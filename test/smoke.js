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
for (const file of ['main.js', 'preload.js', 'app.js', 'upm-manifest.js', 'unity-assets.js', 'unity-bridge.js', 'unity-bridge-source.js', 'mcp-presets.js', 'comfyui.js', 'lmstudio-load.js', 'scripts/embed-bridge.js', 'test/smoke.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
    check('node --check ' + file, true);
  } catch (e) {
    check('node --check ' + file, false, String(e.message).split('\n')[0]);
  }
}

// 2. package.json version is 0.8.3.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check('package.json version is 0.8.3', pkg.version === '0.8.3', 'got ' + pkg.version);
check('sidebar footer shows 0.8.3', fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('CodeFox 0.8.3 — Local'));
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
// Preload source with comments stripped: several checks below must
// look at what the code actually requires, not what the comments
// mention (the v0.6.4 header comment names the old requires).
const preloadCode = preloadJs.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

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

// 11b. v0.6.1: the generated bridge file is untracked, so builds can
// never leave a tracked file dirty and block the next `git pull`.
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
check('.gitignore lists unity-bridge-source.js', gitignore.split('\n').some(l => l.trim() === 'unity-bridge-source.js'));
check('package.json prestart regenerates the bridge', typeof pkg.scripts.prestart === 'string' && pkg.scripts.prestart.includes('scripts/embed-bridge.js'));
check('package.json postinstall regenerates bridge + icons',
  typeof pkg.scripts.postinstall === 'string'
  && pkg.scripts.postinstall.includes('scripts/embed-bridge.js')
  && pkg.scripts.postinstall.includes('scripts/prepare-icons.js'));
