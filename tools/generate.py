"""Generate SYNTHETIC flight data (A320-class, 2 Hz) for VTBS / VTBD scenarios.

Nothing here is real flight data. A simple point-mass model with autopilot-like
modes flies scripted departures/arrivals against AIP runway geometry, then the
scripts inject deviations (unstable approach, hard landing, ...) so the event
detector has something to find.

    python tools/generate.py          -> data/flights/*.csv + data/flights/index.json
"""
from __future__ import annotations

import csv
import json
import math
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable

from fdm_common import DATA, Frame, angdiff, load_airports, rwy_coords, rwy_point

G = 9.80665
KT = 0.514444
NM = 1852.0
DT = 0.25          # integration step (s)
REC_EVERY = 2      # record every 2 steps -> 2 Hz
FLAP_AOA_BONUS = {0: 0.0, 1: 1.0, 2: 2.0, 3: 3.0, 4: 4.0}


@dataclass
class Step:
    until: Callable[["Sim"], bool]
    set: dict = field(default_factory=dict)


class Sim:
    def __init__(self, airports, icao, rwy_id, *, seed, wind, t0, start, turb=1.0):
        self.ap = airports[icao]
        self.rwy = self.ap["runways"][rwy_id]
        self.fr = Frame(self.ap["lat"], self.ap["lon"])
        self.rng = random.Random(seed)
        self.wind_dir, self.wind_spd = wind
        self.t0 = t0
        self.t = 0.0
        self.ground_elev = self.rwy["thr_elev_ft"]
        # state
        self.x, self.y = start["xy"]
        self.alt = start.get("alt", self.rwy["thr_elev_ft"])
        self.ias = start.get("ias", 0.0)
        self.hdg = start["hdg"]
        self.vs = start.get("vs", 0.0)
        self.on_ground = start.get("ground", False)
        self.bank = 0.0
        self.pitch = 0.0 if self.on_ground else 2.0
        self.n1 = 30.0
        self.nz = 1.0
        self.nz_spike = 0.0
        self.e_prev = None
        self.landed = False
        self.rotating = False
        self.done = False
        self.td_sink = None
        self.td_t = None
        # commanded settings
        self.c = dict(lat=("HDG", self.hdg), vert=("VS", self.vs), spd=self.ias, flap=0, gear=1,
                      ap=1, athr=1, n1="AUTO", bank_lim=25.0, phase="", loc_offset=0.0,
                      vr=145, rot_rate=2.8, liftoff_pitch=8.0, rot_target=15.0,
                      flare_vs=-150.0, turb=turb, gust=1.0)
        # turbulence (Ornstein-Uhlenbeck)
        self.tb = dict(roll=0.0, pitch=0.0, nz=0.0, ias=0.0)
        self.rows = []
        self.ils_on = not self.on_ground
        self.lo_t = -99.0
        self.spike_hold = 0.0

    # ------------------------------------------------------------ helpers
    @property
    def ra(self):
        return self.alt - self.ground_elev

    def rwy_ae(self, rwy=None):
        return rwy_coords(self.fr, rwy or self.rwy, self.x, self.y)

    @property
    def a(self):
        return self.rwy_ae()[0]

    @property
    def e(self):
        return self.rwy_ae()[1]

    def gs_alt(self):
        """Altitude (ft) of the 3-degree glide path at the current position."""
        d_gp = 300.0 - self.a
        return self.rwy["thr_elev_ft"] + d_gp * math.tan(math.radians(self.rwy["gp_deg"])) / 0.3048

    def wind_vec(self):
        f = min(max(self.alt, 0), 10000) / 10000
        spd = self.wind_spd * (1 + 1.5 * f) * KT
        d = math.radians(self.wind_dir + 20 * f)
        return -spd * math.sin(d), -spd * math.cos(d)

    def tas(self):
        return self.ias * (1 + 0.02 * max(self.alt, 0) / 1000)

    def wca_heading(self, trk):
        wx, wy = self.wind_vec()
        t = math.radians(trk)
        wc = wx * math.cos(t) - wy * math.sin(t)
        v = max(self.tas() * KT, 30)
        return trk + math.degrees(math.asin(max(-0.9, min(0.9, -wc / v))))

    def ou(self, k, sigma, tau):
        self.tb[k] += -self.tb[k] * DT / tau + sigma * math.sqrt(DT) * self.rng.gauss(0, 1)
        return self.tb[k]

    # ------------------------------------------------------------ dynamics
    def hdg_command(self):
        lat = self.c["lat"]
        if lat[0] == "HDG":
            return lat[1]
        if lat[0] == "TO":
            px, py = lat[1]
            brg = math.degrees(math.atan2(px - self.x, py - self.y)) % 360
            return self.wca_heading(brg)
        if lat[0] in ("LOC", "RWY"):
            a, e = self.rwy_ae()
            e -= self.c["loc_offset"]
            gain = lat[1] if len(lat) > 1 else 1.0
            # fly a track whose cross-track rate closes the error with time constant tau
            tau = 22.0 / gain
            v = max(self.tas() * KT, 40)
            theta = math.degrees(math.asin(max(-0.5, min(0.5, -e / (tau * v)))))
            return self.wca_heading(self.rwy["true_brg"] + theta)
        raise ValueError(lat)

    def vs_command(self):
        v = self.c["vert"]
        m = v[0]
        if m == "VS":
            return v[1]
        if m == "ALT":
            return max(-v[2], min(v[2], 3.0 * (v[1] - self.alt)))
        if m == "GS":
            extra = v[1] if len(v) > 1 else 0.0
            wx, wy = self.wind_vec()
            cr = math.radians(self.rwy["true_brg"])
            gs_kt = self.tas() + (wx * math.sin(cr) + wy * math.cos(cr)) / KT
            nominal = -gs_kt * 101.27 * math.tan(math.radians(self.rwy["gp_deg"]))
            corr = max(-600.0, min(600.0, 6.0 * (self.gs_alt() - self.alt)))
            return nominal + corr + extra
        if m == "FLARE":
            return self.c["flare_vs"]
        raise ValueError(v)

    def n1_command(self, vs_cmd):
        m = self.c["n1"]
        if m == "TOGA":
            return 91.0
        if m == "CLB":
            return 86.0
        if m == "IDLE":
            return 26.0
        if m == "REV":
            return 72.0
        spd_err = self.c["spd"] - self.ias
        return max(26.0, min(92.0, 52.0 + 0.010 * vs_cmd + 2.5 * spd_err + 3 * self.c["flap"]))

    def step(self):
        c = self.c
        vs_old = self.vs
        if self.on_ground:
            self.ground_step()
        else:
            self.air_step()
        self.n1 += (self.n1_command(self.vs_command() if not self.on_ground else 0) - self.n1) * DT / 2.5
        # load factor
        if not self.on_ground:
            dvs = (self.vs - vs_old) / 60.0 / DT
            self.nz = 1 / math.cos(math.radians(self.bank)) + dvs / 32.174
        else:
            self.nz = 1.0
        if self.spike_hold > 0:
            self.spike_hold -= DT
        else:
            self.nz_spike *= math.exp(-DT / 0.3)
        self.t += DT

    def ground_step(self):
        c = self.c
        course = self.rwy["true_brg"]
        wx, wy = self.wind_vec()
        cr = math.radians(course)
        headwind = -(wx * math.sin(cr) + wy * math.cos(cr)) / KT
        if not self.landed:  # take-off roll
            self.ias = min(self.ias + 3.0 * DT * (self.n1 / 91.0) ** 2, 200)
            if self.ias >= c["vr"]:
                self.rotating = True
            if self.rotating:
                self.pitch = min(self.pitch + c["rot_rate"] * DT, c["rot_target"])
                if self.pitch >= c["liftoff_pitch"] and self.ias >= c["vr"] + 3:
                    self.on_ground = False
                    self.vs = 250.0
                    self.lo_t = self.t
        else:  # landing roll
            since = self.t - self.td_t
            decel = 3.6 if self.ias > 70 else 2.0
            self.ias = max(self.ias - decel * DT, 0)
            if since > 1.5:
                self.pitch = max(self.pitch - 2.0 * DT, 0.0)
        gs = max(self.ias - headwind, 0) * KT
        # keep on the centreline
        a, e = self.rwy_ae()
        self.hdg = (course - max(-3, min(3, 0.05 * e))) % 360
        h = math.radians(self.hdg)
        self.x += gs * math.sin(h) * DT
        self.y += gs * math.cos(h) * DT
        self.alt = self.rwy["thr_elev_ft"]
        self.bank *= 0.8
        if not self.landed:
            self.vs = 0.0
        else:
            self.vs = 0.0
            if gs / KT < 30:
                self.done = True

    def air_step(self):
        c = self.c
        if c.get("flap_up_ias") and c["phase"] == "CLIMB" and self.ias > c["flap_up_ias"]:
            c["flap"] = 0
        # speed
        acc = 2.2 if c["n1"] in ("TOGA", "CLB") else 1.6
        dec = 1.3 if c["vert"][0] != "GS" else 1.0
        self.ias += max(-dec * DT, min(acc * DT, (c["spd"] - self.ias) * 0.3 * DT))
        # lateral
        hc = self.hdg_command()
        err = angdiff(hc, self.hdg)
        bank_cmd = max(-c["bank_lim"], min(c["bank_lim"], 2.5 * err))
        db = max(-5 * DT, min(5 * DT, (bank_cmd - self.bank) * DT / 1.0))
        self.bank += db
        v = max(self.tas() * KT, 40)
        self.hdg = (self.hdg + math.degrees(G * math.tan(math.radians(self.bank)) / v) * DT) % 360
        # vertical
        vc = self.vs_command()
        tau = 1.2 if c["vert"][0] == "FLARE" else 2.0
        self.vs += max(-500 * DT, min(500 * DT, (vc - self.vs) * DT / tau))
        self.alt += self.vs / 60.0 * DT
        # attitude
        gamma = math.degrees(math.atan2(self.vs / 60 * 0.3048, self.tas() * KT))
        aoa = (9.0 * 140 ** 2 / max(self.ias, 100) ** 2 - FLAP_AOA_BONUS[c["flap"]]) / math.cos(math.radians(self.bank))
        self.aoa = aoa
        target = gamma + aoa
        if self.t - self.lo_t < 4.0:
            target = max(target, self.pitch)
        self.pitch += (target - self.pitch) * DT / 1.0
        # position
        wx, wy = self.wind_vec()
        h = math.radians(self.hdg)
        self.x += (v * math.sin(h) + wx) * DT
        self.y += (v * math.cos(h) + wy) * DT
        # touchdown
        if self.ra <= 0:
            self.on_ground = True
            self.landed = True
            self.td_sink = -self.vs
            self.td_t = self.t
            self.nz_spike = 0.0009 * max(self.td_sink, 0)
            self.spike_hold = 0.5
            self.alt = self.ground_elev
            self.c.update(n1="REV", phase="ROLLOUT", ap=0, athr=0)

    # ------------------------------------------------------------ outputs
    def ils(self):
        r = self.rwy
        if not r.get("ils_loc_mhz") or self.on_ground or not self.ils_on:
            return None, None
        a, e = self.rwy_ae()
        if a > r["length_m"] or a < -25 * NM:
            return None, None
        d_loc = r["length_m"] + 300 - a
        loc = math.degrees(math.atan2(e, d_loc)) / 0.75
        d_gp = 300 - a
        gs = None
        if d_gp > 150:
            ang = math.degrees(math.atan2((self.alt - r["thr_elev_ft"]) * 0.3048, d_gp))
            gs = (ang - r["gp_deg"]) / 0.35
        return max(-2.5, min(2.5, loc)), (None if gs is None else max(-2.5, min(2.5, gs)))

    def record(self):
        c = self.c
        tm = c["turb"] * (0.4 + 0.6 * max(0.0, 1 - max(self.alt, 0) / 12000))
        if self.on_ground:
            tm *= 0.3
        r_roll = self.ou("roll", 1.2 * tm, 2.0)
        r_pitch = self.ou("pitch", 0.35 * tm, 1.5)
        r_nz = self.ou("nz", 0.05 * tm, 0.4)
        r_ias = self.ou("ias", 1.6 * tm * c["gust"], 3.0)
        lat, lon = self.fr.to_ll(self.x, self.y)
        loc, gs = self.ils()
        wx, wy = self.wind_vec()
        h = math.radians(self.hdg)
        if self.on_ground:
            cr = math.radians(self.rwy["true_brg"])
            vx = vy = 0.0
            hw = -(wx * math.sin(cr) + wy * math.cos(cr)) / KT
            gsk = max(self.ias - hw, 0)
            trk = self.hdg
        else:
            v = self.tas() * KT
            vx, vy = v * math.sin(h) + wx, v * math.cos(h) + wy
            gsk = math.hypot(vx, vy) / KT
            trk = math.degrees(math.atan2(vx, vy)) % 360
        ra = self.ra
        gpws = (not self.on_ground) and ra < 2450 and -self.vs > 1000 + 0.6 * ra
        wspd = math.hypot(wx, wy) / KT
        wdir = (math.degrees(math.atan2(-wx, -wy))) % 360
        sat = 30 - 2 * max(self.alt, 0) / 1000
        tas = self.tas()
        ias_rec = max(self.ias + (r_ias if self.ias > 60 else 0), 0)
        self.rows.append({
            "time_s": round(self.t, 2),
            "utc": (self.t0 + timedelta(seconds=self.t)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-4] + "Z",
            "phase": c["phase"],
            "lat": round(lat, 7), "lon": round(lon, 7),
            "alt_ft": round(self.alt + (self.rng.gauss(0, 3) if not self.on_ground else 0), 1),
            "ra_ft": round(max(ra, 0), 1) if ra <= 2500 else "",
            "ias_kt": round(ias_rec, 1),
            "tas_kt": round(tas, 1),
            "gs_kt": round(gsk, 1),
            "mach": round(tas / (661.5 * math.sqrt((273.15 + sat) / 288.15)), 3),
            "vs_fpm": round(self.vs, 0),
            "pitch_deg": round(self.pitch + r_pitch, 2),
            "roll_deg": round(self.bank + r_roll, 2),
            "hdg_true_deg": round(self.hdg % 360, 2),
            "hdg_mag_deg": round((self.hdg - self.ap["magvar_deg"]) % 360, 2),
            "trk_true_deg": round(trk, 2),
            "aoa_deg": round(getattr(self, "aoa", 0.0) if not self.on_ground else 0.0, 2),
            "nz_g": round(self.nz + self.nz_spike + r_nz, 3),
            "flap": c["flap"],
            "gear": c["gear"],
            "n1_1": round(self.n1 + self.rng.gauss(0, 0.2), 1),
            "n1_2": round(self.n1 + self.rng.gauss(0, 0.2), 1),
            "ap": c["ap"], "athr": c["athr"],
            "loc_dev_dot": "" if loc is None else round(loc, 3),
            "gs_dev_dot": "" if gs is None else round(gs, 3),
            "wind_dir_deg": round(wdir), "wind_spd_kt": round(wspd, 1),
            "sat_c": round(sat, 1),
            "air_ground": 0 if self.on_ground else 1,
            "gpws_warn": 1 if gpws else 0,
            "rev": 1 if c["n1"] == "REV" else 0,
        })

    def run(self, steps: list[Step], tmax=3600):
        i = 0
        self.c.update(steps[0].set)
        k = 0
        while not self.done and self.t < tmax:
            while i < len(steps) and steps[i].until(self):
                i += 1
                if i < len(steps):
                    self.c.update(steps[i].set)
                    if "lat" in steps[i].set:
                        self.e_prev = None
                else:
                    self.done = True
            if self.done:
                break
            if k % REC_EVERY == 0:
                self.record()
            self.step()
            k += 1
        self.record()
        return self.rows


