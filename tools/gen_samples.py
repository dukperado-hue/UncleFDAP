"""Generate SYNTHETIC raw files for testing the import wizard (nothing here is real data).

1. Garmin G1000-style data logs (Cessna 172, 1 Hz) of circuit training at VTPH Hua Hin:
   - same three-line header layout as the G1000 SD-card log (#airframe_info, units row, names row)
   - local date/time + UTC offset, magnetic HDG/TRK, NormAc written as deviation from 1 g,
     AltGPS on the WGS-84 ellipsoid, no radio altimeter, no weight-on-wheels, no flap position
   - G04 carries deliberate recording defects for the data-quality checks
2. An "operator decoder export" .xlsx (+ .csv) of A320 scenario S02 using typical
   FDM parameter mnemonics (ALT_STD, CAS, VRTG, RALT ...), two sheets, units row.

    python tools/gen_samples.py      -> data/samples/*.csv / *.xlsx + index.json
Then `node tools/import_cli.js --all` writes the normalised CSVs used by selftest/parity.
"""
from __future__ import annotations

import csv
import json
import math
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable

from fdm_common import DATA, Frame, angdiff, load_airports, read_flight_csv, rwy_coords, rwy_point

G = 9.80665
KT = 0.514444
DT = 0.2
OUT = DATA / "samples"
LOCAL = timezone(timedelta(hours=7))
GEOID_N_M = -27.0          # ellipsoid - MSL near Hua Hin (EGM96 approx.)


@dataclass
class Step:
    until: Callable[["C172"], bool]
    set: dict = field(default_factory=dict)


