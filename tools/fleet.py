"""Build a SYNTHETIC 12-month fleet dataset for the Stats & Trends page (data/fleet/fleet.json).

Nothing here is real. Two demo operators:
  - "Airline (A320)": departures + arrivals at VTBS / VTBD with randomised technique,
    weather and occasional deviations (generate.py simulator)
  - "Flight school (C172)": circuit-training sorties at VTPH (gen_samples.py simulator)
A storyline is built in so the trend charts have something to show: VTBD unstable
approaches rise in the wet season (Jun-Sep) and fall after a safety-promotion
campaign issued in Sep 2026 (EAFDM: check that trends respond to safety messages).

Only summaries are stored (events + routine measurements + QC), not the time series,
except for the bundled scenario/sample flights which link to the replay page.

    python tools/fleet.py [--n-airline 300] [--n-school 140]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from datetime import datetime, timedelta, timezone

import generate as gen
import gen_samples as gs
from fdm_common import (DATA, detect_events, load_airports, load_config, measurements, read_flight_csv)

NAN = float("nan")
MONTHS = [(2025, 12)] + [(2026, m) for m in range(1, 12)]
CAMPAIGN = "2026-09"
UTC = timezone.utc


def key_for(seed_text):
    return "F" + hashlib.sha256(seed_text.encode()).hexdigest()[:7].upper()


def u(rng, a, b):
    return rng.uniform(a, b)


# ------------------------------------------------------------------ A320 airline
ARR_RWYS = {"VTBS": ["19", "20L", "01", "02R"], "VTBD": ["21R", "21L", "03L"]}
DEP_RWYS = {"VTBS": ["20R", "19", "02L", "01"], "VTBD": ["21R", "21L", "03R"]}


def airline_flight(airports, rng, n, ym):
    y, m = ym
    day = rng.randint(1, 28)
    t0 = datetime(y, m, day, rng.randint(0, 15), rng.choice([0, 10, 20, 30, 40, 50]), tzinfo=UTC)
    dep, arr = rng.choice([("VTBS", "VTBD"), ("VTBD", "VTBS"), ("VTBS", "VTBS"), ("VTBD", "VTBD")])
    wet = m in (6, 7, 8, 9)
    after = f"{y}-{m:02d}" >= "2026-10"
    vapp = round(rng.gauss(138, 4))
    turb = u(rng, 0.5, 1.5 if wet else 1.2)
    training = rng.random() < 0.03
    # ---- departure
    drwy = rng.choice(DEP_RWYS[dep])
    brg = airports[dep]["runways"][drwy]["true_brg"]
    wind = ((brg + rng.gauss(0, 35)) % 360, u(rng, 3, 16))
    od = dict(rot_rate=max(1.8, rng.gauss(2.85, 0.25)), liftoff_pitch=rng.gauss(8.2, 0.5),
              flap_up_ias=rng.gauss(205, 6), climb_spd=250, turn_bank=25)
    if rng.random() < 0.02:
        od["rot_rate"] = u(rng, 3.8, 5.2)
    if rng.random() < 0.012:
        od["liftoff_pitch"] = u(rng, 9.8, 11.2)
    if rng.random() < 0.012:
        od["flap_up_ias"] = u(rng, 236, 246)
    if rng.random() < 0.015:
        od["climb_spd"] = u(rng, 257, 268)
    if rng.random() < 0.015:
        od["turn_bank"] = u(rng, 33, 39)
    sim, steps = gen.departure(airports, dep, drwy, seed=rng.randrange(1 << 30), wind=wind, t0=t0,
                               out_hdg=rng.choice([90, 180, 280, 320]), tmax=360, turb=turb, o=od)
    rows_d = sim.run(steps, tmax=1800)
    # ---- arrival
    arwy = rng.choice(ARR_RWYS[arr])
    brg = airports[arr]["runways"][arwy]["true_brg"]
    wind = ((brg + rng.gauss(0, 30)) % 360, u(rng, 3, 20 if wet else 14))
    p_unst = 0.025
    if arr == "VTBD" and wet:
        p_unst = 0.13
    if arr == "VTBD" and after:
        p_unst = 0.02
    if training:
        p_unst += 0.10
    oa = dict(final_spd=vapp + max(-3, rng.gauss(4, 3)), flare_vs=max(-280, min(-120, rng.gauss(-185, 35))),
              flare_h=max(20, rng.gauss(28, 3)))
    if rng.random() < p_unst:
        oa.update(final_spd=vapp + u(rng, 14, 30), dive=(u(rng, 1300, 1500), u(rng, 820, 980), -u(rng, 1000, 1650)))
        if rng.random() < 0.5:
            oa["flap_final"] = 3
    if rng.random() < 0.012:
        oa.update(late_extra=(45, -u(rng, 250, 400)), flare_h=10, flare_vs=-u(rng, 820, 1080))
    elif rng.random() < 0.02:
        oa.update(flare_h=u(rng, 38, 44), flare_vs=-u(rng, 70, 95))
    if rng.random() < 0.025:
        oa["loc_offset"] = (u(rng, -220, 220), u(rng, 450, 620), u(rng, 20, 30), u(rng, 1.0, 2.2))
    ga = rng.random() < (0.015 if wet else 0.007)
    if ga:
        oa = dict(loc_offset=oa.get("loc_offset", (u(rng, 120, 200), 450, 25, 1.0)), ga_at_ra=u(rng, 450, 800))
    t1 = t0 + timedelta(minutes=rng.randint(40, 80))
    sim, steps = gen.arrival(airports, arr, arwy, seed=rng.randrange(1 << 30), wind=wind, t0=t1, vapp=vapp, turb=turb, o=oa)
    if ga:
        steps = steps + gen.go_around_and_reland(sim, airports[arr]["runways"][arwy], vapp)
    rows_a = sim.run(steps, tmax=2400)
    reg = f"HS-SA{chr(65 + n % 8)}"
    return dict(profile="A320", fleet="Airline (A320)", aircraft="A320-family (SIMULATED)", registration=reg,
                callsign=f"SIM{100 + n % 400}", flight_type="training" if training else "revenue",
                dep=dep, arr=arr, date=t0.strftime("%Y-%m-%d"), time_utc=t0.strftime("%H:%M"), vapp_kt=vapp,
                segments=[rows_d, rows_a])


# ------------------------------------------------------------------ C172 school
def school_flight(airports, rng, n, ym):
    y, m = ym
    rwy = rng.choice(["34", "34", "16"])
    brg = airports["VTPH"]["runways"][rwy]["true_brg"]
    t0 = datetime(y, m, rng.randint(1, 28), rng.randint(6, 16), rng.choice([0, 15, 30, 45]), tzinfo=gs.LOCAL)
    wet = m in (6, 7, 8, 9)
    circuits = []
    nc = rng.randint(2, 4)
    for k in range(nc):
        o = dict(flare_vs=max(-260, min(-80, rng.gauss(-140, 35))), flare_h=max(8, rng.gauss(15, 3)))
        if k == 0 and rng.random() < 0.15:
            o.update(steep_turns=rng.choice([45, 50, 55, 58]))
        if k == 0 and rng.random() < 0.03:
            o.update(liftoff_pitch=u(rng, 12.2, 14), rot_rate=u(rng, 5.2, 6.5))
        if rng.random() < (0.06 if wet else 0.03):
            o.update(dive=(650, 420, -u(rng, 600, 800)), final_spd=u(rng, 76, 82))
        if rng.random() < 0.015:
            o.update(flare_h=6, flare_vs=-u(rng, 650, 760), flare_spd=74)
        elif rng.random() < 0.025:
            o.update(flare_vs=-u(rng, 18, 26), flare_spd=72, flare_h=34)
        if rng.random() < 0.02:
            o.update(base_c=300, final_capture=50, final_look=180, final_bank=42, base_bank=30)
        circuits.append((k < nc - 1, o))
    s = gs.C172(airports, "VTPH", rwy, seed=rng.randrange(1 << 30), wind=((brg + rng.gauss(0, 30)) % 360, u(rng, 2, 12)),
                t0_local=t0)
    steps = []
    for k, (tg, o) in enumerate(circuits):
        steps += gs.circuit(s, tg=tg, o=o, first=(k == 0))
    s.run(steps)
    return dict(profile="C172", fleet="Flight school (C172)", aircraft="Cessna 172S (SIMULATED)",
                registration=f"HS-SC{chr(65 + n % 5)}", callsign=f"SCH{n % 90 + 10}",
                flight_type="instruction", dep="VTPH", arr="VTPH",
                date=t0.astimezone(UTC).strftime("%Y-%m-%d"), time_utc=t0.astimezone(UTC).strftime("%H:%M"),
                vapp_kt=65, segments=[c172_canonical(s)])


def c172_canonical(s):
    """Truth-state canonical rows for the C172 sim (the importer is not needed for the fleet)."""
    out = []
    mv = s.ap["magvar_deg"]
    for i, r in enumerate(s.rows):
        lat, lon = float(r["Latitude"]), float(r["Longitude"])
        alt = float(r["AltMSL"])
        ge = gs_elev(s, lat, lon)
        haa = alt - ge
        out.append(dict(time_s=float(i), lat=lat, lon=lon, alt_ft=alt,
                        ra_ft=max(haa, 0) if haa < 2500 else NAN, ias_kt=float(r["IAS"]), gs_kt=float(r["GndSpd"]),
                        vs_fpm=float(r["VSpd"]), pitch_deg=float(r["Pitch"]), roll_deg=float(r["Roll"]),
                        hdg_true_deg=(float(r["HDG"]) + mv) % 360, nz_g=float(r["NormAc"]) + 1, flap=NAN, gear=1,
                        air_ground=0 if haa <= 3 and float(r["IAS"]) < 75 else (1 if haa > 3 else 0),
                        gs_dev_dot=NAN, loc_dev_dot=NAN, gpws_warn=0))
    # hysteresis like the importer: airborne only after IAS >= 50 and height > 15 ft
    air = False
    for r in out:
        h = r["alt_ft"] - gs_elev(s, r["lat"], r["lon"])
        if not air and r["ias_kt"] >= 50 and h > 15:
            air = True
        elif air and h <= 5:
            air = False
        r["air_ground"] = 1 if air else 0
    return out


def gs_elev(s, lat, lon):
    from fdm_common import rwy_coords
    x, y = s.fr.to_xy(lat, lon)
    a, c = rwy_coords(s.fr, s.rwy, x, y)
    if abs(c) < 100 and 0 <= a <= s.rwy["length_m"]:
        return s.rwy["thr_elev_ft"] + (s.pair["thr_elev_ft"] - s.rwy["thr_elev_ft"]) * a / s.rwy["length_m"]
    return min(s.rwy["thr_elev_ft"], s.pair["thr_elev_ft"]) if math.hypot(x, y) < 15000 else NAN


# ------------------------------------------------------------------ summarise
def as_rows(rows):
    """generate.py rows have '' for missing values; make them floats like read_flight_csv."""
    out = []
    for r in rows:
        o = {}
        for k, v in r.items():
            o[k] = v if k in ("utc", "phase") else (NAN if v in ("", None) else float(v))
        out.append(o)
    return out


def summarise(f, airports, cfgs, rng):
    cfg = cfgs[f["profile"]]
    events, meas = [], dict(landings=[], takeoffs=[], flight={})
    t_off = 0.0
    dur = 0.0
    for seg in f.pop("segments"):
        rows = as_rows(seg)
        for e in detect_events(rows, cfg, airports, f["vapp_kt"]):
            e = {k: e[k] for k in ("code", "level", "name", "th", "t_peak", "value", "unit", "detail")}
            e["t_peak"] = round(e["t_peak"] + t_off, 1)
            events.append(e)
        m = measurements(rows, cfg, airports, f["vapp_kt"])
        for k in ("landings", "takeoffs"):
            for x in m[k]:
                x["t"] = round(x["t"] + t_off, 1)
                meas[k].append(x)
        fl = m["flight"]
        dur += fl.get("duration_s") or 0
        meas["flight"] = dict(duration_s=round(dur, 1),
                              max_alt_ft=max(meas["flight"].get("max_alt_ft") or 0, fl.get("max_alt_ft") or 0),
                              max_bank_deg=max(meas["flight"].get("max_bank_deg") or 0, fl.get("max_bank_deg") or 0),
                              n_takeoffs=meas["flight"].get("n_takeoffs", 0) + fl["n_takeoffs"],
                              n_landings=meas["flight"].get("n_landings", 0) + fl["n_landings"],
                              n_go_arounds=meas["flight"].get("n_go_arounds", 0) + fl["n_go_arounds"])
        t_off += (rows[-1]["time_s"] if rows else 0) + 3600
    f["events"] = events
    f["measures"] = meas
    f["month"] = f["date"][:7]
    f["qc_score"] = 100 - rng.choice([0, 0, 0, 0, 3, 3, 6, 9, 12, 25])
    f["key"] = key_for(f"{f['registration']}|{f['date']}|{f['time_utc']}|{f['callsign']}")
    for e in events:
        e["id"] = f"{f['key']}:{e['code']}:{e['t_peak']}"
    return f


def prereview(f, rng, today="2026-11"):
    """Older events already went through the workflow; the last month is still NEW."""
    for e in f["events"]:
        if f["month"] >= "2026-10" or e["level"] == 1:
            e["status"] = "NEW" if e["level"] > 1 else "CLOSED"
            continue
        r = rng.random()
        if r < 0.10:
            e["status"], note = "NUISANCE", "false trigger - parameter glitch, confirmed against crew report"
        elif r < 0.18 and e["level"] == 3:
            e["status"], note = "CLOSED", "crew contacted by gatekeeper (confidential); debrief done"
        else:
            e["status"], note = "CLOSED", "validated; trend reviewed at monthly FDM meeting"
        e["history"] = [dict(at=f"{f['date']}T12:00:00Z", by="analyst", status="VALID"),
                        dict(at=f"{f['date']}T15:00:00Z", by="analyst", status=e["status"], comment=note)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-airline", type=int, default=420)
    ap.add_argument("--n-school", type=int, default=160)
    ap.add_argument("--seed", type=int, default=2026)
    a = ap.parse_args()
    airports = load_airports()
    cfgs = {p: load_config(p) for p in ("A320", "C172")}
    rng = random.Random(a.seed)
    flights = []
    for n in range(a.n_airline):
        ym = MONTHS[n * len(MONTHS) // a.n_airline]
        flights.append(summarise(airline_flight(airports, rng, n, ym), airports, cfgs, rng))
        if n % 50 == 0:
            print("airline", n)
    for n in range(a.n_school):
        ym = MONTHS[n * len(MONTHS) // a.n_school]
        flights.append(summarise(school_flight(airports, rng, n, ym), airports, cfgs, rng))
        if n % 50 == 0:
            print("school", n)
    # bundled flights that can be replayed (spread over the last 9 months)
    bundled = 0
    for idx_path, prof_default in ((DATA / "flights" / "index.json", "A320"), (DATA / "samples" / "index.json", None)):
        for s in json.loads(idx_path.read_text(encoding="utf-8"))["flights"]:
            if s.get("kind") == "export":      # X01 is S02 re-exported - do not count it twice
                continue
            prof = s.get("profile") or prof_default
            p = idx_path.parent / (s.get("normalized_file") or s["file"])
            rows = read_flight_csv(p)
            f = dict(profile=prof, fleet="Airline (A320)" if prof == "A320" else "Flight school (C172)",
                     aircraft=s["aircraft"], registration=s["registration"], callsign=s["callsign"],
                     flight_type="revenue" if prof == "A320" else "instruction", dep=s.get("airport"), arr=s.get("airport"),
                     date="%d-%02d" % MONTHS[-1 - bundled % 9] + "-%02d" % (10 + bundled % 15), time_utc="%02d:%02d" % (bundled % 15 + 1, 5),
                     vapp_kt=s["vapp_kt"], segments=[rows], replay=s["id"])
            f = summarise(f, airports, cfgs, rng)
            flights.append(f)
            bundled += 1
    for f in flights:
        prereview(f, rng)
    # flights operated vs recorded per month (data recovery SPI)
    ops = {}
    for f in flights:
        k = (f["fleet"], f["month"])
        ops[k] = ops.get(k, 0) + 1
    operated = [dict(fleet=k[0], month=k[1], recorded=v, operated=v + max(0, round(v * rng.uniform(0.02, 0.09))))
                for k, v in sorted(ops.items())]
    out = dict(note="SYNTHETIC fleet dataset generated by tools/fleet.py - not real flight data",
               generated="2026-11-25", months=[f"{y}-{m:02d}" for y, m in MONTHS],
               annotations=[dict(month=CAMPAIGN, fleet="Airline (A320)", text="Safety promotion: stabilised-approach campaign (VTBD)",
                                 text_th="ประชาสัมพันธ์ความปลอดภัย: รณรงค์ stabilised approach (VTBD)")],
               operated=operated, flights=flights)
    (DATA / "fleet").mkdir(exist_ok=True)
    (DATA / "fleet" / "fleet.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
                                               encoding="utf-8", newline="\n")
    ev = sum(len(f["events"]) for f in flights)
    print(f"{len(flights)} flights, {ev} events -> data/fleet/fleet.json")


if __name__ == "__main__":
    main()