# ================================================================ scripts
def never(_):
    return False


def arrival(airports, icao, rwy_id, *, seed, wind, t0, vapp=140, turb=1.0, o=None):
    """Standard ILS arrival with optional deviations in `o`."""
    o = o or {}
    ap = airports[icao]
    rwy = ap["runways"][rwy_id]
    fr = Frame(ap["lat"], ap["lon"])
    side = o.get("side", 1)
    c = rwy["true_brg"]
    ip = rwy_point(fr, rwy, -13 * NM, 0)
    hin = (c + 30 * side) % 360
    hr = math.radians(hin)
    start = (ip[0] - 16 * NM * math.sin(hr), ip[1] - 16 * NM * math.cos(hr))
    sim = Sim(airports, icao, rwy_id, seed=seed, wind=wind, t0=t0, turb=turb,
              start=dict(xy=start, alt=7000, ias=250, hdg=hin, vs=-1000))
    steps = [
        Step(lambda s: abs(s.e) < 2500 and s.a > -16 * NM,
             dict(lat=("HDG", hin), vert=("ALT", 3000, 1200), spd=220, flap=0, gear=0, phase="DESCENT", n1="AUTO")),
        Step(lambda s: s.gs_alt() <= s.alt + 30,
             dict(lat=("LOC",), spd=190, flap=1, gear=0, phase="APPROACH")),
    ]
    steps += final_steps(rwy, vapp, o)
    return sim, steps


