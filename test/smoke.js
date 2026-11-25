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
for (const file of ['main.js', 'preload.js', 'app.js', 'upm-manifest.js', 'unity-assets.js', 'unity-bridge.js', 'unity-bridge-source.js', 'mcp-presets.js', 'comfyui.js', 'scripts/embed-bridge.js', 'test/smoke.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
    check('node --check ' + file, true);
  } catch (e) {
    check('node --check ' + file, false, String(e.message).split('\n')[0]);
  }
}

// 2. package.json version is 0.7.0.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check('package.json version is 0.7.0', pkg.version === '0.7.0', 'got ' + pkg.version);
check('sidebar footer shows 0.7.0', fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('CodeFox 0.7.0 — Local'));
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
  && appJs.includes('Workflow Library') && appJs.includes('Discovered capabilities'));
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

// ComfyUI HTTP client against a mock server (no real ComfyUI).
const http = require('http');
const mockServer = http.createServer((req, res) => {
  if (req.url === '/system_stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ comfyui_version: '0.3.60', system: { os: 'windows' } }));
  } else if (req.url === '/object_info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ KSampler: { input: { required: {} } } }));
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
