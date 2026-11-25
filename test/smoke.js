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
for (const file of ['main.js', 'preload.js', 'app.js', 'upm-manifest.js', 'unity-assets.js', 'unity-bridge.js', 'unity-bridge-source.js', 'scripts/embed-bridge.js', 'test/smoke.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
    check('node --check ' + file, true);
  } catch (e) {
    check('node --check ' + file, false, String(e.message).split('\n')[0]);
  }
}

// 2. package.json version is 0.5.2.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check('package.json version is 0.5.2', pkg.version === '0.5.2', 'got ' + pkg.version);
check('sidebar footer shows 0.5.2', fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('CodeFox 0.5.2 — Local'));
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

// 14. v0.5.1 auto-apply new Unity asset files + revert always available.
// The asset list is the single source of truth (unity-assets.js,
// shared with the renderer through preload's rb.unityAssets).
const assets = require(path.join(root, 'unity-assets.js'));
check('unity-assets list includes .prefab/.unity/.mat/.anim/.controller',
  ['.prefab', '.unity', '.mat', '.anim', '.controller'].every(e => assets.UNITY_ASSET_EXTS.includes(e)));
check('unity-assets list has no code extensions',
  !assets.UNITY_ASSET_EXTS.some(e => ['.cs', '.shader', '.js', '.ts'].includes(e)));
check('isUnityAssetPath accepts Unity assets, rejects code',
  assets.isUnityAssetPath('Assets/Prefabs/TestTMP.prefab')
  && assets.isUnityAssetPath('Assets/Scenes/Main.unity')
  && assets.isUnityAssetPath('Assets/Mats/Red.mat')
  && !assets.isUnityAssetPath('Assets/Scripts/Player.cs')
  && !assets.isUnityAssetPath('Assets/Shaders/Glow.shader')
  && !assets.isUnityAssetPath('README.md'));
check('isUnityAssetPath is case-insensitive',
  assets.isUnityAssetPath('Assets/Prefabs/Thing.PREFAB'));
check('app.js has the auto_apply_unity_assets setting',
  appJs.includes('auto_apply_unity_assets') && appJs.includes('autoApplyUnityAssets'));
check('app.js has the auto-apply decision + handler',
  appJs.includes('isAutoApplyAssetSet') && appJs.includes('handleFileChanges'));
check('auto-apply is wired into the agent loop files branch',
  appJs.includes('isAutoApplyAssetSet(action.changes)') && appJs.includes('Unity asset files applied automatically'));
check('auto-apply is wired into the one-shot Ask/Plan path',
  appJs.includes('await handleFileChanges(changes)'));
check('Advanced settings has the auto-apply toggle',
  appJs.includes('Auto-apply new Unity asset files') && appJs.includes("setShellToggle('auto_apply_unity_assets'"));
