// Primary Flight Display + Navigation Display drawn on <canvas>.
// Generic glass-cockpit layout for replay/training visualisation only.
(function (global) {
  'use strict';
  const D2R = Math.PI / 180;
  const C = {
    sky: '#2f7fd1', ground: '#8a5a2b', white: '#f4f6f8', green: '#3be07a', amber: '#ffb000',
    red: '#ff3b3b', cyan: '#38d9f5', magenta: '#ff5cf0', tape: '#3b4250', bg: '#0b0f14', grey: '#8a94a6',
  };
  const font = (px, w = 600) => `${w} ${px}px "B612 Mono", "Consolas", monospace`;

  function setupCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  const num = v => (typeof v === 'number' && !Number.isNaN(v));

  // ------------------------------------------------------------------ PFD
  function drawPFD(cv, r, ctxInfo) {
    const { ctx, w, h } = setupCanvas(cv);
    const S = Math.min(w, h) / 400;           // design is 400 x 400
    ctx.save();
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    ctx.translate((w - 400 * S) / 2, (h - 400 * S) / 2);
    ctx.scale(S, S);
    if (!r) { ctx.restore(); return; }

    const cx = 190, cy = 205, AW = 180, AH = 200; // attitude window
    const ppd = 5.2;                               // px per degree pitch
    // --- attitude
    ctx.save();
    ctx.beginPath(); ctx.rect(cx - AW / 2, cy - AH / 2, AW, AH); ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-r.roll_deg * D2R);
    const off = r.pitch_deg * ppd;
    ctx.fillStyle = C.sky; ctx.fillRect(-400, -800 + off, 800, 800);
    ctx.fillStyle = C.ground; ctx.fillRect(-400, off, 800, 800);
    ctx.strokeStyle = C.white; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-400, off); ctx.lineTo(400, off); ctx.stroke();
    ctx.font = font(10); ctx.fillStyle = C.white; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 1.5;
    for (let p = -30; p <= 30; p += 2.5) {
      if (p === 0) continue;
      const y = off - p * ppd;
      const major = p % 10 === 0, mid = p % 5 === 0;
      const hw = major ? 36 : mid ? 22 : 10;
      ctx.beginPath(); ctx.moveTo(-hw, y); ctx.lineTo(hw, y); ctx.stroke();
      if (major) { ctx.fillText(Math.abs(p), -hw - 12, y); ctx.fillText(Math.abs(p), hw + 12, y); }
    }
    ctx.restore();
    // window frame
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.strokeRect(cx - AW / 2, cy - AH / 2, AW, AH);
    // bank scale
    ctx.save(); ctx.translate(cx, cy);
    ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.lineWidth = 2;
    const R = 92;
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const len = (Math.abs(a) % 30 === 0) ? 10 : 6;
      const t = (a - 90) * D2R;
      ctx.beginPath(); ctx.moveTo(Math.cos(t) * R, Math.sin(t) * R); ctx.lineTo(Math.cos(t) * (R + len), Math.sin(t) * (R + len)); ctx.stroke();
    }
    ctx.rotate(-r.roll_deg * D2R);
    const bankWarn = Math.abs(r.roll_deg) > 33;
    ctx.fillStyle = bankWarn ? C.amber : C.white;
    ctx.beginPath(); ctx.moveTo(0, -R + 1); ctx.lineTo(-7, -R + 12); ctx.lineTo(7, -R + 12); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = C.amber;
    ctx.beginPath(); ctx.moveTo(cx, cy - R - 1); ctx.lineTo(cx - 7, cy - R - 12); ctx.lineTo(cx + 7, cy - R - 12); ctx.closePath(); ctx.fill();
    // aircraft symbol
    ctx.fillStyle = '#000'; ctx.strokeStyle = C.amber; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx - 60, cy); ctx.lineTo(cx - 22, cy); ctx.lineTo(cx - 22, cy + 8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 60, cy); ctx.lineTo(cx + 22, cy); ctx.lineTo(cx + 22, cy + 8); ctx.stroke();
    ctx.fillStyle = C.amber; ctx.fillRect(cx - 3, cy - 3, 6, 6);

    // --- ILS deviation
    if (num(r.gs_dev_dot)) {
      const x = cx + AW / 2 + 8;
      ctx.strokeStyle = C.white; ctx.lineWidth = 1.5;
      for (const d of [-2, -1, 1, 2]) { ctx.beginPath(); ctx.arc(x, cy + d * 22, 3, 0, 7); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(x - 7, cy); ctx.lineTo(x + 7, cy); ctx.stroke();
      // above glide path -> diamond moves down (fly down)
      diamond(ctx, x, cy + Math.max(-2.3, Math.min(2.3, r.gs_dev_dot)) * 22, C.magenta);
    }
    if (num(r.loc_dev_dot)) {
      const y = cy + AH / 2 + 10;
      ctx.strokeStyle = C.white; ctx.lineWidth = 1.5;
      for (const d of [-2, -1, 1, 2]) { ctx.beginPath(); ctx.arc(cx + d * 30, y, 3, 0, 7); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(cx, y - 7); ctx.lineTo(cx, y + 7); ctx.stroke();
      // aircraft right of course -> diamond moves left
      diamond(ctx, cx - Math.max(-2.3, Math.min(2.3, r.loc_dev_dot)) * 30, y, C.magenta, true);
    }

    // --- speed tape
    const sx = 20, sw = 56, top = cy - AH / 2, bot = cy + AH / 2, ppk = 3.2;
    ctx.save(); ctx.beginPath(); ctx.rect(sx, top, sw, AH); ctx.clip();
    ctx.fillStyle = C.tape; ctx.fillRect(sx, top, sw, AH);
    // VFE red band
    const vfe = ctxInfo && ctxInfo.vfe ? ctxInfo.vfe[Math.round(r.flap)] : null;
    if (vfe) {
      const yv = cy - (vfe - r.ias_kt) * ppk;
      for (let y = yv; y > top - 10; y -= 8) { ctx.fillStyle = (Math.round((yv - y) / 8) % 2) ? '#000' : C.red; ctx.fillRect(sx + sw - 8, y - 8, 8, 8); }
    }
    ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.font = font(12); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const s0 = Math.floor((r.ias_kt - 40) / 10) * 10;
    for (let s = s0; s < r.ias_kt + 40; s += 10) {
      if (s < 30) continue;
      const y = cy - (s - r.ias_kt) * ppk;
      ctx.beginPath(); ctx.moveTo(sx + sw - 10, y); ctx.lineTo(sx + sw, y); ctx.stroke();
      if (s % 20 === 0) ctx.fillText(s, sx + sw - 13, y);
    }
    // speed trend (10 s)
    if (ctxInfo && num(ctxInfo.iasTrend) && Math.abs(ctxInfo.iasTrend) > 2) {
      const y2 = cy - ctxInfo.iasTrend * ppk;
      ctx.strokeStyle = C.green; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx + sw - 2, cy); ctx.lineTo(sx + sw - 2, y2); ctx.stroke();
    }
    // Vapp target (magenta)
    if (ctxInfo && ctxInfo.vapp && r.flap >= 3) {
      const y = cy - (ctxInfo.vapp - r.ias_kt) * ppk;
      ctx.fillStyle = C.magenta; ctx.beginPath(); ctx.moveTo(sx + sw, y); ctx.lineTo(sx + sw + 8, y - 6); ctx.lineTo(sx + sw + 8, y + 6); ctx.fill();
    }
    ctx.restore();
    box(ctx, sx - 4, cy - 13, sw + 4, 26, Math.round(r.ias_kt).toString(), vfe && r.ias_kt > vfe ? C.red : C.white, 16);
    ctx.fillStyle = C.grey; ctx.font = font(10); ctx.textAlign = 'center';
    ctx.fillText(num(r.mach) ? 'M ' + r.mach.toFixed(2).slice(1) : '', sx + sw / 2, bot + 14);

    // --- altitude tape
    const ax = 300, aw = 62, ppf = 0.16;
    ctx.save(); ctx.beginPath(); ctx.rect(ax, top, aw, AH); ctx.clip();
    ctx.fillStyle = C.tape; ctx.fillRect(ax, top, aw, AH);
    // ground (runway elevation) band
    if (ctxInfo && num(ctxInfo.groundFt)) {
      const yg = cy + (r.alt_ft - ctxInfo.groundFt) * ppf;
      ctx.fillStyle = '#c0392b'; ctx.fillRect(ax, yg, aw, 4);
      ctx.fillStyle = 'rgba(138,90,43,.6)'; ctx.fillRect(ax, yg + 4, aw, 400);
    }
    ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.font = font(11); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const a0 = Math.floor((r.alt_ft - 700) / 100) * 100;
    for (let a = a0; a < r.alt_ft + 700; a += 100) {
      const y = cy - (a - r.alt_ft) * ppf;
      ctx.beginPath(); ctx.moveTo(ax, y); ctx.lineTo(ax + 8, y); ctx.stroke();
      if (a % 500 === 0) ctx.fillText(a, ax + 11, y);
    }
    ctx.restore();
    box(ctx, ax, cy - 13, aw + 6, 26, Math.round(r.alt_ft).toString(), C.green, 15, 'left');

    // --- vertical speed
    const vx = 372, vh = 150;
    ctx.fillStyle = C.tape; ctx.fillRect(vx, cy - vh / 2, 24, vh);
    ctx.strokeStyle = C.white; ctx.lineWidth = 1;
    const vsY = v => cy - Math.sign(v) * Math.min(1, Math.sqrt(Math.abs(v) / 6000)) * vh / 2;
    ctx.font = font(9); ctx.fillStyle = C.white; ctx.textAlign = 'left';
    for (const v of [-6000, -2000, -1000, 0, 1000, 2000, 6000]) {
      const y = vsY(v); ctx.beginPath(); ctx.moveTo(vx, y); ctx.lineTo(vx + 5, y); ctx.stroke();
      if (v && Math.abs(v) !== 6000) ctx.fillText(Math.abs(v) / 1000, vx + 7, y);
    }
    const vsWarn = r.vs_fpm < -2000 || r.gpws_warn >= 0.5;
    ctx.strokeStyle = vsWarn ? C.amber : C.green; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(vx + 24, cy); ctx.lineTo(vx + 4, vsY(r.vs_fpm)); ctx.stroke();
    if (Math.abs(r.vs_fpm) > 200) {
      ctx.fillStyle = vsWarn ? C.amber : C.green; ctx.font = font(10); ctx.textAlign = 'center';
      ctx.fillText(Math.round(Math.abs(r.vs_fpm) / 100), vx + 12, r.vs_fpm > 0 ? cy - vh / 2 - 8 : cy + vh / 2 + 9);
    }

    // --- heading strip
    const hy = 352, hw2 = 170;
    ctx.save(); ctx.beginPath(); ctx.rect(cx - hw2 / 2 - 10, hy, hw2 + 20, 30); ctx.clip();
    ctx.fillStyle = C.tape; ctx.fillRect(cx - hw2 / 2 - 10, hy, hw2 + 20, 30);
    ctx.strokeStyle = C.white; ctx.fillStyle = C.white; ctx.font = font(11); ctx.textAlign = 'center';
    const hdg = num(r.hdg_mag_deg) ? r.hdg_mag_deg : r.hdg_true_deg;
    const pph = 5;
    for (let d = Math.floor(hdg - 25); d < hdg + 25; d++) {
      if (d % 5) continue;
      const x = cx + (d - hdg) * pph;
      ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, hy + (d % 10 ? 5 : 9)); ctx.stroke();
      if (d % 10 === 0) ctx.fillText(String(((d % 360) + 360) % 360 / 10).padStart(2, '0'), x, hy + 20);
    }
    // track diamond
    if (num(r.trk_true_deg)) {
      const tx = cx + angd(r.trk_true_deg, r.hdg_true_deg) * pph;
      diamond(ctx, tx, hy + 5, C.green, true, 5);
    }
    ctx.restore();
    ctx.strokeStyle = C.amber; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx, hy - 4); ctx.lineTo(cx, hy + 12); ctx.stroke();

    // --- FMA
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 400, 44);
    ctx.strokeStyle = C.grey; ctx.lineWidth = 1;
    for (const x of [80, 160, 240, 320]) { ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, 40); ctx.stroke(); }
    ctx.font = font(12); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fmaThr = r.rev >= 0.5 ? 'REV' : (r.n1_1 > 88 ? 'TOGA' : (r.athr >= 0.5 ? 'SPEED' : 'MAN'));
    text(ctx, fmaThr, 40, 14, r.rev >= 0.5 ? C.amber : C.green);
    text(ctx, (r.phase || '').replace('_', ' '), 120, 14, C.green);
    const lat = num(r.loc_dev_dot) && Math.abs(r.loc_dev_dot) < 2.4 && r.air_ground >= 0.5 ? 'LOC' : 'HDG';
    text(ctx, lat, 200, 14, C.green);
    text(ctx, r.flap >= 4 ? 'CONF FULL' : 'CONF ' + Math.round(r.flap), 280, 14, C.cyan);
    text(ctx, r.ap >= 0.5 ? 'AP1' : '', 360, 14, C.white);
    text(ctx, r.athr >= 0.5 ? 'A/THR' : '', 360, 31, C.white);
    text(ctx, r.gear >= 0.5 ? 'GEAR DN' : 'GEAR UP', 280, 31, r.gear >= 0.5 ? C.green : C.grey);
    text(ctx, r.air_ground >= 0.5 ? 'AIR' : 'GND', 40, 31, C.grey);

    // --- radio altitude
    if (num(r.ra_ft) && r.ra_ft < 2500 && r.air_ground >= 0.5) {
      ctx.font = font(18, 700); ctx.textAlign = 'center';
      ctx.fillStyle = r.ra_ft < 200 ? C.amber : C.green;
      ctx.fillText(Math.round(r.ra_ft / (r.ra_ft > 50 ? 10 : 1)) * (r.ra_ft > 50 ? 10 : 1), cx, cy + 70);
    }
    // --- warnings
    if (r.gpws_warn >= 0.5) banner(ctx, 'SINK RATE', cx, cy - 55, C.red);
    else if (Math.abs(r.roll_deg) > 35) banner(ctx, 'BANK ANGLE', cx, cy - 55, C.red);
    else if (vfe && r.ias_kt > vfe) banner(ctx, 'OVERSPEED', cx, cy - 55, C.red);
    ctx.restore();
  }

  function angd(a, b) { return ((a - b + 540) % 360) - 180; }
  function diamond(ctx, x, y, col, horiz = false, s = 7) {
    ctx.fillStyle = col; ctx.beginPath();
    ctx.moveTo(x, y - s); ctx.lineTo(x + (horiz ? s * 1.3 : s * 0.8), y); ctx.lineTo(x, y + s); ctx.lineTo(x - (horiz ? s * 1.3 : s * 0.8), y);
    ctx.closePath(); ctx.fill();
  }
  function box(ctx, x, y, w, h, txt, col, px, align = 'right') {
    ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.amber; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = col; ctx.font = font(px, 700); ctx.textBaseline = 'middle';
    ctx.textAlign = align; ctx.fillText(txt, align === 'right' ? x + w - 6 : x + 6, y + h / 2 + 1);
  }
  function text(ctx, t, x, y, col) { ctx.fillStyle = col; ctx.fillText(t, x, y); }
  function banner(ctx, t, x, y, col) {
    ctx.font = font(15, 700); const w = ctx.measureText(t).width + 16;
    ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(x - w / 2, y - 12, w, 24);
    ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, x, y);
  }

  // ------------------------------------------------------------------ ND
  // opts: {rangeNm, airports (prepared), path: [{lat,lon}], idx}
  function drawND(cv, r, opts) {
    const { ctx, w, h } = setupCanvas(cv);
    const S = Math.min(w, h) / 400;
    ctx.save();
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    ctx.translate((w - 400 * S) / 2, (h - 400 * S) / 2); ctx.scale(S, S);
    if (!r) { ctx.restore(); return; }
    const cx = 200, cy = 330, R = 270;
    const range = opts.rangeNm || 10;
    const ppn = R / range;           // px per NM
    const hdg = r.hdg_true_deg;      // true-heading up (airport data is true)
    const fr = new FDM.Frame(r.lat, r.lon);
    const toScreen = (lat, lon) => {
      const [x, y] = fr.toXY(lat, lon);
      const xn = x / 1852, yn = y / 1852;
      const a = -hdg * D2R;
      return [cx + (xn * Math.cos(a) - yn * Math.sin(a)) * ppn, cy - (xn * Math.sin(a) + yn * Math.cos(a)) * ppn];
    };
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R + 2, Math.PI, 2 * Math.PI); ctx.lineTo(400, 400); ctx.lineTo(0, 400); ctx.closePath(); ctx.clip();
    // range ring
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([4, 6]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R / 2, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
    // runways + extended centrelines
    for (const ap of Object.values(opts.airports)) {
      for (const rw of Object.values(ap.runways)) {
        if (rw.endLat == null) continue;
        const [x1, y1] = toScreen(rw.lat, rw.lon), [x2, y2] = toScreen(rw.endLat, rw.endLon);
        ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(2, rw.width_m / 1852 * ppn); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        if (rw.ils_loc_mhz) {
          const L = 10 * 1852, c = rw.true_brg * D2R;
          const fr2 = new FDM.Frame(rw.lat, rw.lon);
          const [elat, elon] = fr2.toLL(-Math.sin(c) * L, -Math.cos(c) * L);
          const [x3, y3] = toScreen(elat, elon);
          ctx.strokeStyle = 'rgba(56,217,245,.45)'; ctx.lineWidth = 1; ctx.setLineDash([6, 5]);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x3, y3); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.fillStyle = C.white; ctx.font = font(9); ctx.textAlign = 'center';
        if (range <= 20) ctx.fillText(rw.id, x1 + (x1 - x2) * 0.06, y1 + (y1 - y2) * 0.06);
      }
      const [ax, ay] = toScreen(ap.lat, ap.lon);
      ctx.fillStyle = C.cyan; ctx.font = font(11); ctx.textAlign = 'left'; ctx.fillText(ap.icao, ax + 10, ay - 8);
    }
    // flight path: flown (white) and remaining (magenta)
    if (opts.path) {
      const p = opts.path, step = Math.max(1, Math.floor(p.length / 1500));
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,92,240,.75)'; ctx.beginPath();
      for (let i = opts.idx; i < p.length; i += step) { const [x, y] = toScreen(p[i].lat, p[i].lon); i === opts.idx ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.beginPath();
      for (let i = 0; i <= opts.idx; i += step) { const [x, y] = toScreen(p[i].lat, p[i].lon); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke();
    }
    // track line
    const trk = angd(r.trk_true_deg, hdg) * D2R;
    ctx.strokeStyle = C.green; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(trk) * R, cy - Math.cos(trk) * R); ctx.stroke();
    ctx.restore();

    // compass arc
    ctx.strokeStyle = C.white; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI * 1.17, Math.PI * 1.83); ctx.stroke();
    ctx.font = font(12); ctx.fillStyle = C.white; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 5) {
      const rel = angd(d, hdg); if (Math.abs(rel) > 58) continue;
      const a = (rel - 90) * D2R, len = d % 10 ? 6 : 12;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.lineTo(cx + Math.cos(a) * (R - len), cy + Math.sin(a) * (R - len)); ctx.stroke();
      if (d % 30 === 0) ctx.fillText(String(d / 10).padStart(2, '0'), cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24));
    }
    // lubber + aircraft
    ctx.strokeStyle = C.amber; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx, cy - R - 10); ctx.lineTo(cx, cy - R + 6); ctx.stroke();
    ctx.strokeStyle = C.amber; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, cy - 16); ctx.lineTo(cx, cy + 18); ctx.moveTo(cx - 16, cy); ctx.lineTo(cx + 16, cy); ctx.moveTo(cx - 7, cy + 14); ctx.lineTo(cx + 7, cy + 14); ctx.stroke();
    // range label
    ctx.fillStyle = C.cyan; ctx.font = font(10); ctx.textAlign = 'left';
    ctx.fillText((range / 2) + ' NM', cx + R / 2 * 0.72 + 6, cy - R / 2 * 0.72);
    // data block
    ctx.font = font(12); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    text(ctx, 'GS', 8, 8, C.white); text(ctx, String(Math.round(r.gs_kt)), 32, 8, C.green);
    text(ctx, 'TAS', 76, 8, C.white); text(ctx, String(Math.round(r.tas_kt || 0)), 108, 8, C.green);
    if (num(r.wind_dir_deg)) {
      text(ctx, `${String(Math.round(r.wind_dir_deg)).padStart(3, '0')}°/${Math.round(r.wind_spd_kt)}`, 8, 26, C.green);
      // wind arrow relative to heading (points where the wind blows)
      const a = (angd(r.wind_dir_deg + 180, hdg)) * D2R, ox = 22, oy = 62;
      ctx.strokeStyle = C.green; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(ox - Math.sin(a) * 12, oy + Math.cos(a) * 12); ctx.lineTo(ox + Math.sin(a) * 12, oy - Math.cos(a) * 12); ctx.stroke();
      ctx.beginPath(); ctx.arc(ox + Math.sin(a) * 12, oy - Math.cos(a) * 12, 3, 0, 7); ctx.fillStyle = C.green; ctx.fill();
    }
    ctx.textAlign = 'right';
    text(ctx, 'HDG ' + String(Math.round(r.hdg_true_deg)).padStart(3, '0') + 'T', 392, 8, C.white);
    if (opts.nearest) text(ctx, opts.nearest, 392, 26, C.cyan);
    ctx.restore();
  }

  global.Instruments = { drawPFD, drawND };
})(window);