class C172:
    """Very small kinematic model - enough to give plausible traces, not a flight model."""

    def __init__(self, airports, icao, rwy_id, *, seed, wind, t0_local, fuel=(24.0, 24.0)):
        self.ap = airports[icao]
        self.rwy = self.ap["runways"][rwy_id]
        self.pair = self.ap["runways"][self.rwy["pair"]]
        self.fr = Frame(self.ap["lat"], self.ap["lon"])
        self.rng = random.Random(seed)
        self.wind_dir, self.wind_spd = wind
        self.t0 = t0_local
        self.t = 0.0
        x, y = rwy_point(self.fr, self.rwy, 40, 0)
        self.x, self.y = x, y
        self.alt = self.elev()
        self.ias = 0.0
        self.hdg = self.rwy["true_brg"]
        self.bank = 0.0
        self.vs = 0.0
        self.pitch = 0.0
        self.on_ground = True
        self.landed = False          # True during a landing roll
        self.td_t = -99.0
        self.lo_t = -99.0
        self.rpm = 1000.0
        self.nz = 1.0
        self.spike = 0.0
        self.spike_hold = 0.0
        self.fuel = list(fuel)
        self.flap = 0
        self.done = False
        self.c = dict(lat=("RWY",), vert=("VS", 0), spd=0, power="IDLE", flap=0, bank_lim=25.0,
                      vr=55, rot_rate=3.0, liftoff_pitch=8.0, flare_vs=-120, roll_s=6.0, tg=True,
                      aim_m=150.0, turb=1.0, phase="TAXI")
        self.tb = dict(roll=0.0, pitch=0.0, nz=0.0, ias=0.0)
        self.rows = []
        self.marks = {}

    # --------------------------------------------------------- geometry
    def ae(self):
        return rwy_coords(self.fr, self.rwy, self.x, self.y)

    def elev(self):
        """Runway surface elevation under the aircraft (sloped runway), else threshold elevation."""
        a, c = self.ae()
        a = max(0.0, min(self.rwy["length_m"], a))
        return self.rwy["thr_elev_ft"] + (self.pair["thr_elev_ft"] - self.rwy["thr_elev_ft"]) * a / self.rwy["length_m"]

    @property
    def haa(self):
        return self.alt - self.elev()

    def pt(self, a, c):
        return rwy_point(self.fr, self.rwy, a, c)

    def dist(self, p):
        return math.hypot(self.x - p[0], self.y - p[1])

    def wind_vec(self):
        f = min(max(self.alt, 0), 5000) / 5000
        spd = self.wind_spd * (1 + 0.6 * f) * KT
        d = math.radians(self.wind_dir)
        return -spd * math.sin(d), -spd * math.cos(d)

    def tas(self):
        return self.ias * (1 + 0.02 * max(self.alt, 0) / 1000)

    def wca(self, trk):
        wx, wy = self.wind_vec()
        t = math.radians(trk)
        wc = wx * math.cos(t) - wy * math.sin(t)
        v = max(self.tas() * KT, 20)
        return trk + math.degrees(math.asin(max(-0.6, min(0.6, -wc / v))))

    def ou(self, k, sigma, tau):
        self.tb[k] += -self.tb[k] * DT / tau + sigma * math.sqrt(DT) * self.rng.gauss(0, 1)
        return self.tb[k]

    # --------------------------------------------------------- guidance
    def hdg_cmd(self):
        lat = self.c["lat"]
        brg = self.rwy["true_brg"]
        if lat[0] == "HDG":
            return lat[1]
        if lat[0] == "TO":
            px, py = lat[1]
            return self.wca(math.degrees(math.atan2(px - self.x, py - self.y)) % 360)
        if lat[0] in ("FINAL", "RWY"):
            a, c = self.ae()
            look = lat[1] if len(lat) > 1 else 600.0
            return self.wca(brg + math.degrees(math.atan2(-c, look)))
        if lat[0] == "BANK":
            return None
        raise ValueError(lat)

    def vs_cmd(self):
        v = self.c["vert"]
        if v[0] == "VS":
            return v[1]
        if v[0] == "ALT":
            return max(-v[2], min(v[2], 4.0 * (v[1] - self.alt)))
        if v[0] == "GP":
            a, _ = self.ae()
            target = self.rwy["thr_elev_ft"] + (self.c["aim_m"] - a) * math.tan(math.radians(3.0)) / 0.3048
            gs = self.tas() - 10
            extra = v[1] if len(v) > 1 else 0.0
            return -gs * 101.27 * math.tan(math.radians(3.0)) + max(-400, min(400, 3.0 * (target - self.alt))) + extra
        if v[0] == "FLARE":
            return self.c["flare_vs"]
        raise ValueError(v)

    def rpm_cmd(self):
        p = self.c["power"]
        if p == "FULL":
            return 2350.0
        if p == "IDLE":
            return 850.0
        if p == "CRUISE":
            return 2250.0
        spd_err = self.c["spd"] - self.ias
        return max(1300.0, min(2350.0, 1900 + 2.0 * self.vs_cmd() * 0.3 + 25 * spd_err - 60 * (self.flap / 10)))

    # --------------------------------------------------------- dynamics
    def step(self):
        c = self.c
        self.flap += max(-10, min(10, c["flap"] - self.flap)) if abs(c["flap"] - self.flap) >= 10 else 0
        vs_old = self.vs
        if self.on_ground:
            self.ground_step()
        else:
            self.air_step()
        self.rpm += (self.rpm_cmd() - self.rpm) * DT / 1.5
        if not self.on_ground:
            self.nz = 1 / math.cos(math.radians(self.bank)) + (self.vs - vs_old) / 60.0 / DT / 32.174
        else:
            self.nz = 1.0
        if self.spike_hold > 0:
            self.spike_hold -= DT
        else:
            self.spike *= math.exp(-DT / 0.3)
        burn = (2 + max(0.0, self.rpm - 800) / 1600 * 8) / 3600 * DT
        self.fuel[0] -= burn / 2
        self.fuel[1] -= burn / 2
        self.t += DT

    def ground_step(self):
        c = self.c
        brg = self.rwy["true_brg"]
        wx, wy = self.wind_vec()
        hw = -(wx * math.sin(math.radians(brg)) + wy * math.cos(math.radians(brg))) / KT
        if self.landed:
            since = self.t - self.td_t
            if c["tg"] and since > c["roll_s"]:
                self.landed = False                     # touch-and-go: power up again
                c.update(power="FULL", flap=0, phase="TAKEOFF")
            else:
                self.ias = max(self.ias - (2.2 if self.ias > 25 else 1.2) * DT * (0.6 if c["tg"] else 1.0), 0)
                self.pitch = max(self.pitch - 1.5 * DT, 0.0)
                if not c["tg"] and self.ias < 12 and since > 15:
                    self.done = True
        if not self.landed:
            if c["power"] == "FULL":
                self.ias = min(self.ias + 3.2 * DT, 90)
            if self.ias >= c["vr"]:
                self.pitch = min(self.pitch + c["rot_rate"] * DT, c["liftoff_pitch"] + 2)
                if self.pitch >= c["liftoff_pitch"] and self.ias >= c["vr"] + 2:
                    self.on_ground = False
                    self.vs = 150.0
                    self.lo_t = self.t
        a, e = self.ae()
        self.hdg = (brg - max(-4, min(4, 0.04 * e))) % 360
        gs = max(self.ias - hw, 0) * KT if self.ias > 0 else 0
        h = math.radians(self.hdg)
        self.x += gs * math.sin(h) * DT
        self.y += gs * math.cos(h) * DT
        self.alt = self.elev()
        self.vs = 0.0
        self.bank *= 0.7

    def air_step(self):
        c = self.c
        self.ias += max(-1.6 * DT, min(1.6 * DT, (c["spd"] - self.ias) * 0.35 * DT))
        hc = self.hdg_cmd()
        if hc is None:
            bank_cmd = c["lat"][1]
        else:
            bank_cmd = max(-c["bank_lim"], min(c["bank_lim"], 1.8 * angdiff(hc, self.hdg)))
        self.bank += max(-12 * DT, min(12 * DT, (bank_cmd - self.bank) * DT / 0.8))
        v = max(self.tas() * KT, 25)
        self.hdg = (self.hdg + math.degrees(G * math.tan(math.radians(self.bank)) / v) * DT) % 360
        vc = self.vs_cmd()
        tau = 0.8 if c["vert"][0] == "FLARE" else 1.6
        self.vs += max(-900 * DT, min(900 * DT, (vc - self.vs) * DT / tau))
        self.alt += self.vs / 60.0 * DT
        gamma = math.degrees(math.atan2(self.vs / 60 * 0.3048, self.tas() * KT))
        aoa = (1.5 + 5.5 * (60 / max(self.ias, 40)) ** 2) / math.cos(math.radians(self.bank)) - {0: 0, 10: 1.5, 20: 3, 30: 4}.get(int(self.flap), 0)
        target = gamma + aoa
        if c["vert"][0] == "FLARE":
            target = max(target, 4.0)
        if self.t - self.lo_t < 3.0:
            target = max(target, self.pitch)
        self.pitch += (target - self.pitch) * DT / 0.8
        wx, wy = self.wind_vec()
        h = math.radians(self.hdg)
        self.x += (v * math.sin(h) + wx) * DT
        self.y += (v * math.cos(h) + wy) * DT
        if self.haa <= 0:
            self.on_ground = True
            self.landed = True
            self.td_t = self.t
            sink = max(-self.vs, 0)
            self.spike = 0.0011 * sink
            self.spike_hold = 1.0       # long enough that a 1 Hz sample can catch it
            self.alt = self.elev()
            self.bank = 0.0
            c.update(power="IDLE", phase="ROLLOUT")

    # --------------------------------------------------------- recording
    def record(self):
        c = self.c
        tm = c["turb"] * (0.5 if self.on_ground else 1.0)
        r_roll = self.ou("roll", 1.6 * tm, 1.5)
        r_pitch = self.ou("pitch", 0.4 * tm, 1.2)
        r_nz = self.ou("nz", 0.04 * tm, 0.4)
        r_ias = self.ou("ias", 1.3 * tm, 2.5)
        lat, lon = self.fr.to_ll(self.x, self.y)
        wx, wy = self.wind_vec()
        if self.on_ground:
            brg = math.radians(self.rwy["true_brg"])
            hw = -(wx * math.sin(brg) + wy * math.cos(brg)) / KT
            gsk = max(self.ias - hw, 0) if self.ias > 0 else 0.0
            trk = self.hdg
        else:
            v = self.tas() * KT
            h = math.radians(self.hdg)
            vx, vy = v * math.sin(h) + wx, v * math.cos(h) + wy
            gsk = math.hypot(vx, vy) / KT
            trk = math.degrees(math.atan2(vx, vy)) % 360
        magvar = self.ap["magvar_deg"]
        ias = max(self.ias + (r_ias if self.ias > 30 else 0), 0)
        oat = 29 - 2 * max(self.alt, 0) / 1000
        egt = 1150 + (self.rpm - 1500) * 0.35
        cht = 330 + (self.rpm - 1500) * 0.06
        ff = 2 + max(0.0, self.rpm - 800) / 1600 * 8
        ts = self.t0 + timedelta(seconds=self.t)
        nz = self.nz + self.spike + r_nz
        self.rows.append({
            "Lcl Date": ts.strftime("%Y-%m-%d"), "Lcl Time": ts.strftime("%H:%M:%S"), "UTCOfst": "+07:00",
            "AtvWpt": self.ap["icao"],
            "Latitude": f"{lat:.7f}", "Longitude": f"{lon:.7f}",
            "AltB": f"{self.alt + self.rng.gauss(0, 4):.1f}", "BaroA": "29.86",
            "AltMSL": f"{self.alt + self.rng.gauss(0, 3) if not self.on_ground else self.alt:.1f}",
            "OAT": f"{oat:.1f}", "IAS": f"{ias:.2f}", "GndSpd": f"{gsk:.2f}", "VSpd": f"{self.vs + self.rng.gauss(0, 15):.2f}",
            "Pitch": f"{self.pitch + r_pitch:.2f}", "Roll": f"{self.bank + r_roll:.2f}",
            "LatAc": f"{self.rng.gauss(0, 0.01):.2f}", "NormAc": f"{nz - 1:.2f}",
            "HDG": f"{(self.hdg - magvar) % 360:.2f}", "TRK": f"{(trk - magvar) % 360:.2f}",
            "volt1": f"{28.0 + self.rng.gauss(0, 0.05):.1f}", "volt2": f"{27.9 + self.rng.gauss(0, 0.05):.1f}",
            "amp1": f"{4.5 + self.rng.gauss(0, 0.3):.1f}", "amp2": f"{0.4 + self.rng.gauss(0, 0.05):.1f}",
            "FQtyL": f"{self.fuel[0]:.2f}", "FQtyR": f"{self.fuel[1]:.2f}",
            "E1 FFlow": f"{ff:.2f}", "E1 OilT": f"{185 + self.rng.gauss(0, 0.5):.2f}", "E1 OilP": f"{62 + self.rng.gauss(0, 0.6):.2f}",
            "E1 RPM": f"{self.rpm:.1f}",
            "E1 CHT1": f"{cht:.2f}", "E1 CHT2": f"{cht + 8:.2f}", "E1 CHT3": f"{cht - 6:.2f}", "E1 CHT4": f"{cht + 3:.2f}",
            "E1 EGT1": f"{egt:.2f}", "E1 EGT2": f"{egt + 25:.2f}", "E1 EGT3": f"{egt - 15:.2f}", "E1 EGT4": f"{egt + 10:.2f}",
            "AltGPS": f"{self.alt + GEOID_N_M / 0.3048 + self.rng.gauss(0, 6):.1f}",
            "TAS": f"{self.tas():.2f}", "HSIS": "GPS", "CRS": f"{(self.rwy['true_brg'] - magvar) % 360:.1f}",
            "NAV1": "109.90", "NAV2": "114.30", "COM1": "118.100", "COM2": "121.500",
            "HCDI": "", "VCDI": "", "WndSpd": f"{math.hypot(wx, wy) / KT:.1f}",
            "WndDr": f"{(math.degrees(math.atan2(-wx, -wy)) - magvar) % 360:.1f}",
            "WptDst": "", "WptBrg": "", "MagVar": f"{magvar:.1f}", "AfcsOn": "0",
            "RollM": "", "PitchM": "", "RollC": "", "PichC": "", "VSpdG": "", "GPSfix": "3D",
            "HAL": "", "VAL": "", "HPLwas": "", "HPLfd": "", "VPLwas": "",
        })

    def run(self, steps, tmax=5400):
        i = 0
        self.c.update(steps[0].set)
        k = 0
        rec_every = int(round(1.0 / DT))
        while not self.done and self.t < tmax:
            while i < len(steps) and steps[i].until(self):
                i += 1
                if i < len(steps):
                    self.c.update(steps[i].set)
                else:
                    self.done = True
            if self.done:
                break
            if k % rec_every == 0:
                self.record()
            self.step()
            k += 1
        return self.rows