def final_steps(rwy, vapp, o):
    """Glide-slope descent, then actions keyed to radio altitude (sorted high->low)."""
    fin_spd = o.get("final_spd", vapp)
    first = dict(vert=("GS",), spd=165, flap=2, gear=0, phase="APPROACH")
    steps = [
        Step(lambda s: s.a > -7 * NM, first),
        Step(lambda s: s.a > -5 * NM, dict(spd=150, flap=3, gear=1)),
        Step(lambda s: s.ra < 1600, dict(spd=fin_spd, flap=o.get("flap_final", 4), gear=1)),
    ]
    acts = [(1000, dict(phase="FINAL")), (400, dict(ap=0))]
    if "dive" in o:  # (ra_start, ra_end, extra_vs)
        r0, r1, xv = o["dive"]
        acts += [(r0, dict(vert=("VS", xv))), (r1, dict(vert=("GS",)))]
    if "loc_offset" in o:  # (offset_m, ra_correct, bank_lim, gain)
        off, ra_c, bl, gain = o["loc_offset"]
        first["loc_offset"] = off
        acts.append((ra_c, dict(loc_offset=0.0, bank_lim=bl, lat=("LOC", gain))))
    ga = o.get("ga_at_ra")
    if ga:
        acts = [a for a in acts if a[0] > ga] + [(ga, dict(ap=0))]
    else:
        if "late_extra" in o:  # (ra, extra_vs): sink below the path just before the flare
            acts.append((o["late_extra"][0], dict(vert=("GS", o["late_extra"][1]))))
        acts.append((o.get("flare_h", 30), dict(vert=("FLARE",), flare_vs=o.get("flare_vs", -150),
                                                phase="LANDING", n1="IDLE", athr=0)))
    acts.sort(key=lambda a: -a[0])
    steps.append(Step(lambda s, h=acts[0][0]: s.ra < h, {}))
    for k, (h, st) in enumerate(acts):
        if k + 1 < len(acts):
            steps.append(Step(lambda s, h2=acts[k + 1][0]: s.ra < h2, st))
        elif ga:
            steps.append(Step(lambda s: True, st))   # hand over to the go-around script
        else:
            steps.append(Step(never, st))
    return steps


