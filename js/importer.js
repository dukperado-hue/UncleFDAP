// FDM import core: CSV / Excel table -> layout detection -> column mapping ->
// unit conversion -> derived parameters -> data-quality report -> canonical rows.
// DOM-free so it also runs under Node (tools/import_cli.js). Needs FDM (js/events.js).
(function (global) {
  'use strict';
  const FDM_ = () => global.FDM;

  // ------------------------------------------------------------------ catalogue
  // kind -> units {name: [factor, offset]} converting to the canonical unit (first entry)
  const UNITS = {
    length: { ft: [1, 0], m: [3.280839895, 0] },
    speed: { kt: [1, 0], 'km/h': [0.539956803, 0], 'm/s': [1.943844492, 0], mph: [0.868976242, 0] },
    vspeed: { fpm: [1, 0], 'm/s': [196.8503937, 0], 'ft/s': [60, 0] },
    angle: { deg: [1, 0], rad: [57.29577951, 0] },
    accel: { g: [1, 0], 'g-delta': [1, 1], 'g-auto': [1, 0], 'm/s2': [1 / 9.80665, 0] },
    dots: { dot: [1, 0], fsd: [2.5, 0] },
    temp: { degC: [1, 0], degF: [5 / 9, -32 * 5 / 9], K: [1, -273.15] },
    bool: { bool: [1, 0], 'bool-inv': [-1, 1] },
    number: { '': [1, 0] },
    text: { text: [1, 0] },
  };
  // canonical fields. req = needed for replay; ext = kept only for QC / derivations (not exported)
  const FIELDS = [
    ['lat', 'Latitude', 'angle', true], ['lon', 'Longitude', 'angle', true], ['alt_ft', 'Altitude (baro / MSL)', 'length', true],
    ['ias_kt', 'Indicated / calibrated airspeed', 'speed', true], ['pitch_deg', 'Pitch attitude', 'angle', true],
    ['roll_deg', 'Roll / bank angle', 'angle', true],
    ['hdg_true_deg', 'Heading (true)', 'angle'], ['hdg_mag_deg', 'Heading (magnetic)', 'angle'],
    ['trk_true_deg', 'Ground track (true)', 'angle'], ['trk_mag_deg', 'Ground track (magnetic)', 'angle', false, true],
    ['magvar_deg', 'Magnetic variation (east +)', 'angle', false, true],
    ['ra_ft', 'Radio altitude', 'length'], ['alt_gps_ft', 'GPS altitude (WGS-84)', 'length', false, true],
    ['gs_kt', 'Ground speed', 'speed'], ['tas_kt', 'True airspeed', 'speed'], ['mach', 'Mach', 'number'],
    ['vs_fpm', 'Vertical speed', 'vspeed'], ['nz_g', 'Normal (vertical) acceleration', 'accel'], ['aoa_deg', 'Angle of attack', 'angle'],
    ['flap', 'Flap position / lever', 'number'], ['gear', 'Gear down (1)', 'bool'], ['air_ground', 'Airborne (1) / ground (0)', 'bool'],
    ['ap', 'Autopilot engaged', 'bool'], ['athr', 'Autothrust engaged', 'bool'], ['n1_1', 'Engine 1 N1 / power %', 'number'],
    ['n1_2', 'Engine 2 N1 / power %', 'number'], ['rpm_1', 'Engine 1 RPM', 'number', false, true],
    ['loc_dev_dot', 'Localiser deviation', 'dots'], ['gs_dev_dot', 'Glideslope deviation', 'dots'],
    ['wind_dir_deg', 'Wind direction (true)', 'angle'], ['wind_dir_mag_deg', 'Wind direction (magnetic)', 'angle', false, true],
    ['wind_spd_kt', 'Wind speed', 'speed'], ['sat_c', 'Outside air temperature', 'temp'],
    ['fuel_l', 'Fuel quantity left', 'number', false, true], ['fuel_r', 'Fuel quantity right', 'number', false, true],
    ['gpws_warn', 'GPWS warning', 'bool'], ['rev', 'Thrust reverser', 'bool'], ['gps_fix', 'GPS fix status', 'text', false, true],
    ['phase', 'Flight phase', 'text'],
  ].map(([key, label, kind, req, ext]) => ({ key, label, kind, req: !!req, ext: !!ext }));
  const FIELD = Object.fromEntries(FIELDS.map(f => [f.key, f]));
  const CANON = ['time_s', 'utc', 'phase', 'lat', 'lon', 'alt_ft', 'ra_ft', 'ias_kt', 'tas_kt', 'gs_kt', 'mach', 'vs_fpm', 'pitch_deg',
    'roll_deg', 'hdg_true_deg', 'hdg_mag_deg', 'trk_true_deg', 'aoa_deg', 'nz_g', 'flap', 'gear', 'n1_1', 'n1_2', 'ap', 'athr',
    'loc_dev_dot', 'gs_dev_dot', 'wind_dir_deg', 'wind_spd_kt', 'sat_c', 'air_ground', 'gpws_warn', 'rev'];
  const ANGLE360 = new Set(['hdg_true_deg', 'hdg_mag_deg', 'trk_true_deg', 'trk_mag_deg', 'wind_dir_deg', 'wind_dir_mag_deg']);
  // physical plausibility limits for the range check
  const LIMITS = { lat: [-90, 90], lon: [-180, 180], alt_ft: [-1500, 60000], ra_ft: [-20, 10000], ias_kt: [0, 500], gs_kt: [0, 700],
    tas_kt: [0, 700], vs_fpm: [-15000, 15000], pitch_deg: [-60, 60], roll_deg: [-120, 120], nz_g: [-3, 6], aoa_deg: [-20, 40],
    hdg_true_deg: [0, 360], hdg_mag_deg: [0, 360], trk_true_deg: [0, 360], sat_c: [-90, 60] };
  // largest believable change per second (single-sample spike filter + rate check)
  // (never applied to nz_g: a real touchdown peak is a legitimate one-sample spike)
  const MAX_RATE = { ias_kt: 15, alt_ft: 6000 / 60 * 1.5 + 50, pitch_deg: 15, roll_deg: 30, gs_kt: 20 };

  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const median = a => { const b = a.filter(isNum).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };

  function unitFromText(kind, txt) {
    const t = String(txt || '').toLowerCase().replace(/[()[\]]/g, '').trim();
    if (!t) return null;
    const has = re => re.test(t);
    switch (kind) {
      case 'length': return has(/\bm\b|met/) && !has(/ft|feet/) ? 'm' : (has(/ft|feet/) ? 'ft' : null);
      case 'speed': return has(/km\/?h|kph/) ? 'km/h' : has(/m\/s|mps/) ? 'm/s' : has(/mph/) ? 'mph' : has(/kt|kts|knot/) ? 'kt' : null;
      case 'vspeed': return has(/fpm|ft\/min|feet\/min/) ? 'fpm' : has(/ft\/s/) ? 'ft/s' : has(/m\/s/) ? 'm/s' : null;
      case 'angle': return has(/rad/) ? 'rad' : has(/deg|°/) ? 'deg' : null;
      case 'accel': return has(/m\/s/) ? 'm/s2' : has(/^g$|\bg\b/) ? 'g' : null;
      case 'temp': return has(/deg ?f|°f|\bf\b/) ? 'degF' : has(/\bk\b|kelvin/) ? 'K' : has(/c/) ? 'degC' : null;
      case 'dots': return has(/fsd/) ? 'fsd' : has(/dot|ddm/) ? 'dot' : null;
      default: return null;
    }
  }

  // ------------------------------------------------------------------ parsing
  function parseDelimited(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const sample = text.split(/\r?\n/).filter(l => l.trim() && l[0] !== '#').slice(0, 30);
    let delim = ',', best = -1;
    for (const d of [',', ';', '\t', '|']) {
      const counts = sample.map(l => l.split(d).length);
      const score = counts.length ? Math.min(...counts) : 0;
      if (score > best && score > 1) { best = score; delim = d; }
    }
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell.trim() === '') { q = true; cell = ''; }
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return { delim, rows: rows.filter(r => r.some(c => String(c).trim() !== '')) };
  }

  function readWorkbook(buf) {
    if (!global.XLSX) throw new Error('Excel support (SheetJS) not loaded');
    const wb = global.XLSX.read(buf, { type: 'array', cellDates: false });
    return wb.SheetNames.map(name => ({
      name, rows: global.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false }),
    }));
  }

  const looksNum = v => typeof v === 'number' || (/^\s*[-+]?(\d+[.,]?\d*|[.,]\d+)([eE][-+]?\d+)?\s*$/.test(String(v)));

  // header row, units row, '#' metadata lines
  function detectLayout(rows) {
    const meta = {}; let header = -1, units = -1;
    for (let i = 0; i < Math.min(rows.length, 60); i++) {
      const r = rows[i].map(c => String(c).trim());
      if (r[0] && r[0][0] === '#') {
        for (const c of r) { const m = /([A-Za-z_][\w.]*)\s*=\s*"?([^"]*)"?/.exec(c); if (m) meta[m[1]] = m[2]; }
        continue;
      }
      const ne = r.filter(c => c !== '');
      if (ne.length >= 3 && ne.filter(c => !looksNum(c)).length / ne.length >= 0.6) { header = i; break; }
    }
    if (header < 0) throw new Error('Could not find a header row (need a row of 3+ column names)');
    const H = rows[header].map(c => String(c).trim());
    const prev = header > 0 ? rows[header - 1].map(c => String(c).trim()) : null;
    const next = rows[header + 1] ? rows[header + 1].map(c => String(c).trim()) : null;
    let U = null;
    const unitish = r => { const ne = r.filter(c => c !== ''); return ne.length && ne.filter(c => !looksNum(c)).length / ne.length >= 0.5 && ne.every(c => c.length <= 16); };
    if (next && unitish(next)) { U = next; units = header + 1; }
    else if (prev && prev[0] && prev[0][0] === '#' && prev.length >= H.length - 1) { U = prev.map((c, k) => k === 0 ? c.slice(1) : c); units = header - 1; }
    const columns = H.map((name, idx) => {
      let unit = U ? (U[idx] || '').trim() : '';
      const m = /^(.*?)\s*[([]\s*([^)\]]+)\s*[)\]]\s*$/.exec(name);
      if (m) { name = m[1]; unit = unit || m[2]; }
      return { idx, name, unit };
    }).filter(c => c.name !== '');
    const dataStart = Math.max(header, units) + 1;
    return { meta, header, units, dataStart, columns, nData: rows.length - dataStart };
  }

  // ------------------------------------------------------------------ templates & mapping
  function matchTemplate(templates, columns) {
    const names = new Set(columns.map(c => norm(c.name)));
    let best = null;
    for (const t of templates) {
      const hit = t.detect.filter(d => names.has(norm(d))).length / t.detect.length;
      if (hit >= 0.8 && (!best || hit > best.hit)) best = { t, hit };
    }
    return best ? best.t : null;
  }

  const findCol = (columns, cands) => {
    for (const c of [].concat(cands || [])) { const k = columns.find(x => norm(x.name) === norm(c)); if (k) return k; }
    return null;
  };

  // mapping = {time:{...}, fields:{key:{col, unit}}}
  function autoMapping(columns, template) {
    const fields = {};
    if (template) {
      for (const [key, spec] of Object.entries(template.columns)) {
        const c = findCol(columns, spec.src); if (!c || !FIELD[key]) continue;
        fields[key] = { col: c.name, unit: spec.unit || unitFromText(FIELD[key].kind, c.unit) || Object.keys(UNITS[FIELD[key].kind])[0] };
      }
    }
    // generic guesses for anything still unmapped: exact canonical name or common aliases
    const ALIAS = { lat: ['latitude', 'lat', 'gpslat'], lon: ['longitude', 'lon', 'long', 'lng', 'gpslon'], alt_ft: ['altitude', 'alt', 'altmsl', 'baroalt', 'pressurealt'],
      ias_kt: ['ias', 'cas', 'airspeed', 'indicatedairspeed'], pitch_deg: ['pitch', 'pitchangle'], roll_deg: ['roll', 'bank', 'rollangle'],
      hdg_true_deg: ['heading', 'hdg', 'trueheading', 'headingtrue'], gs_kt: ['groundspeed', 'gs', 'gndspd'], vs_fpm: ['vs', 'vspd', 'verticalspeed', 'vertspeed'],
      nz_g: ['nz', 'normac', 'vrtg', 'gload', 'verticalacceleration', 'normalacceleration'], ra_ft: ['radioalt', 'ralt', 'radalt', 'agl'] };
    for (const f of FIELDS) {
      if (fields[f.key]) continue;
      const c = columns.find(x => norm(x.name) === norm(f.key)) || columns.find(x => (ALIAS[f.key] || []).includes(norm(x.name)));
      if (c) fields[f.key] = { col: c.name, unit: unitFromText(f.kind, c.unit) || Object.keys(UNITS[f.kind])[0] };
    }
    let time = template ? Object.assign({}, template.time) : null;
    if (!time) {
      const ts = findCol(columns, ['time_s', 'time', 'seconds', 'elapsed', 'frametime', 't']);
      const dt = findCol(columns, ['datetime', 'timestamp', 'utc', 'gmt', 'dateTime']);
      const d = findCol(columns, ['date', 'lcldate', 'utcdate']), tm = findCol(columns, ['lcltime', 'utctime', 'time', 'gmt']);
      if (d && tm) time = { mode: 'datetime', date: d.name, time: tm.name };
      else if (dt) time = { mode: 'datetime', time: dt.name };
      else if (ts) time = { mode: 'seconds', col: ts.name, unit: 's' };
      else time = { mode: 'index', hz: 1 };
    }
    return { template: template ? template.id : null, profile: template ? template.profile : null, time, fields };
  }

  // ------------------------------------------------------------------ time parsing
  function parseDateParts(s) {
    s = String(s).trim(); let m;
    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return [+m[1], +m[2], +m[3]];
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s))) { let y = +m[3]; if (y < 100) y += 2000; return [y, +m[2], +m[1]]; } // d/m/y (Thai convention)
    return null;
  }
  function parseTimeOfDay(v) {
    if (typeof v === 'number') return v < 1 ? v * 86400 : NaN;          // Excel time fraction
    const m = /(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?/.exec(String(v));
    return m ? +m[1] * 3600 + +m[2] * 60 + (m[3] ? +m[3] : 0) : NaN;
  }
  function parseOffset(v) {
    const m = /([+-])?(\d{1,2}):?(\d{2})?/.exec(String(v || '').trim());
    return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 3600 + (m[3] ? +m[3] * 60 : 0)) : 0;
  }
  // epoch seconds (UTC) or NaN
  function epochOf(dateV, timeV, offV) {
    if (typeof dateV === 'number' && dateV > 20000 && dateV < 80000) {          // Excel serial date(+time)
      const s = Math.round((dateV - 25569) * 86400 * 1000) / 1000;
      return (timeV === undefined ? s : Math.floor(s / 86400) * 86400 + parseTimeOfDay(timeV)) - parseOffset(offV);
    }
    let dp = dateV === undefined ? null : parseDateParts(dateV);
    let tv = timeV;
    if (dateV !== undefined && timeV === undefined) {        // single datetime cell
      const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?/.exec(String(dateV).trim());
      if (iso) { dp = parseDateParts(iso[1]); tv = iso[2]; if (iso[3]) offV = iso[3] === 'Z' ? '+00:00' : iso[3]; }
    }
    if (!dp) return NaN;
    let [y, mo, d] = dp; if (y > 2400) y -= 543;             // Buddhist Era year
    const tod = parseTimeOfDay(tv);
    if (!Number.isFinite(tod)) return NaN;
    return Date.UTC(y, mo - 1, d) / 1000 + tod - parseOffset(offV);
  }
  const iso = e => new Date(Math.round(e * 100) * 10).toISOString().replace(/(\.\d\d)\dZ$/, '$1Z');

  // ------------------------------------------------------------------ normalise
  function toNumber(v, decimalComma) {
    if (typeof v === 'number') return v;
    let s = String(v == null ? '' : v).trim();
    if (s === '') return NaN;
    if (decimalComma) s = s.replace(',', '.');
    return looksNum(s) ? +s : NaN;
  }

  function normalize(table, layout, mapping, opts = {}) {
    const rows = table.slice(layout.dataStart);
    const colIdx = Object.fromEntries(layout.columns.map(c => [c.name, c.idx]));
    const ncol = Math.max(...layout.columns.map(c => c.idx)) + 1;
    const decimalComma = opts.delim === ';';
    const issues = { incomplete: 0, badTime: 0, nonNumeric: {}, duplicates: 0, nonMonotonic: 0 };
    const out = [];
    const T = mapping.time;
    let rollover = 0, lastTod = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const filled = r.filter(c => String(c).trim() !== '').length;
      if (r.length < ncol * 0.9 && filled < layout.columns.length * 0.5) { issues.incomplete++; continue; }
      const get = name => (name && name in colIdx) ? r[colIdx[name]] : undefined;
      let t = NaN, utc = '';
      if (T.mode === 'seconds') {
        t = toNumber(get(T.col), decimalComma) * (T.unit === 'ms' ? 0.001 : 1);
        if (T.utc && get(T.utc)) utc = String(get(T.utc)).trim();
      } else if (T.mode === 'datetime') {
        const e = epochOf(T.date ? get(T.date) : get(T.time), T.date ? get(T.time) : undefined, T.offset ? get(T.offset) : T.offsetValue);
        if (Number.isFinite(e)) { t = e; utc = iso(e); }
      } else if (T.mode === 'timeofday') {
        let tod = parseTimeOfDay(get(T.col));
        if (lastTod !== null && tod + rollover < lastTod - 43200) rollover += 86400;
        if (Number.isFinite(tod)) { tod += rollover; lastTod = tod; t = tod; }
      } else t = out.length / (T.hz || 1);
      if (!Number.isFinite(t)) { issues.badTime++; continue; }
      const o = { _t: t, utc };
      for (const [key, m] of Object.entries(mapping.fields)) {
        if (!m || !m.col) continue;
        const f = FIELD[key]; const raw = get(m.col);
        if (f.kind === 'text') { o[key] = raw == null ? '' : String(raw).trim(); continue; }
        let v = toNumber(raw, decimalComma);
        if (!Number.isFinite(v)) { if (String(raw == null ? '' : raw).trim() !== '') issues.nonNumeric[key] = (issues.nonNumeric[key] || 0) + 1; o[key] = NaN; continue; }
        const conv = (UNITS[f.kind] || UNITS.number)[m.unit] || [1, 0];
        v = v * conv[0] + conv[1];
        if (ANGLE360.has(key)) v = ((v % 360) + 360) % 360;
        o[key] = v;
      }
      if (T.mode === 'seconds' && T.timeofday && get(T.timeofday)) o.utc_tod = String(get(T.timeofday)).trim();
      out.push(o);
    }
    // order & duplicates
    for (let i = 1; i < out.length; i++) if (out[i]._t < out[i - 1]._t) issues.nonMonotonic++;
    if (issues.nonMonotonic) out.sort((a, b) => a._t - b._t);
    const dedup = [];
    for (const o of out) { if (dedup.length && Math.abs(o._t - dedup[dedup.length - 1]._t) < 1e-6) { issues.duplicates++; continue; } dedup.push(o); }
    const t0 = dedup.length ? dedup[0]._t : 0;
    for (const o of dedup) { o.time_s = Math.round((o._t - t0) * 1000) / 1000; delete o._t; }
    return { rows: dedup, issues };
  }

  // ------------------------------------------------------------------ derive
  function interpGaps(rows, key, maxGap) {
    const idx = []; rows.forEach((r, i) => { if (isNum(r[key])) idx.push(i); });
    if (!idx.length) return 0;
    let filled = 0;
    const ang = ANGLE360.has(key);
    for (let k = 0; k < idx.length - 1; k++) {
      const a = idx[k], b = idx[k + 1]; if (b - a < 2) continue;
      if (rows[b].time_s - rows[a].time_s > maxGap) continue;
      for (let i = a + 1; i < b; i++) {
        const f = (rows[i].time_s - rows[a].time_s) / (rows[b].time_s - rows[a].time_s);
        rows[i][key] = ang ? (rows[a][key] + FDM_().angdiff(rows[b][key], rows[a][key]) * f + 360) % 360 : rows[a][key] + (rows[b][key] - rows[a][key]) * f;
        filled++;
      }
    }
    for (let i = 0; i < idx[0]; i++) { rows[i][key] = rows[idx[0]][key]; filled++; }
    for (let i = idx[idx.length - 1] + 1; i < rows.length; i++) { rows[i][key] = rows[idx[idx.length - 1]][key]; filled++; }
    return filled;
  }

  // single-sample spikes: jump in and jump back out beyond the believable rate
  function despike(rows, key) {
    const lim = MAX_RATE[key]; if (!lim) return [];
    const fixed = [];
    for (let i = 1; i < rows.length - 1; i++) {
      const a = rows[i - 1][key], b = rows[i][key], c = rows[i + 1][key];
      if (![a, b, c].every(isNum)) continue;
      const d1 = (b - a) / Math.max(rows[i].time_s - rows[i - 1].time_s, 0.05), d2 = (c - b) / Math.max(rows[i + 1].time_s - rows[i].time_s, 0.05);
      if (Math.abs(d1) > lim && Math.abs(d2) > lim && Math.sign(d1) !== Math.sign(d2) && Math.abs(c - a) < Math.abs(b - a) / 3) {
        fixed.push({ i, t: rows[i].time_s, from: b }); rows[i][key] = (a + c) / 2;
      }
    }
    return fixed;
  }

  function derive(rows, ctx) {
    const { cfg, airports, mapping } = ctx;
    const notes = [], derived = {};
    const has = k => rows.some(r => isNum(r[k]));
    const n = rows.length;
    const note = (key, en, th) => { derived[key] = en; notes.push({ key, en, th }); };

    // spikes first (before anything is derived from these fields)
    const spikes = {};
    if (ctx.despike !== false) for (const k of Object.keys(MAX_RATE)) { const f = despike(rows, k); if (f.length) spikes[k] = f; }

    // position gaps: replay needs a position on every row
    const posFilled = Math.max(interpGaps(rows, 'lat', 600), interpGaps(rows, 'lon', 600));
    for (const k of ['alt_ft', 'ias_kt', 'pitch_deg', 'roll_deg']) interpGaps(rows, k, 30);

    // magnetic -> true
    const nearAp = () => {
      const r = rows[n >> 1]; let best = null;
      for (const ap of Object.values(airports)) { const [x, y] = new (FDM_().Frame)(ap.lat, ap.lon).toXY(r.lat, r.lon); const d = Math.hypot(x, y); if (!best || d < best.d) best = { ap, d }; }
      return best && best.d < 150000 ? best.ap : null;
    };
    const ap0 = nearAp();
    const varOf = r => isNum(r.magvar_deg) ? r.magvar_deg : (ap0 ? ap0.magvar_deg : 0);
    if (!has('hdg_true_deg') && has('hdg_mag_deg')) {
      for (const r of rows) r.hdg_true_deg = isNum(r.hdg_mag_deg) ? (r.hdg_mag_deg + varOf(r) + 360) % 360 : NaN;
      note('hdg_true_deg', `true heading = magnetic heading + variation (${has('magvar_deg') ? 'recorded MagVar' : (ap0 ? ap0.icao + ' ' + ap0.magvar_deg + '°' : '0°')})`, 'heading จริง = heading แม่เหล็ก + ค่าแปรผันแม่เหล็ก');
    }
    if (!has('trk_true_deg') && has('trk_mag_deg')) for (const r of rows) r.trk_true_deg = isNum(r.trk_mag_deg) ? (r.trk_mag_deg + varOf(r) + 360) % 360 : NaN;
    if (!has('wind_dir_deg') && has('wind_dir_mag_deg')) for (const r of rows) r.wind_dir_deg = isNum(r.wind_dir_mag_deg) ? (r.wind_dir_mag_deg + varOf(r) + 360) % 360 : NaN;
    if (!has('hdg_mag_deg') && has('hdg_true_deg')) for (const r of rows) r.hdg_mag_deg = isNum(r.hdg_true_deg) ? (r.hdg_true_deg - varOf(r) + 360) % 360 : NaN;

    // ground speed / track from positions
    const gsHad = has('gs_kt');
    if (!gsHad || !has('trk_true_deg')) {
      const Fr = FDM_().Frame;
      for (let i = 0; i < n; i++) {
        const a = rows[Math.max(0, i - 1)], b = rows[Math.min(n - 1, i + 1)];
        const fr = new Fr(a.lat, a.lon); const [x, y] = fr.toXY(b.lat, b.lon); const dt = b.time_s - a.time_s;
        if (!isNum(rows[i].gs_kt) && dt > 0) rows[i].gs_kt = Math.hypot(x, y) / dt / 0.514444;
        if (!isNum(rows[i].trk_true_deg) && dt > 0 && Math.hypot(x, y) > 1) rows[i].trk_true_deg = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
      }
      interpGaps(rows, 'trk_true_deg', 1e9);
      const what = !gsHad ? 'ground speed and track' : 'ground track';
      note(!gsHad ? 'gs_kt' : 'trk_true_deg', what + ' computed from successive positions', 'คำนวณ ' + (!gsHad ? 'ground speed / track' : 'track') + ' จากตำแหน่งต่อเนื่อง');
    }
    if (!has('hdg_true_deg')) {
      for (const r of rows) r.hdg_true_deg = r.trk_true_deg;
      note('hdg_true_deg', 'no heading recorded: heading set equal to ground track (crab angle lost)', 'ไม่มี heading: ใช้ ground track แทน (ไม่เห็นมุม crab)');
    }
    interpGaps(rows, 'hdg_true_deg', 1e9);

    // vertical speed from altitude (central difference over +-2 s)
    if (!has('vs_fpm')) {
      for (let i = 0; i < n; i++) {
        let a = i, b = i; while (a > 0 && rows[i].time_s - rows[a].time_s < 2) a--; while (b < n - 1 && rows[b].time_s - rows[i].time_s < 2) b++;
        const dt = rows[b].time_s - rows[a].time_s;
        rows[i].vs_fpm = dt > 0 ? (rows[b].alt_ft - rows[a].alt_ft) / dt * 60 : 0;
      }
      note('vs_fpm', 'vertical speed derived from altitude (central difference, ±2 s)', 'คำนวณอัตราไต่/ร่อนจากความสูง');
    }

    // normal acceleration: detect 0-based (deviation) recording
    let nzOffset = 0;
    const nzMap = mapping.fields.nz_g;
    if (has('nz_g')) {
      if (nzMap && nzMap.unit === 'g-auto') {
        const lvl = rows.filter(r => Math.abs(r.roll_deg) < 10 && isNum(r.nz_g)).map(r => r.nz_g);
        const md = median(lvl);
        if (Math.abs(md) < 0.3) {
          nzOffset = 1; for (const r of rows) if (isNum(r.nz_g)) r.nz_g += 1;
          note('nz_g', `recorded acceleration is centred on 0 g (median ${md.toFixed(2)}): treated as deviation from 1 g, +1 g applied`, 'ค่าแรง G บันทึกเป็นส่วนเบี่ยงจาก 1 g จึงบวก 1 g');
        }
      }
    } else {
      for (const r of rows) r.nz_g = 1;
      note('nz_g', 'no normal acceleration recorded: filled with 1 g, hard-landing detection is not meaningful', 'ไม่มีค่าแรง G: ใส่ 1 g ไว้ การตรวจ hard landing ใช้ไม่ได้');
    }
    for (const r of rows) if (!isNum(r.nz_g)) r.nz_g = 1;

    // height above aerodrome when there is no radio altimeter
    let haaSource = null;
    if (!has('ra_ft')) {
      for (const r of rows) {
        const ge = FDM_().groundElevAt(airports, r.lat, r.lon);
        r._haa = isNum(ge) ? r.alt_ft - ge : NaN;
        r.ra_ft = isNum(r._haa) && r._haa < 2500 ? Math.max(r._haa, 0) : NaN;
      }
      haaSource = true;
      note('ra_ft', 'no radio altimeter: height = altitude − runway/aerodrome elevation from AIP (sloped runway interpolated)', 'ไม่มี radio altimeter: ใช้ความสูงเหนือสนาม = altitude − ระดับรันเวย์ตาม AIP');
    }

    // air/ground state with hysteresis when no weight-on-wheels
    if (!has('air_ground')) {
      const vlo = cfg.liftoff_ias_kt || 100;
      let air = false;
      const height = r => isNum(r._haa) ? r._haa : (isNum(r.ra_ft) ? r.ra_ft : NaN);
      for (const r of rows) {
        const h = height(r);
        if (!air && r.ias_kt >= vlo && (isNum(h) ? h > 15 : r.ias_kt > vlo + 10)) air = true;
        else if (air && (isNum(h) ? h <= 5 : r.ias_kt < vlo - 10)) air = false;
        r.air_ground = air ? 1 : 0;
      }
      note('air_ground', `air/ground derived from airspeed (≥ ${vlo} kt) and height (> 15 ft airborne, ≤ 5 ft on ground) — no weight-on-wheels`, 'สถานะอากาศ/พื้นคำนวณจากความเร็วและความสูง (ไม่มีสัญญาณ WOW)');
    }
    if (!has('gear') && cfg.fixed_gear) { for (const r of rows) r.gear = 1; note('gear', 'fixed landing gear: gear = down', 'ฐานล้อตายตัว: gear = down'); }

    // flight phase
    if (!rows.some(r => r.phase)) {
      let landed = false;
      for (const r of rows) {
        const h = isNum(r._haa) ? r._haa : r.ra_ft;
        if (r.air_ground < 0.5) r.phase = r.ias_kt < 30 ? 'TAXI' : (landed ? 'ROLLOUT' : 'TAKEOFF');
        else { landed = true; r.phase = r.vs_fpm > 300 ? 'CLIMB' : r.vs_fpm < -300 ? (isNum(h) && h < 1500 ? 'APPROACH' : 'DESCENT') : 'CRUISE'; }
        if (r.air_ground >= 0.5) landed = true;
      }
      note('phase', 'flight phase derived from air/ground, vertical speed and height', 'ช่วงการบินคำนวณจากสถานะอากาศ/พื้น อัตราไต่ และความสูง');
    }
    return { notes, derived, spikes, nzOffset, posFilled, haaSource };
  }

  // ------------------------------------------------------------------ quality report
  function qualityReport(rows, ctx) {
    const { issues, derivation, mapping, layout, airports, cfg } = ctx;
    const checks = [], stats = [];
    const add = (id, sev, en, th, extra) => checks.push(Object.assign({ id, sev, en, th }, extra || {}));
    const n = rows.length;
    if (n < 10) { add('rows', 'fail', `only ${n} usable rows`, `มีข้อมูลใช้ได้เพียง ${n} แถว`); return finish(); }

    const dts = []; for (let i = 1; i < n; i++) dts.push(rows[i].time_s - rows[i - 1].time_s);
    const dt = median(dts);
    const gaps = []; for (let i = 1; i < n; i++) if (rows[i].time_s - rows[i - 1].time_s > Math.max(2.5 * dt, dt + 1.5)) gaps.push({ t: rows[i - 1].time_s, len: rows[i].time_s - rows[i - 1].time_s });
    const dur = rows[n - 1].time_s - rows[0].time_s;
    const recovered = Math.min(1, (n - 1) * dt / Math.max(dur, 1e-9));
    add('rate', dt > 1.01 ? 'warn' : 'ok', `sample rate ${(1 / dt).toFixed(dt < 1 ? 1 : 2)} Hz (${dt.toFixed(2)} s), ${n} rows, ${fmt(dur)}`,
      `อัตราสุ่ม ${(1 / dt).toFixed(2)} Hz, ${n} แถว, ยาว ${fmt(dur)}`, { value: 1 / dt });
    if (dt >= 0.99) add('nz_rate', 'warn', 'vertical acceleration at ≤ 1 Hz under-samples the touchdown peak (Airbus FDA guidance: record it at a high rate) — treat touchdown g as indicative only',
      'ค่าแรง G ที่ ≤ 1 Hz จับค่าสูงสุดตอนแตะพื้นได้ไม่ครบ ให้ใช้ค่า touchdown g เป็นค่าประมาณ');
    add('gaps', gaps.length ? 'warn' : 'ok', gaps.length ? `${gaps.length} recording gap(s), longest ${Math.max(...gaps.map(g => g.len)).toFixed(0)} s at ${fmt(gaps[0].t)} — data recovery ${(recovered * 100).toFixed(1)} %` : 'no recording gaps — data recovery 100 %',
      gaps.length ? `ข้อมูลขาดหาย ${gaps.length} ช่วง ยาวสุด ${Math.max(...gaps.map(g => g.len)).toFixed(0)} วินาที — กู้คืนได้ ${(recovered * 100).toFixed(1)} %` : 'ไม่มีช่วงข้อมูลขาด', { value: recovered, gaps });
    if (issues.incomplete) add('incomplete', 'warn', `${issues.incomplete} incomplete / truncated line(s) dropped`, `ตัดแถวที่ไม่ครบ/ขาดกลางคัน ${issues.incomplete} แถว`);
    if (issues.badTime) add('badtime', 'warn', `${issues.badTime} row(s) without a readable time dropped`, `ตัดแถวที่อ่านเวลาไม่ได้ ${issues.badTime} แถว`);
    if (issues.duplicates) add('dup', 'warn', `${issues.duplicates} duplicated time stamp(s) removed`, `ลบเวลาที่ซ้ำ ${issues.duplicates} แถว`);
    if (issues.nonMonotonic) add('order', 'warn', `${issues.nonMonotonic} row(s) out of time order — sorted`, `มี ${issues.nonMonotonic} แถวที่เวลาไม่เรียง — จัดเรียงใหม่แล้ว`);
    for (const [k, c] of Object.entries(issues.nonNumeric)) add('nonnum_' + k, 'warn', `${c} non-numeric value(s) in ${k}`, `${k} มีค่าที่ไม่ใช่ตัวเลข ${c} ค่า`);

    const missing = FIELDS.filter(f => f.req && !(mapping.fields[f.key] && mapping.fields[f.key].col));
    if (missing.length) add('required', 'fail', 'required parameter(s) not mapped: ' + missing.map(f => f.key).join(', '), 'ยังไม่ได้จับคู่พารามิเตอร์ที่จำเป็น: ' + missing.map(f => f.key).join(', '));

    // per-field statistics
    const air = rows.map(r => r.air_ground >= 0.5);
    for (const f of FIELDS.concat([{ key: 'ra_ft' }])) {
      const k = f.key; if (stats.some(s => s.key === k)) continue;
      const m = mapping.fields[k]; const src = m && m.col ? m.col : (derivation.derived[k] ? 'derived' : null);
      if (!src || FIELD[k] && FIELD[k].kind === 'text') continue;
      const v = rows.map(r => r[k]);
      const fin = v.filter(isNum);
      if (!fin.length && src !== 'derived') { stats.push({ key: k, src, unit: m && m.unit, coverage: 0 }); continue; }
      const lim = LIMITS[k]; const out = lim ? fin.filter(x => x < lim[0] || x > lim[1]).length : 0;
      // frozen while airborne
      let run = 0, best = 0, bestT = null;
      if (['alt_ft', 'ias_kt', 'pitch_deg', 'roll_deg'].includes(k)) {   // heading/position can legitimately stay constant
        for (let i = 1; i < n; i++) {
          if (air[i] && isNum(v[i]) && v[i] === v[i - 1]) { run += rows[i].time_s - rows[i - 1].time_s; if (run > best) { best = run; bestT = rows[i].time_s - run; } } else run = 0;
        }
      }
      const raw = m && m.col ? (ctx.rawCoverage[k] ?? null) : null;
      stats.push({ key: k, src, unit: m && m.unit, coverage: raw ?? fin.length / n, min: Math.min(...fin), max: Math.max(...fin), out,
        frozen_s: best, frozen_t: bestT, spikes: (derivation.spikes[k] || []).length });
      if (out) add('range_' + k, 'warn', `${k}: ${out} value(s) outside ${lim[0]}…${lim[1]}`, `${k}: ${out} ค่าอยู่นอกช่วงที่เป็นไปได้`);
      if (best >= 10) add('frozen_' + k, 'warn', `${k} frozen for ${best.toFixed(0)} s in flight at ${fmt(bestT)} (sensor / recorder freeze?)`, `${k} ค่าค้างนิ่ง ${best.toFixed(0)} วินาทีระหว่างบิน (เซนเซอร์หรือเครื่องบันทึกค้าง?)`);
      if ((derivation.spikes[k] || []).length) add('spike_' + k, 'warn', `${k}: ${derivation.spikes[k].length} single-sample spike(s) repaired, e.g. ${derivation.spikes[k][0].from.toFixed(1)} at ${fmt(derivation.spikes[k][0].t)}`, `${k}: แก้ค่ากระโดดผิดปกติ ${derivation.spikes[k].length} จุด`);
    }
    // GPS coverage / jumps
    const latCov = ctx.rawCoverage.lat;
    if (latCov !== undefined && latCov < 0.999) add('gps', 'warn', `position missing on ${((1 - latCov) * 100).toFixed(1)} % of rows — interpolated for replay`, `ไม่มีตำแหน่ง ${((1 - latCov) * 100).toFixed(1)} % ของแถว — ประมาณค่าแทรกเพื่อ replay`);
    let jumps = 0;
    for (let i = 1; i < n; i++) {
      const fr = new (FDM_().Frame)(rows[i - 1].lat, rows[i - 1].lon); const [x, y] = fr.toXY(rows[i].lat, rows[i].lon);
      const d = rows[i].time_s - rows[i - 1].time_s; if (d > 0 && Math.hypot(x, y) / d > 700 * 0.514444) jumps++;
    }
    if (jumps) add('gpsjump', 'warn', `${jumps} position jump(s) faster than 700 kt`, `ตำแหน่งกระโดดเร็วเกิน 700 kt ${jumps} ครั้ง`);
    // altitude datum check on the ground
    if (derivation.haaSource) {
      const g = rows.filter(r => r.air_ground < 0.5 && isNum(r._haa)).map(r => r._haa);
      const md = median(g);
      if (isNum(md)) add('datum', Math.abs(md) > 50 ? 'fail' : (Math.abs(md) > 25 ? 'warn' : 'ok'),
        `on-ground altitude vs runway elevation: median ${md >= 0 ? '+' : ''}${md.toFixed(0)} ft` + (Math.abs(md) > 25 ? ' — altitude may not be MSL/baro (GPS altitudes are often WGS-84 ellipsoid heights) or the QNH setting is off' : ''),
        `ความสูงขณะอยู่บนพื้นเทียบระดับรันเวย์: ${md.toFixed(0)} ft` + (Math.abs(md) > 25 ? ' — ความสูงอาจไม่ใช่ MSL (เช่น GPS อ้างอิงทรงรี WGS-84)' : ''), { value: md });
      const gp = rows.filter(r => isNum(r.alt_gps_ft) && isNum(r.alt_ft) && r.air_ground >= 0.5).map(r => r.alt_gps_ft - r.alt_ft);
      if (gp.length > 20) { const d = median(gp); add('gpsalt', 'ok', `GPS altitude − baro altitude: median ${d.toFixed(0)} ft (geoid separation + QNH; not used)`, `ความต่าง GPS altitude − baro: ${d.toFixed(0)} ft (ไม่ได้ใช้)`); }
    }
    // airspeed vs ground speed / heading vs track sanity (catches unit or true/magnetic mix-ups)
    const ag = rows.filter((r, i) => air[i] && isNum(r.gs_kt) && isNum(r.ias_kt)).map(r => r.gs_kt - r.ias_kt);
    if (ag.length > 20 && Math.abs(median(ag)) > 80) add('ias_gs', 'warn', `ground speed differs from airspeed by ${median(ag).toFixed(0)} kt on average — check speed units`, 'ground speed ต่างจาก airspeed มาก — ตรวจหน่วยความเร็ว');
    const ht = rows.filter((r, i) => air[i] && isNum(r.trk_true_deg) && isNum(r.hdg_true_deg)).map(r => Math.abs(FDM_().angdiff(r.trk_true_deg, r.hdg_true_deg)));
    if (ht.length > 20 && median(ht) > 25) add('hdg_trk', 'warn', `heading and track differ by ${median(ht).toFixed(0)}° on average — check true/magnetic or units`, 'heading กับ track ต่างกันมาก — ตรวจ true/magnetic หรือหน่วย');
    // operations found
    const lo = [], td = []; for (let i = 1; i < n; i++) { if (air[i] && !air[i - 1]) lo.push(i); if (!air[i] && air[i - 1]) td.push(i); }
    add('ops', lo.length + td.length ? 'ok' : 'warn', `${lo.length} take-off(s), ${td.length} landing(s) detected`, `พบการขึ้น ${lo.length} ครั้ง ลงจอด ${td.length} ครั้ง`);
    for (const d of derivation.notes) add('derived_' + d.key, 'info', 'derived ' + d.key + ': ' + d.en, 'สร้างค่า ' + d.key + ': ' + d.th);
    return finish();

    function finish() {
      let score = 100;
      for (const c of checks) score -= c.sev === 'fail' ? 30 : c.sev === 'warn' ? (c.id === 'nz_rate' || c.id === 'rate' ? 3 : 6) : 0;
      score = Math.max(0, score);
      const verdict = checks.some(c => c.sev === 'fail') || score < 50 ? 'reject' : score < 80 ? 'limited' : 'usable';
      return { score, verdict, checks, stats, template: mapping.template, profile: cfg.profile,
        layout: { header: layout.header, units: layout.units, columns: layout.columns.length, meta: layout.meta } };
    }
  }
  const fmt = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  // ------------------------------------------------------------------ pipeline
  function run(table, layout, mapping, ctx) {
    const res = normalize(table, layout, mapping, ctx);
    const rows = res.rows;
    const rawCoverage = {};
    for (const k of Object.keys(mapping.fields)) if (mapping.fields[k] && mapping.fields[k].col) rawCoverage[k] = rows.length ? rows.filter(r => isNum(r[k])).length / rows.length : 0;
    const cfg = FDM_().resolveConfig(ctx.rawCfg, mapping.profile || ctx.profile);
    const derivation = rows.length >= 3 ? derive(rows, { cfg, airports: ctx.airports, mapping, despike: ctx.despike }) : { notes: [], derived: {}, spikes: {} };
    const qc = qualityReport(rows, { issues: res.issues, derivation, mapping, layout, airports: ctx.airports, cfg, rawCoverage });
    for (const r of rows) { delete r._haa; for (const k of CANON) if (!(k in r)) r[k] = (k === 'utc' || k === 'phase') ? '' : NaN; }
    return { rows, qc, cfg, derivation };
  }

  function toCSV(rows) {
    const f = (k, v) => {
      if (k === 'utc' || k === 'phase') return String(v == null ? '' : v).replace(/[,\n\r"]/g, ' ');
      if (!isNum(v)) return '';
      const d = { lat: 7, lon: 7, time_s: 3, nz_g: 3, mach: 3, loc_dev_dot: 3, gs_dev_dot: 3 }[k] ?? 2;
      return String(Math.round(v * 10 ** d) / 10 ** d);
    };
    return CANON.join(',') + '\n' + rows.map(r => CANON.map(k => f(k, r[k])).join(',')).join('\n') + '\n';
  }

  const api = { UNITS, FIELDS, FIELD, CANON, parseDelimited, readWorkbook, detectLayout, matchTemplate, autoMapping,
    normalize, derive, qualityReport, run, toCSV, unitFromText, epochOf };
  global.Importer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
