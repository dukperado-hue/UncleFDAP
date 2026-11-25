"""End-to-end test of server/fdap_server.py: roles, de-identification, review, retention, audit.

    python tools/server_test.py
Starts a throw-away server on a free port with a temporary data directory.
"""
from __future__ import annotations

import http.cookiejar
import json
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRV = [sys.executable, str(ROOT / "server" / "fdap_server.py")]
PW = "test-password-123"
fails = 0


def check(cond, msg):
    global fails
    print(("PASS " if cond else "FAIL ") + msg)
    fails += not cond


class Client:
    def __init__(self, base):
        self.base = base
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def req(self, method, path, body=None, header=True):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method)
        r.add_header("Content-Type", "application/json")
        if header:
            r.add_header("X-FDAP", "1")
        try:
            with self.op.open(r) as resp:
                raw = resp.read().decode()
                ct = resp.headers.get("Content-Type", "")
                return resp.status, (json.loads(raw) if "json" in ct else raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, raw

    def login(self, user):
        return self.req("POST", "/api/login", {"username": user, "password": PW})


def main():
    tmp = tempfile.mkdtemp(prefix="fdap_test_")
    data = ["--data", tmp]
    subprocess.run(SRV + ["init", "--password", PW] + data, check=True, capture_output=True)
    for u, r in (("gk1", "gatekeeper"), ("an1", "analyst"), ("mg1", "manager")):
        subprocess.run(SRV + ["adduser", u, r, "--password", PW] + data, check=True, capture_output=True)
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    proc = subprocess.Popen(SRV + ["serve", "--port", str(port), "--deid-days", "30"] + data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    base = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            urllib.request.urlopen(base + "/login.html", timeout=0.5)
            break
        except Exception:
            time.sleep(0.1)
    try:
        anon = Client(base)
        check(anon.req("GET", "/api/me")[0] == 401, "anonymous /api/me -> 401")
        check(anon.req("POST", "/api/login", {"username": "an1", "password": "wrong-password"})[0] == 401, "wrong password -> 401")
        check(anon.req("GET", "/server/fdap_server.py")[0] == 404, "server source not served")
        check(anon.req("GET", "/%2e%2e/README.md")[0] == 404, "path traversal blocked")
        check(anon.req("GET", "/index.html")[0] == 200, "static page served")

        an, gk, mg, ad = Client(base), Client(base), Client(base), Client(base)
        for c, u in ((an, "an1"), (gk, "gk1"), (mg, "mg1"), (ad, "admin")):
            check(c.login(u)[0] == 200, f"login {u}")
        csv_text = (ROOT / "data" / "flights" / "S02_VTBD_21R_UNSTABLE.csv").read_text(encoding="utf-8")
        meta = dict(profile="A320", vapp_kt=140, registration="HS-TST", callsign="TST123", title="test S02", source_file="S02.csv")
        check(an.req("POST", "/api/flights", {"meta": meta, "csv": csv_text}, header=False)[0] == 403, "POST without X-FDAP header -> 403")
        code, r = an.req("POST", "/api/flights", {"meta": meta, "csv": csv_text})
        check(code == 200 and r.get("events") == 5, f"analyst upload -> {r}")
        key = r["key"]
        code, r = mg.req("POST", "/api/flights", {"meta": meta, "csv": csv_text})
        check(code == 403, "manager cannot upload")

        code, r = an.req("GET", "/api/flights")
        f = next(x for x in r["flights"] if x["key"] == key)
        check("registration" not in f and "date" not in f and "HS-TST" not in json.dumps(r), "analyst list is de-identified")
        code, txt = an.req("GET", f"/api/flights/{key}/csv")
        check(code == 200 and "2026-11-20T" not in txt and txt.startswith("time_s"), "analyst CSV has no absolute time")
        check(an.req("GET", f"/api/flights/{key}/identity")[0] == 403, "analyst cannot read identity")

        code, r = gk.req("GET", "/api/flights")
        f = next(x for x in r["flights"] if x["key"] == key)
        check(f.get("registration") == "HS-TST" and f.get("date") == "2026-11-20", "gatekeeper sees identity")
        code, txt = gk.req("GET", f"/api/flights/{key}/csv")
        check("2026-11-20T" in txt, "gatekeeper CSV keeps time")
        check(gk.req("GET", f"/api/flights/{key}/identity")[0] == 200, "gatekeeper identity endpoint")

        check(mg.req("GET", "/api/flights")[0] == 403, "manager cannot list flights")
        check(mg.req("GET", f"/api/flights/{key}/csv")[0] == 403, "manager cannot read flight data")
        code, r = mg.req("GET", "/api/fleet")
        ev = [e for f in r["flights"] for e in f["events"]]
        check(code == 200 and ev and all("detail" not in e and "history" not in e for e in ev) and "HS-TST" not in json.dumps(r),
              "manager fleet = aggregates without event detail or identity")

        code, r = an.req("GET", "/api/fleet")
        eid = next(e["id"] for f in r["flights"] for e in f["events"] if e["code"] == "UNSTABLE_500")
        code, r = an.req("POST", f"/api/events/{eid}/review", {"status": "VALID", "comment": "checked"})
        check(code == 200 and r["status"] == "VALID", "analyst validates event")
        check(an.req("POST", f"/api/events/{eid}/review", {"status": "CREW_DONE"})[0] == 403, "analyst cannot record crew contact")
        check(an.req("POST", f"/api/events/{eid}/review", {"status": "CREW_REQ"})[0] == 200, "analyst requests crew contact")
        code, r = gk.req("POST", f"/api/events/{eid}/review", {"status": "CREW_DONE", "comment": "debriefed"})
        check(code == 200 and len(r["history"]) == 3, "gatekeeper records crew contact (history 3)")
        check(mg.req("POST", f"/api/events/{eid}/review", {"status": "CLOSED"})[0] == 403, "manager cannot review")
        check(an.req("POST", f"/api/flights/{key}/flags", {"hold": True})[0] == 403, "analyst cannot set investigation hold")

        # second flight on hold, then retention with 0 days
        code, r = an.req("POST", "/api/flights", {"meta": dict(meta, registration="HS-HLD"), "csv": csv_text})
        key2 = r["key"]
        check(gk.req("POST", f"/api/flights/{key2}/flags", {"hold": True})[0] == 200, "gatekeeper sets hold")
        out = subprocess.run(SRV + ["purge", "--deid-days", "0"] + data, capture_output=True, text=True)
        check(key in out.stdout and key2 not in out.stdout, "purge de-identifies old flight, keeps the held one")
        code, r = gk.req("GET", "/api/flights")
        f1 = next(x for x in r["flights"] if x["key"] == key)
        f2 = next(x for x in r["flights"] if x["key"] == key2)
        check("registration" not in f1 and not f1["identified"] and f2.get("registration") == "HS-HLD", "after purge: identity gone even for gatekeeper; hold kept")
        code, txt = gk.req("GET", f"/api/flights/{key}/csv")
        check("2026-11-20T" not in txt, "after purge: stored CSV time stripped")
        raw = (Path(tmp) / "fdap.db").read_bytes()
        check(b"HS-TST" not in raw and b"HS-HLD" in raw, "after purge: old registration no longer present anywhere in the database file")

        code, r = an.req("GET", "/api/audit")
        check(code == 403, "analyst cannot read audit")
        code, r = ad.req("GET", "/api/audit")
        acts = {a["action"] for a in r["audit"]}
        check({"LOGIN_OK", "LOGIN_FAIL", "UPLOAD", "VIEW_IDENTITY", "REVIEW", "HOLD", "DEIDENTIFY", "VIEW_DATA"} <= acts, f"audit actions {sorted(acts)}")
        code, r = an.req("POST", "/api/logout", {})
        check(an.req("GET", "/api/me")[0] == 401, "logout ends session")
        for i in range(5):
            anon.req("POST", "/api/login", {"username": "gk1", "password": "bad-password-x"})
        check(anon.login("gk1")[0] == 401, "account locked after 5 failures")
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    print("ALL PASS" if not fails else f"{fails} FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