def departure(airports, icao, rwy_id, *, seed, wind, t0, out_hdg, tmax=420, turb=1.0, o=None):
    o = o or {}
    ap = airports[icao]
    rwy = ap["runways"][rwy_id]
    fr = Frame(ap["lat"], ap["lon"])
    start = rwy_point(fr, rwy, 30, 0)
    sim = Sim(airports, icao, rwy_id, seed=seed, wind=wind, t0=t0, turb=turb,
              start=dict(xy=start, ground=True, hdg=rwy["true_brg"], ias=0))
    vr = o.get("vr", 145)
    flap_up_ias = o.get("flap_up_ias", 205)
    steps = [
        Step(lambda s: (not s.on_ground) and s.ra > 35,
             dict(lat=("HDG", rwy["true_brg"]), vert=("VS", 1800), spd=vr + 15, flap=1, gear=1, n1="TOGA",
                  phase="TAKEOFF", ap=0, athr=1, vr=vr, rot_rate=o.get("rot_rate", 2.8),
                  liftoff_pitch=o.get("liftoff_pitch", 8.0), flap_up_ias=flap_up_ias)),
        Step(lambda s: s.ra > 1500, dict(vert=("VS", 2400), gear=0, phase="CLIMB")),
        Step(lambda s: s.alt > 3000, dict(ap=1, n1="CLB", vert=("VS", 1800), spd=o.get("climb_spd", 250))),
        Step(lambda s: s.alt > 7000, dict(lat=("HDG", out_hdg), bank_lim=o.get("turn_bank", 25))),
        Step(lambda s: s.alt > 10300, dict(bank_lim=25)),
        Step(lambda s: s.t > tmax, dict(spd=290)),
    ]
    return sim, steps


