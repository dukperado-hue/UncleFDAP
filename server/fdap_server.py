"""FDAP self-hosted server: login, roles, de-identification, shared review state, audit log.

Standard library only (no pip install). Serves the same web pages as GitHub Pages; the pages
switch to "server mode" when GET api/me answers.

    python server/fdap_server.py init                     # create data dir + admin (prints password once)
    python server/fdap_server.py adduser somchai analyst  # roles: admin gatekeeper analyst manager
    python server/fdap_server.py serve                    # http://127.0.0.1:8780
    python server/fdap_server.py seed-demo                # load the bundled SYNTHETIC flights
    python server/fdap_server.py purge                    # run the de-identification job now

Roles (ICAO Doc 10000 §3.1.9):
    gatekeeper  identified data (registration, call sign, date/time) for confidential crew contact
    analyst     de-identified flight data, replay, upload, event review
    manager     aggregated statistics only
    admin       users + audit log (+ everything)
Identified data are de-identified irreversibly after --deid-days (default 30) unless the flight
is on investigation hold (Annex 13). Keep this server on a trusted network; for anything beyond
localhost put it behind HTTPS (--cert/--key or a reverse proxy).
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import ssl
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from fdm_common import detect_events, load_airports, load_config, measurements  # noqa: E402

ROLES = ("admin", "gatekeeper", "analyst", "manager")
CAN = {
    "admin": {"replay", "upload", "review", "identity", "hold", "admin", "stats", "events"},
    "gatekeeper": {"replay", "upload", "review", "identity", "hold", "stats", "events"},
    "analyst": {"replay", "upload", "review", "stats", "events"},
    "manager": {"stats"},
}
STATUSES = ("NEW", "VALID", "NUISANCE", "CREW_REQ", "CREW_DONE", "CLOSED")
STATIC_OK = re.compile(r"^(index\.html|fleet\.html|login\.html|admin\.html|css/[\w.-]+\.css|js/[\w.-]+\.js|"
                       r"data/(airports|events-config|import-templates)\.json|data/samples/[\w.-]+|data/flights/[\w.-]+)$")
SESSION_H = 8
MAX_BODY = 40 * 1024 * 1024
PBKDF2_ITERS = 310_000
IDENT_FIELDS = ("registration", "callsign", "flight_no", "date_utc", "time_utc", "source_file", "title", "title_th")

AIRPORTS = load_airports()


def now():
    return datetime.now(timezone.utc)


def iso(dt=None):
    return (dt or now()).strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------ storage
class Store:
    def __init__(self, data_dir: Path, deid_days: int = 30):
        self.dir = Path(data_dir)
        self.db_path = self.dir / "fdap.db"
        self.files = self.dir / "flights"
        self.deid_days = deid_days

    def db(self):
        c = sqlite3.connect(self.db_path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA secure_delete=ON")      # overwrite removed identity values instead of leaving them in free pages
        return c

    def init(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        self.files.mkdir(exist_ok=True)
        with self.db() as c:
            c.executescript("""
            CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
              pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, iters INTEGER NOT NULL, created TEXT, disabled INTEGER DEFAULT 0,
              failed INTEGER DEFAULT 0, locked_until REAL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
              created REAL, expires REAL, ip TEXT);
            CREATE TABLE IF NOT EXISTS flights(key TEXT PRIMARY KEY, uploaded_at TEXT, uploaded_by TEXT, profile TEXT, aircraft TEXT,
              registration TEXT, callsign TEXT, flight_no TEXT, date_utc TEXT, time_utc TEXT, month TEXT, dep TEXT, arr TEXT,
              vapp REAL, title TEXT, title_th TEXT, source_file TEXT, template TEXT, qc_json TEXT, qc_score REAL, measures_json TEXT,
              flight_type TEXT DEFAULT 'revenue', identified INTEGER DEFAULT 1, hold INTEGER DEFAULT 0, excluded TEXT,
              deidentified_at TEXT, csv_file TEXT, replay TEXT);
            CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, flight_key TEXT REFERENCES flights(key) ON DELETE CASCADE,
              code TEXT, level INTEGER, name TEXT, th TEXT, t_peak REAL, value REAL, unit TEXT, detail TEXT,
              status TEXT DEFAULT 'NEW', updated TEXT);
            CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
              at TEXT, username TEXT, status TEXT, comment TEXT);
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT, username TEXT, action TEXT, target TEXT, detail TEXT, ip TEXT);
            CREATE INDEX IF NOT EXISTS ev_flight ON events(flight_key);
            """)

    # -------------------------------------------------------- users
    @staticmethod
    def hash_pw(pw: str, salt: bytes, iters: int) -> str:
        return base64.b64encode(hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, iters)).decode()

    def add_user(self, username, role, password=None):
        if role not in ROLES:
            raise ValueError(f"role must be one of {ROLES}")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{3,40}", username):
            raise ValueError("username: 3-40 letters, digits, . _ -")
        password = password or secrets.token_urlsafe(12)
        if len(password) < 10:
            raise ValueError("password must be at least 10 characters")
        salt = secrets.token_bytes(16)
        with self.db() as c:
            c.execute("INSERT INTO users(username, role, pw_hash, pw_salt, iters, created) VALUES(?,?,?,?,?,?)",
                      (username, role, self.hash_pw(password, salt, PBKDF2_ITERS), base64.b64encode(salt).decode(), PBKDF2_ITERS, iso()))
        return password

    def set_password(self, username, password=None):
        password = password or secrets.token_urlsafe(12)
        salt = secrets.token_bytes(16)
        with self.db() as c:
            n = c.execute("UPDATE users SET pw_hash=?, pw_salt=?, iters=?, failed=0, locked_until=0 WHERE username=?",
                          (self.hash_pw(password, salt, PBKDF2_ITERS), base64.b64encode(salt).decode(), PBKDF2_ITERS, username)).rowcount
            c.execute("DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=?)", (username,))
        if not n:
            raise ValueError("no such user")
        return password

    def check_login(self, username, password):
        with self.db() as c:
            u = c.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
            if not u or u["disabled"]:
                self.hash_pw(password, b"x" * 16, PBKDF2_ITERS)   # same cost for unknown users
                return None, "invalid username or password"
            if u["locked_until"] > time.time():
                return None, "too many failed attempts - try again in a few minutes"
            ok = hmac.compare_digest(self.hash_pw(password, base64.b64decode(u["pw_salt"]), u["iters"]), u["pw_hash"])
            if not ok:
                failed = u["failed"] + 1
                c.execute("UPDATE users SET failed=?, locked_until=? WHERE id=?",
                          (failed, time.time() + 300 if failed >= 5 else 0, u["id"]))
                return None, "invalid username or password"
            c.execute("UPDATE users SET failed=0, locked_until=0 WHERE id=?", (u["id"],))
            return u, None

    def new_session(self, user_id, ip):
        tok = secrets.token_urlsafe(32)
        with self.db() as c:
            c.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
            c.execute("INSERT INTO sessions VALUES(?,?,?,?,?)", (hashlib.sha256(tok.encode()).hexdigest(), user_id, time.time(),
                                                                 time.time() + SESSION_H * 3600, ip))
        return tok

    def session_user(self, tok):
        if not tok:
            return None
        with self.db() as c:
            return c.execute("""SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                                WHERE s.token_hash=? AND s.expires>? AND u.disabled=0""",
                             (hashlib.sha256(tok.encode()).hexdigest(), time.time())).fetchone()

    def end_session(self, tok):
        with self.db() as c:
            c.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(tok.encode()).hexdigest(),))

    def audit(self, user, action, target="", detail="", ip=""):
        with self.db() as c:
            c.execute("INSERT INTO audit(at, username, action, target, detail, ip) VALUES(?,?,?,?,?,?)",
                      (iso(), user, action, target, detail[:500], ip))

    # -------------------------------------------------------- flights
    def add_flight(self, meta: dict, csv_text: str, qc: dict | None, user: str, mapping: dict | None = None):
        rows = parse_rows(csv_text)
        if len(rows) < 10:
            raise ValueError("flight has fewer than 10 rows")
        for k in ("time_s", "lat", "lon", "alt_ft", "ias_kt", "pitch_deg", "roll_deg", "hdg_true_deg"):
            if k not in rows[0]:
                raise ValueError(f"normalised CSV lacks column {k}")
        profile = meta.get("profile") or None
        cfg = load_config(profile)
        vapp = float(meta.get("vapp_kt") or cfg["vapp_default_kt"])
        events = detect_events(rows, cfg, AIRPORTS, vapp)
        meas = measurements(rows, cfg, AIRPORTS, vapp)
        utc = next((r.get("utc") for r in rows if r.get("utc")), "") or ""
        date = meta.get("date") or (utc[:10] if re.match(r"\d{4}-\d\d-\d\d", utc) else iso()[:10])
        tm = meta.get("time_utc") or (utc[11:16] if len(utc) >= 16 else "")
        key = "F" + secrets.token_hex(4).upper()          # random pseudonym, not derived from identity
        dep = arr = None
        if meas["takeoffs"] and meas["takeoffs"][0]["rwy"]:
            dep = meas["takeoffs"][0]["rwy"].split()[0]
        if meas["landings"] and meas["landings"][-1]["rwy"]:
            arr = meas["landings"][-1]["rwy"].split()[0]
        fname = key + ".csv"
        (self.files / fname).write_text(csv_text, encoding="utf-8", newline="\n")
        with self.db() as c:
            c.execute("""INSERT INTO flights(key, uploaded_at, uploaded_by, profile, aircraft, registration, callsign, flight_no,
                         date_utc, time_utc, month, dep, arr, vapp, title, title_th, source_file, template, qc_json, qc_score,
                         measures_json, flight_type, csv_file, replay) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                      (key, iso(), user, cfg["profile"], meta.get("aircraft") or "", meta.get("registration") or None,
                       meta.get("callsign") or None, meta.get("flight_no") or None, date, tm, date[:7], meta.get("dep") or dep,
                       meta.get("arr") or arr, vapp, meta.get("title") or None, meta.get("title_th") or None,
                       meta.get("source_file") or None, (mapping or {}).get("template") or meta.get("template"),
                       json.dumps(qc) if qc else None, (qc or {}).get("score"), json.dumps(meas),
                       meta.get("flight_type") or "revenue", fname, meta.get("replay")))
            for e in events:
                c.execute("INSERT INTO events(id, flight_key, code, level, name, th, t_peak, value, unit, detail, updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                          (f"{key}:{e['code']}:{e['t_peak']}", key, e["code"], e["level"], e["name"], e["th"], e["t_peak"],
                           e["value"], e["unit"], e["detail"], iso()))
        return key, events

    def flight_public(self, f: sqlite3.Row, role: str) -> dict:
        d = dict(f)
        out = dict(key=d["key"], profile=d["profile"], aircraft=d["aircraft"], month=d["month"], dep=d["dep"], arr=d["arr"],
                   vapp_kt=d["vapp"], qc=json.loads(d["qc_json"]) if d["qc_json"] else None, qc_score=d["qc_score"],
                   flight_type=d["flight_type"], excluded=d["excluded"], identified=bool(d["identified"]), hold=bool(d["hold"]),
                   template=d["template"], replay=d["replay"])
        if "identity" in CAN[role] and d["identified"]:
            out.update(registration=d["registration"], callsign=d["callsign"], flight_no=d["flight_no"], date=d["date_utc"],
                       time_utc=d["time_utc"], source_file=d["source_file"], title=d["title"], title_th=d["title_th"])
        else:
            out.update(title=f"{d['profile']} flight {d['key']}", title_th=f"{d['month']} · {d['arr'] or ''}")
        return out

    def purge(self, days=None, who="system"):
        """Irreversible de-identification of flights older than `days` (not on hold)."""
        days = self.deid_days if days is None else days
        cutoff = iso(now() - timedelta(days=days))
        done = []
        with self.db() as c:
            for f in c.execute("SELECT key, csv_file FROM flights WHERE identified=1 AND hold=0 AND uploaded_at<=?", (cutoff,)).fetchall():
                strip_csv_identity(self.files / f["csv_file"])
                c.execute(f"UPDATE flights SET {', '.join(k + '=NULL' for k in IDENT_FIELDS)}, identified=0, deidentified_at=? WHERE key=?",
                          (iso(), f["key"]))
                done.append(f["key"])
        for k in done:
            self.audit(who, "DEIDENTIFY", k, f"retention {days} d")
        return done


