// Import wizard UI (dialog): file -> mapping -> data quality -> open / download / save.
// Core logic lives in js/importer.js; this file only builds the dialog and wires events.
(function () {
  'use strict';
  const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const TPL_KEY = 'fdap.importTemplates.v1';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const SEV = { ok: ['✓', 'ok'], info: ['i', 'info'], warn: ['!', 'warn'], fail: ['✕', 'fail'] };
  const VERDICT = { usable: ['Usable', 'ใช้ได้'], limited: ['Usable with limitations', 'ใช้ได้แต่มีข้อจำกัด'], reject: ['Review before use', 'ต้องตรวจก่อนใช้'] };

  const UI = {
    st: null,

    async ensure() {
      if (this.dlg) return;
      const [tpl, samples] = await Promise.all([
        fetch('data/import-templates.json').then(r => r.json()),
        fetch('data/samples/index.json').then(r => r.ok ? r.json() : { flights: [] }).catch(() => ({ flights: [] })),
      ]);
      this.builtin = tpl.templates; this.samples = samples.flights;
      const d = document.createElement('dialog'); d.id = 'imp'; d.className = 'imp';
      d.innerHTML = `
        <form method="dialog" class="imp-head">
          <h2>Import flight data <span class="th">นำเข้าข้อมูลการบิน (CSV / Excel)</span></h2>
          <button class="btn icon" value="close" aria-label="Close">✕</button>
        </form>
        <nav class="imp-tabs" role="tablist">
          <button type="button" data-tab="file" class="on">1 · File <span class="th">ไฟล์</span></button>
          <button type="button" data-tab="map" disabled>2 · Mapping <span class="th">จับคู่คอลัมน์</span></button>
          <button type="button" data-tab="qc" disabled>3 · Data quality <span class="th">คุณภาพข้อมูล</span></button>
        </nav>
        <section class="imp-body" data-pane="file">
          <label class="imp-drop" id="impDrop">
            <input type="file" id="impFile" accept=".csv,.txt,.tsv,.xlsx,.xls,text/csv" hidden>
            <b>Choose or drop a CSV / Excel file</b>
            <span class="th">เลือกหรือลากไฟล์มาวาง · ประมวลผลในเบราว์เซอร์นี้เท่านั้น ไม่มีการอัปโหลด</span>
          </label>
          <div id="impSamples"></div>
          <div id="impFileInfo"></div>
        </section>
        <section class="imp-body" data-pane="map" hidden>
          <div class="imp-row">
            <label>Template <select id="impTpl"></select></label>
            <label>Aircraft profile <select id="impProfile"></select></label>
            <label>Vapp (kt) <input id="impVapp" type="number" min="40" max="200" step="1"></label>
            <label class="chk"><input type="checkbox" id="impDespike" checked> repair single-sample spikes</label>
          </div>
          <fieldset class="imp-time"><legend>Time <span class="th">เวลา</span></legend><div id="impTime"></div></fieldset>
          <div class="tablewrap imp-map"><table id="impMap"><thead><tr><th>Parameter</th><th>Source column</th><th>Unit</th><th>Sample</th></tr></thead><tbody></tbody></table></div>
          <div class="imp-row">
            <button type="button" class="btn" id="impSaveTpl">Save as template</button>
            <button type="button" class="btn" id="impDlTpl">Download template JSON</button>
            <label class="btn file">Load template JSON<input type="file" id="impLoadTpl" accept=".json" hidden></label>
          </div>
        </section>
        <section class="imp-body" data-pane="qc" hidden><div id="impQC"></div></section>
        <footer class="imp-foot">
          <span id="impMsg" class="small"></span>
          <span class="imp-actions">
            <button type="button" class="btn" id="impNext" disabled>Next ›</button>
            <button type="button" class="btn" id="impCsv" disabled>Normalised CSV</button>
            <button type="button" class="btn" id="impQcJson" disabled>QC report</button>
            <button type="button" class="btn" id="impSave" hidden disabled>Save to FDAP server</button>
            <button type="button" class="btn primary" id="impOpen" disabled>Open in replay</button>
          </span>
        </footer>`;
      document.body.appendChild(d); this.dlg = d;
      const $ = s => d.querySelector(s);
      d.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => this.tab(b.dataset.tab)));
      $('#impFile').addEventListener('change', e => { if (e.target.files[0]) this.loadFile(e.target.files[0]); e.target.value = ''; });
      const drop = $('#impDrop');
      drop.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) this.loadFile(e.dataTransfer.files[0]); });
      $('#impTpl').addEventListener('change', e => this.applyTemplate(e.target.value));
      $('#impProfile').addEventListener('change', e => { this.st.mapping.profile = e.target.value; this.setVappDefault(); this.recompute(); });
      $('#impVapp').addEventListener('change', () => this.recompute());
      $('#impDespike').addEventListener('change', () => this.recompute());
      $('#impNext').addEventListener('click', () => this.tab(this.cur === 'file' ? 'map' : 'qc'));
      $('#impOpen').addEventListener('click', () => this.finish());
      $('#impCsv').addEventListener('click', () => this.download(this.baseName() + '.normalized.csv', Importer.toCSV(this.res.rows), 'text/csv'));
      $('#impQcJson').addEventListener('click', () => this.download(this.baseName() + '.qc.json', JSON.stringify(this.res.qc, null, 1), 'application/json'));
      $('#impSave').addEventListener('click', () => this.saveServer());
      $('#impSaveTpl').addEventListener('click', () => this.saveTemplate());
      $('#impDlTpl').addEventListener('click', () => this.download((this.st.mapping.template || 'template') + '.json', JSON.stringify(this.templateFromMapping('my-template'), null, 1), 'application/json'));
      $('#impLoadTpl').addEventListener('change', e => this.loadTemplateFile(e.target.files[0]));
      const sel = $('#impProfile');
      for (const [id, p] of Object.entries(App.cfg.profiles || {})) sel.insertAdjacentHTML('beforeend', `<option value="${esc(id)}">${esc(id)} — ${esc(p.label)}</option>`);
      $('#impSamples').innerHTML = this.samples.length ? '<p class="small">Synthetic sample files to try · ไฟล์ตัวอย่าง (ข้อมูลจำลอง):</p><div class="imp-sample-list">' +
        this.samples.map((s, i) => `<button type="button" class="btn" data-sample="${i}">${esc(s.format.split(' ')[0])} · ${esc(s.id.split('_').slice(0, 1))} <span class="th">${esc(s.title_th)}</span></button>` +
          (s.xlsx ? `<button type="button" class="btn" data-sample="${i}" data-xlsx="1">Excel · ${esc(s.id.split('_')[0])} <span class="th">.xlsx</span></button>` : '')).join('') + '</div>' : '';
      d.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => this.loadSample(this.samples[+b.dataset.sample], !!b.dataset.xlsx)));
      if (window.Backend && Backend.server && Backend.can('upload')) $('#impSave').hidden = false;
      if (window.Backend && Backend.server) d.querySelector('.imp-drop .th').textContent = 'ประมวลผลในเบราว์เซอร์ จะส่งขึ้นเซิร์ฟเวอร์ FDAP ขององค์กรเมื่อกด "Save to FDAP server" เท่านั้น';
    },

    async open(file) {
      await this.ensure();
      if (!this.dlg.open) this.dlg.showModal();
      if (file) this.loadFile(file);
    },

    tab(name) {
      this.cur = name;
      this.dlg.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
      this.dlg.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== name; });
      const next = this.dlg.querySelector('#impNext');
      next.hidden = name === 'qc'; next.disabled = !this.st;
    },
    msg(t, err) { const m = this.dlg.querySelector('#impMsg'); m.textContent = t; m.classList.toggle('err', !!err); },

    async loadSample(s, xlsx) {
      const name = xlsx ? s.xlsx : s.file;
      const r = await fetch('data/samples/' + encodeURIComponent(name));
      const blob = await r.blob();
      this.loadFile(new File([blob], name), s);
    },

    async loadFile(file, sample) {
      this.msg('Reading ' + file.name + ' …');
      try {
        let sheets, delim = null;
        if (/\.xlsx?$/i.test(file.name)) {
          await loadScript(XLSX_URL);
          sheets = Importer.readWorkbook(new Uint8Array(await file.arrayBuffer()));
        } else {
          const p = Importer.parseDelimited(await file.text());
          sheets = [{ name: file.name, rows: p.rows }]; delim = p.delim;
        }
        const usable = sheets.map(s => { try { return Object.assign(s, { layout: Importer.detectLayout(s.rows) }); } catch (e) { return null; } }).filter(Boolean);
        if (!usable.length) throw new Error('no sheet with a header row of column names was found');
        usable.sort((a, b) => b.layout.nData - a.layout.nData);
        this.st = { file, sample, sheets: usable, sheet: usable[0], delim };
        this.setupSheet();
      } catch (e) { this.msg('Cannot read file: ' + e.message, true); console.error(e); }
    },

    setupSheet() {
      const st = this.st, L = st.sheet.layout;
      const all = this.allTemplates();
      const tpl = Importer.matchTemplate(all, L.columns);
      st.mapping = Importer.autoMapping(L.columns, tpl);
      if (!st.mapping.profile) st.mapping.profile = App.cfg.default_profile;
      const $ = s => this.dlg.querySelector(s);
      const meta = Object.entries(L.meta).slice(0, 6).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(' · ');
      $('#impFileInfo').innerHTML = `<table class="kv">
        <tr><th>File</th><td><b>${esc(st.file.name)}</b> ${st.sample ? '<span class="synthetic">SYNTHETIC SAMPLE</span>' : ''}</td></tr>
        <tr><th>Format</th><td>${st.delim ? `delimited text, separator “${st.delim === '\t' ? 'TAB' : esc(st.delim)}”` : 'Excel workbook'}
          ${st.sheets.length > 1 || !st.delim ? `· sheet <select id="impSheet">${st.sheets.map((s, i) => `<option value="${i}" ${s === st.sheet ? 'selected' : ''}>${esc(s.name)} (${s.layout.nData} rows)</option>`).join('')}</select>` : ''}</td></tr>
        <tr><th>Layout</th><td>header row ${L.header + 1}${L.units >= 0 ? `, units row ${L.units + 1}` : ', no units row'} · ${L.columns.length} columns · ${L.nData} data rows</td></tr>
        ${meta ? `<tr><th>Metadata</th><td class="mono">${meta}</td></tr>` : ''}
        <tr><th>Detected</th><td>${tpl ? `template <b>${esc(tpl.name)}</b>` : 'no known template — columns guessed from their names, please check the mapping'}</td></tr>
      </table>`;
      const sh = $('#impSheet'); if (sh) sh.addEventListener('change', e => { st.sheet = st.sheets[+e.target.value]; this.setupSheet(); });
      $('#impTpl').innerHTML = '<option value="">(none — guess from names)</option>' + all.map(t => `<option value="${esc(t.id)}">${esc(t.name)}${t.user ? ' (saved)' : ''}</option>`).join('');
      $('#impTpl').value = tpl ? tpl.id : '';
      $('#impProfile').value = st.mapping.profile;
      this.setVappDefault(st.sample && st.sample.vapp_kt);
      this.dlg.querySelectorAll('[data-tab]').forEach(b => { b.disabled = false; });
      this.renderMapping(); this.recompute();
      this.tab('file');
    },

    setVappDefault(v) {
      const cfg = FDM.resolveConfig(App.cfg, this.st.mapping.profile);
      this.dlg.querySelector('#impVapp').value = v || cfg.vapp_default_kt;
    },

    allTemplates() { return this.builtin.concat((store.get(TPL_KEY) || []).map(t => Object.assign({ user: true }, t))); },

    applyTemplate(id) {
      const st = this.st; const t = this.allTemplates().find(x => x.id === id) || null;
      st.mapping = Importer.autoMapping(st.sheet.layout.columns, t);
      if (!st.mapping.profile) st.mapping.profile = this.dlg.querySelector('#impProfile').value;
      this.dlg.querySelector('#impProfile').value = st.mapping.profile;
      this.setVappDefault(); this.renderMapping(); this.recompute();
    },

    renderMapping() {
      const st = this.st, L = st.sheet.layout, M = st.mapping;
      const rows = st.sheet.rows.slice(L.dataStart, L.dataStart + 400);
      const sample = name => { const c = L.columns.find(x => x.name === name); if (!c) return ''; const v = []; for (const r of rows) { const x = String(r[c.idx] ?? '').trim(); if (x !== '' && !v.includes(x)) v.push(x); if (v.length >= 3) break; } return v.join(' · '); };
      const colOpts = sel => '<option value="">—</option>' + L.columns.map(c => `<option value="${esc(c.name)}" ${c.name === sel ? 'selected' : ''}>${esc(c.name)}${c.unit ? ' [' + esc(c.unit) + ']' : ''}</option>`).join('');
      // time block
      const T = M.time;
      const tsel = (k, label) => `<label>${label} <select data-time="${k}">${colOpts(T[k])}</select></label>`;
      this.dlg.querySelector('#impTime').innerHTML = `<div class="imp-row">
        <label>Mode <select data-time="mode">${[['seconds', 'elapsed seconds column'], ['datetime', 'date + time columns'], ['timeofday', 'time of day only'], ['index', 'row number × rate']]
          .map(([v, l]) => `<option value="${v}" ${T.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${T.mode === 'seconds' ? tsel('col', 'Seconds') + `<label>Unit <select data-time="unit"><option ${T.unit !== 'ms' ? 'selected' : ''}>s</option><option ${T.unit === 'ms' ? 'selected' : ''}>ms</option></select></label>` : ''}
        ${T.mode === 'datetime' ? tsel('date', 'Date (or date-time)') + tsel('time', 'Time') + tsel('offset', 'UTC offset column') + `<label>or fixed offset <input data-time="offsetValue" value="${esc(T.offsetValue || '')}" placeholder="+07:00" size="6"></label>` : ''}
        ${T.mode === 'timeofday' ? tsel('col', 'Time of day') : ''}
        ${T.mode === 'index' ? `<label>Rate (Hz) <input data-time="hz" type="number" step="0.25" min="0.0625" value="${T.hz || 1}"></label>` : ''}
      </div><p class="small">Dates like 18/11/2569 are read as day/month and Buddhist-era years are converted · วันที่ อ่านแบบ วัน/เดือน/ปี และแปลง พ.ศ. ให้อัตโนมัติ</p>`;
      this.dlg.querySelectorAll('[data-time]').forEach(el => el.addEventListener('change', () => {
        const k = el.dataset.time; T[k] = el.type === 'number' ? +el.value : el.value;
        if (k === 'mode') this.renderMapping(); this.recompute();
      }));
      // field table: required, then mapped/recommended, then the rest
      const groups = [['Required for replay · จำเป็น', Importer.FIELDS.filter(f => f.req)],
        ['Mapped / recommended · แนะนำ', Importer.FIELDS.filter(f => !f.req && (M.fields[f.key] || ['ra_ft', 'vs_fpm', 'nz_g', 'gs_kt', 'hdg_true_deg', 'hdg_mag_deg', 'flap', 'gear', 'air_ground'].includes(f.key)))],
        ['Other parameters · อื่น ๆ', Importer.FIELDS.filter(f => !f.req && !M.fields[f.key] && !['ra_ft', 'vs_fpm', 'nz_g', 'gs_kt', 'hdg_true_deg', 'hdg_mag_deg', 'flap', 'gear', 'air_ground'].includes(f.key))]];
      this.dlg.querySelector('#impMap tbody').innerHTML = groups.map(([g, fs]) => `<tr class="grp"><td colspan="4">${g}</td></tr>` + fs.map(f => {
        const m = M.fields[f.key] || {}; const units = Object.keys(Importer.UNITS[f.kind] || {});
        return `<tr class="${f.req && !m.col ? 'missing' : ''}"><td><b>${esc(f.key)}</b><br><span class="th">${esc(f.label)}</span></td>
          <td><select data-field="${f.key}">${colOpts(m.col)}</select></td>
          <td>${units.length > 1 ? `<select data-unit="${f.key}">${units.map(u => `<option ${u === m.unit ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>` : ''}</td>
          <td class="mono small">${esc(sample(m.col))}</td></tr>`;
      }).join('')).join('');
      this.dlg.querySelectorAll('[data-field]').forEach(el => el.addEventListener('change', () => {
        const k = el.dataset.field, f = Importer.FIELD[k];
        if (!el.value) delete M.fields[k];
        else { const c = L.columns.find(x => x.name === el.value); M.fields[k] = { col: el.value, unit: Importer.unitFromText(f.kind, c && c.unit) || Object.keys(Importer.UNITS[f.kind])[0] }; }
        M.template = null; this.dlg.querySelector('#impTpl').value = '';
        this.renderMapping(); this.recompute();
      }));
      this.dlg.querySelectorAll('[data-unit]').forEach(el => el.addEventListener('change', () => { M.fields[el.dataset.unit].unit = el.value; this.recompute(); }));
    },

    recompute() {
      clearTimeout(this._t);
      this._t = setTimeout(() => {
        const st = this.st; if (!st) return;
        try {
          this.res = Importer.run(st.sheet.rows, st.sheet.layout, st.mapping,
            { rawCfg: App.cfg, airports: App.airports, delim: st.delim, despike: this.dlg.querySelector('#impDespike').checked });
          this.renderQC();
          const ok = this.res.rows.length >= 10 && this.res.qc.verdict !== 'reject' || (this.res.rows.length >= 10 && !this.res.qc.checks.some(c => c.id === 'required'));
          ['#impOpen', '#impCsv', '#impQcJson', '#impSave'].forEach(s => { this.dlg.querySelector(s).disabled = !ok; });
          this.dlg.querySelector('#impNext').disabled = false;
          this.msg(`${this.res.rows.length} rows · quality ${this.res.qc.score}/100`);
        } catch (e) { this.msg('Processing failed: ' + e.message, true); console.error(e); }
      }, 120);
    },

    renderQC() {
      const q = this.res.qc, ev = this.previewEvents();
      const v = VERDICT[q.verdict];
      const pct = x => x == null ? '' : (x * 100).toFixed(x < 0.995 ? 1 : 0) + ' %';
      const num = x => Number.isFinite(x) ? (Math.abs(x) >= 1000 ? x.toFixed(0) : +x.toFixed(2)) : '';
      this.dlg.querySelector('#impQC').innerHTML = `
        <div class="qc-head"><div class="qc-score ${q.verdict}"><b>${q.score}</b><span>/100</span></div>
          <div><b>${v[0]}</b> <span class="th">${v[1]}</span><br><span class="small">${ev.length} event(s) found with the ${esc(this.res.cfg.profile)} event set · พบ ${ev.length} event</span></div></div>
        <ul class="qc-list">${q.checks.filter(c => c.sev !== 'ok' || ['rate', 'gaps', 'ops', 'datum'].includes(c.id)).map(c => `<li class="${SEV[c.sev][1]}"><i>${SEV[c.sev][0]}</i><span>${esc(c.en)}<br><span class="th">${esc(c.th)}</span></span></li>`).join('')}</ul>
        <h3>Parameters <span class="th">สถิติรายพารามิเตอร์</span></h3>
        <div class="tablewrap"><table class="qc-stats"><thead><tr><th>Parameter</th><th>Source</th><th>Coverage</th><th>Min</th><th>Max</th><th>Out of range</th><th>Frozen</th><th>Spikes</th></tr></thead><tbody>
        ${q.stats.map(s => `<tr><td><b>${esc(s.key)}</b></td><td>${esc(s.src)}${s.unit && s.src !== 'derived' ? ` <span class="th">${esc(s.unit)}</span>` : ''}</td>
          <td class="${s.coverage < 0.98 ? 'warn' : ''}">${pct(s.coverage)}</td><td class="mono">${num(s.min)}</td><td class="mono">${num(s.max)}</td>
          <td class="${s.out ? 'warn' : ''}">${s.out || ''}</td><td class="${s.frozen_s >= 10 ? 'warn' : ''}">${s.frozen_s >= 10 ? s.frozen_s.toFixed(0) + ' s' : ''}</td><td class="${s.spikes ? 'warn' : ''}">${s.spikes || ''}</td></tr>`).join('')}
        </tbody></table></div>
        ${ev.length ? `<h3>Events preview <span class="th">event ที่พบ</span></h3><div class="ev-chips">${ev.map(e => `<span class="badge lv${e.level}">${esc(e.code.replace(/_/g, ' '))}</span>`).join(' ')}</div>` : ''}`;
    },

    previewEvents() {
      try { return FDM.detectEvents(this.res.rows, this.res.cfg, App.airports, +this.dlg.querySelector('#impVapp').value); } catch (e) { return []; }
    },

    baseName() { return this.st.file.name.replace(/\.[^.]+$/, ''); },

    meta() {
      const st = this.st, s = st.sample, L = st.sheet.layout;
      return {
        id: this.baseName(), title: s ? s.title : st.file.name, title_th: s ? s.title_th : 'ไฟล์นำเข้า (ประมวลผลในเครื่องเท่านั้น)',
        description_th: s ? s.description_th : 'นำเข้าด้วยตัวช่วยนำเข้า ข้อมูลอยู่ในเบราว์เซอร์นี้เท่านั้น',
        aircraft: s ? s.aircraft : (L.meta.airframe_name || ''), registration: s ? s.registration : '', callsign: s ? s.callsign : '',
        profile: this.res.cfg.profile, vapp_kt: +this.dlg.querySelector('#impVapp').value, local: true, qc: this.res.qc,
        source_file: st.file.name, template: st.mapping.template,
      };
    },

    finish() {
      const rows = this.res.rows.map(r => Object.assign({}, r));
      this.dlg.close();
      App.loadImported(this.meta(), rows);
    },

    async saveServer() {
      const btn = this.dlg.querySelector('#impSave'); btn.disabled = true;
      try {
        const r = await Backend.upload({ meta: this.meta(), csv: Importer.toCSV(this.res.rows), qc: this.res.qc, mapping: this.st.mapping });
        this.msg(`Saved to server as ${r.key} · บันทึกขึ้นเซิร์ฟเวอร์แล้ว`);
      } catch (e) { this.msg('Upload failed: ' + e.message, true); }
      btn.disabled = false;
    },

    templateFromMapping(id) {
      const M = this.st.mapping;
      const cols = {}; for (const [k, m] of Object.entries(M.fields)) if (m && m.col) cols[k] = { src: [m.col], unit: m.unit };
      const T = Object.assign({}, M.time);
      return { id, name: id, detect: Object.values(cols).slice(0, 6).map(c => c.src[0]).concat(T.col || T.time || []).filter(Boolean).slice(0, 6),
        profile: M.profile, time: T, columns: cols };
    },
    saveTemplate() {
      const name = (prompt('Template name', this.st.mapping.template || this.baseName()) || '').trim();   // eslint-disable-line no-alert
      if (!name) return;
      const list = (store.get(TPL_KEY) || []).filter(t => t.id !== name);
      list.push(this.templateFromMapping(name)); store.set(TPL_KEY, list);
      this.setupSheet(); this.dlg.querySelector('#impTpl').value = name; this.applyTemplate(name);
      this.msg('Template saved in this browser · บันทึก template ไว้ในเบราว์เซอร์นี้');
    },
    async loadTemplateFile(f) {
      if (!f) return;
      try {
        const t = JSON.parse(await f.text()); if (!t.id || !t.columns) throw new Error('not a template file');
        const list = (store.get(TPL_KEY) || []).filter(x => x.id !== t.id); list.push(t); store.set(TPL_KEY, list);
        if (this.st) { this.setupSheet(); this.dlg.querySelector('#impTpl').value = t.id; this.applyTemplate(t.id); }
      } catch (e) { this.msg('Template not loaded: ' + e.message, true); }
    },

    download(name, text, type) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    },
  };

  function loadScript(src) {
    if (document.querySelector(`script[src="${src}"]`)) return window.XLSX ? Promise.resolve() : new Promise(r => document.querySelector(`script[src="${src}"]`).addEventListener('load', r));
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(s); });
  }

  window.ImportUI = UI;
})();
