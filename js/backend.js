// Data access layer. Two modes:
//  - demo (GitHub Pages / plain static server): bundled synthetic data, review state in this browser
//  - server (tools/../server/fdap_server.py): login, roles, de-identification, shared review state
// The mode is decided at start-up by GET api/me (404 / network error -> demo).
(function () {
  'use strict';
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const ROLE_CAN = {
    admin: ['replay', 'upload', 'review', 'identity', 'hold', 'admin', 'stats', 'events'],
    gatekeeper: ['replay', 'upload', 'review', 'identity', 'hold', 'stats', 'events'],
    analyst: ['replay', 'upload', 'review', 'stats', 'events'],
    manager: ['stats'],
  };
  const ROLE_TH = { admin: 'ผู้ดูแลระบบ', gatekeeper: 'Gatekeeper (ผู้ประสานลูกเรือ)', analyst: 'FDM analyst (ข้อมูลไม่ระบุตัว)', manager: 'ผู้บริหาร (สถิติรวมเท่านั้น)' };

  async function api(path, opts = {}) {
    const r = await fetch('api/' + path, Object.assign({ credentials: 'same-origin', headers: { 'X-FDAP': '1', 'Content-Type': 'application/json' } }, opts));
    if (r.status === 401) { location.href = 'login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() + location.hash); throw new Error('login required'); }
    if (!r.ok) { let m = r.status + ''; try { m = (await r.json()).error || m; } catch (e) { /* not json */ } throw new Error(m); }
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  }

  const Backend = {
    server: false, user: null, ROLE_TH,

    async init() {
      try {
        const r = await fetch('api/me', { credentials: 'same-origin', headers: { 'X-FDAP': '1' } });
        if (r.status === 401) { location.href = 'login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() + location.hash); return new Promise(() => {}); }
        if (r.ok && (r.headers.get('content-type') || '').includes('json')) { this.user = await r.json(); this.server = true; }
      } catch (e) { /* static hosting */ }
      if (!this.server) this.user = { username: 'demo', role: LS.get('fdap.demoRole', 'analyst'), demo: true };
      this.renderUserBox();
    },

    get role() { return this.user ? this.user.role : 'analyst'; },
    can(action) { return (ROLE_CAN[this.role] || []).includes(action); },

    renderUserBox() {
      const box = document.getElementById('userBox'); if (!box) return;
      if (this.server) {
        box.innerHTML = `<span class="role">${this.user.role}</span> <b>${escH(this.user.username)}</b> <button class="btn" id="logoutBtn">Log out</button>`;
        box.querySelector('#logoutBtn').addEventListener('click', async () => { await api('logout', { method: 'POST', body: '{}' }).catch(() => {}); location.href = 'login.html'; });
      } else {
        box.innerHTML = `<label class="small">view as <select id="demoRole">${Object.keys(ROLE_CAN).map(r => `<option ${r === this.role ? 'selected' : ''}>${r}</option>`).join('')}</select></label>`;
        box.querySelector('#demoRole').addEventListener('change', e => { LS.set('fdap.demoRole', e.target.value); location.reload(); });
        box.title = 'Demo only: simulates what each role may see. The self-hosted server enforces this with real logins.';
      }
    },

    // ------------------------------------------------ flights (replay page, server mode)
    async flightIndex() {
      const j = await api('flights');
      return j.flights.map(f => Object.assign({ group: 'server', id: f.key, title: f.title || f.key, title_th: f.title_th || '' }, f));
    },
    flightCSV(meta) { return api('flights/' + encodeURIComponent(meta.key) + '/csv'); },
    upload(payload) { return api('flights', { method: 'POST', body: JSON.stringify(payload) }); },

    // ------------------------------------------------ fleet / review
    async fleet() {
      if (this.server) return api('fleet');
      const j = await fetch('data/fleet/fleet.json').then(r => r.json());
      const rv = LS.get('fdap.review.v1', {}), fl = LS.get('fdap.flags.v1', {});
      for (const f of j.flights) {
        Object.assign(f, fl[f.key] || {});
        for (const e of f.events) Object.assign(e, rv[e.id] || {});
        if (!this.can('identity')) { delete f.registration; delete f.callsign; delete f.date; delete f.time_utc; }
      }
      j.demo = true;
      return j;
    },
    async setReview(id, status, comment) {
      if (this.server) return api('events/' + encodeURIComponent(id) + '/review', { method: 'POST', body: JSON.stringify({ status, comment }) });
      const rv = LS.get('fdap.review.v1', {});
      const cur = rv[id] || { history: [] };
      cur.status = status;
      cur.history = (cur.history || []).concat([{ at: new Date().toISOString(), by: 'demo/' + this.role, status, comment: comment || '' }]);
      rv[id] = cur; LS.set('fdap.review.v1', rv);
      return cur;
    },
    async setFlag(key, flags) {
      if (this.server) return api('flights/' + encodeURIComponent(key) + '/flags', { method: 'POST', body: JSON.stringify(flags) });
      const fl = LS.get('fdap.flags.v1', {}); fl[key] = Object.assign(fl[key] || {}, flags); LS.set('fdap.flags.v1', fl); return fl[key];
    },
    resetDemo() { LS.set('fdap.review.v1', {}); LS.set('fdap.flags.v1', {}); },
    identity(key) { return api('flights/' + encodeURIComponent(key) + '/identity'); },
    api,
  };
  function escH(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  window.Backend = Backend;
})();