def parse_rows(text: str):
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        o = {}
        for k, v in r.items():
            if k is None:
                continue
            k = k.strip()
            if k in ("utc", "phase"):
                o[k] = v or ""
            else:
                try:
                    o[k] = float(v) if v not in ("", None) else float("nan")
                except ValueError:
                    o[k] = float("nan")
        rows.append(o)
    return rows


def strip_csv_identity(path: Path):
    """Blank the absolute time column so the stored series no longer carries the date/time."""
    if not path.exists():
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    head = lines[0].split(",")
    if "utc" not in head:
        return
    i = head.index("utc")
    out = [lines[0]]
    for ln in lines[1:]:
        v = ln.split(",")
        if len(v) > i:
            v[i] = ""
        out.append(",".join(v))
    path.write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")


def csv_without_utc(path: Path) -> str:
    lines = path.read_text(encoding="utf-8").splitlines()
    head = lines[0].split(",")
    if "utc" not in head:
        return "\n".join(lines) + "\n"
    i = head.index("utc")
    out = [lines[0]] + [",".join(("" if k == i else x) for k, x in enumerate(ln.split(","))) for ln in lines[1:]]
    return "\n".join(out) + "\n"


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "FDAP"
    sys_version = ""
    store: Store = None
    secure = False

    def log_message(self, fmt, *args):     # keep the console quiet but useful
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # -------------------------------------------------- helpers
    def send(self, code, body=b"", ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False, allow_nan=False, default=str).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")   # OSM tiles need a referer
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        if ctype.startswith("application/json") or ctype.startswith("text/csv"):
            self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def err(self, code, msg):
        self.send(code, {"error": msg})

    def token(self):
        c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        return c["fdap_session"].value if "fdap_session" in c else None

    def user(self):
        return self.store.session_user(self.token())

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("request too large")
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw or b"{}")

    @property
    def ip(self):
        return self.client_address[0]

    # -------------------------------------------------- routing
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self.api("GET", path[5:])
        return self.static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self.err(405, "method not allowed")
        if self.headers.get("X-FDAP") != "1":          # custom header: blocks cross-site form posts (CSRF)
            return self.err(403, "missing X-FDAP header")
        return self.api("POST", path[5:])

    def static(self, path):
        rel = unquote(path).lstrip("/") or "index.html"
        if not STATIC_OK.match(rel) or ".." in rel:
            return self.err(404, "not found")
        p = (ROOT / rel).resolve()
        if ROOT not in p.parents or not p.is_file():
            return self.err(404, "not found")
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self.send(200, p.read_bytes(), ctype, {"Cache-Control": "no-cache"})

    def api(self, method, route):
        try:
            if route == "login" and method == "POST":
                return self.login()
            u = self.user()
            if not u:
                return self.err(401, "login required")
            role = u["role"]
            can = CAN[role]
            parts = route.strip("/").split("/")
            if route == "me":
                return self.send(200, dict(username=u["username"], role=role, deid_days=self.store.deid_days, can=sorted(can)))
            if route == "logout" and method == "POST":
                self.store.end_session(self.token())
                self.store.audit(u["username"], "LOGOUT", ip=self.ip)
                return self.send(200, {"ok": True}, headers={"Set-Cookie": self.cookie("", 0)})
            if parts[0] == "flights":
                return self.flights(method, parts[1:], u, role, can)
            if route == "fleet" and method == "GET" and "stats" in can:
                return self.fleet(role, can)
            if parts[0] == "events" and len(parts) == 3 and parts[2] == "review" and method == "POST" and "review" in can:
                return self.review(unquote(parts[1]), u, can)
            if route.startswith("audit") and "admin" in can:
                lim = int((parse_qs(urlparse(self.path).query).get("limit") or [500])[0])
                with self.store.db() as c:
                    rows = [dict(r) for r in c.execute("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (min(lim, 5000),))]
                return self.send(200, {"audit": rows})
            if route == "users" and "admin" in can:
                if method == "GET":
                    with self.store.db() as c:
                        rows = [dict(username=r["username"], role=r["role"], created=r["created"], disabled=bool(r["disabled"]))
                                for r in c.execute("SELECT * FROM users ORDER BY username")]
                    return self.send(200, {"users": rows})
                b = self.body()
                if b.get("action") == "reset":
                    pw = self.store.set_password(b["username"])
                    self.store.audit(u["username"], "USER_RESET", b["username"], ip=self.ip)
                else:
                    pw = self.store.add_user(b.get("username", ""), b.get("role", ""))
                    self.store.audit(u["username"], "USER_ADD", b.get("username", ""), b.get("role", ""), self.ip)
                return self.send(200, {"username": b["username"], "password": pw})
            return self.err(403 if route in ("fleet", "audit", "users") or parts[0] == "events" else 404, "not allowed")
        except (ValueError, KeyError, json.JSONDecodeError, sqlite3.IntegrityError) as e:
            return self.err(400, str(e))
        except Exception as e:      # never drop the connection silently
            print(f"internal error on {method} {route}: {e!r}", file=sys.stderr)
            return self.err(500, "internal error")

    def cookie(self, val, max_age):
        return (f"fdap_session={val}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}" + ("; Secure" if self.secure else ""))

    def login(self):
        b = self.body()
        u, why = self.store.check_login(str(b.get("username", "")), str(b.get("password", "")))
        if not u:
            self.store.audit(str(b.get("username", ""))[:40], "LOGIN_FAIL", ip=self.ip)
            return self.err(401, why)
        tok = self.store.new_session(u["id"], self.ip)
        self.store.audit(u["username"], "LOGIN_OK", ip=self.ip)
        return self.send(200, dict(username=u["username"], role=u["role"]), headers={"Set-Cookie": self.cookie(tok, SESSION_H * 3600)})

    def flights(self, method, parts, u, role, can):
        st = self.store
        if not parts:
            if method == "GET":
                if "replay" not in can:
                    return self.err(403, "not allowed")
                with st.db() as c:
                    fl = c.execute("SELECT * FROM flights ORDER BY month DESC, uploaded_at DESC").fetchall()
                    n = dict(c.execute("SELECT flight_key, COUNT(*) FROM events GROUP BY flight_key").fetchall())
                out = []
                for f in fl:
                    d = st.flight_public(f, role)
                    d["n_events"] = n.get(f["key"], 0)
                    out.append(d)
                return self.send(200, {"flights": out})
            if method == "POST" and "upload" in can:
                b = self.body()
                key, events = st.add_flight(b.get("meta") or {}, b.get("csv") or "", b.get("qc"), u["username"], b.get("mapping"))
                st.audit(u["username"], "UPLOAD", key, f"{len(events)} events", self.ip)
                return self.send(200, {"key": key, "events": len(events)})
            return self.err(403, "not allowed")
        key = unquote(parts[0])
        with st.db() as c:
            f = c.execute("SELECT * FROM flights WHERE key=?", (key,)).fetchone()
        if not f:
            return self.err(404, "no such flight")
        sub = parts[1] if len(parts) > 1 else ""
        if sub == "csv" and method == "GET" and "replay" in can:
            p = st.files / f["csv_file"]
            ident = "identity" in can and f["identified"]
            st.audit(u["username"], "VIEW_DATA", key, "identified" if ident else "de-identified", self.ip)
            return self.send(200, p.read_text(encoding="utf-8") if ident else csv_without_utc(p), "text/csv; charset=utf-8")
        if sub == "identity" and method == "GET" and "identity" in can:
            st.audit(u["username"], "VIEW_IDENTITY", key, ip=self.ip)
            return self.send(200, {k: f[k] for k in IDENT_FIELDS} | {"identified": bool(f["identified"])})
        if sub == "flags" and method == "POST" and "review" in can:
            b = self.body()
            if "hold" in b and "hold" not in can:
                return self.err(403, "only the gatekeeper can set an investigation hold")
            logs = []
            with st.db() as c:
                if "excluded" in b:
                    c.execute("UPDATE flights SET excluded=? WHERE key=?", ((str(b["excluded"])[:60] or None) if b["excluded"] else None, key))
                    logs.append(("FLAG", f"excluded={b['excluded']}"))
                if "hold" in b:
                    c.execute("UPDATE flights SET hold=? WHERE key=?", (1 if b["hold"] else 0, key))
                    logs.append(("HOLD", f"hold={bool(b['hold'])}"))
                f = c.execute("SELECT excluded, hold FROM flights WHERE key=?", (key,)).fetchone()
            for act, det in logs:          # audit uses its own connection: write after the transaction above is committed
                st.audit(u["username"], act, key, det, self.ip)
            return self.send(200, {"excluded": f["excluded"], "hold": bool(f["hold"])})
        return self.err(403, "not allowed")

    def fleet(self, role, can):
        st = self.store
        with st.db() as c:
            fl = c.execute("SELECT * FROM flights").fetchall()
            evs = c.execute("SELECT * FROM events").fetchall()
            hist = c.execute("SELECT * FROM reviews ORDER BY id").fetchall()
        hby = {}
        for h in hist:
            hby.setdefault(h["event_id"], []).append(dict(at=h["at"], by=h["username"] if "events" in can else "", status=h["status"],
                                                           comment=h["comment"] if "events" in can else ""))
        eby = {}
        for e in evs:
            d = dict(id=e["id"], code=e["code"], level=e["level"], name=e["name"], th=e["th"], status=e["status"], t_peak=e["t_peak"])
            if "events" in can:
                d.update(value=e["value"], unit=e["unit"], detail=e["detail"], history=hby.get(e["id"], []))
            eby.setdefault(e["flight_key"], []).append(d)
        flights = []
        for f in fl:
            d = st.flight_public(f, role)
            d["fleet"] = f"{f['profile']} ({f['aircraft'] or 'aircraft'})" if f["profile"] else "Fleet"
            d["fleet"] = {"A320": "Airline (A320)", "C172": "Flight school (C172)"}.get(f["profile"], d["fleet"])
            d["measures"] = json.loads(f["measures_json"])
            d["events"] = eby.get(f["key"], [])
            flights.append(d)
        months = sorted({f["month"] for f in flights if f["month"]})
        if months:
            y, m = map(int, months[-1].split("-"))
            months = [f"{y - (m - k <= 0) :04d}-{(m - k - 1) % 12 + 1:02d}" for k in range(11, -1, -1)]
        return self.send(200, dict(months=months, annotations=[], operated=[], flights=flights))

    def review(self, eid, u, can):
        b = self.body()
        status = b.get("status")
        if status not in STATUSES:
            return self.err(400, "bad status")
        if status == "CREW_DONE" and "identity" not in can:
            return self.err(403, "only the gatekeeper records crew contact")
        comment = str(b.get("comment") or "")[:1000]
        with self.store.db() as c:
            if not c.execute("SELECT 1 FROM events WHERE id=?", (eid,)).fetchone():
                return self.err(404, "no such event")
            c.execute("UPDATE events SET status=?, updated=? WHERE id=?", (status, iso(), eid))
            c.execute("INSERT INTO reviews(event_id, at, username, status, comment) VALUES(?,?,?,?,?)", (eid, iso(), u["username"], status, comment))
            hist = [dict(at=r["at"], by=r["username"], status=r["status"], comment=r["comment"])
                    for r in c.execute("SELECT * FROM reviews WHERE event_id=? ORDER BY id", (eid,))]
        self.store.audit(u["username"], "REVIEW", eid, status, self.ip)
        return self.send(200, {"status": status, "history": hist})


# ------------------------------------------------------------------ CLI
def seed_demo(store: Store):
    """Load the bundled SYNTHETIC flights (scenarios + normalised samples) as if uploaded."""
    n = 0
    for idx_path, prof in ((ROOT / "data" / "flights" / "index.json", "A320"), (ROOT / "data" / "samples" / "index.json", None)):
        for s in json.loads(idx_path.read_text(encoding="utf-8"))["flights"]:
            p = idx_path.parent / (s.get("normalized_file") or s["file"])
            qc = None
            if s.get("qc_file") and (idx_path.parent / s["qc_file"]).exists():
                qc = json.loads((idx_path.parent / s["qc_file"]).read_text(encoding="utf-8"))
            meta = dict(profile=s.get("profile") or prof, vapp_kt=s["vapp_kt"], aircraft=s["aircraft"], registration=s["registration"],
                        callsign=s["callsign"], title=s["title"], title_th=s["title_th"], source_file=s["file"], replay=None,
                        flight_type="revenue" if (s.get("profile") or prof) == "A320" else "instruction")
            key, ev = store.add_flight(meta, p.read_text(encoding="utf-8"), qc, "seed-demo")
            store.audit("seed-demo", "UPLOAD", key, f"{len(ev)} events; SYNTHETIC {s['id']}")
            n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["init", "adduser", "passwd", "serve", "seed-demo", "purge"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--data", default=str(ROOT / "server" / "var"), help="data directory (default server/var, git-ignored)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8780)
    ap.add_argument("--deid-days", type=int, default=30, help="de-identify flights this many days after upload")
    ap.add_argument("--cert", help="TLS certificate (PEM) to serve HTTPS")
    ap.add_argument("--key", help="TLS private key (PEM)")
    ap.add_argument("--password", help=argparse.SUPPRESS)          # for automated tests only
    a = ap.parse_args()
    st = Store(Path(a.data), a.deid_days)
    if a.cmd == "init":
        st.init()
        with st.db() as c:
            has_admin = c.execute("SELECT 1 FROM users WHERE role='admin'").fetchone()
        if has_admin:
            print("already initialised:", st.db_path)
            return
        pw = st.add_user("admin", "admin", a.password)
        print(f"initialised {st.db_path}\nadmin password (shown once): {pw}")
        return
    if not st.db_path.exists():
        sys.exit("run `python server/fdap_server.py init` first")
    st.init()
    if a.cmd == "adduser":
        if len(a.args) != 2:
            sys.exit("usage: adduser <username> <role>")
        pw = st.add_user(a.args[0], a.args[1], a.password)
        print(f"user {a.args[0]} ({a.args[1]}) password (shown once): {pw}")
    elif a.cmd == "passwd":
        print("new password (shown once):", st.set_password(a.args[0], a.password))
    elif a.cmd == "seed-demo":
        print(seed_demo(st), "synthetic flights loaded")
    elif a.cmd == "purge":
        print("de-identified:", st.purge())
    elif a.cmd == "serve":
        Handler.store = st
        httpd = ThreadingHTTPServer((a.host, a.port), Handler)
        if a.cert:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(a.cert, a.key)
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
            Handler.secure = True
        elif a.host not in ("127.0.0.1", "localhost", "::1"):
            print("WARNING: serving plain HTTP beyond localhost - passwords and flight data travel unencrypted. Use --cert/--key or an HTTPS reverse proxy.")

        def retention():
            while True:
                try:
                    done = st.purge()
                    if done:
                        print("de-identified", len(done), "flight(s)")
                except Exception as e:      # keep the job alive
                    print("retention job error:", e)
                time.sleep(3600)
        threading.Thread(target=retention, daemon=True).start()
        print(f"FDAP server on {'https' if a.cert else 'http'}://{a.host}:{a.port}  (data: {st.dir}, de-identify after {a.deid_days} d)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