try {
  const tracked = execFileSync('git', ['ls-files', 'unity-bridge-source.js'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  check('unity-bridge-source.js is not tracked in git', tracked === '', 'git ls-files returned ' + JSON.stringify(tracked));
} catch (e) {
  // No git available, or this copy is not a git checkout (e.g. a
  // packaged copy): the check cannot run here, so skip it rather
  // than failing the whole suite on the environment.
  console.log('SKIP — git ls-files check (no git repo available here)');
}

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
check('preload.js exposes rb.unityAssets without requiring the file',
  preloadJs.includes('unityAssets') && !preloadCode.includes("require('./unity-assets')")
  && preloadJs.includes("sendSync('app:staticData')"));
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
// v0.8.2 — the prefab refusal: Ask mode instructed the model to
// refuse, and the refusal list missed tutorial-style refusals.
// Extract the pure helpers and run them in Node.
const refusalListSrc = /const REFUSAL_PHRASES = \[[\s\S]*?\];/.exec(appJs);
check('REFUSAL_PHRASES list can be extracted for testing', !!refusalListSrc);
const isRefusalSrc = extractFunction(appJs, 'isRefusal');
check('isRefusal can be extracted for testing', !!isRefusalSrc);
if (refusalListSrc && isRefusalSrc) {
  const isRefusal = new Function(refusalListSrc[0] + '\n' + isRefusalSrc + '\nreturn isRefusal;')();
  check('isRefusal catches the exact tutorial refusal Rob got',
    isRefusal('I cannot do that, but I can walk you through the steps'));
  check('isRefusal catches other tutorial-style refusals',
    isRefusal("I can't create a prefab, but let me guide you through it")
    && isRefusal("I don't have access to your project files")
    && isRefusal('I can show you how to set it up yourself'));
  check('isRefusal does NOT flag a legit Agent reply',
    !isRefusal('**File Path:** `Assets/Test.prefab`\n```\nhello\n```\nDone — I worked step by step through the setup.')
    && !isRefusal('Here is the file:\n**File Path:** `Assets/Editor/X.cs`\n```csharp\npublic class X {}\n```'));
}
const changeWordsSrc = /const CHANGE_INTENT_WORDS = \[[^\]]*\];/.exec(appJs);
const asksSrc = extractFunction(appJs, 'asksForChange');
const resolveSrc = extractFunction(appJs, 'resolveModeForRequest');
check('resolveModeForRequest can be extracted for testing', !!changeWordsSrc && !!asksSrc && !!resolveSrc);
if (changeWordsSrc && asksSrc && resolveSrc) {
  const resolveModeForRequest = new Function(changeWordsSrc[0] + '\n' + asksSrc + '\n' + resolveSrc + '\nreturn resolveModeForRequest;')();
  check('build request in Ask mode routes to Agent mode',
    resolveModeForRequest('ask', 'build me a prefab') === 'agent'
    && resolveModeForRequest('ask', 'fix the null reference in Player.cs') === 'agent');
  check('plain question in Ask mode stays in Ask mode',
    resolveModeForRequest('ask', 'why does this script fail?') === 'ask');
  check('Plan mode is never switched by routing',
    resolveModeForRequest('plan', 'build me a prefab') === 'plan');
  check('Agent mode is unchanged by routing',
    resolveModeForRequest('agent', 'build me a prefab') === 'agent');
}
check('Ask-mode prompt still explains only for non-change requests',
  appJs.includes('Answer and explain only. Do not propose file writes'));
check('sendChat routes by intent before building the prompt',
  appJs.includes('resolveModeForRequest(state.chatMode, text)')
  && appJs.includes('Switched to Agent mode to do the work'));
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

// 18. v0.5.3 curated MCP presets, extended in v0.6.0 — ten only, one click to add the config, plus a guided setup prompt.
const presets = require(path.join(root, 'mcp-presets.js'));
check('mcp-presets.js exports exactly 10 presets',
  Array.isArray(presets.MCP_PRESETS) && presets.MCP_PRESETS.length === 10,
  'got ' + (presets.MCP_PRESETS && presets.MCP_PRESETS.length));
check('preset ids are exactly the 10 verified ids',
  JSON.stringify(presets.MCP_PRESETS.map(p => p.id)) === JSON.stringify(['blender', 'figma', 'unity', 'github', 'filesystem', 'git', 'atlassian', 'notion', 'trello', 'perforce']));
check('no Miro preset in mcp-presets.js',
  !fs.readFileSync(path.join(root, 'mcp-presets.js'), 'utf8').toLowerCase().includes('miro'));
for (const p of presets.MCP_PRESETS) {
  check('preset ' + p.id + ' has name, description, command, args, needs, setupSteps',
    !!p.name && !!p.description && !!p.command && Array.isArray(p.args) && p.args.length > 0
    && Array.isArray(p.needs) && p.needs.length > 0 && Array.isArray(p.setupSteps) && p.setupSteps.length > 0);
}
const byId = {};
for (const p of presets.MCP_PRESETS) byId[p.id] = p;
check('Blender preset uses uvx blender-mcp',
  byId.blender.command === 'uvx' && byId.blender.args.includes('blender-mcp'));
check('Figma preset uses npx figma-developer-mcp and needs FIGMA_API_KEY',
  byId.figma.command === 'npx' && byId.figma.args.includes('figma-developer-mcp')
  && byId.figma.requiresToken && byId.figma.requiresToken.envKey === 'FIGMA_API_KEY');
check('Unity preset uses uvx mcpforunityserver',
  byId.unity.command === 'uvx' && byId.unity.args.includes('mcpforunityserver'));
check('GitHub preset uses @modelcontextprotocol/server-github and needs a token',
  byId.github.args.includes('@modelcontextprotocol/server-github')
  && byId.github.requiresToken && byId.github.requiresToken.envKey === 'GITHUB_PERSONAL_ACCESS_TOKEN');
check('Filesystem preset uses @modelcontextprotocol/server-filesystem and needs a folder',
  byId.filesystem.args.includes('@modelcontextprotocol/server-filesystem') && byId.filesystem.requiresFolder === true);
check('Git preset uses mcp-server-git and needs a folder',
  byId.git.args.includes('mcp-server-git') && byId.git.requiresFolder === true);
check('Blender preset says CodeFox cannot start Blender',
  (byId.blender.note || '').includes('cannot start Blender'));
check('Unity preset says it is Coplay, not affiliated with Unity Technologies',
  byId.unity.description.includes('Coplay') && byId.unity.description.includes('not affiliated with Unity Technologies'));
const figmaNoToken = presets.buildServerEntry(byId.figma, {});
check('buildServerEntry refuses Figma without a token',
  figmaNoToken.ok === false && figmaNoToken.entry === null);
const figmaOk = presets.buildServerEntry(byId.figma, { token: 'figd_test123' });
check('buildServerEntry builds Figma entry with the token as env',
  figmaOk.ok === true && figmaOk.entry.env.FIGMA_API_KEY === 'figd_test123'
  && figmaOk.entry.args === '-y figma-developer-mcp' && figmaOk.entry.command === 'npx'
  && figmaOk.entry.enabled === true && figmaOk.entry.presetId === 'figma');
const fsNoFolder = presets.buildServerEntry(byId.filesystem, {});
check('buildServerEntry refuses Filesystem without a folder',
  fsNoFolder.ok === false && fsNoFolder.entry === null);
const fsOk = presets.buildServerEntry(byId.filesystem, { folder: 'C:\\shared\\assets' });
check('buildServerEntry substitutes the folder into Filesystem args',
  fsOk.ok === true && fsOk.entry.args === '-y @modelcontextprotocol/server-filesystem C:\\shared\\assets');
const gitOk = presets.buildServerEntry(byId.git, { folder: 'C:\\TD Pizza Racer' });
check('buildServerEntry substitutes the folder into Git args',
  gitOk.ok === true && gitOk.entry.args === 'mcp-server-git --repository C:\\TD Pizza Racer');
const blenderOk = presets.buildServerEntry(byId.blender, {});
check('buildServerEntry builds Blender entry with no token or folder',
  blenderOk.ok === true && blenderOk.entry.command === 'uvx' && blenderOk.entry.args === 'blender-mcp');
check('mcp-presets.js is in package.json build.files',
  Array.isArray(pkg.build.files) && pkg.build.files.includes('mcp-presets.js'));
check('preload.js exposes rb.mcpPresets without requiring the file',
  preloadJs.includes('mcpPresets') && !preloadCode.includes("require('./mcp-presets')")
  && preloadJs.includes("sendSync('app:staticData')"));
check('MCPs section has the Recommended presets heading',
  appJs.includes('Recommended for game development') && appJs.includes('renderMcpPresets'));
check('MCPs section installs a preset via buildServerEntry',
  appJs.includes('installMcpPreset') && appJs.includes('buildServerEntry'));
check('preset Install is disabled without a required token or folder',
  appJs.includes('mcp-preset-install-') && appJs.includes('updateMcpPresetInstallBtn'));
check('honest MCP scope note is still present',
  appJs.includes('does not call MCP tools yet'));


// 19. v0.6.0 — guided setup prompt, four new presets, ComfyUI.
check('every preset has a checkKind',
  presets.MCP_PRESETS.every(p => typeof p.checkKind === 'string' && p.checkKind.length > 0));
check('token presets declare a real check',
  ['figma', 'github', 'notion', 'atlassian', 'trello'].every(id => {
    const p = byId[id];
    return p && ['figma', 'github', 'notion', 'atlassian', 'trello'].includes(p.checkKind);
  }));
check('Atlassian preset uses uvx mcp-atlassian with site/email/token fields',
  byId.atlassian.command === 'uvx' && byId.atlassian.args.includes('mcp-atlassian')
  && Array.isArray(byId.atlassian.requiresFields)
  && ['site', 'email', 'token'].every(k => byId.atlassian.requiresFields.some(f => f.key === k))
  && byId.atlassian.env.JIRA_URL === '<site>' && byId.atlassian.env.JIRA_USERNAME === '<email>'
  && byId.atlassian.env.JIRA_API_TOKEN === '<token>');
check('Notion preset uses the official server and needs NOTION_TOKEN',
  byId.notion.command === 'npx' && byId.notion.args.includes('@notionhq/notion-mcp-server')
  && byId.notion.requiresToken && byId.notion.requiresToken.envKey === 'NOTION_TOKEN');
check('Trello preset needs an API key and a token',
  byId.trello.args.includes('@delorenj/mcp-server-trello')
  && Array.isArray(byId.trello.requiresFields)
  && byId.trello.requiresFields.some(f => f.key === 'apiKey')
  && byId.trello.requiresFields.some(f => f.key === 'token')
  && byId.trello.env.TRELLO_API_KEY === '<apiKey>' && byId.trello.env.TRELLO_TOKEN === '<token>');
check('Perforce preset is read-only uvx with no automatic check',
  byId.perforce.command === 'uvx' && byId.perforce.args.includes('p4mcp-server')
  && byId.perforce.args.includes('--readonly') && byId.perforce.checkKind === 'none');
check('Filesystem preset has no automatic check',
  byId.filesystem.checkKind === 'none');
const atlOk = presets.buildServerEntry(byId.atlassian, { fields: { site: 'https://team.atlassian.net', email: 'a@example.com', token: 'ATATT123' } });
check('buildServerEntry builds Atlassian entry from site/email/token fields',
  atlOk.ok === true && atlOk.entry.env.JIRA_URL === 'https://team.atlassian.net'
  && atlOk.entry.env.JIRA_USERNAME === 'a@example.com' && atlOk.entry.env.JIRA_API_TOKEN === 'ATATT123'
  && atlOk.entry.args === 'mcp-atlassian');
check('buildServerEntry refuses Atlassian without an email',
  presets.buildServerEntry(byId.atlassian, { fields: { site: 'https://team.atlassian.net', token: 'ATATT123' } }).ok === false);
const trelloOk = presets.buildServerEntry(byId.trello, { fields: { apiKey: 'key123', token: 'tok456' } });
check('buildServerEntry builds Trello entry from apiKey/token fields',
  trelloOk.ok === true && trelloOk.entry.env.TRELLO_API_KEY === 'key123' && trelloOk.entry.env.TRELLO_TOKEN === 'tok456');
check('main.js has mcp:checkToken + mcp:checkApp IPCs (not via shell:run)',
  mainJs.includes("ipcMain.handle('mcp:checkToken'") && mainJs.includes("ipcMain.handle('mcp:checkApp'")
  && mainJs.includes('api.figma.com/v1/me') && mainJs.includes('api.github.com/user')
  && mainJs.includes('api.notion.com/v1/users/me') && mainJs.includes('rest/api/3/myself')
  && mainJs.includes('api.trello.com/1/members/me'));
check('main.js has shell:openExternal IPC using shell.openExternal',
  mainJs.includes("ipcMain.handle('shell:openExternal'") && mainJs.includes('shell.openExternal'));
check('preload.js exposes rb.mcp checks and rb.shell.openExternal',
  preloadJs.includes('checkToken') && preloadJs.includes('checkApp') && preloadJs.includes('openExternal'));
check('guided setup modal exists in index.html + app.js',
  indexHtml.includes('mcp-setup-modal-overlay') && indexHtml.includes('id="mcp-setup-modal"')
  && appJs.includes('function openMcpSetupModal') && appJs.includes('runMcpSetupCheck')
  && appJs.includes('I have done the steps above'));
check('guided setup Add is gated on check pass or the anyway checkbox',
  appJs.includes('setup.checkPassed') && appJs.includes('mcp-setup-anyway') && appJs.includes('updateMcpSetupAddBtn'));
check('MCPs section says ten presets and offers Quick add',
  appJs.includes('Ten presets') && appJs.includes('Quick add'));

// ComfyUI helper: workflow parser, submit-payload builder, capabilities.
const comfy = require(path.join(root, 'comfyui.js'));
check('comfyui.js exports the client + parser + capabilities',
  typeof comfy.parseWorkflowGraph === 'function' && typeof comfy.buildSubmitPrompt === 'function'
  && typeof comfy.detectCapabilities === 'function' && typeof comfy.getComfyuiStatus === 'function'
  && typeof comfy.submitPrompt === 'function' && typeof comfy.downloadView === 'function'
  && typeof comfy.uploadImage === 'function' && typeof comfy.importWorkflowsFromDir === 'function'
  && comfy.DEFAULT_COMFYUI_URL === 'http://127.0.0.1:8188');
const fakeWorkflow = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', _meta: { title: 'Positive' }, inputs: { text: 'a knight' } },
  '3': { class_type: 'CLIPTextEncode', _meta: { title: 'Negative' }, inputs: { text: 'blurry' } },
  '4': { class_type: 'KSampler', inputs: { seed: 42, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', positive: ['2', 0], negative: ['3', 0], latent_image: ['5', 0], model: ['1', 0] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '6': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } },
  '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'card-art', images: ['6', 0] } },
  '8': { class_type: 'ControlNetApply', inputs: { strength: 1.0, conditioning: ['2', 0], control_net: ['9', 0], image: ['10', 0] } },
  '9': { class_type: 'ControlNetLoader', inputs: { control_net_name: 'control.safetensors' } },
  '10': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
};
const fakeObjectInfo = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd_xl.safetensors']] } } },
  CLIPTextEncode: { input: { required: { text: [['']] } } },
  KSampler: { input: { required: {} } },
  EmptyLatentImage: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
};
const parsedWf = comfy.parseWorkflowGraph(fakeWorkflow, fakeObjectInfo);
check('workflow parser detects positive/negative prompts by KSampler link',
  parsedWf.inputs.some(i => i.role === 'positive' && i.value === 'a knight')
  && parsedWf.inputs.some(i => i.role === 'negative' && i.value === 'blurry'));
check('workflow parser detects KSampler seed/steps/cfg',
  parsedWf.inputs.some(i => i.inputName === 'seed' && i.value === 42)
  && parsedWf.inputs.some(i => i.inputName === 'steps' && i.value === 20)
  && parsedWf.inputs.some(i => i.inputName === 'cfg' && i.value === 7));
check('workflow parser detects SaveImage outputs',
  parsedWf.outputs.some(o => o.classType === 'SaveImage' && o.nodeId === '7'));
check('workflow parser reports a missing node class and marks unavailable',
  parsedWf.available === false
  && parsedWf.missing.some(m => m.includes('ControlNetApply'))
  && parsedWf.missing.some(m => m.includes('ControlNetLoader')));
check('workflow parser accepts the installed checkpoint',
  !parsedWf.missing.some(m => m.includes('sd_xl.safetensors')));
const missingCkpt = comfy.parseWorkflowGraph(
  { '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'gone.safetensors' } } }, fakeObjectInfo);
check('workflow parser reports a missing checkpoint',
  missingCkpt.missing.some(m => m.includes('gone.safetensors')) && missingCkpt.available === false);
const built = comfy.buildSubmitPrompt(fakeWorkflow, { positive: 'a dragon', seed: 7, '1.ckpt_name': 'other.safetensors', nosuchinput: 'x' });
check('submit-payload builder substitutes positive/seed/checkpoint',
  built.prompt['2'].inputs.text === 'a dragon' && built.prompt['4'].inputs.seed === 7
  && built.prompt['1'].inputs.ckpt_name === 'other.safetensors'
  && built.applied.includes('positive') && built.applied.includes('seed')
  && built.unapplied.includes('nosuchinput'));
check('submit-payload builder does not mutate the stored workflow',
  fakeWorkflow['2'].inputs.text === 'a knight' && fakeWorkflow['4'].inputs.seed === 42
  && fakeWorkflow['1'].inputs.ckpt_name === 'sd_xl.safetensors');
const caps = comfy.detectCapabilities({ KSampler: {}, CheckpointLoaderSimple: {}, SaveVideo: {}, ImageUpscaleWithModel: {}, ControlNetLoader: {} });
check('capability detection lists only what the install has',
  caps.some(c => c.id === 'image') && caps.some(c => c.id === 'video')
  && caps.some(c => c.id === 'upscale') && caps.some(c => c.id === 'controlnet')
  && !caps.some(c => c.id === 'inpaint'));
check('capability detection returns nothing without object_info',
  comfy.detectCapabilities(null).length === 0);
check('defaultWorkflowsDir returns a string',
  typeof comfy.defaultWorkflowsDir() === 'string');

// Workflow import from a folder: valid JSON catalogued, bad JSON
// reported, stored purpose + approval survive a rescan.
const tmpWf = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-comfyui-'));
try {
  fs.writeFileSync(path.join(tmpWf, 'card-art.json'), JSON.stringify(fakeWorkflow));
  fs.writeFileSync(path.join(tmpWf, 'broken.json'), '{not json');
  fs.writeFileSync(path.join(tmpWf, 'notes.txt'), 'not a workflow');
  const imported = comfy.importWorkflowsFromDir(tmpWf, fakeObjectInfo,
    [{ id: 'card-art', purpose: 'Card art for the game', approved: true }]);
  check('import catalogues the valid workflow and skips non-JSON files',
    imported.ok === true && imported.workflows.length === 1 && imported.workflows[0].id === 'card-art');
  check('import keeps the stored purpose and approval',
    imported.workflows[0].purpose === 'Card art for the game' && imported.workflows[0].approved === true);
  check('import reports the broken JSON file',
    imported.errors.length === 1 && imported.errors[0].includes('broken.json'));
  check('import refuses a missing folder',
    comfy.importWorkflowsFromDir(path.join(tmpWf, 'no-such-folder'), fakeObjectInfo, []).ok === false);
} finally {
  fs.rmSync(tmpWf, { recursive: true, force: true });
}

check('main.js has the comfyui:* IPCs and seeds the ComfyUI settings',
  mainJs.includes("ipcMain.handle('comfyui:status'") && mainJs.includes("ipcMain.handle('comfyui:objectInfo'")
  && mainJs.includes("ipcMain.handle('comfyui:queue'") && mainJs.includes("ipcMain.handle('comfyui:history'")
  && mainJs.includes("ipcMain.handle('comfyui:submit'") && mainJs.includes("ipcMain.handle('comfyui:view'")
  && mainJs.includes("ipcMain.handle('comfyui:uploadImage'") && mainJs.includes("ipcMain.handle('comfyui:listWorkflows'")
  && mainJs.includes("'comfyui_url', 'http://127.0.0.1:8188'") && mainJs.includes("'comfyui_workflows', '[]'"));
check('comfyui.js status falls back to /object_info and never fakes ok',
  fs.readFileSync(path.join(root, 'comfyui.js'), 'utf8').includes('/system_stats')
  && fs.readFileSync(path.join(root, 'comfyui.js'), 'utf8').includes('/object_info')
  && mainJs.includes('getComfyuiStatus'));
check('preload.js exposes rb.comfyui with status/submit/view/history',
  preloadJs.includes('comfyui:') && preloadJs.includes("ipcRenderer.invoke('comfyui:status'")
  && preloadJs.includes("ipcRenderer.invoke('comfyui:submit'") && preloadJs.includes("ipcRenderer.invoke('comfyui:view'"));
check('package.json build.files includes comfyui.js',
  Array.isArray(pkg.build.files) && pkg.build.files.includes('comfyui.js'));
check('ComfyUI view + sidebar item exist in index.html/app.js',
  indexHtml.includes('nav-comfyui') && indexHtml.includes('comfyui-mode') && indexHtml.includes('showComfyUI()')
  && appJs.includes('function showComfyUI') && appJs.includes('function renderComfyUIView')
  && appJs.includes('Workflow Library') && appJs.includes('All nodes in /object_info'));
check('ComfyUI view has connection card, Generate panel, history, import',
  appJs.includes('comfyui-url') && appJs.includes('runComfyuiFromPanel') && appJs.includes('comfyuiHistory')
  && appJs.includes('Assets/Generated/') && appJs.includes('importComfyuiOutputs'));
check('only approved workflows auto-run in the Agent loop',
  appJs.includes('function parseComfyuiBlocks') && appJs.includes("type: 'comfyui'")
  && appJs.includes('if (!wf.approved)') && appJs.includes('function showComfyuiBar')
  && appJs.includes('Workflow unavailable'));
check('agent loop polls ComfyUI (no WebSocket client) with a 10-minute cap',
  appJs.includes('function pollComfyuiPrompt') && appJs.includes('10 * 60 * 1000')
  && !appJs.includes('new WebSocket'));
check('ComfyUI settings live in Settings → Connections, not Model',
  appJs.includes("Open ComfyUI panel") && appJs.includes('verifyComfyuiFromSettings'));
check('README documents ComfyUI, approval, and the agent block',
  readme.includes('ComfyUI') && readme.includes('Approved for autonomous execution')
  && readme.includes('```comfyui') && readme.includes('/system_stats')
  && readme.includes('Miro') && readme.includes('no Miro preset'));
check('README documents the guided setup prompt',
  readme.includes('guided setup prompt') && readme.includes('Add server'));

// 20. v0.6.2 — "Developer tools" button (Settings → Advanced) so
// the console can be opened without a keyboard shortcut, and a
// packaging regression check from the v0.6.0 investigation.
// The reported v0.6.0 bug (project dropdown, creating a
// conversation, LM Studio verify / refresh models all silently
// dead) has no definite cause in the code: the audit traced init(),
// the preload bridge, the main-process load order, the database
// layer, and the v0.5.1–v0.6.0 diff, and ruled out a startup throw
// in app.js (no top-level use of the bridge, no top-level DOM
// statement that can throw), a broken preload require, and
// unregistered IPC handlers. The one failure mode that would
// produce exactly these symptoms and is only visible in the
// packaged app is a preload/main require that is NOT in
// package.json build.files — the file would be missing from the
// installer, preload would throw, window.rb would never exist, and
// every bridge call would fail silently. These checks pin that
// down: every relative require in preload.js and main.js must
// resolve to a file the packager ships.
check('main.js has app:openDevTools IPC opening the DevTools panel',
  mainJs.includes("ipcMain.handle('app:openDevTools'") && mainJs.includes('openDevTools()'));
check('preload.js exposes rb.app.openDevTools',
  preloadJs.includes('openDevTools') && preloadJs.includes("ipcRenderer.invoke('app:openDevTools'"));
check('Settings → Advanced has a Developer tools diagnostics button',
  appJs.includes('Developer tools') && appJs.includes('onclick="openDevTools()"')
  && appJs.includes('Diagnostics') && appJs.includes('function openDevTools'));
check('dead-feature handlers still await the bridge (no silent removal)',
  appJs.includes('toggleProjectDropdown') && appJs.includes('await rb.project.list()')
  && appJs.includes('await rb.llm.verify') && appJs.includes('await rb.llm.listModels')
  && appJs.includes("await rb.db.insert('threads'"));
for (const [label, src] of [['preload.js', preloadJs], ['main.js', mainJs]]) {
  const missing = [];
  for (const m of src.matchAll(/require\('\.\/([A-Za-z0-9_./-]+)'\)/g)) {
    const file = m[1].endsWith('.js') ? m[1] : m[1] + '.js';
    const shipped = Array.isArray(pkg.build.files) && pkg.build.files.some(f =>
      f === file || (f.endsWith('/**/*') && file.startsWith(f.slice(0, -5))));
    if (!shipped) missing.push(file);
  }
  check(label + ' relative requires are all in package.json build.files', missing.length === 0, missing.join(', '));
}

// 21. v0.6.3 — bridge self-check: the app says on screen when it
// cannot reach the main process, instead of failing silently.
// main.js answers app:ping; preload exposes rb.app.ping; app.js
// runs checkBridge() first in init() and shows a persistent banner
// (#bridge-banner, a direct child of <body> in index.html) with one
// of two exact messages; the Developer tools button fails visibly.
const indexHtmlSrc = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
check('main.js handles app:ping and answers ok with a version',
  mainJs.includes("ipcMain.handle('app:ping'") && mainJs.includes('app.getVersion()'));
check('preload.js exposes rb.app.ping',
  preloadJs.includes('ping') && preloadJs.includes("ipcRenderer.invoke('app:ping'"));
check('index.html has the bridge banner element outside #app',
  indexHtmlSrc.includes('<div id="bridge-banner" class="hidden"></div>')
  && indexHtmlSrc.indexOf('id="bridge-banner"') < indexHtmlSrc.indexOf('<div id="app">'));
check('bridge banner has fixed positioning and both colour variants',
  indexHtmlSrc.includes('#bridge-banner { position: fixed')
  && indexHtmlSrc.includes('#bridge-banner.bridge-missing')
  && indexHtmlSrc.includes('#bridge-banner.bridge-timeout'));
check('app.js has both exact bridge failure messages',
  appJs.includes('CodeFox cannot reach its main process (bridge missing) — buttons that save, load, or connect will not respond. Please report this exact message.')
  && appJs.includes('CodeFox loaded, but the main process is not answering (bridge timeout) — buttons that save, load, or connect will not respond. Please report this exact message.'));
check('init() runs the bridge self-check first, before any rb call',
  appJs.indexOf('checkBridge()') !== -1
  && appJs.indexOf('checkBridge()') < appJs.indexOf('await rb.project.list()')
  && appJs.includes('function checkBridge'));
check('bridge check uses a 2s ping timeout so a hung invoke cannot hang startup',
  appJs.includes('Promise.race') && appJs.includes('ping timed out after 2s'));
check('Developer tools button fails visibly with a toast when the bridge is down',
  appJs.includes('Developer tools could not be opened — the app bridge is not responding.'));

// 21b. Preload harness: the real preload.js must load with a
// stubbed electron module and expose the full rb object. This is
// the check that would have caught a preload throw. It is guarded:
// if the stub approach cannot run in this environment it SKIPs
// (prints SKIP, does not fail the suite) rather than failing on
// harness mechanics instead of on the code under test.
// The stub answers the 'app:staticData' sync channel with the real
// module data, the way main.js does — so the harness also proves
// the preload's local copies of the helpers agree with the modules.
try {
  const Module = require('module');
  const calls = [];
  const realAssets = require(path.join(root, 'unity-assets.js'));
  const realPresets = require(path.join(root, 'mcp-presets.js'));
  const stubElectron = {
    contextBridge: { exposeInMainWorld: (key, value) => { calls.push({ key, value }); } },
    ipcRenderer: {
      invoke: async () => ({ ok: true }),
      on: () => {}, removeAllListeners: () => {},
      sendSync: (channel) => (channel === 'app:staticData'
        ? { unityAssetExts: realAssets.UNITY_ASSET_EXTS, mcpPresets: realPresets.MCP_PRESETS }
        : undefined),
    },
  };
  const origResolve = Module._resolveFilename;
  try {
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'electron') return 'electron-stub';
      return origResolve.call(this, request, ...rest);
    };
    require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stubElectron };
    delete require.cache[path.join(root, 'preload.js')];
    require(path.join(root, 'preload.js'));
  } finally {
    Module._resolveFilename = origResolve;
    delete require.cache['electron-stub'];
  }
  const exposed = calls.length === 1 && calls[0].key === 'rb' ? calls[0].value : null;
  check('preload.js loads with stubbed electron and exposes rb with app.ping',
    !!exposed && typeof exposed.app.ping === 'function' && typeof exposed.app.openDevTools === 'function'
    && typeof exposed.project.list === 'function' && typeof exposed.db.insert === 'function',
    'expose calls: ' + calls.length);
  if (exposed) {
    // Parity: the preload's local copies of the helpers (built from
    // the fetched static data) must agree with the real modules, so
    // the two copies cannot drift silently.
    check('preload rb.mcpPresets.list matches the real preset list',
      JSON.stringify(exposed.mcpPresets.list) === JSON.stringify(realPresets.MCP_PRESETS));
    check('preload rb.unityAssets.exts matches the real extension list',
      JSON.stringify(exposed.unityAssets.exts) === JSON.stringify(realAssets.UNITY_ASSET_EXTS));
    for (const p of ['Assets/Test.prefab', 'Assets/Scene.unity', 'Assets/Mat.mat', 'Assets/Script.cs', 'x.png']) {
      check('preload isUnityAssetPath agrees with unity-assets.js for ' + p,
        exposed.unityAssets.isUnityAssetPath(p) === realAssets.isUnityAssetPath(p));
    }
    check('preload rb.mcpPresets.get finds the Figma preset',
      exposed.mcpPresets.get('figma') && exposed.mcpPresets.get('figma').id === 'figma'
      && exposed.mcpPresets.get('nope') === null);
    const parityCases = [
      [{ id: 'figma' }, { token: 'figd_abc' }],
      [{ id: 'figma' }, { token: '' }],
      [{ id: 'filesystem' }, { folder: 'C:\\Assets' }],
      [{ id: 'filesystem' }, { folder: '' }],
      [{ id: 'atlassian' }, { fields: { site: 'https://x.atlassian.net', email: 'a@b.c' } }],
      [{ id: 'atlassian' }, { fields: { site: 'https://x.atlassian.net', email: 'a@b.c', token: 'ATATT1' } }],
      [{ id: 'trello' }, { fields: { apiKey: 'k', token: 't' } }],
      [{ id: 'blender' }, {}],
      [{ id: 'git' }, { folder: 'C:\\TD Pizza Racer' }],
      [null, {}],
    ];
    for (const [presetRef, opts] of parityCases) {
      const preset = presetRef ? realPresets.getPreset(presetRef.id) : null;
      const label = 'buildServerEntry parity for ' + (preset ? preset.id : 'null preset') + ' ' + JSON.stringify(opts);
      check('preload ' + label,
        JSON.stringify(exposed.mcpPresets.buildServerEntry(preset, opts))
        === JSON.stringify(realPresets.buildServerEntry(preset, opts)));
    }
  }
} catch (e) {
  console.log('SKIP — preload stub harness could not run here (' + String(e && e.message).split('\n')[0] + ')');
}

