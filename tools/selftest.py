"""Check that every synthetic scenario produces exactly the events it was designed for."""
import json
import sys

from fdm_common import DATA, detect_events, load_airports, load_config, read_flight_csv

A, C = load_airports(), load_config()
idx = json.loads((DATA / "flights" / "index.json").read_text(encoding="utf-8"))
bad = 0
for f in idx["flights"]:
    ev = detect_events(read_flight_csv(DATA / "flights" / f["file"]), C, A, f["vapp_kt"])
    got, exp = {e["code"] for e in ev}, set(f["expected_events"])
    ok = got == exp
    bad += not ok
    print(f"{'OK ' if ok else 'FAIL'} {f['id']:40s} missing={sorted(exp - got)} extra={sorted(got - exp)}")
sys.exit(1 if bad else 0)
