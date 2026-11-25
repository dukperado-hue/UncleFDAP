// Command-line front end for js/importer.js (same code the browser wizard uses).
//   node tools/import_cli.js <file.csv> [--template g1000] [--profile C172] [--out x.csv] [--qc x.json]
//   node tools/import_cli.js --all        (every CSV in data/samples/index.json -> *.normalized.csv + *.qc.json)
// Excel files need the browser (SheetJS); export the sheet as CSV for the CLI.
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
require(path.join(__dirname, '..', 'js', 'events.js'));
const Importer = require(path.join(__dirname, '..', 'js', 'importer.js'));

const root = path.join(__dirname, '..');
const J = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const rawCfg = J('data/events-config.json');
const airports = FDM.prepareAirports(J('data/airports.json'));
const templates = J('data/import-templates.json').templates;

function importFile(file, { template, profile } = {}) {
  const { delim, rows } = Importer.parseDelimited(fs.readFileSync(file, 'utf8'));
  const layout = Importer.detectLayout(rows);
  const tpl = template ? templates.find(t => t.id === template) : Importer.matchTemplate(templates, layout.columns);
  const mapping = Importer.autoMapping(layout.columns, tpl);
  if (profile) mapping.profile = profile;
  const res = Importer.run(rows, layout, mapping, { rawCfg, airports, delim });
  return { res, mapping, layout, tpl };
}

function summary(name, { res, tpl }) {
  const q = res.qc;
  console.log(`${name}: template=${tpl ? tpl.id : 'none'} profile=${res.cfg.profile} rows=${res.rows.length} score=${q.score} ${q.verdict}`);
  for (const c of q.checks) if (c.sev !== 'ok') console.log(`   [${c.sev}] ${c.en}`);
}

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--all')) {
  const dir = path.join(root, 'data', 'samples');
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  for (const f of idx.flights) {
    const r = importFile(path.join(dir, f.file), { template: f.template, profile: f.profile });
    fs.writeFileSync(path.join(dir, f.normalized_file), Importer.toCSV(r.res.rows));
    fs.writeFileSync(path.join(dir, f.id + '.qc.json'), JSON.stringify(r.res.qc, null, 1));
    f.qc_file = f.id + '.qc.json';
    f.qc_score = r.res.qc.score; f.qc_verdict = r.res.qc.verdict;
    summary(f.id, r);
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx, null, 1));
} else if (args[0]) {
  const r = importFile(args[0], { template: opt('--template'), profile: opt('--profile') });
  summary(path.basename(args[0]), r);
  if (opt('--out')) fs.writeFileSync(opt('--out'), Importer.toCSV(r.res.rows));
  if (opt('--qc')) fs.writeFileSync(opt('--qc'), JSON.stringify(r.res.qc, null, 1));
} else {
  console.log('usage: node tools/import_cli.js <file.csv> [--template id] [--profile C172] [--out x.csv] [--qc x.json] | --all');
}