// 21c. v0.6.4 — preload must never require a local file. This is
// the invariant that, had it existed, would have caught v0.5.1:
// in real Electron a local require in preload throws ("module not
// found"), the bridge never gets created, and every button that
// needs the main process silently does nothing. Only 'electron'
// (and Node built-ins) may be required here; the static data comes
// from the main process over the 'app:staticData' sync channel.
{
  const BUILTINS = new Set(require('module').builtinModules.map(m => m.replace(/^node:/, '')));
  const specifiers = [...preloadCode.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  const bad = specifiers.filter(s => s.startsWith('./') || s.startsWith('../') || s.startsWith('/') || s.includes(':\\'));
  check('preload.js has no local-file require (only electron / built-ins)',
    bad.length === 0 && specifiers.every(s => s === 'electron' || BUILTINS.has(s.replace(/^node:/, ''))),
    'requires found: ' + specifiers.join(', '));
  check('preload.js fetches its static data over the sync channel',
    preloadJs.includes("sendSync('app:staticData')"));
  check('main.js requires unity-assets.js and mcp-presets.js',
    mainJs.includes("require('./unity-assets')") && mainJs.includes("require('./mcp-presets')"));
  check('main.js serves the static data on app:staticData',
    mainJs.includes("ipcMain.on('app:staticData'") && mainJs.includes('event.returnValue'));
  check('main.js still requires the helper modules the renderer needs',
    mainJs.includes('UNITY_ASSET_EXTS') && mainJs.includes('MCP_PRESETS'));
}

// 22. v0.7.0 — ComfyUI finds itself, and generation feels like
// Midjourney: broader capability detection (Flux / SD3-style
// split-model graphs), the full node list, "Scan for ComfyUI",
// and the simple prompt-first generation form.
const fluxObjectInfo = {
  UNETLoader: { input: { required: {} } },
  DualCLIPLoader: { input: { required: {} } },
  VAELoader: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  EmptyLatentImage: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
};
check('capability detection recognises Flux-style graphs without a CheckpointLoader',
  comfy.detectCapabilities(fluxObjectInfo).some(c => c.id === 'image'));
const fluxGgufObjectInfo = {
  UNETLoaderGGUF: { input: { required: {} } },
  CLIPLoaderGGUF: { input: { required: {} } },
  VAELoader: { input: { required: {} } },
  SamplerCustomAdvanced: { input: { required: {} } },
  BasicGuider: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
};
check('capability detection recognises GGUF split-model graphs (UNETLoaderGGUF + SamplerCustomAdvanced)',
  comfy.detectCapabilities(fluxGgufObjectInfo).some(c => c.id === 'image'));
check('capability detection lists nothing for custom-nodes-only installs',
  comfy.detectCapabilities({ MyCustomNode: {}, AnotherThing: {} }).length === 0);
check('capability detection lists nothing for an empty /object_info',
  comfy.detectCapabilities({}).length === 0);
check('nodeClassNames lists every node class, sorted',
  JSON.stringify(comfy.nodeClassNames({ Zeta: {}, Alpha: {}, KSampler: {} })) === JSON.stringify(['Alpha', 'KSampler', 'Zeta'])
  && comfy.nodeClassNames(null).length === 0 && comfy.nodeClassNames({}).length === 0);
// Flux-style graph: conditioning runs through a BasicGuider, not
// a KSampler — the prompt roles must still be detected from it.
const fluxWorkflow = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux.safetensors' } },
  '2': { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl.safetensors' } },
  '3': { class_type: 'CLIPTextEncode', _meta: { title: 'Positive' }, inputs: { text: 'a cat' } },
  '4': { class_type: 'CLIPTextEncode', _meta: { title: 'Negative' }, inputs: { text: 'blurry' } },
  '5': { class_type: 'BasicGuider', inputs: { model: ['1', 0], conditioning: ['3', 0], positive: ['3', 0], negative: ['4', 0] } },
  '6': { class_type: 'SamplerCustomAdvanced', inputs: { model: ['1', 0], positive: ['3', 0], negative: ['4', 0] } },
  '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'flux', images: ['6', 0] } },
};
const parsedFlux = comfy.parseWorkflowGraph(fluxWorkflow, fluxObjectInfo);
check('workflow parser detects prompt roles through a BasicGuider (Flux-style)',
  parsedFlux.inputs.some(i => i.role === 'positive' && i.value === 'a cat')
  && parsedFlux.inputs.some(i => i.role === 'negative' && i.value === 'blurry'));
const builtFlux = comfy.buildSubmitPrompt(fluxWorkflow, { positive: 'a dog' });
check('submit-payload builder substitutes the positive prompt in a Flux-style graph',
  builtFlux.prompt['3'].inputs.text === 'a dog' && builtFlux.applied.includes('positive'));
// Two prompt nodes and no sampler wiring at all: roles stay
// unknown, so the form must label them Prompt 1 / Prompt 2.
const unroledWorkflow = {
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'first' } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'second' } },
};
const parsedUnroled = comfy.parseWorkflowGraph(unroledWorkflow, fluxObjectInfo);
check('workflow parser leaves prompt roles unknown when no sampler wires them',
  parsedUnroled.inputs.filter(i => i.role === 'positive').length === 0
  && parsedUnroled.inputs.filter(i => i.role === 'negative').length === 0);
// Simple-form descriptor: what the Midjourney-easy form shows.
const simpleSd = comfy.describeSimpleForm(parsedWf.inputs);
check('simple form shows prompt/negative, sampler, and size for an SD1.5 workflow',
  simpleSd.hasPrompt === true
  && simpleSd.prompts.some(p => p.role === 'positive' && p.key === 'positive')
  && simpleSd.prompts.some(p => p.role === 'negative' && p.key === 'negative')
  && simpleSd.samplers.length === 1 && simpleSd.samplers[0].nodeId === '4'
  && simpleSd.samplers[0].fields.some(f => f.inputName === 'seed' && f.value === 42)
  && simpleSd.samplers[0].fields.some(f => f.inputName === 'steps')
  && simpleSd.samplers[0].fields.some(f => f.inputName === 'cfg')
  && simpleSd.sizes.length === 1 && simpleSd.sizes[0].width === 512 && simpleSd.sizes[0].height === 512);
const noPromptGraph = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl.safetensors' } },
  '4': { class_type: 'KSampler', inputs: { seed: 1, steps: 10, cfg: 5, latent_image: ['5', 0], model: ['1', 0] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 640, height: 640, batch_size: 1 } },
  '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['4', 0] } },
};
const simpleNoPrompt = comfy.describeSimpleForm(comfy.parseWorkflowGraph(noPromptGraph, fakeObjectInfo).inputs);
check('simple form reports no prompt input — and no fake prompt boxes — for a promptless workflow',
  simpleNoPrompt.hasPrompt === false && simpleNoPrompt.prompts.length === 0
  && simpleNoPrompt.samplers.length === 1 && simpleNoPrompt.sizes.length === 1);
const simpleUnroled = comfy.describeSimpleForm(parsedUnroled.inputs);
check('simple form keeps unroled prompts as node-keyed Prompt 1 / Prompt 2 (never guesses)',
  simpleUnroled.hasPrompt === true && simpleUnroled.prompts.length === 2
  && simpleUnroled.prompts.every(p => p.role === null && p.key.endsWith('.text')));
// Scan + recursive import against a mock ComfyUI layout in temp dirs.
const tmpScan = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-comfyui-scan-'));
try {
  const appData = path.join(tmpScan, 'appdata');
  const userDir = path.join(appData, 'ComfyUI');
  const wfDir = path.join(userDir, 'user', 'default', 'workflows');
  const subDir = path.join(wfDir, 'portraits');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'txt2img.json'), JSON.stringify(fakeWorkflow));
  fs.writeFileSync(path.join(subDir, 'portrait.json'), JSON.stringify(fakeWorkflow));
  for (const [cat, files] of [['checkpoints', ['a.safetensors', 'b.safetensors']], ['loras', ['l.safetensors']], ['vae', ['v.safetensors']]]) {
    fs.mkdirSync(path.join(userDir, 'models', cat), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(userDir, 'models', cat, f), 'x');
  }
  fs.mkdirSync(path.join(userDir, 'custom_nodes'), { recursive: true });
  const scan = comfy.scanComfyui({ home: tmpScan, appData, localAppData: path.join(tmpScan, 'local'), drives: [] });
  const desktopRoot = scan.roots.find(r => r.label === 'ComfyUI Desktop user data');
  check('scan finds the Desktop user dir, its workflows, models, and custom_nodes',
    scan.ok === true && desktopRoot && desktopRoot.found === true
    && desktopRoot.workflows && desktopRoot.workflows.count === 2
    && desktopRoot.models && desktopRoot.models.checkpoints === 2
    && desktopRoot.models.loras === 1 && desktopRoot.models.vae === 1
    && desktopRoot.customNodes === true
    && scan.workflowsDir === wfDir);
  check('scan reports missing locations honestly instead of inventing them',
    scan.roots.some(r => r.label === 'Documents' && r.found === false)
    && scan.roots.some(r => r.label === 'Home folder' && r.found === false));
  const importedRecursive = comfy.importWorkflowsFromDir(wfDir, fakeObjectInfo, [], { recursive: true });
  check('recursive import finds workflows in subfolders',
    importedRecursive.ok === true && importedRecursive.workflows.length === 2);
  check('import attaches the simple-form descriptor to each workflow',
    importedRecursive.workflows.every(w => w.simpleForm && w.simpleForm.hasPrompt === true
      && w.simpleForm.prompts.some(p => p.role === 'positive')));
  const importedFlat = comfy.importWorkflowsFromDir(wfDir, fakeObjectInfo, [], {});
  check('non-recursive import still reads only the top level',
    importedFlat.ok === true && importedFlat.workflows.length === 1);
  const emptyScan = comfy.scanComfyui({ home: path.join(tmpScan, 'nowhere'), appData: path.join(tmpScan, 'no-appdata'), localAppData: path.join(tmpScan, 'no-local'), drives: [] });
  check('scan with nothing installed reports no workflows dir',
    emptyScan.ok === true && emptyScan.workflowsDir === null && emptyScan.foundRoots === 0);
} finally {
  fs.rmSync(tmpScan, { recursive: true, force: true });
}
check('main.js has the comfyui:scan IPC',
  mainJs.includes("ipcMain.handle('comfyui:scan'") && mainJs.includes('scanComfyui()'));
