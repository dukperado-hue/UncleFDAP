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
        this.airportsRaw = ap; this.airports = FDM.prepareAirports(ap); this.cfg = cfg; this.index = idx.flights;
        this.vfe = {}; for (const [k, v] of Object.entries(cfg.vfe_kt)) this.vfe[+k] = v;
      } catch (e) { this.fatal('Could not load data files: ' + e.message + ' (serve the folder over http, e.g. "python -m http.server")'); return; }

      try {
        Scene.init('cesium', { imagery: store.get('fdm.imagery') || 'osm', ionToken: store.get('fdm.ion') || '' });
        Scene.drawAirports(this.airports);
      } catch (e) { $('#cesium').innerHTML = `<div class="err">3D view unavailable: ${e.message}</div>`; this.noScene = true; }

      $('#imagery').value = store.get('fdm.imagery') || 'osm';
      $('#iontoken').value = store.get('fdm.ion') || '';
      const sel = $('#flightSel');
      for (const f of this.index) {
        const o = document.createElement('option'); o.value = f.id; o.textContent = `${f.id.slice(0, 3)} · ${f.title_th}`; sel.appendChild(o);
      }
      this.wire();
      const want = decodeURIComponent(location.hash.slice(1));
      await this.selectFlight(this.index.find(f => f.id === want) ? want : this.index[0].id);
      requestAnimationFrame(ts => this.loop(ts));
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
      $('#csvFile').addEventListener('change', e => { if (e.target.files[0]) this.loadUserCSV(e.target.files[0]); e.target.value = ''; });
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
      ['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('show'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('show'); }));
      drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) this.loadUserCSV(f); });
    },

    async selectFlight(id) {
      const meta = this.index.find(f => f.id === id);
      $('#flightSel').value = id;
      $('#status').textContent = 'Loading ' + meta.file + ' ...'; $('#status').className = 'status';
      const text = await fetch('data/flights/' + meta.file).then(r => r.text());
      const rows = this.parseCSV(text);
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

    loadUserCSV(file) {
      const reader = new FileReader();
      reader.onload = () => {
        const rows = this.parseCSV(reader.result);
        const missing = REQUIRED.filter(k => !(rows.length && k in rows[0]));
        if (missing.length) { this.fatal(`CSV is missing required columns: ${missing.join(', ')} (see README)`); return; }
        for (const r of rows) {
          if (!('air_ground' in r) || Number.isNaN(r.air_ground)) r.air_ground = (Number.isFinite(r.ra_ft) ? r.ra_ft > 1 : r.ias_kt > 60) ? 1 : 0;
          for (const k of ['ra_ft', 'vs_fpm', 'nz_g', 'gs_kt', 'tas_kt', 'flap', 'gear', 'trk_true_deg']) if (!(k in r)) r[k] = NaN;
          if (Number.isNaN(r.nz_g)) r.nz_g = 1;
          if (Number.isNaN(r.vs_fpm)) r.vs_fpm = 0;
          if (Number.isNaN(r.trk_true_deg)) r.trk_true_deg = r.hdg_true_deg;
          if (Number.isNaN(r.gs_kt)) r.gs_kt = r.ias_kt;
        }
        const meta = { id: file.name.replace(/\.csv$/i, ''), title: file.name, title_th: 'ไฟล์ที่อัปโหลด (ประมวลผลในเครื่องเท่านั้น)',
          vapp_kt: this.cfg.vapp_default_kt, description_th: 'ข้อมูลจากไฟล์ในเครื่อง ไม่ได้ส่งออกไปที่ใด', local: true };
        $('#flightSel').value = '';
        history.replaceState(null, '', location.pathname);
        this.loadFlight(meta, rows);
      };
      reader.readAsText(file);
    },

    loadFlight(meta, rows) {
      this.flight = meta; this.rows = rows;
      this.t0 = rows[0].time_s; this.t1 = rows[rows.length - 1].time_s; this.t = this.t0;
      this.events = FDM.detectEvents(rows, this.cfg, this.airports, meta.vapp_kt);
      this.summary = FDM.flightSummary(rows, this.airports);
      // reference airport for the altitude-tape ground band and terrain offset
      const r0 = rows[Math.floor(rows.length / 2)];
      let best = null;
      for (const ap of Object.values(this.airports)) {
        const [x, y] = new FDM.Frame(ap.lat, ap.lon).toXY(r0.lat, r0.lon); const d = Math.hypot(x, y);
        if (!best || d < best.d) best = { ap, d };
      }
      this.refAirport = meta.airport ? this.airports[meta.airport] : best.ap;
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
      ];
      $('#info').innerHTML = `<p class="desc">${esc(f.description_th || '')}</p>` +
        '<table>' + rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('') + '</table>' +
        (f.local ? '' : `<p class="small"><a href="reports/${encodeURIComponent(f.id)}_report.pdf" target="_blank" rel="noopener">Pre-generated PDF report (Python)</a> · <a href="data/flights/${encodeURIComponent(f.file)}" download>raw CSV</a></p>`);
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
  window.addEventListener('DOMContentLoaded', () => App.init());
})();
