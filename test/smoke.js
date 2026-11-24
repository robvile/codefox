// CodeFox smoke test — plain Node, no dependencies.
// Run: node test/smoke.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ' (' + detail + ')' : ''));
  if (!ok) failures++;
}

// 1. Syntax-check every JS file we ship.
for (const file of ['main.js', 'preload.js', 'app.js', 'test/smoke.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
    check('node --check ' + file, true);
  } catch (e) {
    check('node --check ' + file, false, String(e.message).split('\n')[0]);
  }
}

// 2. package.json version is 0.2.0.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check('package.json version is 0.2.0', pkg.version === '0.2.0', 'got ' + pkg.version);
check('package.json has test script', typeof pkg.scripts.test === 'string' && pkg.scripts.test.includes('test/smoke.js'));

// 3. No occurrence of the forbidden word (case-insensitive) in any
// tracked text file, excluding .git and node_modules.
const FORBIDDEN = String.fromCharCode(98, 101, 122, 105); // built from codes so this file itself does not contain the word
const textExts = new Set(['.js', '.json', '.md', '.html', '.cs', '.ps1', '.nsh', '.txt']);
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (textExts.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}
const badFiles = [];
for (const file of walk(root)) {
  const content = fs.readFileSync(file, 'utf8');
  if (content.toLowerCase().includes(FORBIDDEN)) badFiles.push(path.relative(root, file));
}
check('no forbidden word in repo text files', badFiles.length === 0, badFiles.join(', '));

// 4. README mentions LM Studio and "Verify connection".
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
check('README mentions LM Studio', readme.includes('LM Studio'));
check('README mentions "Verify connection"', readme.includes('Verify connection'));

// 5. main.js contains the LM Studio endpoints.
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
check("main.js contains 'v1/models'", mainJs.includes('v1/models'));
check("main.js contains 'chat/completions'", mainJs.includes('chat/completions'));
check('main.js has llm:chat handler', mainJs.includes("ipcMain.handle('llm:chat'"));
check('main.js has project:scan handler', mainJs.includes("ipcMain.handle('project:scan'"));
check('main.js has unity:runTests handler', mainJs.includes("ipcMain.handle('unity:runTests'"));
check('main.js has unity:buildCheck handler', mainJs.includes("ipcMain.handle('unity:buildCheck'"));

// 6. app.js has the modes, tools, and diff preview.
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
check('app.js has Ask/Plan/Agent modes', appJs.includes("setChatMode") && appJs.includes("'ask'") && appJs.includes("'plan'") && appJs.includes("'agent'"));
check('app.js has diff preview', appJs.includes('showDiffOverlay') && appJs.includes('diffLines'));
check('app.js uses rb.llm.chat', appJs.includes('rb.llm.chat'));
check('app.js has no hardcoded Unity version prompt', !appJs.includes('Unity 6000.3'));

if (failures) {
  console.log('\n' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