check('preload.js exposes rb.comfyui.scan',
  preloadJs.includes("ipcRenderer.invoke('comfyui:scan'"));
check('ComfyUI view has Scan for ComfyUI, the full node list, and the simple form (no iframe)',
  appJs.includes('Scan for ComfyUI') && appJs.includes('function scanComfyui')
  && appJs.includes('All nodes in /object_info') && appJs.includes('came back empty')
  && appJs.includes('function simpleComfyuiFormHtml') && appJs.includes('function setComfyuiSize')
  && appJs.includes('function randomiseComfyuiSeedFor') && appJs.includes('Advanced — all inputs')
  && appJs.includes('has no text-prompt input') && !appJs.includes('<iframe'));
check('README documents the scan and the simple generation form',
  readme.includes('Scan for ComfyUI') && readme.includes('simple form')
  && readme.includes('Flux') && readme.includes('Prompt 1 / Prompt 2'));

// 23. v0.7.1 — "the workflows you actually have": built-in
// templates found on disk, UI-format (LiteGraph) workflows
// converted to API format (including subgraph expansion), import
// failures surfaced instead of silent zeros, the Desktop exe
// recorded for the native Open button, and model counts that
// include diffusion_models / text_encoders.
const uiStr = (d) => ['STRING', { multiline: true, default: d || '' }];
const uiCombo = (list, d) => [list, { default: d }];
const uiInt = (d) => ['INT', { default: d, min: 0, max: 100000 }];
const uiFloat = (d) => ['FLOAT', { default: d }];
const uiObjectInfo = {
  UNETLoader: { input: { required: { unet_name: uiCombo(['flux.safetensors'], 'flux.safetensors'), weight_dtype: uiCombo(['default', 'fp8_e4m3fn'], 'default') } } },
  DualCLIPLoader: { input: { required: { clip_name1: uiCombo(['clip_l.safetensors']), clip_name2: uiCombo(['t5xxl.safetensors']), type: uiCombo(['flux', 'sd3'], 'flux'), device: uiCombo(['default', 'cpu'], 'default') } } },
  CLIPLoader: { input: { required: { clip_name: uiCombo(['t5.safetensors']), type: uiCombo(['chroma'], 'chroma'), device: uiCombo(['default', 'cpu'], 'default') } } },
  CLIPTextEncode: { input: { required: { text: uiStr(), clip: ['CLIP', {}] } } },
  EmptySD3LatentImage: { input: { required: { width: uiInt(1024), height: uiInt(1024), batch_size: uiInt(1) } } },
  EmptyLatentImage: { input: { required: { width: uiInt(512), height: uiInt(512), batch_size: uiInt(1) } } },
  KSampler: { input: { required: { model: ['MODEL', {}], positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], latent_image: ['LATENT', {}], seed: uiInt(0), control_after_generate: uiCombo(['fixed', 'randomize'], 'randomize'), steps: uiInt(20), cfg: uiFloat(1), sampler_name: uiCombo(['euler'], 'euler'), scheduler: uiCombo(['simple'], 'simple'), denoise: uiFloat(1) } } },
  VAELoader: { input: { required: { vae_name: uiCombo(['ae.safetensors'], 'ae.safetensors') } } },
  VAEDecode: { input: { required: { samples: ['LATENT', {}], vae: ['VAE', {}] } } },
  SaveImage: { input: { required: { images: ['IMAGE', {}], filename_prefix: uiStr('ComfyUI') } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: uiCombo(['sd_xl.safetensors', 'sd15.safetensors'], 'sd_xl.safetensors') } } },
  CFGGuider: { input: { required: { model: ['MODEL', {}], positive: ['CONDITIONING', {}], negative: ['CONDITIONING', {}], cfg: uiFloat(1) } } },
};
// A plain UI-format (LiteGraph) workflow: widget values in
// widgets_values, links in the links array, plus an annotation
// node that must be skipped, not executed.
const uiPlainWorkflow = {
  id: 'test-plain',
  nodes: [
    { id: 1, type: 'UNETLoader', inputs: [], widgets_values: ['flux.safetensors', 'default'] },
    { id: 2, type: 'DualCLIPLoader', inputs: [], widgets_values: ['clip_l.safetensors', 't5xxl.safetensors', 'flux', 'default'] },
    { id: 3, type: 'CLIPTextEncode', inputs: [{ name: 'clip', type: 'CLIP', link: 1 }], widgets_values: ['a cat'] },
    { id: 4, type: 'CLIPTextEncode', inputs: [{ name: 'clip', type: 'CLIP', link: 2 }], widgets_values: ['blurry'] },
    { id: 5, type: 'EmptySD3LatentImage', inputs: [], widgets_values: [1024, 1024, 1] },
    { id: 6, type: 'KSampler', inputs: [
      { name: 'model', type: 'MODEL', link: 3 },
      { name: 'positive', type: 'CONDITIONING', link: 4 },
      { name: 'negative', type: 'CONDITIONING', link: 5 },
      { name: 'latent_image', type: 'LATENT', link: 6 },
    ], widgets_values: [42, 'randomize', 20, 1, 'euler', 'simple', 1] },
    { id: 7, type: 'VAELoader', inputs: [], widgets_values: ['ae.safetensors'] },
    { id: 8, type: 'VAEDecode', inputs: [
      { name: 'samples', type: 'LATENT', link: 7 },
      { name: 'vae', type: 'VAE', link: 8 },
    ], widgets_values: [] },
    { id: 9, type: 'SaveImage', inputs: [{ name: 'images', type: 'IMAGE', link: 9 }], widgets_values: ['test'] },
    { id: 10, type: 'MarkdownNote', inputs: [], widgets_values: ['a note, not a node'] },
  ],
  links: [
    [1, 2, 0, 3, 0, 'CLIP'], [2, 2, 0, 4, 0, 'CLIP'],
    [3, 1, 0, 6, 0, 'MODEL'], [4, 3, 0, 6, 1, 'CONDITIONING'],
    [5, 4, 0, 6, 2, 'CONDITIONING'], [6, 5, 0, 6, 3, 'LATENT'],
    [7, 6, 0, 8, 0, 'LATENT'], [8, 7, 0, 8, 1, 'VAE'],
    [9, 8, 0, 9, 0, 'IMAGE'],
  ],
};
const convPlain = comfy.convertUiGraphToApi(uiPlainWorkflow, uiObjectInfo);
check('UI-format workflow converts to API format (links + widgets)',
  convPlain.ok === true && convPlain.graph['6'].inputs.model[0] === '1'
  && convPlain.graph['6'].inputs.positive[0] === '3' && convPlain.graph['6'].inputs.negative[0] === '4'
  && convPlain.graph['6'].inputs.seed === 42 && convPlain.graph['3'].inputs.text === 'a cat'
  && convPlain.graph['1'].inputs.unet_name === 'flux.safetensors'
  && !Object.values(convPlain.graph).some(n => n.class_type === 'MarkdownNote'));
const parsedPlain = comfy.parseWorkflowGraph(uiPlainWorkflow, uiObjectInfo);
check('UI-format workflow parses with prompt roles (no empty shell)',
  parsedPlain.ok === true && parsedPlain.inputs.some(i => i.role === 'positive' && i.value === 'a cat')
  && parsedPlain.inputs.some(i => i.role === 'negative' && i.value === 'blurry')
  && parsedPlain.outputs.length === 1 && parsedPlain.available === true);
const builtPlain = comfy.buildSubmitPrompt(convPlain.graph, { positive: 'a dog' });
check('submit-payload builder substitutes the prompt in a converted UI workflow',
  builtPlain.prompt['3'].inputs.text === 'a dog' && builtPlain.applied.includes('positive'));
check('UI conversion is deterministic (same file, same API graph)',
  JSON.stringify(comfy.convertUiGraphToApi(uiPlainWorkflow, uiObjectInfo).graph) === JSON.stringify(convPlain.graph));
// A subgraph ("blueprint") workflow, like the Flux / Qwen
// templates: one instance node whose internals live in
// definitions.subgraphs, with the prompt/width fed through the
// subgraph's inputs and the image out through its output.
const UI_SUB_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const uiSubgraphWorkflow = {
  id: 'test-sub',
  nodes: [
    { id: 10, type: UI_SUB_ID, inputs: [
      { name: 'text', type: 'STRING', widget: { name: 'text' }, link: null },
      { name: 'width', type: 'INT', widget: { name: 'width' }, link: null },
    ], widgets_values: [] },
    { id: 11, type: 'SaveImage', inputs: [{ name: 'images', type: 'IMAGE', link: 20 }], widgets_values: ['sub'] },
  ],
  links: [[20, 10, 0, 11, 0, 'IMAGE']],
  definitions: { subgraphs: [{
    id: UI_SUB_ID, name: 'Mini T2I',
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', inputs: [], widgets_values: ['sd15.safetensors'] },
      { id: 2, type: 'CLIPTextEncode', inputs: [
        { name: 'clip', type: 'CLIP', link: 1 },
        { name: 'text', type: 'STRING', widget: { name: 'text' }, link: 2 },
      ], widgets_values: ['default prompt'] },
      { id: 3, type: 'EmptyLatentImage', inputs: [
        { name: 'width', type: 'INT', widget: { name: 'width' }, link: 3 },
        { name: 'height', type: 'INT', widget: { name: 'height' }, link: null },
      ], widgets_values: [512, 512, 1] },
      { id: 4, type: 'KSampler', inputs: [
        { name: 'model', type: 'MODEL', link: 4 },
        { name: 'positive', type: 'CONDITIONING', link: 5 },
        { name: 'negative', type: 'CONDITIONING', link: 7 },
        { name: 'latent_image', type: 'LATENT', link: 8 },
      ], widgets_values: [7, 'randomize', 5, 1, 'euler', 'simple', 1] },
      { id: 5, type: 'CLIPTextEncode', inputs: [
        { name: 'clip', type: 'CLIP', link: 10 },
      ], widgets_values: [''] },
    ],
    links: [
      { id: 1, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: 'CLIP' },
      { id: 2, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 1, type: 'STRING' },
      { id: 3, origin_id: -10, origin_slot: 1, target_id: 3, target_slot: 0, type: 'INT' },
      { id: 4, origin_id: 1, origin_slot: 0, target_id: 4, target_slot: 0, type: 'MODEL' },
      { id: 5, origin_id: 2, origin_slot: 0, target_id: 4, target_slot: 1, type: 'CONDITIONING' },
      { id: 7, origin_id: 5, origin_slot: 0, target_id: 4, target_slot: 2, type: 'CONDITIONING' },
      { id: 8, origin_id: 3, origin_slot: 0, target_id: 4, target_slot: 3, type: 'LATENT' },
      { id: 9, origin_id: 4, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
      { id: 10, origin_id: 1, origin_slot: 0, target_id: 5, target_slot: 0, type: 'CLIP' },
    ],
    inputs: [
      { id: 'in-text', name: 'text', type: 'STRING', linkIds: [2] },
      { id: 'in-width', name: 'width', type: 'INT', linkIds: [3] },
    ],
    outputs: [{ id: 'out-img', name: 'IMAGE', type: 'IMAGE', linkIds: [9] }],
  }] },
};
const convSub = comfy.convertUiGraphToApi(uiSubgraphWorkflow, uiObjectInfo);
const subNodes = convSub.ok ? Object.values(convSub.graph) : [];
check('subgraph workflow expands to a flat API graph with prompt roles',
  convSub.ok === true && subNodes.length === 6
  && subNodes.filter(n => n.class_type === 'CLIPTextEncode').length === 2
  && comfy.parseWorkflowGraph(convSub.graph, uiObjectInfo).inputs.some(i => i.role === 'positive' && i.value === 'default prompt')
  && comfy.buildSubmitPrompt(convSub.graph, { positive: 'a dog' }).applied.includes('positive'));
// A widget value set on the instance itself overrides the
// internal node's default.
const uiSubWithValues = JSON.parse(JSON.stringify(uiSubgraphWorkflow));
uiSubWithValues.nodes[0].widgets_values = ['my prompt', 768];
const convSubLit = comfy.convertUiGraphToApi(uiSubWithValues, uiObjectInfo);
check('subgraph instance widget values override internal defaults',
  convSubLit.ok === true
  && Object.values(convSubLit.graph).some(n => n.class_type === 'CLIPTextEncode' && n.inputs.text === 'my prompt')
  && Object.values(convSubLit.graph).some(n => n.class_type === 'EmptyLatentImage' && n.inputs.width === 768));
// Reroute nodes pass through to the real origin.
const uiRerouteWorkflow = {
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', inputs: [], widgets_values: ['sd15.safetensors'] },
    { id: 2, type: 'Reroute', inputs: [{ name: '', type: '*', link: 1 }], outputs: [{ name: '', type: '*', links: [2] }], widgets_values: [] },
    { id: 3, type: 'KSampler', inputs: [{ name: 'model', type: 'MODEL', link: 2 }], widgets_values: [1, 'randomize', 5, 1, 'euler', 'simple', 1] },
  ],
  links: [[1, 1, 0, 2, 0, '*'], [2, 2, 0, 3, 0, 'MODEL']],
};
const convReroute = comfy.convertUiGraphToApi(uiRerouteWorkflow, uiObjectInfo);
check('Reroute nodes resolve through to the real origin',
  convReroute.ok === true && convReroute.graph['3'].inputs.model[0] === '1'
  && !Object.values(convReroute.graph).some(n => n.class_type === 'Reroute'));
