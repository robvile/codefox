// scripts/eval-runner.js — the eval harness runner (v0.18.0).
//
// Spawns Electron with --eval-* flags, waits for the results JSON,
// prints a readable summary + flips vs the previous run of the
// same suite, and exits 0 (every task passed) or 1 (anything
// failed, or the run itself broke).
//
//   npm run eval              (canary, 1 run per task)
//   npm run eval:canary       (same, explicit)
//   node scripts/eval-runner.js --suite full --runs 3
//   node scripts/eval-runner.js --task fix-syntax --mock
//   node scripts/eval-runner.js --suite canary --mock
//
// Options: --suite canary|full (default canary), --task <id>,
//   --runs <n> (1-5, default 1), --mock (canned replies, no Unity
//   and no model — proves the pipeline, not the model),
//   --out <path> (results JSON), --project <dir> (fixture project
//   folder), --no-sanity (skip the baseline + reference sanity
//   runs — quicker, weaker), --timeout <minutes> (default 60).
//
// A mock run prints its warning prominently: its task passes prove
// the harness pipeline, not the model. Live runs need Unity open
// on the fixture project and the LM Studio model loaded.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EvalTasks = require('../eval/eval-tasks.js');
const appDir = path.join(__dirname, '..');

function parseArgs(argv) {
  const o = { suite: 'canary', task: null, runs: 1, mock: false, out: null, project: null, noSanity: false, timeoutMin: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--suite') o.suite = next();
    else if (a === '--task') o.task = next();
    else if (a === '--runs') o.runs = Math.max(1, Math.min(5, parseInt(next(), 10) || 1));
    else if (a === '--mock') o.mock = true;
    else if (a === '--out') o.out = next();
    else if (a === '--project') o.project = next();
    else if (a === '--no-sanity') o.noSanity = true;
    else if (a === '--timeout') o.timeoutMin = Math.max(1, parseInt(next(), 10) || 60);
    else if (a === '--help' || a === '-h') { o.help = true; }
    else { console.error('unknown option: ' + a); o.help = true; }
  }
  if (o.task) o.suite = 'single';
  return o;
}