# ------------------------------------------------------------------ circuit scripts
def mark(name):
    def f(s):
        s.marks[name] = s.t
        return True
    return f


def circuit(s: C172, *, tg=True, vapp=65, cross=-1500, o=None, first=False):
    """One left/right-hand circuit from the take-off roll to the next touchdown (+ roll)."""
    o = o or {}
    tpa = s.ap["elev_ft"] + 1000
    L = s.rwy["length_m"]
    side = -1 if cross < 0 else 1
    steps = []
    if first:
        steps.append(Step(lambda s: s.t > 25, dict(lat=("RWY",), power="IDLE", spd=0, phase="TAXI")))
        steps.append(Step(lambda s: True, dict(power="FULL", phase="TAKEOFF", spd=74,
                                               liftoff_pitch=o.get("liftoff_pitch", 8.0), rot_rate=o.get("rot_rate", 3.0))))
    steps += [
        Step(lambda s: (not s.on_ground) and s.haa > 50, dict(lat=("RWY", 900), vert=("VS", 700), spd=74, flap=0)),
        Step(lambda s: s.haa > 300, dict(phase="CLIMB")),
        Step(lambda s: s.haa > 650, dict(power="FULL")),
        Step(lambda s, p=s.pt(L + 700, cross): s.dist(p) < 350, dict(lat=("TO", s.pt(L + 700, cross)), vert=("ALT", tpa, 700), spd=80, phase="CROSSWIND")),
    ]
    if o.get("steep_turns"):
        far = s.pt(L + 9000, cross * 4)
        steps += [
            Step(lambda s, p=far: s.dist(p) < 500, dict(lat=("TO", far), vert=("ALT", s.ap["elev_ft"] + 3000, 600), spd=95, power="CRUISE", phase="CRUISE")),
            Step(mark("st0"), {}),
            Step(lambda s: s.t - s.marks["st0"] > 24, dict(lat=("BANK", -o["steep_turns"]), vert=("ALT", s.ap["elev_ft"] + 3000, 500), spd=95, phase="MANOEUVRE")),
            Step(lambda s: s.t - s.marks["st0"] > 30, dict(lat=("HDG", s.hdg), bank_lim=25)),
            Step(lambda s: s.t - s.marks["st0"] > 54, dict(lat=("BANK", o["steep_turns"] + 3))),
            Step(lambda s: s.t - s.marks["st0"] > 60, dict(lat=("TO", s.pt(L + 700, cross)), bank_lim=25, phase="CRUISE")),
            Step(lambda s, p=s.pt(L + 700, cross): s.dist(p) < 500, dict(vert=("ALT", tpa, 600), spd=90)),
        ]
    dw_end = s.pt(-900, cross)
    base = s.pt(o.get("base_a", -1900), o.get("base_c", side * 350))
    steps += [
        Step(lambda s: s.ae()[0] < 0, dict(lat=("TO", dw_end), vert=("ALT", tpa, 500), spd=90, power="CRUISE", phase="DOWNWIND")),
        Step(lambda s, p=dw_end: s.dist(p) < 300, dict(vert=("VS", o.get("dw_vs", -450)), spd=75, flap=10, power="AUTO")),
        Step(lambda s: abs(s.ae()[1]) < o.get("final_capture", 450), dict(lat=("TO", base), spd=70, flap=20, phase="BASE",
                                                                         bank_lim=o.get("base_bank", 25))),
    ]
    final = dict(lat=("FINAL", o.get("final_look", 600)), vert=("GP",), spd=o.get("final_spd", vapp), flap=30,
                 phase="FINAL", bank_lim=o.get("final_bank", 25))
    if "dive" in o:     # (ra_start, ra_end, extra_vs): steep, fast segment on final
        r0, r1, xv = o["dive"]
        steps += [Step(lambda s: s.haa < r0, final),
                  Step(lambda s: s.haa < r1, dict(vert=("GP", xv))),
                  Step(lambda s: s.haa < o.get("flare_h", 15), dict(vert=("GP",)))]
    else:
        steps.append(Step(lambda s: s.haa < o.get("flare_h", 15), final))
    steps += [
        Step(lambda s: s.on_ground, dict(vert=("FLARE",), flare_vs=o.get("flare_vs", -120), power="IDLE", phase="LANDING",
                                         spd=o.get("flare_spd", vapp - 8), tg=tg)),
    ]
    if tg:
        steps.append(Step(lambda s: not s.landed and s.on_ground and s.c["power"] == "FULL", dict(phase="ROLLOUT")))
    else:
        steps.append(Step(lambda s: False, dict(phase="ROLLOUT")))
    return steps


