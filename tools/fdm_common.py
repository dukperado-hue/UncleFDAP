"""Shared helpers: AIP airport data, local geometry and FDM event detection.

The event logic here mirrors js/events.js so the PDF/CSV reports and the web
viewer flag the same events. Thresholds live in data/events-config.json.
"""
from __future__ import annotations

import csv
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
R_EARTH = 6371008.8
FT = 0.3048
NAN = float("nan")


# ---------------------------------------------------------------- airports
def dms_to_deg(s: str) -> float:
    """'134016.60N' -> 13.6712..., '1004404.79E' -> 100.7346..."""
    m = re.fullmatch(r"(\d+)(\d\d)(\d\d(?:\.\d+)?)([NSEW])", s.strip())
    if not m:
        raise ValueError(f"bad DMS: {s}")
    d, mi, se, h = int(m[1]), int(m[2]), float(m[3]), m[4]
    v = d + mi / 60 + se / 3600
    return -v if h in "SW" else v


def parse_latlon(s: str) -> tuple[float, float]:
    a, b = s.split()
    return dms_to_deg(a), dms_to_deg(b)


def load_airports() -> dict:
    raw = json.loads((DATA / "airports.json").read_text(encoding="utf-8"))
    out = {}
    for icao, ap in raw["airports"].items():
        lat, lon = parse_latlon(ap["arp"])
        ap = dict(ap, icao=icao, lat=lat, lon=lon)
        rwys = {}
        for r in ap["runways"]:
            tlat, tlon = parse_latlon(r["thr"])
            rwys[r["id"]] = dict(r, lat=tlat, lon=tlon, icao=icao)
        ap["runways"] = rwys
        out[icao] = ap
    return out


def load_config(profile: str | None = None) -> dict:
    return resolve_config(json.loads((DATA / "events-config.json").read_text(encoding="utf-8")), profile)


def _strip(v):
    return {k: x for k, x in v.items() if k != "_replace"} if isinstance(v, dict) else v


def _merge(base, over):
    if not isinstance(over, dict) or not isinstance(base, dict) or over.get("_replace"):
        return _strip(over)
    out = dict(base)
    for k, v in over.items():
        out[k] = _merge(base[k], v) if k in base else _strip(v)
    return out


def resolve_config(cfg: dict, profile: str | None = None) -> dict:
    """Merge the aircraft-type profile (cfg['profiles'][name]) over the baseline. Mirrors js resolveConfig."""
    name = profile or cfg.get("default_profile")
    prof = (cfg.get("profiles") or {}).get(name) or {}
    over = {k: v for k, v in prof.items() if k not in ("label", "label_th")}
    out = _merge({k: v for k, v in cfg.items() if k != "profiles"}, over)
    out["profile"] = name
    out["profiles"] = cfg.get("profiles", {})
    return out