function usage() {
  console.log([
    'usage: node scripts/eval-runner.js [--suite canary|full] [--task <id>]',
    '         [--runs 1-5] [--mock] [--out <path>] [--project <dir>]',
    '         [--no-sanity] [--timeout <minutes>]',
    '',
    'Runs the eval harness in Electron (headless). Live runs need',
    'Unity open on the fixture project and the LM Studio model',
    'loaded. Mock runs need neither — they prove the pipeline,',
    'not the model.',
  ].join('\n'));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function readJsonQuiet(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); process.exit(opts.help && process.argv.slice(2).length ? 1 : 0); }
  if (opts.suite !== 'canary' && opts.suite !== 'full' && opts.suite !== 'single') {
    console.error('suite must be canary or full (or --task for one task)');
    process.exit(1);
  }

  const electron = require('electron');
  const runId = 'eval-' + opts.suite + '-' + stamp();
  const outDir = path.join(appDir, 'eval', 'results', runId);
  const outPath = opts.out ? path.resolve(opts.out) : path.join(outDir, 'results.json');
  const workDir = path.join(appDir, 'eval-work');
  const projectDir = opts.project ? path.resolve(opts.project) : path.join(workDir, runId, 'project');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const flags = [
    '.',
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--eval-suite=' + opts.suite,
    '--eval-runs=' + opts.runs,
    '--eval-out=' + outPath,
    '--eval-work=' + workDir,
    '--eval-project=' + projectDir,
    '--eval-run-id=' + runId,
  ];
  if (opts.task) flags.push('--eval-task=' + opts.task);
  if (opts.mock) flags.push('--eval-mock=1');
  if (opts.noSanity) flags.push('--eval-no-sanity=1');

  console.log('eval run ' + runId);
  console.log('  suite: ' + opts.suite + (opts.task ? ' (task ' + opts.task + ')' : '') + '  runs: ' + opts.runs + (opts.mock ? '  MOCK' : ''));
  console.log('  project: ' + projectDir);
  console.log('  results: ' + outPath);
  if (opts.mock) console.log('  NOTE: mock mode — canned replies, no Unity, no model. Task passes here prove the harness pipeline, not the model.');
  else console.log('  NOTE: live run — Unity must be open on the fixture project and the LM Studio model loaded.');

  const env = Object.assign({}, process.env);
  if (process.platform === 'linux' && !env.DISPLAY) env.DISPLAY = ':99';
  const child = spawn(electron, flags, { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrTail = '';
  child.stderr.on('data', (d) => { stderrTail += String(d); if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000); });
  // Electron logs to stdout too; keep it quiet unless the run fails.
  let stdoutTail = '';
  child.stdout.on('data', (d) => { stdoutTail += String(d); if (stdoutTail.length > 8000) stdoutTail = stdoutTail.slice(-8000); });

  const deadline = Date.now() + opts.timeoutMin * 60 * 1000;
  let lastProgress = '';
  let childExited = null;
  child.on('exit', (code, signal) => { childExited = { code, signal }; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let results = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(outPath)) {
      results = readJsonQuiet(outPath);
      if (results) break;
    }
    const prog = readJsonQuiet(path.join(path.dirname(outPath), 'progress.json'));
    if (prog) {
      const line = prog.currentTask + ' run ' + prog.currentRun + ' (' + prog.done + '/' + prog.total + ')';
      if (line !== lastProgress) { lastProgress = line; console.log('  … ' + line); }
    }
    if (childExited && !fs.existsSync(outPath)) break;
    await sleep(2000);
  }
  if (!results) {
    console.error('\nFAILED: no results file appeared' + (childExited ? ' (Electron exited code ' + childExited.code + ')' : ' (timed out after ' + opts.timeoutMin + ' min)') + '.');
    if (stderrTail.trim()) console.error('Electron stderr (tail):\n' + stderrTail.trim().slice(-3000));
    if (stdoutTail.trim()) console.error('Electron stdout (tail):\n' + stdoutTail.trim().slice(-3000));
    process.exit(1);
  }
  // Give the app a moment to quit cleanly, then move on.
  const waitExit = Date.now() + 10000;
  while (!childExited && Date.now() < waitExit) { await sleep(500); }
  if (!childExited) { try { child.kill(); } catch (e) {} }

  // Flips vs the previous run of the same suite.
  const latestPath = path.join(appDir, 'eval', 'results', 'latest-' + opts.suite + '.json');
  const prev = readJsonQuiet(latestPath);
  let flips = [];
  if (prev && Array.isArray(prev.tasks)) {
    const prevMap = {};
    prev.tasks.forEach((t) => { prevMap[t.id] = !!t.pass; });
    const currMap = {};
    results.tasks.forEach((t) => { currMap[t.id] = !!t.pass; });
    flips = EvalTasks.detectFlips(prevMap, currMap);
  }
  try { fs.mkdirSync(path.dirname(latestPath), { recursive: true }); fs.writeFileSync(latestPath, JSON.stringify(results, null, 2)); } catch (e) {}

  // ── Summary ──────────────────────────────────────────────────
  const s = results.summary || { total: 0, passed: 0, passRate: 0, byTag: {} };
  console.log('\n' + (results.mock ? '[MOCK] ' : '') + 'eval ' + results.runId + ' — ' + s.passed + '/' + s.total + ' tasks passed (' + Math.round(s.passRate * 100) + '%)');
  console.log('  result key: ' + ((results.resultKey && results.resultKey.key) || '?'));
  if (results.unityAvailable === false) console.log('  Unity: not answering (Unity-backed checks skipped)');
  for (const t of (results.tasks || [])) {
    const mark = t.pass ? 'PASS' : 'FAIL';
    const ci = ' [' + Math.round(t.ciLow * 100) + '–' + Math.round(t.ciHigh * 100) + '%]';
    console.log('  ' + mark + '  ' + t.id + ' — ' + Math.round(t.passRate * 100) + '% over ' + t.runs.length + ' run(s)' + (t.consistent ? '' : '  INCONSISTENT') + ci);
    for (const r of (t.runs || [])) {
      if (r.pass) continue;
      const failed = (r.checks || []).filter((c) => !c.pass && !c.skipped);
      const skipped = (r.checks || []).filter((c) => c.skipped);
      console.log('        run ' + r.run + ': ' + (failed.map((c) => c.type + ' — ' + (c.detail || '')).join('; ') || 'no failing check?') + (r.baselineOk === false ? ' [baseline sanity failed]' : '') + (r.referenceOk === false ? ' [reference failed: ' + (r.referenceDetail || '') + ']' : '') + (skipped.length ? ' [skipped: ' + skipped.map((c) => c.type).join(', ') + ']' : '') + (r.error ? ' [harness error: ' + r.error + ']' : ''));
    }
  }
  if (Object.keys(s.byTag || {}).length) {
    console.log('  by tag: ' + Object.keys(s.byTag).sort().map((tag) => tag + ' ' + s.byTag[tag].passed + '/' + s.byTag[tag].total).join(', '));
  }
  if (flips.length) {
    console.log('  flips vs previous ' + opts.suite + ' run:');
    for (const f of flips) console.log('    ' + (f.regression ? 'REGRESSION' : 'improvement') + '  ' + f.id + '  ' + (f.from ? 'pass' : 'fail') + ' -> ' + (f.to ? 'pass' : 'fail'));
  } else if (prev) {
    console.log('  flips vs previous ' + opts.suite + ' run: none');
  }
  if (results.mock) console.log('  (mock run — see the NOTE above; run live for real pass rates)');
  process.exit(s.total > 0 && s.passed === s.total ? 0 : 1);
}

main().catch((e) => { console.error('runner failed:', e && e.message ? e.message : e); process.exit(1); });