def go_around_and_reland(sim, rwy, vapp):
    """Go-around, left-hand circuit, second ILS approach to the same runway."""
    fr = sim.fr
    p1 = rwy_point(fr, rwy, 6000, -5500)
    p2 = rwy_point(fr, rwy, -9000, -5500)
    p3 = rwy_point(fr, rwy, -14500, -3000)
    c = rwy["true_brg"]
    steps = [
        Step(lambda s: s.vs > 500, dict(n1="TOGA", vert=("VS", 1800), spd=vapp + 10, flap=3,
                                        phase="GO_AROUND", ap=0)),
        Step(lambda s: s.ra > 400, dict(gear=0, lat=("HDG", c))),
        Step(lambda s: s.alt > 1500, dict(flap=2, ap=1, n1="CLB", spd=180)),
        Step(lambda s: s.a > 3000, dict(vert=("ALT", 2500, 1500), flap=1, spd=190, n1="AUTO", phase="CIRCUIT")),
        Step(lambda s: math.hypot(s.x - p1[0], s.y - p1[1]) < 1200, dict(lat=("TO", p1))),
        Step(lambda s: math.hypot(s.x - p2[0], s.y - p2[1]) < 1200, dict(lat=("TO", p2))),
        Step(lambda s: math.hypot(s.x - p3[0], s.y - p3[1]) < 1000, dict(lat=("TO", p3), spd=180)),
        Step(lambda s: abs(s.e) < 1500, dict(lat=("HDG", (c + 45) % 360), phase="APPROACH")),
        Step(lambda s: s.gs_alt() <= s.alt + 30, dict(lat=("LOC",), vert=("ALT", 2500, 1000), loc_offset=0.0,
                                                     bank_lim=25)),
    ]
    steps += final_steps(rwy, vapp, {})
    return steps


