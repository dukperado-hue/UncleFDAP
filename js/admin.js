// Admin page: users + audit log (server mode only).
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let audit = [];

  async function users() {
    const j = await Backend.api('users');
    $('#tUsers').innerHTML = '<thead><tr><th>User</th><th>Role</th><th>Created</th><th></th></tr></thead><tbody>' +
      j.users.map(u => `<tr><td><b>${esc(u.username)}</b></td><td><span class="role">${esc(u.role)}</span></td><td class="mono">${esc((u.created || '').slice(0, 16))}</td>
        <td><button class="btn sm" data-reset="${esc(u.username)}">Reset password</button></td></tr>`).join('') + '</tbody>';
    document.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', async () => {
      const r = await Backend.api('users', { method: 'POST', body: JSON.stringify({ action: 'reset', username: b.dataset.reset }) });
      showPw(r); loadAudit();
    }));
  }
  function showPw(r) { const p = $('#pwOut'); p.hidden = false; p.textContent = `Password for ${r.username} (shown once, give it over a separate channel): ${r.password}`; }

  async function loadAudit() {
    audit = (await Backend.api('audit?limit=1000')).audit;
    const acts = [...new Set(audit.map(a => a.action))].sort(); const cur = $('#aAct').value;
    $('#aAct').innerHTML = '<option value="">all</option>' + acts.map(a => `<option ${a === cur ? 'selected' : ''}>${esc(a)}</option>`).join('');
    renderAudit();
  }
  function renderAudit() {
    const act = $('#aAct').value;
    $('#tAudit').innerHTML = '<thead><tr><th>Time (UTC)</th><th>User</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>' +
      audit.filter(a => !act || a.action === act).map(a => `<tr><td class="mono">${esc(a.at.replace('T', ' ').slice(0, 19))}</td><td>${esc(a.username)}</td><td><b>${esc(a.action)}</b></td>
        <td class="mono">${esc(a.target)}</td><td class="det">${esc(a.detail)} ${a.ip ? '· ' + esc(a.ip) : ''}</td></tr>`).join('') + '</tbody>';
  }

  window.addEventListener('DOMContentLoaded', async () => {
    await Backend.init();
    if (!Backend.server || !Backend.can('admin')) { document.querySelector('main').innerHTML = '<p class="panel">Admin page is available on the FDAP server to admin users only.</p>'; return; }
    $('#aAct').addEventListener('change', renderAudit);
    $('#addUser').addEventListener('submit', async e => {
      e.preventDefault();
      try { showPw(await Backend.api('users', { method: 'POST', body: JSON.stringify({ username: $('#nu').value.trim(), role: $('#nr').value }) })); $('#nu').value = ''; users(); loadAudit(); }
      catch (x) { const p = $('#pwOut'); p.hidden = false; p.textContent = 'Not added: ' + x.message; }
    });
    users(); loadAudit();
  });
})();