def flight(airports, rwy, seed, wind, t0, circuits):
    s = C172(airports, "VTPH", rwy, seed=seed, wind=wind, t0_local=t0)
    steps = []
    for k, (tg, o) in enumerate(circuits):
        steps += circuit(s, tg=tg, o=o, first=(k == 0))
    s.run(steps)
    return s


# ------------------------------------------------------------------ writers
G1000_UNITS = {
    "Lcl Date": "yyy-mm-dd", "Lcl Time": "hh:mm:ss", "UTCOfst": "hh:mm", "AtvWpt": "ident", "Latitude": "degrees",
    "Longitude": "degrees", "AltB": "ft Baro", "BaroA": "inch", "AltMSL": "ft msl", "OAT": "deg C", "IAS": "kt",
    "GndSpd": "kt", "VSpd": "fpm", "Pitch": "deg", "Roll": "deg", "LatAc": "G", "NormAc": "G", "HDG": "deg",
    "TRK": "deg", "volt1": "volts", "volt2": "volts", "amp1": "amps", "amp2": "amps", "FQtyL": "gals", "FQtyR": "gals",
    "E1 FFlow": "gph", "E1 OilT": "deg F", "E1 OilP": "PSI", "E1 RPM": "rpm", "E1 CHT1": "deg F", "E1 CHT2": "deg F",
    "E1 CHT3": "deg F", "E1 CHT4": "deg F", "E1 EGT1": "deg F", "E1 EGT2": "deg F", "E1 EGT3": "deg F",
    "E1 EGT4": "deg F", "AltGPS": "ft wgs", "TAS": "kt", "HSIS": "enum", "CRS": "deg", "NAV1": "MHz", "NAV2": "MHz",
    "COM1": "MHz", "COM2": "MHz", "HCDI": "fsd", "VCDI": "fsd", "WndSpd": "kt", "WndDr": "deg", "WptDst": "nm",
    "WptBrg": "deg", "MagVar": "deg", "AfcsOn": "bool", "RollM": "enum", "PitchM": "enum", "RollC": "deg",
    "PichC": "deg", "VSpdG": "fpm", "GPSfix": "enum", "HAL": "mt", "VAL": "mt", "HPLwas": "mt", "HPLfd": "mt", "VPLwas": "mt",
}