# ================================================================ scenarios
def build(airports):
    tz = timezone.utc
    D = lambda h, m: datetime(2026, 11, 20, h, m, 0, tzinfo=tz)
    scen = []

    def add(fid, title, title_th, kind, icao, rwy, sim_steps, desc_th, expect, vapp=140):
        sim, steps = sim_steps
        rows = sim.run(steps, tmax=1800)
        scen.append(dict(id=fid, title=title, title_th=title_th, kind=kind, airport=icao, runway=rwy,
                         aircraft="A320-family (SIMULATED)", registration="HS-SIM", callsign=f"SIM{fid[1:3]}",
                         date=rows[0]["utc"][:10], vapp_kt=vapp, description_th=desc_th,
                         expected_events=expect, file=f"{fid}.csv", rows=rows))

    add("S01_VTBS_19_NORMAL", "Normal ILS arrival VTBS RWY 19", "ขาเข้าปกติ สุวรรณภูมิ RWY 19", "arrival",
        "VTBS", "19", arrival(airports, "VTBS", "19", seed=1, wind=(170, 8), t0=D(1, 10)),
        "เที่ยวบินอ้างอิง (baseline) บินเข้า ILS ตามมาตรฐาน ไม่ควรพบ event", [])

    add("S02_VTBD_21R_UNSTABLE", "Unstabilised approach VTBD RWY 21R", "บินเข้าไม่เสถียร ดอนเมือง RWY 21R", "arrival",
        "VTBD", "21R", arrival(airports, "VTBD", "21R", seed=2, wind=(200, 6), t0=D(3, 25), o=dict(
            final_spd=168, flap_final=3, dive=(1400, 900, -1450), flare_h=40, flare_vs=-90)),
        "บินเร็วและสูงเกิน ตั้งแฟลปไม่ครบ ร่อนลงชัน แต่ยังลงต่อ (ไม่ go-around) ลอยตัวนานจนแตะพื้นไกล",
        ["UNSTABLE_1000", "UNSTABLE_500", "HIGH_ROD_FINAL", "GS_DEVIATION", "LONG_LANDING"])

    add("S03_VTBS_01_HARD_LANDING", "Hard landing VTBS RWY 01", "ลงสนามแรง สุวรรณภูมิ RWY 01", "arrival",
        "VTBS", "01", arrival(airports, "VTBS", "01", seed=3, wind=(30, 12), t0=D(5, 40), turb=1.6, o=dict(
            late_extra=(45, -350), flare_h=10, flare_vs=-1050)),
        "ช่วงท้ายจมต่ำกว่า glide path และ flare ช้า แตะพื้นด้วยอัตราจมสูง (~1,000 fpm)",
        ["HARD_LANDING"])

    sim, steps = arrival(airports, "VTBD", "03L", seed=4, wind=(110, 18), t0=D(7, 5), turb=1.8,
                         o=dict(loc_offset=(140, 450, 25, 1.0), ga_at_ra=650))
    rwy = airports["VTBD"]["runways"]["03L"]
    steps = steps + go_around_and_reland(sim, rwy, 140)
    sim.c["gust"] = 1.2
    add("S04_VTBD_03L_GO_AROUND", "Go-around and re-approach VTBD RWY 03L", "Go-around แล้วบินเข้าใหม่ ดอนเมือง RWY 03L",
        "arrival+go-around", "VTBD", "03L", (sim, steps),
        "ลมขวาง 110/18 kt กระโชก ไม่ตรงแนว localiser ที่ 1000 ft จึง go-around ที่ ~650 ft บินวงจรซ้ายแล้วลงสำเร็จ",
        ["LOC_DEVIATION", "UNSTABLE_1000", "GO_AROUND"])

    add("S05_VTBS_20L_TAILSTRIKE_RISK", "Over-rotation on take-off VTBS RWY 20L", "เงยหัวเร็วเกินขณะขึ้น สุวรรณภูมิ RWY 20L",
        "departure", "VTBS", "20L", departure(airports, "VTBS", "20L", seed=5, wind=(190, 10), t0=D(9, 0),
                                              out_hdg=280, o=dict(rot_rate=4.9, liftoff_pitch=11.0, turn_bank=37)),
        "rotate เร็ว (~5°/s) มุมเงยขณะล้อพ้นพื้น ~11° (เสี่ยงหางครูดพื้น) และเลี้ยวชัน 37°",
        ["HIGH_PITCH_LIFTOFF", "HIGH_PITCH_RATE_ROT", "HIGH_BANK"])

    add("S06_VTBS_02L_FLAP_OVERSPEED", "Flap overspeed after take-off VTBS RWY 02L", "ความเร็วเกินขีดแฟลป สุวรรณภูมิ RWY 02L",
        "departure", "VTBS", "02L", departure(airports, "VTBS", "02L", seed=6, wind=(40, 9), t0=D(10, 30),
                                              out_hdg=90, o=dict(flap_up_ias=244, climb_spd=268)),
        "เก็บแฟลปช้า ความเร็วเกิน VFE CONF 1 (230 kt) และบินเกิน 250 kt ต่ำกว่า 10,000 ft",
        ["FLAP_OVERSPEED", "SPEED_250_BELOW_FL100"])

    add("S07_VTBD_21L_SINKRATE_LATE_LINEUP", "Sink rate + late line-up VTBD RWY 21L",
        "SINK RATE + จัดแนวช้า ดอนเมือง RWY 21L", "arrival",
        "VTBD", "21L", arrival(airports, "VTBD", "21L", seed=7, wind=(230, 10), t0=D(12, 15), turb=1.3, o=dict(
            dive=(1500, 880, -2000), loc_offset=(-210, 560, 22, 2.2))),
        "ร่อนลงชันจน GPWS 'SINK RATE' และจัดแนวกับรันเวย์ (ซึ่งขนานกับ 21R) ช้า ต้องเอียงแรงที่ความสูงต่ำ",
        ["GPWS_WARNING", "HIGH_ROD_FINAL", "GS_DEVIATION", "LOC_DEVIATION", "UNSTABLE_1000", "UNSTABLE_500", "HIGH_BANK_LOW_ALT"])

    add("S08_VTBD_21R_NORMAL_DEP", "Normal departure VTBD RWY 21R", "ขาออกปกติ ดอนเมือง RWY 21R", "departure",
        "VTBD", "21R", departure(airports, "VTBD", "21R", seed=8, wind=(210, 7), t0=D(14, 45), out_hdg=320),
        "เที่ยวบินอ้างอิงขาออก ไม่ควรพบ event", [])
    return scen


def main():
    airports = load_airports()
    out = DATA / "flights"
    out.mkdir(parents=True, exist_ok=True)
    scen = build(airports)
    index = []
    for s in scen:
        rows = s.pop("rows")
        with open(out / s["file"], "w", newline="\n", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")
            w.writeheader()
            w.writerows(rows)
        s["n_rows"] = len(rows)
        s["duration_s"] = rows[-1]["time_s"]
        index.append(s)
        print(f"{s['id']:40s} {len(rows):5d} rows  {rows[-1]['time_s']:7.1f} s")
    (out / "index.json").write_text(json.dumps(dict(
        note="SYNTHETIC data generated by tools/generate.py - not real flight data",
        flights=index), ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
