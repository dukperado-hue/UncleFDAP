// Sign-in page for the self-hosted FDAP server.
(function () {
  'use strict';
  const form = document.getElementById('f'), err = document.getElementById('e');
  const next = new URLSearchParams(location.search).get('next') || 'index.html';
  const safeNext = /^[\w.-]+\.html(#[\w.-]*)?$/.test(next) ? next : 'index.html';
  fetch('api/me', { headers: { 'X-FDAP': '1' } }).then(r => { if (r.ok) location.replace(safeNext); }).catch(() => {
    err.textContent = 'This page needs the FDAP server (python server/fdap_server.py serve). The public demo has no login.';
  });
  form.addEventListener('submit', async e => {
    e.preventDefault(); err.textContent = '';
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FDAP': '1' },
        body: JSON.stringify({ username: document.getElementById('u').value.trim(), password: document.getElementById('p').value }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('error ' + r.status));
      location.replace(j.role === 'manager' ? 'fleet.html' : (j.role === 'admin' && safeNext === 'index.html' ? 'admin.html' : safeNext));
    } catch (x) { err.textContent = x.message; document.getElementById('p').value = ''; }
    btn.disabled = false;
  });
})();
