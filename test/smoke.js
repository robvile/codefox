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

// 2. package.json version is 0.4.0.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check('package.json version is 0.4.0', pkg.version === '0.4.0', 'got ' + pkg.version);
check('installer has one unversioned name', pkg.build && pkg.build.artifactName === 'CodeFox-Setup.${ext}', 'got ' + (pkg.build && pkg.build.artifactName));
check('build scripts clean dist first', typeof pkg.scripts['build:win'] === 'string' && pkg.scripts['build:win'].includes('npm run clean'));
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

// 7. v0.3.0 Home view: Conversations / References renames, New Project,
// project IPC, skills table — and no trace of the removed items.
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
check('index.html has Conversations', indexHtml.includes('Conversations'));
check('index.html has References', indexHtml.includes('References'));
check('app.js has Conversations rename', appJs.includes('New conversation') && appJs.includes('conversations-list'));
check('app.js has References', appJs.includes('References'));
check('index.html has New Project entry point', indexHtml.includes('New Project') || appJs.includes('New Project'));
check('app.js has New Project', appJs.includes('New Project'));
check('main.js has project:list IPC', mainJs.includes("ipcMain.handle('project:list'"));
check('main.js has project:create IPC', mainJs.includes("ipcMain.handle('project:create'"));
check('main.js has project:switch IPC', mainJs.includes("ipcMain.handle('project:switch'"));
check('main.js has project:update IPC', mainJs.includes("ipcMain.handle('project:update'"));
check('main.js has project:delete IPC', mainJs.includes("ipcMain.handle('project:delete'"));
check('main.js has projects table', mainJs.includes('CREATE TABLE IF NOT EXISTS projects'));
check('main.js has skills table', mainJs.includes('CREATE TABLE IF NOT EXISTS skills'));
check('main.js has unity:installBridge IPC', mainJs.includes("ipcMain.handle('unity:installBridge'"));
check('main.js migrates project_id onto threads', mainJs.includes('ADD COLUMN project_id'));
for (const [label, content] of [['index.html', indexHtml], ['app.js', appJs], ['README', readme]]) {
  check(label + ' has no removed proofs section', !content.includes('All ' + 'Proofs'));
  check(label + ' has no workspace-named project button', !content.includes('New ' + 'Workspace'));
}
check('app.js has Home mode', appJs.includes("'home'") && appJs.includes('showHome'));
check('no Unreal UI elements', !indexHtml.includes('conn-unreal') && !indexHtml.includes('Unreal') && !appJs.includes('Unreal') && !appJs.includes('onUnrealCard'));
check('kitsune nine-tails mark present', indexHtml.includes('kitsune-mark'));
check('app.js has skills grid', appJs.includes('renderSkillsGrid') && appJs.includes('/document-project') && appJs.includes('/audit-project-structure'));
check('app.js has connections view', appJs.includes('renderConnectionsView') && appJs.includes('installUnityBridge'));
check('app.js has no Invite button', !appJs.includes('Invite') && !indexHtml.includes('Invite'));
check('README mentions multiple projects', readme.includes('Multiple projects') || readme.includes('New Project'));
check('README has planned-collaboration note', readme.includes('Working together (planned)'));

const preloadJs = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

// 8. v0.4.0 Settings as a full window — centre view, no modal.
check('app.js has Settings centre view', (appJs.includes("setMode('settings'") || appJs.includes('showSettingsView')) && appJs.includes('showSettings') && !appJs.includes('function openSettings'));
check('index.html has settings-mode element', indexHtml.includes('settings-mode'));
check('index.html Settings nav opens the view', indexHtml.includes("onclick=\"showSettings()\""));
check('main.js has unity:removeBridge IPC', mainJs.includes("ipcMain.handle('unity:removeBridge'"));
check('main.js has shell:run IPC', mainJs.includes("ipcMain.handle('shell:run'"));
check('preload.js exposes rb.shell', preloadJs.includes('shell:') && preloadJs.includes("ipcRenderer.invoke('shell:run'"));
check('preload.js exposes unity.removeBridge', preloadJs.includes('removeBridge'));
check('shell defaults off', mainJs.includes("'shell_enabled', '0'") && mainJs.includes('Shell tool is disabled'));
check('app.js has rules budget + condensed rules', appJs.includes('rules_char_budget') && appJs.includes('condensed_rules'));
check('app.js has ruleset enabled/priority', appJs.includes('toggleRulesetEnabled') && appJs.includes('moveRulesetPriority'));
check('excluded file types present', mainJs.includes('excluded_file_types') && appJs.includes('excluded_file_types') && mainJs.includes('isExcludedFile'));
check('MCPs section present', (indexHtml.includes('MCPs') || appJs.includes('MCPs')) && appJs.includes('mcp_servers'));
check('app.js has shell command bar', appJs.includes('shell-bar') && appJs.includes('handleShellBlocks'));
check('app.js has auto-accept gating', appJs.includes('autoAcceptChanges') && appJs.includes('applyFileChanges(changes)'));
for (const [label, content] of [['index.html', indexHtml], ['app.js', appJs], ['README', readme]]) {
  check(label + ' has no "Workspace settings"', !content.includes('Workspace settings'));
}

// 9. v0.4.0 app icon — kitsune mark as the packaged icon.
// Binaries cannot be pushed through the text-only push flow, so the repo
// stores them as base64 and scripts/prepare-icons.js regenerates them.
// Check the .b64 files decode to real PNG / ICO magic bytes.
function b64DecodesTo(file, magic) {
  try {
    const buf = Buffer.from(fs.readFileSync(path.join(root, file), 'utf8').trim(), 'base64');
    return buf.length > 1000 && buf.subarray(0, magic.length).equals(Buffer.from(magic));
  } catch { return false; }
}
check('build/icon.png.b64 decodes to a PNG', b64DecodesTo('build/icon.png.b64', [0x89, 0x50, 0x4e, 0x47]));
check('build/icon.ico.b64 decodes to an ICO', b64DecodesTo('build/icon.ico.b64', [0x00, 0x00, 0x01, 0x00]));
check('scripts/prepare-icons.js exists', fs.existsSync(path.join(root, 'scripts', 'prepare-icons.js')));
check('build scripts regenerate icons first', typeof pkg.scripts['build:win'] === 'string' && pkg.scripts['build:win'].includes('scripts/prepare-icons.js'));
check('package.json win icon is build/icon.ico', pkg.build && pkg.build.win && pkg.build.win.icon === 'build/icon.ico', 'got ' + (pkg.build && pkg.build.win && pkg.build.win.icon));
check('package.json build icon is build/icon.png', pkg.build && pkg.build.icon === 'build/icon.png', 'got ' + (pkg.build && pkg.build.icon));
check('kitsune mark still in index.html', indexHtml.includes('kitsune-mark'));

if (failures) {
  console.log('\n' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
