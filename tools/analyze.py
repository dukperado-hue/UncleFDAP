"""Batch FDM analysis -> PDF report + CSV per flight, plus a fleet summary CSV.

    python tools/analyze.py                      # all flights in data/flights/index.json
    python tools/analyze.py path/to/flight.csv   # any CSV with the documented columns

Outputs go to reports/. Uses matplotlib only (no network access).
"""
from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402

from fdm_common import (DATA, ROOT, Frame, detect_events, flight_summary, load_airports,  # noqa: E402
                        load_config, read_flight_csv)

OUT = ROOT / "reports"
LEVEL = {1: "INFO", 2: "CAUTION", 3: "WARNING"}
LCOL = {1: "#1f9bb8", 2: "#e09a00", 3: "#d62828"}


def fmt_t(s):
    s = max(0, int(round(s)))
    return f"{s // 60}:{s % 60:02d}"


def nanfree(v):
    return None if v != v else v


def plot_track(ax, rows, airports, events):
    ap = min(airports.values(), key=lambda a: math.hypot(a["lat"] - rows[len(rows) // 2]["lat"],
                                                        a["lon"] - rows[len(rows) // 2]["lon"]))
    fr = Frame(ap["lat"], ap["lon"])
    xy = [fr.to_xy(r["lat"], r["lon"]) for r in rows]
    xs = [p[0] / 1852 for p in xy]
    ys = [p[1] / 1852 for p in xy]
    sc = ax.scatter(xs, ys, c=[r["alt_ft"] for r in rows], s=2, cmap="viridis")
    plt.colorbar(sc, ax=ax, label="altitude (ft)", shrink=0.8)
    for a in airports.values():
        f2 = Frame(ap["lat"], ap["lon"])
        for r in a["runways"].values():
            p = a["runways"].get(r["pair"])
            if not p:
                continue
            x1, y1 = f2.to_xy(r["lat"], r["lon"])
            x2, y2 = f2.to_xy(p["lat"], p["lon"])
            ax.plot([x1 / 1852, x2 / 1852], [y1 / 1852, y2 / 1852], color="k", lw=2.5)
        x, y = f2.to_xy(a["lat"], a["lon"])
        ax.annotate(a["icao"], (x / 1852, y / 1852), xytext=(6, 6), textcoords="offset points", fontsize=8, weight="bold")
    for e in events:
        i = next((k for k, r in enumerate(rows) if r["time_s"] >= e["t_peak"]), 0)
        ax.plot(xs[i], ys[i], "o", ms=7, mfc=LCOL[e["level"]], mec="k")
        ax.annotate(e["code"].replace("_", " "), (xs[i], ys[i]), xytext=(5, -10), textcoords="offset points",
                    fontsize=6.5, color=LCOL[e["level"]])
    ax.set_aspect("equal")
    ax.set_xlabel(f"east of {ap['icao']} ARP (NM)")
    ax.set_ylabel("north (NM)")
    ax.set_title("Ground track (colour = altitude)")
    ax.grid(alpha=0.3)


def shade(ax, events):
    for e in events:
        ax.axvspan(e["t_start"] - 1, e["t_end"] + 1, color=LCOL[e["level"]], alpha=0.18, lw=0)


def report(meta: dict, rows: list[dict], airports, cfg):
    events = detect_events(rows, cfg, airports, meta.get("vapp_kt"))
    summ = flight_summary(rows, airports)
    fid = meta["id"]
    OUT.mkdir(exist_ok=True)

    # events CSV (UTF-8 BOM so Excel shows Thai)
    with open(OUT / f"{fid}_events.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["flight_id", "code", "level", "level_name", "event", "event_th", "t_start_s", "t_end_s",
                    "t_peak_s", "value", "unit", "detail"])
        for e in events:
            w.writerow([fid, e["code"], e["level"], LEVEL[e["level"]], e["name"], e["th"], e["t_start"], e["t_end"],
                        e["t_peak"], e["value"], e["unit"], e["detail"]])

    t = [r["time_s"] for r in rows]
    with PdfPages(OUT / f"{fid}_report.pdf") as pdf:
        # page 1: summary + events + track
        fig = plt.figure(figsize=(8.27, 11.69))
        fig.text(0.06, 0.965, "FDM REPLAY - FLIGHT DATA REPORT", fontsize=14, weight="bold", color="#b37400")
        fig.text(0.06, 0.948, "SYNTHETIC / DEMONSTRATION DATA - NOT FOR OPERATIONAL USE", fontsize=8, color="#d62828")
        fig.text(0.06, 0.925, meta.get("title", fid), fontsize=12, weight="bold")
        lines = [
            f"Flight ID: {fid}    Aircraft: {meta.get('aircraft', '-')} {meta.get('registration', '')}    Callsign: {meta.get('callsign', '-')}",
            f"Date (UTC): {rows[0].get('utc', '')[:10]}    Duration: {fmt_t(summ['duration_s'])}    Records: {len(rows)}",
            "Take-off: " + ("; ".join(f"{x['rwy']} @{fmt_t(x['t'])} IAS {x['ias_kt']}" for x in summ["takeoffs"]) or "-"),
            "Landing: " + ("; ".join(f"{x['rwy']} @{fmt_t(x['t'])}  TD {x['along_m']} m past THR  IAS {x['ias_kt']}"
                                       for x in summ["landings"]) or "-"),
            f"Max: ALT {summ['max_alt_ft']:.0f} ft   IAS {summ['max_ias_kt']:.0f} kt   Nz {summ['max_nz_g']:.2f} g",
        ]
        for k, s in enumerate(lines):
            fig.text(0.06, 0.902 - k * 0.016, s, fontsize=8.5, family="monospace")
        ax = fig.add_axes([0.06, 0.50, 0.88, 0.30])
        ax.axis("off")
        ax.set_title(f"Events detected: {len(events)}", loc="left", fontsize=11, weight="bold")
        if events:
            cells = [[i + 1, LEVEL[e["level"]], e["name"][:42], fmt_t(e["t_peak"]),
                      "" if e["value"] is None else f"{e['value']} {e['unit']}"[:18], e["detail"][:58]]
                     for i, e in enumerate(events[:22])]
            tb = ax.table(cellText=cells, colLabels=["#", "Level", "Event", "Time", "Value", "Detail"], loc="upper left",
                          colWidths=[0.04, 0.10, 0.30, 0.07, 0.14, 0.40], cellLoc="left")
            tb.auto_set_font_size(False)
            tb.set_fontsize(6.6)
            tb.scale(1, 1.25)
            for (r_, c_), cell in tb.get_celld().items():
                cell.set_linewidth(0.3)
                if r_ == 0:
                    cell.set_facecolor("#28303a")
                    cell.get_text().set_color("white")
                elif c_ == 1:
                    cell.get_text().set_color(LCOL[events[r_ - 1]["level"]])
                    cell.get_text().set_weight("bold")
        else:
            ax.text(0, 0.9, "No events detected.", fontsize=10, color="green")
        plot_track(fig.add_axes([0.08, 0.05, 0.84, 0.40]), rows, airports, events)
        pdf.savefig(fig)
        plt.close(fig)

        # page 2+: parameter charts
        panels = [
            ("Altitude / RA (ft)", [("alt_ft", "ALT"), ("ra_ft", "RA")]),
            ("Speed (kt)", [("ias_kt", "IAS"), ("gs_kt", "GS")]),
            ("Vertical speed (fpm)", [("vs_fpm", "V/S")]),
            ("Pitch / Roll (deg)", [("pitch_deg", "pitch"), ("roll_deg", "roll")]),
            ("Nz (g)", [("nz_g", "Nz")]),
            ("N1 (%)", [("n1_1", "ENG1"), ("n1_2", "ENG2")]),
            ("ILS deviation (dot)", [("loc_dev_dot", "LOC"), ("gs_dev_dot", "G/S")]),
            ("Flap / Gear / GPWS", [("flap", "flap"), ("gear", "gear"), ("gpws_warn", "GPWS")]),
        ]
        for page in (panels[:4], panels[4:]):
            fig, axs = plt.subplots(len(page), 1, figsize=(8.27, 11.69), sharex=True)
            fig.suptitle(f"{fid} - parameters vs time (shaded = events)", fontsize=10)
            for ax, (title, ser) in zip(axs, page):
                for k, lab in ser:
                    if k in rows[0]:
                        ax.plot(t, [nanfree(r.get(k, math.nan)) for r in rows], lw=0.9, label=lab,
                                drawstyle="steps-post" if k in ("flap", "gear", "gpws_warn") else "default")
                if title.startswith("Speed"):
                    vfe = {int(k): v for k, v in cfg["vfe_kt"].items()}
                    ax.plot(t, [vfe.get(int(r["flap"])) if r["flap"] == r["flap"] else None for r in rows],
                            "r--", lw=0.8, label="VFE")
                shade(ax, events)
                ax.set_title(title, fontsize=9, loc="left")
                ax.grid(alpha=0.3)
                ax.legend(fontsize=7, loc="upper right")
            axs[-1].set_xlabel("time (s)")
            fig.tight_layout(rect=(0, 0, 1, 0.97))
            pdf.savefig(fig)
            plt.close(fig)
    return events, summ


def main(argv):
    airports, cfg = load_airports(), load_config()
    if argv:
        flights = [dict(id=Path(p).stem, title=Path(p).name, path=Path(p)) for p in argv]
    else:
        idx = json.loads((DATA / "flights" / "index.json").read_text(encoding="utf-8"))
        flights = [dict(f, path=DATA / "flights" / f["file"]) for f in idx["flights"]]
    allrows = []
    for f in flights:
        rows = read_flight_csv(f["path"])
        events, summ = report(f, rows, airports, cfg)
        lv = [e["level"] for e in events]
        allrows.append([f["id"], f.get("airport", ""), f.get("runway", ""), len(events), lv.count(3), lv.count(2), lv.count(1),
                        " ".join(sorted({e["code"] for e in events}))])
        print(f"{f['id']:40s} events={len(events):2d}  -> reports/{f['id']}_report.pdf")
    with open(OUT / "summary_events.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["flight_id", "airport", "runway", "n_events", "n_warning", "n_caution", "n_info", "codes"])
        w.writerows(allrows)


if __name__ == "__main__":
    main(sys.argv[1:])