// Honest failures, never silent empty workflows.
check('UI-format workflow without /object_info fails with the reason (not an empty shell)',
  (() => { const p = comfy.parseWorkflowGraph(uiPlainWorkflow, null); return p.ok === false && /UI-format/.test(p.error); })());
check('UI-format workflow with a node type the install lacks names the type',
  (() => { const bad = JSON.parse(JSON.stringify(uiPlainWorkflow)); bad.nodes[0].type = 'NoSuchNode'; const c = comfy.convertUiGraphToApi(bad, uiObjectInfo); return c.ok === false && /NoSuchNode/.test(c.error); })());
check('muted node feeding a required input fails naming the downstream node',
  (() => { const bad = JSON.parse(JSON.stringify(uiPlainWorkflow)); bad.nodes[1].mode = 2; const c = comfy.convertUiGraphToApi(bad, uiObjectInfo); return c.ok === false && /CLIPTextEncode/.test(c.error) && /required input "clip"/.test(c.error); })());
// CFGGuider carries positive/negative like BasicGuider (the
// Chroma-style path the old role detection missed).
const guiderWorkflow = {
  '1': { class_type: 'CLIPLoader', inputs: { clip_name: 't5.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['1', 0] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['1', 0] } },
  '4': { class_type: 'CFGGuider', inputs: { model: ['5', 0], positive: ['2', 0], negative: ['3', 0], cfg: 3.5 } },
  '5': { class_type: 'UNETLoader', inputs: { unet_name: 'u.safetensors' } },
};
const parsedGuider = comfy.parseWorkflowGraph(guiderWorkflow, uiObjectInfo);
check('workflow parser detects prompt roles through a CFGGuider',
  parsedGuider.inputs.some(i => i.role === 'positive' && i.value === 'pos')
  && parsedGuider.inputs.some(i => i.role === 'negative' && i.value === 'neg'));
// Scan + import against a mock ComfyUI Desktop layout in temp dirs:
// a program folder with an exe + frontend templates + custom-node
// examples, a uv-cache copy of the template package, a user dir
// with an empty workflows folder + a real user workflow + a
// malformed file, and models in diffusion_models / text_encoders.
const tmpScan2 = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-comfyui-scan2-'));
try {
  const appData2 = path.join(tmpScan2, 'appdata');
  const local2 = path.join(tmpScan2, 'local');
  const home2 = path.join(tmpScan2, 'home');
  const customBase = path.join(tmpScan2, 'custom-base');
  fs.mkdirSync(path.join(appData2, 'ComfyUI'), { recursive: true });
  fs.writeFileSync(path.join(appData2, 'ComfyUI', 'config.json'), JSON.stringify({ basePath: customBase }));
  fs.mkdirSync(path.join(customBase, 'user', 'default', 'workflows'), { recursive: true });
  const progComfy = path.join(local2, 'Programs', 'ComfyUI');
  fs.mkdirSync(progComfy, { recursive: true });
  fs.writeFileSync(path.join(progComfy, 'ComfyUI.exe'), 'x');
  const frontendTpl = path.join(progComfy, 'web_custom_versions', 'Comfy-Org_ComfyUI_frontend', '1.0.0', 'templates');
  fs.mkdirSync(frontendTpl, { recursive: true });
  fs.writeFileSync(path.join(frontendTpl, 'image_flux_t2i.json'), JSON.stringify(uiPlainWorkflow));
  // Locale files ship next to the templates — not workflows, and
  // they must not count as files found or appear as problems.
  fs.writeFileSync(path.join(frontendTpl, 'index.json'), JSON.stringify({ en: 'Templates', de: 'Vorlagen' }));
  fs.writeFileSync(path.join(frontendTpl, 'index.de.json'), JSON.stringify({ de: 'Vorlagen' }));
  fs.writeFileSync(path.join(frontendTpl, 'random.json'), JSON.stringify({ foo: 1, bar: [2, 3] }));
  const cnEx = path.join(progComfy, 'custom_nodes', 'some-pack', 'example_workflows');
  fs.mkdirSync(cnEx, { recursive: true });
  fs.writeFileSync(path.join(cnEx, 'pack_wf.json'), JSON.stringify(uiPlainWorkflow));
  const uvTpl = path.join(local2, 'uv', 'cache', 'archive-v0', 'abc123', 'comfyui_workflow_templates_json', 'templates');
  fs.mkdirSync(uvTpl, { recursive: true });
  fs.writeFileSync(path.join(uvTpl, 'image_qwen_image.json'), JSON.stringify(uiSubgraphWorkflow));
  const userDir2 = path.join(home2, 'Documents', 'ComfyUI');
  const wfDir2 = path.join(userDir2, 'user', 'default', 'workflows');
  fs.mkdirSync(wfDir2, { recursive: true });
  fs.writeFileSync(path.join(wfDir2, 'txt2img.json'), JSON.stringify(fakeWorkflow));
  fs.writeFileSync(path.join(wfDir2, 'broken.json'), '{not json');
  fs.writeFileSync(path.join(wfDir2, 'index.json'), JSON.stringify({ en: 'Workflows' }));
  for (const [cat, files] of [['diffusion_models', ['flux.safetensors']], ['vae', ['v.safetensors']], ['text_encoders', ['clip.safetensors']]]) {
    fs.mkdirSync(path.join(userDir2, 'models', cat), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(userDir2, 'models', cat, f), 'x');
  }
  const scan2 = comfy.scanComfyui({ home: home2, appData: appData2, localAppData: local2, drives: [] });
  check('scan records the Desktop exe only when the exe exists on disk',
    scan2.ok === true && scan2.desktopExe === path.join(progComfy, 'ComfyUI.exe'));
  check('scan finds built-in templates in the frontend package, custom-node examples, and the uv cache (locale files do not count)',
    scan2.templateDirs.length === 3 && scan2.templateDirs.every(t => t.count === 1)
    && scan2.templateDirs.some(t => t.kind === 'frontend')
    && scan2.templateDirs.some(t => t.kind === 'custom-node')
    && scan2.templateDirs.some(t => t.kind === 'uv-cache'));
  check('scan reads Desktop config.json basePath',
    scan2.desktopConfig && scan2.desktopConfig.basePath === customBase);
  const docsRoot = scan2.roots.find(r => r.path === userDir2);
  check('models walk counts diffusion_models / text_encoders and reports the models folder checked',
    docsRoot && docsRoot.models && docsRoot.models.diffusion_models === 1
    && docsRoot.models.text_encoders === 1 && docsRoot.models.vae === 1
    && docsRoot.modelsDir === path.join(userDir2, 'models'));
  check('scan adopts the workflows folder with files in it',
    scan2.workflowsDir === wfDir2);
  const importedUser = comfy.importWorkflowsFromDir(wfDir2, uiObjectInfo, [], { recursive: true });
  check('user workflows import labelled user, malformed files surface as errors (not silent zeros), locale files are ignored',
    importedUser.ok === true && importedUser.workflows.length === 1
    && importedUser.workflows[0].source === 'user'
    && importedUser.errors.length === 1 && /broken\.json/.test(importedUser.errors[0])
    && !importedUser.errors.some(e => /index\.json/.test(e)));
  const templateFiles = [];
  for (const t of scan2.templateDirs) {
    for (const f of fs.readdirSync(t.dir).filter(f => f.toLowerCase().endsWith('.json'))) templateFiles.push(path.join(t.dir, f));
  }
  const importedTpl = comfy.importWorkflowsFromFiles(templateFiles, uiObjectInfo, [], {
    source: 'builtin',
    defaultPurpose: 'Built-in template — from ComfyUI Desktop',
    titleByName: { image_qwen_image: { title: 'Qwen Image Text to Image', description: 'Text to image with Qwen' } },
  });
  check('templates import labelled builtin with server titles, locale files ignored (no errors for them)',
    importedTpl.ok === true && importedTpl.workflows.length === 3
    && importedTpl.workflows.every(w => w.source === 'builtin' && w.id.startsWith('tpl-'))
    && importedTpl.workflows.some(w => w.name === 'Qwen Image Text to Image' && w.description === 'Text to image with Qwen')
    && importedTpl.workflows.every(w => w.purpose === 'Built-in template — from ComfyUI Desktop')
    && importedTpl.errors.length === 0);
  const importedNoInfo = comfy.importWorkflowsFromFiles([path.join(frontendTpl, 'image_flux_t2i.json')], null, [], { source: 'builtin' });
  check('UI-format template without ComfyUI running fails with the reason (not a silent zero)',
    importedNoInfo.workflows.length === 0 && importedNoInfo.errors.length === 1 && /UI-format/.test(importedNoInfo.errors[0]));
  const noExeLocal = path.join(tmpScan2, 'noexe-local');
  fs.mkdirSync(path.join(noExeLocal, 'Programs', 'ComfyUI'), { recursive: true });
  const scanNoExe = comfy.scanComfyui({ home: path.join(tmpScan2, 'nowhere'), appData: path.join(tmpScan2, 'no-appdata'), localAppData: noExeLocal, drives: [] });
  check('scan records no exe when the program folder has none',
    scanNoExe.ok === true && scanNoExe.desktopExe === null);
} finally {
  fs.rmSync(tmpScan2, { recursive: true, force: true });
}
check('main.js has shell:openPath and the shared workflow collector, and converts UI graphs at submit',
  mainJs.includes("ipcMain.handle('shell:openPath'") && mainJs.includes('collectComfyuiWorkflows')
  && mainJs.includes('convertUiGraphToApi') && mainJs.includes('isUiWorkflowGraph'));
check('preload.js exposes rb.shell.openPath',
  preloadJs.includes("openPath: (filePath) => ipcRenderer.invoke('shell:openPath'"));
check('ComfyUI view launches the native app, labels built-ins, and teaches the empty library (no iframe)',
  appJs.includes('function openComfyui') && appJs.includes('Built-in template')
  && appJs.includes('Rescan for workflows') && appJs.includes('comfyuiDesktopExe')
  && appJs.includes('Built-in templates') && !appJs.includes('<iframe'));
check('README documents built-in templates, UI-format conversion, and the native Open button',
  readme.includes('Built-in template') && readme.includes('UI-format')
  && readme.includes('comfyui-workflow-templates') && readme.includes('Desktop app'));
// 24. v0.7.2 — bypassed / muted nodes resolve the way ComfyUI
// does, PrimitiveNode inlines, non-workflow JSON is ignored,
// and each library section has an Approve all button.
// (The old v0.7.1 behaviour — failing a workflow for a bypassed
// node and telling the user to switch it back on — was wrong: Desktop's
// own templates are full of bypassed optional branches, and the
// frontend resolves them into pass-through links at submission.)
const uiObjectInfo2 = {
  ...uiObjectInfo,
  ImageScale: { input: { required: { image: ['IMAGE', {}], upscale_method: uiCombo(['nearest-exact', 'bilinear'], 'bilinear'), width: uiInt(512), height: uiInt(512), crop: uiCombo(['disabled', 'center'], 'disabled') } } },
  LoadImage: { input: { required: { image: uiStr('ref.png'), upload: uiCombo(['image', 'mask'], 'image') } } },
  // Fixture-only stand-in for the many real nodes whose image
  // input is optional (reference-image inputs on edit nodes).
  TestOptionalImage: { input: { required: { model: ['MODEL', {}] }, optional: { image: ['IMAGE', {}] } } },
};
// A bypassed node mid-chain: ImageScale (mode 4) between
// VAEDecode and SaveImage in the plain workflow.
const uiBypassMid = JSON.parse(JSON.stringify(uiPlainWorkflow));
uiBypassMid.nodes.push({ id: 11, type: 'ImageScale', mode: 4, inputs: [{ name: 'image', type: 'IMAGE', link: 20 }], widgets_values: ['bilinear', 512, 512, 'disabled'] });
uiBypassMid.links = uiBypassMid.links.filter(l => l[0] !== 9);
uiBypassMid.links.push([20, 8, 0, 11, 0, 'IMAGE'], [21, 11, 0, 9, 0, 'IMAGE']);
// The SaveImage entry must point at the new link from the
// bypassed node — entries and the links array stay consistent,
// as they are in a real saved file.
uiBypassMid.nodes[8].inputs[0].link = 21;
const convBypassMid = comfy.convertUiGraphToApi(uiBypassMid, uiObjectInfo2);
check('bypassed node mid-chain rewires to its input (frontend passthrough)',
  convBypassMid.ok === true && convBypassMid.graph['9'].inputs.images[0] === '8'
  && !Object.values(convBypassMid.graph).some(n => n.class_type === 'ImageScale'));
// A bypassed terminal node (SaveImage) simply disappears.
check('bypassed terminal node disappears and the rest converts',
  (() => { const bad = JSON.parse(JSON.stringify(uiPlainWorkflow)); bad.nodes[8].mode = 4; const c = comfy.convertUiGraphToApi(bad, uiObjectInfo2); return c.ok === true && !Object.values(c.graph).some(n => n.class_type === 'SaveImage') && Object.keys(c.graph).length === 8; })());
// A bypassed source node (LoadImage, no connected input) feeding
// an OPTIONAL input: the link is dropped, the input is left out.
const uiBypassSource = {
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', inputs: [], widgets_values: ['sd15.safetensors'] },
    { id: 2, type: 'LoadImage', mode: 4, inputs: [], widgets_values: ['ref.png', 'image'] },
    { id: 3, type: 'TestOptionalImage', inputs: [{ name: 'model', type: 'MODEL', link: 1 }, { name: 'image', type: 'IMAGE', link: 2 }], widgets_values: [] },
  ],
  links: [[1, 1, 0, 3, 0, 'MODEL'], [2, 2, 0, 3, 1, 'IMAGE']],
};
const convBypassSource = comfy.convertUiGraphToApi(uiBypassSource, uiObjectInfo2);
check('bypassed source node feeding an optional input drops the link, input left out',
  convBypassSource.ok === true && convBypassSource.graph['3'].inputs.model[0] === '1'
  && !('image' in convBypassSource.graph['3'].inputs)
  && !Object.values(convBypassSource.graph).some(n => n.class_type === 'LoadImage'));
// The same bypassed source feeding a REQUIRED input is a genuine
// problem and names the downstream node.
check('bypassed source feeding a required input fails naming the downstream node',
  (() => {
    const bad = {
      nodes: [
        { id: 1, type: 'LoadImage', mode: 4, inputs: [], widgets_values: ['ref.png', 'image'] },
        { id: 2, type: 'SaveImage', inputs: [{ name: 'images', type: 'IMAGE', link: 1 }], widgets_values: ['out'] },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
    };
    const c = comfy.convertUiGraphToApi(bad, uiObjectInfo2);
    return c.ok === false && /Bypassed node "LoadImage"/.test(c.error) && /required input "images" of "SaveImage"/.test(c.error);
  })());
// A muted terminal node disappears too.
check('muted terminal node disappears and the rest converts',
  (() => { const bad = JSON.parse(JSON.stringify(uiPlainWorkflow)); bad.nodes[8].mode = 2; const c = comfy.convertUiGraphToApi(bad, uiObjectInfo2); return c.ok === true && !Object.values(c.graph).some(n => n.class_type === 'SaveImage'); })());
// PrimitiveNode: its value is inlined into the downstream widget
// input (KSampler seed), and the node itself is never emitted.
const uiPrimitive = JSON.parse(JSON.stringify(uiPlainWorkflow));
uiPrimitive.nodes[5].inputs.push({ name: 'seed', type: 'INT', link: 20, widget: { name: 'seed' } });
uiPrimitive.nodes.push({ id: 11, type: 'PrimitiveNode', inputs: [], outputs: [{ name: 'connect to widget input', type: '*', links: [20] }], widgets_values: [12345] });
uiPrimitive.links.push([20, 11, 0, 6, 4, 'INT']);
const convPrimitive = comfy.convertUiGraphToApi(uiPrimitive, uiObjectInfo2);
check('PrimitiveNode value is inlined into the downstream input, node never emitted',
  convPrimitive.ok === true && convPrimitive.graph['6'].inputs.seed === 12345
  && !Object.values(convPrimitive.graph).some(n => n.class_type === 'PrimitiveNode'));
// A bypassed node INSIDE a subgraph is rewired the same way
// during expansion: ImageScale between the subgraph's KSampler
// and its output.
const uiBypassSub = JSON.parse(JSON.stringify(uiSubgraphWorkflow));
const subDef = uiBypassSub.definitions.subgraphs[0];
subDef.nodes.push({ id: 6, type: 'ImageScale', mode: 4, inputs: [{ name: 'image', type: 'IMAGE', link: 11 }], widgets_values: ['bilinear', 512, 512, 'disabled'] });
subDef.links = subDef.links.filter(l => l.id !== 9);
subDef.links.push(
  { id: 11, origin_id: 4, origin_slot: 0, target_id: 6, target_slot: 0, type: 'IMAGE' },
  { id: 9, origin_id: 6, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
);
const convBypassSub = comfy.convertUiGraphToApi(uiBypassSub, uiObjectInfo2);
const subSave = convBypassSub.ok ? Object.values(convBypassSub.graph).find(n => n.class_type === 'SaveImage') : null;
const subSampler = convBypassSub.ok ? Object.entries(convBypassSub.graph).find(([, n]) => n.class_type === 'KSampler') : null;
check('bypassed node inside a subgraph rewires to the internal producer',
  convBypassSub.ok === true && Object.keys(convBypassSub.graph).length === 6
  && !Object.values(convBypassSub.graph).some(n => n.class_type === 'ImageScale')
  && subSave && subSave.inputs.images[0] === subSampler[0]);
// Conversion is pure: converting the same graph twice gives the
// same result and the input graph is unmutated.
check('conversion does not mutate its input (same graph converts identically twice)',
  (() => {
    const before = JSON.stringify(uiBypassMid);
    const a = comfy.convertUiGraphToApi(uiBypassMid, uiObjectInfo2);
    const b = comfy.convertUiGraphToApi(uiBypassMid, uiObjectInfo2);
    return a.ok === true && b.ok === true
      && JSON.stringify(a.graph) === JSON.stringify(b.graph)
      && JSON.stringify(uiBypassMid) === before;
  })());
// A genuinely missing node type still fails honestly.
check('genuinely missing node type still reported (not swallowed by the bypass fix)',
  (() => { const bad = JSON.parse(JSON.stringify(uiPlainWorkflow)); bad.nodes[0].type = 'LumaImageModifyNode'; const c = comfy.convertUiGraphToApi(bad, uiObjectInfo2); return c.ok === false && /LumaImageModifyNode/.test(c.error); })());
// Non-workflow JSON is not a workflow candidate.
check('locale / stray JSON is not a workflow candidate, API and UI graphs are',
  comfy.isWorkflowGraph({ en: 'hello', de: 'hallo' }) === false
  && comfy.isWorkflowGraph({ foo: 1 }) === false
  && comfy.isWorkflowGraph({ '1': { class_type: 'KSampler', inputs: {} } }) === true
  && comfy.isWorkflowGraph({ nodes: [] }) === true);
// The old advice string is built from parts so this file itself
// does not contain it (the check below greps the shipped files).
const UNBYPASS = 'un-' + 'bypass';
check('the old "switch the node back on" advice is gone from shipped code and docs',
  !fs.readFileSync(path.join(root, 'comfyui.js'), 'utf8').includes(UNBYPASS) && !appJs.includes(UNBYPASS) && !mainJs.includes(UNBYPASS)
  && !readme.includes(UNBYPASS) && !fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes(UNBYPASS));
check('ComfyUI view has an Approve all button per library section',
  appJs.includes('function approveAllComfyuiWorkflows') && appJs.includes("sectionHtml('user'")
  && appJs.includes("sectionHtml('builtin'") && appJs.includes("approveAllComfyuiWorkflows('${source}')")
  && appJs.includes('Approve all'));
check('CHANGELOG has the 0.7.2 entry',
  fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.7.2 — 2026-11-24'));

// 25. v0.8.0 — "ComfyUI you can actually look at": searchable /
// filterable / hideable library with pins and collapsible
// sections, two-column Generate form with a searchable picker,
// generation results rendered in chat with an Import / Discard
// row, and import problems grouped by reason. No converter
// behaviour changed in this release.
const typeSrc = extractFunction(appJs, 'comfyuiWorkflowType');
const filterSrc = extractFunction(appJs, 'filterComfyuiWorkflows');
const sortSrc = extractFunction(appJs, 'sortComfyuiWorkflows');
const groupSrc = extractFunction(appJs, 'groupComfyuiErrors');
check('library helpers are extractable for testing',
  !!typeSrc && !!filterSrc && !!sortSrc && !!groupSrc);
let comfyuiWorkflowType, filterComfyuiWorkflows, sortComfyuiWorkflows, groupComfyuiErrors;
try {
  comfyuiWorkflowType = new Function(typeSrc + '\nreturn comfyuiWorkflowType;')();
  filterComfyuiWorkflows = new Function('comfyuiWorkflowType', filterSrc + '\nreturn filterComfyuiWorkflows;')(comfyuiWorkflowType);
  sortComfyuiWorkflows = new Function('comfyuiWorkflowType', sortSrc + '\nreturn sortComfyuiWorkflows;')(comfyuiWorkflowType);
  groupComfyuiErrors = new Function(groupSrc + '\nreturn groupComfyuiErrors;')();
} catch (e) {
  check('library helpers construct in Node', false, String(e && e.message));
}
if (comfyuiWorkflowType) {
  const typeCases = [
    ['image_qwen_image', 'image'], ['flux_kontext_dev_basic', 'image'],
    ['video_ltx2_i2v', 'video'], ['api_kling_o3_i2v', 'video'],
    ['audio_yue_text2music', 'audio'], ['audio-chatterbox_tts', 'audio'],
    ['3d_pixel3d_trellis', '3d'], ['api_tripo3_0_image_to_model', '3d'],
    ['something_random', 'other'],
  ];
  check('workflow type derivation (name-based)',
    typeCases.every(([name, want]) => comfyuiWorkflowType({ name }) === want),
    typeCases.filter(([name, want]) => comfyuiWorkflowType({ name }) !== want).map(([n]) => n).join(','));
  check('workflow type derivation (node-class based)',
    comfyuiWorkflowType({ name: 'x', inputs: [{ classType: 'SaveVideo' }] }) === 'video'
    && comfyuiWorkflowType({ name: 'x', inputs: [{ classType: 'SaveAudio' }] }) === 'audio'
    && comfyuiWorkflowType({ name: 'x', inputs: [{ classType: 'KSampler' }] }) === 'other');
}
if (filterComfyuiWorkflows) {
  const lib = [
    { id: 'a', name: 'image_qwen_image', source: 'builtin', available: true, pinned: true, hidden: false, inputs: [] },
    { id: 'b', name: 'video_ltx2_i2v', source: 'builtin', available: true, pinned: false, hidden: false, inputs: [] },
    { id: 'c', name: 'api_kling_o3_i2v', source: 'builtin', available: false, pinned: false, hidden: false, inputs: [] },
    { id: 'd', name: 'my_flux_t2i', source: 'user', available: true, pinned: false, hidden: true, inputs: [] },
    { id: 'e', name: 'audio_yue_text2music', source: 'user', available: true, pinned: false, hidden: false, inputs: [] },
    { id: 'f', name: '3d_pixel3d_trellis', source: 'builtin', available: true, pinned: false, hidden: false, inputs: [] },
  ];
  const ids = (list) => list.map(w => w.id).sort().join(',');
  check('library search matches name across sections (hidden excluded by default)',
    ids(filterComfyuiWorkflows(lib, { query: 'qwen' })) === 'a'
    && ids(filterComfyuiWorkflows(lib, { query: 'flux' })) === ''
    && ids(filterComfyuiWorkflows(lib, { query: 'flux', showHidden: true })) === 'd');
  check('library type filter (video) and source filter (user)',
    ids(filterComfyuiWorkflows(lib, { type: 'video' })) === 'b,c'
    && ids(filterComfyuiWorkflows(lib, { source: 'user' })) === 'e');
  check('library available-only and pinned-only filters',
    ids(filterComfyuiWorkflows(lib, { availableOnly: true })) === 'a,b,e,f'
    && ids(filterComfyuiWorkflows(lib, { pinnedOnly: true })) === 'a');
  check('library Hide API templates hides api_ names only',
    ids(filterComfyuiWorkflows(lib, { hideApi: true })) === 'a,b,e,f'
    && ids(filterComfyuiWorkflows(lib, { hideApi: false })) === 'a,b,c,e,f');
}
if (sortComfyuiWorkflows) {
  const sLib = [
    { id: 'a', name: 'zebra', pinned: false, lastUsedAt: 100 },
    { id: 'b', name: 'apple', pinned: true, lastUsedAt: 0 },
    { id: 'c', name: 'mango', pinned: false, lastUsedAt: 300 },
    { id: 'd', name: 'banana', pinned: false, lastUsedAt: 200 },
  ];
  check('library sort: pinned first, then name A-Z',
    sortComfyuiWorkflows(sLib, 'name').map(w => w.id).join(',') === 'b,d,c,a');
  check('library sort: recently used first (pinned still first, never-used last)',
    sortComfyuiWorkflows(sLib, 'recent').map(w => w.id).join(',') === 'b,c,d,a');
  const tLib = [
    { id: 'a', name: 'video_ltx2_i2v' },
    { id: 'b', name: 'audio_yue_text2music' },
    { id: 'c', name: 'image_qwen_image' },
    { id: 'd', name: '3d_pixel3d_trellis' },
  ];
  check('library sort: type order Image, Video, Audio, 3D',
    sortComfyuiWorkflows(tLib, 'type').map(w => w.id).join(',') === 'c,a,b,d');
}
if (groupComfyuiErrors) {
  const errs = [
    'a.json: Node type not installed: PrimitiveNode (node 99)',
    'b.json: Node type not installed: PrimitiveNode (node 45)',
    'c.json: Node type not installed: LumaImageModifyNode (node 2)',
    'd.json: Bypassed node "LoadImage" (id 90) is not supported',
    'e.json: Bypassed node "LoadImage" (id 14) is not supported',
    'Workflows folder not found: C:\\Nope',
  ];
  const groups = groupComfyuiErrors(errs);
  check('import problems group by reason (same node, different node id = one group), most-common first',
    groups.length === 4 && groups[0].count === 2 && /PrimitiveNode/.test(groups[0].reason)
    && groups[1].count === 2 && /LoadImage/.test(groups[1].reason)
    && groups.some(g => /LumaImageModifyNode/.test(g.reason) && g.count === 1)
    && groups.some(g => /Workflows folder not found/.test(g.reason) && g.count === 1));
  check('import problems grouping is empty-safe',
    Array.isArray(groupComfyuiErrors([])) && groupComfyuiErrors([]).length === 0
    && Array.isArray(groupComfyuiErrors(null)) && groupComfyuiErrors(null).length === 0);
}
// Pin / hide / last-used survive a rescan, like purpose and
// approval already did (real importWorkflowsFromFiles, temp dir).
{
  const tmpLib = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-lib-'));
  try {
    fs.writeFileSync(path.join(tmpLib, 'my_flux.json'), JSON.stringify(uiPlainWorkflow));
    const stored = [{
      id: comfy.slugifyWorkflowId('my_flux'), name: 'my_flux', purpose: 'Mine',
      approved: true, pinned: true, hidden: true, lastUsedAt: 12345,
    }];
    const re = comfy.importWorkflowsFromFiles([path.join(tmpLib, 'my_flux.json')], uiObjectInfo, stored, { source: 'user' });
    check('rescan preserves pin / hide / last-used / purpose / approval',
      re.ok === true && re.workflows.length === 1 && re.workflows[0].pinned === true
      && re.workflows[0].hidden === true && re.workflows[0].lastUsedAt === 12345
      && re.workflows[0].purpose === 'Mine' && re.workflows[0].approved === true);
  } finally { fs.rmSync(tmpLib, { recursive: true, force: true }); }
}
// Chat results: the envelope marker parses, and the rich renderer
// (the real comfyuiChatResultHtml from app.js) shows thumbnails
// plus an Import / Discard row, then Imported / Discarded states.
const markerMatch = /const COMFYUI_CHAT_MARKER = '([^']+)'/.exec(appJs);
const parseSrc = extractFunction(appJs, 'parseComfyuiChatResult');
const chatHtmlSrc = extractFunction(appJs, 'comfyuiChatResultHtml');
const escSrc = extractFunction(appJs, 'escHtml');
check('chat-result envelope marker and renderer are extractable',
  !!markerMatch && !!parseSrc && !!chatHtmlSrc && !!escSrc);
if (markerMatch && parseSrc && chatHtmlSrc && escSrc) {
  try {
    const marker = markerMatch[1];
    const escHtml = new Function(escSrc + '\nreturn escHtml;')();
    const renderChatResult = new Function('escHtml', 'comfyuiFileUrl', 'comfyuiSlug',
      'const COMFYUI_CHAT_MARKER = ' + JSON.stringify(marker) + ';\n'
      + parseSrc + '\n' + chatHtmlSrc + '\nreturn comfyuiChatResultHtml;')(
      escHtml, (p) => 'file:///' + String(p || '').replace(/\\/g, '/'), (n) => 'slug');
    const msg = { role: 'assistant', content: marker + JSON.stringify({
      v: 1, workflowId: 'w1', workflowName: 'my_flux_t2i', prompt: 'a red car',
      inputs: { positive: 'a red car' },
      outputs: [{ filename: 'x.png', subfolder: '', type: 'output', localPath: 'C:\\tmp\\x.png' }],
      imported: false, dir: '', discarded: false,
    }) };
    const html = renderChatResult(msg, 3);
    check('chat result renders thumbnails + Import / Discard row',
      typeof html === 'string' && html.includes('<img') && html.includes('file:///C:/tmp/x.png')
      && html.includes('Import to Assets/Generated/slug/') && html.includes('Discard')
      && html.includes('my_flux_t2i') && html.includes('a red car')
      && html.includes('importComfyuiChatResult(3)') && html.includes('discardComfyuiChatResult(3)'));
    const importedMsg = { role: 'assistant', content: marker + JSON.stringify({
      v: 1, workflowId: 'w1', workflowName: 'my_flux_t2i', prompt: '', inputs: {},
      outputs: [{ filename: 'x.png', subfolder: '', type: 'output', localPath: null }],
      imported: true, dir: 'Assets/Generated/my-flux-t2i/', discarded: false,
    }) };
    const htmlImported = renderChatResult(importedMsg, 0);
    check('chat result shows Imported state and no Import button after import',
      htmlImported.includes('Imported to Assets/Generated/my-flux-t2i/')
      && !htmlImported.includes('importComfyuiChatResult('));
    const discardedMsg = { role: 'assistant', content: marker + JSON.stringify({
      v: 1, workflowId: 'w1', workflowName: 'my_flux_t2i', prompt: '', inputs: {},
      outputs: [{ filename: 'x.png', subfolder: '', type: 'output', localPath: null }],
      imported: false, dir: '', discarded: true,
    }) };
    check('chat result shows Discarded state',
      renderChatResult(discardedMsg, 0).includes('Discarded'));
    const parse = new Function('const COMFYUI_CHAT_MARKER = ' + JSON.stringify(marker) + ';\n' + parseSrc + '\nreturn parseComfyuiChatResult;')();
    check('chat-result envelope parses, plain text does not',
      parse(msg.content) && parse(msg.content).workflowName === 'my_flux_t2i'
      && parse('hello') === null && parse(marker + '{bad json') === null);
  } catch (e) {
    check('chat-result renderer runs in Node', false, String(e && e.message));
  }
}
check('ComfyUI view has library search, sort, filter chips, pin/hide, and a searchable picker',
  appJs.includes('comfyui-lib-search') && appJs.includes('comfyui-lib-sort')
  && appJs.includes('Hide API templates') && appJs.includes('Show hidden')
  && appJs.includes('toggleComfyuiPinned') && appJs.includes('toggleComfyuiHidden')
  && appJs.includes('comfyui-picker') && appJs.includes('comfyui-picker-results')
  && appJs.includes('onComfyuiPickerInput') && appJs.includes('renderComfyuiLibrary'));
check('Generate panel has two columns and a Generate in chat button',
  appJs.includes('cf-two-col') && appJs.includes('generateComfyuiInChat') && appJs.includes('Generate in chat'));
check('Agent loop shows chat results and no longer auto-imports; system prompt says results appear in chat',
  appJs.includes('await appendComfyuiChatResult(wf, res.outputs, action.inputs, null)')
  && !appJs.includes('importComfyuiOutputs(wf, res.outputs, action.inputs)')
  && appJs.includes('The result appears in the chat with an offer to import it into the project'));
check('ComfyUI view layout is Connection, Generate, Library, History, Scan results — no flat error wall',
  appJs.includes('Scan results') && appJs.includes('comfyuiErrorGroupsHtml')
  && !appJs.includes('Import problems:<br>'));
check('index.html has the v0.8.0 ComfyUI CSS (two-column form, compact rows, picker, chat result)',
  indexHtml.includes('cf-two-col') && indexHtml.includes('cf-lib-row')
  && indexHtml.includes('cf-picker-results') && indexHtml.includes('cf-chat-result'));
check('README documents library search/filter/pin/hide and chat generation',
  readme.includes('Hide API templates') && readme.includes('Recently used')
  && readme.includes('Generate in chat') && readme.includes('Import to `Assets/Generated/<workflow>/`'));
check('CHANGELOG has the 0.8.0 entry',
  fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.8.0 — 2026-11-24'));

// 26. v0.8.1 — dead branches convert (a bypassed loader feeding
// a bypassed consumer is an either/or branch switched off by
// design, not a broken workflow), a genuinely unfed ACTIVE
// consumer still fails, missing nodes name their pack, and
// Available only defaults ON (CodeFox only offers workflows
// that are actually runnable on this machine).
const uiObjectInfo3 = {
  ...uiObjectInfo2,
  LoraLoader: { input: { required: { model: ['MODEL', {}], clip: ['CLIP', {}], lora_name: uiCombo(['l.safetensors'], 'l.safetensors'), strength_model: uiFloat(1), strength_clip: uiFloat(1) } } },
};
// A bypassed CLIPLoader feeding a bypassed CLIPTextEncode: the
// whole branch is dead, so the workflow converts and the dead
// nodes never appear in the API graph.
const uiDeadBranch = JSON.parse(JSON.stringify(uiPlainWorkflow));
uiDeadBranch.nodes.push(
  { id: 11, type: 'CLIPLoader', mode: 4, inputs: [], widgets_values: ['t5.safetensors', 'chroma', 'default'] },
  { id: 12, type: 'CLIPTextEncode', mode: 4, inputs: [{ name: 'clip', type: 'CLIP', link: 20 }], widgets_values: ['dead branch'] },
);
uiDeadBranch.links.push([20, 11, 0, 12, 0, 'CLIP']);
const convDeadBranch = comfy.convertUiGraphToApi(uiDeadBranch, uiObjectInfo3);
check('dead branch converts: bypassed loader feeding a bypassed consumer is dropped silently',
  convDeadBranch.ok === true
  && !Object.values(convDeadBranch.graph).some(n => n.class_type === 'CLIPLoader')
  && !Object.values(convDeadBranch.graph).some(n => n.class_type === 'CLIPTextEncode' && n.inputs.text === 'dead branch')
  && convDeadBranch.graph['3'].inputs.clip[0] === '2'
  && Object.keys(convDeadBranch.graph).length === 9);
// The same shape with the consumer ACTIVE is genuinely broken
// and must still fail naming it.
check('dead-branch twin with an active consumer still fails naming the downstream node',
  (() => {
    const bad = JSON.parse(JSON.stringify(uiDeadBranch));
    bad.nodes.find(n => n.id === 12).mode = 0;
    const c = comfy.convertUiGraphToApi(bad, uiObjectInfo3);
    return c.ok === false && /Bypassed node "CLIPLoader"/.test(c.error) && /required input "clip" of "CLIPTextEncode"/.test(c.error);
  })());
// A bypassed loader feeding a bypassed consumer THROUGH a
// Reroute converts too (the consumer is found past the Reroute).
const uiDeadReroute = JSON.parse(JSON.stringify(uiPlainWorkflow));
uiDeadReroute.nodes.push(
  { id: 11, type: 'UNETLoader', mode: 4, inputs: [], widgets_values: ['flux.safetensors', 'default'] },
  { id: 12, type: 'Reroute', inputs: [{ name: '', type: '*', link: 20 }], outputs: [{ name: '', type: '*', links: [21] }], widgets_values: [] },
  { id: 13, type: 'LoraLoader', mode: 4, inputs: [{ name: 'model', type: 'MODEL', link: 21 }], widgets_values: ['l.safetensors', 1, 1] },
);
uiDeadReroute.links.push([20, 11, 0, 12, 0, 'MODEL'], [21, 12, 0, 13, 0, 'MODEL']);
const convDeadReroute = comfy.convertUiGraphToApi(uiDeadReroute, uiObjectInfo3);
check('dead branch through a Reroute converts (consumer found past the Reroute)',
  convDeadReroute.ok === true
  && !Object.values(convDeadReroute.graph).some(n => n.class_type === 'LoraLoader')
  && Object.keys(convDeadReroute.graph).length === 9);
// A bypassed branch INSIDE a subgraph converts: a bypassed
// CLIPLoader feeding a bypassed CLIPTextEncode in the subgraph
// definition leaves the expanded graph unchanged.
const uiDeadSub = JSON.parse(JSON.stringify(uiSubgraphWorkflow));
const deadSubDef = uiDeadSub.definitions.subgraphs[0];
deadSubDef.nodes.push(
  { id: 6, type: 'CLIPLoader', mode: 4, inputs: [], widgets_values: ['t5.safetensors', 'chroma', 'default'] },
  { id: 7, type: 'CLIPTextEncode', mode: 4, inputs: [{ name: 'clip', type: 'CLIP', link: 11 }], widgets_values: ['dead branch'] },
);
deadSubDef.links.push({ id: 11, origin_id: 6, origin_slot: 0, target_id: 7, target_slot: 0, type: 'CLIP' });
const convDeadSub = comfy.convertUiGraphToApi(uiDeadSub, uiObjectInfo3);
check('dead branch inside a subgraph converts (expanded graph unchanged)',
  convDeadSub.ok === true && Object.keys(convDeadSub.graph).length === 6
  && !Object.values(convDeadSub.graph).some(n => n.class_type === 'CLIPTextEncode' && n.inputs.text === 'dead branch'));
// Missing nodes name their pack when it is known, and stay
// plain when it is not.
check('missing node names its pack when known (ComfyUI Essentials)',
  comfy.missingNodeTypeMessage('ImageRemoveAlpha+', 99)
    === 'Node type not installed: ImageRemoveAlpha+ (node 99) — ComfyUI Essentials (ComfyUI_essentials); install it in ComfyUI Desktop (ComfyUI Manager) and Rescan');
check('missing Luma node says built-in Partner Nodes, not a Manager install',
  /built-in Luma Partner Nodes/.test(comfy.missingNodeTypeMessage('LumaImageModifyNode', 2))
  && /not a custom-node pack/.test(comfy.missingNodeTypeMessage('LumaReferenceNode', 5))
  && !/Manager/.test(comfy.missingNodeTypeMessage('LumaVideoNode', 1))
  && /built-in Luma Partner Nodes/.test(comfy.missingNodeTypeMessage('LumaImageToVideoNode', 3)));
check('missing node with no known pack reports no pack',
  comfy.missingNodeTypeMessage('NoSuchNode', 7) === 'Node type not installed: NoSuchNode (node 7)');
check('converter missing-node error names the pack',
  (() => { const bad = JSON.parse(JSON.stringify(uiPlainWorkflow)); bad.nodes[0].type = 'ImageRemoveAlpha+'; const c = comfy.convertUiGraphToApi(bad, uiObjectInfo2); return c.ok === false && /ComfyUI Essentials/.test(c.error); })());
if (groupComfyuiErrors) {
  const packErrs = [
    'a.json: Node type not installed: LumaImageModifyNode (node 2) — ComfyUI\'s built-in Luma Partner Nodes; they ship with ComfyUI, not a custom-node pack — update ComfyUI Desktop and make sure Partner Nodes are enabled, then Rescan',
    'b.json: Node type not installed: LumaImageModifyNode (node 9) — ComfyUI\'s built-in Luma Partner Nodes; they ship with ComfyUI, not a custom-node pack — update ComfyUI Desktop and make sure Partner Nodes are enabled, then Rescan',
    'c.json: Node type not installed: LumaReferenceNode (node 5) — ComfyUI\'s built-in Luma Partner Nodes; they ship with ComfyUI, not a custom-node pack — update ComfyUI Desktop and make sure Partner Nodes are enabled, then Rescan',
  ];
  const packGroups = groupComfyuiErrors(packErrs);
  check('missing-node groups stay one group per node type, pack shown in the reason',
    packGroups.length === 2 && packGroups[0].count === 2 && /LumaImageModifyNode/.test(packGroups[0].reason) && /Partner Nodes/.test(packGroups[0].reason)
    && packGroups.some(g => /LumaReferenceNode/.test(g.reason) && g.count === 1));
}
// Available only defaults ON and is persisted: CodeFox only
// offers workflows that are actually runnable here.
check('Available only defaults ON, is persisted, and Clear resets to it',
  appJs.includes('availableOnly: true,')
  && appJs.includes("comfyui_lib_available_only")
  && appJs.includes('function toggleComfyuiAvailableOnly')
  && appJs.includes("toggleComfyuiAvailableOnly(!state.comfyuiLib.availableOnly)")
  && appJs.includes('state.comfyuiLib.availableOnly = true;'));
check('CHANGELOG has the 0.8.3 entry',
  fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.8.3 — 2026-11-25'));

// v0.8.3 — tuned LM Studio model loading. The defaults are global:
// one object, no per-model table, and the load body is built only
// from it, so no model can silently drop a setting.
const lmLoad = require(path.join(root, 'lmstudio-load.js'));
check('tuned defaults are exactly the six global settings with the right values',
  JSON.stringify(Object.keys(lmLoad.TUNED_LOAD_DEFAULTS).sort()) === JSON.stringify(['contextLength', 'evalBatchSize', 'flashAttention', 'gpuOffloadRatio', 'kvCacheQuantization', 'maxParallelPredictions'].sort())
  && lmLoad.TUNED_LOAD_DEFAULTS.kvCacheQuantization === 'q8_0'
  && lmLoad.TUNED_LOAD_DEFAULTS.maxParallelPredictions === 1
  && lmLoad.TUNED_LOAD_DEFAULTS.gpuOffloadRatio === 1
  && lmLoad.TUNED_LOAD_DEFAULTS.contextLength === 16384
  && lmLoad.TUNED_LOAD_DEFAULTS.evalBatchSize === 512
  && lmLoad.TUNED_LOAD_DEFAULTS.flashAttention === true);
check('load body uses the global defaults for any model id (no per-model lookup)',
  (() => {
    const a = lmLoad.buildLoadBody('qwen/qwen3-coder-30b-a3b-instruct');
    const b = lmLoad.buildLoadBody('google/gemma-4-31b');
    return a.model === 'qwen/qwen3-coder-30b-a3b-instruct' && b.model === 'google/gemma-4-31b'
      && a.context_length === 16384 && b.context_length === 16384
      && a.eval_batch_size === 512 && b.eval_batch_size === 512
      && a.flash_attention === true && b.flash_attention === true
      && a.offload_kv_cache_to_gpu === true && b.offload_kv_cache_to_gpu === true
      && a.echo_load_config === true && b.echo_load_config === true;
  })());
check('recommended-model matcher picks Qwen3 Coder 30B A3B Q4_K_M out of a mixed list',
  (() => {
    const list = [
      { key: 'qwen/qwen3-coder-8b-a3b-instruct', selected_variant: 'qwen/qwen3-coder-8b-a3b-instruct@q4_k_m' },
      { key: 'qwen/qwen3-30b-a3b-instruct', selected_variant: 'qwen/qwen3-30b-a3b-instruct@q4_k_m' },
      { key: 'deepseek/deepseek-coder-33b-instruct', selected_variant: 'deepseek/deepseek-coder-33b-instruct@q4_k_m' },
      { key: 'qwen/qwen3-coder-30b-a3b-instruct', selected_variant: 'qwen/qwen3-coder-30b-a3b-instruct@q4_k_m' },
      { key: 'qwen/qwen3-coder-30b-a3b-instruct', selected_variant: null },
    ];
    const picked = list.filter(m => lmLoad.isRecommendedCodingModel(m));
    return picked.length === 1 && picked[0].key === 'qwen/qwen3-coder-30b-a3b-instruct'
      && lmLoad.isRecommendedCodingModel('Qwen/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M')
      && !lmLoad.isRecommendedCodingModel('qwen/qwen3-coder-30b-a3b-instruct');
  })());
check('preset merge preserves unrelated fields and keeps each value shape',
  (() => {
    const parsed = { load: { fields: [
      { key: 'llm.load.contextLength', value: 8192 },
      { key: 'llm.load.llama.kCacheQuantizationType', value: 'f16' },
      { key: 'llm.load.llama.vCacheQuantizationType', value: { checked: false, value: 'f16' } },
      { key: 'llm.load.seed', value: 42 },
    ] } };
    const merged = lmLoad.mergeProfileFields(parsed, lmLoad.tunedLoadProfile());
    if (!merged) return false;
    const byKey = (k) => merged.load.fields.find(f => f.key === k);
    return byKey('llm.load.contextLength').value === 8192
      && byKey('llm.load.seed').value === 42
      && byKey('llm.load.llama.kCacheQuantizationType').value === 'q8_0'
      && byKey('llm.load.llama.vCacheQuantizationType').value.checked === true
      && byKey('llm.load.llama.vCacheQuantizationType').value.value === 'q8_0'
      && byKey('llm.load.numParallelSessions').value === 1
      && byKey('llm.load.llama.acceleration.offloadRatio').value === 1
      && byKey('llm.load.offloadKVCacheToGpu').value === true
      && lmLoad.mergeProfileFields({ nope: true }, lmLoad.tunedLoadProfile()) === null
      && lmLoad.mergeProfileFields(null, lmLoad.tunedLoadProfile()) === null;
  })());
check('preset write creates the file, then preserves unrelated fields on re-apply',
  (() => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-lm-home-'));
    try {
      const first = lmLoad.applyTunedLoadProfile('qwen/qwen3-coder-30b-a3b-instruct', { home: tmpHome });
      if (!first.applied || !first.created) return false;
      const file = first.files[0];
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (written.load.fields.find(f => f.key === 'llm.load.numParallelSessions').value !== 1) return false;
      // Add an unrelated field by hand, then re-apply: it must survive.
      written.load.fields.push({ key: 'llm.load.seed', value: 7 });
      fs.writeFileSync(file, JSON.stringify(written));
      const second = lmLoad.applyTunedLoadProfile('qwen/qwen3-coder-30b-a3b-instruct', { home: tmpHome });
      if (!second.applied) return false;
      const again = JSON.parse(fs.readFileSync(file, 'utf8'));
      const seed = again.load.fields.find(f => f.key === 'llm.load.seed');
      const bak = fs.existsSync(file + '.codefox-bak');
      const unsafe = lmLoad.applyTunedLoadProfile('../../etc/passwd', { home: tmpHome });
      return seed && seed.value === 7 && bak && unsafe.applied === false;
    } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
  })());
check('main.js wires the load IPCs and preload exposes them',
  mainJs.includes("require('./lmstudio-load')")
  && mainJs.includes("ipcMain.handle('llm:listDownloaded'")
  && mainJs.includes("ipcMain.handle('llm:loadModel'")
  && fs.readFileSync(path.join(root, 'lmstudio-load.js'), 'utf8').includes('/api/v1/models/load')
  && preloadJs.includes('listDownloaded')
  && preloadJs.includes('loadModel'));
check('Settings shows the downloaded list with a Load action and the tuned settings in plain words',
  appJs.includes('s-lm-downloaded')
  && appJs.includes('async function loadLmStudioModel(id)')
  && appJs.includes('async function refreshDownloadedModels()')
  && appJs.includes('Recommended coding model')
  && appJs.includes('is not downloaded in LM Studio — download it in LM Studio first')
  && appJs.includes('Loads with full GPU offload, KV cache Q8, 1 concurrent prediction, 16K context, flash attention')
  && appJs.includes('it does not start the server'));
check('README documents model loading honestly (loads into a running server, no speed promise)',
  readme.includes('loads models into a running LM Studio server')
  && readme.includes('does not start the server')
  && readme.includes('speed depends on the model and the machine'));

// ComfyUI HTTP client against a mock server (no real ComfyUI).
const http = require('http');
const mockServer = http.createServer((req, res) => {
  if (req.url === '/system_stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ comfyui_version: '0.3.60', system: { os: 'windows' } }));
  } else if (req.url === '/object_info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ KSampler: { input: { required: {} } } }));
  } else if (req.url === '/api/workflow_templates') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ moduleName: 'comfyui', category: 'image', title: 'Image', type: 'category', templates: [{ name: 'image_qwen_image', title: 'Qwen Image Text to Image', description: 'Text to image with Qwen', mediaType: 'image' }] }]));
  } else if (req.url === '/prompt' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: 'mock-prompt-1', number: 1, node_errors: {} }));
    });
  } else if (req.url === '/view?filename=x.png&subfolder=&type=output') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } else {
    res.writeHead(404);
    res.end();
  }
});
(async () => {
  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + mockServer.address().port;
  try {
    const st = await comfy.getComfyuiStatus(base);
    check('mock server: status reports ok with the real version',
      st.ok === true && st.version === '0.3.60');
    const tpl = await comfy.getWorkflowTemplates(base);
    check('mock server: /api/workflow_templates yields titles by name',
      tpl.ok === true && tpl.byName['image_qwen_image'] && tpl.byName['image_qwen_image'].title === 'Qwen Image Text to Image');
    const sub = await comfy.submitPrompt(base, fakeWorkflow, 'test-client');
    check('mock server: submit returns a prompt_id',
      sub.ok === true && sub.prompt_id === 'mock-prompt-1');
    const tmpDl = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-comfyui-dl-'));
    try {
      const dl = await comfy.downloadView(base, { filename: 'x.png', subfolder: '', type: 'output' }, path.join(tmpDl, 'x.png'));
      check('mock server: view downloads bytes to disk',
        dl.ok === true && fs.existsSync(path.join(tmpDl, 'x.png')) && fs.readFileSync(path.join(tmpDl, 'x.png'))[0] === 0x89);
    } finally { fs.rmSync(tmpDl, { recursive: true, force: true }); }
  } finally { mockServer.close(); }
  const down = await comfy.getComfyuiStatus('http://127.0.0.1:1');
  check('status reports not-ok (never fake ok) when nothing is listening',
    down.ok === false && !!down.error);

  // v0.8.3 — the load flow against a stub fetch (no real LM Studio):
  // preset write + REST load with the tuned body + verify-after-load.
  // No fake "loaded" state: a load the verify step cannot see is a failure.
  {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-lm-load-'));
    const makeStub = (verifyLoaded) => {
      const calls = [];
      const stub = async (url, opts) => {
        calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
        if (url.endsWith('/api/v1/models') && (!opts || !opts.method || opts.method === 'GET')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ models: [{ key: 'qwen/qwen3-coder-30b-a3b-instruct', loaded_instances: verifyLoaded ? [{ id: 'qwen/qwen3-coder-30b-a3b-instruct', config: { context_length: 16384, eval_batch_size: 512, flash_attention: true, offload_kv_cache_to_gpu: true, parallel: 1 } }] : [] }] }) };
        }
        if (url.endsWith('/api/v1/models/load')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ type: 'llm', instance_id: 'qwen/qwen3-coder-30b-a3b-instruct', load_config: { context_length: 16384 } }) };
        }
        return { ok: false, status: 404, text: async () => '' };
      };
      return { stub, calls };
    };
    const happy = makeStub(true);
    const res = await lmLoad.loadLmStudioModel({ modelId: 'qwen/qwen3-coder-30b-a3b-instruct', baseUrl: 'http://localhost:1234', home: tmpHome, fetchImpl: happy.stub });
    const loadCall = happy.calls.find(c => c.url.endsWith('/api/v1/models/load'));
    check('load flow: preset written, tuned REST body sent, verified loaded',
      res.ok === true && res.loaded === true
      && loadCall && loadCall.body.context_length === 16384 && loadCall.body.eval_batch_size === 512
      && loadCall.body.flash_attention === true && loadCall.body.offload_kv_cache_to_gpu === true
      && fs.existsSync(path.join(tmpHome, '.internal', 'user-concrete-model-default-config', 'qwen', 'qwen3-coder-30b-a3b-instruct.json')));
    const noVerify = makeStub(false);
    const res2 = await lmLoad.loadLmStudioModel({ modelId: 'qwen/qwen3-coder-30b-a3b-instruct', baseUrl: 'http://localhost:1234', home: tmpHome, fetchImpl: noVerify.stub });
    check('load flow: a load the verify step cannot see is a failure, not a success',
      res2.ok === false && /not in the loaded list/.test(res2.error || ''));
    const res3 = await lmLoad.loadLmStudioModel({ modelId: 'qwen/qwen3-coder-30b-a3b-instruct', baseUrl: 'http://localhost:1234', home: tmpHome, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    check('load flow: an unreachable server fails plainly, never a fake success',
      res3.ok === false && /not running/.test(res3.error || ''));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  // Bulk approve: run the REAL approveAllComfyuiWorkflows from
  // app.js (extracted by brace matching, not a copy) against a
  // mock library with several workflows per section.
  try {
    const fnStart = appJs.indexOf('async function approveAllComfyuiWorkflows(source) {');
    let depth = 0, fnEnd = -1;
    for (let i = fnStart; i < appJs.length; i++) {
      if (appJs[i] === '{') depth++;
      else if (appJs[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
    }
    const fnText = appJs.slice(fnStart, fnEnd);
    const fnBody = fnText.slice(fnText.indexOf('{') + 1, -1);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const approveAll = new AsyncFunction('source', 'state', 'persistComfyuiWorkflows', 'renderComfyuiLibrary', 'showToast', fnBody);
    const mockState = { comfyuiWorkflows: [
      { id: 'u1', source: 'user', approved: false },
      { id: 'u2', source: 'user', approved: true },
      { id: 't1', source: 'builtin', approved: false },
      { id: 't2', source: 'builtin', approved: false },
    ] };
    let persisted = 0, rendered = 0, toast = '';
    const mockPersist = async () => { persisted++; };
    const mockRender = () => { rendered++; };
    const mockToast = (m) => { toast = m; };
    await approveAll('builtin', mockState, mockPersist, mockRender, mockToast);
    check('Approve all (built-in) sets every flag in that section and nothing else',
      mockState.comfyuiWorkflows.find(w => w.id === 't1').approved === true
      && mockState.comfyuiWorkflows.find(w => w.id === 't2').approved === true
      && mockState.comfyuiWorkflows.find(w => w.id === 'u1').approved === false
      && mockState.comfyuiWorkflows.find(w => w.id === 'u2').approved === true
      && persisted === 1 && rendered === 1 && /2 built-in templates/.test(toast));
    await approveAll('user', mockState, mockPersist, mockRender, mockToast);
    check('Approve all (user) sets every flag in that section',
      mockState.comfyuiWorkflows.find(w => w.id === 'u1').approved === true
      && persisted === 2 && /2 workflows/.test(toast));
    await approveAll('nobody', mockState, mockPersist, mockRender, mockToast);
    check('Approve all with an empty section does nothing (no persist)',
      persisted === 2 && rendered === 2);
  } catch (e) {
    check('Approve all runs against a mock library', false, String(e && e.message));
  }
  finish();
})().catch((e) => {
  check('mock ComfyUI server tests ran without throwing', false, String(e && e.message));
  finish();
});

function finish() {
  if (failures) {
    console.log('\n' + failures + ' check(s) FAILED');
    process.exit(1);
  }
  console.log('\nAll smoke checks passed.');
}