def write_g1000(path, rows, *, truncate_last=False):
    cols = list(G1000_UNITS)
    w = [max(len(c), 7) + 1 for c in cols]
    with open(path, "w", encoding="utf-8", newline="\r\n") as f:   # SD-card logs use CRLF
        f.write('#airframe_info, log_version="1.00", airframe_name="Cessna 172S", '
                'unit_software_part_number="006-B0000-00", unit_software_version="0.00", '
                'system_software_part_number="006-B0000-00", system_id="SYNTHETIC", mode=NORMAL,\n')
        units = ",".join(G1000_UNITS[c].rjust(n) for c, n in zip(cols, w))
        f.write("#" + (units[1:] if units[0] == " " else units) + "\n")
        f.write(",".join(c.rjust(n) for c, n in zip(cols, w)) + "\n")
        for k, r in enumerate(rows):
            line = ",".join(str(r[c]).rjust(n) for c, n in zip(cols, w))
            if truncate_last and k == len(rows) - 1:
                line = line[: len(line) // 3]          # power removed mid-write
            f.write(line + "\n")


def inject_defects(rows):
    """Recording problems a real QAR/SD log can have (for the data-quality checks)."""
    rows = [dict(r) for r in rows]
    defects = []
    del rows[300:309]
    defects.append("9 s recording gap (rows missing) near t=300 s")
    rows.insert(400, dict(rows[400]))
    rows.insert(400, dict(rows[400]))
    defects.append("2 duplicated time stamps near t=410 s")
    for r in rows[520:541]:
        r.update(Latitude="", Longitude="", GndSpd="", TRK="", AltGPS="", GPSfix="NoSoln")
    defects.append("GPS position lost for 21 s near t=530 s")
    stuck = rows[600]["AltMSL"]
    for r in rows[600:631]:
        r["AltMSL"] = stuck
        r["AltB"] = stuck
    defects.append("altitude frozen for 31 s near t=610 s")
    rows[700]["IAS"] = "251.30"
    defects.append("single-sample airspeed spike (251 kt) near t=710 s")
    defects.append("last line truncated (power removed while writing)")
    return rows, defects


OPERATOR_MAP = [  # (export column, unit, source column in our canonical CSV, scale)
    ("GMT", "hh:mm:ss.s", "utc", None), ("FRAME_TIME", "s", "time_s", 1), ("LATP", "deg", "lat", 1), ("LONP", "deg", "lon", 1),
    ("ALT_STD", "ft", "alt_ft", 1), ("RALT", "ft", "ra_ft", 1), ("CAS", "kt", "ias_kt", 1), ("TAS", "kt", "tas_kt", 1),
    ("GS", "kt", "gs_kt", 1), ("IVV", "ft/min", "vs_fpm", 1), ("PITCH", "deg", "pitch_deg", 1), ("ROLL", "deg", "roll_deg", 1),
    ("HEAD_TRUE", "deg", "hdg_true_deg", 1), ("HEAD_MAG", "deg", "hdg_mag_deg", 1), ("VRTG", "g", "nz_g", 1),
    ("FLAP_LEVER", "index", "flap", 1), ("LDG_SEL_DN", "bool", "gear", 1), ("AP_ENGAGED", "bool", "ap", 1),
    ("N11", "%", "n1_1", 1), ("N12", "%", "n1_2", 1), ("LOC_DEV", "ddm-dot", "loc_dev_dot", 1), ("GS_DEV", "ddm-dot", "gs_dev_dot", 1),
    ("WOW", "bool", "air_ground", "invert"), ("GPWS_SINK", "bool", "gpws_warn", 1), ("SAT", "deg C", "sat_c", 1),
]


def write_operator_export(src_csv, xlsx_path, csv_path):
    rows = read_flight_csv(src_csv)
    head = [c for c, *_ in OPERATOR_MAP]
    units = [u for _, u, *_ in OPERATOR_MAP]
    data = []
    for r in rows:
        out = []
        for _, _, src, sc in OPERATOR_MAP:
            v = r.get(src)
            if src == "utc":
                out.append(v[11:21])
            elif v is None or v != v:
                out.append(None)
            elif sc == "invert":
                out.append(0 if v >= 0.5 else 1)
            else:
                out.append(round(v, 4))
        data.append(out)
    with open(csv_path, "w", encoding="utf-8", newline="\n") as f:      # semicolon CSV, as Excel writes in many locales
        f.write(";".join(head) + "\n" + ";".join(units) + "\n")
        for d in data:
            f.write(";".join("" if v is None else str(v) for v in d) + "\n")
    try:
        from openpyxl import Workbook
    except ImportError:
        print("openpyxl not installed - skipped", xlsx_path.name)
        return
    wb = Workbook()
    info = wb.active
    info.title = "Info"
    for row in [("Report", "Decoder export (SYNTHETIC demo)"), ("Aircraft", "A320-family (SIMULATED)"),
                ("Registration", "HS-SIM"), ("Flight", "SIM02"), ("Date", rows[0]["utc"][:10]),
                ("Note", "Generated by tools/gen_samples.py from scenario S02. Not real data.")]:
        info.append(row)
    ws = wb.create_sheet("Data")
    ws.append(head)
    ws.append(units)
    for d in data:
        ws.append(d)
    wb.save(xlsx_path)


# ------------------------------------------------------------------ main
def main():
    airports = load_airports()
    OUT.mkdir(parents=True, exist_ok=True)
    D = lambda d, h, m: datetime(2026, 11, d, h, m, 0, tzinfo=LOCAL)
    entries = []

    def add(fid, title, title_th, rwy, s, desc_th, expect, defects=None):
        name = f"log_{s.t0.strftime('%y%m%d_%H%M%S')}_VTPH_{fid}.csv"
        rows = s.rows
        if defects is not None:
            rows, defects[:] = inject_defects(rows)
        write_g1000(OUT / name, rows, truncate_last=defects is not None)
        entries.append(dict(id=fid, title=title, title_th=title_th, kind="g1000", format="Garmin G1000 CSV",
                            template="g1000", profile="C172", airport="VTPH", runway=rwy,
                            aircraft="Cessna 172S (SIMULATED)", registration="HS-SIMC", callsign=f"SIM{fid[1:3]}",
                            date=s.t0.strftime("%Y-%m-%d"), vapp_kt=65, description_th=desc_th,
                            expected_events=expect, defects=defects or [], file=name,
                            normalized_file=f"{fid}.normalized.csv"))
        print(f"{fid:34s} {len(rows):5d} rows  {name}")

    s = flight(airports, "34", 11, (330, 8), D(18, 7, 5), [(True, {}), (True, {}), (False, {})])
    add("G01_VTPH_34_CIRCUITS", "C172 circuits VTPH RWY 34 (normal)", "C172 บินวงจร หัวหิน RWY 34 (ปกติ)", "34", s,
        "ฝึกบินวงจร touch-and-go 2 ครั้งแล้วลงจอด ไม่ควรพบ event", [])

    s = flight(airports, "34", 12, (320, 10), D(18, 9, 40), [
        (True, {}),
        (True, dict(dive=(650, 420, -750), final_spd=80, flare_h=6, flare_vs=-720, flare_spd=76)),
        (False, dict(flare_vs=-22, flare_spd=72, flare_h=34))])
    add("G02_VTPH_34_UNSTABLE_HARD_LONG", "C172 unstable approach, hard landing, long landing VTPH 34",
        "C172 บินเข้าไม่เสถียร ลงแรง และลงไกล หัวหิน RWY 34", "34", s,
        "วงจรที่ 2 บินเร็วและชันจนไม่เสถียรที่ 500/300 ft แล้วลงแรง วงจรที่ 3 ลอยตัวนานจนแตะพื้นไกล",
        ["UNSTABLE_1000", "UNSTABLE_500", "HIGH_ROD_FINAL", "HARD_LANDING", "LONG_LANDING"])

    s = flight(airports, "16", 13, (150, 7), D(19, 8, 15), [
        (True, dict(steep_turns=58, liftoff_pitch=12.6, rot_rate=5.5)),
        (False, dict(base_c=300, final_capture=50, final_look=180, final_bank=42, base_bank=30))])
    add("G03_VTPH_16_STEEP_TURNS_OVERSHOOT", "C172 steep turns + base-to-final overshoot VTPH 16",
        "C172 เลี้ยวชัน และเลี้ยวเข้า final เลยแนว หัวหิน RWY 16", "16", s,
        "เงยหัวแรงขณะขึ้น ฝึก steep turn ~60° ในพื้นที่ฝึก แล้วเลี้ยวเข้า final เลยแนวจนต้องเอียงแรงที่ความสูงต่ำ (เสี่ยง LOC-I)",
        ["HIGH_PITCH_LIFTOFF", "HIGH_PITCH_RATE_ROT", "HIGH_BANK", "HIGH_BANK_LOW_ALT"])

    s = flight(airports, "34", 14, (340, 6), D(20, 6, 50), [(True, {}), (True, {}), (False, {})])
    add("G04_VTPH_34_DATA_QUALITY", "C172 circuits with recording defects", "C172 บินวงจร ไฟล์มีข้อบกพร่องการบันทึก", "34", s,
        "ไฟล์สำหรับทดสอบการตรวจคุณภาพข้อมูล: ช่วงข้อมูลหาย, เวลาซ้ำ, GPS หาย, ความสูงค้าง, ค่าความเร็วกระโดด, บรรทัดสุดท้ายขาด",
        [], defects=[])

    src = DATA / "flights" / "S02_VTBD_21R_UNSTABLE.csv"
    write_operator_export(src, OUT / "X01_A320_decoder_export.xlsx", OUT / "X01_A320_decoder_export.csv")
    entries.append(dict(id="X01_A320_DECODER_EXPORT", title="A320 decoder export (Excel, mnemonics)",
                        title_th="ไฟล์ส่งออกจาก decoder ของ A320 (Excel, ชื่อพารามิเตอร์แบบย่อ)", kind="export",
                        format="Excel .xlsx (sheet 'Data', units row) / semicolon CSV", template="operator-mnemonic",
                        profile="A320", airport="VTBD", runway="21R", aircraft="A320-family (SIMULATED)",
                        registration="HS-SIM", callsign="SIM02", date="2026-11-20", vapp_kt=140,
                        description_th="ตัวอย่างไฟล์ที่ระบบ decoder ส่งออก ใช้ชื่อพารามิเตอร์แบบ ALT_STD, CAS, VRTG, RALT ต้องจับคู่คอลัมน์ก่อน",
                        expected_events=["UNSTABLE_1000", "UNSTABLE_500", "HIGH_ROD_FINAL", "GS_DEVIATION", "LONG_LANDING"],
                        defects=[], file="X01_A320_decoder_export.csv", xlsx="X01_A320_decoder_export.xlsx",
                        normalized_file="X01_A320_DECODER_EXPORT.normalized.csv"))
    (OUT / "index.json").write_text(json.dumps(dict(
        note="SYNTHETIC raw files for the import wizard - generated by tools/gen_samples.py, not real data",
        flights=entries), ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
