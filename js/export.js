// CSV and PDF export (client-side; nothing leaves the browser).
(function (global) {
  'use strict';

  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const esc = v => {
    if (v == null || (typeof v === 'number' && Number.isNaN(v))) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const LEVEL_TXT = { 1: 'INFO', 2: 'CAUTION', 3: 'WARNING' };

  function eventsCSV(flight, events) {
    const head = ['flight_id', 'code', 'level', 'level_name', 'event', 'event_th', 't_start_s', 't_end_s', 't_peak_s', 'value', 'unit', 'detail'];
    const lines = [head.join(',')];
    for (const e of events) lines.push([flight.id, e.code, e.level, LEVEL_TXT[e.level], e.name, e.th, e.t_start, e.t_end, e.t_peak, e.value, e.unit, e.detail].map(esc).join(','));
    // BOM so Excel opens Thai text correctly
    download(`${flight.id}_events.csv`, new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
  }

  function dataCSV(flight, rows, t0, t1, suffix = '') {
    const cols = Object.keys(rows[0]);
    const lines = [cols.join(',')];
    for (const r of rows) if (r.time_s >= t0 && r.time_s <= t1) lines.push(cols.map(c => esc(r[c])).join(','));
    download(`${flight.id}${suffix}.csv`, new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
  }

  // canvases: [{title, canvas}] ; snaps: {scene, pfd, nd} data URLs ; at: row at snapshot time
  function pdfReport({ flight, rows, events, summary, snaps, snapRow, charts }) {
    const { jsPDF } = global.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const W = 210, M = 12;
    const header = (title) => {
      doc.setFillColor(11, 15, 20); doc.rect(0, 0, W, 16, 'F');
      doc.setTextColor(255, 176, 0); doc.setFontSize(12); doc.setFont('helvetica', 'bold');
      doc.text('FDM REPLAY - FLIGHT DATA REPORT', M, 10);
      doc.setTextColor(255, 255, 255); doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      doc.text(title, W - M, 10, { align: 'right' });
      doc.setTextColor(200, 30, 30); doc.setFontSize(8);
      doc.text('SYNTHETIC / DEMONSTRATION DATA - NOT FOR OPERATIONAL USE', W / 2, 14.5, { align: 'center' });
      doc.setTextColor(20, 20, 20);
    };
    header(flight.id);
    let y = 24;
    doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.text(flight.title || flight.id, M, y); y += 6;
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    const meta = [
      ['Flight ID', flight.id], ['Aircraft', `${flight.aircraft || '-'}  ${flight.registration || ''}`],
      ['Callsign', flight.callsign || '-'], ['Date (UTC)', flight.date || (rows[0].utc || '').slice(0, 10)],
      ['Airport / RWY', `${flight.airport || '-'} ${flight.runway || ''}`], ['Duration', fmtT(summary.duration_s)],
      ['Take-off', summary.takeoffs.map(x => `${x.rwy} @${fmtT(x.t)} IAS ${x.ias_kt}`).join('; ') || '-'],
      ['Landing', summary.landings.map(x => `${x.rwy} @${fmtT(x.t)} TD ${x.along_m ?? '?'} m past THR, IAS ${x.ias_kt}`).join('; ') || '-'],
      ['Max ALT / IAS / Nz', `${summary.max_alt_ft.toFixed(0)} ft / ${summary.max_ias_kt.toFixed(0)} kt / ${summary.max_nz_g.toFixed(2)} g`],
    ];
    doc.autoTable({ startY: y, body: meta, theme: 'plain', styles: { fontSize: 8.5, cellPadding: 1 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 38 } }, margin: { left: M, right: M } });
    y = doc.lastAutoTable.finalY + 4;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(`Events detected: ${events.length}`, M, y); y += 2;
    doc.autoTable({ startY: y,
      head: [['#', 'Level', 'Event', 'Time', 'Value', 'Detail']],
      body: events.map((e, i) => [i + 1, LEVEL_TXT[e.level], e.name, fmtT(e.t_peak), e.value == null ? '' : `${e.value} ${e.unit}`, e.detail]),
      styles: { fontSize: 7.5, cellPadding: 1.2 }, headStyles: { fillColor: [40, 46, 56] },
      columnStyles: { 0: { cellWidth: 7 }, 1: { cellWidth: 17 }, 2: { cellWidth: 48 }, 3: { cellWidth: 12 }, 4: { cellWidth: 26 } },
      didParseCell: d => {
        if (d.section === 'body' && d.column.index === 1) {
          const lv = events[d.row.index].level;
          d.cell.styles.textColor = lv === 3 ? [200, 30, 30] : lv === 2 ? [190, 120, 0] : [20, 120, 160];
          d.cell.styles.fontStyle = 'bold';
        }
      }, margin: { left: M, right: M } });
    y = doc.lastAutoTable.finalY + 6;
    if (snaps && snaps.scene) {
      if (y > 200) { doc.addPage(); header(flight.id); y = 24; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text(`Replay snapshot at t = ${fmtT(snapRow.time_s)} (${snapRow.utc || ''})`, M, y); y += 3;
      const iw = W - 2 * M, ih = iw * 0.5;
      doc.addImage(snaps.scene, 'JPEG', M, y, iw, ih); y += ih + 3;
      const pw = (iw - 4) / 2;
      if (y + pw > 285) { doc.addPage(); header(flight.id); y = 24; }
      if (snaps.pfd) doc.addImage(snaps.pfd, 'PNG', M, y, pw, pw);
      if (snaps.nd) doc.addImage(snaps.nd, 'PNG', M + pw + 4, y, pw, pw);
      y += pw + 4;
    }
    // charts, 4 per page
    doc.addPage(); header(flight.id); y = 22;
    for (const c of charts) {
      const iw = W - 2 * M, ih = iw * c.canvas.height / c.canvas.width;
      if (y + ih + 6 > 290) { doc.addPage(); header(flight.id); y = 22; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text(c.title, M, y + 3);
      const img = whiteBg(c.canvas);
      doc.addImage(img, 'JPEG', M, y + 5, iw, ih); y += ih + 9;
    }
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFontSize(7); doc.setTextColor(120);
      doc.text(`Generated ${new Date().toISOString().slice(0, 19)}Z by FDM Replay (github) - page ${i}/${n}`, W / 2, 293, { align: 'center' });
    }
    doc.save(`${flight.id}_report.pdf`);
  }

  // uPlot canvases are transparent with light strokes; draw on a dark panel so they stay legible in print
  function whiteBg(cv) {
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
    const x = c.getContext('2d'); x.fillStyle = '#11161d'; x.fillRect(0, 0, c.width, c.height); x.drawImage(cv, 0, 0);
    return c.toDataURL('image/jpeg', 0.82);
  }

  global.Exporter = { eventsCSV, dataCSV, pdfReport };
})(window);
