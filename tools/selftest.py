"""Check that every synthetic flight produces exactly the events it was designed for.

Covers data/flights (A320 scenarios) and data/samples (raw G1000 / decoder files, using the
normalised CSV written by `node tools/import_cli.js --all`).
"""
import json
import sys

from fdm_common import DATA, detect_events, load_airports, load_config, read_flight_csv

A = load_airports()
bad = 0
for idx_path in (DATA / "flights" / "index.json", DATA / "samples" / "index.json"):
    if not idx_path.exists():
        continue
    for f in json.loads(idx_path.read_text(encoding="utf-8"))["flights"]:
        p = idx_path.parent / (f.get("normalized_file") or f["file"])
        if not p.exists():
            print(f"SKIP {f['id']:40s} ({p.name} missing - run node tools/import_cli.js --all)")
            continue
        ev = detect_events(read_flight_csv(p), load_config(f.get("profile")), A, f["vapp_kt"])
        got, exp = {e["code"] for e in ev}, set(f["expected_events"])
        ok = got == exp
        bad += not ok
        print(f"{'OK ' if ok else 'FAIL'} {f['id']:40s} missing={sorted(exp - got)} extra={sorted(got - exp)}")
sys.exit(1 if bad else 0)
