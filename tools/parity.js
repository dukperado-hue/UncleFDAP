// Run the browser event/measurement code (js/events.js) under Node for a list of
// flight CSVs and print JSON. tools/parity.py compares this with the Python output.
//   node tools/parity.js <profile> <vapp> <file.csv> [...]
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
require(path.join(__dirname, '..', 'js', 'events.js'));

const root = path.join(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'events-config.json'), 'utf8'));
const airports = FDM.prepareAirports(JSON.parse(fs.readFileSync(path.join(root, 'data', 'airports.json'), 'utf8')));

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  const head = lines[0].split(',').map(s => s.trim());
  return lines.slice(1).map(l => {
    const v = l.split(','), o = {};
    head.forEach((k, i) => {
      const x = v[i] === undefined ? '' : v[i];
      o[k] = (k === 'utc' || k === 'phase') ? x : (x === '' ? NaN : (Number.isFinite(+x) ? +x : NaN));
    });
    return o;
  });
}

const [profile, vapp, ...files] = process.argv.slice(2);
const cfg = FDM.resolveConfig(raw, profile === '-' ? null : profile);
const out = {};
for (const f of files) {
  const rows = parseCSV(fs.readFileSync(f, 'utf8'));
  const v = vapp === '-' ? null : +vapp;
  out[path.basename(f)] = {
    events: FDM.detectEvents(rows, cfg, airports, v).map(e => ({ code: e.code, level: e.level, t_peak: e.t_peak, value: e.value })),
    measures: FDM.measurements(rows, cfg, airports, v),
  };
}
process.stdout.write(JSON.stringify(out));