check('main.js seeds auto_apply_unity_assets default on',
  (mainJs.match(/auto_apply_unity_assets', '1'/g) || []).length >= 3);
check('package.json build.files includes unity-assets.js',
  Array.isArray(pkg.build.files) && pkg.build.files.includes('unity-assets.js'));
check('preload.js exposes rb.unityAssets',
  preloadJs.includes('unityAssets') && preloadJs.includes("require('./unity-assets')"));
check('preload.js exposes rb.db.deleteSnapshot',
  preloadJs.includes('deleteSnapshot'));
check('main.js has db:deleteSnapshot handler',
  mainJs.includes("ipcMain.handle('db:deleteSnapshot'"));
check('app.js Keep discards the snapshot via deleteSnapshot',
  appJs.includes('discardSnapshot') && appJs.includes('rb.db.deleteSnapshot(snapshotId)'));
check('revert bar explains revert vs keep',
  (() => {
    const start = appJs.indexOf('function showRevertBar');
    const end = appJs.indexOf('\nfunction ', start + 1);
    const body = appJs.slice(start, end === -1 ? undefined : end);
    return body.includes('Revert changes') && body.includes('Keep changes')
      && body.includes('discards the snapshot')
      && body.includes('new files are deleted');
  })());
check('revert bar has no auto-dismiss timer',
  (() => {
    const start = appJs.indexOf('function showRevertBar');
    const end = appJs.indexOf('\nfunction ', start + 1);
    const body = appJs.slice(start, end === -1 ? undefined : end);
    return !body.includes('setTimeout');
  })());
check('revert discards the spent snapshot',
  appJs.includes('deleteSnapshot(snapshotId)') && appJs.indexOf('The snapshot is spent') !== -1);
check('sidebar lists snapshots with a revert button',
  appJs.includes("revertFromHistory('${s.id}')"));

// Functional test: auto-apply decision + apply-then-revert against
// a real temp project directory. The .prefab is created (the apply
// write), then reverted via the sentinel row — and must be gone.
// An existing file edited by an apply must come back with its
// original contents.
const tmpAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-assets-'));
try {
  const projDir = path.join(tmpAssets, 'TD Pizza Racer');
  fs.mkdirSync(path.join(projDir, 'Assets', 'Prefabs'), { recursive: true });
  fs.mkdirSync(path.join(projDir, 'Assets', 'Scripts'), { recursive: true });
  const existsSync = (p) => fs.existsSync(p);
  const resolve = (rel) => path.join(projDir, rel.split('/').join(path.sep));
  const prefab = 'Assets/Prefabs/TestTMP.prefab';
  check('auto-apply: new .prefab alone qualifies',
    assets.isAutoApplyAssetSet([{ path: prefab }], resolve, existsSync) === true);
  check('auto-apply: .cs file never qualifies',
    assets.isAutoApplyAssetSet([{ path: 'Assets/Scripts/Player.cs' }], resolve, existsSync) === false);
  check('auto-apply: mixed set (prefab + code) never qualifies',
    assets.isAutoApplyAssetSet([{ path: prefab }, { path: 'Assets/Scripts/Player.cs' }], resolve, existsSync) === false);
  check('auto-apply: empty set never qualifies',
    assets.isAutoApplyAssetSet([], resolve, existsSync) === false);
  // Apply: write the new prefab (what applyFileChanges does).
  fs.writeFileSync(resolve(prefab), '%YAML 1.1\n--- !u!1001 &123\nMonoBehaviour:\n  m_Name: TestTMP\n');
  fs.writeFileSync(resolve(prefab) + '.meta', 'fileFormatVersion: 2\n');
  check('auto-apply: existing .prefab no longer qualifies (it is an edit now)',
    assets.isAutoApplyAssetSet([{ path: prefab }], resolve, existsSync) === false);
  // Revert the new file: the snapshot row holds the sentinel, so
  // revert deletes the file and its .meta (confirmRevert semantics).
  const sentinel = (appJs.match(/const NEW_FILE_SENTINEL = '([^']+)'/) || [])[1];
  check('NEW_FILE_SENTINEL is readable from app.js', !!sentinel);
  const reverted = assets.revertBackupFile({ file_path: resolve(prefab), content: sentinel }, sentinel, fs);
  check('revert deletes a newly created .prefab', reverted === 'deleted' && !fs.existsSync(resolve(prefab)));
  check('revert deletes the .prefab .meta too', !fs.existsSync(resolve(prefab) + '.meta'));
  // Revert an edit: the saved original content comes back.
  const script = 'Assets/Scripts/Player.cs';
  const original = 'public class Player { }\n';
  fs.writeFileSync(resolve(script), original);
  fs.writeFileSync(resolve(script), 'public class Player { /* changed */ }\n'); // the apply overwrote it
  const restored = assets.revertBackupFile({ file_path: resolve(script), content: original }, sentinel, fs);
  check('revert restores an edited file to its original contents',
    restored === 'restored' && fs.readFileSync(resolve(script), 'utf8') === original);
  check('revert of an already-gone file is a no-op',
    assets.revertBackupFile({ file_path: resolve(prefab), content: sentinel }, sentinel, fs) === null);
} finally {
  fs.rmSync(tmpAssets, { recursive: true, force: true });
}

// 15. v0.5.1 bridge fix: CreateAnimatorControllerAtPath is 1-arg only.
// The 2-argument call does not exist in any Unity version (CS1501).
const twoArgCall = /CreateAnimatorControllerAtPath\([^)]*,[^)]*\)/;
check('bridge .cs has no 2-argument CreateAnimatorControllerAtPath call',
  !twoArgCall.test(bridgeCs));
check('embedded bridge has no 2-argument CreateAnimatorControllerAtPath call',
  !twoArgCall.test(bridgeSrc.BRIDGE_SOURCE));
check('bridge .cs uses the 1-argument CreateAnimatorControllerAtPath call',
  bridgeCs.includes('AnimatorController.CreateAnimatorControllerAtPath(assetPath);'));
check('embedded bridge contains the fixed 1-argument call',
  bridgeSrc.BRIDGE_SOURCE.includes('AnimatorController.CreateAnimatorControllerAtPath(assetPath);'));

// 16. v0.5.2 bridge toggle-off fix, versioning, auto-update.
// Root cause of the toggle bug: toggle-off removed the file, then
// renderSettingsView() re-rendered Connections, whose auto-install
// saw the file missing and re-installed it — so the toggle never
// changed. The fix is a persisted per-project bridge_enabled flag
// that every auto-install / auto-update path respects, plus bridge
// versioning so an out-of-date installed bridge is overwritten
// instead of skipped.
check('bridge .cs has the 0.5.2 version marker',
  bridgeCs.includes('// CodeFoxBridge version: 0.5.2') && bridgeCs.includes('BridgeVersion = "0.5.2"'));
check('embedded bridge has the 0.5.2 version marker',
  bridgeSrc.BRIDGE_SOURCE.includes('// CodeFoxBridge version: 0.5.2'));
check('unity-bridge.js has BUNDLED_BRIDGE_VERSION 0.5.2',
  bridge.BUNDLED_BRIDGE_VERSION === '0.5.2');
check('unity-bridge.js has version helpers',
  typeof bridge.getInstalledBridgeVersion === 'function'
  && typeof bridge.isBridgeUpdateAvailable === 'function'
  && typeof bridge.compareVersions === 'function');
check('version compare works',
  bridge.compareVersions('0.5.0', '0.5.2') < 0
  && bridge.compareVersions('0.5.2', '0.5.2') === 0
  && bridge.compareVersions('0.5.3', '0.5.2') > 0
  && bridge.compareVersions('0.5.10', '0.5.2') > 0);
check('main.js has the per-project bridge_enabled flag',
  mainJs.includes('bridge_enabled_') && mainJs.includes('bridgeEnabledForProject')
  && mainJs.includes('setBridgeEnabled'));
check('main.js installBridge turns the flag on, removeBridge turns it off',
  mainJs.includes('setBridgeEnabled(projectIdByPath(root), true)')
  && mainJs.includes('setBridgeEnabled(projectIdByPath(root), false)'));
check('main.js ensureBridge IPC respects the flag',
  mainJs.includes("ipcMain.handle('unity:ensureBridge'")
  && mainJs.includes('enabled: bridgeEnabledForProject(projectIdByPath(root))'));
check('main.js has unity:bridgeStatus IPC', mainJs.includes("ipcMain.handle('unity:bridgeStatus'"));
check('preload.js exposes rb.unity.bridgeStatus', preloadJs.includes('bridgeStatus'));
check('app.js Update plugin disabled state is driven by updateAvailable',
  appJs.includes("updateAvailable ? '' : 'disabled'") && appJs.includes('Bridge is up to date'));
check('app.js Connections auto-install is gated on the bridge toggle',
  appJs.includes('if (bridgeEnabled && state.projectPath)'));
check('app.js re-reads bridge status after ensure',
  appJs.includes('rb.unity.bridgeStatus(state.projectPath)'));

const tmpV = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-bridge-v-'));
const tmpVAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-appdir-v-'));
try {
  fs.mkdirSync(path.join(tmpV, 'Assets', 'Editor'), { recursive: true });
  // An old bridge as v0.5.0 installed it: no version marker at all.
  const oldBridge = '// CodeFoxBridge.cs\n// Place this file in: Assets/Editor/CodeFoxBridge.cs\npublic static class CodeFoxBridge {}\n';
  const installedPath = path.join(tmpV, 'Assets', 'Editor', 'CodeFoxBridge.cs');
  fs.writeFileSync(installedPath, oldBridge);
  check('unmarked installed bridge reads as null version',
    bridge.getInstalledBridgeVersion(tmpV) === null);
  check('isBridgeUpdateAvailable true for an unmarked bridge',
    bridge.isBridgeUpdateAvailable(tmpV) === true);
  check('isBridgeUpdateAvailable true when bridge is missing',
    bridge.isBridgeUpdateAvailable(path.join(tmpV, 'no-such-project')) === true);
  const upd = bridge.ensureBridge(tmpV, tmpVAppDir);
  check('ensureBridge overwrites an out-of-date bridge',
    upd.ok === true && upd.updated === true && upd.toVersion === '0.5.2' && upd.fromVersion === '0.0.0');
  check('installed bridge now carries the 0.5.2 marker',
    bridge.getInstalledBridgeVersion(tmpV) === '0.5.2');
  check('isBridgeUpdateAvailable false when the bridge is current',
    bridge.isBridgeUpdateAvailable(tmpV) === false);
  check('ensureBridge no-ops when the bridge is already current',
    bridge.ensureBridge(tmpV, tmpVAppDir).already === true);
  check('ensureBridge with enabled:false does not install a missing bridge', (() => {
    fs.rmSync(installedPath);
    const r = bridge.ensureBridge(tmpV, tmpVAppDir, { enabled: false });
    return r.ok === false && r.disabled === true && !fs.existsSync(installedPath);
  })());
  check('ensureBridge with enabled:false does not update an old bridge', (() => {
    fs.writeFileSync(installedPath, oldBridge);
    const r = bridge.ensureBridge(tmpV, tmpVAppDir, { enabled: false });
    return r.ok === false && r.disabled === true && bridge.getInstalledBridgeVersion(tmpV) === null;
  })());
} finally {
  fs.rmSync(tmpV, { recursive: true, force: true });
  fs.rmSync(tmpVAppDir, { recursive: true, force: true });
}

// 17. v0.5.2 model-must-edit enforcement + refusal retry.
// A local model told to fix the CS1501 error refused with "cannot
// modify files" — a prompt failure, not a capability failure (the
// apply pipeline already works: it created TestTMP.prefab). The
// system prompt now ORDERS the model to output the file, and the
// app enforces it with two triggers in the Agent loop.
check('system prompt orders the model to edit files (MUST + FAILURE)',
  appJs.includes('You MUST edit') && appJs.includes('FAILURE')
  && appJs.includes('Do not output an explanation instead of the file'));
check('system prompt has the capability statement',
  appJs.includes('You CAN edit') && appJs.includes('Never say you cannot modify files')
  && appJs.includes('CodeFox writes it to disk'));
check('refusal-phrase list and one automatic correction turn exist',
  appJs.includes('REFUSAL_PHRASES') && appJs.includes('cannot modify files')
  && appJs.includes('REFUSAL_CORRECTION') && appJs.includes('refusalRetries')
  && appJs.includes('You CAN modify files in this app'));
check('no-actions enforcement trigger exists',
  appJs.includes('enforcementRetried') && appJs.includes('ENFORCEMENT_FOLLOWUP')
  && appJs.includes('You did not output any file changes')
  && appJs.includes('asksForChange(userRequest)'));
check('diagnose-error flow attaches the named file',
  appJs.includes('diagnoseErrorContext') && appJs.includes('surrounding lines'));
check('Agent-mode UI hint exists',
  appJs.includes('agent-hint')
  && fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('Agent mode writes code to your project'));

// extractFileChanges lives in app.js (browser code), so pull the
// function out by brace-matching and run it in Node.
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const codeExtsMatch = /const CODE_EXTS = '([^']+)'/.exec(appJs);
const parserSrc = extractFunction(appJs, 'extractFileChanges');
check('extractFileChanges can be extracted for testing', !!parserSrc && !!codeExtsMatch);
if (parserSrc && codeExtsMatch) {
  const extractFileChanges = new Function('CODE_EXTS', parserSrc + '\nreturn extractFileChanges;')(codeExtsMatch[1]);
  const sampleDoc = '**File Path:** `Assets/Editor/CodeFoxBridge.cs`\n```csharp\npublic class X {}\n```\n';
  const rDoc = extractFileChanges(sampleDoc);
  check('parser accepts **File Path:** + fenced block',
    rDoc.length === 1 && rDoc[0].path === 'Assets/Editor/CodeFoxBridge.cs' && rDoc[0].code.includes('public class X'));
  const sampleFile = '```file:Assets/Editor/CodeFoxBridge.cs\npublic class X {}\n```\n';
  const rFile = extractFileChanges(sampleFile);
  check('parser accepts ```file:path blocks',
    rFile.length === 1 && rFile[0].path === 'Assets/Editor/CodeFoxBridge.cs' && rFile[0].code.includes('public class X'));
  const sampleBare = 'Assets/Editor/CodeFoxBridge.cs\n```csharp\npublic class X {}\n```\n';
  const rBare = extractFileChanges(sampleBare);
  check('parser accepts a bare path line before a csharp block',
    rBare.length === 1 && rBare[0].path === 'Assets/Editor/CodeFoxBridge.cs');
  check('parser skips powershell blocks as files',
    extractFileChanges('```powershell\ngit status\n```\n').length === 0);
  check('parser keeps path case from a file: fence',
    extractFileChanges('```file:Assets/Editor/CodeFoxBridge.cs\nx\n```\n')[0].path === 'Assets/Editor/CodeFoxBridge.cs');
}

if (failures) {
  console.log('\n' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
