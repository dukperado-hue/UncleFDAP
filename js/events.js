// FDM event detection - mirrors tools/fdm_common.py (keep the two in sync).
// Thresholds come from data/events-config.json.
(function (global) {
  'use strict';
  const R_EARTH = 6371008.8;
  const D2R = Math.PI / 180;

  function dmsToDeg(s) {
    const m = /^(\d+)(\d\d)(\d\d(?:\.\d+)?)([NSEW])$/.exec(s.trim());
    if (!m) throw new Error('bad DMS ' + s);
    const v = +m[1] + +m[2] / 60 + +m[3] / 3600;
    return 'SW'.includes(m[4]) ? -v : v;
  }
  function parseLatLon(s) { const [a, b] = s.split(/\s+/); return [dmsToDeg(a), dmsToDeg(b)]; }

  function prepareAirports(raw) {
    const out = {};
    for (const [icao, ap0] of Object.entries(raw.airports)) {
      const [lat, lon] = parseLatLon(ap0.arp);
      const ap = Object.assign({}, ap0, { icao, lat, lon, runways: {} });
      for (const r of ap0.runways) {
        const [tlat, tlon] = parseLatLon(r.thr);
        ap.runways[r.id] = Object.assign({}, r, { lat: tlat, lon: tlon, icao });
      }
      out[icao] = ap;
    }
    // runway end = threshold of the reciprocal runway
    for (const ap of Object.values(out)) for (const r of Object.values(ap.runways)) {
      const p = ap.runways[r.pair]; if (p) { r.endLat = p.lat; r.endLon = p.lon; }
    }
    return out;
  }

  class Frame {
    constructor(lat0, lon0) { this.lat0 = lat0; this.lon0 = lon0; this.k = Math.cos(lat0 * D2R); }
    toXY(lat, lon) { return [(lon - this.lon0) * D2R * R_EARTH * this.k, (lat - this.lat0) * D2R * R_EARTH]; }
    toLL(x, y) { return [this.lat0 + y / R_EARTH / D2R, this.lon0 + x / (R_EARTH * this.k) / D2R]; }
  }
  function rwyCoords(fr, r, x, y) {
    const [tx, ty] = fr.toXY(r.lat, r.lon); const c = r.true_brg * D2R;
    const dx = x - tx, dy = y - ty;
    return [dx * Math.sin(c) + dy * Math.cos(c), dx * Math.cos(c) - dy * Math.sin(c)];
  }
  const angdiff = (a, b) => ((a - b + 540) % 360) - 180;

  function findRunway(airports, lat, lon, hdg) {
    let best = null;
    for (const ap of Object.values(airports)) {
      const fr = new Frame(ap.lat, ap.lon); const [x, y] = fr.toXY(lat, lon);
      for (const r of Object.values(ap.runways)) {
        if (Math.abs(angdiff(hdg, r.true_brg)) > 25) continue;
        const [a, c] = rwyCoords(fr, r, x, y);
        if (Math.abs(c) < 150 && a > -8000 && a < r.length_m + 500)
          if (!best || Math.abs(c) < best[2]) best = [r, a, Math.abs(c)];
      }
    }
    return best ? { rwy: best[0], along: best[1] } : { rwy: null, along: null };
  }

  const isNum = v => typeof v === 'number' && !Number.isNaN(v);
  const g = (r, k) => (isNum(r[k]) ? r[k] : NaN);

  function segments(rows, pred) {
    const out = []; let i0 = null;
    for (let i = 0; i < rows.length; i++) {
      if (pred(rows[i])) { if (i0 === null) i0 = i; }
      else if (i0 !== null) { out.push([i0, i - 1]); i0 = null; }
    }
    if (i0 !== null) out.push([i0, rows.length - 1]);
    return out;
  }
  const argBy = (i0, i1, f) => { let b = i0; for (let i = i0; i <= i1; i++) if (f(i) > f(b)) b = i; return b; };

  // ---- aircraft-type profiles (mirrors fdm_common.resolve_config)
  const strip = v => { if (v && typeof v === 'object' && !Array.isArray(v)) { const o = Object.assign({}, v); delete o._replace; return o; } return v; };
  function merge(base, over) {
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(over) || !isObj(base) || over._replace) return strip(over);
    const out = Object.assign({}, base);
    for (const [k, v] of Object.entries(over)) out[k] = (k in base) ? merge(base[k], v) : strip(v);
    return out;
  }
  function resolveConfig(cfg, profile) {
    const name = profile || cfg.default_profile;
    const prof = (cfg.profiles || {})[name] || {};
    const over = {}; for (const [k, v] of Object.entries(prof)) if (k !== 'label' && k !== 'label_th') over[k] = v;
    const base = {}; for (const [k, v] of Object.entries(cfg)) if (k !== 'profiles') base[k] = v;
    const out = merge(base, over);
    out.profile = name; out.profiles = cfg.profiles || {};
    return out;
  }

  // lowest point of each go-around: below 1000 ft RA, then climb 400 ft without touching down
  function goArounds(rows, air) {
    const n = rows.length, gas = [];
    for (let i = 1; i < n;) {
      if (air[i] && g(rows[i], 'ra_ft') < 1000 && rows[i].vs_fpm < 0) {
        let jmin = i, j = i;
        while (j < n && air[j]) {
          const ra = g(rows[j], 'ra_ft');
          if (isNum(ra) && ra < g(rows[jmin], 'ra_ft')) jmin = j;
          if ((isNum(ra) && ra > g(rows[jmin], 'ra_ft') + 400) || (!isNum(ra) && j > jmin)) { gas.push(jmin); break; }
          j++;
        }
        i = j + 1;
      } else i++;
    }
    return gas;
  }
  function gateIndex(rows, end, prev, gate) {
    for (let j = end; j > Math.max(prev, 0); j--) if (g(rows[j], 'ra_ft') <= gate && gate < g(rows[j - 1], 'ra_ft')) return j;
    return null;
  }

  // Ground elevation (ft) under a point: interpolated along a runway when on it,
  // else the nearest threshold elevation within 15 km; NaN when far from any airport.
  function groundElevAt(airports, lat, lon) {
    let near = null;
    for (const ap of Object.values(airports)) {
      const fr = new Frame(ap.lat, ap.lon); const [x, y] = fr.toXY(lat, lon);
      for (const r of Object.values(ap.runways)) {
        const [a, c] = rwyCoords(fr, r, x, y);
        const p = ap.runways[r.pair];
        if (Math.abs(c) < 100 && a >= 0 && a <= r.length_m && p) return r.thr_elev_ft + (p.thr_elev_ft - r.thr_elev_ft) * a / r.length_m;
        const [tx, ty] = fr.toXY(r.lat, r.lon); const d = Math.hypot(x - tx, y - ty);
        if (!near || d < near.d) near = { d, e: r.thr_elev_ft };
      }
    }
    return near && near.d < 15000 ? near.e : NaN;
  }

  function detectEvents(rows, cfg, airports, vapp) {
    const E = cfg.events, uc = cfg.unstable_criteria;
    vapp = vapp || cfg.vapp_default_kt;
    const vfe = {}; for (const [k, v] of Object.entries(cfg.vfe_kt)) vfe[+k] = v;
    const n = rows.length; if (n < 3) return [];
    const t = rows.map(r => r.time_s);
    const dt = (t[n - 1] - t[0]) / (n - 1);
    const air = rows.map(r => g(r, 'air_ground') >= 0.5);
    const events = [];
    const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
    const ev = (code, level, i0, i1, ipk, value, detail = '') => {
      const d = E[code];
      if (d.enabled === false) return;
      events.push({ code, level, name: d.name, th: d.th, t_start: r1(t[i0]), t_end: r1(t[i1]), t_peak: r1(t[ipk]),
        value: value == null ? null : r2(value), unit: d.unit || '', detail, idx: ipk });
    };
    const levelOf = (code, v) => (v > E[code].l3 ? 3 : 2);
    const inAir = r => g(r, 'air_ground') >= 0.5;

    const liftoffs = [], touchdowns = [];
    for (let i = 1; i < n; i++) { if (air[i] && !air[i - 1]) liftoffs.push(i); if (!air[i] && air[i - 1]) touchdowns.push(i); }

    const pr = new Array(n).fill(NaN);
    for (let i = 1; i < n - 1; i++) pr[i] = (rows[i + 1].pitch_deg - rows[i - 1].pitch_deg) / (t[i + 1] - t[i - 1]);

    for (const i of liftoffs) {
      const p = rows[i].pitch_deg;
      if (p > E.HIGH_PITCH_LIFTOFF.l2) ev('HIGH_PITCH_LIFTOFF', levelOf('HIGH_PITCH_LIFTOFF', p), i, i, i, p);
      const j0 = Math.max(1, i - Math.trunc(10 / dt)), j1 = Math.min(n - 2, i + Math.trunc(3 / dt));
      const jm = argBy(j0, j1, j => (isNum(pr[j]) ? pr[j] : -99));
      if (pr[jm] > E.HIGH_PITCH_RATE_ROT.l2) ev('HIGH_PITCH_RATE_ROT', levelOf('HIGH_PITCH_RATE_ROT', pr[jm]), j0, j1, jm, pr[jm]);
    }

    let d = E.FLAP_OVERSPEED;
    const over = r => { const f = isNum(r.flap) ? Math.round(r.flap) : 0; return vfe[f] ? r.ias_kt - vfe[f] : -999; };
    for (const [i0, i1] of segments(rows, r => inAir(r) && over(r) > d.l2)) {
      if ((i1 - i0 + 1) * dt >= d.min_s) {
        const ipk = argBy(i0, i1, i => over(rows[i])); const v = over(rows[ipk]); const f = Math.round(rows[ipk].flap);
        ev('FLAP_OVERSPEED', v > d.l3 ? 3 : 2, i0, i1, ipk, v, `flap ${f} VFE ${vfe[f]} kt, IAS ${rows[ipk].ias_kt.toFixed(0)} kt`);
      }
    }
    d = E.SPEED_250_BELOW_FL100;
    for (const [i0, i1] of segments(rows, r => inAir(r) && r.alt_ft < 10000 && r.ias_kt > d.l2))
      if ((i1 - i0 + 1) * dt >= d.min_s) {
        const ipk = argBy(i0, i1, i => rows[i].ias_kt); ev('SPEED_250_BELOW_FL100', levelOf('SPEED_250_BELOW_FL100', rows[ipk].ias_kt), i0, i1, ipk, rows[ipk].ias_kt);
      }
    d = E.HIGH_BANK;
    for (const [i0, i1] of segments(rows, r => inAir(r) && Math.abs(r.roll_deg) > d.l2)) {
      const ipk = argBy(i0, i1, i => Math.abs(rows[i].roll_deg)); const v = Math.abs(rows[ipk].roll_deg);
      ev('HIGH_BANK', levelOf('HIGH_BANK', v), i0, i1, ipk, v);
    }
    d = E.HIGH_BANK_LOW_ALT;
    for (const [i0, i1] of segments(rows, r => inAir(r) && g(r, 'ra_ft') < d.ra_max && Math.abs(r.roll_deg) > d.l2)) {
      const ipk = argBy(i0, i1, i => Math.abs(rows[i].roll_deg)); const v = Math.abs(rows[ipk].roll_deg);
      ev('HIGH_BANK_LOW_ALT', levelOf('HIGH_BANK_LOW_ALT', v), i0, i1, ipk, v, `RA ${rows[ipk].ra_ft.toFixed(0)} ft`);
    }
    d = E.HIGH_ROD_FINAL;
    for (const [i0, i1] of segments(rows, r => inAir(r) && g(r, 'ra_ft') > d.ra_min && g(r, 'ra_ft') < d.ra_max && -r.vs_fpm > d.l2))
      if ((i1 - i0 + 1) * dt >= d.min_s) {
        const ipk = argBy(i0, i1, i => -rows[i].vs_fpm); const v = -rows[ipk].vs_fpm;
        ev('HIGH_ROD_FINAL', levelOf('HIGH_ROD_FINAL', v), i0, i1, ipk, v, `RA ${rows[ipk].ra_ft.toFixed(0)} ft`);
      }
    for (const [i0, i1] of segments(rows, r => g(r, 'gpws_warn') >= 0.5)) ev('GPWS_WARNING', 3, i0, i1, i0, 1, 'SINK RATE');

    for (const [code, col] of [['GS_DEVIATION', 'gs_dev_dot'], ['LOC_DEVIATION', 'loc_dev_dot']]) {
      const dd = E[code];
      for (const [i0, i1] of segments(rows, r => inAir(r) && r.vs_fpm < 0 && g(r, 'ra_ft') > dd.ra_min && g(r, 'ra_ft') < dd.ra_max && Math.abs(g(r, col)) > dd.l2))
        if ((i1 - i0 + 1) * dt >= dd.min_s) {
          const ipk = argBy(i0, i1, i => Math.abs(rows[i][col])); const v = Math.abs(rows[ipk][col]);
          ev(code, levelOf(code, v), i0, i1, ipk, v, `${rows[ipk][col] >= 0 ? '+' : ''}${rows[ipk][col].toFixed(2)} dot at RA ${rows[ipk].ra_ft.toFixed(0)} ft`);
        }
    }

    const gas = goArounds(rows, air);
    for (const k of gas) ev('GO_AROUND', 1, k, k, k, rows[k].ra_ft, `minimum RA ${rows[k].ra_ft.toFixed(0)} ft`);

    const marks = [...touchdowns, ...gas, ...liftoffs].sort((a, b) => a - b);
    for (const end of [...touchdowns, ...gas].sort((a, b) => a - b)) {
      const prev = Math.max(0, ...marks.filter(m => m < end));
      for (const code of ['UNSTABLE_1000', 'UNSTABLE_500']) {
        const gi = gateIndex(rows, end, prev, E[code].gate_ft);
        if (gi === null) continue;
        const r = Object.assign({}, rows[gi]);
        const w = rows.slice(Math.max(0, gi - 2), gi + 3);
        r.ias_kt = w.reduce((s, x) => s + x.ias_kt, 0) / w.length;
        r.vs_fpm = w.reduce((s, x) => s + x.vs_fpm, 0) / w.length;
        const why = [];
        if (r.ias_kt > vapp + uc.ias_above_vapp_kt) why.push(`IAS ${r.ias_kt.toFixed(0)} kt > Vapp+${uc.ias_above_vapp_kt}`);
        if (r.ias_kt < vapp - uc.ias_below_vapp_kt) why.push(`IAS ${r.ias_kt.toFixed(0)} kt < Vapp-${uc.ias_below_vapp_kt}`);
        if (r.vs_fpm < uc.vs_min_fpm) why.push(`V/S ${r.vs_fpm.toFixed(0)} fpm`);
        if (g(r, 'flap') < uc.landing_flap_min) why.push(`flap ${Math.round(r.flap)} (not landing config)`);
        if (g(r, 'gear') < 0.5) why.push('gear not down');
        if (Math.abs(g(r, 'loc_dev_dot')) > uc.loc_dev_dot) why.push(`LOC ${r.loc_dev_dot >= 0 ? '+' : ''}${r.loc_dev_dot.toFixed(1)} dot`);
        if (Math.abs(g(r, 'gs_dev_dot')) > uc.gs_dev_dot) why.push(`G/S ${r.gs_dev_dot >= 0 ? '+' : ''}${r.gs_dev_dot.toFixed(1)} dot`);
        if (why.length) ev(code, E[code].level, gi, gi, gi, why.length, why.join('; '));
      }
    }

    for (const td of touchdowns) {
      const j0 = Math.max(0, td - Math.trunc(1 / dt)), j1 = Math.min(n - 1, td + Math.trunc(3 / dt));
      const jm = argBy(j0, j1, j => rows[j].nz_g); const v = rows[jm].nz_g;
      if (v > E.HARD_LANDING.l2) ev('HARD_LANDING', levelOf('HARD_LANDING', v), j0, j1, jm, v, `V/S at touchdown ${rows[td - 1].vs_fpm.toFixed(0)} fpm`);
      const r = rows[td]; const { rwy, along } = findRunway(airports, r.lat, r.lon, r.hdg_true_deg);
      if (rwy && along > E.LONG_LANDING.l2)
        ev('LONG_LANDING', levelOf('LONG_LANDING', along), td, td, td, along, `${rwy.icao} RWY ${rwy.id}: touchdown ${along.toFixed(0)} m past THR`);
    }
    events.sort((a, b) => a.t_peak - b.t_peak);
    return events;
  }

  // ---- routine measurements (mirrors fdm_common.measurements)
  const rnd = (v, nd = 1) => (v == null || Number.isNaN(v)) ? null : Math.round(v * 10 ** nd) / 10 ** nd;
  function measurements(rows, cfg, airports, vapp) {
    vapp = vapp || cfg.vapp_default_kt;
    const gates = cfg.gates_ft || [1000, 500, 50];
    const n = rows.length, out = { landings: [], takeoffs: [], flight: {} };
    if (n < 3) return out;
    const t = rows.map(r => r.time_s), dt = (t[n - 1] - t[0]) / (n - 1);
    const air = rows.map(r => g(r, 'air_ground') >= 0.5);
    const liftoffs = [], touchdowns = [];
    for (let i = 1; i < n; i++) { if (air[i] && !air[i - 1]) liftoffs.push(i); if (!air[i] && air[i - 1]) touchdowns.push(i); }
    const gas = goArounds(rows, air);
    const marks = [...touchdowns, ...gas, ...liftoffs].sort((a, b) => a - b);
    for (const td of touchdowns) {
      const prev = Math.max(0, ...marks.filter(m => m < td));
      const j0 = Math.max(0, td - Math.trunc(1 / dt)), j1 = Math.min(n - 1, td + Math.trunc(3 / dt));
      const k0 = Math.max(prev, td - Math.trunc(3 / dt));
      const { rwy, along } = findRunway(airports, rows[td].lat, rows[td].lon, rows[td].hdg_true_deg);
      let nz = -Infinity; for (let j = j0; j <= j1; j++) nz = Math.max(nz, rows[j].nz_g);
      let roll = -Infinity; for (let k = k0; k <= td; k++) roll = Math.max(roll, Math.abs(rows[k].roll_deg));
      const m = { t: rnd(t[td]), rwy: rwy ? `${rwy.icao} ${rwy.id}` : null, td_nz_g: rnd(nz, 3), td_vs_fpm: rnd(rows[td - 1].vs_fpm, 0),
        td_pitch_deg: rnd(rows[td].pitch_deg, 2), td_roll_max_deg: rnd(roll, 2), td_ias_kt: rnd(rows[td].ias_kt), td_dist_m: rwy ? rnd(along, 0) : null };
      for (const gate of gates) {
        const gi = gateIndex(rows, td, prev, gate);
        if (gi === null) { m['ias_dev_' + gate] = m['vs_' + gate] = m['gs_dev_' + gate] = null; continue; }
        const w = rows.slice(Math.max(0, gi - 2), gi + 3);
        m['ias_dev_' + gate] = rnd(w.reduce((s, x) => s + x.ias_kt, 0) / w.length - vapp);
        m['vs_' + gate] = rnd(w.reduce((s, x) => s + x.vs_fpm, 0) / w.length, 0);
        m['gs_dev_' + gate] = rnd(g(rows[gi], 'gs_dev_dot'), 2);
      }
      const rod = []; for (let k = prev; k < td; k++) { const ra = g(rows[k], 'ra_ft'); if (50 < ra && ra < gates[0]) rod.push(-rows[k].vs_fpm); }
      m.max_rod_final_fpm = rod.length ? rnd(Math.max(...rod), 0) : null;
      out.landings.push(m);
    }
    for (const lo of liftoffs) {
      const j0 = Math.max(1, lo - Math.trunc(10 / dt)), j1 = Math.min(n - 2, lo + Math.trunc(3 / dt));
      let pr = -Infinity; for (let j = j0; j <= j1; j++) pr = Math.max(pr, (rows[j + 1].pitch_deg - rows[j - 1].pitch_deg) / (t[j + 1] - t[j - 1]));
      const { rwy } = findRunway(airports, rows[lo].lat, rows[lo].lon, rows[lo].hdg_true_deg);
      out.takeoffs.push({ t: rnd(t[lo]), rwy: rwy ? `${rwy.icao} ${rwy.id}` : null, lo_pitch_deg: rnd(rows[lo].pitch_deg, 2),
        lo_ias_kt: rnd(rows[lo].ias_kt), max_pitch_rate: j1 >= j0 ? rnd(pr, 2) : null });
    }
    let maxBank = null, maxAlt = -Infinity;
    rows.forEach((r, i) => { if (air[i]) maxBank = Math.max(maxBank ?? 0, Math.abs(r.roll_deg)); maxAlt = Math.max(maxAlt, r.alt_ft); });
    out.flight = { duration_s: rnd(t[n - 1] - t[0]), max_alt_ft: rnd(maxAlt, 0), max_bank_deg: rnd(maxBank, 1),
      n_takeoffs: liftoffs.length, n_landings: touchdowns.length, n_go_arounds: gas.length };
    return out;
  }

  function flightSummary(rows, airports) {
    const air = rows.map(r => g(r, 'air_ground') >= 0.5);
    const out = { duration_s: rows[rows.length - 1].time_s - rows[0].time_s,
      max_alt_ft: Math.max(...rows.map(r => r.alt_ft)), max_ias_kt: Math.max(...rows.map(r => r.ias_kt)),
      max_nz_g: Math.max(...rows.map(r => r.nz_g)), takeoffs: [], landings: [] };
    for (let i = 1; i < rows.length; i++) if (air[i] !== air[i - 1]) {
      const r = rows[i]; const { rwy, along } = findRunway(airports, r.lat, r.lon, r.hdg_true_deg);
      const item = { t: r.time_s, idx: i, rwy: rwy ? `${rwy.icao} ${rwy.id}` : '?', along_m: along == null ? null : Math.round(along), ias_kt: Math.round(r.ias_kt) };
      (air[i] ? out.takeoffs : out.landings).push(item);
    }
    return out;
  }

  global.FDM = { prepareAirports, Frame, rwyCoords, angdiff, findRunway, detectEvents, flightSummary, dmsToDeg,
    resolveConfig, measurements, goArounds, groundElevAt };
})(window);
