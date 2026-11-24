// CodeFox smoke test — plain Node, no dependencies.
// Run: node test/smoke.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ' (' + detail + ')' : ''));
  if (!ok) failures++;
}

// 1. Syntax-check every JS file we ship.
for (const file of ['main.js', 'preload.js', 'app.js', 'upm-manifest.js', 'unity-bridge.js', 'unity-bridge-source.js', 'scripts/embed-bridge.js', 'test/smoke.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
    check('node --check ' + file, true);
  } catch (e) {
    check('node --check ' + file, false, String(e.message).split('\n')[0]);
  }
}

// 2. package.json version is 0.5.0.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check('package.json version is 0.5.0', pkg.version === '0.5.0', 'got ' + pkg.version);
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

// 10. v0.5.0 agent loop + Unity Package Manager.
check('main.js has unity:listPackages IPC', mainJs.includes("ipcMain.handle('unity:listPackages'"));
check('main.js has unity:addPackage IPC', mainJs.includes("ipcMain.handle('unity:addPackage'"));
check('main.js has unity:removePackage IPC', mainJs.includes("ipcMain.handle('unity:removePackage'"));
check('main.js has updateManifest helper', mainJs.includes('function updateManifest'));
check('main.js has agent_max_rounds default', mainJs.includes("'agent_max_rounds', '5'"));
check('preload.js exposes rb.unity listPackages/addPackage/removePackage',
  preloadJs.includes('listPackages') && preloadJs.includes('addPackage') && preloadJs.includes('removePackage'));
check('app.js has agent loop (runAgentTurn)', appJs.includes('runAgentTurn') && appJs.includes('streamOneTurn'));
check('app.js has agent_max_rounds setting', appJs.includes('agent_max_rounds') && appJs.includes('saveAgentMaxRounds'));
check('app.js has Stop button + loop status', appJs.includes('stop-loop-btn') && appJs.includes('stopAgentLoop') && appJs.includes('loop-status') && appJs.includes('setLoopStatus'));
check('app.js parses upm-install / upm-remove blocks', appJs.includes('upm-install') && appJs.includes('upm-remove') && appJs.includes('parseUpmBlocks'));
check('app.js has package approval bar', appJs.includes('package-bar') && appJs.includes('showPackageBar'));
check('app.js loop ends at max rounds', appJs.includes('Stopped after ') && appJs.includes('tool rounds'));
check('app.js loop stop message', appJs.includes('Stopped by user.'));
check('app.js tool results are user messages', appJs.includes('Tool result — ') && appJs.includes('appendToolResult'));
check('app.js Agent prompt mentions tool results', appJs.includes('come back to you as tool results'));
check('dangerous list includes rmdir / rd', appJs.includes('rmdir') && appJs.includes('Remove-Item -Force -Recurse'));
check('index.html has Stop button + loop status', indexHtml.includes('stop-loop-btn') && indexHtml.includes('loop-status'));
check('README documents the agent loop', readme.includes('Agent mode (the loop)') && readme.includes('agent_max_rounds'));
check('README documents Unity Package Manager', readme.includes('Unity Package Manager') && readme.includes('upm-install'));
// Package installs are only reachable from the approval bar: the
// install call appears exactly once, inside showPackageBar, and the
// remove call only in showPackageBar and the confirm-click remover.
function enclosingFunction(src, idx) {
  const head = src.slice(0, idx);
  let best = null, bestIdx = -1;
  for (const m of head.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (m.index > bestIdx) { bestIdx = m.index; best = m[1]; }
  }
  return best;
}
const addPkgIdx = appJs.indexOf('rb.unity.addPackage');
check('package install call appears once', appJs.split('rb.unity.addPackage').length - 1 === 1);
check('package install call is inside showPackageBar', addPkgIdx !== -1 && enclosingFunction(appJs, addPkgIdx) === 'showPackageBar');
const removePkgIdxs = [];
{ let i = -1; while ((i = appJs.indexOf('rb.unity.removePackage', i + 1)) !== -1) removePkgIdxs.push(i); }
check('package remove call appears twice (bar + confirm)', removePkgIdxs.length === 2);
check('package remove calls are in approval handlers',
  removePkgIdxs.length === 2 && removePkgIdxs.every(i => ['showPackageBar', 'removeUnityPackage'].includes(enclosingFunction(appJs, i))));
