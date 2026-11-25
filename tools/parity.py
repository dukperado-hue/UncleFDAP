"""Check that js/events.js (run under Node) and tools/fdm_common.py give the same
events and routine measurements for every bundled flight.

    python tools/parity.py            (needs `node` on PATH)
"""
from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys

from fdm_common import DATA, ROOT, detect_events, load_airports, load_config, measurements, read_flight_csv


def close(a, b):
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return math.isclose(a, b, abs_tol=0.0101)
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(close(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(close(x, y) for x, y in zip(a, b))
    return a == b


def groups():
    """(profile, vapp, [csv paths]) for every flight listed in an index.json."""
    for idx_path in sorted(DATA.glob("**/index.json")):
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
        by = {}
        for f in idx.get("flights", []):
            p = idx_path.parent / (f.get("normalized_file") or f["file"])
            if p.suffix.lower() != ".csv" or not p.exists():
                continue
            by.setdefault((f.get("profile") or "A320", f.get("vapp_kt")), []).append(p)
        for (prof, vapp), files in by.items():
            yield prof, vapp, files


def main():
    node = shutil.which("node")
    if not node:
        print("node not found - skipping JS/Python parity check")
        return 0
    A = load_airports()
    bad = total = 0
    for prof, vapp, files in groups():
        js = json.loads(subprocess.run([node, str(ROOT / "tools" / "parity.js"), prof, str(vapp or "-"), *map(str, files)],
                                       capture_output=True, text=True, encoding="utf-8", check=True).stdout)
        C = load_config(prof)
        for p in files:
            rows = read_flight_csv(p)
            py_ev = [dict(code=e["code"], level=e["level"], t_peak=e["t_peak"], value=e["value"])
                     for e in detect_events(rows, C, A, vapp)]
            py_ms = measurements(rows, C, A, vapp)
            j = js[p.name]
            ok_e, ok_m = close(py_ev, j["events"]), close(py_ms, j["measures"])
            total += 1
            bad += not (ok_e and ok_m)
            print(f"{'OK ' if ok_e and ok_m else 'FAIL'} [{prof}] {p.name:45s} events={len(py_ev):2d} "
                  f"{'' if ok_e else 'EVENTS DIFFER '}{'' if ok_m else 'MEASURES DIFFER'}")
            if not ok_m:
                print("   py:", json.dumps(py_ms)[:600])
                print("   js:", json.dumps(j["measures"])[:600])
    print(f"{total - bad}/{total} flights identical")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