class Frame:
    """Flat-earth local frame (x east, y north, metres) around a reference point.
    Accurate to well under a metre over the ~60 km used here."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.k = math.cos(math.radians(lat0))

    def to_xy(self, lat, lon):
        return (math.radians(lon - self.lon0) * R_EARTH * self.k,
                math.radians(lat - self.lat0) * R_EARTH)

    def to_ll(self, x, y):
        return (self.lat0 + math.degrees(y / R_EARTH),
                self.lon0 + math.degrees(x / (R_EARTH * self.k)))


def rwy_coords(frame: Frame, rwy: dict, x: float, y: float):
    """Return (along, cross) in metres relative to the runway threshold.
    along > 0 is past the threshold, cross > 0 is right of the course."""
    tx, ty = frame.to_xy(rwy["lat"], rwy["lon"])
    c = math.radians(rwy["true_brg"])
    dx, dy = x - tx, y - ty
    return dx * math.sin(c) + dy * math.cos(c), dx * math.cos(c) - dy * math.sin(c)


def rwy_point(frame: Frame, rwy: dict, along: float, cross: float):
    tx, ty = frame.to_xy(rwy["lat"], rwy["lon"])
    c = math.radians(rwy["true_brg"])
    return (tx + along * math.sin(c) + cross * math.cos(c),
            ty + along * math.cos(c) - cross * math.sin(c))


def angdiff(a: float, b: float) -> float:
    """Signed smallest difference a-b in degrees, in (-180, 180]."""
    return (a - b + 180.0) % 360.0 - 180.0


# ---------------------------------------------------------------- CSV I/O
def read_flight_csv(path: Path) -> list[dict]:
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            row = {}
            for k, v in r.items():
                if k in ("utc", "phase"):
                    row[k] = v
                else:
                    row[k] = float(v) if v not in ("", None) else NAN
            rows.append(row)
    return rows


# ---------------------------------------------------------------- events
def _g(r, k):
    v = r.get(k, NAN)
    return NAN if v is None else v


def _segments(rows, pred):
    """Yield (i0, i1) index ranges (inclusive) where pred(row) is true."""
    i0 = None
    for i, r in enumerate(rows):
        if pred(r):
            if i0 is None:
                i0 = i
        elif i0 is not None:
            yield i0, i - 1
            i0 = None
    if i0 is not None:
        yield i0, len(rows) - 1


def find_runway(airports, lat, lon, hdg):
    """Runway the aircraft is on/aligned with: course within 25 deg and
    |cross-track| < 150 m. Returns (rwy, along_m) or (None, None)."""
    best = None
    for ap in airports.values():
        fr = Frame(ap["lat"], ap["lon"])
        x, y = fr.to_xy(lat, lon)
        for r in ap["runways"].values():
            if abs(angdiff(hdg, r["true_brg"])) > 25:
                continue
            a, c = rwy_coords(fr, r, x, y)
            if abs(c) < 150 and -8000 < a < r["length_m"] + 500:
                if best is None or abs(c) < best[2]:
                    best = (r, a, abs(c))
    return (best[0], best[1]) if best else (None, None)


def go_arounds(rows, air):
    """Indices of the lowest point of each go-around: descend below 1000 ft RA,
    then climb 400 ft without touching down."""
    n = len(rows)
    gas = []
    i = 1
    while i < n:
        if air[i] and _g(rows[i], "ra_ft") < 1000 and rows[i]["vs_fpm"] < 0:
            jmin = i
            j = i
            while j < n and air[j]:
                ra = _g(rows[j], "ra_ft")
                if ra == ra and ra < _g(rows[jmin], "ra_ft"):
                    jmin = j
                if ra == ra and ra > _g(rows[jmin], "ra_ft") + 400 or (ra != ra and j > jmin):
                    gas.append(jmin)
                    break
                j += 1
            i = j + 1
        else:
            i += 1
    return gas


def gate_index(rows, end, prev, gate):
    """Last row (searching back from `end` to `prev`) where RA crosses down through `gate`."""
    for j in range(end, max(prev, 0), -1):
        if _g(rows[j], "ra_ft") <= gate < _g(rows[j - 1], "ra_ft"):
            return j
    return None


def detect_events(rows: list[dict], cfg: dict, airports: dict, vapp: float | None = None) -> list[dict]:
    E = cfg["events"]
    uc = cfg["unstable_criteria"]
    vapp = vapp or cfg["vapp_default_kt"]
    vfe = {int(k): v for k, v in cfg["vfe_kt"].items()}
    n = len(rows)
    if n < 3:
        return []
    t = [r["time_s"] for r in rows]
    dt = (t[-1] - t[0]) / (n - 1)
    air = [(_g(r, "air_ground") >= 0.5) for r in rows]
    events = []

    def ev(code, level, i0, i1, ipk, value, detail=""):
        d = E[code]
        if d.get("enabled") is False:
            return
        events.append(dict(code=code, level=level, name=d["name"], th=d["th"],
                           t_start=round(t[i0], 1), t_end=round(t[i1], 1), t_peak=round(t[ipk], 1),
                           value=None if value is None else round(value, 2), unit=d.get("unit", ""),
                           detail=detail))

    def level_of(code, v):
        d = E[code]
        return 3 if v > d["l3"] else 2

    liftoffs = [i for i in range(1, n) if air[i] and not air[i - 1]]
    touchdowns = [i for i in range(1, n) if not air[i] and air[i - 1]]

    # pitch rate (central difference)
    pr = [NAN] * n
    for i in range(1, n - 1):
        pr[i] = (rows[i + 1]["pitch_deg"] - rows[i - 1]["pitch_deg"]) / (t[i + 1] - t[i - 1])

    for i in liftoffs:
        p = rows[i]["pitch_deg"]
        d = E["HIGH_PITCH_LIFTOFF"]
        if p > d["l2"]:
            ev("HIGH_PITCH_LIFTOFF", level_of("HIGH_PITCH_LIFTOFF", p), i, i, i, p)
        j0 = max(1, i - int(10 / dt))
        j1 = min(n - 2, i + int(3 / dt))
        jm = max(range(j0, j1 + 1), key=lambda j: pr[j] if pr[j] == pr[j] else -99)
        d = E["HIGH_PITCH_RATE_ROT"]
        if pr[jm] > d["l2"]:
            ev("HIGH_PITCH_RATE_ROT", level_of("HIGH_PITCH_RATE_ROT", pr[jm]), j0, j1, jm, pr[jm])

    # flap overspeed
    d = E["FLAP_OVERSPEED"]
    def over(r):
        f = int(round(_g(r, "flap"))) if _g(r, "flap") == _g(r, "flap") else 0
        return r["ias_kt"] - vfe[f] if f in vfe else -999
    for i0, i1 in _segments(rows, lambda r: _g(r, "air_ground") >= 0.5 and over(r) > d["l2"]):
        if (i1 - i0 + 1) * dt >= d["min_s"]:
            ipk = max(range(i0, i1 + 1), key=lambda i: over(rows[i]))
            v = over(rows[ipk])
            ev("FLAP_OVERSPEED", 3 if v > d["l3"] else 2, i0, i1, ipk, v,
               f"flap {int(rows[ipk]['flap'])} VFE {vfe[int(rows[ipk]['flap'])]} kt, IAS {rows[ipk]['ias_kt']:.0f} kt")

    # 250 kt below 10,000 ft
    d = E["SPEED_250_BELOW_FL100"]
    for i0, i1 in _segments(rows, lambda r: _g(r, "air_ground") >= 0.5 and r["alt_ft"] < 10000 and r["ias_kt"] > d["l2"]):
        if (i1 - i0 + 1) * dt >= d["min_s"]:
            ipk = max(range(i0, i1 + 1), key=lambda i: rows[i]["ias_kt"])
            v = rows[ipk]["ias_kt"]
            ev("SPEED_250_BELOW_FL100", level_of("SPEED_250_BELOW_FL100", v), i0, i1, ipk, v)

    # bank angles
    d = E["HIGH_BANK"]
    for i0, i1 in _segments(rows, lambda r: _g(r, "air_ground") >= 0.5 and abs(r["roll_deg"]) > d["l2"]):
        ipk = max(range(i0, i1 + 1), key=lambda i: abs(rows[i]["roll_deg"]))
        v = abs(rows[ipk]["roll_deg"])
        ev("HIGH_BANK", level_of("HIGH_BANK", v), i0, i1, ipk, v)
    d = E["HIGH_BANK_LOW_ALT"]
    for i0, i1 in _segments(rows, lambda r: _g(r, "air_ground") >= 0.5 and _g(r, "ra_ft") < d["ra_max"] and abs(r["roll_deg"]) > d["l2"]):
        ipk = max(range(i0, i1 + 1), key=lambda i: abs(rows[i]["roll_deg"]))
        v = abs(rows[ipk]["roll_deg"])
        ev("HIGH_BANK_LOW_ALT", level_of("HIGH_BANK_LOW_ALT", v), i0, i1, ipk, v,
           f"RA {rows[ipk]['ra_ft']:.0f} ft")

    # high rate of descent on final
    d = E["HIGH_ROD_FINAL"]
    for i0, i1 in _segments(rows, lambda r: _g(r, "air_ground") >= 0.5 and d["ra_min"] < _g(r, "ra_ft") < d["ra_max"] and -r["vs_fpm"] > d["l2"]):
        if (i1 - i0 + 1) * dt >= d["min_s"]:
            ipk = min(range(i0, i1 + 1), key=lambda i: rows[i]["vs_fpm"])
            v = -rows[ipk]["vs_fpm"]
            ev("HIGH_ROD_FINAL", level_of("HIGH_ROD_FINAL", v), i0, i1, ipk, v, f"RA {rows[ipk]['ra_ft']:.0f} ft")

    # GPWS discrete
    for i0, i1 in _segments(rows, lambda r: _g(r, "gpws_warn") >= 0.5):
        ev("GPWS_WARNING", 3, i0, i1, i0, 1, "SINK RATE")

    # ILS deviations
    for code, col in (("GS_DEVIATION", "gs_dev_dot"), ("LOC_DEVIATION", "loc_dev_dot")):
        d = E[code]
        for i0, i1 in _segments(rows, lambda r: _g(r, "air_ground") >= 0.5 and r["vs_fpm"] < 0 and d["ra_min"] < _g(r, "ra_ft") < d["ra_max"] and abs(_g(r, col)) > d["l2"]):
            if (i1 - i0 + 1) * dt >= d["min_s"]:
                ipk = max(range(i0, i1 + 1), key=lambda i: abs(rows[i][col]))
                v = abs(rows[ipk][col])
                ev(code, level_of(code, v), i0, i1, ipk, v, f"{rows[ipk][col]:+.2f} dot at RA {rows[ipk]['ra_ft']:.0f} ft")

    gas = go_arounds(rows, air)
    for g in gas:
        ev("GO_AROUND", 1, g, g, g, rows[g]["ra_ft"], f"minimum RA {rows[g]['ra_ft']:.0f} ft")

    # approach gates (for each landing or go-around)
    marks = sorted(touchdowns + gas + liftoffs)
    for end in sorted(touchdowns + gas):
        prev = max([m for m in marks if m < end], default=0)
        for code in ("UNSTABLE_1000", "UNSTABLE_500"):
            gate = E[code]["gate_ft"]
            gi = gate_index(rows, end, prev, gate)
            if gi is None:
                continue
            r = dict(rows[gi])
            w = rows[max(0, gi - 2): gi + 3]          # +-1 s average smooths gust spikes
            r["ias_kt"] = sum(x["ias_kt"] for x in w) / len(w)
            r["vs_fpm"] = sum(x["vs_fpm"] for x in w) / len(w)
            why = []
            if r["ias_kt"] > vapp + uc["ias_above_vapp_kt"]:
                why.append(f"IAS {r['ias_kt']:.0f} kt > Vapp+{uc['ias_above_vapp_kt']}")
            if r["ias_kt"] < vapp - uc["ias_below_vapp_kt"]:
                why.append(f"IAS {r['ias_kt']:.0f} kt < Vapp-{uc['ias_below_vapp_kt']}")
            if r["vs_fpm"] < uc["vs_min_fpm"]:
                why.append(f"V/S {r['vs_fpm']:.0f} fpm")
            if _g(r, "flap") < uc["landing_flap_min"]:
                why.append(f"flap {int(r['flap'])} (not landing config)")
            if _g(r, "gear") < 0.5:
                why.append("gear not down")
            if abs(_g(r, "loc_dev_dot")) > uc["loc_dev_dot"]:
                why.append(f"LOC {r['loc_dev_dot']:+.1f} dot")
            if abs(_g(r, "gs_dev_dot")) > uc["gs_dev_dot"]:
                why.append(f"G/S {r['gs_dev_dot']:+.1f} dot")
            if why:
                ev(code, E[code]["level"], gi, gi, gi, len(why), "; ".join(why))

    # landings
    for td in touchdowns:
        j0, j1 = max(0, td - int(1 / dt)), min(n - 1, td + int(3 / dt))
        jm = max(range(j0, j1 + 1), key=lambda j: rows[j]["nz_g"])
        v = rows[jm]["nz_g"]
        if v > E["HARD_LANDING"]["l2"]:
            ev("HARD_LANDING", level_of("HARD_LANDING", v), j0, j1, jm, v,
               f"V/S at touchdown {rows[td - 1]['vs_fpm']:.0f} fpm")
        r = rows[td]
        rwy, along = find_runway(airports, r["lat"], r["lon"], r["hdg_true_deg"])
        if rwy is not None and along > E["LONG_LANDING"]["l2"]:
            ev("LONG_LANDING", level_of("LONG_LANDING", along), td, td, td, along,
               f"{rwy['icao']} RWY {rwy['id']}: touchdown {along:.0f} m past THR")

    events.sort(key=lambda e: e["t_peak"])
    return events


def flight_summary(rows: list[dict], airports: dict) -> dict:
    """Departure/arrival runway, touchdown point etc. for reports."""
    n = len(rows)
    air = [(_g(r, "air_ground") >= 0.5) for r in rows]
    out = dict(duration_s=rows[-1]["time_s"] - rows[0]["time_s"],
               max_alt_ft=max(r["alt_ft"] for r in rows),
               max_ias_kt=max(r["ias_kt"] for r in rows),
               max_nz_g=max(r["nz_g"] for r in rows), landings=[], takeoffs=[])
    for i in range(1, n):
        if air[i] != air[i - 1]:
            r = rows[i]
            rwy, along = find_runway(airports, r["lat"], r["lon"], r["hdg_true_deg"])
            item = dict(t=r["time_s"], rwy=f"{rwy['icao']} {rwy['id']}" if rwy else "?",
                        along_m=round(along) if along is not None else None, ias_kt=round(r["ias_kt"]))
            (out["takeoffs"] if air[i] else out["landings"]).append(item)
    return out


# ---------------------------------------------------------------- routine measurements
def _r(v, nd=1):
    """Round, mapping NaN/None to None (JSON null). Mirrors js rnd()."""
    if v is None or v != v:
        return None
    k = 10 ** nd
    return math.floor(v * k + 0.5) / k   # half-up like JS Math.round


def measurements(rows: list[dict], cfg: dict, airports: dict, vapp: float | None = None) -> dict:
    """Doc 10000 'routine measurements': values kept for EVERY flight (not only
    exceedances) so distributions and trends can be watched before thresholds trip.
    Mirrors js FDM.measurements()."""
    vapp = vapp or cfg["vapp_default_kt"]
    gates = cfg.get("gates_ft", [1000, 500, 50])
    n = len(rows)
    out = dict(landings=[], takeoffs=[], flight={})
    if n < 3:
        return out
    t = [r["time_s"] for r in rows]
    dt = (t[-1] - t[0]) / (n - 1)
    air = [(_g(r, "air_ground") >= 0.5) for r in rows]
    liftoffs = [i for i in range(1, n) if air[i] and not air[i - 1]]
    touchdowns = [i for i in range(1, n) if not air[i] and air[i - 1]]
    gas = go_arounds(rows, air)
    marks = sorted(touchdowns + gas + liftoffs)

    for td in touchdowns:
        prev = max([m for m in marks if m < td], default=0)
        j0, j1 = max(0, td - int(1 / dt)), min(n - 1, td + int(3 / dt))
        k0 = max(prev, td - int(3 / dt))
        rwy, along = find_runway(airports, rows[td]["lat"], rows[td]["lon"], rows[td]["hdg_true_deg"])
        m = dict(t=_r(t[td]), rwy=f"{rwy['icao']} {rwy['id']}" if rwy else None,
                 td_nz_g=_r(max(rows[j]["nz_g"] for j in range(j0, j1 + 1)), 3),
                 td_vs_fpm=_r(rows[td - 1]["vs_fpm"], 0),
                 td_pitch_deg=_r(rows[td]["pitch_deg"], 2),
                 td_roll_max_deg=_r(max(abs(rows[k]["roll_deg"]) for k in range(k0, td + 1)), 2),
                 td_ias_kt=_r(rows[td]["ias_kt"]),
                 td_dist_m=_r(along, 0) if rwy else None)
        for gate in gates:
            gi = gate_index(rows, td, prev, gate)
            if gi is None:
                m[f"ias_dev_{gate}"] = m[f"vs_{gate}"] = m[f"gs_dev_{gate}"] = None
                continue
            w = rows[max(0, gi - 2): gi + 3]
            m[f"ias_dev_{gate}"] = _r(sum(x["ias_kt"] for x in w) / len(w) - vapp)
            m[f"vs_{gate}"] = _r(sum(x["vs_fpm"] for x in w) / len(w), 0)
            m[f"gs_dev_{gate}"] = _r(_g(rows[gi], "gs_dev_dot"), 2)
        rod = [-rows[k]["vs_fpm"] for k in range(prev, td) if 50 < _g(rows[k], "ra_ft") < gates[0]]
        m["max_rod_final_fpm"] = _r(max(rod), 0) if rod else None
        out["landings"].append(m)

    for lo in liftoffs:
        j0 = max(1, lo - int(10 / dt))
        j1 = min(n - 2, lo + int(3 / dt))
        prs = [(rows[j + 1]["pitch_deg"] - rows[j - 1]["pitch_deg"]) / (t[j + 1] - t[j - 1]) for j in range(j0, j1 + 1)]
        rwy, _ = find_runway(airports, rows[lo]["lat"], rows[lo]["lon"], rows[lo]["hdg_true_deg"])
        out["takeoffs"].append(dict(t=_r(t[lo]), rwy=f"{rwy['icao']} {rwy['id']}" if rwy else None,
                                    lo_pitch_deg=_r(rows[lo]["pitch_deg"], 2), lo_ias_kt=_r(rows[lo]["ias_kt"]),
                                    max_pitch_rate=_r(max(prs), 2) if prs else None))

    airborne = [abs(r["roll_deg"]) for r, a in zip(rows, air) if a]
    out["flight"] = dict(duration_s=_r(t[-1] - t[0]), max_alt_ft=_r(max(r["alt_ft"] for r in rows), 0),
                         max_bank_deg=_r(max(airborne), 1) if airborne else None,
                         n_takeoffs=len(liftoffs), n_landings=len(touchdowns), n_go_arounds=len(gas))
    return out