check('app.js has Packages list + remove', appJs.includes('unityPackagesSectionHtml') && appJs.includes('removeUnityPackage'));

// 11. v0.5.0 bridge install fix: packaging, embedded fallback, auto-install.
// The old error text is built from parts (as with FORBIDDEN above)
// so this file itself does not contain it.
const COPY_BY_HAND = ['Copy unity-companion/CodeFoxBridge.cs', ' to Assets/Editor/', ' by hand'].join('');
check('package.json build.files includes unity-companion',
  Array.isArray(pkg.build.files) && pkg.build.files.includes('unity-companion/**/*'));
check('package.json build.files includes new runtime helpers',
  Array.isArray(pkg.build.files) && pkg.build.files.includes('upm-manifest.js')
  && pkg.build.files.includes('unity-bridge.js') && pkg.build.files.includes('unity-bridge-source.js'));
check('build scripts regenerate the embedded bridge first',
  typeof pkg.scripts['build:win'] === 'string' && pkg.scripts['build:win'].includes('scripts/embed-bridge.js'));
check('main.js has no copy-by-hand bridge error',
  !mainJs.includes(COPY_BY_HAND));
check('main.js uses the bridge helper with embedded fallback',
  mainJs.includes("require('./unity-bridge')") && mainJs.includes('installBridgeFile') && mainJs.includes('unity:ensureBridge'));
