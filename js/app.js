// FDM Replay - main controller: data loading, playback, wiring of 3D/PFD/ND/charts/exports.
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const ANGLE_KEYS = new Set(['hdg_true_deg', 'hdg_mag_deg', 'trk_true_deg', 'wind_dir_deg']);
  const STEP_KEYS = new Set(['flap', 'gear', 'ap', 'athr', 'air_ground', 'gpws_warn', 'rev', 'phase', 'utc']);
  const REQUIRED = ['time_s', 'lat', 'lon', 'alt_ft', 'ias_kt', 'pitch_deg', 'roll_deg', 'hdg_true_deg'];
  const LEVEL_TXT = { 1: 'INFO', 2: 'CAUTION', 3: 'WARNING' };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  const App = {
    t: 0, playing: false, speed: 4, ndRange: 10, last: 0,

    async init() {
      try {
        const [ap, cfg, idx] = await Promise.all(['data/airports.json', 'data/events-config.json', 'data/flights/index.json']
          .map(u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); })));
        const smp = await fetch('data/samples/index.json').then(r => r.ok ? r.json() : { flights: [] }).catch(() => ({ flights: [] }));
        this.airportsRaw = ap; this.airports = FDM.prepareAirports(ap); this.cfg = cfg;
        this.index = idx.flights.map(f => Object.assign({ group: 'scenario', profile: 'A320', path: 'data/flights/' + f.file }, f))
          .concat(smp.flights.map(f => Object.assign({}, f, { group: 'sample', path: 'data/samples/' + f.normalized_file, raw: 'data/samples/' + f.file })));
        if (window.Backend && Backend.server) this.index = await Backend.flightIndex();
        this.setVfe(FDM.resolveConfig(cfg));
      } catch (e) { this.fatal('Could not load data files: ' + e.message + ' (serve the folder over http, e.g. "python -m http.server")'); return; }

      try {
        Scene.init('cesium', { imagery: store.get('fdm.imagery') || 'osm', ionToken: store.get('fdm.ion') || '' });
        Scene.drawAirports(this.airports);
      } catch (e) { $('#cesium').innerHTML = `<div class="err">3D view unavailable: ${e.message}</div>`; this.noScene = true; }

      $('#imagery').value = store.get('fdm.imagery') || 'osm';
      $('#iontoken').value = store.get('fdm.ion') || '';
      this.fillFlightSel();
      this.wire();
      const want = decodeURIComponent(location.hash.slice(1));
      if (!this.index.length) { $('#status').textContent = 'No flights yet · ยังไม่มีเที่ยวบิน — use Import'; }
      else await this.selectFlight(this.index.find(f => f.id === want) ? want : this.index[0].id);
      if (want === 'import') ImportUI.open();
      requestAnimationFrame(ts => this.loop(ts));
    },

    setVfe(cfg) { this.fcfg = cfg; this.vfe = {}; for (const [k, v] of Object.entries(cfg.vfe_kt)) this.vfe[+k] = v; },

    fillFlightSel() {
      const sel = $('#flightSel'); sel.innerHTML = '';
      const groups = { scenario: 'A320 scenarios (synthetic) · ฉากจำลอง', sample: 'Imported raw files (synthetic G1000 / decoder) · ไฟล์ดิบตัวอย่าง', server: 'FDAP server flights · เที่ยวบินบนเซิร์ฟเวอร์' };
      for (const [g, label] of Object.entries(groups)) {
        const fs = this.index.filter(f => f.group === g); if (!fs.length) continue;
        const og = document.createElement('optgroup'); og.label = label;
        for (const f of fs) { const o = document.createElement('option'); o.value = f.id; o.textContent = `${f.id.split('_')[0]} · ${f.title_th || f.title || f.id}`; og.appendChild(o); }
        sel.appendChild(og);
      }
    },

    fatal(msg) { $('#status').textContent = msg; $('#status').className = 'status err'; },

    wire() {
      $('#flightSel').addEventListener('change', e => this.selectFlight(e.target.value));
      $('#play').addEventListener('click', () => this.togglePlay());
      $('#speed').addEventListener('change', e => { this.speed = +e.target.value; });
      $('#slider').addEventListener('input', e => this.seek(this.t0 + (+e.target.value / 1000) * (this.t1 - this.t0)));
      $('#back').addEventListener('click', () => this.seek(this.t - 10));
      $('#fwd').addEventListener('click', () => this.seek(this.t + 10));
      document.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => {
        document.querySelectorAll('[data-cam]').forEach(x => x.classList.toggle('on', x === b));
        if (!this.noScene) Scene.setCamera(b.dataset.cam);
      }));
      document.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => {
        document.querySelectorAll('[data-range]').forEach(x => x.classList.toggle('on', x === b));
        this.ndRange = +b.dataset.range; this.render(true);
      }));
      $('#imagery').addEventListener('change', e => { store.set('fdm.imagery', e.target.value); if (!this.noScene) Scene.setImagery(e.target.value); });
      $('#saveToken').addEventListener('click', () => { store.set('fdm.ion', $('#iontoken').value.trim()); location.reload(); });
      $('#importBtn').addEventListener('click', () => ImportUI.open());
      $('#expEvents').addEventListener('click', () => Exporter.eventsCSV(this.flight, this.events));
      $('#expData').addEventListener('click', () => Exporter.dataCSV(this.flight, this.rows, this.t0, this.t1));
      $('#expSeg').addEventListener('click', () => Exporter.dataCSV(this.flight, this.rows, this.t - 60, this.t + 60, `_t${Math.round(this.t)}`));
      $('#expPdf').addEventListener('click', () => this.pdf());
      window.addEventListener('resize', () => { Charts.resize($('#charts')); this.render(true); });
      document.addEventListener('keydown', e => {
        if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
        if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
        else if (e.code === 'ArrowRight') this.seek(this.t + (e.shiftKey ? 30 : 5));
        else if (e.code === 'ArrowLeft') this.seek(this.t - (e.shiftKey ? 30 : 5));
      });
      const drop = $('#dropzone');
      ['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (!document.querySelector('dialog[open]')) drop.classList.add('show'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('show'); }));
      drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) ImportUI.open(f); });
    },

    async selectFlight(id) {
      const meta = this.index.find(f => f.id === id);
      $('#flightSel').value = id;
      $('#status').textContent = 'Loading ' + meta.file + ' ...'; $('#status').className = 'status';
      const text = (window.Backend && Backend.server) ? await Backend.flightCSV(meta) : await fetch(meta.path).then(r => r.text());
      const rows = this.parseCSV(text);
      if (meta.qc_file && !meta.qc) meta.qc = await fetch('data/samples/' + meta.qc_file).then(r => r.json()).catch(() => null);
      history.replaceState(null, '', '#' + id);
      this.loadFlight(meta, rows);
    },

    parseCSV(text) {
      const res = Papa.parse(text, { header: true, dynamicTyping: f => f !== 'utc' && f !== 'phase', skipEmptyLines: true });
      return res.data.map(r => {
        const o = {};
        for (const [k, v] of Object.entries(r)) {
          const key = k.trim();
          if (key === 'utc' || key === 'phase') o[key] = v == null ? '' : String(v);
          else o[key] = (typeof v === 'number') ? v : (v === null || v === '' ? NaN : (Number.isFinite(+v) ? +v : NaN));
        }
        return o;
      });
    },

    loadImported(meta, rows) {
      $('#flightSel').value = '';
      history.replaceState(null, '', location.pathname);
      this.loadFlight(meta, rows);
    },

    loadFlight(meta, rows) {
      this.flight = meta; this.rows = rows;
      this.t0 = rows[0].time_s; this.t1 = rows[rows.length - 1].time_s; this.t = this.t0;
      this.setVfe(FDM.resolveConfig(this.cfg, meta.profile));
      this.events = FDM.detectEvents(rows, this.fcfg, this.airports, meta.vapp_kt);
      this.measures = FDM.measurements(rows, this.fcfg, this.airports, meta.vapp_kt);
      this.summary = FDM.flightSummary(rows, this.airports);
      // reference airport for the altitude-tape ground band and terrain offset
      const r0 = rows[Math.floor(rows.length / 2)];
      let best = null;
      for (const ap of Object.values(this.airports)) {
        const [x, y] = new FDM.Frame(ap.lat, ap.lon).toXY(r0.lat, r0.lon); const d = Math.hypot(x, y);
        if (!best || d < best.d) best = { ap, d };
      }
      this.refAirport = (meta.airport && this.airports[meta.airport]) ? this.airports[meta.airport] : best.ap;
      if (!this.noScene) { Scene.loadFlight(rows, this.events, this.refAirport ? this.refAirport.geoid_undulation_m : 0); }
      Charts.onSeek = t => this.seek(t);
      Charts.build($('#charts'), rows, this.events, this.vfe);
      this.renderInfo(); this.renderEvents(); this.renderTicks();
      $('#status').textContent = `${rows.length} records · ${fmtT(this.t1 - this.t0)} · ${this.events.length} events`;
      $('#status').className = 'status';
      // start 20 s before the first significant event, else at the start
      const firstEv = this.events.find(e => e.level >= 2);
      this.seek(firstEv ? Math.max(this.t0, firstEv.t_peak - 40) : this.t0);
      if (!this.noScene) Scene.setCamera(document.querySelector('[data-cam].on').dataset.cam);
    },

    renderInfo() {
      const f = this.flight, s = this.summary;
      const rows = [
        ['Scenario', `<b>${esc(f.title || f.id)}</b><br><span class="th">${esc(f.title_th || '')}</span>`],
        ['Aircraft', `${esc(f.aircraft || '-')} ${esc(f.registration || '')} ${esc(f.callsign || '')}`],
        ['Take-off', s.takeoffs.map(x => `${x.rwy} @ ${fmtT(x.t)}`).join('<br>') || '-'],
        ['Landing', s.landings.map(x => `${x.rwy} @ ${fmtT(x.t)} · TD ${x.along_m ?? '?'} m past THR`).join('<br>') || '-'],
        ['Max', `${s.max_alt_ft.toFixed(0)} ft · ${s.max_ias_kt.toFixed(0)} kt · ${s.max_nz_g.toFixed(2)} g`],
        ['Event set', `${esc(this.fcfg.profile)} <span class="th">${esc((this.fcfg.profiles[this.fcfg.profile] || {}).label_th || '')}</span>`],
      ];
      if (f.qc) rows.push(['Data quality', `<span class="qcb ${f.qc.verdict}">${f.qc.score}/100</span> ${esc({ usable: 'usable · ใช้ได้', limited: 'limited · มีข้อจำกัด', reject: 'review · ต้องตรวจ' }[f.qc.verdict])}
        <details class="qcd"><summary>checks</summary><ul>${f.qc.checks.filter(c => c.sev !== 'ok').map(c => `<li class="${c.sev}">${esc(c.en)}</li>`).join('')}</ul></details>`]);
      const L = this.measures.landings, T = this.measures.takeoffs, G = this.fcfg.gates_ft;
      const mv = (v, u = '') => v == null ? '—' : `${v}${u}`;
      const meas = (L.length || T.length) ? `<h2>Routine measurements <span class="th">ค่าวัดทุกเที่ยวบิน (Doc 10000 §2.3.1)</span></h2>
        <div class="tablewrap"><table class="meas"><thead><tr><th></th>${L.map((m, i) => `<th>LDG ${i + 1}<br><span class="th">${esc(m.rwy || '?')}</span></th>`).join('')}</tr></thead><tbody>
        ${L.length ? [['TD g', m => mv(m.td_nz_g)], ['TD V/S', m => mv(m.td_vs_fpm, ' fpm')], ['TD distance', m => mv(m.td_dist_m, ' m')],
          ...G.map(g => [`IAS−Vapp @${g}`, m => mv(m['ias_dev_' + g], ' kt')]), ...G.slice(0, 2).map(g => [`V/S @${g}`, m => mv(m['vs_' + g], ' fpm')]),
          ['Max ROD final', m => mv(m.max_rod_final_fpm, ' fpm')], ['TD pitch', m => mv(m.td_pitch_deg, '°')], ['TD max bank', m => mv(m.td_roll_max_deg, '°')]]
          .map(([k, fn]) => `<tr><th>${k}</th>${L.map(m => `<td>${fn(m)}</td>`).join('')}</tr>`).join('') : ''}
        </tbody></table></div>${T.length ? `<p class="small">Take-off: ${T.map(t => `${esc(t.rwy || '?')} pitch ${mv(t.lo_pitch_deg, '°')} · max rate ${mv(t.max_pitch_rate, '°/s')} · IAS ${mv(t.lo_ias_kt, ' kt')}`).join('<br>')}</p>` : ''}` : '';
      $('#info').innerHTML = `<p class="desc">${esc(f.description_th || '')}</p>` +
        '<table>' + rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('') + '</table>' +
        meas + (f.local || f.group === 'server' ? '' : f.group === 'sample'
          ? `<p class="small"><a href="${esc(f.raw)}" download>raw file (${esc(f.format)})</a> · <a href="${esc(f.path)}" download>normalised CSV</a> · <a href="#" id="tryImport">open the raw file in the import wizard</a></p>`
          : `<p class="small"><a href="reports/${encodeURIComponent(f.id)}_report.pdf" target="_blank" rel="noopener">Pre-generated PDF report (Python)</a> · <a href="${esc(f.path)}" download>raw CSV</a></p>`);
      const ti = $('#tryImport'); if (ti) ti.addEventListener('click', async e => { e.preventDefault(); await ImportUI.open(); ImportUI.loadSample(f); });
    },

    renderEvents() {
      const tb = $('#events tbody');
      if (!this.events.length) { tb.innerHTML = '<tr><td colspan="4" class="none">No events detected · ไม่พบ event</td></tr>'; return; }
      tb.innerHTML = this.events.map((e, i) => `<tr data-i="${i}" class="lv${e.level}">
        <td><span class="badge lv${e.level}">${LEVEL_TXT[e.level]}</span></td>
        <td>${fmtT(e.t_peak)}</td>
        <td><b>${esc(e.name)}</b><br><span class="th">${esc(e.th)}</span>${e.detail ? `<br><span class="det">${esc(e.detail)}</span>` : ''}</td>
        <td class="num">${e.value == null ? '' : esc(String(e.value))}<br><span class="det">${esc(e.unit)}</span></td></tr>`).join('');
      tb.querySelectorAll('tr').forEach(tr => tr.addEventListener('click', () => {
        const e = this.events[+tr.dataset.i]; this.seek(Math.max(this.t0, e.t_peak - 12)); this.playing = true; this.updatePlayBtn();
      }));
    },

    renderTicks() {
      const box = $('#ticks'); box.innerHTML = '';
      for (const e of this.events) {
        const d = document.createElement('div'); d.className = 'tick lv' + e.level;
        d.style.left = ((e.t_peak - this.t0) / (this.t1 - this.t0) * 100) + '%'; d.title = `${fmtT(e.t_peak)} ${e.name}`;
        box.appendChild(d);
      }
    },

    togglePlay() { if (this.t >= this.t1) this.t = this.t0; this.playing = !this.playing; this.updatePlayBtn(); },
    updatePlayBtn() { $('#play').textContent = this.playing ? '❚❚' : '▶'; $('#play').setAttribute('aria-label', this.playing ? 'Pause' : 'Play'); },
    seek(t) { this.t = Math.max(this.t0, Math.min(this.t1, t)); this.render(true); },

    loop(ts) {
      const dt = this.last ? Math.min(0.1, (ts - this.last) / 1000) : 0; this.last = ts;
      if (this.playing && this.rows) {
        this.t += dt * this.speed;
        if (this.t >= this.t1) { this.t = this.t1; this.playing = false; this.updatePlayBtn(); }
        this.render(false);
      }
      requestAnimationFrame(x => this.loop(x));
    },

    index_(t) { // last row with time <= t
      const R = this.rows; let lo = 0, hi = R.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (R[m].time_s <= t) lo = m; else hi = m - 1; }
      return lo;
    },

    rowAt(t) {
      const i = this.index_(t), a = this.rows[i], b = this.rows[Math.min(i + 1, this.rows.length - 1)];
      const span = b.time_s - a.time_s, f = span > 0 ? (t - a.time_s) / span : 0;
      const o = {};
      for (const k in a) {
        const va = a[k], vb = b[k];
        if (STEP_KEYS.has(k) || typeof va !== 'number' || typeof vb !== 'number' || Number.isNaN(va) || Number.isNaN(vb)) o[k] = va;
        else if (ANGLE_KEYS.has(k)) o[k] = (va + FDM.angdiff(vb, va) * f + 360) % 360;
        else o[k] = va + (vb - va) * f;
      }
      o.time_s = t;
      return { r: o, i };
    },

    render(force) {
      if (!this.rows) return;
      const { r, i } = this.rowAt(this.t);
      this.cur = r;
      const j = this.index_(this.t + 10);
      const iasTrend = this.rows[j].ias_kt - r.ias_kt;
      const groundFt = this.refAirport ? Math.min(...Object.values(this.refAirport.runways).map(x => x.thr_elev_ft)) : 0;
      Instruments.drawPFD($('#pfd'), r, { vfe: this.vfe, vapp: this.flight.vapp_kt, iasTrend, groundFt });
      let near = null;
      for (const ap of Object.values(this.airports)) {
        const [x, y] = new FDM.Frame(r.lat, r.lon).toXY(ap.lat, ap.lon); const d = Math.hypot(x, y) / 1852;
        if (!near || d < near.d) near = { ap, d };
      }
      Instruments.drawND($('#nd'), r, { rangeNm: this.ndRange, airports: this.airports, path: this.rows, idx: i,
        nearest: near ? `${near.ap.icao} ${near.d.toFixed(1)} NM` : '' });
      if (!this.noScene) Scene.update(r, i);
      Charts.setTime(this.t);
      $('#slider').value = Math.round((this.t - this.t0) / (this.t1 - this.t0) * 1000);
      $('#clock').textContent = `${fmtT(this.t - this.t0)} / ${fmtT(this.t1 - this.t0)}`;
      $('#utc').textContent = r.utc ? r.utc.replace('T', ' ').slice(0, 19) + 'Z' : '';
      this.renderReadout(r);
      const active = this.events.filter(e => this.t >= e.t_start - 1 && this.t <= e.t_end + 1);
      $('#active').innerHTML = active.map(e => `<span class="badge lv${e.level}">${esc(e.code.replace(/_/g, ' '))}</span>`).join(' ');
    },

    renderReadout(r) {
      const f = (v, d = 0) => (typeof v === 'number' && !Number.isNaN(v)) ? v.toFixed(d) : '—';
      const items = [
        ['Phase', r.phase || '—'], ['ALT', f(r.alt_ft) + ' ft'], ['RA', f(r.ra_ft) + ' ft'], ['IAS', f(r.ias_kt) + ' kt'],
        ['GS', f(r.gs_kt) + ' kt'], ['V/S', f(r.vs_fpm) + ' fpm'], ['Pitch', f(r.pitch_deg, 1) + '°'], ['Roll', f(r.roll_deg, 1) + '°'],
        ['HDG', f(r.hdg_true_deg) + '°T'], ['AoA', f(r.aoa_deg, 1) + '°'], ['Nz', f(r.nz_g, 2) + ' g'], ['N1', f(r.n1_1, 1) + ' %'],
        ['Flap', r.flap >= 4 ? 'FULL' : f(r.flap)], ['Gear', r.gear >= 0.5 ? 'DOWN' : 'UP'], ['LOC', f(r.loc_dev_dot, 2)], ['G/S', f(r.gs_dev_dot, 2)],
        ['Wind', `${f(r.wind_dir_deg)}°/${f(r.wind_spd_kt)}`], ['Lat/Lon', `${f(r.lat, 4)}, ${f(r.lon, 4)}`],
      ];
      $('#readout').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    },

    async pdf() {
      const btn = $('#expPdf'); btn.disabled = true; btn.textContent = 'Building PDF…';
      try {
        this.render(true);
        await new Promise(res => setTimeout(res, 60));
        const snaps = { scene: this.noScene ? null : Scene.snapshot(), pfd: $('#pfd').toDataURL('image/png'), nd: $('#nd').toDataURL('image/png') };
        Exporter.pdfReport({ flight: this.flight, rows: this.rows, events: this.events, summary: this.summary,
          snaps, snapRow: this.cur, charts: Charts.canvases() });
      } catch (e) { this.fatal('PDF export failed: ' + e.message); }
      btn.disabled = false; btn.textContent = 'PDF report';
    },
  };

  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  window.App = App;
  window.addEventListener('DOMContentLoaded', async () => {
    if (window.Backend) { await Backend.init(); if (Backend.server && !Backend.can('replay')) { location.replace('fleet.html'); return; } }
    App.init();
  });
})();
