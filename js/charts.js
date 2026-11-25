// Time-series charts (uPlot), synced cursor, event bands, click-to-seek.
(function (global) {
  'use strict';
  const LEVEL_FILL = { 1: 'rgba(56,217,245,.16)', 2: 'rgba(255,176,0,.20)', 3: 'rgba(255,59,59,.24)' };

  const PANELS = [
    { id: 'alt', title: 'Altitude / Radio altitude (ft)', series: [['alt_ft', 'ALT', '#3be07a'], ['ra_ft', 'RA', '#ffb000']] },
    { id: 'spd', title: 'Speed (kt)', series: [['ias_kt', 'IAS', '#f4f6f8'], ['gs_kt', 'GS', '#38d9f5'], ['vfe', 'VFE', '#ff3b3b', [6, 4]]] },
    { id: 'vs', title: 'Vertical speed (fpm)', series: [['vs_fpm', 'V/S', '#3be07a']] },
    { id: 'att', title: 'Pitch / Roll (deg)', series: [['pitch_deg', 'PITCH', '#38d9f5'], ['roll_deg', 'ROLL', '#ff5cf0']] },
    { id: 'nz', title: 'Normal load factor (g)', series: [['nz_g', 'Nz', '#ffb000']] },
    { id: 'n1', title: 'Engine N1 (%)', series: [['n1_1', 'N1 ENG1', '#3be07a'], ['n1_2', 'N1 ENG2', '#38d9f5', [4, 3]]] },
    { id: 'ils', title: 'ILS deviation (dot)', series: [['loc_dev_dot', 'LOC', '#ff5cf0'], ['gs_dev_dot', 'G/S', '#38d9f5']] },
    { id: 'disc', title: 'Configuration / discretes', series: [['flap', 'FLAP', '#38d9f5'], ['gear', 'GEAR', '#3be07a'], ['ap', 'AP', '#f4f6f8'], ['gpws_warn', 'GPWS', '#ff3b3b']], stepped: true },
  ];

  const Charts = {
    plots: [], markers: [], onSeek: null, events: [],

    build(container, rows, events, vfeTable) {
      this.destroy();
      container.innerHTML = '';
      this.events = events;
      const t = rows.map(r => r.time_s);
      const col = k => rows.map(r => {
        if (k === 'vfe') { const f = Math.round(r.flap); return vfeTable[f] || null; }
        const v = r[k]; return (typeof v === 'number' && !Number.isNaN(v)) ? v : null;
      });
      const width = Math.max(300, container.clientWidth - 2);
      const sync = uPlot.sync('fdm');
      const self = this;
      for (const p of PANELS) {
        const present = p.series.filter(([k]) => k === 'vfe' || rows.some(r => typeof r[k] === 'number' && !Number.isNaN(r[k])));
        if (!present.length) continue;
        const wrap = document.createElement('div');
        wrap.className = 'chart';
        container.appendChild(wrap);
        const data = [t, ...present.map(([k]) => col(k))];
        const opts = {
          title: p.title, width, height: p.id === 'disc' ? 110 : 140,
          cursor: { sync: { key: sync.key, setSeries: false }, drag: { x: true, y: false } },
          legend: { live: true },
          scales: { x: { time: false } },
          axes: [
            { stroke: '#8a94a6', grid: { stroke: 'rgba(255,255,255,.06)' }, ticks: { stroke: 'rgba(255,255,255,.1)' },
              values: (u, vals) => vals.map(v => fmtT(v)) },
            { stroke: '#8a94a6', grid: { stroke: 'rgba(255,255,255,.06)' }, ticks: { stroke: 'rgba(255,255,255,.1)' }, size: 52 },
          ],
          series: [{ label: 't', value: (u, v) => v == null ? '-' : fmtT(v) },
            ...present.map(([k, label, stroke, dash]) => ({ label, stroke, width: 1.6, dash,
              paths: p.stepped ? uPlot.paths.stepped({ align: 1 }) : undefined,
              value: (u, v) => v == null ? '-' : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) }))],
          hooks: {
            drawClear: [u => self.drawBands(u)],
            setSelect: [u => {
              if (u.select.width > 4) {
                const a = u.posToVal(u.select.left, 'x'), b = u.posToVal(u.select.left + u.select.width, 'x');
                self.plots.forEach(o => { if (o !== u) o.setScale('x', { min: a, max: b }); });
              }
            }],
          },
        };
        const u = new uPlot(opts, data, wrap);
        sync.sub(u);
        u.over.addEventListener('dblclick', () => self.plots.forEach(o => o.setScale('x', { min: t[0], max: t[t.length - 1] })));
        u.over.addEventListener('click', () => {
          if (u.select.width > 4) return;
          const v = u.posToVal(u.cursor.left, 'x');
          if (self.onSeek && Number.isFinite(v)) self.onSeek(v);
        });
        const mk = document.createElement('div');
        mk.className = 'chart-marker';
        u.over.appendChild(mk);
        this.plots.push(u); this.markers.push(mk);
      }
    },

    drawBands(u) {
      const ctx = u.ctx, { top, height } = u.bbox;
      ctx.save();
      for (const e of this.events) {
        const x0 = u.valToPos(e.t_start - 1, 'x', true), x1 = u.valToPos(e.t_end + 1, 'x', true);
        ctx.fillStyle = LEVEL_FILL[e.level] || LEVEL_FILL[1];
        ctx.fillRect(x0, top, Math.max(3, x1 - x0), height);
      }
      ctx.restore();
    },

    setTime(tsec) {
      this.plots.forEach((u, i) => {
        const x = u.valToPos(tsec, 'x');
        const mk = this.markers[i];
        if (x < 0 || x > u.over.clientWidth) { mk.style.display = 'none'; return; }
        mk.style.display = 'block'; mk.style.left = x + 'px';
      });
    },

    resize(container) {
      const w = Math.max(300, container.clientWidth - 2);
      this.plots.forEach(u => u.setSize({ width: w, height: u.height }));
    },

    canvases() { return this.plots.map(u => ({ title: u.root.querySelector('.u-title')?.textContent || '', canvas: u.ctx.canvas })); },

    destroy() { this.plots.forEach(u => u.destroy()); this.plots = []; this.markers = []; },
  };

  function fmtT(v) {
    const s = Math.max(0, Math.round(v)); const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  global.Charts = Charts;
  global.fmtT = fmtT;
})(window);