check('main.js auto-installs the bridge on connect/startup',
  (mainJs.match(/ensureBridge\(/g) || []).length >= 5);
check('preload.js exposes rb.unity.ensureBridge', preloadJs.includes('ensureBridge'));
check('app.js auto-installs the bridge from Connections', appJs.includes('rb.unity.ensureBridge'));
check('app.js shows a real bridge error, not a copy-by-hand note',
  appJs.includes('Bridge install failed: ') && !appJs.includes(COPY_BY_HAND));
check('scripts/embed-bridge.js exists', fs.existsSync(path.join(root, 'scripts', 'embed-bridge.js')));
check('unity-bridge-source.js exists', fs.existsSync(path.join(root, 'unity-bridge-source.js')));
const bridgeSrc = require(path.join(root, 'unity-bridge-source.js'));
const bridgeCs = fs.readFileSync(path.join(root, 'unity-companion', 'CodeFoxBridge.cs'), 'utf8');
check('embedded bridge source matches CodeFoxBridge.cs', bridgeSrc.BRIDGE_SOURCE === bridgeCs);

// 12. Manifest add/remove round-trip against a temp directory.
const upm = require(path.join(root, 'upm-manifest.js'));
const tmpUpm = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-upm-'));
try {
  fs.mkdirSync(path.join(tmpUpm, 'Packages'), { recursive: true });
  fs.writeFileSync(path.join(tmpUpm, 'Packages', 'manifest.json'),
    JSON.stringify({ dependencies: { 'com.unity.textmeshpro': '3.0.6' } }, null, 2));
  let r = upm.updateManifest(tmpUpm, (m) => { m.dependencies['com.unity.inputsystem'] = '1.8.2'; });
  check('manifest add succeeds', r.ok === true);
  let after = JSON.parse(fs.readFileSync(path.join(tmpUpm, 'Packages', 'manifest.json'), 'utf8'));
  check('manifest add keeps existing + adds new',
    after.dependencies['com.unity.textmeshpro'] === '3.0.6' && after.dependencies['com.unity.inputsystem'] === '1.8.2');
  check('manifest backup written', fs.existsSync(path.join(tmpUpm, 'Packages', 'manifest.json.codefox-bak')));
  check('manifest backup holds the original',
    JSON.parse(fs.readFileSync(path.join(tmpUpm, 'Packages', 'manifest.json.codefox-bak'), 'utf8')).dependencies['com.unity.inputsystem'] === undefined);
  check('manifest kept 2-space indent',
    fs.readFileSync(path.join(tmpUpm, 'Packages', 'manifest.json'), 'utf8').includes('\n  "dependencies"'));
  r = upm.updateManifest(tmpUpm, (m) => { delete m.dependencies['com.unity.textmeshpro']; });
  check('manifest remove succeeds', r.ok === true);
  after = JSON.parse(fs.readFileSync(path.join(tmpUpm, 'Packages', 'manifest.json'), 'utf8'));
  check('manifest remove deletes only that package',
    !('com.unity.textmeshpro' in after.dependencies) && after.dependencies['com.unity.inputsystem'] === '1.8.2');
  check('manifest validation accepts real names/versions',
    upm.isValidPackageName('com.unity.textmeshpro') && upm.isValidPackageVersion('3.0.6')
    && upm.isValidPackageVersion('https://github.com/user/repo.git#1.0.0'));
  check('manifest validation rejects bad names/versions',
    !upm.isValidPackageName('notaname') && !upm.isValidPackageName('') && !upm.isValidPackageVersion(''));
  check('manifest add refuses a missing manifest',
    upm.updateManifest(path.join(tmpUpm, 'no-such-project'), () => {}).ok === false);
  const spec = upm.parsePackageSpec('com.unity.textmeshpro@3.0.6');
  check('manifest parse name@version', spec && spec.name === 'com.unity.textmeshpro' && spec.version === '3.0.6');
  check('manifest parse name-only needs a version',
    upm.parsePackageSpec('com.unity.textmeshpro').version === '');
  check('manifest parse git URL', upm.parsePackageSpec('https://github.com/user/repo.git#1.0.0').isGit === true);
} finally {
  fs.rmSync(tmpUpm, { recursive: true, force: true });
}

// 13. Bridge fallback: install from the embedded copy when the disk
// file is absent (temp app dir with no unity-companion folder).
const bridge = require(path.join(root, 'unity-bridge.js'));
const tmpBridge = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-bridge-'));
const tmpAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-appdir-'));
try {
  fs.mkdirSync(path.join(tmpBridge, 'Assets'), { recursive: true });
  const installed = bridge.installBridgeFile(tmpBridge, tmpAppDir);
  check('bridge installs from embedded copy when disk file is absent',
    installed.ok === true && installed.from === 'embedded');
  check('bridge file written to Assets/Editor',
    fs.existsSync(path.join(tmpBridge, 'Assets', 'Editor', 'CodeFoxBridge.cs')));
  check('installed bridge matches the embedded source',
    fs.readFileSync(path.join(tmpBridge, 'Assets', 'Editor', 'CodeFoxBridge.cs'), 'utf8') === bridge.embeddedSource());
  check('ensureBridge no-ops when bridge already installed',
    bridge.ensureBridge(tmpBridge, tmpAppDir).already === true);
  check('ensureBridge refuses a missing project folder',
    bridge.ensureBridge(path.join(tmpBridge, 'no-such-project'), tmpAppDir).ok === false);
  const tmpNoAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-noassets-'));
  try {
    const skipped = bridge.ensureBridge(tmpNoAssets, tmpAppDir);
    check('ensureBridge skips a folder with no Assets folder', skipped.skipped === true);
  } finally { fs.rmSync(tmpNoAssets, { recursive: true, force: true }); }
  check('bridge disk source preferred when present',
    bridge.resolveBridgeSource(root).from === 'disk');
} finally {
  fs.rmSync(tmpBridge, { recursive: true, force: true });
  fs.rmSync(tmpAppDir, { recursive: true, force: true });
}

if (failures) {
  console.log('\n' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
