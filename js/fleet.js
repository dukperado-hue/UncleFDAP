// Fleet & trends page: KPIs, monthly trends, event types, runway table, routine-measurement
// distributions (precursor view) and the event review workflow.
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const C = { l2: '#ffb000', l3: '#ff3b3b', l1: '#38d9f5', bar: '#38d9f5', line: '#38d9f5', grid: '#263142', axis: '#8a94a6', text: '#e6ebf2' };
  const LEVEL = { 1: 'Info', 2: 'Caution', 3: 'Warning' };
  const STATUS = {
    NEW: ['New', 'ใหม่'], VALID: ['Validated', 'ยืนยันแล้ว'], NUISANCE: ['Nuisance / false', 'แจ้งเตือนผิด'],
    CREW_REQ: ['Crew contact requested', 'ขอให้ติดต่อลูกเรือ'], CREW_DONE: ['Crew contacted', 'ติดต่อลูกเรือแล้ว'], CLOSED: ['Closed', 'ปิดเรื่อง'],
  };
  const NEXT = { NEW: ['VALID', 'NUISANCE'], VALID: ['CREW_REQ', 'CLOSED'], NUISANCE: ['CLOSED', 'VALID'], CREW_REQ: ['CREW_DONE'], CREW_DONE: ['CLOSED'], CLOSED: ['VALID'] };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (a, b) => b ? a / b * 100 : NaN;
  const f1 = v => Number.isFinite(v) ? v.toFixed(1) : '—';
  const quant = (a, q) => { if (!a.length) return NaN; const b = a.slice().sort((x, y) => x - y); const i = (b.length - 1) * q, lo = Math.floor(i); return b[lo] + (b[Math.min(lo + 1, b.length - 1)] - b[lo]) * (i - lo); };

  const P = {
    async init() {
      await Backend.init();
      const [data, raw] = await Promise.all([Backend.fleet(), fetch('data/events-config.json').then(r => r.json())]);
      this.data = data; this.raw = raw;
      this.cfgs = {}; for (const p of Object.keys(raw.profiles)) this.cfgs[p] = FDM.resolveConfig(raw, p);
      this.fleets = [...new Set(data.flights.map(f => f.fleet))];
      const months = data.months;
      $('#fFleet').innerHTML = this.fleets.map(f => `<option>${esc(f)}</option>`).join('');
      $('#fFrom').innerHTML = months.map(m => `<option>${m}</option>`).join('');
      $('#fTo').innerHTML = months.map(m => `<option ${m === months[months.length - 1] ? 'selected' : ''}>${m}</option>`).join('');
      ['#fFleet', '#fFrom', '#fTo', '#fAirport', '#fTraining', '#fNuisance', '#fExcluded'].forEach(s => $(s).addEventListener('change', () => { if (s === '#fFleet') this.fillAirports(); this.render(); }));
      $('#fMeasure').addEventListener('change', () => this.renderMeasure());
      ['#rStatus', '#rLevel', '#rCode'].forEach(s => $(s).addEventListener('change', () => { this.page = 1; this.renderReview(); }));
      $('#rMore').addEventListener('click', () => { this.page++; this.renderReview(); });
      if (data.demo) { $('#rReset').hidden = false; $('#rReset').addEventListener('click', async () => { Backend.resetDemo(); this.data = await Backend.fleet(); this.render(); }); }
      window.addEventListener('resize', () => { clearTimeout(this._rz); this._rz = setTimeout(() => this.render(), 150); });
      this.fillAirports();
      const canEvents = Backend.can('events');
      $('#reviewPanel').hidden = !canEvents; $('#noAccess').hidden = canEvents;
      $('#deid').innerHTML = Backend.can('identity')
        ? '🔓 <b>Identified view</b> (gatekeeper): registration, call sign and date are visible for confidential crew contact. Every identity view is logged on the server. · มุมมองระบุตัวตน (gatekeeper) ใช้เพื่อการติดต่อลูกเรือแบบรักษาความลับ'
        : '🔒 <b>De-identified view</b>: flights are shown by pseudonymous key and month only (ICAO Doc 10000 §3.1.7–3.1.9, Annex 19 App. 3). · มุมมองไม่ระบุตัวตน แสดงเฉพาะรหัสแฝงและเดือน';
      if (Backend.server) $('footer p').innerHTML = '<b>FDAP server.</b> Review actions are saved per user and written to the audit log. Identified data are de-identified automatically ' + esc(Backend.user.deid_days) + ' days after upload unless on investigation hold.';
      this.page = 1;
      this.render();
    },

    fillAirports() {
      const fl = $('#fFleet').value;
      const aps = [...new Set(this.data.flights.filter(f => f.fleet === fl).map(f => f.arr).filter(Boolean))].sort();
      $('#fAirport').innerHTML = '<option value="">all</option>' + aps.map(a => `<option>${esc(a)}</option>`).join('');
    },

    // ------------------------------------------------------------ filtering
    sel() {
      const fl = $('#fFleet').value, from = $('#fFrom').value, to = $('#fTo').value, ap = $('#fAirport').value;
      const flights = this.data.flights.filter(f => f.fleet === fl && f.month >= from && f.month <= to && (!ap || f.arr === ap)
        && !($('#fTraining').checked && f.flight_type === 'training') && !($('#fExcluded').checked && f.excluded));
      const evOk = e => !($('#fNuisance').checked && e.status === 'NUISANCE');
      const months = this.data.months.filter(m => m >= from && m <= to);
      const profile = flights[0] ? flights[0].profile : (this.data.flights.find(f => f.fleet === fl) || {}).profile || 'A320';
      return { flights, evOk, months, cfg: this.cfgs[profile], profile, fleet: fl };
    },

    render() {
      this.S = this.sel();
      this.renderKPIs(); this.renderTrend(); this.renderUnstable(); this.renderTypes(); this.renderRunways(); this.renderSPI();
      this.fillMeasures(); this.renderMeasure();
      if (Backend.can('events')) { this.fillCodes(); this.renderReview(); }
    },

    // ------------------------------------------------------------ KPIs
    renderKPIs() {
      const { flights, evOk } = this.S;
      const n = flights.length;
      const ev = flights.flatMap(f => f.events.filter(evOk));
      const L = flights.reduce((s, f) => s + f.measures.flight.n_landings, 0);
      const unst = flights.reduce((s, f) => s + f.events.filter(e => evOk(e) && e.code === 'UNSTABLE_1000').length, 0);
      const ga = flights.reduce((s, f) => s + (f.measures.flight.n_go_arounds || 0), 0);
      const hard = ev.filter(e => e.code === 'HARD_LANDING').length;
      const op = this.data.operated.filter(o => o.fleet === this.S.fleet && this.S.months.includes(o.month));
      const rec = op.reduce((s, o) => s + o.recorded, 0), opn = op.reduce((s, o) => s + o.operated, 0);
      const open = ev.filter(e => e.level > 1 && !['CLOSED', 'NUISANCE'].includes(e.status || 'NEW')).length;
      const tiles = [
        ['Flights analysed', n.toLocaleString(), `${L.toLocaleString()} landings`, 'เที่ยวบินที่วิเคราะห์'],
        ['Data recovery', f1(pct(rec, opn)) + ' %', `${rec} of ${opn} flights recorded`, 'สัดส่วนเที่ยวบินที่ได้ข้อมูล (เป้าหมาย ≥ 90 %)'],
        ['Warnings / 1,000 flights', f1(ev.filter(e => e.level === 3).length / n * 1000), `cautions ${f1(ev.filter(e => e.level === 2).length / n * 1000)}`, 'event ระดับ warning ต่อ 1,000 เที่ยว'],
        ['Unstabilised approaches', f1(pct(unst, L)) + ' %', `of landings · gate ${this.S.cfg.events.UNSTABLE_1000.gate_ft} ft`, 'ร้อยละการลงจอดที่ไม่เสถียร'],
        ['Go-arounds', f1(pct(ga, L + ga)) + ' %', `${ga} go-around(s)`, 'อัตรา go-around (ยิ่งสูงไม่ได้แปลว่าแย่)'],
        ['Hard landings / 1,000 ldg', f1(hard / Math.max(L, 1) * 1000), `${hard} event(s)`, 'ลงแรงต่อ 1,000 ครั้ง'],
        ['Open reviews', String(open), 'caution + warning not closed', 'event ที่ยังไม่ปิด'],
      ];
      $('#kpis').innerHTML = tiles.map(([k, v, s, th]) => `<div class="kpi"><span>${k}</span><b>${v}</b><small>${esc(s)}</small><small class="th">${th}</small></div>`).join('');
    },

    // ------------------------------------------------------------ trend charts
    monthly(fn) { return this.S.months.map(m => fn(this.S.flights.filter(f => f.month === m), m)); },

    renderTrend() {
      const { evOk } = this.S;
      const rows = this.monthly(fs => {
        const n = fs.length || NaN;
        return { n: fs.length, l3: fs.reduce((s, f) => s + f.events.filter(e => evOk(e) && e.level === 3).length, 0) / n * 1000,
          l2: fs.reduce((s, f) => s + f.events.filter(e => evOk(e) && e.level === 2).length, 0) / n * 1000 };
      });
      legend($('#lgTrend'), [['Caution (level 2)', C.l2, 'rect'], ['Warning (level 3)', C.l3, 'rect']]);
      stackedBars($('#chTrend'), this.S.months, [{ name: 'Warning', color: C.l3, values: rows.map(r => r.l3) }, { name: 'Caution', color: C.l2, values: rows.map(r => r.l2) }],
        { fmt: v => v.toFixed(0), extra: i => `${rows[i].n} flights`, annotations: this.annotations() });
    },

    annotations() { return (this.data.annotations || []).filter(a => a.fleet === this.S.fleet && this.S.months.includes(a.month)); },

    renderUnstable() {
      const { evOk } = this.S;
      const Ls = this.monthly(fs => fs.reduce((s, f) => s + f.measures.flight.n_landings, 0));
      const vals = this.monthly((fs, m) => { const L = Ls[this.S.months.indexOf(m)]; return L ? pct(fs.reduce((s, f) => s + f.events.filter(e => evOk(e) && e.code === 'UNSTABLE_1000').length, 0), L) : NaN; });
      $('#unstTitle').innerHTML = `Unstabilised approaches at ${this.S.cfg.events.UNSTABLE_1000.gate_ft} ft <span class="th">ร้อยละของการลงจอดที่บินเข้าไม่เสถียร รายเดือน</span>`;
      lineChart($('#chUnst'), this.S.months, [{ name: 'Unstable approach rate', color: C.line, values: vals }], { fmt: v => v.toFixed(1) + ' %', yMin: 0, annotations: this.annotations(), extra: i => `${Ls[i]} landings` });
    },

    // ------------------------------------------------------------ event types / runways / SPI
    renderTypes() {
      const { flights, evOk, cfg } = this.S; const n = flights.length || 1;
      const by = {};
      for (const f of flights) for (const e of f.events) if (evOk(e) && e.level > 1) { const b = by[e.code] || (by[e.code] = { 2: 0, 3: 0 }); b[e.level]++; }
      const rows = Object.entries(by).map(([code, b]) => ({ code, name: (cfg.events[code] || {}).name || code, th: (cfg.events[code] || {}).th || '', l2: b[2] / n * 1000, l3: b[3] / n * 1000, c2: b[2], c3: b[3] }))
        .sort((a, b) => (b.l2 + b.l3) - (a.l2 + a.l3));
      legend($('#lgTypes'), [['Caution', C.l2, 'rect'], ['Warning', C.l3, 'rect']]);
      hbars($('#chTypes'), rows.map(r => ({ label: r.name, sub: r.th, segs: [{ v: r.l3, c: C.l3, name: 'Warning', count: r.c3 }, { v: r.l2, c: C.l2, name: 'Caution', count: r.c2 }],
        onClick: () => { $('#rCode').value = r.code; this.page = 1; this.renderReview(); $('#reviewPanel').scrollIntoView({ behavior: 'smooth' }); } })), { fmt: v => v.toFixed(1) });
    },

    renderRunways() {
      const { flights, evOk } = this.S;
      const by = {};
      for (const f of flights) for (const l of f.measures.landings) {
        const k = l.rwy || '(off-runway / unknown)'; const b = by[k] || (by[k] = { n: 0, unst: 0, long: 0, hard: 0, td: [] });
        b.n++; if (l.td_dist_m != null) b.td.push(l.td_dist_m);
        const near = e => evOk(e) && Math.abs(e.t_peak - l.t) < 400;
        if (f.events.some(e => e.code === 'UNSTABLE_1000' && near(e) && e.t_peak <= l.t)) b.unst++;
        if (f.events.some(e => e.code === 'LONG_LANDING' && Math.abs(e.t_peak - l.t) < 2 && evOk(e))) b.long++;
        if (f.events.some(e => e.code === 'HARD_LANDING' && Math.abs(e.t_peak - l.t) < 6 && evOk(e))) b.hard++;
      }
      const rows = Object.entries(by).sort((a, b) => b[1].n - a[1].n);
      $('#tRwy').innerHTML = '<thead><tr><th>Runway</th><th class="num">Landings</th><th class="num">Unstable %</th><th class="num">Long ldg %</th><th class="num">Hard / 1k</th><th class="num">TD dist P50 / P90 (m)</th></tr></thead><tbody>' +
        rows.map(([k, b]) => `<tr><td>${esc(k)}</td><td class="num">${b.n}</td><td class="num">${f1(pct(b.unst, b.n))}</td><td class="num">${f1(pct(b.long, b.n))}</td><td class="num">${f1(b.hard / b.n * 1000)}</td><td class="num">${b.td.length ? quant(b.td, 0.5).toFixed(0) + ' / ' + quant(b.td, 0.9).toFixed(0) : '—'}</td></tr>`).join('') + '</tbody>';
    },

    renderSPI() {
      const { flights } = this.S;
      const ev = flights.flatMap(f => f.events.filter(e => e.level > 1));
      const nuis = ev.filter(e => e.status === 'NUISANCE').length;
      const reviewed = ev.filter(e => e.status && e.status !== 'NEW');
      const qc = flights.map(f => f.qc_score).filter(Number.isFinite);
      const crew = ev.filter(e => (e.history || []).some(h => /crew/i.test(h.comment || '') || h.status === 'CREW_DONE')).length;
      const rows = [
        ['Events reviewed', `${reviewed.length} / ${ev.length} (${f1(pct(reviewed.length, ev.length))} %)`, 'ทบทวนแล้ว'],
        ['Nuisance rate', `${f1(pct(nuis, ev.length))} %`, 'สัดส่วนแจ้งเตือนผิด — สูงแปลว่าควรปรับ event definition'],
        ['Crew contacts', String(crew), 'จำนวนครั้งที่ gatekeeper ติดต่อลูกเรือ'],
        ['Mean data-quality score', f1(qc.reduce((s, x) => s + x, 0) / Math.max(qc.length, 1)), 'คะแนนคุณภาพข้อมูลเฉลี่ย'],
        ['Flights below QC 80', String(qc.filter(x => x < 80).length), 'เที่ยวบินที่คุณภาพข้อมูลต่ำ'],
      ];
      $('#tSpi').innerHTML = '<tbody>' + rows.map(([k, v, th]) => `<tr><th>${k}<br><span class="th">${th}</span></th><td class="num">${esc(v)}</td></tr>`).join('') + '</tbody>';
    },

    // ------------------------------------------------------------ measurements
    measureDefs() {
      const cfg = this.S.cfg, E = cfg.events, G = cfg.gates_ft, U = cfg.unstable_criteria;
      const th = (code, k) => (E[code] && E[code].enabled !== false && Number.isFinite(E[code][k])) ? E[code][k] : null;
      const lv = (code, mul = 1) => [th(code, 'l2') != null && { v: th(code, 'l2') * mul, label: 'caution', c: C.l2 }, th(code, 'l3') != null && { v: th(code, 'l3') * mul, label: 'warning', c: C.l3 }].filter(Boolean);
      const L = (key, label, unit, lines, opt = {}) => Object.assign({ key, label, unit, lines, src: 'landings' }, opt);
      return [
        L('td_nz_g', 'Touchdown vertical acceleration', 'g', lv('HARD_LANDING'), { th: 'แรง G ขณะแตะพื้น' }),
        L('td_dist_m', 'Touchdown distance past threshold', 'm', lv('LONG_LANDING'), { th: 'ระยะแตะพื้นจากหัวรันเวย์' }),
        ...G.map(g => L('ias_dev_' + g, `IAS − Vapp at ${g} ft`, 'kt', [{ v: U.ias_above_vapp_kt, label: `+${U.ias_above_vapp_kt} (unstable)`, c: C.l2 }, { v: -U.ias_below_vapp_kt, label: `−${U.ias_below_vapp_kt}`, c: C.l2 }], { th: `ความเร็วเทียบ Vapp ที่ ${g} ft` })),
        ...G.slice(0, 2).map(g => L('vs_' + g, `Vertical speed at ${g} ft`, 'fpm', [{ v: U.vs_min_fpm, label: `${U.vs_min_fpm} (unstable)`, c: C.l2 }], { th: `อัตราร่อนที่ ${g} ft` })),
        L('max_rod_final_fpm', `Max rate of descent below ${G[0]} ft`, 'fpm', lv('HIGH_ROD_FINAL'), { th: 'อัตราร่อนสูงสุดช่วง final' }),
        L('td_vs_fpm', 'Vertical speed at touchdown', 'fpm', [], { th: 'อัตราร่อนขณะแตะพื้น' }),
        L('td_roll_max_deg', 'Max bank in last 3 s before touchdown', '°', [], { th: 'มุมเอียงสูงสุดก่อนแตะพื้น' }),
        L('lo_pitch_deg', 'Pitch at lift-off', '°', lv('HIGH_PITCH_LIFTOFF'), { src: 'takeoffs', th: 'มุมเงยขณะล้อพ้นพื้น' }),
        L('max_pitch_rate', 'Max pitch rate at rotation', '°/s', lv('HIGH_PITCH_RATE_ROT'), { src: 'takeoffs', th: 'อัตราเงยหัวสูงสุดขณะ rotate' }),
        L('max_bank_deg', 'Max bank angle in flight', '°', lv('HIGH_BANK'), { src: 'flight', th: 'มุมเอียงสูงสุดระหว่างบิน' }),
      ];
    },

    fillMeasures() {
      const defs = this.measureDefs(); const cur = $('#fMeasure').value;
      $('#fMeasure').innerHTML = defs.map(d => `<option value="${d.key}">${esc(d.label)} (${esc(d.unit)})</option>`).join('');
      $('#fMeasure').value = defs.some(d => d.key === cur) ? cur : 'td_nz_g';
    },

    values(def, flights) {
      const out = [];
      for (const f of flights) {
        const src = def.src === 'flight' ? [f.measures.flight] : f.measures[def.src];
        for (const m of src) if (m[def.key] != null) out.push({ v: m[def.key], month: f.month });
      }
      return out;
    },

    renderMeasure() {
      const def = this.measureDefs().find(d => d.key === $('#fMeasure').value); if (!def) return;
      const vals = this.values(def, this.S.flights); const v = vals.map(x => x.v);
      const caution = def.lines.find(l => l.label.startsWith('caution') || l.label.includes('unstable')) || def.lines[0];
      let near = '', above = 0, band = 0;
      if (caution && v.length) {
        const sgn = caution.v < 0 ? -1 : 1, thr = caution.v;
        above = v.filter(x => sgn > 0 ? x > thr : x < thr).length;
        const lo = def.key === 'td_nz_g' ? 1 + (thr - 1) * 0.8 : thr * 0.8;
        band = v.filter(x => sgn > 0 ? (x > lo && x <= thr) : (x < lo && x >= thr)).length;
        near = ` · beyond caution ${above} (${f1(pct(above, v.length))} %) · in the 80–100 % precursor band ${band} (${f1(pct(band, v.length))} %)`;
      }
      $('#mStats').textContent = v.length ? `n = ${v.length} · P50 ${quant(v, 0.5).toFixed(2)} · P90 ${quant(v, 0.9).toFixed(2)} · P99 ${quant(v, 0.99).toFixed(2)} ${def.unit}${near}` : 'no values for this selection';
      histogram($('#chHist'), v, { unit: def.unit, lines: def.lines });
      const months = this.S.months;
      $('#mMonthTitle').textContent = `Monthly median and 90th percentile · ค่ามัธยฐานและเปอร์เซ็นไทล์ที่ 90 รายเดือน (${def.unit})`;
      lineChart($('#chMonthly'), months, [
        { name: 'P90', color: C.l2, values: months.map(m => { const a = vals.filter(x => x.month === m).map(x => x.v); return a.length >= 3 ? quant(a, 0.9) : NaN; }) },
        { name: 'Median', color: C.line, values: months.map(m => { const a = vals.filter(x => x.month === m).map(x => x.v); return a.length >= 3 ? quant(a, 0.5) : NaN; }) },
      ], { fmt: x => x.toFixed(2) + ' ' + def.unit, legend: true, annotations: this.annotations() });
      $('#mNote').innerHTML = 'Doc 10000 §2.3.1: values kept from <i>every</i> flight show drift towards a limit before events fire. The 80–100 % band counts flights close to the caution threshold — the precursor population an exceedance-only programme never sees. · ค่าที่เก็บจากทุกเที่ยวบินช่วยเห็นแนวโน้มก่อนจะเกิด event';
    },

    // ------------------------------------------------------------ review
    fillCodes() {
      const cur = $('#rCode').value; const codes = new Set(); for (const f of this.S.flights) for (const e of f.events) codes.add(e.code);
      $('#rCode').innerHTML = '<option value="">all</option>' + [...codes].sort().map(c => `<option value="${c}">${esc((this.S.cfg.events[c] || {}).name || c)}</option>`).join('');
      if (codes.has(cur)) $('#rCode').value = cur;
    },

    renderReview() {
      const st = $('#rStatus').value, lv = $('#rLevel').value, code = $('#rCode').value;
      const items = [];
      for (const f of this.S.flights) for (const e of f.events) {
        const s = e.status || 'NEW';
        if (st === 'open' && ['CLOSED'].includes(s)) continue;
        if (lv && e.level !== +lv) continue; if (code && e.code !== code) continue;
        items.push({ f, e });
      }
      items.sort((a, b) => b.e.level - a.e.level || (b.f.date || b.f.month).localeCompare(a.f.date || a.f.month));
      const shown = items.slice(0, this.page * 40);
      $('#rCount').textContent = `${items.length} event(s)`;
      $('#rMore').hidden = shown.length >= items.length;
      const ident = Backend.can('identity');
      $('#tReview').innerHTML = `<thead><tr><th>Level</th><th>${ident ? 'Date · flight' : 'Month · flight key'}</th><th>Event</th><th class="num">Value</th><th>Status</th><th></th></tr></thead><tbody>` +
        shown.map(({ f, e }, i) => {
          const s = e.status || 'NEW';
          const who = ident ? `${esc(f.date || f.month)} ${esc(f.time_utc || '')}Z<br><b>${esc(f.registration || '')}</b> ${esc(f.callsign || '')}` : `${esc(f.month)}<br><span class="mono">${esc(f.key)}</span>`;
          return `<tr class="lv${e.level}" data-i="${i}"><td><span class="badge lv${e.level}">${LEVEL[e.level].toUpperCase()}</span></td>
            <td>${who}${f.excluded ? `<br><span class="flag">excluded: ${esc(f.excluded)}</span>` : ''}</td>
            <td><b>${esc(e.name)}</b><br><span class="th">${esc(e.th)}</span>${e.detail ? `<br><span class="det">${esc(e.detail)}</span>` : ''}</td>
            <td class="num">${e.value == null ? '' : esc(e.value)} <span class="det">${esc(e.unit)}</span></td>
            <td><span class="st st-${s}">${STATUS[s][0]}</span></td>
            <td><button class="btn sm" data-open="${i}" aria-expanded="false">Review</button></td></tr>
            <tr class="rv-detail" id="rvd${i}" hidden><td colspan="6"></td></tr>`;
        }).join('') + '</tbody>';
      this.shown = shown;
      $('#tReview').querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => this.toggleDetail(+b.dataset.open, b)));
    },

    toggleDetail(i, btn) {
      const row = $('#rvd' + i); const open = row.hidden; row.hidden = !open; btn.setAttribute('aria-expanded', String(open));
      if (!open) return;
      const { f, e } = this.shown[i]; const s = e.status || 'NEW';
      const allowed = (NEXT[s] || []).filter(n => n !== 'CREW_DONE' || Backend.can('identity'));
      const hist = (e.history || []).map(h => `<li><span class="mono">${esc((h.at || '').replace('T', ' ').slice(0, 16))}</span> ${esc(h.by || '')} → <b>${esc(STATUS[h.status] ? STATUS[h.status][0] : h.status)}</b>${h.comment ? ' — ' + esc(h.comment) : ''}</li>`).join('');
      row.firstElementChild.innerHTML = `<div class="rv-box">
        <div><h4>History <span class="th">ประวัติ</span></h4>${hist ? `<ul class="hist">${hist}</ul>` : '<p class="small">no actions yet</p>'}
          <p class="small">Flight ${esc(f.key)} · ${esc(f.aircraft)} · profile ${esc(f.profile)} · QC ${esc(f.qc_score)}/100 · ${esc(f.flight_type)}
          ${f.replay ? ` · <a href="index.html#${encodeURIComponent(f.replay)}">open in replay</a>` : (Backend.server && Backend.can('replay') ? ` · <a href="index.html#${encodeURIComponent(f.key)}">open in replay</a>` : ' · summary only (no time series in demo)')}</p></div>
        <div><h4>Action <span class="th">ดำเนินการ</span></h4>
          <textarea rows="2" placeholder="comment (no names - de-identified record)" aria-label="Comment"></textarea>
          <div class="acts">${allowed.map(n => `<button class="btn sm" data-st="${n}">${STATUS[n][0]}</button>`).join('')}</div>
          ${s === 'CREW_REQ' && !Backend.can('identity') ? '<p class="small">Waiting for the gatekeeper — only the gatekeeper can see who flew. · รอ gatekeeper ติดต่อลูกเรือ</p>' : ''}
          <label class="small">Flight flag <select data-flag><option value="">included in statistics</option>
            ${['training / non-revenue', 'check / test flight', 'data quality - unusable', 'simulator / duplicate'].map(r => `<option ${f.excluded === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
          ${Backend.can('hold') ? `<label class="small chk"><input type="checkbox" data-hold ${f.hold ? 'checked' : ''}> investigation hold (Annex 13 — keep identified, no de-identification)</label>` : ''}
        </div></div>`;
      const box = row.firstElementChild;
      box.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true;
        try { const r = await Backend.setReview(e.id, b.dataset.st, box.querySelector('textarea').value.trim()); Object.assign(e, { status: r.status || b.dataset.st, history: r.history || e.history }); this.render(); }
        catch (err) { b.disabled = false; alert('Not saved: ' + err.message); } // eslint-disable-line no-alert
      }));
      box.querySelector('[data-flag]').addEventListener('change', async ev => { const v = ev.target.value || null; await Backend.setFlag(f.key, { excluded: v }); f.excluded = v; this.render(); });
      const hold = box.querySelector('[data-hold]'); if (hold) hold.addEventListener('change', async ev => { await Backend.setFlag(f.key, { hold: ev.target.checked }); f.hold = ev.target.checked; });
    },
  };

  // ================================================================== tiny SVG chart kit
  const NS = 'http://www.w3.org/2000/svg';
  const tip = () => $('#tip');
  function showTip(evt, lines) {
    const t = tip(); t.replaceChildren();
    for (const [i, l] of lines.entries()) {
      const d = document.createElement('div'); d.className = i === 0 ? 'tt' : 'tr';
      if (l.color) { const k = document.createElement('i'); k.style.background = l.color; d.appendChild(k); }
      const b = document.createElement('b'); b.textContent = l.value ?? ''; d.appendChild(b);
      if (l.label) { const s = document.createElement('span'); s.textContent = ' ' + l.label; d.appendChild(s); }
      t.appendChild(d);
    }
    t.hidden = false;
    const x = Math.min(evt.clientX + 14, innerWidth - t.offsetWidth - 8), y = Math.min(evt.clientY + 14, innerHeight - t.offsetHeight - 8);
    t.style.left = x + 'px'; t.style.top = y + 'px';
  }
  const hideTip = () => { tip().hidden = true; };
  function el(name, attrs, parent) { const e = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; }
  function frame(box, h) {
    box.replaceChildren(); const w = Math.max(280, box.clientWidth || 600);
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: h, role: 'img' }, box); return { svg, w, h };
  }
  function niceMax(v) { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
  function yAxis(svg, x0, x1, y0, y1, lo, hi, fmt, ticks) {
    if (!ticks) { const r = (hi - lo) / 10 ** Math.floor(Math.log10(hi - lo || 1)); ticks = Math.abs(r - 2) < 1e-9 ? 4 : 5; }
    for (let i = 0; i <= ticks; i++) {
      const v = lo + (hi - lo) * i / ticks, y = y0 - (y0 - y1) * i / ticks;
      el('line', { x1: x0, x2: x1, y1: y, y2: y, stroke: C.grid, 'stroke-width': 1 }, svg);
      const t = el('text', { x: x0 - 6, y: y + 4, 'text-anchor': 'end', fill: C.axis, 'font-size': 11 }, svg); t.textContent = fmt(v);
    }
  }
  function monthLabel(m) { const [y, mo] = m.split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mo - 1] + (mo === '01' || m === m0 ? ` ’${y.slice(2)}` : ''); }
  let m0 = null;
  function xLabels(svg, cats, xAt, y, step = 1) { m0 = cats[0]; cats.forEach((c, i) => { if (i % step) return; const t = el('text', { x: xAt(i), y, 'text-anchor': 'middle', fill: C.axis, 'font-size': 11 }, svg); t.textContent = monthLabel(c); }); }
  function annot(svg, cats, xAt, top, bottom, anns) {
    for (const a of anns) {
      const i = cats.indexOf(a.month); if (i < 0) continue; const x = xAt(i);
      el('line', { x1: x, x2: x, y1: top - 6, y2: bottom, stroke: C.text, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: .7 }, svg);
      const t = el('text', { x: x + 4, y: top - 8, fill: C.text, 'font-size': 10.5 }, svg); t.textContent = '▼ ' + a.text;
      if (x > svg.viewBox.baseVal.width * 0.55) { t.setAttribute('text-anchor', 'end'); t.setAttribute('x', x - 4); t.textContent = a.text + ' ▼'; }
    }
  }

  function stackedBars(box, cats, series, opt) {
    const { svg, w, h } = frame(box, 230); const L = 44, R = 10, T = 26, B = 24;
    const tot = cats.map((_, i) => series.reduce((s, se) => s + (Number.isFinite(se.values[i]) ? se.values[i] : 0), 0));
    const hi = niceMax(Math.max(...tot) * 1.1);
    yAxis(svg, L, w - R, h - B, T, 0, hi, v => v.toFixed(0));
    const bw = (w - L - R) / cats.length, xAt = i => L + bw * (i + 0.5), Y = v => (h - B) - (h - B - T) * v / hi;
    cats.forEach((c, i) => {
      let base = 0; const g = el('g', { tabindex: 0, class: 'mk' }, svg);
      for (const se of series.slice().reverse()) {
        const v = se.values[i]; if (!(v > 0)) continue;
        const y1 = Y(base + v), y0 = Y(base);
        el('rect', { x: xAt(i) - bw * 0.32, y: y1, width: bw * 0.64, height: Math.max(0, y0 - y1 - 2), fill: se.color, rx: 2 }, g);
        base += v;
      }
      el('rect', { x: xAt(i) - bw / 2, y: T, width: bw, height: h - B - T, fill: 'transparent' }, g);
      const lines = () => [{ value: `${c}`, label: opt.extra ? opt.extra(i) : '' }].concat(series.map(se => ({ color: se.color, value: Number.isFinite(se.values[i]) ? opt.fmt(se.values[i]) : '—', label: se.name })));
      g.addEventListener('pointermove', e => showTip(e, lines())); g.addEventListener('pointerleave', hideTip);
      g.addEventListener('focus', e => { const r = g.getBoundingClientRect(); showTip({ clientX: r.right, clientY: r.top }, lines()); }); g.addEventListener('blur', hideTip);
    });
    xLabels(svg, cats, xAt, h - 6, cats.length > 14 ? 2 : 1);
    annot(svg, cats, xAt, T, h - B, opt.annotations || []);
  }

  function lineChart(box, cats, series, opt) {
    const { svg, w, h } = frame(box, 230); const L = 52, R = 12, T = 26, B = 24;
    const all = series.flatMap(s => s.values).filter(Number.isFinite);
    if (!all.length) { const t = el('text', { x: w / 2, y: h / 2, fill: C.axis, 'text-anchor': 'middle' }, svg); t.textContent = 'no data'; return; }
    let lo = opt.yMin != null ? opt.yMin : Math.min(...all), hi = Math.max(...all);
    if (opt.yMin == null) { const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1; lo -= pad; hi += pad; } else hi = niceMax(hi * 1.15);
    const fmtAxis = v => Math.abs(hi - lo) < 5 ? v.toFixed(2) : v.toFixed(0);
    yAxis(svg, L, w - R, h - B, T, lo, hi, fmtAxis);
    const step = (w - L - R) / Math.max(cats.length - 1, 1), xAt = i => L + step * i, Y = v => (h - B) - (h - B - T) * (v - lo) / (hi - lo);
    for (const se of series) {
      let d = '', pen = false;
      se.values.forEach((v, i) => { if (Number.isFinite(v)) { d += (pen ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true; } else pen = false; });
      el('path', { d, fill: 'none', stroke: se.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
      se.values.forEach((v, i) => { if (Number.isFinite(v)) el('circle', { cx: xAt(i), cy: Y(v), r: 4, fill: se.color, stroke: '#121820', 'stroke-width': 2 }, svg); });
      if (series.length > 1 && opt.legend) { const lastI = se.values.map((v, i) => Number.isFinite(v) ? i : -1).filter(i => i >= 0).pop(); if (lastI != null) { const t = el('text', { x: xAt(lastI) - 6, y: Y(se.values[lastI]) - 8, fill: C.text, 'font-size': 11, 'text-anchor': 'end' }, svg); t.textContent = se.name; } }
    }
    xLabels(svg, cats, xAt, h - 6, cats.length > 14 ? 2 : 1);
    annot(svg, cats, xAt, T, h - B, opt.annotations || []);
    const hair = el('line', { y1: T, y2: h - B, stroke: C.axis, 'stroke-width': 1, opacity: 0 }, svg);
    const hit = el('rect', { x: L, y: T, width: w - L - R, height: h - B - T, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', e => {
      const r = svg.getBoundingClientRect(); const px = (e.clientX - r.left) * (w / r.width);
      const i = Math.max(0, Math.min(cats.length - 1, Math.round((px - L) / step)));
      hair.setAttribute('x1', xAt(i)); hair.setAttribute('x2', xAt(i)); hair.setAttribute('opacity', 1);
      showTip(e, [{ value: cats[i], label: opt.extra ? opt.extra(i) : '' }].concat(series.map(se => ({ color: se.color, value: Number.isFinite(se.values[i]) ? opt.fmt(se.values[i]) : '—', label: se.name }))));
    });
    hit.addEventListener('pointerleave', () => { hair.setAttribute('opacity', 0); hideTip(); });
  }

  function hbars(box, rows, opt) {
    box.replaceChildren();
    if (!rows.length) { box.textContent = 'No caution / warning events in this selection.'; return; }
    const max = Math.max(...rows.map(r => r.segs.reduce((s, x) => s + x.v, 0)));
    for (const r of rows) {
      const d = document.createElement('button'); d.type = 'button'; d.className = 'hb';
      const lab = document.createElement('span'); lab.className = 'hb-l'; lab.textContent = r.label;
      const sub = document.createElement('small'); sub.textContent = r.sub; lab.appendChild(document.createElement('br')); lab.appendChild(sub);
      const track = document.createElement('span'); track.className = 'hb-t';
      for (const s of r.segs) if (s.v > 0) { const seg = document.createElement('i'); seg.style.width = (s.v / max * 100) + '%'; seg.style.background = s.c; track.appendChild(seg); }
      const val = document.createElement('b'); val.className = 'hb-v'; val.textContent = opt.fmt(r.segs.reduce((s, x) => s + x.v, 0));
      d.append(lab, track, val);
      d.addEventListener('click', r.onClick);
      d.addEventListener('pointermove', e => showTip(e, [{ value: r.label }].concat(r.segs.map(s => ({ color: s.c, value: `${opt.fmt(s.v)} /1k`, label: `${s.name} (${s.count})` })))));
      d.addEventListener('pointerleave', hideTip);
      box.appendChild(d);
    }
  }

  function histogram(box, vals, opt) {
    const { svg, w, h } = frame(box, 250); const L = 44, R = 12, T = 30, B = 30;
    if (!vals.length) { const t = el('text', { x: w / 2, y: h / 2, fill: C.axis, 'text-anchor': 'middle' }, svg); t.textContent = 'no values'; return; }
    let lo = Math.min(...vals, ...opt.lines.map(l => l.v)), hi = Math.max(...vals, ...opt.lines.map(l => l.v));
    const span = hi - lo || 1; lo -= span * 0.04; hi += span * 0.04;
    const nb = Math.min(40, Math.max(12, Math.round(Math.sqrt(vals.length) * 1.5)));
    const bwv = (hi - lo) / nb; const bins = new Array(nb).fill(0);
    for (const v of vals) bins[Math.min(nb - 1, Math.floor((v - lo) / bwv))]++;
    const ymax = niceMax(Math.max(...bins) * 1.1);
    yAxis(svg, L, w - R, h - B, T, 0, ymax, v => v.toFixed(0));
    const X = v => L + (w - L - R) * (v - lo) / (hi - lo), Y = c => (h - B) - (h - B - T) * c / ymax;
    const cautions = opt.lines.filter(l => l.label.startsWith('caution') || l.label.includes('unstable'));
    bins.forEach((c, i) => {
      const a = lo + i * bwv, b = a + bwv; const x0 = X(a) + 1, x1 = X(b) - 1;
      const beyond = cautions.some(l => (l.v >= 0 ? a >= l.v : b <= l.v));
      const g = el('g', { class: 'mk' }, svg);
      if (c) el('rect', { x: x0, y: Y(c), width: Math.max(1, x1 - x0), height: (h - B) - Y(c), fill: beyond ? C.l2 : C.bar, opacity: beyond ? 0.95 : 0.8, rx: 2 }, g);
      el('rect', { x: X(a), y: T, width: X(b) - X(a), height: h - B - T, fill: 'transparent' }, g);
      g.addEventListener('pointermove', e => showTip(e, [{ value: `${c} value(s)`, label: `${a.toFixed(2)} … ${b.toFixed(2)} ${opt.unit}` }]));
      g.addEventListener('pointerleave', hideTip);
    });
    // x ticks
    for (let i = 0; i <= 5; i++) { const v = lo + (hi - lo) * i / 5; const t = el('text', { x: X(v), y: h - 10, 'text-anchor': 'middle', fill: C.axis, 'font-size': 11 }, svg); t.textContent = Math.abs(hi - lo) < 10 ? v.toFixed(2) : v.toFixed(0); }
    opt.lines.forEach((l, k) => {
      el('line', { x1: X(l.v), x2: X(l.v), y1: T - 4, y2: h - B, stroke: l.c, 'stroke-width': 2, 'stroke-dasharray': '5 3' }, svg);
      const t = el('text', { x: X(l.v) + 4, y: T - 8 - (k % 2) * 0, fill: C.text, 'font-size': 11 }, svg); t.textContent = `${l.label} ${l.v}`;
      if (X(l.v) > w * 0.7) { t.setAttribute('text-anchor', 'end'); t.setAttribute('x', X(l.v) - 4); }
      if (k % 2) t.setAttribute('y', T + 8);
    });
  }

  function legend(box, items) {
    box.replaceChildren();
    for (const [name, color, kind] of items) {
      const s = document.createElement('span'); const k = document.createElement('i'); k.className = kind; k.style.background = color; s.append(k, document.createTextNode(name)); box.appendChild(s);
    }
  }

  window.addEventListener('DOMContentLoaded', () => P.init().catch(e => { document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="status err">Could not load fleet data: ${esc(e.message)}</p>`); console.error(e); }));
  window.FleetPage = P;
})();
