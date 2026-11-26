// CodeFox smoke test — plain Node, no dependencies.
// Run: node test/smoke.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ' (' + detail + ')' : ''));
  if (!ok) failures++;
}

// 1. Syntax-check every JS file we ship.
for (const file of ['main.js', 'preload.js', 'app.js', 'upm-manifest.js', 'unity-assets.js', 'unity-bridge.js', 'unity-bridge-source.js', 'unity-command.js', 'mcp-presets.js', 'comfyui.js', 'lmstudio-load.js', 'git-backup.js', 'file-tools.js', 'log-triage.js', 'context-budget.js', 'turn-ledger.js', 'docs-search.js', 'model-profiles.js', 'docs-engine.js', 'mcp-server/server.js', 'skill-files.js', 'eval/eval-tasks.js', 'eval/eval-mode.js', 'scripts/eval-runner.js', 'scripts/embed-bridge.js', 'test/smoke.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
    check('node --check ' + file, true);
  } catch (e) {
    check('node --check ' + file, false, String(e.message).split('\n')[0]);
  }
}

// 2. package.json version is 0.21.2.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check('package.json version is 0.21.2', pkg.version === '0.21.2', 'got ' + pkg.version);
check('sidebar footer shows 0.21.2', fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('CodeFox 0.21.2 — Local'));
check('installer has one unversioned name', pkg.build && pkg.build.artifactName === 'CodeFox-Setup.${ext}', 'got ' + (pkg.build && pkg.build.artifactName));
check('build scripts clean dist first', typeof pkg.scripts['build:win'] === 'string' && pkg.scripts['build:win'].includes('npm run clean'));
check('package.json has test script', typeof pkg.scripts.test === 'string' && pkg.scripts.test.includes('test/smoke.js'));

// 3. No occurrence of the forbidden word (case-insensitive) in any
// tracked text file, excluding .git and node_modules. The Unity
// docs fixtures under test/fixtures/unity-docs are excluded too:
// they are third-party Unity documentation, and Unity's own pages
// use a curve term that contains the forbidden substring — that is
// not a mention of the name, and CodeFox's own writing is what this
// check guards.
const FORBIDDEN = String.fromCharCode(98, 101, 122, 105); // built from codes so this file itself does not contain the word
const textExts = new Set(['.js', '.json', '.md', '.html', '.cs', '.ps1', '.nsh', '.txt']);
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    if (entry.name === 'unity-docs' && dir.endsWith(path.join('test', 'fixtures'))) continue;
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
  appJs.includes('applyFilesAction(action.changes') && appJs.includes('isAutoApplyAssetSet(changes)') && appJs.includes('Unity asset files applied automatically'));
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
check('bridge .cs has the 0.16.2 version marker',
  bridgeCs.includes('// CodeFoxBridge version: 0.16.2') && bridgeCs.includes('BridgeVersion = "0.16.2"'));
check('embedded bridge has the 0.16.2 version marker',
  bridgeSrc.BRIDGE_SOURCE.includes('// CodeFoxBridge version: 0.16.2'));
check('unity-bridge.js has BUNDLED_BRIDGE_VERSION 0.16.2',
  bridge.BUNDLED_BRIDGE_VERSION === '0.16.2');
// v0.9.1 — CS0104: a bare `Object` is an ambiguous reference between
// UnityEngine.Object and System.Object when both namespaces are in
// scope (the 0.9.0 bridge failed to compile in Unity on exactly this:
// Object.DestroyImmediate in two places). The bridge must always
// qualify it. Strip strings and comments first so "Object '...'" in
// error messages cannot false-positive, then remove the qualified
// forms and assert no bare Object token is left. Identifiers such as
// ParseObject, RegisterCreatedObjectUndo, Enum.ToObject and
// gameObject do not match \bObject\b, so they need no special case.
const bridgeCsBare = bridgeCs
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/UnityEngine\.Object/g, '')
  .replace(/System\.Object/g, '');
check('bridge .cs has no bare Object reference (CS0104)',
  !/\bObject\b/.test(bridgeCsBare));
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
    upd.ok === true && upd.updated === true && upd.toVersion === '0.16.2' && upd.fromVersion === '0.0.0');
  check('installed bridge now carries the 0.16.2 marker',
    bridge.getInstalledBridgeVersion(tmpV) === '0.16.2');
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
      && html.includes('Import all to Assets/Generated/slug/') && html.includes('Discard')
      && html.includes('my_flux_t2i') && html.includes('a red car')
      && html.includes('importComfyuiChatResult(3)') && html.includes('discardComfyuiChatResult(3)')
      && html.includes('importComfyuiChatImage(3, 0)') && html.includes('discardComfyuiChatImage(3, 0)'));
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
  appJs.includes('await appendComfyuiChatResult(wf, [], action.inputs, null, job)')
  && appJs.includes('syncComfyuiChatResult(job)')
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
  && readme.includes('Generate in chat') && readme.includes('Import all') && readme.includes('per-image'));
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
check('CHANGELOG has the 0.8.4 entry',
  fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.8.4 — 2026-11-25'));

// 29. v0.9.0 — Unity builds prefabs through the bridge; the model
// never hand-writes .prefab / .unity YAML again. Rob's imagecontainer
// prefab is the proof: the model invented a script guid, a YAML node
// literally named "Image:", Button fields on an Image, and no
// CanvasRenderer. Unity writes those files itself now, and the file
// writer refuses .prefab / .unity writes outright.
check('bridge .cs has the four v0.9.0 actions',
  bridgeCs.includes('{ "createPrefab", (json, args) => CreatePrefab(json, args) }')
  && bridgeCs.includes('{ "modifyPrefab", (json, args) => ModifyPrefab(json, args) }')
  && bridgeCs.includes('{ "listComponentTypes", (json, args) => ListComponentTypes(json, args) }')
  && bridgeCs.includes('{ "describeComponent", (json, args) => DescribeComponent(json, args) }'));
check('bridge .cs builds prefabs through Unity APIs, never YAML',
  bridgeCs.includes('PrefabUtility.SaveAsPrefabAsset') && bridgeCs.includes('PrefabUtility.LoadPrefabContents')
  && bridgeCs.includes('PrefabUtility.UnloadPrefabContents') && bridgeCs.includes('AddComponent(type)')
  && bridgeCs.includes('ResolveComponentType') && bridgeCs.includes('GetComponent<CanvasRenderer>'));
check('embedded bridge has the four v0.9.0 actions',
  bridgeSrc.BRIDGE_SOURCE.includes('{ "createPrefab", (json, args) => CreatePrefab(json, args) }')
  && bridgeSrc.BRIDGE_SOURCE.includes('{ "modifyPrefab", (json, args) => ModifyPrefab(json, args) }')
  && bridgeSrc.BRIDGE_SOURCE.includes('{ "listComponentTypes", (json, args) => ListComponentTypes(json, args) }')
  && bridgeSrc.BRIDGE_SOURCE.includes('{ "describeComponent", (json, args) => DescribeComponent(json, args) }'));
check('main.js has unity:command IPC backed by unity-command.js',
  mainJs.includes("ipcMain.handle('unity:command'") && mainJs.includes("require('./unity-command')")
  && mainJs.includes('runUnityCommand'));
check('preload.js exposes rb.unity.runCommand',
  preloadJs.includes('runCommand') && preloadJs.includes("ipcRenderer.invoke('unity:command'"));
check('package.json build.files includes unity-command.js',
  Array.isArray(pkg.build.files) && pkg.build.files.includes('unity-command.js'));
check('app.js parses unity-command blocks and runs them in the agent loop',
  appJs.includes('parseUnityCommandBlocks') && appJs.includes("type: 'unity-command'")
  && appJs.includes('rb.unity.runCommand') && appJs.includes('Unity command'));
check('applyFileChanges refuses .prefab/.unity with the unity-command wording',
  appJs.includes('does not write .prefab or .unity files by hand')
  && appJs.includes('unity-command block (createPrefab')
  && appJs.includes('snapshotId: null'));
check('system prompt has the Unity bridge-command section and the never-guess rule',
  appJs.includes('Unity — prefabs and components')
  && appJs.includes('Never hand-write .prefab or .unity files')
  && appJs.includes('listComponentTypes / describeComponent')
  && appJs.includes('never guess a type name, a property name, or a script guid')
  && appJs.includes('TextMeshProUGUI') && appJs.includes('ScrollRect'));
check('README documents the bridge-command prefab workflow and the Unity-writes-prefabs rule',
  readme.includes('Prefabs are built by Unity, never hand-written')
  && readme.includes('createPrefab') && readme.includes('modifyPrefab')
  && readme.includes('listComponentTypes') && readme.includes('describeComponent'));
check('CHANGELOG has the 0.9.0 entry',
  fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.9.0 — 2026-11-26'));
check('CHANGELOG has the 0.9.1 entry',
  fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.9.1 — 2026-11-26'));
// Functional: the refusal predicate (unity-assets.js) refuses
// .prefab/.unity and accepts .cs/.mat, and the refusal names the
// file and points at the unity-command block.
check('refusal: .prefab and .unity refused, .cs and .mat accepted',
  assets.isHandWrittenUnityFile('Assets/Prefabs/X.prefab')
  && assets.isHandWrittenUnityFile('Assets/Scenes/Main.unity')
  && assets.isHandWrittenUnityFile('Assets/Prefabs/Y.PREFAB')
  && !assets.isHandWrittenUnityFile('Assets/Scripts/Player.cs')
  && !assets.isHandWrittenUnityFile('Assets/Mats/Red.mat'));
check('refusal: partition splits a mixed set, refusal names the file and the unity-command block',
  (() => {
    const p = assets.partitionHandWrittenUnityFiles([
      { path: 'Assets/Prefabs/X.prefab' }, { path: 'Assets/Scenes/Main.unity' },
      { path: 'Assets/Scripts/Player.cs' }, { path: 'Assets/Mats/Red.mat' },
    ]);
    const r = assets.handWrittenUnityRefusal('Assets/Prefabs/X.prefab');
    return p.refused.length === 2 && p.allowed.length === 2
      && p.refused.every(c => /\.prefab$|\.unity$/.test(c.path))
      && r.includes('Assets/Prefabs/X.prefab') && r.includes('unity-command block (createPrefab');
  })());

// 30. v0.9.2 — the model cannot miss the Unity bridge. Rob's 0.9.1
// live test: no compile errors, no prefab — the model never saw
// the bridge-command section (it was gated on a project scan he
// never ran), guessed the block as plain text, and ended by telling
// him to do it manually in the editor. The section is now gated on
// a connected project, every error that points at the bridge
// carries a copyable example, Unity requests get a bridge
// correction instead of "output the file", and editor-API
// generator scripts are refused.
check('Unity prompt section is gated on a connected project, not a scan',
  appJs.includes('if (state.projectPath) {')
  && !/if \(state\.projectScan && state\.projectScan\.unityVersion\)/.test(appJs));
const promptSrc = extractFunction(appJs, 'buildSystemPrompt');
check('buildSystemPrompt can be extracted for testing', !!promptSrc);
// v0.13.0: buildSystemPrompt calls the top-level
// buildSkillsPromptSection, so the extracted prompt needs its
// helpers in scope — the section builder and the project-dir
// constant it closes over. (The app uses the same code at
// runtime; the test just re-assembles the scope.)
const skillsSectionSrc = extractFunction(appJs, 'buildSkillsPromptSection');
const skillsDirConst = /const SKILLS_PROJECT_DIR = '[^']+';/.exec(appJs);
check('skills prompt helpers extractable for testing', !!skillsSectionSrc && !!skillsDirConst);
const promptHelpersSrc = (skillsSectionSrc && skillsDirConst)
  ? skillsDirConst[0] + '\n' + skillsSectionSrc + '\n' : '';
if (promptSrc) {
  // buildSystemPrompt closes over the top-level example constant —
  // pass unity-assets.js's copy in as the parameter of the same
  // name (the equality check below proves app.js holds the same
  // string, so this is the value the app itself uses).
  const buildPrompt = new Function('state', 'window', 'projectScanSummary', 'UNITY_CREATE_PREFAB_EXAMPLE', promptHelpersSrc + promptSrc + '\nreturn buildSystemPrompt([]);');
  const agentPrompt = buildPrompt(
    { projectContext: 'a Unity project', projectPath: 'C:\\TD Pizza Racer', projectScan: null, rulesCharBudget: 4000, useCondensedRules: false, condensedRules: '', chatMode: 'agent' },
    {},
    () => '',
    assets.UNITY_CREATE_PREFAB_EXAMPLE);
  check('agent prompt has the Unity section for a connected project with NO scan',
    agentPrompt.includes('## Unity — prefabs and components')
    && agentPrompt.includes('"action": "createPrefab"')
    && agentPrompt.includes('"type": "Image"')
    && agentPrompt.includes('never by writing a script that does it'));
  const refusalListSrc30 = /const REFUSAL_PHRASES = \[[\s\S]*?\];/.exec(appJs);
  const isRefusalSrc30 = extractFunction(appJs, 'isRefusal');
  if (refusalListSrc30 && isRefusalSrc30) {
    const isRefusal = new Function(refusalListSrc30[0] + '\n' + isRefusalSrc30 + '\nreturn isRefusal;')();
    // The new v0.9.2 phrases must not appear in the Agent prompt
    // text itself, or the model echoing the prompt would trip its
    // own retry. (The prompt DOES contain the pre-existing phrases
    // 'cannot modify files' / 'cannot write code' in its capability
    // statement — "Never say you cannot modify files…" — that is
    // by design, and isRefusal is only ever run on model replies,
    // never on the prompt itself, so it is not a trip.)
    check('agent prompt contains none of the new v0.9.2 refusal phrases',
      !['cannot directly', "can't directly", 'manual process', 'drag the gameobject', 'drag this gameobject', 'you need to do this manually', 'you will need to do this'].some(p => agentPrompt.toLowerCase().includes(p)));
    check('new refusal phrases catch the manual-work pivot',
      isRefusal('I cannot directly write .prefab files')
      && isRefusal('This is a manual process that needs to be done through Unity')
      && isRefusal('Drag the GameObject into the Assets/Prefabs/UI/ folder to create the prefab')
      && isRefusal('Drag this GameObject into the folder and save it as a prefab')
      && isRefusal('You will need to do this manually in the editor'));
    check('isRefusal does NOT flag a successful Unity reply',
      !isRefusal('Prefab created. View it in the Unity Editor.')
      && !isRefusal('Done — adjust the size manually afterwards if you want it bigger.'));
  } else {
    check('refusal list extractable for the v0.9.2 prompt checks', false);
  }
}
// One canonical example: app.js and unity-assets.js must hold the
// identical string, so the messages cannot drift apart.
const appExampleSrc = /const UNITY_CREATE_PREFAB_EXAMPLE = ('(?:\\.|[^'\\])*');/.exec(appJs);
check('app.js example constant matches unity-assets.js',
  !!appExampleSrc && new Function('return ' + appExampleSrc[1] + ';')() === assets.UNITY_CREATE_PREFAB_EXAMPLE
  && assets.UNITY_CREATE_PREFAB_EXAMPLE.includes('"action": "createPrefab"')
  && assets.UNITY_CREATE_PREFAB_EXAMPLE.includes('"type": "Image"'));
check('prefab refusal and unity-command parse error both carry the copyable example',
  appJs.includes("Example — copy this shape: ' + UNITY_CREATE_PREFAB_EXAMPLE")
  && appJs.includes("Example of a working block: ' + UNITY_CREATE_PREFAB_EXAMPLE"));
check('agent loop uses the Unity-aware corrections',
  appJs.includes('refusalCorrectionFor(userRequest)') && appJs.includes('enforcementFollowupFor(userRequest)'));
// Functional: editor-API generator scripts (unity-assets.js).
check('editor-API .cs refused outside Assets/Editor, accepted inside',
  assets.isEditorApiScript({ path: 'Assets/Scripts/CreateImagePrefab.cs', code: 'using UnityEngine;\npublic class X { void M() { PrefabUtility.SaveAsPrefabAsset(null, "x"); } }' })
  && assets.isEditorApiScript({ path: 'Assets/Scripts/Y.cs', code: 'using UnityEditor;\npublic class Y {}' })
  && assets.isEditorApiScript({ path: 'Assets/Scripts/Z.cs', code: 'var x = AssetDatabase.LoadAssetAtPath<Sprite>("Assets/a.png");' })
  && assets.isEditorApiScript({ path: 'Assets/Scripts/W.cs', code: 'EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects);' })
  && !assets.isEditorApiScript({ path: 'Assets/Editor/Tools.cs', code: 'using UnityEditor;\nPrefabUtility.SaveAsPrefabAsset(null, "x");' })
  && !assets.isEditorApiScript({ path: 'Assets/Editor/Sub/Tools.cs', code: 'EditorApplication.update += null;' })
  && !assets.isEditorApiScript({ path: 'Assets\\Editor\\Tools.cs', code: 'using UnityEditor;\npublic class T {}' })
  && !assets.isEditorApiScript({ path: 'Assets/Scripts/Player.cs', code: 'using UnityEngine;\npublic class Player : MonoBehaviour {}' })
  && !assets.isEditorApiScript({ path: 'Assets/Scripts/Player.cs', code: '' })
  && !assets.isEditorApiScript({ path: 'Assets/Prefabs/X.prefab', code: 'PrefabUtility' }));
check('editor-API partition splits a mixed set, refusal names the file and the example',
  (() => {
    const p = assets.partitionEditorApiScripts([
      { path: 'Assets/Scripts/Gen.cs', code: 'PrefabUtility.Create();' },
      { path: 'Assets/Editor/Ok.cs', code: 'PrefabUtility.Create();' },
      { path: 'Assets/Scripts/Player.cs', code: 'class Player {}' },
    ]);
    const r = assets.editorApiScriptRefusal('Assets/Scripts/Gen.cs');
    return p.refused.length === 1 && p.allowed.length === 2
      && p.refused[0].path === 'Assets/Scripts/Gen.cs'
      && r.includes('Assets/Scripts/Gen.cs') && r.includes('Assets/Editor/')
      && r.includes('unity-command block (createPrefab')
      && r.includes('"action": "createPrefab"');
  })());
// The correction selection: extract the pure helpers and the
// constants they close over, then run them in Node.
const unityReqSrc = extractFunction(appJs, 'isUnityRequest');
const corrForSrc = extractFunction(appJs, 'refusalCorrectionFor');
const followForSrc = extractFunction(appJs, 'enforcementFollowupFor');
// v0.12.0: the correction closes over the triage detector too.
const triageCorrSrc = extractFunction(appJs, 'isLogTriageRequest');
const triageCorrConst = /const TRIAGE_MIN_ERROR_LINES = \d+;/.exec(appJs);
const exampleDecl = /const UNITY_CREATE_PREFAB_EXAMPLE = '[^']*';/.exec(appJs);
const corrDecl = /const REFUSAL_CORRECTION = '[^']*';/.exec(appJs);
const corrUDecl = /const REFUSAL_CORRECTION_UNITY = [^;]+;/.exec(appJs);
const corrTDecl = /const REFUSAL_CORRECTION_TRIAGE = '[^']*';/.exec(appJs);
const followDecl = /const ENFORCEMENT_FOLLOWUP = '[^']*';/.exec(appJs);
const followUDecl = /const ENFORCEMENT_FOLLOWUP_UNITY = [^;]+;/.exec(appJs);
check('correction helpers can be extracted for testing',
  !!unityReqSrc && !!corrForSrc && !!followForSrc && !!exampleDecl && !!corrDecl && !!corrUDecl && !!corrTDecl && !!followDecl && !!followUDecl && !!triageCorrSrc && !!triageCorrConst);
if (unityReqSrc && corrForSrc && followForSrc && exampleDecl && corrDecl && corrUDecl && corrTDecl && followDecl && followUDecl && triageCorrSrc && triageCorrConst) {
  const fns = new Function(exampleDecl[0] + '\n' + corrDecl[0] + '\n' + corrUDecl[0] + '\n' + corrTDecl[0] + '\n' + followDecl[0] + '\n' + followUDecl[0] + '\n' + unityReqSrc + '\n' + triageCorrConst[0] + '\n' + triageCorrSrc + '\n' + corrForSrc + '\n' + followForSrc + '\nreturn { refusalCorrectionFor, enforcementFollowupFor };')();
  check('Unity-variant correction for a prefab request, generic for a non-Unity request',
    fns.refusalCorrectionFor('build me a prefab with an image').includes('unity-command block')
    && fns.refusalCorrectionFor('build me a prefab with an image').includes('"action": "createPrefab"')
    && !fns.refusalCorrectionFor('build me a prefab with an image').includes('Output the corrected file')
    && fns.refusalCorrectionFor('fix the null reference in Player.cs').includes('Output the corrected file')
    && fns.enforcementFollowupFor('edit this prefab to use a scroll rect').includes('unity-command block')
    && fns.enforcementFollowupFor('fix the typo in the README').includes('You did not output any file changes'));
  // v0.12.0: a triage refusal is corrected back to diagnosis,
  // never to file output.
  check('refusal correction for a triage request goes back to diagnosis, not to file output',
    fns.refusalCorrectionFor('here is the Editor.log from the crash').includes('log-triage turn')
    && !fns.refusalCorrectionFor('here is the Editor.log from the crash').includes('Output the corrected file'));
}
check('CHANGELOG has the 0.9.2 entry',
  fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.9.2 — 2026-11-26'));
check('README notes the always-on bridge instructions and the generator-script refusal',
  readme.includes('no project scan needed') && readme.includes('generator script is never the way to make a prefab'));

// v0.9.3 — delete assets, grow prefabs in place, ScrollRect works
// first try. Rob's 0.9.2 live test created the Image prefab first
// try, then hit three walls: a root ScrollRect could not reference
// children from the same command (props were set while the tree
// was still being built), modifyPrefab could not add child
// GameObjects at all (so the model recreated the whole prefab
// under a new name), and there was no delete — the model guessed
// deleteAsset and the bridge answered "Unknown action". On top of
// that, every successful command came with a spurious "0 written,
// 1 failed" refusal (the file extractor ate the unity-command
// fence), and the loop re-ran the command after a success because
// a text-only summary tripped the no-actions enforcement.

// Bridge (read from the .cs — it cannot run in Node, so these
// checks are structural: the dispatcher, the validation, and the
// ordering that makes the behaviours possible. The first compile
// and the live round-trips are Rob's Unity test).
check('bridge dispatches deleteAsset',
  bridgeCs.includes('{ "deleteAsset", (json, args) => DeleteAsset(json, args) }'));
check('deleteAsset validates path, existence, and the Assets folder itself',
  bridgeCs.includes('private static BridgeResult DeleteAsset(string json, Dictionary<string, object> args)')
  && bridgeCs.includes('deleteAsset path must start with Assets/')
  && bridgeCs.includes('refuses to delete the Assets folder itself')
  && bridgeCs.includes('AssetDatabase.IsValidFolder(assetPath)')
  && bridgeCs.includes("Asset not found: '\" + assetPath + \"'")
  && bridgeCs.includes('AssetDatabase.DeleteAsset(assetPath)')
  && bridgeCs.includes('AssetDatabase.SaveAssets();'));
check('bridge builds prefabs in two passes (structure first, props second)',
  bridgeCs.includes('private static string AddComponentsNoProps(')
  && bridgeCs.includes('private static string SetComponentProps(')
  && bridgeCs.includes('private static string BuildTreeStructure(')
  && /private static string BuildTree\(GameObject go, Dictionary<string, object> spec, GameObject treeRoot\)\s*\{[^}]*BuildTreeStructure\(go, spec, treeRoot, created\)[^}]*SetComponentProps\(created, treeRoot\)[^}]*\}/s.test(bridgeCs)
  && (() => {
    // Props are never set inside the structure pass — that is the
    // whole point: a reference can only resolve against the
    // complete tree.
    const start = bridgeCs.indexOf('private static string BuildTreeStructure(');
    const end = bridgeCs.indexOf('private static BridgeResult CreatePrefab(', start);
    const body = bridgeCs.slice(start, end);
    return body.includes('AddComponentsNoProps') && !body.includes('SetComponentProps') && !body.includes('SetMember');
  })());
check('modifyPrefab grows prefabs in place: addChildren runs before add, then remove, then set',
  bridgeCs.includes('var addChildren = JArr(cmd, "addChildren");')
  && bridgeCs.includes('addChildren / add / remove / set, in that order')
  && bridgeCs.indexOf('var addChildren = JArr(cmd, "addChildren");') < bridgeCs.indexOf('var adds = JArr(cmd, "add");')
  && bridgeCs.includes('already has a child named'));
check('modifyPrefab remove accepts "component" (string) and "components" (array)',
  bridgeCs.includes('JStr(entry, "component", "")')
  && bridgeCs.includes('JArr(entry, "components")')
  && bridgeCs.includes('Each \\"remove\\" entry needs a \\"component\\"'));
// Dual-output noise: a ```unity-command block after a **File Path:**
// line must never also be a file change.
const extractorSrc93 = extractFunction(appJs, 'extractFileChanges');
check('extractFileChanges can be extracted for the v0.9.3 checks', !!extractorSrc93);
if (extractorSrc93) {
  const codeExtsMatch93 = /const CODE_EXTS = '([^']+)';/.exec(appJs);
  const extract93 = new Function('CODE_EXTS', extractorSrc93 + '\nreturn extractFileChanges;')(codeExtsMatch93[1]);
  check('unity-command / comfyui / powershell / upm fences after a File Path line are not file changes',
    extract93('**File Path:** `Assets/Prefabs/ImageContainer.prefab`\n```unity-command\n{"action": "createPrefab", "name": "ImageContainer", "root": {"name": "ImageContainer", "components": [{"type": "RectTransform"}]}}\n```\n').length === 0
    && extract93('**File Path:** `Assets/Workflows/Gen.json`\n```comfyui\n{"workflow": "NovaXL"}\n```\n').length === 0
    && extract93('**File Path:** `Assets/Scripts/X.cs`\n```powershell\ngit status\n```\n').length === 0
    && extract93('**File Path:** `Packages/manifest.json`\n```upm-install\ncom.unity.textmeshpro@3.0.6\n```\n').length === 0
    && extract93('**File Path:** `Assets/Scripts/Player.cs`\n```csharp\nusing UnityEngine;\npublic class Player : MonoBehaviour {}\n```\n').length === 1);
}
// Loop-done decision: pure function, extracted with the helpers it
// closes over.
const loopDecisionSrc = extractFunction(appJs, 'loopNoActionsDecision');
const asksSrc93 = extractFunction(appJs, 'asksForChange');
const intentDecl93 = /const CHANGE_INTENT_WORDS = \[[^\]]*\];/.exec(appJs);
// v0.12.0: the loop-done decision closes over the triage detector.
const triageFn93 = extractFunction(appJs, 'isLogTriageRequest');
const triageConst93 = /const TRIAGE_MIN_ERROR_LINES = \d+;/.exec(appJs);
check('loopNoActionsDecision can be extracted for testing',
  !!loopDecisionSrc && !!asksSrc93 && !!intentDecl93 && !!triageFn93 && !!triageConst93);
if (loopDecisionSrc && asksSrc93 && intentDecl93 && triageFn93 && triageConst93) {
  const decide = new Function(intentDecl93[0] + '\n' + asksSrc93 + '\n' + triageConst93[0] + '\n' + triageFn93 + '\n' + loopDecisionSrc + '\nreturn loopNoActionsDecision;')();
  check('loop-done: all-success round + text-only reply ends, anything else enforces or stops',
    decide('build me a prefab with an image', false, true, false) === 'done'
    && decide('build me a prefab with an image', false, true, true) === 'enforce'
    && decide('build me a prefab with an image', false, false, false) === 'enforce'
    && decide('build me a prefab with an image', true, false, false) === 'stop'
    && decide('build me a prefab with an image', true, true, true) === 'stop'
    && decide('what is a prefab?', false, false, false) === 'stop'
    && decide('what is a prefab?', false, true, false) === 'done');
  // v0.12.0: a triage turn is read-only — a text-only reply is the
  // report, never an enforcement, even when the request names a fix
  // (the Diagnose error template says "Diagnose it and fix it").
  check('loop-done: a triage turn never enforces a file change',
    decide('I pasted a Unity console error / log below. Diagnose it and fix it:\nNullReferenceException\nerror CS1002\nFailed to load\nerror CS0117\nFatal error', false, false, false) === 'stop'
    && decide('why are there so many errors in the console', false, false, false) === 'stop'
    && decide('here is the Editor.log from the crash', false, true, false) === 'done');
}
check('agent loop records per-round success for the no-actions branch',
  appJs.includes('lastRoundHadActions: false, lastRoundFailed: false')
  && appJs.includes('loopNoActionsDecision(userRequest, loopState.enforcementRetried, loopState.lastRoundHadActions, loopState.lastRoundFailed)')
  && appJs.includes('loopState.lastRoundFailed = failed > 0')
  && appJs.includes("if (summary.failed > 0) failed++"));
check('auto-apply tool result only claims a snapshot when something was written',
  appJs.includes("(summary.written > 0 ? ' Snapshot taken"));
// deleteAsset snapshot: the helper is async, so it is exercised
// in the async block at the end of this file (top-level await
// would break this CommonJS file). Here, only that it extracts.
const snapSrc93 = extractFunction(appJs, 'snapshotForDelete');
const resolveSrc93 = extractFunction(appJs, 'resolvePath');
check('snapshotForDelete can be extracted for testing', !!snapSrc93 && !!resolveSrc93);
// Prompt: deleteAsset, the ScrollRect recipes, the remove shapes,
// and no File Path line before a unity-command block.
if (promptSrc) {
  const buildPrompt93 = new Function('state', 'window', 'projectScanSummary', 'UNITY_CREATE_PREFAB_EXAMPLE', promptHelpersSrc + promptSrc + '\nreturn buildSystemPrompt([]);');
  const agentPrompt93 = buildPrompt93(
    { projectContext: 'a Unity project', projectPath: 'C:\\TD Pizza Racer', projectScan: null, rulesCharBudget: 4000, useCondensedRules: false, condensedRules: '', chatMode: 'agent' },
    {},
    () => '',
    assets.UNITY_CREATE_PREFAB_EXAMPLE);
  check('agent prompt documents deleteAsset, addChildren, and the ScrollRect recipes',
    agentPrompt93.includes('"action": "deleteAsset"')
    && agentPrompt93.includes('"addChildren"')
    && agentPrompt93.includes('"components": ["Image"]')
    && agentPrompt93.includes('"name": "ScrollPanel"')
    && agentPrompt93.includes('"type": "ScrollRect"')
    && agentPrompt93.includes('"viewport": "Viewport"')
    && agentPrompt93.includes('Do not put a **File Path:** line before a ```unity-command block'));
}
check('prefab refusal message names deleteAsset',
  appJs.includes('deleteAsset to delete one'));
check('CHANGELOG has the 0.9.3 entry',
  fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.9.3 — 2026-11-26'));
check('README documents deleteAsset, addChildren, and the ScrollRect recipe',
  readme.includes('deleteAsset') && readme.includes('addChildren') && readme.includes('canonical ScrollRect change is one call'));

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
  } else if (req.url === '/queue' && req.method === 'GET') {
    // One pending prompt, one running prompt, one someone else's.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queue_pending: [[1, 'mock-prompt-pending']], queue_running: [[2, 'mock-prompt-running']] }));
  } else if (req.url === '/queue' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: parsed.delete || [] }));
    });
  } else if (req.url === '/interrupt' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.url === '/free' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, freed: parsed }));
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

// 34. v0.10.0 — automatic git backups, diff and self-restore.
// Rob runs GitKraken; the backups are local commits in the
// project's own .git folder, made by the git CLI before CodeFox
// changes anything. Pure parsers and loop helpers are tested
// here; the engine (stubbed git) and the real-git round-trip run
// in the async block below, before finish().
const gitBackup = require(path.join(root, 'git-backup.js'));
check('git-backup parses porcelain status (staged/modified/untracked/deleted/rename)',
  (() => {
    const s = gitBackup.parsePorcelainStatus('M  src/a.cs\n M src/b.cs\nMM src/c.cs\n?? new.txt\n D src/d.cs\nD  src/e.cs\nR  old.cs -> new.cs\nA  src/f.cs\n');
    return s.staged.includes('src/a.cs') && s.staged.includes('src/c.cs') && s.staged.includes('src/f.cs')
      && s.modified.includes('src/b.cs') && s.modified.includes('src/c.cs')
      && s.untracked.includes('new.txt')
      && s.deleted.includes('src/d.cs') && s.deleted.includes('src/e.cs')
      && s.renamed.length === 1 && s.renamed[0].from === 'old.cs' && s.renamed[0].to === 'new.cs';
  })());
check('git-backup parses log output and flags backup commits',
  (() => {
    const commits = gitBackup.parseLogOutput('abc1234567890abcdef\x1fabc1234\x1fRob\x1f2026-11-26\x1fCodeFox backup: before fix the prefab\ndef1234567890abcdef\x1fdef1234\x1fRob\x1f2026-11-25\x1fFix the bridge\n');
    return commits.length === 2 && commits[0].short === 'abc1234' && commits[0].isBackup === true
      && commits[0].message === 'CodeFox backup: before fix the prefab' && commits[1].isBackup === false;
  })());
check('git-backup parses name-status diffs',
  (() => {
    const d = gitBackup.parseNameStatus('M\tAssets/Scripts/Player.cs\nD\tAssets/Old.cs\nA\tAssets/New.cs\n');
    return d.modified.length === 1 && d.modified[0] === 'Assets/Scripts/Player.cs'
      && d.deleted.length === 1 && d.deleted[0] === 'Assets/Old.cs'
      && d.added.length === 1 && d.added[0] === 'Assets/New.cs';
  })());
check('git-backup truncates a huge diff with a note, leaves a small one alone',
  (() => {
    const big = gitBackup.truncateDiff('x'.repeat(300 * 1024));
    const small = gitBackup.truncateDiff('diff --git a/x b/x');
    return big.truncated === true && big.diff.includes('truncated at 200KB')
      && small.truncated === false && small.diff === 'diff --git a/x b/x';
  })());
check('git-backup commit message format, 80-char cap, empty fallback',
  gitBackup.backupCommitMessage('fix the prefab') === 'CodeFox backup: before fix the prefab'
  && gitBackup.backupCommitMessage('  fix   the\nprefab  ') === 'CodeFox backup: before fix the prefab'
  && gitBackup.backupCommitMessage('x'.repeat(200)).length === 'CodeFox backup: before '.length + 80
  && gitBackup.backupCommitMessage('') === 'CodeFox backup: before assistant change');
check('git-backup refuses paths escaping the repo',
  gitBackup.isPathInsideRepo('/repo', 'Assets/a.cs') === true
  && gitBackup.isPathInsideRepo('/repo', '../evil.cs') === false
  && gitBackup.isPathInsideRepo('/repo', '/abs/path.cs') === false
  && gitBackup.isPathInsideRepo('/repo', 'Assets/../../evil.cs') === false
  && gitBackup.isPathInsideRepo('/repo', '') === false);
check('git-backup never stages the transient bridge files',
  gitBackup.TRANSIENT_EXCLUDES.includes(':!Assets/.codefox-command.json')
  && gitBackup.TRANSIENT_EXCLUDES.includes(':!Assets/.codefox-result.json')
  && gitBackup.TRANSIENT_EXCLUDES.includes(':!Assets/.codefox-refresh-trigger'));

// Loop helpers (v0.10.0) — extracted from app.js like the 0.9.3 ones.
const summarizeSrc = extractFunction(appJs, 'summarizeForBackup');
const shouldBackupSrc = extractFunction(appJs, 'shouldTakeTurnBackup');
const changeMakingSrc = extractFunction(appJs, 'isChangeMakingAction');
const verifyDecisionSrc = extractFunction(appJs, 'postTurnVerifyDecision');
const parseGitSrc = extractFunction(appJs, 'parseGitBlocks');
check('git loop helpers can be extracted for testing',
  !!summarizeSrc && !!shouldBackupSrc && !!changeMakingSrc && !!verifyDecisionSrc && !!parseGitSrc);
if (summarizeSrc && shouldBackupSrc && changeMakingSrc && verifyDecisionSrc && parseGitSrc) {
  const gitHelpers = new Function(
    summarizeSrc + '\n' + shouldBackupSrc + '\n' + changeMakingSrc + '\n' + verifyDecisionSrc + '\n' + parseGitSrc
    + '\nreturn { summarizeForBackup, shouldTakeTurnBackup, isChangeMakingAction, postTurnVerifyDecision, parseGitBlocks };')();
  check('backup summary cleans the request to one 80-char line',
    gitHelpers.summarizeForBackup('  fix   the\nprefab  ') === 'fix the prefab'
    && gitHelpers.summarizeForBackup('x'.repeat(200)).length === 80
    && gitHelpers.summarizeForBackup('') === 'assistant change');
  check('turn backup is taken once, only for a real change, only when on',
    gitHelpers.shouldTakeTurnBackup({ backupAttempted: false, gitAutoBackup: true, projectPath: 'C:\\x', hasChangeActions: true }) === true
    && gitHelpers.shouldTakeTurnBackup({ backupAttempted: true, gitAutoBackup: true, projectPath: 'C:\\x', hasChangeActions: true }) === false
    && gitHelpers.shouldTakeTurnBackup({ backupAttempted: false, gitAutoBackup: false, projectPath: 'C:\\x', hasChangeActions: true }) === false
    && gitHelpers.shouldTakeTurnBackup({ backupAttempted: false, gitAutoBackup: true, projectPath: '', hasChangeActions: true }) === false
    && gitHelpers.shouldTakeTurnBackup({ backupAttempted: false, gitAutoBackup: true, projectPath: 'C:\\x', hasChangeActions: false }) === false);
  check('change-making actions include files/unity/packages/shell and git-restore, not git reads',
    gitHelpers.isChangeMakingAction({ type: 'files' })
    && gitHelpers.isChangeMakingAction({ type: 'unity-command' })
    && gitHelpers.isChangeMakingAction({ type: 'package-install' })
    && gitHelpers.isChangeMakingAction({ type: 'package-remove' })
    && gitHelpers.isChangeMakingAction({ type: 'shell' })
    && gitHelpers.isChangeMakingAction({ type: 'git', command: { action: 'restore' } })
    && !gitHelpers.isChangeMakingAction({ type: 'git', command: { action: 'status' } })
    && !gitHelpers.isChangeMakingAction({ type: 'git', command: { action: 'log' } })
    && !gitHelpers.isChangeMakingAction({ type: 'comfyui' })
    && !gitHelpers.isChangeMakingAction(null));
  check('verify decision: ok / fixed / restore-git / restore-snapshot / report-only',
    gitHelpers.postTurnVerifyDecision({ firstCheckOk: true }) === 'ok'
    && gitHelpers.postTurnVerifyDecision({ firstCheckOk: false, fixProduced: true, secondCheckOk: true }) === 'fixed'
    && gitHelpers.postTurnVerifyDecision({ firstCheckOk: false, fixProduced: false, secondCheckOk: null, hasGitPoint: true, hasSnapshots: true }) === 'restore-git'
    && gitHelpers.postTurnVerifyDecision({ firstCheckOk: false, fixProduced: true, secondCheckOk: false, hasGitPoint: false, hasSnapshots: true }) === 'restore-snapshot'
    && gitHelpers.postTurnVerifyDecision({ firstCheckOk: false, fixProduced: false, secondCheckOk: null, hasGitPoint: false, hasSnapshots: false }) === 'report-only');
  check('parseGitBlocks parses status/diff/restore JSON, rejects bad JSON',
    (() => {
      const blocks = gitHelpers.parseGitBlocks('```git\n{"action": "status"}\n```\n```git\n{"action": "restore", "ref": "abc1234"}\n```\n```git\nnot json\n```\n');
      return blocks.length === 3
        && blocks[0].valid && blocks[0].command.action === 'status'
        && blocks[1].valid && blocks[1].command.ref === 'abc1234'
        && !blocks[2].valid && !!blocks[2].error;
    })());
}
// extractFileChanges must skip ```git fences like the other tool blocks.
check('parser skips ```git fences as files, still extracts a real file change',
  (() => {
    const p = new Function('CODE_EXTS', parserSrc + '\nreturn extractFileChanges;')(codeExtsMatch[1]);
    return p('```git\n{"action": "status"}\n```\n').length === 0
      && p('**File Path:** `Assets/Scripts/Player.cs`\n```git\n{"action": "diff"}\n```\n').length === 0
      && p('**File Path:** `Assets/Scripts/Player.cs`\n```csharp\npublic class Player {}\n```\n').length === 1;
  })());
// Prompt: the agent prompt carries the git docs (re-extract like 0.9.2).
if (promptSrc) {
  const buildPrompt10 = new Function('state', 'window', 'projectScanSummary', 'UNITY_CREATE_PREFAB_EXAMPLE', promptHelpersSrc + promptSrc + '\nreturn buildSystemPrompt([]);');
  const agentPrompt10 = buildPrompt10(
    { projectContext: 'a Unity project', projectPath: 'C:\\TD Pizza Racer', projectScan: null, rulesCharBudget: 4000, useCondensedRules: false, condensedRules: '', chatMode: 'agent' },
    {},
    () => '',
    assets.UNITY_CREATE_PREFAB_EXAMPLE);
  check('agent prompt has the Git backups section with status/diff/log/restore examples',
    agentPrompt10.includes('## Git backups')
    && agentPrompt10.includes('```git')
    && agentPrompt10.includes('"action": "status"')
    && agentPrompt10.includes('"action": "diff"')
    && agentPrompt10.includes('"action": "log"')
    && agentPrompt10.includes('"action": "restore"')
    && agentPrompt10.includes('GitKraken')
    && agentPrompt10.includes('never leave the project broken'));
  check('agent prompt capability statement mentions the backup commit',
    agentPrompt10.includes('a backup commit is taken first'));
  check('the git examples in the built prompt are valid JSON',
    (() => {
      const gitSection = agentPrompt10.slice(agentPrompt10.indexOf('## Git backups'));
      const found = gitSection.match(/\{"action": "[a-z]+"[^}]*\}/g) || [];
      if (found.length < 4) return false;
      try { for (const f of found) JSON.parse(f); return true; } catch { return false; }
    })());
}
// Wiring: IPCs, preload, UI, loop.
check('main.js has the git IPCs and the engine require',
  mainJs.includes("require('./git-backup')")
  && mainJs.includes("ipcMain.handle('git:repoInfo'")
  && mainJs.includes("ipcMain.handle('git:status'")
  && mainJs.includes("ipcMain.handle('git:diff'")
  && mainJs.includes("ipcMain.handle('git:log'")
  && mainJs.includes("ipcMain.handle('git:backup'")
  && mainJs.includes("ipcMain.handle('git:restore'")
  && mainJs.includes("'git_auto_backup', '1'")
  && mainJs.includes("'git_exe_path', ''"));
check('preload.js exposes rb.git with all six calls',
  preloadJs.includes('git:') && preloadJs.includes("ipcRenderer.invoke('git:repoInfo'")
  && preloadJs.includes("ipcRenderer.invoke('git:status'") && preloadJs.includes("ipcRenderer.invoke('git:diff'")
  && preloadJs.includes("ipcRenderer.invoke('git:log'") && preloadJs.includes("ipcRenderer.invoke('git:backup'")
  && preloadJs.includes("ipcRenderer.invoke('git:restore'"));
check('sidebar has the Git Backups section and the loop has the git machinery',
  indexHtml.includes('git-backups-list')
  && appJs.includes('renderGitBackupSection') && appJs.includes('gitBackupNow')
  && appJs.includes('gitRestoreLastBackup') && appJs.includes('showGitRestoreBar')
  && appJs.includes('ensureTurnBackup') && appJs.includes('verifyTurnAfterChanges')
  && appJs.includes('restoreTurnToBackupPoint') && appJs.includes('saveGitExePath')
  && appJs.includes("setShellToggle('git_auto_backup'"));
check('sidebar revert guards the fake bar (revertFromHistory fix)',
  appJs.includes('bar && bar.querySelector') && appJs.includes('bar && bar.remove'));
check('README has the Git backups section, CHANGELOG has the 0.10.0 entry',
  readme.includes('### Git backups') && readme.includes('Never leave it broken')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.10.0 — 2026-11-26'));
// 35. v0.11.0 — the foundation loop: read/edit tools, compile
// after every edit, console reading. The engine is plain Node
// (file-tools.js) so it is tested directly; the app.js pure
// helpers are extracted like the 0.9.3/0.10.0 ones; the bridge
// readConsole code is structural (live console reading is only
// proven by Rob's Unity).
const fileTools = require(path.join(root, 'file-tools.js'));
check('file-tools resolveInProject keeps project paths, refuses escapes',
  fileTools.resolveInProject('/proj', 'Assets/Scripts/Player.cs') === path.join('/proj', 'Assets/Scripts/Player.cs')
  && fileTools.resolveInProject('/proj', '../evil.cs') === null
  && fileTools.resolveInProject('/proj', 'Assets/../../evil.cs') === null
  && fileTools.resolveInProject('/proj', '/abs/path.cs') === null
  && fileTools.resolveInProject('/proj', 'C:\\evil.cs') === null
  && fileTools.resolveInProject('/proj', '') === null);
check('file-tools applyStrReplaceText replaces exactly once',
  (() => {
    const ok = fileTools.applyStrReplaceText('a\nb\nc\n', 'b', 'B');
    return ok.ok === true && ok.content === 'a\nB\nc\n';
  })());
check('file-tools applyStrReplaceText fails plainly on 0 and 2+ matches',
  (() => {
    const none = fileTools.applyStrReplaceText('a\nb\nc\n', 'zzz', 'Z');
    const twice = fileTools.applyStrReplaceText('x\ny\nx\n', 'x', 'X');
    return none.ok === false && none.error.includes('not found') && none.error.includes('view the file')
      && twice.ok === false && twice.error.includes('matched 2 times') && twice.error.includes('more surrounding context');
  })());
check('file-tools applyStrReplaceText matches LF text against a CRLF file and keeps CRLF endings',
  (() => {
    const crlf = fileTools.applyStrReplaceText('line1\r\nline2\r\nline3\r\n', 'line1\nline2', 'A\nB');
    const single = fileTools.applyStrReplaceText('line1\r\nline2\r\nline3\r\n', 'line2', 'LINE2');
    return crlf.ok === true && crlf.content === 'A\r\nB\r\nline3\r\n'
      && single.ok === true && single.content === 'line1\r\nLINE2\r\nline3\r\n';
  })());
check('file-tools applyStrReplaceText refuses an empty old text',
  fileTools.applyStrReplaceText('a\nb\n', '', 'x').ok === false);
// view / grep against a throwaway project tree.
const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-file-tools-'));
try {
  fs.mkdirSync(path.join(tmpProj, 'Assets', 'Scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmpProj, 'Library'), { recursive: true });
  fs.mkdirSync(path.join(tmpProj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmpProj, 'node_modules'), { recursive: true });
  const playerLines = Array.from({ length: 10 }, (_, i) => 'line ' + (i + 1));
  fs.writeFileSync(path.join(tmpProj, 'Assets', 'Scripts', 'Player.cs'), playerLines.join('\n') + '\n');
  fs.writeFileSync(path.join(tmpProj, 'Assets', 'Scripts', 'Health.cs'), 'public int health = 100;\npublic int maxHealth = 100;\n// health regen\n');
  fs.writeFileSync(path.join(tmpProj, 'Library', 'Ignored.cs'), 'needle in Library\n');
  fs.writeFileSync(path.join(tmpProj, '.git', 'ignored.cs'), 'needle in git\n');
  fs.writeFileSync(path.join(tmpProj, 'node_modules', 'ignored.js'), 'needle in node_modules\n');
  fs.writeFileSync(path.join(tmpProj, 'Assets', 'sprite.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  fs.writeFileSync(path.join(tmpProj, 'Assets', 'Scripts', 'Many.cs'), Array.from({ length: 60 }, () => 'needle here').join('\n') + '\n');
  fs.writeFileSync(path.join(tmpProj, 'Assets', 'Scripts', 'Long.cs'), Array.from({ length: 300 }, (_, i) => 'row ' + (i + 1)).join('\n') + '\n');
  fs.writeFileSync(path.join(tmpProj, 'Assets', 'Scripts', 'Wide.cs'), Array.from({ length: 5 }, () => 'x'.repeat(10000)).join('\n') + '\n');
  const eng = fileTools.createFileEngine({ fs, path });
  const v = eng.view({ projectPath: tmpProj, path: 'Assets/Scripts/Player.cs', start: 3, end: 5 });
  check('view returns the right lines with numbers',
    v.ok === true && v.totalLines === 10 && v.start === 3 && v.end === 5 && v.truncated === false
    && v.lines.length === 3 && v.lines[0].n === 3 && v.lines[0].text === 'line 3' && v.lines[2].n === 5 && v.lines[2].text === 'line 5');
  check('view fails plainly on out-of-range start and a missing file',
    eng.view({ projectPath: tmpProj, path: 'Assets/Scripts/Player.cs', start: 99 }).ok === false
    && eng.view({ projectPath: tmpProj, path: 'Assets/Scripts/Player.cs', start: 99 }).error.includes('outside the file')
    && eng.view({ projectPath: tmpProj, path: 'Assets/Scripts/Nope.cs' }).ok === false
    && eng.view({ projectPath: tmpProj, path: 'Assets/Scripts/Nope.cs' }).error.includes('File not found'));
  const long = eng.view({ projectPath: tmpProj, path: 'Assets/Scripts/Long.cs' });
  check('view truncates an oversize range with a note',
    long.ok === true && long.lines.length === 200 && long.truncated === true);
  const wide = eng.view({ projectPath: tmpProj, path: 'Assets/Scripts/Wide.cs' });
  check('view truncates on the byte cap with a note',
    wide.ok === true && wide.lines.length === 3 && wide.truncated === true);
  check('view refuses a path escaping the project',
    eng.view({ projectPath: tmpProj, path: '../evil.cs' }).ok === false
    && eng.view({ projectPath: tmpProj, path: '../evil.cs' }).error.includes('inside the project folder')
    && eng.view({ projectPath: tmpProj, path: 'C:\\evil.cs' }).ok === false);
  const g = eng.grep({ projectPath: tmpProj, pattern: 'health' });
  check('grep finds matches as file:line with the matching line',
    g.ok === true && g.truncated === false
    && g.matches.some(m => m.file === 'Assets/Scripts/Health.cs' && m.line === 1 && m.text.includes('health = 100'))
    && g.matches.some(m => m.file === 'Assets/Scripts/Health.cs' && m.line === 3));
  check('grep never searches Library / .git / node_modules and skips binary files',
    (() => {
      const n = eng.grep({ projectPath: tmpProj, pattern: 'needle' });
      return n.ok === true && n.matches.every(m => !m.file.startsWith('Library/') && !m.file.startsWith('.git/') && !m.file.startsWith('node_modules/'))
        && n.matches.every(m => m.file !== 'Assets/sprite.png');
    })());
  const many = eng.grep({ projectPath: tmpProj, pattern: 'needle here' });
  check('grep caps matches with a note',
    many.ok === true && many.matches.length === 50 && many.truncated === true);
  const none = eng.grep({ projectPath: tmpProj, pattern: 'zzz-no-such-text' });
  check('grep with no match is a plain empty result, not an error',
    none.ok === true && none.matches.length === 0 && none.truncated === false);
  check('grep with no pattern fails plainly',
    eng.grep({ projectPath: tmpProj, pattern: '' }).ok === false);
} finally { fs.rmSync(tmpProj, { recursive: true, force: true }); }

// The app.js str_replace mirror must agree with file-tools.js:
// the renderer cannot require that file, so the text op lives in
// both places — if they ever drift, edits the model sees in the
// UI will not match what the engine does.
const mirrorCountSrc = extractFunction(appJs, 'countOccurrencesText');
const mirrorMapSrc = extractFunction(appJs, 'mapNormToOrigText');
const mirrorReplaceSrc = extractFunction(appJs, 'applyStrReplaceText');
check('app.js str_replace mirror is extractable for testing',
  !!mirrorCountSrc && !!mirrorMapSrc && !!mirrorReplaceSrc);
if (mirrorCountSrc && mirrorMapSrc && mirrorReplaceSrc) {
  const mirrorReplace = new Function(mirrorCountSrc + '\n' + mirrorMapSrc + '\n' + mirrorReplaceSrc + '\nreturn applyStrReplaceText;')();
  const mirrorCases = [
    ['a\nb\nc\n', 'b', 'B'],
    ['a\nb\nc\n', 'zzz', 'Z'],
    ['x\ny\nx\n', 'x', 'X'],
    ['line1\r\nline2\r\nline3\r\n', 'line1\nline2', 'A\nB'],
    ['line1\r\nline2\r\nline3\r\n', 'line2', 'LINE2'],
    ['a\nb\n', '', 'x'],
    ['  health = 100;\n  health = 100;\n', '  health = 100;\n  health = 100;\n', '  health = 150;\n'],
    ['one\ntwo\nthree\n', 'two\nthree', 'TWO\nTHREE'],
  ];
  check('app.js str_replace mirror agrees with file-tools.js on every case',
    mirrorCases.every(([content, oldText, newText]) =>
      JSON.stringify(mirrorReplace(content, oldText, newText)) === JSON.stringify(fileTools.applyStrReplaceText(content, oldText, newText))));
}

// Compile-after-every-edit decision + normalized check (pure helpers).
// v0.12.0: the check shape is normalized — Unity's compiler (bridge)
// or dotnet — so the loop, the post-turn verify, and the manual
// button all read the same fields.
const compileCheckSrc = extractFunction(appJs, 'shouldRunRoundCompileCheck');
const compileTextSrc = extractFunction(appJs, 'roundCompileCheckText');
const normBridgeSrc = extractFunction(appJs, 'normalizeBridgeCompileReport');
const normDotnetSrc = extractFunction(appJs, 'normalizeDotnetBuildCheck');
const firstErrSrc = extractFunction(appJs, 'firstCompileError');
const sameErrSrc = extractFunction(appJs, 'isSameFirstError');
check('round compile helpers are extractable for testing',
  !!compileCheckSrc && !!compileTextSrc && !!normBridgeSrc && !!normDotnetSrc && !!firstErrSrc && !!sameErrSrc);
if (compileCheckSrc && compileTextSrc && normBridgeSrc && normDotnetSrc && firstErrSrc && sameErrSrc) {
  const helpers = new Function(compileCheckSrc + '\n' + compileTextSrc + '\n' + normBridgeSrc + '\n' + normDotnetSrc + '\n' + firstErrSrc + '\n' + sameErrSrc + '\nreturn { shouldRunRoundCompileCheck, roundCompileCheckText, normalizeBridgeCompileReport, normalizeDotnetBuildCheck, firstCompileError, isSameFirstError };')();
  check('compile check runs when a .cs changed, skips otherwise',
    helpers.shouldRunRoundCompileCheck(['Assets/Scripts/Player.cs']) === true
    && helpers.shouldRunRoundCompileCheck(['Assets/Scripts/PLAYER.CS']) === true
    && helpers.shouldRunRoundCompileCheck(['Assets/Prefabs/Image.prefab']) === false
    && helpers.shouldRunRoundCompileCheck([]) === false
    && helpers.shouldRunRoundCompileCheck(['Assets/Scripts/Player.cs', 'Assets/Prefabs/Image.prefab']) === true);
  check('bridge compile report normalizes: clean, failure with file:line, nothing-to-compile',
    (() => {
      const clean = helpers.normalizeBridgeCompileReport({ success: true, compiled: true, errors: [], errorCount: 0, warningCount: 2 });
      const fail = helpers.normalizeBridgeCompileReport({ success: false, compiled: true, errors: [{ file: 'Assets/Scripts/Player.cs', line: 12, message: 'error CS1002: ; expected' }], errorCount: 1, warningCount: 0 });
      const none = helpers.normalizeBridgeCompileReport({ success: true, compiled: false, errors: [], errorCount: 0, warningCount: 0 });
      const many = helpers.normalizeBridgeCompileReport({ success: false, compiled: true, errors: Array.from({ length: 20 }, (_, i) => ({ file: 'f.cs', line: i + 1, message: 'error CS' + i })), errorCount: 25, warningCount: 0 });
      return clean.ok === true && clean.source === 'bridge' && clean.detail.includes('Compile clean (Unity)') && clean.detail.includes('2 warning(s)')
        && fail.ok === false && fail.source === 'bridge' && fail.errorCount === 1 && fail.detail.includes('Player.cs:12') && fail.detail.includes('CS1002') && fail.detail.includes('Fix the first error first')
        && none.ok === true && none.detail.includes('nothing to compile')
        && many.detail.includes('showing the first 20 of 25');
    })());
  check('dotnet build check normalizes: clean, no-solution is noCheck, no-project is none, failure tail',
    (() => {
      const clean = helpers.normalizeDotnetBuildCheck({ ok: true });
      const noSol = helpers.normalizeDotnetBuildCheck({ ok: false, error: 'no .NET solution found' });
      const noProj = helpers.normalizeDotnetBuildCheck({ ok: false, error: 'No project folder set.' });
      const fail = helpers.normalizeDotnetBuildCheck({ ok: false, rawTail: 'Assets/Scripts/Player.cs(12,5): error CS1002: ; expected' });
      return clean.ok === true && clean.source === 'dotnet'
        && noSol.ok === false && noSol.noCheck === true && noSol.detail.includes('no check available')
        && noProj.source === 'none' && noProj.noCheck === true
        && fail.ok === false && fail.noCheck === false && fail.detail.includes('CS1002');
    })());
  check('firstCompileError reads the bridge first error and the dotnet tail, null when there is none',
    helpers.firstCompileError({ errors: [{ file: 'Assets/Scripts/Player.cs', line: 12, message: 'error CS1002: ; expected' }] }) === 'Assets/Scripts/Player.cs:12: error CS1002: ; expected'
    && helpers.firstCompileError({ detail: 'Compile failed (dotnet).\nAssets/Scripts/Player.cs(12,5): error CS1002: ; expected' }).includes('CS1002')
    && helpers.firstCompileError({ detail: 'Compile clean (Unity).' }) === null
    && helpers.isSameFirstError('a', 'a') === true
    && helpers.isSameFirstError('a', 'b') === false
    && helpers.isSameFirstError(null, 'a') === false
    && helpers.isSameFirstError('a', null) === false);
  check('compile result text: clean note, no-check note, failure with file:line',
    helpers.roundCompileCheckText({ ok: true, source: 'bridge', detail: 'Compile clean (Unity).' }).includes('compile clean')
    && helpers.roundCompileCheckText({ ok: false, noCheck: true, detail: 'No .NET solution found in the project, so there is no check available here. Not a failure — carry on.' }).includes('no check available')
    && !helpers.roundCompileCheckText({ ok: false, noCheck: true, detail: 'No .NET solution found in the project, so there is no check available here. Not a failure — carry on.' }).includes('FAILED')
    && helpers.roundCompileCheckText({ ok: false, source: 'bridge', detail: 'Compile failed (Unity): 1 error(s).\nAssets/Scripts/Player.cs:12: error CS1002: ; expected' }).includes('FAILED')
    && helpers.roundCompileCheckText({ ok: false, source: 'bridge', detail: 'Compile failed (Unity): 1 error(s).\nAssets/Scripts/Player.cs:12: error CS1002: ; expected' }).includes('Player.cs:12'));
}

// File-tool result text + console result text (pure helpers).
const fileTextSrc = extractFunction(appJs, 'fileToolResultText');
const consoleTextSrc = extractFunction(appJs, 'formatConsoleResult');
check('file/console result formatters are extractable for testing', !!fileTextSrc && !!consoleTextSrc);
if (fileTextSrc && consoleTextSrc) {
  const fmt = new Function(fileTextSrc + '\n' + consoleTextSrc + '\nreturn { fileToolResultText, formatConsoleResult };')();
  check('file tool result text formats view / grep / str_replace / failure',
    fmt.fileToolResultText({ ok: true, kind: 'view', path: 'Assets/Scripts/Player.cs', start: 3, end: 5, totalLines: 10, lines: [{ n: 3, text: 'line 3' }], truncated: false }).includes('  3| line 3')
    && fmt.fileToolResultText({ ok: true, kind: 'grep', pattern: 'Health', matches: [{ file: 'a.cs', line: 7, text: '  health = 100;' }], truncated: false, filesSearched: 3 }).includes('a.cs:7:   health = 100;')
    && fmt.fileToolResultText({ ok: true, kind: 'grep', pattern: 'zzz', matches: [], filesSearched: 3 }).includes('no matches')
    && fmt.fileToolResultText({ ok: true, kind: 'str_replace', path: 'x.cs' }).includes('str_replace applied')
    && fmt.fileToolResultText({ ok: false, error: 'boom' }).includes('File tool failed: boom'));
  check('console result text (new shape): earliest-first, cursor, counts, omitted / evicted / repeated, mark, empty',
    fmt.formatConsoleResult({ cursor: 42, entries: [{ seq: 40, message: 'CS1002: ; expected', file: 'Assets/Scripts/Player.cs', line: 42, stack: ['at Player.Start () (at Assets/Scripts/Player.cs:42)'] }, { message: 'NullReferenceException', count: 3, stack: [] }], errorCount: 2, warningCount: 1, omitted: 0, hiddenByFilter: 0, missedEvictedEntries: 0 }).includes('CS1002')
    && fmt.formatConsoleResult({ cursor: 42, entries: [{ seq: 40, message: 'CS1002: ; expected', file: 'Assets/Scripts/Player.cs', line: 42, stack: ['at Player.Start ()'] }], errorCount: 1, warningCount: 0 }).includes('Player.cs:42')
    && fmt.formatConsoleResult({ cursor: 42, entries: [{ seq: 40, message: 'NullReferenceException', count: 3, stack: [] }], errorCount: 1, warningCount: 0 }).includes('repeated 3 times')
    && fmt.formatConsoleResult({ cursor: 42, entries: [{ seq: 40, message: 'x', stack: [] }], errorCount: 1, warningCount: 0, omitted: 5 }).includes('5 more omitted')
    && fmt.formatConsoleResult({ cursor: 42, entries: [{ seq: 40, message: 'x', stack: [] }], errorCount: 1, warningCount: 0, missedEvictedEntries: 7 }).includes('7 older entries were evicted')
    && fmt.formatConsoleResult({ cursor: 42, marked: true, entries: [], errorCount: 0, warningCount: 0 }).includes('marked at seq 42')
    && fmt.formatConsoleResult({ cursor: 42, entries: [], errorCount: 0, warningCount: 0 }).includes('no new entries'));
  check('console result text (old shape): newest entries, file:line, stack lines, truncated warning, empty — still formats',
    fmt.formatConsoleResult({ logType: 'Error', entries: [{ message: 'CS1002: ; expected', file: 'Assets/Scripts/Player.cs', line: 42, stack: ['at Player.Start () (at Assets/Scripts/Player.cs:42)'] }], truncated: true }).includes('CS1002')
    && fmt.formatConsoleResult({ logType: 'Error', entries: [{ message: 'x', stack: [] }], truncated: true }).includes('truncated')
    && fmt.formatConsoleResult({ logType: 'Error', entries: [{ message: 'x', stack: [] }], truncated: true }).includes('lower bound')
    && fmt.formatConsoleResult({ logType: 'Warning', entries: [], truncated: false }).includes('no entries'));
}

// ```file blocks: parsed, skipped by the file extractor, and a
// str_replace is a change-making action (backup hook) while reads
// are not.
const parseFileSrc = extractFunction(appJs, 'parseFileBlocks');
const changeMaking11Src = extractFunction(appJs, 'isChangeMakingAction');
const safePathSrc = extractFunction(appJs, 'isSafeProjectPath');
check('file-block helpers are extractable for testing', !!parseFileSrc && !!changeMaking11Src && !!safePathSrc);
if (parseFileSrc && changeMaking11Src && safePathSrc) {
  const helpers11 = new Function(parseFileSrc + '\n' + changeMaking11Src + '\n' + safePathSrc + '\nreturn { parseFileBlocks, isChangeMakingAction, isSafeProjectPath };')();
  check('parseFileBlocks parses view/grep/str_replace JSON, rejects bad JSON',
    (() => {
      const blocks = helpers11.parseFileBlocks('```file\n{"action": "view", "path": "Assets/Scripts/Player.cs", "start": 1, "end": 20}\n```\n```file\n{"action": "str_replace", "path": "Assets/Scripts/Player.cs", "old": "a", "new": "b"}\n```\n```file\nnot json\n```\n');
      return blocks.length === 3 && blocks[0].valid && blocks[0].command.action === 'view'
        && blocks[1].valid && blocks[1].command.action === 'str_replace'
        && !blocks[2].valid && !!blocks[2].error;
    })());
  check('str_replace is change-making for the backup hook; view/grep are reads, not changes',
    helpers11.isChangeMakingAction({ type: 'file', command: { action: 'str_replace' } }) === true
    && helpers11.isChangeMakingAction({ type: 'file', command: { action: 'view' } }) === false
    && helpers11.isChangeMakingAction({ type: 'file', command: { action: 'grep' } }) === false
    && helpers11.isChangeMakingAction({ type: 'files' }) === true);
  check('file paths must be project-relative: escapes refused',
    helpers11.isSafeProjectPath('Assets/Scripts/Player.cs') === true
    && helpers11.isSafeProjectPath('../evil.cs') === false
    && helpers11.isSafeProjectPath('Assets/../../evil.cs') === false
    && helpers11.isSafeProjectPath('/abs/path.cs') === false
    && helpers11.isSafeProjectPath('C:\\evil.cs') === false
    && helpers11.isSafeProjectPath('') === false);
}
check('parser skips ```file fences as files, still extracts a real file change',
  (() => {
    const p = new Function('CODE_EXTS', parserSrc + '\nreturn extractFileChanges;')(codeExtsMatch[1]);
    return p('```file\n{"action": "view", "path": "Assets/Scripts/Player.cs"}\n```\n').length === 0
      && p('**File Path:** `Assets/Scripts/Player.cs`\n```file\n{"action": "grep", "pattern": "Health"}\n```\n').length === 0
      && p('**File Path:** `Assets/Scripts/Player.cs`\n```csharp\npublic class Player {}\n```\n').length === 1;
  })());

// readConsole + the transport + the compile action — structural
// only: the .cs can only truly run in Rob's Unity. The dispatcher
// dictionary, the ConsoleBuffer (subscribe + seed + persist), the
// read args and caps, the hard rule that reading never
// recompiles or reimports, and the CompileReport's SessionState
// shape (the trap: errors never reload, so a poll tick must
// finalize either way).
check('bridge dispatcher registers readConsole and recompile_and_report_errors, unknown action lists available actions',
  bridgeCs.includes('{ "readConsole", (json, args) => ConsoleBuffer.Read(json, args) }')
  && bridgeCs.includes('{ "recompile_and_report_errors", (json, args) => CompileReport.Begin(json, args) }')
  && bridgeCs.includes('Unknown action: ') && bridgeCs.includes('. Available: '));
const consoleStart = bridgeCs.indexOf('private static class ConsoleBuffer');
const consoleEnd = bridgeCs.indexOf('private static class JsonMini', consoleStart);
const consoleSrc = consoleStart !== -1 && consoleEnd !== -1 ? bridgeCs.slice(consoleStart, consoleEnd) : '';
const consoleCode = consoleSrc
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
check('bridge ConsoleBuffer is extractable for the structural checks', consoleSrc.length > 0);
check('bridge ConsoleBuffer subscribes to logMessageReceivedThreaded and seeds from LogEntries once at load',
  consoleSrc.includes('Application.logMessageReceivedThreaded -= OnLogMessage')
  && consoleSrc.includes('Application.logMessageReceivedThreaded += OnLogMessage')
  && consoleSrc.includes('SeedFromLogEntries')
  && consoleSrc.includes('GetType("UnityEditor.LogEntries")')
  && consoleSrc.includes('"StartGettingEntries"') && consoleSrc.includes('"GetCount"')
  && consoleSrc.includes('"GetEntryInternal"') && consoleSrc.includes('GetType("UnityEditor.LogEntry")'));
check('bridge ConsoleBuffer persists across reloads and never clears the console',
  consoleSrc.includes('AssemblyReloadEvents.beforeAssemblyReload -= Persist')
  && consoleSrc.includes('AssemblyReloadEvents.beforeAssemblyReload += Persist')
  && consoleSrc.includes('SessionState')
  && consoleSrc.includes('Capacity = 2000') && consoleSrc.includes('PersistCount = 500')
  && !/\.Clear\s*\(/.test(consoleCode));
check('bridge readConsole takes sinceSeq / mark / minLevel / contains / playModeOnly / includeStack / maxEntries (default 30, hard max 100)',
  consoleSrc.includes('"sinceSeq"') && consoleSrc.includes('"mark"') && consoleSrc.includes('"minLevel"')
  && consoleSrc.includes('"contains"') && consoleSrc.includes('"playModeOnly"') && consoleSrc.includes('"includeStack"')
  && consoleSrc.includes('ToLong(NumField(cmd, "maxEntries"), 30)') && consoleSrc.includes('if (maxEntries > 100) maxEntries = 100')
  && consoleSrc.includes('\\"cursor\\"') && consoleSrc.includes('\\"omitted\\"') && consoleSrc.includes('\\"hiddenByFilter\\"')
  && consoleSrc.includes('\\"errorCount\\"') && consoleSrc.includes('\\"warningCount\\"') && consoleSrc.includes('\\"missedEvictedEntries\\"'));
check('bridge readConsole never recompiles or reimports (no Refresh / AssetDatabase / Compile call)',
  !consoleCode.includes('AssetDatabase') && !consoleCode.includes('Refresh(')
  && !consoleCode.includes('Compile') && !consoleCode.includes('Reimport'));
check('bridge readConsole refuses "All" and maps the old logType to minLevel',
  consoleSrc.includes('never \\"All\\"') && consoleSrc.includes('\\"Error\\"') && consoleSrc.includes('\\"Warning\\"')
  && consoleSrc.includes('minLevel = 2') && consoleSrc.includes('minLevel = 1'));
const compileStart = bridgeCs.indexOf('private static class CompileReport');
const compileEnd = bridgeCs.indexOf('private static class ConsoleBuffer', compileStart);
const compileSrc = compileStart !== -1 && compileEnd !== -1 ? bridgeCs.slice(compileStart, compileEnd) : '';
check('bridge CompileReport is extractable for the structural checks', compileSrc.length > 0);
check('bridge CompileReport keeps state in SessionState, compiles via the pipeline, caps 20 errors x 300 chars, 5-min timeout',
  compileSrc.includes('SessionState.GetString(PendingIdKey')
  && compileSrc.includes('CompilationPipeline.RequestScriptCompilation()')
  && compileSrc.includes('CompilationPipeline.compilationStarted -= OnCompilationStarted')
  && compileSrc.includes('CompilationPipeline.compilationFinished -= OnCompilationFinished')
  && compileSrc.includes('MaxErrors = 20') && compileSrc.includes('MaxErrorChars = 300')
  && compileSrc.includes('HardTimeoutSeconds = 300')
  && compileSrc.includes('EditorUtility.scriptCompilationFailed')
  && compileSrc.includes('TryFinalize') && compileSrc.includes('IsPending'));
check('bridge transport: BridgeResult ok/error/pending, protocol 1, inbox/processing/outbox/heartbeat, atomic claim, pending kept',
  bridgeCs.includes('public static BridgeResult Ok(') && bridgeCs.includes('public static BridgeResult Error(')
  && bridgeCs.includes('public static BridgeResult Pending(')
  && bridgeCs.includes('public const int ProtocolVersion = 1')
  && bridgeCs.includes('Path.Combine(_bridgeDir, "inbox")') && bridgeCs.includes('Path.Combine(_bridgeDir, "processing")')
  && bridgeCs.includes('Path.Combine(_bridgeDir, "outbox")') && bridgeCs.includes('Path.Combine(_bridgeDir, "heartbeat.json")')
  && bridgeCs.includes('File.Move(file, processingPath)')
  && bridgeCs.includes('IsSafeRequestId') && bridgeCs.includes('RecoverInterruptedRequests')
  && bridgeCs.includes('if (CompileReport.IsPending(id)) continue;')
  && bridgeCs.includes('WriteHeartbeat()'));
check('bridge has no Newtonsoft dependency and no old single-file protocol in code',
  !bridgeCs.includes('Newtonsoft')
  && !bridgeCs.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').includes('.codefox-command.json')
  && !bridgeCs.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').includes('.codefox-result.json'));

// Prompt: the agent prompt carries the file-tool docs and the
// readConsole example, and its JSON examples parse.
if (promptSrc) {
  const buildPrompt11 = new Function('state', 'window', 'projectScanSummary', 'UNITY_CREATE_PREFAB_EXAMPLE', promptHelpersSrc + promptSrc + '\nreturn buildSystemPrompt([]);');
  const agentPrompt11 = buildPrompt11(
    { projectContext: 'a Unity project', projectPath: 'C:\\TD Pizza Racer', projectScan: null, rulesCharBudget: 4000, useCondensedRules: false, condensedRules: '', chatMode: 'agent' },
    {},
    () => '',
    assets.UNITY_CREATE_PREFAB_EXAMPLE);
  check('agent prompt has the file-tools section with all three actions and the read-before-you-edit rule',
    agentPrompt11.includes('## Reading and editing files')
    && agentPrompt11.includes('Read before you edit')
    && agentPrompt11.includes('"action": "view"')
    && agentPrompt11.includes('"action": "grep"')
    && agentPrompt11.includes('"action": "str_replace"')
    && agentPrompt11.includes('must match EXACTLY ONCE'));
  check('agent prompt has the readConsole example (cursor, mark, minLevel, never All) and the recompile action',
    agentPrompt11.includes('"action": "readConsole"')
    && agentPrompt11.includes('"sinceSeq": 0')
    && agentPrompt11.includes('"mark": true')
    && agentPrompt11.includes('minLevel')
    && agentPrompt11.includes('never "All"')
    && agentPrompt11.includes('"action": "recompile_and_report_errors"')
    && agentPrompt11.includes('success:false'));
  check('agent prompt says compile-after-edit uses Unity\'s own compiler and the identical-first-error rule',
    agentPrompt11.includes('After you change a .cs file')
    && agentPrompt11.includes('compile clean')
    && agentPrompt11.includes('Unity\'s own compiler')
    && agentPrompt11.includes('identical on two consecutive checks')
    && agentPrompt11.includes('no check available'));
  check('the file-tool examples in the built prompt are valid JSON',
    (() => {
      const section = agentPrompt11.slice(agentPrompt11.indexOf('## Reading and editing files'), agentPrompt11.indexOf('## Git backups'));
      const found = section.match(/\{"action": "[a-z_]+"[^}]*\}/g) || [];
      if (found.length < 3) return false;
      try { for (const f of found) JSON.parse(f); return true; } catch { return false; }
    })());
  check('the readConsole example in the built prompt is valid JSON',
    (() => {
      const section = agentPrompt11.slice(agentPrompt11.indexOf('## Unity — prefabs'), agentPrompt11.indexOf('## Reading and editing files'));
      const found = section.match(/\{"action": "readConsole"[^}]*\}/g) || [];
      if (found.length < 1) return false;
      try { JSON.parse(found[0]); return true; } catch { return false; }
    })());
}
// Wiring + version pins for 0.11.0.
check('main.js has the file IPCs and the engine require',
  mainJs.includes("require('./file-tools')")
  && mainJs.includes("ipcMain.handle('file:view'")
  && mainJs.includes("ipcMain.handle('file:grep'"));
check('preload.js exposes rb.fs.view / rb.fs.grep',
  preloadJs.includes("ipcRenderer.invoke('file:view'") && preloadJs.includes("ipcRenderer.invoke('file:grep'"));
check('package.json build files include file-tools.js',
  Array.isArray(pkg.build && pkg.build.files) && pkg.build.files.includes('file-tools.js'));
check('app.js has the file loop machinery',
  appJs.includes('parseFileBlocks') && appJs.includes("action.type === 'file'")
  && appJs.includes('applyFilesAction') && appJs.includes('runRoundCompileCheck')
  && appJs.includes('roundCompileCheckText') && appJs.includes('shouldRunRoundCompileCheck')
  && appJs.includes('formatConsoleResult') && appJs.includes('resolveStrReplaceChanges')
  && appJs.includes('isSafeProjectPath'));
check('bridge version pins are 0.16.2 everywhere (MIN_TRANSPORT_VERSION stays 0.12.0)',
  bridgeCs.includes('// CodeFoxBridge version: 0.16.2')
  && bridgeCs.includes('BridgeVersion = "0.16.2"')
  && fs.readFileSync(path.join(root, 'unity-bridge.js'), 'utf8').includes("BUNDLED_BRIDGE_VERSION = '0.16.2'")
  && fs.readFileSync(path.join(root, 'unity-bridge-source.js'), 'utf8').includes('CodeFoxBridge version: 0.16.2')
  && bridge.MIN_TRANSPORT_VERSION === '0.12.0');
check('README has the file-tools section + compile-after-edit + readConsole, CHANGELOG has the 0.14.0 entry',
  readme.includes('### Reading and editing files') && readme.includes('Compile after every edit')
  && readme.includes('readConsole') && readme.includes('version-0.21.2')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.14.0 — 2026-11-26'));

// 36. v0.12.0 — log triage: detection, mirror agreement, prompt,
// loop guards, wiring. No new IPCs, no bridge change.
const logTriage = require('../log-triage');
const TRIAGE_TRUE = [
  'here is the Editor.log from the crash',
  'Player.log attached — why does the game crash on start',
  'why are there so many errors in the console',
  'the editor is full of errors, what is going on',
  'diagnose these logs please',
  'can you read the Unity console? it is flooded with errors',
  'Editor-prev.log after the editor crashed',
  'what is causing all these errors',
  'why is the console full of errors',
  'I pasted a Unity console error / log below. Diagnose it and fix it:\n```\nNullReferenceException: Object reference not set\nerror CS1002: ; expected\nFailed to load asset\nerror CS0117: no definition\nFatal error in gc\n```',
  'here is the log file, what is the root cause',
  'what is wrong with the console',
];
const TRIAGE_FALSE = [
  'fix this error: Assets/Scripts/Player.cs(42,5): error CS1002: ; expected',
  'why is there an error in Player.cs',
  'show me the git log',
  'add a console.log to debug this',
  'create a log file for player scores',
  'the build failed',
  'where is the Editor.log file?',
  'what is a prefab?',
  'NullReferenceException in Player.cs line 42, fix it',
  '',
  'diagnose this error: error CS1501',
  // Three error lines is one error pasted for a fix, not a log.
  'error CS1002\nerror CS0117\nFailed to load',
];
check('log-triage detector fires on log files, many-errors asks, and pasted logs',
  TRIAGE_TRUE.every(t => logTriage.isLogTriageRequest(t) === true));
check('log-triage detector stays quiet on a single error, git log, and location questions',
  TRIAGE_FALSE.every(t => logTriage.isLogTriageRequest(t) === false));

// The app.js mirror must agree with log-triage.js: the renderer
// cannot require that file, so the detector lives in both places.
const triageMirrorSrc = extractFunction(appJs, 'isLogTriageRequest');
const triageMirrorConst = /const TRIAGE_MIN_ERROR_LINES = \d+;/.exec(appJs);
check('app.js log-triage mirror is extractable for testing',
  !!triageMirrorSrc && !!triageMirrorConst);
if (triageMirrorSrc && triageMirrorConst) {
  const mirrorDetect = new Function(triageMirrorConst[0] + '\n' + triageMirrorSrc + '\nreturn isLogTriageRequest;')();
  check('app.js log-triage mirror agrees with log-triage.js on every case',
    [...TRIAGE_TRUE, ...TRIAGE_FALSE].every(t =>
      mirrorDetect(t) === logTriage.isLogTriageRequest(t)));
}

// Prompt: the agent prompt carries the triage section (Agent mode,
// project connected); the Ask prompt and a no-project prompt do not.
if (promptSrc) {
  const buildPrompt12 = new Function('state', 'window', 'projectScanSummary', 'UNITY_CREATE_PREFAB_EXAMPLE', promptHelpersSrc + promptSrc + '\nreturn buildSystemPrompt([]);');
  const agentPrompt12 = buildPrompt12(
    { projectContext: 'a Unity project', projectPath: 'C:\\TD Pizza Racer', projectScan: null, rulesCharBudget: 4000, useCondensedRules: false, condensedRules: '', chatMode: 'agent' },
    {},
    () => '',
    assets.UNITY_CREATE_PREFAB_EXAMPLE);
  check('agent prompt has the log-triage section: trigger, read-only override, method, report format, request for more information',
    agentPrompt12.includes('## Log triage')
    && agentPrompt12.includes('READ-ONLY')
    && agentPrompt12.includes('overrides the "you MUST edit files" rule')
    && agentPrompt12.includes('FIRST error that causes the rest')
    && agentPrompt12.includes('never guess from addresses')
    && agentPrompt12.includes('never trigger a recompile while reading')
    && agentPrompt12.includes('start, then end, then narrow toward the first error')
    && agentPrompt12.includes('Request for more information')
    && agentPrompt12.includes('EVERY file you suspect')
    && agentPrompt12.includes('Editor-prev.log')
    && agentPrompt12.includes('%LOCALAPPDATA%')
    && agentPrompt12.includes('Ignored as noise')
    && agentPrompt12.includes('A single error that can be read directly is NOT a triage turn'));
  const askPrompt12 = buildPrompt12(
    { projectContext: 'a Unity project', projectPath: 'C:\\TD Pizza Racer', projectScan: null, rulesCharBudget: 4000, useCondensedRules: false, condensedRules: '', chatMode: 'ask' },
    {},
    () => '',
    assets.UNITY_CREATE_PREFAB_EXAMPLE);
  check('ask prompt has no log-triage section (Agent-mode only)', !askPrompt12.includes('## Log triage'));
  const noProjectPrompt12 = buildPrompt12(
    { projectContext: '', projectPath: '', projectScan: null, rulesCharBudget: 4000, useCondensedRules: false, condensedRules: '', chatMode: 'agent' },
    {},
    () => '',
    assets.UNITY_CREATE_PREFAB_EXAMPLE);
  check('no-project prompt has no log-triage section (needs the file and console tools)', !noProjectPrompt12.includes('## Log triage'));
}

// Wiring: sendChat detects triage, switches Ask/Plan to Agent
// before the prompt is built, and appends the turn note.
check('sendChat routes triage turns: detector, mode switch before the prompt, turn note',
  appJs.includes('const wantsTriage = !usedExecPlanPrompt && !!state.projectPath && isLogTriageRequest(text)')
  && appJs.includes("if (wantsTriage && state.chatMode !== 'agent')")
  && appJs.includes('Switched to Agent mode for log triage')
  && appJs.includes('if (wantsTriage) systemPrompt += LOG_TRIAGE_TURN_NOTE;'));
check('triage loop guards: no-actions decision never enforces triage, refusal correction routes back to diagnosis',
  appJs.includes("if (isLogTriageRequest(userRequest)) return 'stop';")
  && appJs.includes('REFUSAL_CORRECTION_TRIAGE')
  && appJs.includes('if (isLogTriageRequest(request)) return REFUSAL_CORRECTION_TRIAGE;'));

// (The refusal-correction behaviour for triage turns is covered
// by the v0.9.2 correction harness above, which extracts
// refusalCorrectionFor with the triage detector in scope.)
check('README has the log-triage section + CHANGELOG has the 0.12.0 triage entry',
  readme.includes('### Log triage') && readme.includes('strictly read-only')
  && readme.includes('Editor-prev.log')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('Log triage as an automatic pipeline stage'));

// 37. v0.13.0 — skills: progressive loading, per-project
// enable/disable, manual override, and the first built-in skill.
// The bridge is untouched (still 0.11.0).
const skillFiles = require('../skill-files');

// Frontmatter parsing.
check('skill frontmatter: name + description parsed',
  JSON.stringify(skillFiles.parseSkillFrontmatter('---\nname: foo-bar\ndescription: Use when testing.\n---\n# Foo\n')) === JSON.stringify({ name: 'foo-bar', description: 'Use when testing.' }));
check('skill frontmatter: quoted values unquoted, unknown keys ignored, missing keys null',
  JSON.stringify(skillFiles.parseSkillFrontmatter('---\ndescription: "Quoted desc."\nversion: 3\n---\n')) === JSON.stringify({ name: null, description: 'Quoted desc.' }));
check('skill frontmatter: no frontmatter block is null',
  skillFiles.parseSkillFrontmatter('# No frontmatter\nUse when testing.\n') === null);
check('skill frontmatter: CRLF line endings parse',
  skillFiles.parseSkillFrontmatter('---\r\nname: crlf-skill\r\ndescription: CRLF desc.\r\n---\r\n') !== null
  && skillFiles.parseSkillFrontmatter('---\r\nname: crlf-skill\r\ndescription: CRLF desc.\r\n---\r\n').name === 'crlf-skill');

// describeSkillFile: frontmatter wins; without it, the name comes
// from the folder and the description from the first non-heading
// line; null when there is no usable description.
check('describeSkillFile: frontmatter name + description win',
  JSON.stringify(skillFiles.describeSkillFile('---\nname: fm-skill\ndescription: From frontmatter.\n---\n# Title\nBody line.\n', 'folder-name')) === JSON.stringify({ name: 'fm-skill', description: 'From frontmatter.' }));
check('describeSkillFile: no frontmatter — folder name + first paragraph line',
  JSON.stringify(skillFiles.describeSkillFile('# Plain Skill\n\nPlain skill does things.\n', 'plain-skill')) === JSON.stringify({ name: 'plain-skill', description: 'Plain skill does things.' }));
check('describeSkillFile: no description is null (cannot be routed on)',
  skillFiles.describeSkillFile('# Title only\n', 'empty-skill') === null);
check('describeSkillFile: unsafe frontmatter name is null',
  skillFiles.describeSkillFile('---\nname: ../escape\ndescription: Evil.\n---\n', 'escape') === null);

// Name helpers.
check('isSafeSkillName / normalizeSkillName / skillProjectRelPath',
  skillFiles.isSafeSkillName('unity-multiplayer-networking') === true
  && skillFiles.isSafeSkillName('Bad Name') === false
  && skillFiles.isSafeSkillName('a/b') === false
  && skillFiles.isSafeSkillName('') === false
  && skillFiles.normalizeSkillName('  MultiPlayer-Net ') === 'multiplayer-net'
  && skillFiles.skillProjectRelPath('foo') === '.codefox/skills/foo/SKILL.md');

// parseSkillCommand: the command is the first non-blank line,
// "/skill <name>" optionally followed by the task on the
// FOLLOWING lines — a task on the same line is not a command.
check('parseSkillCommand: name + task on following lines',
  JSON.stringify(skillFiles.parseSkillCommand('/skill multiplayer\nmake a lobby')) === JSON.stringify({ name: 'multiplayer', rest: 'make a lobby' }));
check('parseSkillCommand: bare /skill lists (empty name), leading blanks skipped, name normalized to lowercase',
  JSON.stringify(skillFiles.parseSkillCommand('\n\n/skill')) === JSON.stringify({ name: '', rest: '' })
  && JSON.stringify(skillFiles.parseSkillCommand('/skill Multiplayer')) === JSON.stringify({ name: 'multiplayer', rest: '' }));
check('parseSkillCommand: not a command is null; task on the same line is null',
  skillFiles.parseSkillCommand('please /skill multiplayer') === null
  && skillFiles.parseSkillCommand('/skill multiplayer make a lobby') === null
  && skillFiles.parseSkillCommand('') === null
  && skillFiles.parseSkillCommand('/skills multiplayer') === null);

// Token estimate: name + ' — ' (3) + description + newline (1),
// ~4 chars per token. Only the one-line descriptions count —
// the full SKILL.md is never in the prompt until it is loaded.
check('estimateSkillPromptTokens: one skill, empty list, rounding',
  skillFiles.estimateSkillPromptTokens([{ name: 'ab', description: 'x'.repeat(10) }]) === 4
  && skillFiles.estimateSkillPromptTokens([]) === 0
  && skillFiles.estimateSkillPromptTokens([{ name: 'a', description: 'b' }]) === 2);

// Prompt section.
check('buildSkillsPromptSection: empty when no skills',
  skillFiles.buildSkillsPromptSection([]) === '' && skillFiles.buildSkillsPromptSection(null) === '');
check('buildSkillsPromptSection: one skill — name, description, exact path, rules-win precedence',
  (() => {
    const s = skillFiles.buildSkillsPromptSection([{ name: 'unity-multiplayer-networking', description: 'Use when adding multiplayer.', relPath: '.codefox/skills/unity-multiplayer-networking/SKILL.md' }]);
    return s.includes('## Skills')
      && s.includes('- unity-multiplayer-networking — Use when adding multiplayer.')
      && s.includes('(read .codefox/skills/unity-multiplayer-networking/SKILL.md with view when a task matches)')
      && s.includes('Project Rules always win')
      && s.includes("if a skill's instruction conflicts with a Project Rule, follow the rule and say so")
      && s.includes("Do not read a skill's full content when the task does not match");
  })());
check('buildSkillsPromptSection: missing relPath falls back to the project path',
  skillFiles.buildSkillsPromptSection([{ name: 'foo', description: 'Does foo.' }]).includes('.codefox/skills/foo/SKILL.md'));
check('buildSkillsPromptSection: entries without a description are dropped',
  skillFiles.buildSkillsPromptSection([{ name: 'foo' }]) === '');

// The app.js mirrors must agree with skill-files.js: the renderer
// cannot require that file, so the command parser and the prompt
// section live in both places.
const mirrorCmdSrc = extractFunction(appJs, 'parseSkillCommand');
const mirrorSectionSrc = extractFunction(appJs, 'buildSkillsPromptSection');
const mirrorDirConst = /const SKILLS_PROJECT_DIR = '[^']+';/.exec(appJs);
check('app.js skill mirrors extractable for testing', !!mirrorCmdSrc && !!mirrorSectionSrc && !!mirrorDirConst);
if (mirrorCmdSrc && mirrorSectionSrc && mirrorDirConst) {
  const mirrorParse = new Function(mirrorCmdSrc + '\nreturn parseSkillCommand;')();
  const mirrorSection = new Function(mirrorDirConst[0] + '\n' + mirrorSectionSrc + '\nreturn buildSkillsPromptSection;')();
  const cmdCases = ['/skill multiplayer\nmake a lobby', '/skill', '/SKILL Multiplayer', 'please /skill x', '/skill multiplayer make a lobby', '', '/skills x', '\n\n/skill foo-bar\nrest here'];
  check('app.js parseSkillCommand mirror agrees with skill-files.js on every case',
    cmdCases.every(t => JSON.stringify(mirrorParse(t)) === JSON.stringify(skillFiles.parseSkillCommand(t))));
  const sectionCases = [
    [],
    [{ name: 'foo', description: 'Does foo.' }],
    [{ name: 'foo', description: 'Does foo.', relPath: 'custom/path/SKILL.md' }, { name: 'bar', description: 'Does bar.' }],
    [{ name: 'foo' }, { name: 'bar', description: 'Does bar.' }],
  ];
  check('app.js buildSkillsPromptSection mirror agrees with skill-files.js on every case',
    sectionCases.every(c => mirrorSection(c) === skillFiles.buildSkillsPromptSection(c)));
}

// Discovery across builtin / user / project roots: the first root
// wins on a name clash, folders without SKILL.md or without a
// usable description are skipped, and a skill written straight
// into the project folder still shows up.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-skills-'));
  try {
    const builtin = path.join(tmp, 'builtin');
    const user = path.join(tmp, 'user');
    const project = path.join(tmp, 'project');
    const write = (dir, name, content) => {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'SKILL.md'), content);
    };
    write(builtin, 'multiplayer', '---\nname: multiplayer\ndescription: Use when adding multiplayer.\n---\n');
    write(builtin, 'plain', '# Plain Skill\n\nPlain skill does things.\n');
    fs.mkdirSync(path.join(builtin, 'broken'), { recursive: true });
    write(user, 'multiplayer', '---\nname: multiplayer\ndescription: A DIFFERENT description.\n---\n');
    write(user, 'user-only', '---\nname: user-only\ndescription: Only in user root.\n---\n');
    write(project, 'multiplayer', '---\nname: multiplayer\ndescription: Use when adding multiplayer.\n---\n');
    write(project, 'local-only', '---\nname: local-only\ndescription: Written straight into the project.\n---\n');
    const found = skillFiles.discoverSkills(fs, path, [
      { source: 'builtin', dir: builtin },
      { source: 'user', dir: user },
      { source: 'project', dir: project },
    ]);
    const byName = Object.fromEntries(found.skills.map(s => [s.name, s]));
    check('discoverSkills: first root wins, project-only skill included, fallback description used',
      found.skills.length === 4
      && byName['multiplayer'].source === 'builtin'
      && byName['multiplayer'].description === 'Use when adding multiplayer.'
      && byName['plain'].description === 'Plain skill does things.'
      && byName['user-only'].source === 'user'
      && byName['local-only'].source === 'project');
    check('discoverSkills: skipped lists the folder without SKILL.md and the duplicates',
      found.skipped.some(s => s.name === 'broken' && s.reason === 'no SKILL.md')
      && found.skipped.some(s => s.name === 'multiplayer' && s.source === 'user' && s.reason.startsWith('duplicate name')));
    check('discoverSkills: a missing root is skipped, not an error',
      skillFiles.discoverSkills(fs, path, [{ source: 'builtin', dir: path.join(tmp, 'does-not-exist') }]).skills.length === 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Wiring: main.js IPCs + project_skills table, preload surface,
// app.js call sites, packaging, and the bridge staying put.
check('main.js wires the skillFiles IPCs + project_skills table',
  mainJs.includes("ipcMain.handle('skillFiles:scan'") && mainJs.includes("ipcMain.handle('skillFiles:install'") && mainJs.includes("ipcMain.handle('skillFiles:setEnabled'") && mainJs.includes('CREATE TABLE IF NOT EXISTS project_skills'));
const preloadJs13 = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
check('preload exposes rb.skillFiles (scan/install/setEnabled)',
  preloadJs13.includes('skillFiles: {') && preloadJs13.includes("ipcRenderer.invoke('skillFiles:scan'") && preloadJs13.includes("ipcRenderer.invoke('skillFiles:install'") && preloadJs13.includes("ipcRenderer.invoke('skillFiles:setEnabled'"));
check('app.js: /skill handling, Skills settings section, prompt call site',
  appJs.includes('parseSkillCommand(text)') && appJs.includes('rb.skillFiles.scan') && appJs.includes('rb.skillFiles.install') && appJs.includes('rb.skillFiles.setEnabled') && appJs.includes('id="skill-files-list"') && appJs.includes('buildSystemPrompt(rulesets, enabledSkillFiles())'));
check('Settings Skills section shows the token estimate and the >5 warning',
  appJs.includes('tokens added to every Agent-mode prompt') && appJs.includes('More than 5 skills enabled — routing gets less reliable'));
check('package.json build.files ships skill-files.js and the skills folder',
  Array.isArray(pkg.build.files) && pkg.build.files.includes('skill-files.js') && pkg.build.files.includes('skills/**/*'));
check('bridge is now 0.16.2 (import profile in 0.17.0)',
  fs.readFileSync(path.join(root, 'unity-bridge.js'), 'utf8').includes("const BUNDLED_BRIDGE_VERSION = '0.16.2';"));

// The built-in multiplayer skill: frontmatter, file set, and the
// workflow points the skill must encode.
const mpSkill = path.join(root, 'skills', 'unity-multiplayer-networking');
const mpSkillMd = fs.readFileSync(path.join(mpSkill, 'SKILL.md'), 'utf8');
const mpFm = skillFiles.parseSkillFrontmatter(mpSkillMd);
check('multiplayer skill: SKILL.md frontmatter has name + strong use-when description',
  mpFm && mpFm.name === 'unity-multiplayer-networking' && /Use when adding multiplayer/i.test(mpFm.description || ''));
const mpFiles = [];
(function walkMd(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walkMd(path.join(dir, e.name));
    else if (e.name.endsWith('.md')) mpFiles.push(path.relative(mpSkill, path.join(dir, e.name)));
  }
})(mpSkill);
check('multiplayer skill: SKILL.md + per-stack references present (29 files)',
  mpFiles.length === 29 && mpFiles.includes('SKILL.md')
  && mpFiles.includes(path.join('references', 'netcode', 'SETUP.md'))
  && mpFiles.includes(path.join('references', 'photon', 'EXAMPLES_FUSION.md'))
  && mpFiles.includes(path.join('references', 'metaplay', 'BEST_PRACTICES.md')));
check('multiplayer skill: every stack has README/SETUP/EXAMPLES/DEBUGGING/BEST_PRACTICES',
  ['netcode', 'photon', 'fishnet', 'nakama', 'metaplay'].every(stack =>
    ['README.md', 'SETUP.md', 'DEBUGGING.md', 'BEST_PRACTICES.md'].every(f =>
      mpFiles.includes(path.join('references', stack, f)))
    && mpFiles.some(f => f.startsWith(path.join('references', stack, 'EXAMPLES')))));
check('multiplayer skill: SKILL.md encodes the workflow (detect, stop and ask, docs-first, config check, no programmatic install, no unasked docs)',
  mpSkillMd.includes('Detect the installed stack.')
  && mpSkillMd.includes('Then STOP and wait. Never silently adopt a stack, and never guess one.')
  && mpSkillMd.includes('Suggest 2–4 candidates with concrete trade-offs')
  && mpSkillMd.includes('Installing is a manual user step — never install a package programmatically.')
  && mpSkillMd.includes('verify the project configuration matches the approach')
  && mpSkillMd.includes('triggers never fire when the physics simulation mode is Script')
  && mpSkillMd.includes('Debug — docs FIRST, then fix.')
  && mpSkillMd.includes('physics or configuration bugs wearing a networking costume')
  && mpSkillMd.includes('Never freelance a fix from memory before reading the debugging docs.')
  && mpSkillMd.includes('Do not generate guides, READMEs, tutorials, or summary pages.')
  && mpSkillMd.includes('Never attempt to install packages or import assets programmatically'));
check('multiplayer skill: Metaplay examples are marked schematic (SDK names vary by version)',
  fs.readFileSync(path.join(mpSkill, 'references', 'metaplay', 'EXAMPLES.md'), 'utf8').includes('must be verified against the installed SDK docs')
  || fs.readFileSync(path.join(mpSkill, 'references', 'metaplay', 'EXAMPLES.md'), 'utf8').includes('check them against the official docs for that version'));

// Prompt: the agent prompt lists enabled skills (Agent mode,
// project connected); the Ask prompt and a no-skills prompt do not.
if (promptSrc) {
  const buildPrompt13 = new Function('state', 'window', 'projectScanSummary', 'UNITY_CREATE_PREFAB_EXAMPLE', promptHelpersSrc + promptSrc + '\nreturn (r, s) => buildSystemPrompt(r, s);');
  const agentState13 = { projectContext: 'a Unity project', projectPath: 'C:\\TD Pizza Racer', projectScan: null, rulesCharBudget: 4000, useCondensedRules: false, condensedRules: '', chatMode: 'agent' };
  const mpEnabled = [{ name: 'unity-multiplayer-networking', description: 'Use when adding multiplayer to a Unity game.', relPath: '.codefox/skills/unity-multiplayer-networking/SKILL.md' }];
  const agentPrompt13 = buildPrompt13(agentState13, {}, () => '', assets.UNITY_CREATE_PREFAB_EXAMPLE)([], mpEnabled);
  check('agent prompt lists enabled skills with name, description, path, and rules-win precedence',
    agentPrompt13.includes('## Skills')
    && agentPrompt13.includes('- unity-multiplayer-networking — Use when adding multiplayer to a Unity game.')
    && agentPrompt13.includes('.codefox/skills/unity-multiplayer-networking/SKILL.md')
    && agentPrompt13.includes('Project Rules always win'));
  const askPrompt13 = buildPrompt13({ ...agentState13, chatMode: 'ask' }, {}, () => '', assets.UNITY_CREATE_PREFAB_EXAMPLE)([], mpEnabled);
  check('ask prompt has no Skills section (no file tools to read one with)', !askPrompt13.includes('## Skills'));
  const noSkillsPrompt13 = buildPrompt13(agentState13, {}, () => '', assets.UNITY_CREATE_PREFAB_EXAMPLE)([], []);
  check('agent prompt with no skills enabled has no Skills section (an empty section costs tokens)', !noSkillsPrompt13.includes('## Skills'));
}

check('README has the Skills section + CHANGELOG has the 0.13.0 skills entry',
  readme.includes('### Skills') && readme.includes('Project Rules always win')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.13.0')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('Skills — progressive loading'));
check('README badge reads 0.21.2', readme.includes('version-0.21.2'));

// 38. v0.14.0 — bridge protocol hardening: the .bridge/
// transport (inbox/processing/outbox/heartbeat), Unity's own
// compiler (recompile_and_report_errors), and the unified
// readConsole buffer. The bridge .cs is structural (it can only
// truly run in Rob's Unity); the runner is plain Node and is
// tested directly with an injected fs and clock (see the async
// block below); the app.js helpers are extracted like the
// earlier ones.
const unityCommand = require(path.join(root, 'unity-command.js'));
check('unity-command pure helpers: safe request ids, heartbeat parse/status, result classification',
  unityCommand.isSafeBridgeRequestId('abc-123_X') === true
  && unityCommand.isSafeBridgeRequestId('../x') === false
  && unityCommand.isSafeBridgeRequestId('a/b') === false
  && unityCommand.isSafeBridgeRequestId('') === false
  && unityCommand.isSafeBridgeRequestId('x'.repeat(65)) === false
  && unityCommand.isSafeBridgeRequestId('bad id') === false
  && unityCommand.parseHeartbeat('{"protocol":1,"timeMs":1000,"isCompiling":false,"isPlaying":false}').ok === true
  && unityCommand.parseHeartbeat('{"protocol":2,"timeMs":1000}').ok === false
  && unityCommand.parseHeartbeat('not json').ok === false
  && unityCommand.parseHeartbeat('{"protocol":1}').ok === false
  && unityCommand.heartbeatStatus({ ok: true, timeMs: 1000, isCompiling: false }, 5000) === 'fresh'
  && unityCommand.heartbeatStatus({ ok: true, timeMs: 1000, isCompiling: false }, 7000) === 'stale'
  && unityCommand.heartbeatStatus({ ok: true, timeMs: 1000, isCompiling: true }, 7000) === 'stale-compiling'
  && unityCommand.heartbeatStatus(null, 5000) === 'missing'
  && unityCommand.heartbeatStatus({ ok: false }, 5000) === 'missing'
  && unityCommand.classifyBridgeResult('{"status":"ok","message":"done","data":{"a":1}}').state === 'ok'
  && unityCommand.classifyBridgeResult('{"status":"pending","message":"working"}').state === 'pending'
  && unityCommand.classifyBridgeResult('{"status":"error","message":"boom"}').state === 'error'
  && unityCommand.classifyBridgeResult('not json').state === 'unreadable'
  && unityCommand.classifyBridgeResult('{"status":"weird"}').state === 'unreadable'
  && unityCommand.oldBridgeError('0.11.0').includes('0.11.0')
  && unityCommand.oldBridgeError(null).includes('older CodeFox'));
check('unity-command exports the transport constants and the heartbeat read',
  unityCommand.BRIDGE_DIR === '.bridge' && unityCommand.INBOX_DIR === 'inbox' && unityCommand.OUTBOX_DIR === 'outbox'
  && unityCommand.PROTOCOL_VERSION === 1 && unityCommand.HEARTBEAT_FRESH_MS === 5000
  && typeof unityCommand.readHeartbeat === 'function' && typeof unityCommand.runUnityCommand === 'function');

// Transport minimum + .gitignore + legacy cleanup (unity-bridge.js).
const tmpT = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-transport-'));
try {
  const tProj = path.join(tmpT, 'proj');
  fs.mkdirSync(path.join(tProj, 'Assets', 'Editor'), { recursive: true });
  check('hasTransportBridge false with no bridge, false for 0.11.0, true for the bundled 0.12.0',
    bridge.MIN_TRANSPORT_VERSION === '0.12.0'
    && bridge.hasTransportBridge(tProj) === false
    && (() => {
      fs.writeFileSync(path.join(tProj, 'Assets', 'Editor', 'CodeFoxBridge.cs'), '// CodeFoxBridge version: 0.11.0\npublic class CodeFoxBridge {}');
      const old = bridge.hasTransportBridge(tProj);
      fs.writeFileSync(path.join(tProj, 'Assets', 'Editor', 'CodeFoxBridge.cs'), fs.readFileSync(path.join(root, 'unity-companion', 'CodeFoxBridge.cs'), 'utf8'));
      return old === false && bridge.hasTransportBridge(tProj) === true;
    })());
  check('ensureProjectGitignore does nothing without a .gitignore, appends .bridge/ once, is idempotent',
    bridge.ensureProjectGitignore(tProj) === false
    && (() => {
      fs.writeFileSync(path.join(tProj, '.gitignore'), 'Library/\n');
      const added = bridge.ensureProjectGitignore(tProj);
      const content = fs.readFileSync(path.join(tProj, '.gitignore'), 'utf8');
      const again = bridge.ensureProjectGitignore(tProj);
      const content2 = fs.readFileSync(path.join(tProj, '.gitignore'), 'utf8');
      return added === true && content.includes('.bridge/') && again === false && content2 === content;
    })());
  check('deleteLegacyProtocolFiles removes the old protocol files',
    (() => {
      fs.writeFileSync(path.join(tProj, 'Assets', '.codefox-command.json'), '{}');
      fs.writeFileSync(path.join(tProj, 'Assets', '.codefox-result.json'), '{}');
      bridge.deleteLegacyProtocolFiles(tProj);
      return !fs.existsSync(path.join(tProj, 'Assets', '.codefox-command.json'))
        && !fs.existsSync(path.join(tProj, 'Assets', '.codefox-result.json'));
    })());
  check('installBridgeFile removes legacy protocol files on update',
    (() => {
      fs.writeFileSync(path.join(tProj, 'Assets', '.codefox-command.json'), '{}');
      const inst = bridge.installBridgeFile(tProj, root);
      return inst.ok === true && !fs.existsSync(path.join(tProj, 'Assets', '.codefox-command.json'))
        && fs.readFileSync(path.join(tProj, '.gitignore'), 'utf8').includes('.bridge/');
    })());
} finally { fs.rmSync(tmpT, { recursive: true, force: true }); }

// Wiring: main.js heartbeat IPC + version gate, preload, app.js.
check('main.js has the unity:heartbeat IPC and the unity:command version gate (update first, longer wait after a reload)',
  mainJs.includes("ipcMain.handle('unity:heartbeat'")
  && mainJs.includes('unityBridge.MIN_TRANSPORT_VERSION')
  && mainJs.includes('heartbeatWaitMs = 45000')
  && mainJs.includes("const bridgeDir = path.join(projectPath, '.bridge')")
  && mainJs.includes('fs.rmSync(bridgeDir, { recursive: true, force: true })'));
check('preload.js exposes rb.unity.heartbeat',
  preloadJs.includes("ipcRenderer.invoke('unity:heartbeat'"));
check('app.js runCompileCheck is heartbeat-gated with a dotnet fallback, and the loop tracks the first error',
  appJs.includes('async function runCompileCheck()')
  && appJs.includes('rb.unity.heartbeat(state.projectPath)')
  && appJs.includes("command: { action: 'recompile_and_report_errors' }")
  && appJs.includes('normalizeBridgeCompileReport(res.data, res.message)')
  && appJs.includes('normalizeDotnetBuildCheck(check)')
  && appJs.includes('lastCompileFirstError: null')
  && appJs.includes('isSameFirstError(loopState.lastCompileFirstError, first)')
  && appJs.includes('The first error is identical to the last compile check'));
check('app.js manual build check uses the shared compile check',
  appJs.includes('const check = await runCompileCheck();'));
check('package.json build files include the plain-Node modules',
  Array.isArray(pkg.build && pkg.build.files) && pkg.build.files.includes('log-triage.js') && pkg.build.files.includes('skill-files.js') && pkg.build.files.includes('skills/**/*'));
check('README documents the .bridge/ transport, the console buffer, and the Unity compiler; CHANGELOG has the 0.14.0 entry',
  readme.includes('.bridge/inbox/') && readme.includes('heartbeat')
  && readme.includes('log buffer') && readme.includes('recompile_and_report_errors')
  && readme.includes("Unity's own compiler")
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.14.0 — 2026-11-26')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('Bridge protocol hardened'));

// 39. v0.15.0 — the play-test loop: set_play_mode,
// read_component_values, inject_input, click_ui, and the app-side
// wait tool. The bridge .cs is structural (it can only truly run
// in Rob's Unity — the first compile, the play-mode event
// ordering, the input focus behaviour, and the timed-run
// round-trip are all proven there); the app-side wait parser and
// the heartbeat fields are plain Node and are tested directly.
const waitParserSrc = extractFunction(appJs, 'parseWaitBlocks');
const waitClampSrc = extractFunction(appJs, 'clampWaitSeconds');
check('app.js wait parser is extractable for testing', !!waitParserSrc && !!waitClampSrc);
if (waitParserSrc && waitClampSrc) {
  const parseWait = new Function(waitClampSrc + '\n' + waitParserSrc + '\nreturn parseWaitBlocks;')();
  const clampWait = new Function(waitClampSrc + '\nreturn clampWaitSeconds;')();
  check('wait clamp: positive seconds pass, 0/negative/non-numbers fail, over 30 clamps to 30',
    clampWait(5) === 5 && clampWait(30) === 30 && clampWait(120) === 30 && clampWait(0.5) === 0.5
    && clampWait(0) === null && clampWait(-3) === null && clampWait('x') === null && clampWait(null) === null);
  const waits = parseWait('enter play mode\n```wait\n{"seconds": 5}\n```\nthen read\n```wait\n10\n```\n```wait\nnot json\n```\n');
  check('wait parser: object form, bare number, and invalid JSON',
    waits.length === 3
    && waits[0].seconds === 5 && waits[0].valid === true
    && waits[1].seconds === 10 && waits[1].valid === true
    && waits[2].valid === false && waits[2].error != null);
  check('wait parser: 0 seconds is invalid, 120 seconds parses and clamps',
    parseWait('```wait\n{"seconds": 0}\n```')[0].valid === false
    && parseWait('```wait\n{"seconds": 120}\n```')[0].valid === true
    && clampWait(parseWait('```wait\n{"seconds": 120}\n```')[0].seconds) === 30);
}
const changeMaking15Src = extractFunction(appJs, 'isChangeMakingAction');
check('app.js routes wait blocks through parseAgentActions and the loop waits interruptibly; a wait is not a change',
  appJs.includes('for (const b of parseWaitBlocks(text))')
  && appJs.includes("actions.push({ type: 'wait', seconds: b.seconds")
  && appJs.includes("action.type === 'wait'")
  && appJs.includes('clampWaitSeconds(action.seconds)')
  && appJs.includes('Tool result — Waited ')
  && appJs.includes('while (waitedMs < seconds * 1000)')
  && !!changeMaking15Src && !changeMaking15Src.includes("'wait'"));
check('bridge dispatcher registers set_play_mode, read_component_values, click_ui, inject_input (new Input System only, legacy gets a plain error)',
  bridgeCs.includes('{ "set_play_mode", (json, args) => PlayMode.Begin(json, args) }')
  && bridgeCs.includes('{ "read_component_values", (json, args) => ReadComponentValuesHandler.Handle(json, args) }')
  && bridgeCs.includes('{ "click_ui", (json, args) => ClickUI(json, args) }')
  && bridgeCs.includes('#if ENABLE_INPUT_SYSTEM')
  && bridgeCs.includes('{ "inject_input", (json, args) => InjectInputHandler.Begin(json, args) }')
  && bridgeCs.includes('uses the legacy input system only'));
const playStart = bridgeCs.indexOf('private static class PlayMode');
const playEnd = bridgeCs.indexOf('private static class ReadComponentValuesHandler', playStart);
const playSrc = playStart !== -1 && playEnd !== -1 ? bridgeCs.slice(playStart, playEnd) : '';
check('bridge PlayMode is extractable for the structural checks', playSrc.length > 0);
check('bridge PlayMode: SessionState phases, 60s enter / 30s exit timeouts, 120s duration cap, compile-error block, console report',
  playSrc.includes('CodeFox.PlayMode.PendingId') && playSrc.includes('CodeFox.PlayMode.Phase')
  && playSrc.includes('CodeFox.PlayMode.SettledState') && playSrc.includes('CodeFox.PlayMode.StartCursor')
  && playSrc.includes('CodeFox.PlayMode.Duration') && playSrc.includes('CodeFox.PlayMode.EndedBy')
  && playSrc.includes('EnterTimeoutSeconds = 60') && playSrc.includes('ExitTimeoutSeconds = 30')
  && playSrc.includes('MaxDurationSeconds = 120')
  && playSrc.includes('EditorUtility.scriptCompilationFailed')
  && playSrc.includes('OnPlayModeStateChanged') && playSrc.includes('EnteredPlayMode') && playSrc.includes('EnteredEditMode')
  && playSrc.includes('ConsoleBuffer.SummarySince') && playSrc.includes('"errorOccurrences"')
  && playSrc.includes('Use read_console with sinceSeq=')
  && playSrc.includes('TryFinalize') && playSrc.includes('IsPending'));
check('bridge transport finalizes play-mode and input requests, recovery skips pending play-mode ids, heartbeat carries play-mode state',
  bridgeCs.includes('TryFinalizePending') && bridgeCs.includes('PlayMode.TryFinalize')
  && bridgeCs.includes('InjectInputHandler.TryFinalize')
  && bridgeCs.includes('if (PlayMode.IsPending(id)) continue;')
  && bridgeCs.includes('isPlayingOrWillChangePlaymode') && bridgeCs.includes('isPaused'));
check('bridge compile action refuses while the game is running',
  bridgeCs.includes('Stop Play Mode first: set_play_mode'));
const rcStart = bridgeCs.indexOf('private static class ReadComponentValuesHandler');
const rcEnd = bridgeCs.indexOf('#if ENABLE_INPUT_SYSTEM', rcStart);
const rcSrc = rcStart !== -1 && rcEnd !== -1 ? bridgeCs.slice(rcStart, rcEnd) : '';
check('bridge ComponentLocator + read_component_values are extractable', bridgeCs.includes('private static class ComponentLocator') && rcSrc.length > 0);
check('bridge ComponentLocator: roots from loaded scenes + DontDestroyOnLoad probe, case-insensitive component, componentIndex',
  bridgeCs.includes('SceneManager.GetSceneAt') && bridgeCs.includes('__codefox_probe')
  && bridgeCs.includes('DontDestroyOnLoad') && bridgeCs.includes('StringComparison.OrdinalIgnoreCase')
  && bridgeCs.includes('"componentIndex"') && rcSrc.includes('internal static object ReadProperty'));
check('bridge read_component_values: discovery, caps, denied members, Similar suggestions, bounded output',
  rcSrc.includes('DefaultMaxProperties = 40') && rcSrc.includes('HardMaxProperties = 100')
  && rcSrc.includes('MaxCollectionItems = 8') && rcSrc.includes('MaxDepth = 2')
  && rcSrc.includes('MaxStringChars = 200')
  && rcSrc.includes('DeniedMembers') && rcSrc.includes('sharedMaterial') && rcSrc.includes('sharedMesh')
  && rcSrc.includes('Similar: ') && rcSrc.includes('LevenshteinDistance')
  && rcSrc.includes('"omitted"') && rcSrc.includes('"availableNames"') && rcSrc.includes('"unknownProperties"')
  && rcSrc.includes('"memberErrors"') && rcSrc.includes('"m_Script"'));
const injStart = bridgeCs.indexOf('private static class InjectInputHandler');
const injEnd = bridgeCs.indexOf('#endif', injStart);
const injSrc = injStart !== -1 && injEnd !== -1 ? bridgeCs.slice(injStart, injEnd) : '';
check('bridge InjectInputHandler is extractable for the structural checks', injSrc.length > 0);
check('bridge inject_input: Input System only, 50 steps / 30s caps, focus save/restore, self-check, stuck-key release, no arbitrary reflection',
  injSrc.includes('MaxSteps = 50') && injSrc.includes('MaxTotalSeconds = 30')
  && injSrc.includes('InputSystem.QueueStateEvent') && injSrc.includes('KeyboardState')
  && injSrc.includes('GamepadState') && injSrc.includes('WithButton')
  && injSrc.includes('backgroundBehavior') && injSrc.includes('IgnoreFocus')
  && injSrc.includes('editorInputBehaviorInPlayMode') && injSrc.includes('AllDeviceInputAlwaysGoesToGameView')
  && injSrc.includes('SessionState') && injSrc.includes('RestoreFocusSettings')
  && injSrc.includes('SelfCheck') && injSrc.includes('is being dropped')
  && injSrc.includes('DefaultTapFrames = 3')
  && injSrc.includes('AssemblyReloadEvents.beforeAssemblyReload')
  && injSrc.includes('playModeStateChanged')
  && !injSrc.includes('Invoke(') && !injSrc.includes('GetMethod('));
check('bridge has a hand-rolled JsonWrite (no Newtonsoft) and a shared ComponentLocator',
  bridgeCs.includes('private static string JsonWrite(object v)')
  && bridgeCs.includes('private static class ComponentLocator')
  && !bridgeCs.includes('Newtonsoft'));
check('unity-command heartbeat parses the 0.13.0 fields and readHeartbeat passes them through',
  unityCommand.parseHeartbeat('{"protocol":1,"timeMs":1000,"isCompiling":false,"isPlaying":true,"isPlayingOrWillChangePlaymode":true,"isPaused":false}').isPlayingOrWillChangePlaymode === true
  && unityCommand.parseHeartbeat('{"protocol":1,"timeMs":1000,"isCompiling":false,"isPlaying":false}').isPlayingOrWillChangePlaymode === false
  && unityCommand.parseHeartbeat('{"protocol":1,"timeMs":1000,"isCompiling":false,"isPlaying":false}').isPaused === false
  && (() => {
    const fakeFs = { existsSync: () => true, readFileSync: () => '{"protocol":1,"timeMs":' + Date.now() + ',"isCompiling":false,"isPlaying":true,"isPlayingOrWillChangePlaymode":true,"isPaused":true}' };
    const hb = unityCommand.readHeartbeat('/proj', fakeFs);
    return hb.exists === true && hb.fresh === true && hb.isPlaying === true && hb.isPlayingOrWillChangePlaymode === true && hb.isPaused === true;
  })());
check('README has the Play testing section + wait in the loop list; CHANGELOG has the 0.15.0 entry',
  readme.includes('### Play testing') && readme.includes('set_play_mode') && readme.includes('inject_input')
  && readme.includes('```wait blocks (a sleep in the loop, at most 30 seconds)')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.15.0 — 2026-11-26')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('The play-test loop'));
if (promptSrc) {
  const buildPrompt15 = new Function('state', 'window', 'projectScanSummary', 'UNITY_CREATE_PREFAB_EXAMPLE', promptHelpersSrc + promptSrc + '\nreturn buildSystemPrompt([]);');
  const agentPrompt15 = buildPrompt15(
    { projectContext: 'a Unity project', projectPath: 'C:\\TD Pizza Racer', projectScan: null, rulesCharBudget: 4000, useCondensedRules: false, condensedRules: '', chatMode: 'agent' },
    {},
    () => '',
    assets.UNITY_CREATE_PREFAB_EXAMPLE);
  check('agent prompt has the play-test actions (set_play_mode, read_component_values, inject_input, click_ui) and the Play testing section',
    agentPrompt15.includes('## Play testing')
    && agentPrompt15.includes('"action": "set_play_mode"')
    && agentPrompt15.includes('"action": "read_component_values"')
    && agentPrompt15.includes('"action": "inject_input"')
    && agentPrompt15.includes('"action": "click_ui"')
    && agentPrompt15.includes('linearVelocity') && agentPrompt15.includes('"velocity"'));
  check('agent prompt has the stop-Play-Mode rule, the timed-run default, and the two patterns',
    agentPrompt15.includes('stop Play Mode before finishing')
    && agentPrompt15.includes('A timed run is the default')
    && agentPrompt15.includes('console-based test') && agentPrompt15.includes('state probing')
    && agentPrompt15.includes('```wait')
    && agentPrompt15.includes('Never edit code while the game is running')
    && agentPrompt15.includes('run the game with set_play_mode'));
  check('the play-test examples in the built prompt are valid JSON',
    (() => {
      const section = agentPrompt15.slice(agentPrompt15.indexOf('## Unity — prefabs'), agentPrompt15.indexOf('## Reading and editing files'));
      const simple = section.match(/\{"action": "(?:set_play_mode|read_component_values|click_ui)"[^}]*\}/g) || [];
      if (simple.length < 5) return false;
      try { for (const f of simple) JSON.parse(f); } catch { return false; }
      const inj = section.indexOf('{"action": "inject_input"');
      if (inj < 0) return false;
      let depth = 0;
      for (let i = inj; i < section.length; i++) {
        if (section[i] === '{') depth++;
        else if (section[i] === '}') {
          depth--;
          if (depth === 0) {
            try { JSON.parse(section.slice(inj, i + 1)); return true; } catch { return false; }
          }
        }
      }
      return false;
    })());
}

// 40. v0.16.0 — scene tools: set_property (lead), create_gameobject,
// add_component, delete_gameobject, set_parent, GameObject
// pseudo-component, list_hierarchy, create_material, list_assets,
// MutationScope + ComponentTypeResolver + the app-side pathChanges
// rewriting and the dry-run approval bar. The bridge .cs is
// structural (it can only truly run in Rob's Unity — the first
// compile, the prefab delete/move rules on a real instance,
// SetTransformParent pose preservation, CreatePrimitive materials
// under URP/HDRP, GetUniqueNameForSibling(null) for scene roots,
// the reference-scan cost on a big scene, and CollapseUndoOperations
// merging across ticks are all proven there); the app-side path
// rewriting, preview labels, and prompt text are plain Node and
// are tested directly.
check('bridge .cs registers all eight new scene actions', [
  '"set_property"', '"create_gameobject"', '"add_component"', '"delete_gameobject"',
  '"set_parent"', '"list_hierarchy"', '"create_material"', '"list_assets"',
].every(a => bridgeCs.includes('{ ' + a + ',')));
check('bridge .cs has the scene helpers and handlers, no Newtonsoft', [
  'static class MutationScope', 'static class ComponentTypeResolver', 'static class SceneHelpers',
  'static class SetPropertyHandler', 'static class CreateGameObjectHandler', 'static class AddComponentHandler',
  'static class DeleteGameObjectHandler', 'static class SetParentHandler', 'static class ListHierarchyHandler',
  'static class CreateMaterialHandler', 'static class ListAssetsHandler',
].every(n => bridgeCs.includes(n)) && !bridgeCs.includes('Newtonsoft') && !bridgeCs.includes('using Newtonsoft'));
check('bridge .cs scene actions use the shared mutation scope and the GameObject pseudo-component', [
  'MutationScope.PlayModeError', 'MutationScope.BeginUndoGroup', 'MutationScope.Commit',
  'MutationScope.PlayModeWarning', 'ComponentTypeResolver.TryResolve', 'ComponentLocator.GetPath',
  '"GameObject"', 'expectedBefore', 'expectedLostObjects', 'renameOnConflict', 'keepWorldPosition',
].every(n => bridgeCs.includes(n)));
check('bridge .cs set_property stages on SerializedObject (all-or-nothing) and guards the GameObject rules', [
  'ApplyModifiedProperties()', 'Preview: ', 'IsPersistent', 'm_Script',
  'DescribeStaged', 'Nothing was changed', 'expectedBefore', 'allowPlayMode',
].every(n => bridgeCs.includes(n)));
check('bridge .cs delete preview scans inbound references under a time budget and list_hierarchy collapses siblings', [
  'InboundReference', 'inboundReferences', 'scanComplete', 'lostObjects', 'lostCount',
  'GroupByBaseName', 'CollapseThreshold', 'collapsedCount', 'hiddenChildren', '!dup',
  'shownSet', 'maxNodes', 'MaxFindResults',
].every(n => bridgeCs.includes(n)));
check('app.js has the scene path-change machinery and the dry-run approval flow', [
  'rewriteScenePath', 'rewriteToolResultPaths', 'applyPathChanges', 'resolveSceneCommandPaths',
  'showSceneApprovalBar', 'scenePreviewLabel', 'sceneDeclineText', 'SCENE_WRITE_ACTIONS', 'SCENE_PATH_ACTIONS',
  "turnId: 'turn-'", 'expectedBefore', 'expectedLostObjects', 'state.pathChanges = []',
].every(n => appJs.includes(n)));
check('app.js unity-command branch resolves paths, dry-runs scene writes, and records pathChanges', [
  'resolveSceneCommandPaths(action.command)', "pathResolution.dead", 'was deleted earlier in this session',
  "dryRun: true", "dryRun: false", 'showSceneApprovalBar({ label: scenePreviewLabel',
  'applyPathChanges(res.data.pathChanges)', 'rewrittenNote',
].every(n => appJs.includes(n)));
check('README has the Scene tools section + CHANGELOG has the 0.16.0 entry',
  readme.includes('### Scene tools') && readme.includes('set_property') && readme.includes('list_hierarchy')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.16.0 — 2026-11-26')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('Scene tools — edit the open scene directly'));
const rewritePathSrc = extractFunction(appJs, 'rewriteScenePath');
const rewriteResultsSrc = extractFunction(appJs, 'rewriteToolResultPaths');
const resolveCmdSrc = extractFunction(appJs, 'resolveSceneCommandPaths');
const applyChangesSrc = extractFunction(appJs, 'applyPathChanges');
const previewLabelSrc = extractFunction(appJs, 'scenePreviewLabel');
const shortValueSrc = extractFunction(appJs, 'shortValue');
const declineTextSrc = extractFunction(appJs, 'sceneDeclineText');
check('scene path helpers are extractable for testing',
  !!rewritePathSrc && !!rewriteResultsSrc && !!resolveCmdSrc && !!applyChangesSrc && !!previewLabelSrc && !!shortValueSrc && !!declineTextSrc);
if (rewritePathSrc && rewriteResultsSrc && resolveCmdSrc && applyChangesSrc && previewLabelSrc && shortValueSrc && declineTextSrc) {
  const rewriteScenePath = new Function(rewritePathSrc + '\nreturn rewriteScenePath;')();
  const rewriteToolResultPaths = new Function(rewriteResultsSrc + '\nreturn rewriteToolResultPaths;')();
  const scenePreviewLabel = new Function(shortValueSrc + '\n' + previewLabelSrc + '\nreturn scenePreviewLabel;')();
  const sceneDeclineText = new Function(declineTextSrc + '\nreturn sceneDeclineText;')();
  const changes16 = [
    { from: 'Level/Enemies/Boss', to: 'Level/Bosses/Boss' },
    { from: 'Player', to: null },
  ];
  check('rewriteScenePath: prefix rewrite, boundary (Level/Enemy never matches Level/EnemyBoss), dead path, chained moves',
    rewriteScenePath('Level/Enemies/Boss', changes16).path === 'Level/Bosses/Boss'
    && rewriteScenePath('Level/Enemies/Boss/Weapon', changes16).path === 'Level/Bosses/Boss/Weapon'
    && rewriteScenePath('Level/EnemyBoss', [{ from: 'Level/Enemy', to: 'Level/Foe' }]).path === 'Level/EnemyBoss'
    && rewriteScenePath('Player', changes16).dead === true
    && rewriteScenePath('Player/Weapon', changes16).dead === true
    && rewriteScenePath('Canvas/Panel', changes16).path === 'Canvas/Panel'
    && rewriteScenePath('A/B', [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }]).path === 'C/B');
  check('rewriteToolResultPaths: rewrites tool text, marks deleted paths, leaves asset files alone',
    rewriteToolResultPaths('read Player: speed 5', changes16) === 'read Player (deleted): speed 5'
    && rewriteToolResultPaths('see Level/Enemies/Boss', changes16) === 'see Level/Bosses/Boss'
    && rewriteToolResultPaths('opened Level/Enemy.prefab', [{ from: 'Level/Enemy', to: 'Level/Foe' }]) === 'opened Level/Enemy.prefab'
    && rewriteToolResultPaths('Level/Enemies/Boss/Weapon', changes16) === 'Level/Bosses/Boss/Weapon');
  check('resolveSceneCommandPaths: rewrites path args, reports dead paths, ignores non-scene commands',
    (() => {
      const resolveWith = new Function('state', rewritePathSrc + '\n' + resolveCmdSrc + '\nreturn resolveSceneCommandPaths;')({ pathChanges: changes16 });
      const moved = resolveWith({ action: 'read_component_values', path: 'Level/Enemies/Boss' });
      const moved2 = resolveWith({ action: 'set_parent', path: 'Level/Enemies/Boss', newParent: 'Level' });
      const dead = resolveWith({ action: 'set_property', path: 'Player', component: 'X' });
      const none = resolveWith({ action: 'createPrefab', name: 'Foo' });
      return moved.rewrittenPaths.length === 1 && moved.rewrittenPaths[0].path === 'Level/Bosses/Boss'
        && moved2.rewrittenPaths.length === 1 && moved2.rewrittenPaths[0].key === 'path'
        && dead.dead === true && dead.deadPath === 'Player'
        && none.rewrittenPaths.length === 0 && none.dead === false;
    })());
  check('applyPathChanges: extends the map and rewrites earlier tool results, never user messages',
    (() => {
      const st = {
        pathChanges: [],
        messages: [
          { role: 'user', content: 'Tool result — Unity command "read_component_values": Player speed 5' },
          { role: 'user', content: 'delete the Player object' },
          { role: 'assistant', content: 'Player is at speed 5' },
        ],
      };
      const apply = new Function('state', rewriteResultsSrc + '\n' + applyChangesSrc + '\nreturn applyPathChanges;')(st);
      apply([{ from: 'Player', to: null }]);
      return st.pathChanges.length === 1 && st.pathChanges[0].to === null
        && st.messages[0].content.includes('Player (deleted)')
        && st.messages[1].content === 'delete the Player object'
        && st.messages[2].content === 'Player is at speed 5';
    })());
  check('scene preview labels name the action, the path, and the diff; decline text says nothing changed',
    scenePreviewLabel('set_property', { path: 'Player', component: 'PlayerController' }, { changes: [{ property: 'moveSpeed', before: 5, after: 8 }] }).includes('moveSpeed 5 → 8')
    && scenePreviewLabel('delete_gameobject', { path: 'Level/Enemies/Boss' }, { lostCount: 4, inboundReferences: [{ path: 'Canvas/Button' }] }).includes('4 object(s)') && scenePreviewLabel('delete_gameobject', { path: 'X' }, { lostCount: 1, inboundReferences: [] }).includes('no broken references')
    && scenePreviewLabel('create_gameobject', { name: 'Boss' }, { path: 'Level/Boss', renamed: true }).includes('(renamed)')
    && scenePreviewLabel('set_parent', { path: 'A' }, { newPath: 'B/C', descendantCount: 3 }).includes('3 descendant(s)')
    && sceneDeclineText('delete_gameobject', { path: 'Level/Enemies/Boss' }, {}).includes('nothing deleted')
    && sceneDeclineText('set_property', { path: 'Player', component: 'PlayerController' }, {}).includes('no changes made'));
}
if (promptSrc) {
  const buildPrompt16 = new Function('state', 'window', 'projectScanSummary', 'UNITY_CREATE_PREFAB_EXAMPLE', promptHelpersSrc + promptSrc + '\nreturn buildSystemPrompt([]);');
  const agentPrompt16 = buildPrompt16(
    { projectContext: 'a Unity project', projectPath: 'C:\\TD Pizza Racer', projectScan: null, rulesCharBudget: 4000, useCondensedRules: false, condensedRules: '', chatMode: 'agent' },
    {},
    () => '',
    assets.UNITY_CREATE_PREFAB_EXAMPLE);
  check('agent prompt has the scene actions and the Scene tools section',
    agentPrompt16.includes('## Scene tools')
    && agentPrompt16.includes('"action": "set_property"')
    && agentPrompt16.includes('"action": "create_gameobject"')
    && agentPrompt16.includes('"action": "add_component"')
    && agentPrompt16.includes('"action": "delete_gameobject"')
    && agentPrompt16.includes('"action": "set_parent"')
    && agentPrompt16.includes('"action": "list_hierarchy"')
    && agentPrompt16.includes('"action": "create_material"')
    && agentPrompt16.includes('"action": "list_assets"'));
  check('agent prompt teaches read-before-write, one Ctrl+Z per turn, and the pathChanges convention',
    agentPrompt16.includes('read_component_values returns the exact serialized names set_property needs')
    && agentPrompt16.includes('one Ctrl+Z')
    && agentPrompt16.includes('pathChanges')
    && agentPrompt16.includes('Always use the paths from the latest tool results')
    && agentPrompt16.includes('was deleted earlier in this session'));
  check('the scene examples in the built prompt are valid JSON',
    (() => {
      const section = agentPrompt16.slice(agentPrompt16.indexOf('## Unity — prefabs'), agentPrompt16.indexOf('## Reading and editing files'));
      const actions = ['set_property', 'create_gameobject', 'add_component', 'delete_gameobject', 'set_parent', 'list_hierarchy', 'create_material', 'list_assets'];
      for (const a of actions) {
        const start = section.indexOf('{"action": "' + a + '"');
        if (start < 0) return false;
        let depth = 0;
        let closed = false;
        for (let i = start; i < section.length; i++) {
          if (section[i] === '{') depth++;
          else if (section[i] === '}') {
            depth--;
            if (depth === 0) {
              try { JSON.parse(section.slice(start, i + 1)); } catch { return false; }
              closed = true;
              break;
            }
          }
        }
        if (!closed) return false;
      }
      return true;
    })());
}

// 41. v0.17.0 — ComfyUI improvements: shared job + real cancel,
// import profiles, provenance sidecar, variations, GPU swap mode,
// confinement, and the comfyui.js split.
{
  // The split: three modules behind the comfyui.js facade, with
  // every original export still there (the facade is what main.js
  // and this test require).
  check('comfyui.js split: client/workflows/scan modules exist and the facade re-exports them',
    fs.existsSync(path.join(root, 'comfyui-client.js'))
    && fs.existsSync(path.join(root, 'comfyui-workflows.js'))
    && fs.existsSync(path.join(root, 'comfyui-scan.js'))
    && typeof comfy.cancelPrompt === 'function' && typeof comfy.freeComfyuiMemory === 'function'
    && typeof comfy.planVariations === 'function' && typeof comfy.clampVariations === 'function'
    && Array.isArray(comfy.IMPORT_PROFILES) && typeof comfy.fnv1aHash === 'function'
    && typeof comfy.workflowFileHash === 'function'
    && typeof comfy.parseWorkflowGraph === 'function' && typeof comfy.scanComfyui === 'function'
    && typeof comfy.convertUiGraphToApi === 'function' && typeof comfy.submitPrompt === 'function');

  // Variation planning, from the fake workflow's parsed inputs
  // (batch_size on node 5, seed 42 on node 4).
  check('planVariations: batch node renders N in one run',
    (() => {
      const p = comfy.planVariations(parsedWf.inputs, 3);
      return p.count === 3 && p.mode === 'batch' && p.batchNodeId === '5' && p.seedNodeId === null;
    })());
  check('planVariations: seed input gives sequential runs with the base seed',
    (() => {
      const p = comfy.planVariations([{ nodeId: '4', inputName: 'seed', value: 42 }], 3);
      return p.count === 3 && p.mode === 'sequential' && p.seedNodeId === '4' && p.baseSeed === 42;
    })());
  check('planVariations: no seed or batch runs once and says so',
    (() => {
      const p = comfy.planVariations([{ nodeId: '2', inputName: 'text', value: 'a knight' }], 3);
      return p.count === 1 && p.mode === 'single' && !!p.note;
    })());
  check('planVariations clamps the count to 1–4',
    comfy.clampVariations(0) === 1 && comfy.clampVariations(9) === 4
    && comfy.clampVariations('x') === 1 && comfy.clampVariations(2.7) === 2
    && comfy.planVariations(parsedWf.inputs, 99).count === 4);

  // Import profiles: the five ids, and the three lists that must
  // agree — comfyui-workflows.js, the bridge .cs, and the
  // renderer's copy in app.js.
  const profileIds = ['sprite', 'pixel-sprite', 'texture', 'normal-map', 'ui'];
  check('import profiles are exactly the five known ids',
    comfy.IMPORT_PROFILES.map(p => p.id).join(',') === profileIds.join(','));
  check('import profile lists agree across comfyui-workflows.js, the bridge, and app.js',
    profileIds.every(id => bridgeCs.includes('"' + id + '"'))
    && profileIds.every(id => appJs.includes("'" + id + "'"))
    && bridgeCs.includes('ApplyImportProfileHandler')
    && bridgeCs.includes('TextureImporter')
    && bridgeCs.includes('Assets/Generated/'));
  check('normalizeImportProfile lowercases and rejects unknown ids',
    comfy.normalizeImportProfile('Sprite') === 'sprite'
    && comfy.normalizeImportProfile('bogus') === ''
    && comfy.normalizeImportProfile('') === '');

  // Content hash for the provenance sidecar.
  check('fnv1aHash is deterministic, 8 hex chars, and distinguishes files',
    comfy.fnv1aHash('abc') === comfy.fnv1aHash('abc')
    && /^[0-9a-f]{8}$/.test(comfy.fnv1aHash('abc'))
    && comfy.fnv1aHash('abc') !== comfy.fnv1aHash('abd'));

  // The scan assigns a hash and preserves the import profile
  // across rescans, like purpose and approval.
  check('importWorkflowsFromFiles assigns a hash and preserves the import profile',
    (() => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-comfyui-hash-'));
      try {
        const file = path.join(tmp, 'hero.json');
        fs.writeFileSync(file, JSON.stringify(fakeWorkflow));
        const stored = [{ id: 'hero', purpose: 'x', approved: true, importProfile: 'sprite' }];
        const r = comfy.importWorkflowsFromFiles([file], fakeObjectInfo, stored, { source: 'user' });
        if (!r.workflows.length) return false;
        const w = r.workflows[0];
        return /^[0-9a-f]{8}$/.test(w.hash || '')
          && w.hash === comfy.fnv1aHash(JSON.stringify(fakeWorkflow))
          && w.importProfile === 'sprite';
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    })());

  // Confinement: only the last path segment of a ComfyUI
  // filename ever joins the import folder.
  const safeNameSrc = extractFunction(appJs, 'comfyuiSafeImportFilename');
  check('comfyuiSafeImportFilename is extractable', !!safeNameSrc);
  if (safeNameSrc) {
    const safeName = new Function(safeNameSrc + '\nreturn comfyuiSafeImportFilename;')();
    check('confinement: ../../x and absolute paths cannot escape Assets/Generated/',
      safeName('../../x.png') === 'x.png'
      && safeName('C:\\evil\\y.png') === 'y.png'
      && safeName('/abs/z.png') === 'z.png'
      && safeName('a/b/c.png') === 'c.png'
      && safeName('ok.png') === 'ok.png'
      && safeName('') === 'output.png');
  }

  // The provenance sidecar: workflow hash, the seed the run
  // actually used, prompt, inputs, profile, app version.
  const sidecarSrc = extractFunction(appJs, 'buildComfyuiSidecar');
  const normProfileSrc = extractFunction(appJs, 'normalizeComfyuiImportProfile');
  check('buildComfyuiSidecar + normalizeComfyuiImportProfile are extractable', !!sidecarSrc && !!normProfileSrc);
  if (sidecarSrc && normProfileSrc) {
    const build = new Function('APP_VERSION', 'normalizeComfyuiImportProfile', sidecarSrc + '\nreturn buildComfyuiSidecar;')('0.17.0', new Function(normProfileSrc + '\nreturn normalizeComfyuiImportProfile;')());
    const sc = build(
      { id: 'hero', name: 'Hero', source: 'user', hash: 'abcdef01', file: 'C:\\wf\\hero.json', inputs: [{ inputName: 'checkpoint_name', value: 'qwen.safetensors' }], importProfile: 'Sprite' },
      { promptId: 'p1', variation: 2, seedUsed: 45 },
      { positive: 'a hero', seed: 42 },
      'Assets/Generated/hero/hero-1.png');
    check('sidecar records workflow, prompt, seed used, checkpoint, profile, version',
      sc.workflow.hash === 'abcdef01' && sc.prompt === 'a hero' && sc.seed === 45
      && sc.checkpoints.includes('qwen.safetensors') && sc.importProfile === 'sprite'
      && sc.codefoxVersion === '0.17.0' && sc.asset === 'Assets/Generated/hero/hero-1.png'
      && sc.variation === 2 && sc.promptId === 'p1');
  }

  // The ```comfyui block carries a variations count.
  const parseBlocksSrc = extractFunction(appJs, 'parseComfyuiBlocks');
  check('parseComfyuiBlocks is extractable', !!parseBlocksSrc);
  if (parseBlocksSrc) {
    const parse = new Function(parseBlocksSrc + '\nreturn parseComfyuiBlocks;')();
    const withCount = parse('```comfyui\n{"workflow": "hero", "count": 3, "inputs": {}}\n```');
    const withVariations = parse('```comfyui\n{"workflow": "hero", "variations": 2, "inputs": {}}\n```');
    const plain = parse('```comfyui\n{"workflow": "hero", "inputs": {}}\n```');
    check('parseComfyuiBlocks reads count / variations, defaulting to 1',
      withCount.length === 1 && withCount[0].count === 3
      && withVariations.length === 1 && withVariations[0].count === 2
      && plain.length === 1 && plain[0].count === 1);
  }

  // The chat result v2 envelope: running shows Cancel, failed
  // shows the error, per-image state shows per-image.
  if (markerMatch && parseSrc && chatHtmlSrc && escSrc) {
    try {
      const marker = markerMatch[1];
      const escHtml = new Function(escSrc + '\nreturn escHtml;')();
      const renderChatResult = new Function('escHtml', 'comfyuiFileUrl', 'comfyuiSlug',
        'const COMFYUI_CHAT_MARKER = ' + JSON.stringify(marker) + ';\n'
        + parseSrc + '\n' + chatHtmlSrc + '\nreturn comfyuiChatResultHtml;')(
        escHtml, (p) => 'file:///' + String(p || '').replace(/\\/g, '/'), (n) => 'slug');
      const runningMsg = { role: 'assistant', content: marker + JSON.stringify({
        v: 2, workflowId: 'w1', workflowName: 'hero', prompt: 'a hero', inputs: {},
        outputs: [], jobId: 'job-1', status: 'running', error: null, imported: false, dir: '', discarded: false,
      }) };
      const runningHtml = renderChatResult(runningMsg, 5);
      check('chat result shows live status + Cancel while the job runs',
        runningHtml.includes('Generating') && runningHtml.includes('cancelComfyuiChatJob(5)'));
      const failedMsg = { role: 'assistant', content: marker + JSON.stringify({
        v: 2, workflowId: 'w1', workflowName: 'hero', prompt: '', inputs: {},
        outputs: [{ filename: 'x.png', subfolder: '', type: 'output', localPath: null }],
        jobId: 'job-1', status: 'failed', error: 'ComfyUI reported an error', imported: false, dir: '', discarded: false,
      }) };
      check('chat result shows the failure plainly',
        renderChatResult(failedMsg, 0).includes('ComfyUI reported an error'));
      const perImageMsg = { role: 'assistant', content: marker + JSON.stringify({
        v: 2, workflowId: 'w1', workflowName: 'hero', prompt: '', inputs: {},
        outputs: [
          { filename: 'a.png', subfolder: '', type: 'output', localPath: 'C:\\tmp\\a.png', imported: true, assetPath: 'Assets/Generated/hero/a.png' },
          { filename: 'b.png', subfolder: '', type: 'output', localPath: 'C:\\tmp\\b.png', imported: false, discarded: false },
        ],
        jobId: null, status: 'done', imported: false, dir: '', discarded: false,
      }) };
      const perImageHtml = renderChatResult(perImageMsg, 2);
      check('chat result shows per-image Imported and per-image Import',
        perImageHtml.includes('✓ Imported to Assets/Generated/hero/a.png')
        && perImageHtml.includes('importComfyuiChatImage(2, 1)'));
    } catch (e) {
      check('chat-result v2 renderer runs in Node', false, String(e && e.message));
    }
  }

  // The job machinery: one shared job, cancel, and no global
  // poll-stop flag left.
  check('app.js has the shared job object and real cancel, no global poll-stop',
    appJs.includes('function createComfyuiJob') && appJs.includes('function cancelComfyuiJob')
    && appJs.includes('function runComfyuiJob') && appJs.includes('function pollComfyuiPrompt')
    && appJs.includes('rb.comfyui.cancel({ promptId })')
    && !appJs.includes('window._comfyuiPollStop'));
  check('agent loop cancels the job on Stop and creates the chat message before the run',
    appJs.includes('cancelComfyuiJob(state.comfyuiGenerating.jobId)')
    && appJs.includes('createComfyuiJob(wf, { plan, swap: !!swappedModel, swappedModel })')
    && appJs.includes('runComfyuiJobFromJob(job, action.inputs)'));
  check('system prompt teaches variations, the sidecar, and chaining into the scene',
    appJs.includes('Add "count": 2–4 when the user wants variations')
    && appJs.includes('<asset>.gen.json sidecar')
    && appJs.includes("assign it to a SpriteRenderer with the set_property tool (m_Sprite)"));

  // GPU swap mode: the setting, the UI, and the unload/reload
  // helpers. The unload endpoint is LM Studio's /api/v1/models/unload.
  check('GPU swap mode: setting seeded, UI in Settings, unload + reload helpers in app.js',
    mainJs.includes("INSERT OR IGNORE INTO settings VALUES ('comfyui_gpu_mode', 'shared')")
    && appJs.includes('function setComfyuiGpuMode') && appJs.includes('GPU mode')
    && appJs.includes('function unloadModelForComfyuiSwap') && appJs.includes('function reloadModelAfterComfyuiSwap')
    && appJs.includes("rb.llm.unloadModel(model)") && appJs.includes("rb.comfyui.freeMemory({})"));
  check('lmstudio-load.js has unloadLmStudioModel (POST /api/v1/models/unload)',
    typeof lmLoad.unloadLmStudioModel === 'function'
    && fs.readFileSync(path.join(root, 'lmstudio-load.js'), 'utf8').includes('/api/v1/models/unload'));

  // New IPCs on both sides of the bridge.
  check('main.js + preload expose cancel / freeMemory / planVariations / unloadModel',
    mainJs.includes("ipcMain.handle('comfyui:cancel'") && mainJs.includes("ipcMain.handle('comfyui:freeMemory'")
    && mainJs.includes("ipcMain.handle('comfyui:planVariations'") && mainJs.includes("ipcMain.handle('llm:unloadModel'")
    && preloadJs.includes("cancel: (payload) => ipcRenderer.invoke('comfyui:cancel'")
    && preloadJs.includes("freeMemory: (payload) => ipcRenderer.invoke('comfyui:freeMemory'")
    && preloadJs.includes("planVariations: (payload) => ipcRenderer.invoke('comfyui:planVariations'")
    && preloadJs.includes("unloadModel: (modelId) => ipcRenderer.invoke('llm:unloadModel'"));

  // Bridge: the import-profile handler is registered, confined,
  // and versioned.
  check('bridge registers apply_import_profile, confined to Assets/Generated/, version 0.16.2',
    bridgeCs.includes('{ "apply_import_profile", (json, args) => ApplyImportProfileHandler.Handle(json, args) }')
    && bridgeCs.includes('TextureImporterType.Sprite') && bridgeCs.includes('SaveAndReimport')
    && bridgeCs.includes("StartsWith(\"Assets/Generated/\"")
    && bridgeCs.includes('// CodeFoxBridge version: 0.16.2'));

  // Version pins and packaging for 0.21.2.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  check('package.json is 0.21.2 and build.files includes the three split modules + context-budget.js',
    pkg.version === '0.21.2'
    && pkg.build.files.includes('comfyui-client.js')
    && pkg.build.files.includes('comfyui-workflows.js')
    && pkg.build.files.includes('comfyui-scan.js')
    && pkg.build.files.includes('context-budget.js')
    && pkg.build.files.includes('turn-ledger.js'));
  check('index.html footer and README badge are 0.21.2, CHANGELOG keeps the 0.21.1 entry',
    indexHtml.includes('CodeFox 0.21.2 — Local · No account needed')
    && fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes('badge/version-0.21.2-blue')
    && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.21.1 — 2026-11-26'));
}

// 42. v0.18.0 — the eval harness: YAML tasks, programmatic
// checks, k-run aggregation, canary subset, no LLM-as-judge.
{
  const EvalTasks = require('../eval/eval-tasks.js');
  const taskDir = path.join(root, 'eval', 'tasks');
  const taskFiles = fs.readdirSync(taskDir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const parsedTasks = [];
  let parseFailed = [];
  for (const f of taskFiles) {
    const r = EvalTasks.parseTask(fs.readFileSync(path.join(taskDir, f), 'utf8'), f);
    if (!r.ok) parseFailed.push(f + ': ' + r.errors.join('; '));
    else parsedTasks.push(r.task);
  }
  check('eval: all 12 task YAMLs parse', taskFiles.length === 12 && parseFailed.length === 0, parseFailed.join(' | ') || (taskFiles.length + ' files'));
  check('eval: fnv1a is deterministic and distinguishes inputs',
    EvalTasks.fnv1a('abc') === EvalTasks.fnv1a('abc') && EvalTasks.fnv1a('abc') !== EvalTasks.fnv1a('abd'));
  check('eval: estimateTokens is chars/4 (labelled estimate)', EvalTasks.estimateTokens('abcdabcd') === 2);
  check('eval: canary subset is 10 tasks', EvalTasks.selectTasks(parsedTasks, { suite: 'canary' }).length === 10);
  check('eval: full suite is 12 tasks', EvalTasks.selectTasks(parsedTasks, { suite: 'full' }).length === 12);
  check('eval: single-task selection by id', (EvalTasks.selectTasks(parsedTasks, { taskId: 'fix-syntax' }) || []).length === 1);
  check('eval: unknown task id selects nothing', EvalTasks.selectTasks(parsedTasks, { taskId: 'no-such-task' }) === null);
  // The YAML subset keeps blank lines inside block scalars (the
  // mock replies contain fenced code blocks separated by blanks).
  const blankYaml = EvalTasks.parseYaml('id: t\nprompt: |\n  line one\n\n  line three\n', 't.yaml');
  check('eval: YAML block scalar keeps blank lines', blankYaml.ok && blankYaml.value.prompt === 'line one\n\nline three\n', JSON.stringify(blankYaml.value && blankYaml.value.prompt));
  const fixType = parsedTasks.find((t) => t.id === 'fix-type-error');
  check('eval: quoted JSON with escaped quotes survives the parser',
    !!fixType && fixType.mockReplies[0].includes('SetHealth(\\"100\\")'));
  const denied = parsedTasks.find((t) => t.id === 'denied-approval');
  check('eval: denied-approval has null reference and deny policy',
    !!denied && denied.reference === null && denied.approvals === 'deny');
  const readOnly = parsedTasks.find((t) => t.id === 'read-only');
  check('eval: read-only task does not require the baseline to fail',
    !!readOnly && readOnly.baselineMustFail === false && readOnly.mode === 'ask');
  check('eval: every task has mock replies and a reference or an explicit null',
    parsedTasks.every((t) => t.mockReplies.length > 0 && (t.reference === null || typeof t.reference === 'object')));
  // Check evaluation against plain world objects.
  const withUnity = { unityAvailable: true };
  const noUnity = { unityAvailable: false };
  check('eval: state check passes on a matching value',
    EvalTasks.evaluateCheck({ type: 'state', path: 'Player', component: 'Rigidbody', property: 'm_Mass', equals: 2.5 },
      Object.assign({}, withUnity, { state: { 'Player|Rigidbody': { ok: true, values: { m_Mass: 2.5 } } } })).pass === true);
  check('eval: state check fails on a wrong value',
    EvalTasks.evaluateCheck({ type: 'state', path: 'Player', component: 'Rigidbody', property: 'm_Mass', equals: 2.5 },
      Object.assign({}, withUnity, { state: { 'Player|Rigidbody': { ok: true, values: { m_Mass: 1 } } } })).pass === false);
  check('eval: state exists:false passes when the object is gone',
    EvalTasks.evaluateCheck({ type: 'state', path: 'Level/Enemies/Enemy2', component: 'Enemy', exists: false },
      Object.assign({}, withUnity, { state: { 'Level/Enemies/Enemy2|Enemy': { ok: false, error: 'not found' } } })).pass === true);
  check('eval: state check skips with no Unity',
    EvalTasks.evaluateCheck({ type: 'state', path: 'Player', component: 'Rigidbody', property: 'm_Mass', equals: 2.5 }, noUnity).skipped === true);
  check('eval: compiles passes on success, fails on errors, skips with no Unity',
    EvalTasks.evaluateCheck({ type: 'compiles' }, Object.assign({}, withUnity, { compiles: { success: true, errors: [] } })).pass === true
    && EvalTasks.evaluateCheck({ type: 'compiles' }, Object.assign({}, withUnity, { compiles: { success: false, errors: [{ file: 'A.cs', line: 3, message: 'CS1002' }] } })).pass === false
    && EvalTasks.evaluateCheck({ type: 'compiles' }, noUnity).skipped === true);
  check('eval: console_clean passes on zero errors, fails on errors',
    EvalTasks.evaluateCheck({ type: 'console_clean' }, Object.assign({}, withUnity, { consoleReport: { errorCount: 0 } })).pass === true
    && EvalTasks.evaluateCheck({ type: 'console_clean' }, Object.assign({}, withUnity, { consoleReport: { errorCount: 2, firstErrors: ['NullReferenceException'] } })).pass === false);
  check('eval: probe passes on matching lines, fails on a missing key',
    EvalTasks.evaluateCheck({ type: 'probe', expect: { jumped: 'true' } },
      Object.assign({}, withUnity, { probeLines: [{ key: 'jumped', value: 'true' }] })).pass === true
    && EvalTasks.evaluateCheck({ type: 'probe', expect: { jumped: 'true' } },
      Object.assign({}, withUnity, { probeLines: [{ key: 'rotated', value: 'true' }] })).pass === false);
  check('eval: probe check skips with no Unity',
    EvalTasks.evaluateCheck({ type: 'probe', expect: { jumped: 'true' } }, noUnity).skipped === true);
  check('eval: file contains passes and fails honestly',
    EvalTasks.evaluateCheck({ type: 'file', path: 'A.cs', contains: 'Rotate' }, { files: { 'A.cs': 'transform.Rotate(0, 1, 0);' } }).pass === true
    && EvalTasks.evaluateCheck({ type: 'file', path: 'A.cs', contains: 'Rotate' }, { files: { 'A.cs': 'nothing here' } }).pass === false);
  check('eval: file regex works',
    EvalTasks.evaluateCheck({ type: 'file', path: 'A.cs', regex: 'SetHealth\\(\\d+' }, { files: { 'A.cs': 'target.SetHealth(100f);' } }).pass === true);
  check('eval: no_collateral passes on allowlisted changes only',
    EvalTasks.evaluateCheck({ type: 'no_collateral', allowlist: ['Assets/Scenes/Main.unity'] }, { fileChanges: ['Assets/Scenes/Main.unity'] }).pass === true
    && EvalTasks.evaluateCheck({ type: 'no_collateral', allowlist: ['Assets/Scenes/Main.unity'] }, { fileChanges: ['Assets/Scripts/PlayerController.cs'] }).pass === false);
  check('eval: no_collateral always protects the probe script',
    EvalTasks.evaluateCheck({ type: 'no_collateral', allowlist: ['Assets/EvalProbe.cs'] }, { fileChanges: ['Assets/EvalProbe.cs'] }).pass === false);
  check('eval: nothing_changed passes on no changes, fails on any',
    EvalTasks.evaluateCheck({ type: 'nothing_changed' }, { fileChanges: [] }).pass === true
    && EvalTasks.evaluateCheck({ type: 'nothing_changed' }, { fileChanges: ['Assets/Scripts/Enemy.cs'] }).pass === false);
  check('eval: approval_denied passes when asked, declined, unchanged',
    EvalTasks.evaluateCheck({ type: 'approval_denied', action: 'delete_gameobject' },
      { transcriptActions: [{ type: 'delete_gameobject' }], declines: 1, fileChanges: [] }).pass === true);
  check('eval: approval_denied fails with no decline, or when never asked',
    EvalTasks.evaluateCheck({ type: 'approval_denied', action: 'delete_gameobject' },
      { transcriptActions: [{ type: 'delete_gameobject' }], declines: 0, fileChanges: [] }).pass === false
    && EvalTasks.evaluateCheck({ type: 'approval_denied', action: 'delete_gameobject' },
      { transcriptActions: [], declines: 1, fileChanges: [] }).pass === false);
  check('eval: pass rule needs at least one real pass — all-skipped fails',
    EvalTasks.evaluateChecks([{ type: 'compiles' }, { type: 'state', path: 'P', component: 'C' }], noUnity).passed === false
    && EvalTasks.evaluateChecks([{ type: 'compiles' }], Object.assign({}, withUnity, { compiles: { success: true, errors: [] } })).passed === true);
  const agg3 = EvalTasks.aggregateRuns([{ pass: true }, { pass: true }, { pass: true }]);
  check('eval: 3/3 aggregates to rate 1, consistent', agg3.passRate === 1 && agg3.consistent === true);
  const agg2 = EvalTasks.aggregateRuns([{ pass: true }, { pass: false }, { pass: true }]);
  check('eval: 2/3 aggregates to rate 2/3, inconsistent, CI inside [0,1]',
    Math.abs(agg2.passRate - 2 / 3) < 1e-9 && agg2.consistent === false && agg2.ciLow >= 0 && agg2.ciHigh <= 1 && agg2.ciLow < agg2.ciHigh);
  const flips = EvalTasks.detectFlips({ a: true, b: false }, { a: false, b: true, c: true });
  check('eval: flip detection flags the regression and the improvement, ignores new tasks',
    flips.length === 2 && flips.some((f) => f.id === 'a' && f.regression) && flips.some((f) => f.id === 'b' && !f.regression));
  check('eval: flip detection reports no flips when nothing changed',
    EvalTasks.detectFlips({ a: true }, { a: true }).length === 0);
  const keyA = EvalTasks.buildResultKey({ model: { provider: 'lmstudio', model: 'qwen3-coder', loadedContext: 16384 }, appVersion: '0.18.0', promptHash: 'aaaa0001' });
  const keyB = EvalTasks.buildResultKey({ model: { provider: 'lmstudio', model: 'qwen3-coder', loadedContext: 16384 }, appVersion: '0.18.0', promptHash: 'aaaa0001' });
  const keyC = EvalTasks.buildResultKey({ model: { provider: 'lmstudio', model: 'qwen3-coder', loadedContext: 16384 }, appVersion: '0.18.0', promptHash: 'bbbb0002' });
  const keyD = EvalTasks.buildResultKey({ model: { provider: 'lmstudio', model: 'other-model', loadedContext: 16384 }, appVersion: '0.18.0', promptHash: 'aaaa0001' });
  check('eval: result key is stable for identical inputs, changes with prompt or model',
    keyA.hash === keyB.hash && keyA.hash !== keyC.hash && keyA.hash !== keyD.hash);
  // Fixture files exist on disk.
  const baseFiles = ['ProjectSettings/ProjectVersion.txt', 'ProjectSettings/ProjectSettings.asset', 'Packages/manifest.json',
    'Assets/Scripts/PlayerController.cs', 'Assets/Scripts/PlayerController.cs.meta',
    'Assets/Scripts/Enemy.cs', 'Assets/Scripts/Enemy.cs.meta',
    'Assets/EvalProbe.cs', 'Assets/EvalProbe.cs.meta', 'Assets/Scenes/Main.unity'];
  const missingBase = baseFiles.filter((f) => !fs.existsSync(path.join(root, 'eval', 'fixtures', 'base', f)));
  check('eval: base fixture files exist', missingBase.length === 0, missingBase.join(', '));
  const overlayFiles = ['broken-syntax/Assets/Scripts/BrokenSyntax.cs', 'broken-syntax/Assets/Scripts/BrokenSyntax.cs.meta',
    'type-error/Assets/Scripts/TypeErrorA.cs', 'type-error/Assets/Scripts/TypeErrorA.cs.meta',
    'type-error/Assets/Scripts/TypeErrorB.cs', 'type-error/Assets/Scripts/TypeErrorB.cs.meta',
    'nullref/Assets/Scripts/NullRef.cs', 'nullref/Assets/Scripts/NullRef.cs.meta',
    'nullref/gen-scene.js', 'large-scene/gen-scene.js'];
  const missingOverlay = overlayFiles.filter((f) => !fs.existsSync(path.join(root, 'eval', 'fixtures', 'overlays', f)));
  check('eval: overlay fixture files exist', missingOverlay.length === 0, missingOverlay.join(', '));
  // The large-scene generator writes 500 enemies + the base objects.
  const largeGen = require('../eval/fixtures/overlays/large-scene/gen-scene.js');
  const tmpLarge = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-eval-large-'));
  try {
    largeGen.generate(tmpLarge);
    const scene = fs.readFileSync(path.join(tmpLarge, 'Assets', 'Scenes', 'Main.unity'), 'utf8');
    const enemyNames = scene.match(/^  m_Name: Enemy_/gm) || [];
    check('eval: large-scene generator writes exactly 500 enemies', enemyNames.length === 500, enemyNames.length + ' found');
    check('eval: large-scene generator keeps the probe and the player', scene.includes('m_Name: EvalProbe') && scene.includes('m_Name: Player'));
  } finally { fs.rmSync(tmpLarge, { recursive: true, force: true }); }
  // The nullref generator appends its object to a copy of the base scene.
  const nullGen = require('../eval/fixtures/overlays/nullref/gen-scene.js');
  const tmpNull = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-eval-null-'));
  try {
    const baseScene = fs.readFileSync(path.join(root, 'eval', 'fixtures', 'base', 'Assets', 'Scenes', 'Main.unity'), 'utf8');
    fs.mkdirSync(path.join(tmpNull, 'Assets', 'Scenes'), { recursive: true });
    fs.writeFileSync(path.join(tmpNull, 'Assets', 'Scenes', 'Main.unity'), baseScene);
    nullGen.generate(tmpNull);
    const scene = fs.readFileSync(path.join(tmpNull, 'Assets', 'Scenes', 'Main.unity'), 'utf8');
    check('eval: nullref generator appends the NullRef object', scene.includes('m_Name: NullRef') && scene.includes('m_Name: EvalProbe'));
  } finally { fs.rmSync(tmpNull, { recursive: true, force: true }); }
  // Wiring: main, preload, app, package, gitignore.
  check('eval: main.js has the eval IPCs and argv parsing',
    mainJs.includes("ipcMain.handle('eval:resetFixture'") && mainJs.includes("ipcMain.handle('eval:hashTree'")
    && mainJs.includes("ipcMain.handle('app:quit'") && mainJs.includes('function parseEvalArgv'));
  const preloadJs = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  check('eval: preload exposes rb.eval and rb.app.quit',
    preloadJs.includes('eval:resetFixture') && preloadJs.includes('eval:hashTree') && preloadJs.includes("quit: () => ipcRenderer.invoke('app:quit')"));
  const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  check('eval: app.js starts eval mode after showHome in init',
    appJs.includes('await maybeStartEvalMode()') && appJs.includes('function maybeStartEvalMode'));
  check('eval: package.json has eval scripts and ships the harness',
    typeof pkg.scripts.eval === 'string' && pkg.scripts.eval.includes('eval-runner.js')
    && typeof pkg.scripts['eval:canary'] === 'string' && typeof pkg.scripts['eval:full'] === 'string'
    && Array.isArray(pkg.build.files) && pkg.build.files.includes('eval/**/*') && pkg.build.files.includes('scripts/eval-runner.js'));
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  check('eval: gitignore keeps run work out of the repo', gitignore.includes('eval-work/') && gitignore.includes('eval/results/'));
  check('eval: harness README exists', fs.existsSync(path.join(root, 'eval', 'README.md')));
  // The driver only calls EvalTasks functions that exist.
  const driverJs = fs.readFileSync(path.join(root, 'eval', 'eval-mode.js'), 'utf8');
  const calledApis = [...driverJs.matchAll(/EvalTasks\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const missingApis = [...new Set(calledApis)].filter((name) => typeof EvalTasks[name] !== 'function');
  check('eval: driver only calls EvalTasks functions that exist', missingApis.length === 0, missingApis.join(', '));
  check('eval: driver never calls a removed helper', !driverJs.includes('taskPass') && !driverJs.includes('stateKey(') && !driverJs.includes('summarize('));
  // The three fixes the first mock canary run caught: rb.fs.readFile
  // returns { ok, content }, not a string; the fixture paths are
  // relative to the eval folder (main.js passes evalDir as the eval
  // folder, not the app root); file writes in 'auto' tasks use the
  // direct-apply path because the apply bar's only success decision
  // is 'applied', which the policy wrapper cannot produce.
  check('eval: driver unwraps the { ok, content } readFile shape',
    driverJs.includes('async function readText') && driverJs.includes('if (r && r.ok) return r.content'));
  check('eval: fixture paths are relative to the eval folder',
    mainJs.includes("path.join(evalDir, 'fixtures', 'base')") && mainJs.includes("path.join(evalDir, 'fixtures', 'overlays', fixture)")
    && !mainJs.includes("path.join(evalDir, 'eval', 'fixtures'"));
  check('eval: driver preserves the bridge across resets and re-ensures it',
    mainJs.includes('CodeFoxBridge.cs') && mainJs.includes('could not restore the bridge')
    && driverJs.includes('resetFixtureAndBridge') && driverJs.includes('rb.unity.ensureBridge(ctx.projectDir)'));
  check('eval: baseline is re-hashed after the bridge ensure, and transient bridge files are skipped',
    driverJs.includes('Re-hash AFTER the bridge ensure') && driverJs.includes('await rb.eval.hashTree({ projectDir: ctx.projectDir })')
    && mainJs.includes('EVAL_TRANSIENT_FILES') && mainJs.includes('.codefox-refresh-trigger')); 
  // resolvePath used to join with a backslash unconditionally — on
  // Linux that wrote files literally named `project\Assets\…`.
  // The mock canary caught it; the fix joins with the platform's
  // separator.
  const resolvePathSrc = extractFunction(appJs, 'resolvePath');
  check('eval: resolvePath can be extracted for testing', !!resolvePathSrc);
  if (resolvePathSrc) {
    const makeResolve = (platform, projectPath) => new Function('navigator', 'state', resolvePathSrc + '\nreturn resolvePath;')({ platform }, { projectPath });
    const resolveLinux = makeResolve('Linux x86_64', '/tmp/proj');
    const resolveWindows = makeResolve('Win32', 'C:\\Users\\rob\\proj');
    check('eval: resolvePath joins with / on Linux',
      resolveLinux('Assets/Scripts/Rotator.cs') === '/tmp/proj/Assets/Scripts/Rotator.cs');
    check('eval: resolvePath joins with \\ on Windows',
      resolveWindows('Assets/Scripts/Rotator.cs') === 'C:\\Users\\rob\\proj\\Assets\\Scripts\\Rotator.cs');
    check('eval: resolvePath passes absolute paths through',
      resolveLinux('/abs/path.cs') === '/abs/path.cs' && resolveWindows('D:\\abs\\path.cs') === 'D:\\abs\\path.cs');
  }
  check('eval: auto-accept is per-task — on for auto, off for deny',
    driverJs.includes("state.autoAcceptChanges = (policy === 'auto')"));
}

// 43. v0.19.0 — context budgeting: calibrated counting, the
// elide/summarize/drop triggers, the deterministic ledger and
// project map, prefix-cache-aware batch compaction, the meter,
// and the wiring at every model call site. Bridge unchanged at
// 0.15.0.
const CB = require('../context-budget');
const cbMsg = (role, content) => ({ role, content });
check('context-budget: estimateTokens divides by the ratio', CB.estimateTokens('hello world', 3) === 4 && CB.estimateTokens('x'.repeat(9000), 3) === 3000);
check('context-budget: calibrateCharsPerToken blends toward the observed ratio and clamps [2,6]',
  CB.calibrateCharsPerToken(3, [{ chars: 4000, actualTokens: 1000 }]) === 3.5
  // The observed ratio is clamped to [2,6] BEFORE blending, so a
  // wild reading can only pull the running value halfway to the
  // clamp: 100/1000 = 0.1 → 2 → (3+2)/2 = 2.5; 12 → 6 → 4.5.
  && CB.calibrateCharsPerToken(3, [{ chars: 100, actualTokens: 1000 }]) === 2.5
  && CB.calibrateCharsPerToken(3, [{ chars: 12000, actualTokens: 1000 }]) === 4.5
  && CB.calibrateCharsPerToken(3, []) === 3);
check('context-budget: outputReserveFor is the configured max, capped at half the window',
  CB.outputReserveFor(4096, 16384) === 4096 && CB.outputReserveFor(4096, null) === 4096
  && CB.outputReserveFor(8192, 8192) === 4096);
check('context-budget: result caps scale with the window (600 @ 8k, 2000 @ 32k)',
  CB.capResultTokens(8192) === 600 && CB.capResultTokens(32768) === 2000
  && CB.capResultTokens(16384) > 600 && CB.capResultTokens(16384) < 2000);
check('context-budget: triggers are none/elide/summarize/drop at u 0.5/0.65/0.8/0.95 (0.9 itself is still summarize — drop needs u > 0.9)',
  CB.compactionAction(0.5) === 'none' && CB.compactionAction(0.65) === 'elide'
  && CB.compactionAction(0.8) === 'summarize' && CB.compactionAction(0.95) === 'drop'
  && CB.compactionAction(0.6) === 'elide' && CB.compactionAction(0.75) === 'summarize' && CB.compactionAction(0.9) === 'summarize');
// isElidableToolResult / elideToolResult take the result TEXT,
// not the message object (compactHistory passes .content).
check('context-budget: isElidableToolResult — reads yes, writes/failed no',
  CB.isElidableToolResult('Tool result — Unity command "readConsole": ok')
  && CB.isElidableToolResult('View Assets/Scripts/Player.cs — lines 1–20 of 40:')
  && CB.isElidableToolResult('Compile check: compile clean')
  && !CB.isElidableToolResult('Tool result — Unity command "set_property": ok')
  && !CB.isElidableToolResult('Tool result — Unity command "readConsole": failed')
  && !CB.isElidableToolResult('please continue'));
check('context-budget: elideToolResult keeps the first line plus a re-run stub',
  CB.elideToolResult('Tool result — Unity command "readConsole": 12 entries\nline two\nline three').includes('[elided')
  && CB.elideToolResult('Tool result — Unity command "readConsole": 12 entries\nline two\nline three').startsWith('Tool result — Unity command "readConsole": 12 entries')
  && CB.elideToolResult('short') === 'short [elided — 5 chars, re-run to see]');
check('context-budget: groupMessages keeps turns atomic and system messages singleton',
  (() => {
    const groups = CB.groupMessages([
      cbMsg('system', 'you are codefox'),
      cbMsg('user', 'make a player'),
      cbMsg('assistant', '```file\n{"path":"Player.cs"}```'),
      cbMsg('user', 'Tool result — File Player.cs: written'),
      cbMsg('user', 'now add health'),
      cbMsg('assistant', 'done'),
    ]);
    // 3 groups: the system singleton, turn 1 (user + assistant +
    // its tool result), turn 2 (user + assistant).
    return groups.length === 3 && groups[0].kind === 'system' && groups[1].messages.length === 3
      && groups[2].messages.length === 2;
  })());
check('context-budget: buildMutationLedger is deterministic, from assistant output only',
  (() => {
    const ledger = CB.buildMutationLedger([
      cbMsg('user', '**File Path:** `Assets/Scripts/UserSaid.cs`'),
      cbMsg('assistant', '**File Path:** `Assets/Scripts/Player.cs`\n```unity-command\n{"action":"set_property","path":"Player","property":"m_Mass"}```'),
      cbMsg('assistant', 'I also made Assets/Scripts/NotCounted.cs in prose — not a file block.'),
    ]);
    return ledger.entries.length === 2 && ledger.entries[0].includes('Player.cs') && ledger.entries[1].includes('set_property');
  })());
check('context-budget: buildWorkingMemoryNote carries goal, done, and failed approaches',
  (() => {
    const note = CB.buildWorkingMemoryNote([
      { messages: [cbMsg('user', 'add a player controller'), cbMsg('assistant', '**File Path:** `Player.cs`')] },
      // Tool results are role "user" in the transcript — that is
      // what isToolResultMessage matches on.
      { messages: [cbMsg('user', 'that broke the build'), cbMsg('user', 'Tool result — Unity command "recompile_and_report_errors": failed: CS1002')] },
    ]);
    return note.includes('Goal: add a player controller') && note.includes('Player.cs')
      && note.includes('Failed approaches') && note.includes('CS1002');
  })());
check('context-budget: compactHistory summarizes a long history and keeps the newest turns',
  (() => {
    const msgs = [];
    for (let t = 0; t < 6; t++) {
      msgs.push(cbMsg('user', 'do thing ' + t + ' ' + 'x'.repeat(200)));
      msgs.push(cbMsg('assistant', 'reply ' + t + ' ' + 'y'.repeat(2000)));
      msgs.push(cbMsg('user', 'Tool result — Unity command "readConsole": ' + 'z'.repeat(3000)));
    }
    const res = CB.compactHistory(msgs, { loadedContext: 8192, outputReserve: 1024, promptTokens: 1000 });
    return res.action === 'summarize' && res.messages.length < msgs.length
      && res.messages.some(m => m.content.includes('[Context note'))
      && res.messages.slice(-3).some(m => m.content.includes('do thing 5'))
      && res.log.groupsSummarized > 0 && res.log.resultsElided > 0;
  })());
check('context-budget: compactHistory never splits a tool call from its result, and never drops system messages',
  (() => {
    // Four big turns: the oldest two are compactable, the newest
    // two are protected. A summarized turn is replaced as a whole
    // by the note — its ```file block and its tool result leave
    // together, so in the output either both are present (the turn
    // survived) or neither is (it was summarized).
    const msgs = [cbMsg('system', 'you are codefox')];
    for (let t = 0; t < 4; t++) {
      msgs.push(cbMsg('user', 'make thing ' + t));
      msgs.push(cbMsg('assistant', '```file\n{"path":"Thing' + t + '.cs"}```\n' + 'x'.repeat(3000)));
      msgs.push(cbMsg('user', 'Tool result — File Thing' + t + '.cs: written'));
    }
    const res = CB.compactHistory(msgs, { loadedContext: 4096, outputReserve: 512, promptTokens: 500 });
    const text = res.messages.map(m => m.content).join('\n');
    const hasCall = text.includes('```file');
    const hasResult = text.includes('Tool result — File');
    return res.messages[0].role === 'system' && hasCall === hasResult
      && res.log.groupsSummarized >= 1 && res.messages.some(m => m.content.includes('[Context note'));
  })());
check('context-budget: compactHistory reports floorHit when only protected turns remain',
  (() => {
    const msgs = [];
    for (let t = 0; t < 10; t++) {
      msgs.push(cbMsg('user', 'q' + t + ' ' + 'x'.repeat(500)));
      msgs.push(cbMsg('assistant', 'a' + t + ' ' + 'y'.repeat(8000)));
    }
    const res = CB.compactHistory(msgs, { loadedContext: 8192, outputReserve: 1024, promptTokens: 1000 });
    return res.log.floorHit === true && res.messages.length >= 4
      && res.messages[res.messages.length - 1].content.includes('a9');
  })());
check('context-budget: buildProjectMap detects URP + new Input System, caps at 1500 tokens',
  (() => {
    const map = CB.buildProjectMap({
      unityVersion: '6000.3.9f1',
      packages: { 'com.unity.render-pipelines.universal': '17.0.0', 'com.unity.inputsystem': '1.7.0' },
      tree: { Assets: 120 },
      scripts: ['Assets/Scripts/Player.cs'],
      scriptCount: 1,
      scenes: [{ path: 'Assets/Scenes/Main.unity', gameObjects: ['Player'] }],
      prefabs: [{ path: 'Assets/Prefabs/Enemy.prefab' }],
    });
    // The cap only bites when the rendered map exceeds ~4500
    // chars, so the big map uses long paths: 60 of them at ~90
    // chars each would blow past the cap, and the list shrinks
    // until it fits.
    const big = CB.buildProjectMap({
      unityVersion: '6000.3.9f1', packages: {}, tree: {},
      scripts: Array.from({ length: 500 }, (_, i) => 'Assets/Scripts/Module01234567890123456789/DeeplyNestedScriptName01234567890123456789_' + i + '.cs'),
      scriptCount: 500, scenes: [], prefabs: [],
    });
    return map.text.includes('Unity 6000.3.9f1') && map.text.includes('Render pipeline: URP')
      && map.text.includes('new Input System') && map.pipeline === 'URP'
      && CB.estimateTokens(big.text, 3) <= 1500 && big.truncated === true && big.scripts.length < 60;
  })());
check('context-budget: diffProjectMap reports added/removed scripts and package changes',
  (() => {
    const a = CB.buildProjectMap({ unityVersion: '1', packages: { 'com.unity.inputsystem': '1.7.0' }, tree: {}, scripts: ['A.cs'], scriptCount: 1, scenes: [], prefabs: [] });
    const b = CB.buildProjectMap({ unityVersion: '2', packages: { 'com.unity.inputsystem': '1.8.0' }, tree: {}, scripts: ['A.cs', 'B.cs'], scriptCount: 2, scenes: [], prefabs: [] });
    const d = CB.diffProjectMap(a, b);
    return d.lines.some(l => l.includes('+') && l.includes('B.cs'))
      && d.lines.some(l => l.includes('com.unity.inputsystem') && l.includes('1.8.0'))
      && d.lines.some(l => l.includes('Unity version'));
  })());
check('context-budget: meterSegments splits the window and sums to the loaded context',
  (() => {
    const m = CB.meterSegments({ systemTokens: 1200, mapTokens: 800, historyTokens: 3000, resultTokens: 1800, loadedContext: 16384, outputReserve: 4096 });
    const total = m.segments.reduce((s, x) => s + x.tokens, 0);
    return m.used === 9096 && m.free === 7288 && total === 16384 && m.known === true
      && m.segments.find(s => s.key === 'results').tokens === 1800;
  })());
check('context-budget: parseStreamMeta reads LM Studio usage and Ollama done counts, nulls otherwise',
  (() => {
    const lm = CB.parseStreamMeta({ usage: { prompt_tokens: 1234 }, choices: [{ finish_reason: 'stop' }] });
    const ol = CB.parseStreamMeta({ prompt_eval_count: 99, done_reason: 'length', done: true });
    const none = CB.parseStreamMeta({ choices: [{ delta: { content: 'hi' } }] });
    return lm.promptTokens === 1234 && lm.finishReason === 'stop'
      && ol.promptTokens === 99 && ol.finishReason === 'length'
      && none.promptTokens === null && none.finishReason === null;
  })());
check('context-budget wiring: every model call goes through messagesForModel; stream meta flows main → preload → renderer',
  appJs.includes('messagesForModel(systemPrompt)') && appJs.includes('messagesForModel(loopState.systemPrompt)')
  && (appJs.match(/messagesForModel\(/g) || []).length >= 4
  && mainJs.includes("stream_options: { include_usage: true }") && mainJs.includes("event.sender.send('llm:stream-meta'")
  && fs.readFileSync(path.join(root, 'preload.js'), 'utf8').includes('onMeta')
  && appJs.includes('noteStreamMeta(streamMeta') && appJs.includes('function newContextBudget')
  && appJs.includes('refreshProjectMapIfDirty()') && appJs.includes('foldPendingProjectMap()')
  && appJs.includes('updateContextMeter()') && appJs.includes('contextBudget: null'));
check('context-budget wiring: meter markup + module script in index.html, module in build.files',
  fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('id="context-meter"')
  && fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('<script src="context-budget.js"></script>')
  && fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('id="ctx-seg-history"')
  && pkg.build.files.includes('context-budget.js')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.19.0 — 2026-11-26'));

// 44. v0.20.0 — Undo + diffs: prefab edits as snapshot-backed
// file transactions, set_property on a prefab object, the
// per-turn ledger with the Undo-agent-turn button, and the diffs
// in the approval bar. Bridge 0.15.0 -> 0.16.0.
const TL = require('../turn-ledger');
check('turn-ledger: createTurnLedger starts empty',
  (() => {
    const l = TL.createTurnLedger('turn-abc');
    return l.turnId === 'turn-abc' && l.snapshots.length === 0 && l.createdAssets.length === 0
      && l.deleteSnapshots.length === 0 && l.prefabEdits.length === 0 && l.sceneWrites === false
      && TL.ledgerHasWork(l) === false;
  })());
check('turn-ledger: isSnapshotRelPath accepts the bridge shape, refuses escapes',
  TL.isSnapshotRelPath('.bridge/snapshots/turn-abc/Assets_Prefabs_X.prefab')
  && !TL.isSnapshotRelPath('.bridge/snapshots/../evil.prefab')
  && !TL.isSnapshotRelPath('Assets/Prefabs/X.prefab')
  && !TL.isSnapshotRelPath('.bridge/inbox/turn-abc/x.json')
  && !TL.isSnapshotRelPath(''));
check('turn-ledger: addSnapshotToLedger records the bridge snapshot, dedupes, refuses a bad path',
  (() => {
    const l = TL.createTurnLedger('t1');
    TL.addSnapshotToLedger(l, { asset: 'Assets/Prefabs/X.prefab', snapshot: '.bridge/snapshots/t1/Assets_Prefabs_X.prefab', hash: 'aa', kind: 'modifyPrefab' });
    TL.addSnapshotToLedger(l, { asset: 'Assets/Prefabs/X.prefab', snapshot: '.bridge/snapshots/t1/Assets_Prefabs_X.prefab', hash: 'aa', kind: 'modifyPrefab' });
    TL.addSnapshotToLedger(l, { asset: 'Assets/Prefabs/Y.prefab', snapshot: 'Assets/Prefabs/Y.prefab', hash: 'bb', kind: 'modifyPrefab' });
    return l.snapshots.length === 1 && l.snapshots[0].asset === 'Assets/Prefabs/X.prefab' && l.snapshots[0].hash === 'aa'
      && TL.ledgerHasWork(l) === true;
  })());
check('turn-ledger: created assets, delete snapshots, prefab edits dedupe; scene writes flag',
  (() => {
    const l = TL.createTurnLedger('t2');
    TL.addCreatedAssetToLedger(l, 'Assets/Prefabs/New.prefab');
    TL.addCreatedAssetToLedger(l, 'Assets/Prefabs/New.prefab');
    TL.addDeleteSnapshotToLedger(l, 'snap-1');
    TL.addDeleteSnapshotToLedger(l, 'snap-1');
    TL.addPrefabEditToLedger(l, 'Assets/Prefabs/X.prefab', 'add child A');
    TL.addPrefabEditToLedger(l, 'Assets/Prefabs/X.prefab', 'add child A; set Image.color');
    TL.noteSceneWrites(l);
    return l.createdAssets.length === 1 && l.deleteSnapshots.length === 1
      && l.prefabEdits.length === 1 && l.prefabEdits[0].summary === 'add child A; set Image.color'
      && l.sceneWrites === true && TL.ledgerHasWork(l) === true;
  })());
check('turn-ledger: ledgerSummaryLines lists prefab edits, created assets, delete snapshots, scene writes',
  (() => {
    const l = TL.createTurnLedger('t3');
    TL.addPrefabEditToLedger(l, 'Assets/Prefabs/X.prefab', 'remove Image');
    TL.addCreatedAssetToLedger(l, 'Assets/Materials/M.mat');
    TL.addDeleteSnapshotToLedger(l, 'snap-2');
    TL.noteSceneWrites(l);
    const lines = TL.ledgerSummaryLines(l);
    return lines.length === 4 && /Prefab Assets\/Prefabs\/X\.prefab — remove Image/.test(lines[0])
      && /1 created asset/.test(lines[1]) && /1 deleted asset snapshot/.test(lines[2])
      && /Scene changes \(one Ctrl\+Z in Unity\)/.test(lines[3]);
  })());
check('turn-ledger: describeLedgerForRevert names every revert step, and the scene-plan refusal',
  (() => {
    const l = TL.createTurnLedger('t4');
    TL.addSnapshotToLedger(l, { asset: 'Assets/Prefabs/X.prefab', snapshot: '.bridge/snapshots/t4/Assets_Prefabs_X.prefab', hash: 'aa', kind: 'modifyPrefab' });
    TL.addCreatedAssetToLedger(l, 'Assets/Prefabs/New.prefab');
    const withScene = TL.describeLedgerForRevert(l, { canRevert: true });
    const refused = TL.describeLedgerForRevert(l, { canRevert: false, reason: 'the undo stack moved on' });
    const empty = TL.describeLedgerForRevert(TL.createTurnLedger('t5'), null);
    return /restore Assets\/Prefabs\/X\.prefab/.test(withScene) && /delete Assets\/Prefabs\/New\.prefab/.test(withScene)
      && /undo the scene changes as one step/.test(withScene)
      && /cannot undo as one step \(the undo stack moved on\)/.test(refused)
      && /Nothing to undo/.test(empty);
  })());
check('bridge 0.16.0: PrefabTransactions + restore_prefab + revert_turn registered',
  bridgeCs.includes('private static class PrefabTransactions')
  && bridgeCs.includes('{ "restore_prefab", (json, args) => PrefabTransactions.RestoreSnapshotAction(json, args) }')
  && bridgeCs.includes('{ "revert_turn", (json, args) => MutationScope.RevertTurn(json, args) }')
  && bridgeCs.includes('public static BridgeResult RevertTurn(string json, Dictionary<string, object> args)')
  && bridgeCs.includes('public static BridgeResult Transact(string assetPath, Dictionary<string, object> args, Func<GameObject, List<string>, EditOutcome> edit)'));
check('bridge 0.16.0: transaction snapshots before touching, saves, always unloads in finally',
  bridgeCs.includes('SnapshotAsset(assetPath, turnId, out snapError)')
  && bridgeCs.includes('PrefabUtility.SaveAsPrefabAsset(contents, assetPath)')
  && bridgeCs.includes('PrefabUtility.UnloadPrefabContents(contents)')
  && bridgeCs.includes('SessionState.SetString(ActiveEditKey, "")')
  && bridgeCs.includes('public static void ClearStaleEdit()')
  && bridgeCs.includes('PrefabUtility.GetPrefabAssetType(go) == PrefabAssetType.NotAPrefab')
  && bridgeCs.includes('PrefabUtility.GetPrefabInstanceStatus(go) != PrefabInstanceStatus.NotAPrefab'));
check('bridge 0.16.0: transaction guards — Prefab Mode, read-only, expectedHash, snapshot-path validation',
  bridgeCs.includes('IsPrefabStageOpen(assetPath)')
  && bridgeCs.includes('AssetDatabase.IsOpenForEdit(assetPath)')
  && bridgeCs.includes("changed since the preview — run the preview again.")
  && bridgeCs.includes("Refused snapshot path '")
  && bridgeCs.includes('public static bool IsSnapshotRelPath(string rel)')
  && bridgeCs.includes('ComputeAssetHash(assetPath)'));
check('bridge 0.16.0: fresh undo group per turn, and the revert refuses when the stack moved on',
  bridgeCs.includes('Undo.IncrementCurrentGroup();\n            int group = Undo.GetCurrentGroup();')
  && bridgeCs.includes('SessionState.SetString(GroupNameKey, "Agent: " + label)')
  && bridgeCs.includes('Undo.RevertAllInCurrentGroup()')
  && bridgeCs.includes('The undo stack moved on since that turn')
  && !/int group = Undo\.GetCurrentGroup\(\);\s*\n\s*if \(group < 0\)/.test(bridgeCs));
check('bridge 0.16.0: modifyPrefab runs through the transaction with ops batching + a summary',
  bridgeCs.includes('PrefabTransactions.Transact(assetPath, cmd, (contents, summary) =>')
  && bridgeCs.includes('JArr(cmd, "ops")')
  && bridgeCs.includes('ApplyPrefabEdits(contents, op, summary)')
  && bridgeCs.includes('private static string ApplyPrefabEdits(GameObject root, Dictionary<string, object> cmd, List<string> summary)')
  && bridgeCs.includes('summary.Add("add child \'')
  && bridgeCs.includes('summary.Add("remove "')
  && bridgeCs.includes('summary.Add("set "'));
check('bridge 0.16.0: set_property prefab scope — staged the same way, applied without Undo, scene refs refused',
  bridgeCs.includes('string prefab = JStr(args, "prefab", "");')
  && bridgeCs.includes('if (!string.IsNullOrEmpty(prefab)) return HandlePrefab(args, prefab, path, dryRun);')
  && bridgeCs.includes('private static BridgeResult HandlePrefab(Dictionary<string, object> args, string prefab, string path, bool dryRun)')
  && bridgeCs.includes('so.ApplyModifiedPropertiesWithoutUndo()')
  && bridgeCs.includes('private static void StageChanges(SerializedObject so, List<object> rawChanges, string resolvedComponent, bool prefabScope, out List<StagedChange> staged, out List<string> problems)')
  && bridgeCs.includes("a prefab cannot reference a scene object")
  && bridgeCs.includes('public static bool TryResolveOn(GameObject go, string componentName, int index, out Component component, out string error)'));
check('bridge 0.16.0: no Newtonsoft anywhere, hand-rolled JSON only',
  !/Newtonsoft/.test(bridgeCs) && !/JsonConvert/.test(bridgeCs) && !/JObject/.test(bridgeCs) && !/JArray/.test(bridgeCs));
check('app 0.20.0: modifyPrefab joins the dry-run approval flow with the hash guard; prefab set_property skips scene-path rewriting',
  appJs.includes("const SCENE_WRITE_ACTIONS = ['set_property', 'create_gameobject', 'add_component', 'set_parent', 'delete_gameobject', 'modifyPrefab'];")
  && appJs.includes("if (SCENE_PATH_ACTIONS.indexOf(label) !== -1 && !action.command.prefab)")
  && appJs.includes("if ((label === 'modifyPrefab' || (label === 'set_property' && action.command.prefab)) && preview.data && preview.data.assetHash)")
  && appJs.includes('realCmd.expectedHash = preview.data.assetHash;'));
check('app 0.20.0: the turn ledger is recorded on success and cleared when a new turn starts',
  appJs.includes('recordTurnLedgerEntry(label, action.command, res, deleteSnapshot)')
  && appJs.includes('function recordTurnLedgerEntry(label, command, res, deleteSnapshot)')
  && appJs.includes('TL.addSnapshotToLedger(ledger, {')
  && appJs.includes('TL.addCreatedAssetToLedger(ledger, res.path)')
  && appJs.includes('state.lastTurnLedger = null;')
  && appJs.includes('lastTurnLedger: null,'));
check('app 0.20.0: Agent Turn sidebar section + undo flow + turn-revert bar',
  appJs.includes("renderAgentTurnSection()")
  && appJs.includes("document.getElementById('agent-turn-list')")
  && appJs.includes('async function undoAgentTurn()')
  && appJs.includes("command: { action: 'revert_turn', turnId: ledger.turnId, dryRun: true }")
  && appJs.includes("command: { action: 'restore_prefab', snapshot: snap.snapshot, asset: snap.asset, expectedHash: snap.hash || '' }")
  && appJs.includes('async function revertTurnLedger(ledger, scenePlan)')
  && appJs.includes("function showTurnRevertBar(plan, cb)")
  && appJs.includes("bar.id = 'turn-revert-bar';"));
check('app 0.20.0: approval-bar labels show the prefab diff and the prefab scope',
  appJs.includes("if (label === 'modifyPrefab') {")
  && appJs.includes("const summary = (d.summary || []).slice(0, 3);")
  && appJs.includes("const where = command.prefab ? ((command.prefab || '?') + ' / ' + (command.path || '?')) : (command.path || '?');")
  && appJs.includes("if (label === 'modifyPrefab') return 'modifyPrefab ' + (command.path || '?') + ' (nothing changed).';"));
check('app 0.20.0: prompt documents the prefab transaction, ops batching, and the turn undo',
  appJs.includes('Several edits to one prefab go in one call as')
  && appJs.includes('never try to undo a prefab edit yourself with Ctrl+Z')
  && appJs.includes('pass \\"prefab\\": \\"Assets/Prefabs/….prefab\\" to set a property on an object inside a prefab asset instead')
  && appJs.includes('Scene and prefab writes (set_property, create_gameobject, add_component, set_parent, delete_gameobject, modifyPrefab) are previewed'));
check('v0.20.0 wiring: turn-ledger script + Agent Turn section in index.html, module in build.files, docs',
  fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('<script src="turn-ledger.js"></script>')
  && fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('id="agent-turn-list"')
  && pkg.build.files.includes('turn-ledger.js')
  && readme.includes('Undo agent turn')
  && readme.includes('modifyPrefab')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.20.0 — 2026-11-26'));

// 45. v0.21.0 — docs search + per-model profiles + MCP server:
// BM25 over real ScriptReference pages, the minimal ZIP reader
// (a hand-built zip, not the 470 MB archive), profile routing,
// the swap state machine, the MCP tool list with deny-by-default,
// and the wiring (version pins, script tags, IPCs, prompt
// sections). Bridge unchanged at 0.16.0.
const DS = require('../docs-search');
const DE = require('../docs-engine');
const MP = require('../model-profiles');
const MCP = require('../mcp-server/server');
check('docs-search: tokenize splits camelCase and keeps the whole token',
  JSON.stringify(DS.tokenize('TransformPoint')) === JSON.stringify(['transformpoint', 'transform', 'point'])
  && DS.tokenize('the Rigidbody velocity').includes('rigidbody')
  && !DS.tokenize('the and of').length);
check('docs-search: parseUnityVersion takes the major.minor pair',
  DS.parseUnityVersion('6000.3.9f1') === '6000.3'
  && DS.parseUnityVersion('2022.3.5f1') === '2022.3'
  && DS.parseUnityVersion('not-a-version') === null);
check('docs-search: docsZipUrl is the official offline-docs archive',
  DS.docsZipUrl('6000.3.9f1') === 'https://cloudmedia-docs.unity3d.com/docscloudstorage/en/6000.3/UnityDocumentation.zip'
  && DS.docsZipUrl('junk') === null);
check('docs-search: extractDocText finds the article in a real ScriptReference page',
  (() => {
    const html = fs.readFileSync(path.join(root, 'test', 'fixtures', 'unity-docs', 'Transform.TransformPoint.html'), 'utf8');
    const doc = DS.extractDocText(html, 'Documentation/en/ScriptReference/Transform.TransformPoint.html');
    return doc.id === 'Transform.TransformPoint' && doc.title === 'Transform.TransformPoint'
      && doc.text.length > 1000 && doc.text.includes('TransformPoint')
      && !doc.text.includes('MuiTreeItem');
  })());
const fixtureDocs = ['Transform.TransformPoint', 'Rigidbody', 'Vector3', 'Quaternion'].map((id) => {
  const html = fs.readFileSync(path.join(root, 'test', 'fixtures', 'unity-docs', id + '.html'), 'utf8');
  return DS.extractDocText(html, 'Documentation/en/ScriptReference/' + id + '.html');
});
const fixtureIndex = DS.buildIndex(fixtureDocs);
check('docs-search: BM25 ranks the exact API page first on real pages',
  DS.search(fixtureIndex, 'TransformPoint')[0].id === 'Transform.TransformPoint'
  && DS.search(fixtureIndex, 'rigidbody velocity')[0].id === 'Rigidbody'
  && DS.search(fixtureIndex, 'quaternion euler angles')[0].id === 'Quaternion'
  && DS.search(fixtureIndex, 'vector3 magnitude')[0].id === 'Vector3'
  && DS.search(fixtureIndex, 'zzz-no-such-term').length === 0
  && DS.search(fixtureIndex, '').length === 0);
check('docs-search: snippets come from the page lead, not invented text',
  DS.search(fixtureIndex, 'TransformPoint')[0].snippet.length > 0
  && DS.search(fixtureIndex, 'TransformPoint')[0].snippet.length <= 300
  && DS.search(fixtureIndex, 'TransformPoint')[0].snippet.includes('local space'));
check('docs-search: extractDocText cuts the offline archive feedback form out of the text',
  (() => {
    const html = '<html><body><article><h1>TransformPoint</h1><p>Transform .TransformPoint Leave feedback Suggest a change Success! Thank you for helping us improve the quality of Unity Documentation. Although we cannot accept all submissions, we do read each suggested change from our users and will make updates where applicable. Close Submission failed For some reason your suggested change could not be submitted. Please try again in a few minutes. And thank you for taking the time to help us improve the quality of Unity Documentation. Close Your name Your email Suggestion * Submit suggestion Cancel Switch to Manual Declaration public Vector3 TransformPoint ( Vector3 position ); Description Transforms position from local space to world space.</p></article></body></html>';
    const doc = DS.extractDocText(html, 'Documentation/en/ScriptReference/Transform.TransformPoint.html');
    return !doc.text.includes('Leave feedback') && !doc.text.includes('Switch to Manual')
      && doc.text.includes('Transforms position from local space to world space')
      && doc.lead.includes('Declaration');
  })());
// The minimal ZIP reader, tested against a zip built by hand in
// the test (one stored entry, one deflated entry) — no 470 MB
// archive, no zip dependency.
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function testCrc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function buildTestZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data, 'utf8');
    const stored = e.method === 0 ? data : zlib.deflateRawSync(data);
    const crc = testCrc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(stored.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([lh, name, stored]));
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(stored.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cd, name]));
    offset += lh.length + name.length + stored.length;
  }
  const cdStart = offset;
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}
const testZipPath = path.join(os.tmpdir(), 'codefox-test-docs-' + process.pid + '.zip');
fs.writeFileSync(testZipPath, buildTestZip([
  { name: 'Documentation/en/ScriptReference/Transform.TransformPoint.html', method: 8, data: '<html><head><title>x</title></head><body><article><h1>TransformPoint</h1><p>Transforms position from local space to world space.</p></article></body></html>' },
  { name: 'Documentation/en/ScriptReference/Rigidbody.html', method: 0, data: '<html><body><article><h1>Rigidbody</h1><p>Control of an object\'s position through physics simulation.</p></article></body></html>' },
  { name: 'Documentation/en/Manual/Physics.html', method: 8, data: '<html><body><p>Manual page — not a ScriptReference entry.</p></body></html>' },
]));
const zipEntries = DE.listZipEntries(testZipPath);
check('docs-engine: minimal ZIP reader lists entries with methods and offsets',
  zipEntries.length === 3
  && zipEntries[0].name === 'Documentation/en/ScriptReference/Transform.TransformPoint.html' && zipEntries[0].method === 8
  && zipEntries[1].method === 0);
check('docs-engine: readZipEntry inflates deflated entries and passes stored ones through',
  DE.readZipEntry(testZipPath, zipEntries[0]).toString('utf8').includes('Transforms position from local space')
  && DE.readZipEntry(testZipPath, zipEntries[1]).toString('utf8').includes('physics simulation'));
const zipIndex = DE.buildIndexFromZip(testZipPath, '6000.3');
check('docs-engine: buildIndexFromZip indexes only ScriptReference pages and searches them',
  zipIndex.totalDocs === 2 && zipIndex.unityVersion === '6000.3'
  && DS.search(zipIndex, 'transformpoint')[0].id === 'Transform.TransformPoint'
  && DS.search(zipIndex, 'rigidbody')[0].id === 'Rigidbody');
fs.unlinkSync(testZipPath);
check('model-profiles: default profiles carry the tuned load settings',
  (() => {
    const p = MP.defaultCoderProfile('qwen3-coder-30b');
    return p.id === 'primary' && p.lmStudioKey === 'qwen3-coder-30b'
      && p.load.kvCacheQuant === 'q8_0' && p.load.parallel === 1 && p.load.offloadRatio === 1
      && p.load.contextLength === 16384 && p.load.evalBatch === 512 && p.load.flashAttention === true
      && p.sampling.temperature === 0.2 && p.sampling.chatTemperature === 0.7;
  })());
check('model-profiles: validateProfile catches a missing model key and a bad context',
  MP.validateProfile(MP.createProfile({ id: 'vision', lmStudioKey: '' })).length > 0
  && MP.validateProfile(MP.createProfile({ id: 'vision', lmStudioKey: 'x', load: { contextLength: 0 } })).length > 0
  && MP.validateProfile(MP.createProfile({ id: 'vision', lmStudioKey: 'x' })).length === 0);
check('model-profiles: routeVision prefers a vision-capable primary, then the vision profile, then none',
  (() => {
    const primaryVision = MP.createProfile({ id: 'primary', lmStudioKey: 'coder-vision', capabilities: { vision: true } });
    const primaryPlain = MP.createProfile({ id: 'primary', lmStudioKey: 'coder', capabilities: { vision: false } });
    const vision = MP.createProfile({ id: 'vision', lmStudioKey: 'qwen2-vl' });
    const a = MP.routeVision({ primary: primaryVision, vision });
    const b = MP.routeVision({ primary: primaryPlain, vision });
    const c = MP.routeVision({ primary: primaryPlain, vision: null });
    return a.kind === 'primary' && a.swap === false
      && b.kind === 'swap' && b.swap === true && b.profile.lmStudioKey === 'qwen2-vl'
      && c.kind === 'none' && /No vision model/.test(c.reason);
  })());
check('model-profiles: swap cost is load time plus prompt time, measured beats default',
  MP.estimateSwapCost(MP.createProfile({}), 0).seconds === 30
  && MP.estimateSwapCost(MP.createProfile({ measured: { loadSeconds: 12, promptTokensPerSecond: 40 } }), 400).seconds === 22);
check('model-profiles: the state machine allows the swap sequence and refuses a busy unload',
  (() => {
    let s = { state: 'ready', current: 'coder', busy: false };
    const step = (ev, id) => { const r = MP.modelTransition(s, ev, id); if (r.ok) s = r.state; return r; };
    const ok1 = step('unload-start').ok && s.state === 'unloading';
    const ok2 = step('unload-ok').ok && s.state === 'unloaded' && s.current === null;
    const ok3 = step('load-start', 'vision').ok && s.state === 'loading';
    const ok4 = step('load-ok', 'vision').ok && s.state === 'ready' && s.current === 'vision';
    const ok5 = step('busy').ok && s.state === 'busy';
    const bad = step('unload-start');
    const ok6 = !bad.ok && /busy/.test(bad.error) && s.state === 'busy';
    const ok7 = step('free').ok && s.state === 'ready';
    const bad2 = step('load-start', 'x');
    return ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && !bad2.ok;
  })());
check('model-profiles: parseVisionResult structures bullets and never invents findings',
  (() => {
    const r = MP.parseVisionResult('Matches:\n- player sprite is visible\n- facing right\nIssues:\n- the health bar is cut off');
    const plain = MP.parseVisionResult('The sprite looks fine, nothing wrong here.');
    return r.matches.length === 2 && r.issues.length === 1 && r.raw.length > 0
      && plain.matches.length === 0 && plain.issues.length === 0 && plain.raw.includes('sprite looks fine');
  })());
check('model-profiles: stripImagesFromHistory removes image parts and keeps text',
  (() => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }] },
      { role: 'assistant', content: 'plain string stays' },
    ];
    const out = MP.stripImagesFromHistory(msgs);
    return out[0].content.every(p => p.type !== 'image_url') && out[0].content.some(p => /image removed/.test(p.text))
      && out[1].content === 'plain string stays';
  })());
check('mcp-server: the tool list has the read tools and the denied mutating ones',
  MCP.TOOLS.map(t => t.name).join(',') === 'docs_search,file_view,file_grep,git_status,git_diff,git_log,unity_command,file_str_replace,comfyui_generate'
  && MCP.TOOLS.filter(t => t.kind === 'mutating').map(t => t.name).join(',') === 'file_str_replace,comfyui_generate'
  && MCP.TOOLS.find(t => t.name === 'unity_command').kind === 'gated');
check('mcp-server: classifyUnityAction allows reads and denies writes',
  MCP.classifyUnityAction('list_hierarchy') === 'read'
  && MCP.classifyUnityAction('describeComponent') === 'read'
  && MCP.classifyUnityAction('readConsole') === 'read'
  && MCP.classifyUnityAction('createPrefab') === 'mutating'
  && MCP.classifyUnityAction('set_property') === 'mutating'
  && MCP.classifyUnityAction('recompile_and_report_errors') === 'mutating');
check('v0.21.0 wiring: version pins, script tags, IPCs, prompt sections, migration',
  pkg.version === '0.21.2'
  && fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('CodeFox 0.21.2 — Local')
  && fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('<script src="docs-search.js"></script>')
  && fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('<script src="model-profiles.js"></script>')
  && pkg.build.files.includes('docs-search.js')
  && pkg.build.files.includes('model-profiles.js')
  && pkg.build.files.includes('docs-engine.js')
  && pkg.build.files.includes('mcp-server/**/*')
  && Array.isArray(pkg.build.asarUnpack) && pkg.build.asarUnpack.includes('mcp-server/**/*')
  && typeof pkg.scripts.mcp === 'string' && pkg.scripts.mcp.includes('mcp-server/server.js')
  && fs.readFileSync(path.join(root, 'main.js'), 'utf8').includes("ipcMain.handle('docs:search'")
  && fs.readFileSync(path.join(root, 'main.js'), 'utf8').includes("ipcMain.handle('llm:visionChat'")
  && fs.readFileSync(path.join(root, 'main.js'), 'utf8').includes("ipcMain.handle('mcp:serverInfo'")
  && fs.readFileSync(path.join(root, 'main.js'), 'utf8').includes('ALTER TABLE messages ADD COLUMN model TEXT')
  && fs.readFileSync(path.join(root, 'preload.js'), 'utf8').includes('visionChat:')
  && fs.readFileSync(path.join(root, 'preload.js'), 'utf8').includes('serverInfo:')
  && fs.readFileSync(path.join(root, 'app.js'), 'utf8').includes('## Unity docs — search before you guess')
  && fs.readFileSync(path.join(root, 'app.js'), 'utf8').includes('## Seeing the game — vision as a tool')
  && fs.readFileSync(path.join(root, 'app.js'), 'utf8').includes('parseDocsBlocks')
  && fs.readFileSync(path.join(root, 'app.js'), 'utf8').includes('parseVisionBlocks')
  && fs.readFileSync(path.join(root, 'app.js'), 'utf8').includes('restoreCoderAfterVision')
  && fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes('Unity docs')
  && fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('## 0.21.0 — 2026-11-26'));
check('v0.21.2 wiring: bridge is 0.16.2 (the API fixes), not 0.17.0',
  fs.readFileSync(path.join(root, 'unity-bridge.js'), 'utf8').includes("BUNDLED_BRIDGE_VERSION = '0.16.2'")
  && !/0\.17\.0/.test(fs.readFileSync(path.join(root, 'unity-bridge.js'), 'utf8')));

(async () => {
  // v0.14.0 runner: runUnityCommand against an injected fs and
  // clock — no Unity, no real waiting. The fake clock advances
  // only when the fake sleep runs, so every wait is deterministic
  // and fast in real time. Own try/catch so a failure is labelled
  // as the runner, not the mock ComfyUI server below.
  try {
    const uc = require(path.join(root, 'unity-command.js'));
    // In-memory fs. The fake bridge answers when a command lands
    // in the inbox: onInbox(id) returns the outbox JSON (or null
    // for no answer). After the app reads a pending result, the
    // fake bridge writes the final one in its place.
    function makeBridgeFs(seed, onInbox) {
      const store = new Map(Object.entries(seed || {}));
      return {
        store,
        existsSync: (p) => store.has(p),
        readFileSync: (p) => {
          if (!store.has(p)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; }
          return store.get(p);
        },
        writeFileSync: (p, data) => { store.set(p, String(data)); },
        renameSync: (from, to) => {
          store.set(to, store.get(from)); store.delete(from);
          if (to.includes('inbox') && to.endsWith('.json') && onInbox) {
            const id = path.basename(to, '.json');
            const out = onInbox(id);
            if (out != null) store.set(path.join('/proj', '.bridge', 'outbox', id + '.json'), out);
          }
        },
        unlinkSync: (p) => {
          const cur = store.get(p);
          if (cur && p.includes('outbox')) {
            try {
              const parsed = JSON.parse(cur);
              if (parsed.status === 'pending') {
                store.set(p, JSON.stringify({ protocol: 1, requestId: parsed.requestId, status: 'ok', message: 'done', data: { ok: true } }));
                return;
              }
            } catch (e) { /* fall through to delete */ }
          }
          store.delete(p);
        },
        mkdirSync: () => {},
      };
    }
    let fakeNow = 1000000;
    const fakeSleep = async (ms) => { fakeNow += ms; };
    const now = () => fakeNow;
    const baseOpts = { sleep: fakeSleep, now, pollMs: 1, bridgeInstalled: () => true, getInstalledVersion: () => '0.12.0' };
    const heartbeatSeed = () => ({ '/proj/.bridge/heartbeat.json': JSON.stringify({ protocol: 1, timeMs: fakeNow, isCompiling: false, isPlaying: false }) });

    const rMissing = await uc.runUnityCommand('/proj', { action: 'refresh' }, { ...baseOpts, fs: makeBridgeFs(), bridgeInstalled: () => false });
    check('runner refuses a missing bridge', rMissing.ok === false && rMissing.error.includes('not installed'));
    const rOld = await uc.runUnityCommand('/proj', { action: 'refresh' }, { ...baseOpts, fs: makeBridgeFs(), getInstalledVersion: () => '0.11.0' });
    check('runner refuses an old bridge (never sends inbox commands to it)', rOld.ok === false && rOld.error.includes('older CodeFox'));
    const rNoHb = await uc.runUnityCommand('/proj', { action: 'refresh' }, { ...baseOpts, fs: makeBridgeFs(), heartbeatWaitMs: 100 });
    check('runner fails fast with no heartbeat', rNoHb.ok === false && rNoHb.error.includes('not responding'));

    const fOk = makeBridgeFs(heartbeatSeed(), (id) => JSON.stringify({ protocol: 1, requestId: id, status: 'ok', message: 'done', data: { ok: true } }));
    const rOk = await uc.runUnityCommand('/proj', { action: 'refresh' }, { ...baseOpts, fs: fOk });
    check('runner delivers an ok result, inbox written via .tmp then rename with protocol 1, outbox deleted after reading',
      rOk.ok === true && rOk.message === 'done' && rOk.data && rOk.data.ok === true
      && [...fOk.store.keys()].some(k => k.includes('/inbox/') && k.endsWith('.json'))
      && ![...fOk.store.keys()].some(k => k.endsWith('.tmp'))
      && ![...fOk.store.keys()].some(k => k.includes('/outbox/'))
      && (() => {
        const inboxKey = [...fOk.store.keys()].find(k => k.includes('/inbox/') && k.endsWith('.json'));
        const body = JSON.parse(fOk.store.get(inboxKey));
        return body.protocol === 1 && body.requestId === path.basename(inboxKey, '.json') && body.action === 'refresh';
      })());

    const fPend = makeBridgeFs(heartbeatSeed(), (id) => JSON.stringify({ protocol: 1, requestId: id, status: 'pending', message: 'compiling' }));
    const rPend = await uc.runUnityCommand('/proj', { action: 'recompile_and_report_errors' }, { ...baseOpts, fs: fPend, timeoutMs: 5000 });
    check('runner treats pending as alive and returns the final result',
      rPend.ok === true && rPend.message === 'done' && ![...fPend.store.keys()].some(k => k.includes('/outbox/')));

    const fErr = makeBridgeFs(heartbeatSeed(), (id) => JSON.stringify({ protocol: 1, requestId: id, status: 'error', message: "Unknown component type 'Nope'. Use listComponentTypes to see what this Unity install has." }));
    const rErr = await uc.runUnityCommand('/proj', { action: 'createPrefab', name: 'X' }, { ...baseOpts, fs: fErr });
    check('runner returns a bridge failure as a plain error',
      rErr.ok === false && /Unknown component type 'Nope'/.test(rErr.error || ''));
    const fBad = makeBridgeFs(heartbeatSeed(), () => 'this is not json{');
    const rBad = await uc.runUnityCommand('/proj', { action: 'refresh' }, { ...baseOpts, fs: fBad });
    check('runner returns a malformed result as a plain unreadable-result error',
      rBad.ok === false && /could not read/.test(rBad.error || ''));

    const fStale = makeBridgeFs(heartbeatSeed(), null);
    const rStale = await uc.runUnityCommand('/proj', { action: 'refresh' }, { ...baseOpts, fs: fStale, timeoutMs: 60000 });
    check('runner fails fast when the heartbeat goes stale mid-command',
      rStale.ok === false && rStale.error.includes('stopped responding'));
  } catch (e) {
    check('bridge runner tests ran without throwing', false, String(e && e.message));
  }

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
    // v0.17.0 — real cancel: queued prompts are deleted from the
    // queue, running ones are interrupted, and a prompt that is
    // in neither list is already done (nothing to cancel).
    const cancelPending = await comfy.cancelPrompt(base, 'mock-prompt-pending');
    check('mock server: cancel deletes a queued prompt from /queue',
      cancelPending.ok === true && cancelPending.action === 'deleted');
    const cancelRunning = await comfy.cancelPrompt(base, 'mock-prompt-running');
    check('mock server: cancel interrupts a running prompt',
      cancelRunning.ok === true && cancelRunning.action === 'interrupted');
    const cancelGone = await comfy.cancelPrompt(base, 'mock-prompt-gone');
    check('mock server: cancel of a finished prompt is already-done, not an error',
      cancelGone.ok === true && cancelGone.action === 'already-done');
    const freed = await comfy.freeComfyuiMemory(base);
    check('mock server: /free unloads models and frees memory',
      freed.ok === true);
    // v0.17.0 — LM Studio unload: the instance_id from the loaded
    // list is what gets unloaded, and the verify step must see it
    // gone afterwards.
    {
      const calls = [];
      let loadedNow = true;
      const stub = async (url, opts) => {
        calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
        if (url.endsWith('/api/v1/models') && (!opts || !opts.method || opts.method === 'GET')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ models: [{ key: 'qwen/qwen3-coder-30b-a3b-instruct', loaded_instances: loadedNow ? [{ id: 'qwen/qwen3-coder-30b-a3b-instruct' }] : [] }] }) };
        }
        if (url.endsWith('/api/v1/models/unload')) {
          loadedNow = false;
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
        }
        return { ok: false, status: 404, text: async () => '' };
      };
      const un = await lmLoad.unloadLmStudioModel({ modelId: 'qwen/qwen3-coder-30b-a3b-instruct', baseUrl: 'http://localhost:1234', fetchImpl: stub });
      const unloadCall = calls.find(c => c.url.endsWith('/api/v1/models/unload'));
      check('unload flow: instance_id from the loaded list is unloaded, verified gone',
        un.ok === true && un.unloaded === true
        && unloadCall && unloadCall.body.instance_id === 'qwen/qwen3-coder-30b-a3b-instruct');
      const already = await lmLoad.unloadLmStudioModel({ modelId: 'qwen/qwen3-coder-30b-a3b-instruct', baseUrl: 'http://localhost:1234', fetchImpl: stub });
      check('unload flow: an already-unloaded model is a success, not an error',
        already.ok === true && already.alreadyUnloaded === true);
    }
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
  // v0.8.4 — Inkwell-aligned LM Studio calls: load state from the
  // native list (v1, then v0, then the compat list), the context
  // cap, and plain connection-failure wording. /v1/models alone
  // cannot prove a model is loaded — with Just-In-Time loading on
  // it may list downloaded models too (LM Studio docs:
  // https://www.lmstudio.ai/docs/developer/openai-compat/models).
  {
    const v1Body = (loaded) => JSON.stringify({ models: [{
      key: 'qwen/qwen3-coder-30b-a3b-instruct', type: 'llm',
      display_name: 'Qwen3 Coder 30B A3B Instruct',
      quantization: { name: 'q4_k_m' }, params_string: '30B', size_bytes: 19000000000,
      format: 'gguf', selected_variant: 'qwen/qwen3-coder-30b-a3b-instruct@q4_k_m',
      max_context_length: 262144,
      loaded_instances: loaded ? [{ id: 'qwen/qwen3-coder-30b-a3b-instruct', config: { context_length: 16384 } }] : [],
    }, {
      key: 'nomic-ai/nomic-embed-text-v1.5', type: 'embedding',
      display_name: 'Nomic Embed', loaded_instances: [],
    }] });
    const compatBody = JSON.stringify({ data: [{ id: 'qwen/qwen3-coder-30b-a3b-instruct' }] });
    const makeNativeStub = (mode) => async (url, opts) => {
      if (url.endsWith('/api/v1/models')) {
        if (mode === 'v1-not-loaded') return { ok: true, status: 200, text: async () => v1Body(false) };
        if (mode === 'v1-loaded') return { ok: true, status: 200, text: async () => v1Body(true) };
        return { ok: false, status: 404, text: async () => '' }; // v0 / compat modes: no v1 endpoint
      }
      if (url.endsWith('/api/v0/models')) {
        if (mode === 'v0') return { ok: true, status: 200, text: async () => JSON.stringify({ object: 'list', data: [
          { id: 'qwen/qwen3-coder-30b-a3b-instruct', object: 'model', type: 'llm', publisher: 'qwen', arch: 'qwen3', compatibility_type: 'gguf', quantization: 'q4_k_m', state: 'loaded', max_context_length: 262144, loaded_context_length: 8192 },
          { id: 'google/gemma-3-4b-it', object: 'model', type: 'llm', publisher: 'google', arch: 'gemma3', compatibility_type: 'gguf', quantization: 'q4_k_m', state: 'not-loaded', max_context_length: 131072, loaded_context_length: null },
          { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model', type: 'embeddings', publisher: 'nomic-ai', arch: 'nomic-bert', compatibility_type: 'gguf', quantization: 'f16', state: 'not-loaded', max_context_length: 2048, loaded_context_length: null },
        ] }) };
        return { ok: false, status: 404, text: async () => '' }; // compat mode: no v0 endpoint
      }
      if (url.endsWith('/v1/models')) return { ok: true, status: 200, text: async () => compatBody };
      return { ok: false, status: 404, text: async () => '' };
    };
    // (a) A model in /v1/models with empty loaded_instances is NOT loaded.
    const notLoaded = await lmLoad.listNativeLmStudioModels({ baseUrl: 'http://localhost:1234', fetchImpl: makeNativeStub('v1-not-loaded') });
    const notLoadedState = lmLoad.loadedContextForModel(notLoaded.models, 'qwen/qwen3-coder-30b-a3b-instruct');
    check('verify logic: a model present in /v1/models but absent from loaded_instances is NOT loaded',
      notLoaded.ok === true && notLoaded.source === 'v1' && notLoaded.downloadedList === true
      && notLoadedState.found === true && notLoadedState.loaded === false && notLoadedState.loadedContextLength === null
      && mainJs.includes("listNativeLmStudioModels") && mainJs.includes('is downloaded but not loaded — load it in Settings')
      && !mainJs.includes('which only lists loaded ones'));
    // (a2) Same model, loaded: loaded with its served context.
    const loaded = await lmLoad.listNativeLmStudioModels({ baseUrl: 'http://localhost:1234', fetchImpl: makeNativeStub('v1-loaded') });
    const loadedState = lmLoad.loadedContextForModel(loaded.models, 'qwen/qwen3-coder-30b-a3b-instruct');
    check('native list: a loaded model reports loaded with its served context, embeddings filtered',
      loaded.ok === true && loadedState.found === true && loadedState.loaded === true && loadedState.loadedContextLength === 16384
      && !loaded.models.some(m => m.id.includes('nomic-embed')));
    // (b) v0 fallback when /api/v1/models 404s.
    const v0 = await lmLoad.listNativeLmStudioModels({ baseUrl: 'http://localhost:1234', fetchImpl: makeNativeStub('v0') });
    const v0Qwen = lmLoad.loadedContextForModel(v0.models, 'qwen/qwen3-coder-30b-a3b-instruct');
    const v0Gemma = lmLoad.loadedContextForModel(v0.models, 'google/gemma-3-4b-it');
    check('listDownloaded falls back to /api/v0/models when /api/v1/models 404s (state + loaded context mapped)',
      v0.ok === true && v0.source === 'v0' && v0.downloadedList === true
      && v0Qwen.found === true && v0Qwen.loaded === true && v0Qwen.loadedContextLength === 8192
      && v0Gemma.found === true && v0Gemma.loaded === false && v0Gemma.loadedContextLength === null
      && !v0.models.some(m => m.id.includes('nomic-embed')));
    // (b2) Compat fallback when neither native endpoint exists.
    const compat = await lmLoad.listNativeLmStudioModels({ baseUrl: 'http://localhost:1234', fetchImpl: makeNativeStub('compat') });
    const compatState = lmLoad.loadedContextForModel(compat.models, 'qwen/qwen3-coder-30b-a3b-instruct');
    check('native list falls back to the loaded-only /v1/models list with unknown context',
      compat.ok === true && compat.source === 'compat' && compat.downloadedList === false
      && compatState.found === true && compatState.loaded === true && compatState.loadedContextLength === null);
    // (c) The context cap math (Inkwell's budget pattern).
    check('context cap: min(configured, half the loaded window); unknown context falls back to 4096',
      lmLoad.effectiveMaxTokens(4096, 16384) === 4096
      && lmLoad.effectiveMaxTokens(4096, 4096) === 2048
      && lmLoad.effectiveMaxTokens(4096, null) === 4096
      && lmLoad.effectiveMaxTokens(4096, undefined) === 4096
      && lmLoad.effectiveMaxTokens(8192, 16384) === 8192
      && lmLoad.effectiveMaxTokens(1024, null) === 1024);
    // (d) Connection failures use Inkwell's plain wording, not a raw error.
    const down = await lmLoad.listNativeLmStudioModels({ baseUrl: 'http://localhost:1234', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    check('native list: an unreachable server fails with Inkwell\u2019s plain wording',
      down.ok === false && /Can't reach LM Studio at http:\/\/localhost:1234/.test(down.error || '')
      && /Start the local server in LM Studio/.test(down.error || ''));
    check('main.js uses the plain unreachable wording in the model list and chat paths',
      mainJs.includes('lmStudioConnectionError') && mainJs.includes('listNativeLmStudioModels'));
    // (e) The tuned loading flow is untouched — the load body still
    // comes only from the global defaults.
    check('tuned loading untouched: load body still built only from the global defaults',
      lmLoad.buildLoadBody('qwen/qwen3-coder-30b-a3b-instruct').context_length === 16384
      && lmLoad.buildLoadBody('qwen/qwen3-coder-30b-a3b-instruct').eval_batch_size === 512
      && lmLoad.buildLoadBody('qwen/qwen3-coder-30b-a3b-instruct').flash_attention === true);
    check('Settings shows the loaded context line and verify/status expose it',
      appJs.includes('s-lm-context') && appJs.includes('Loaded context: ')
      && appJs.includes('function updateLoadedContextLine')
      && mainJs.includes('loadedContextLength') && mainJs.includes('loadState') && mainJs.includes("'not-loaded'"));
  }
  // v0.14.0 — the unity:command runner tests moved to the top of
  // this async block: the single-file protocol (Assets/.codefox-
  // command.json / .codefox-result.json) is gone, and the runner
  // is now tested against the .bridge/ transport (inbox/outbox/
  // heartbeat) with an injected fs and clock.
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
  // v0.9.3 — deleteAsset snapshot (async helper; extractFunction
  // drops the `async` keyword, so re-add it). Stubbed rb/state.
  try {
    const snapSrcA = extractFunction(appJs, 'snapshotForDelete');
    const resolveSrcA = extractFunction(appJs, 'resolvePath');
    if (!snapSrcA || !resolveSrcA) throw new Error('snapshotForDelete or resolvePath not extractable');
    const inserts = [];
    const snapshotForDelete = new Function('rb', 'state', 'navigator', 'async ' + snapSrcA + '\n' + resolveSrcA + '\nreturn snapshotForDelete;')(
      {
        fs: {
          readFile: async (p) => {
            if (p.endsWith('.meta')) return p.includes('NoMeta') ? { ok: false, error: 'ENOENT' } : { ok: true, content: 'META-CONTENT' };
            return p.includes('Missing') ? { ok: false, error: 'ENOENT' } : { ok: true, content: 'PREFAB-CONTENT' };
          },
        },
        db: { insert: async (table, row) => { inserts.push({ table, row }); } },
      },
      { projectPath: 'C:\\TD Pizza Racer' },
      { platform: 'Win32' });
    inserts.length = 0;
    const snapOk = await snapshotForDelete('Assets/Prefabs/ImageContainer.prefab');
    check('snapshotForDelete backs up the asset and its .meta before a delete',
      snapOk.ok === true && snapOk.snapshotId.startsWith('snap_') && snapOk.backedUp === 2
      && inserts.filter(i => i.table === 'file_backups').length === 2
      && inserts.some(i => i.table === 'file_backups' && i.row.file_path === 'C:\\TD Pizza Racer\\Assets\\Prefabs\\ImageContainer.prefab' && i.row.content === 'PREFAB-CONTENT')
      && inserts.some(i => i.table === 'file_backups' && i.row.file_path === 'C:\\TD Pizza Racer\\Assets\\Prefabs\\ImageContainer.prefab.meta' && i.row.content === 'META-CONTENT')
      && inserts.some(i => i.table === 'snapshots' && i.row.id === snapOk.snapshotId && i.row.label === 'Delete ImageContainer.prefab' && i.row.file_count === 2));
    inserts.length = 0;
    const snapNoMeta = await snapshotForDelete('Assets/Prefabs/NoMeta.prefab');
    check('snapshotForDelete tolerates a missing .meta',
      snapNoMeta.ok === true && snapNoMeta.backedUp === 1
      && inserts.filter(i => i.table === 'file_backups').length === 1);
    inserts.length = 0;
    const snapMissing = await snapshotForDelete('Assets/Prefabs/Missing.prefab');
    check('snapshotForDelete refuses a delete it cannot back up',
      snapMissing.ok === false && snapMissing.error.includes('delete not attempted')
      && inserts.length === 0);
  } catch (e) {
    check('snapshotForDelete runs against stubbed rb/state', false, String(e && e.message));
  }
  // v0.11.0 — resolveStrReplaceChanges (async helper; extractFunction
  // drops the `async` keyword, so re-add it). Stubbed rb/state: a
  // str_replace resolves to a whole-file change through the same
  // path the writer uses, and a failure stops the apply before
  // anything is written.
  try {
    const resolveSrSrc = extractFunction(appJs, 'resolveStrReplaceChanges');
    const safePathSrcA = extractFunction(appJs, 'isSafeProjectPath');
    const resolvePathSrcA = extractFunction(appJs, 'resolvePath');
    const replaceSrcA = extractFunction(appJs, 'applyStrReplaceText');
    const countSrcA = extractFunction(appJs, 'countOccurrencesText');
    const mapSrcA = extractFunction(appJs, 'mapNormToOrigText');
    if (!resolveSrSrc || !safePathSrcA || !resolvePathSrcA || !replaceSrcA || !countSrcA || !mapSrcA) throw new Error('resolveStrReplaceChanges or its helpers not extractable');
    const files = {
      'C:\\TD Pizza Racer\\Assets\\Scripts\\Player.cs': 'public class Player {\n  int health = 100;\n}\n',
      'C:\\TD Pizza Racer\\Assets\\Scripts\\CRLF.cs': 'line1\r\nline2\r\n',
    };
    const resolveStrReplaceChanges = new Function('rb', 'state', 'navigator',
      'async ' + resolveSrSrc + '\n' + safePathSrcA + '\n' + resolvePathSrcA + '\n' + replaceSrcA + '\n' + countSrcA + '\n' + mapSrcA + '\nreturn resolveStrReplaceChanges;')(
      { fs: { readFile: async (p) => (p in files ? { ok: true, content: files[p] } : { ok: false, error: 'ENOENT' }) } },
      { projectPath: 'C:\\TD Pizza Racer' },
      { platform: 'Win32' });
    const srOk = await resolveStrReplaceChanges([{ kind: 'str_replace', path: 'Assets/Scripts/Player.cs', old: '  int health = 100;', new: '  int health = 150;' }]);
    check('resolveStrReplaceChanges resolves a str_replace to a whole-file change',
      srOk.ok === true && srOk.changes.length === 1 && srOk.changes[0].path === 'Assets/Scripts/Player.cs'
      && srOk.changes[0].code === 'public class Player {\n  int health = 150;\n}\n');
    const srCrlf = await resolveStrReplaceChanges([{ kind: 'str_replace', path: 'Assets/Scripts/CRLF.cs', old: 'line1\nline2', new: 'A\nB' }]);
    check('resolveStrReplaceChanges handles CRLF files',
      srCrlf.ok === true && srCrlf.changes[0].code === 'A\r\nB\r\n');
    const srMiss = await resolveStrReplaceChanges([{ kind: 'str_replace', path: 'Assets/Scripts/Player.cs', old: 'not in the file', new: 'x' }]);
    check('resolveStrReplaceChanges fails plainly on a 0-match edit',
      srMiss.ok === false && srMiss.error.includes('not found') && srMiss.error.includes('view the file'));
    const srMissing = await resolveStrReplaceChanges([{ kind: 'str_replace', path: 'Assets/Scripts/Nope.cs', old: 'a', new: 'b' }]);
    check('resolveStrReplaceChanges fails plainly on an unreadable file',
      srMissing.ok === false && srMissing.error.includes('could not read'));
    const srEscape = await resolveStrReplaceChanges([{ kind: 'str_replace', path: '../evil.cs', old: 'a', new: 'b' }]);
    check('resolveStrReplaceChanges refuses a path escaping the project',
      srEscape.ok === false && srEscape.error.includes('relative to the project folder'));
    const srPass = await resolveStrReplaceChanges([{ path: 'Assets/Scripts/Player.cs', code: 'whole file\n' }]);
    check('resolveStrReplaceChanges passes whole-file changes through untouched',
      srPass.ok === true && srPass.changes.length === 1 && srPass.changes[0].code === 'whole file\n' && !('kind' in srPass.changes[0]));
  } catch (e) {
    check('resolveStrReplaceChanges runs against stubbed rb/state', false, String(e && e.message));
  }

  // v0.10.0 — git engine against a stubbed git, then the real
  // thing. The stub matches on the git args after `git -C <dir>`.
  {
    const proj = '/tmp/codefox-git-stub';
    const mkFs = (extra) => {
      const existing = new Set([proj + '/.git', '/usr/bin/git', ...(extra || [])]);
      return { existsSync: (p) => existing.has(p), unlinkSync: () => {} };
    };
    const mkRun = (handlers) => {
      const calls = [];
      const run = async (cmd, args, opts, timeoutMs) => {
        calls.push(args.slice(2).join(' '));
        for (const h of handlers) {
          const r = h(args.slice(2));
          if (r) return { code: r.code ?? 0, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: false };
        }
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      };
      return { run, calls };
    };
    const statusHandlers = (porcelain) => [
      (a) => a[0] === 'status' ? { stdout: porcelain } : null,
      (a) => a[0] === 'rev-parse' && a[1] === 'HEAD' ? { stdout: 'abc1234567890abcdef\n' } : null,
      (a) => a[0] === 'symbolic-ref' && a[1] === '--short' ? { stdout: 'main\n' } : null,
    ];
    // Status parsing through the engine.
    {
      const { run } = mkRun(statusHandlers(' M Assets/Scripts/Player.cs\n?? Notes.txt\n'));
      const eng = gitBackup.createEngine({ run, where: async () => ({ found: true, path: '/usr/bin/git' }), fs: mkFs(), path, getGitExePath: () => '' });
      const st = await eng.status(proj);
      check('git engine status parses modified/untracked, branch, head, not clean',
        st.ok === true && st.branch === 'main' && st.head === 'abc1234567890abcdef'
        && st.modified.includes('Assets/Scripts/Player.cs') && st.untracked.includes('Notes.txt') && st.clean === false);
    }
    // Backup on a clean tree: no commit, HEAD is the restore point.
    {
      const { run, calls } = mkRun(statusHandlers(''));
      const eng = gitBackup.createEngine({ run, where: async () => ({ found: true, path: '/usr/bin/git' }), fs: mkFs(), path, getGitExePath: () => '' });
      const b = await eng.backup(proj, 'fix the player');
      check('git engine backup on a clean tree makes no commit, HEAD is the restore point',
        b.ok === true && b.committed === false && b.sha === 'abc1234567890abcdef'
        && !calls.some(c => c.startsWith('commit')));
    }
    // Backup on a dirty tree: add -u (tracked only, transient
    // files excluded), then a commit with the CodeFox message.
    {
      const handlers = [
        ...statusHandlers('M  Assets/Scripts/Player.cs\n'),
        (a) => a[0] === 'diff' && a[1] === '--cached' ? { code: 1, stdout: '' } : null, // something staged
        (a) => a[0] === 'config' ? { code: 1, stdout: '' } : null, // no user.name/email set
        (a) => a[0] === 'commit' ? { stdout: '[main abc1234] CodeFox backup: before fix the player\n' } : null,
      ];
      const { run, calls } = mkRun(handlers);
      const eng = gitBackup.createEngine({ run, where: async () => ({ found: true, path: '/usr/bin/git' }), fs: mkFs(), path, getGitExePath: () => '' });
      const b = await eng.backup(proj, 'fix the player');
      check('git engine backup commits tracked changes with the CodeFox message',
        b.ok === true && b.committed === true && b.sha === 'abc1234567890abcdef'
        && calls.some(c => c.startsWith('add -u') && c.includes(':!Assets/.codefox-command.json'))
        && calls.some(c => c.includes('commit') && c.includes('CodeFox backup: before fix the player'))
        && calls.some(c => c.includes('-c') && c.includes('user.name=CodeFox')));
    }
    // Backup with only untracked changes: nothing staged, no commit.
    {
      const handlers = [
        ...statusHandlers('?? Notes.txt\n'),
        (a) => a[0] === 'diff' && a[1] === '--cached' ? { code: 0, stdout: '' } : null, // nothing staged
      ];
      const { run, calls } = mkRun(handlers);
      const eng = gitBackup.createEngine({ run, where: async () => ({ found: true, path: '/usr/bin/git' }), fs: mkFs(), path, getGitExePath: () => '' });
      const b = await eng.backup(proj, 'fix the player');
      check('git engine backup with only untracked changes makes no commit',
        b.ok === true && b.committed === false && !calls.some(c => c.startsWith('commit')));
    }
    // Backup refusals: not a repo, git missing, merge in progress.
    {
      const engNoRepo2 = gitBackup.createEngine({ run: mkRun([]).run, where: async () => ({ found: true, path: '/usr/bin/git' }), fs: { existsSync: (p) => p === '/usr/bin/git', unlinkSync: () => {} }, path, getGitExePath: () => '' });
      const r1 = await engNoRepo2.backup('/tmp/not-a-repo', 'x');
      check('git engine backup refuses a non-repo', r1.ok === false && r1.reason === 'not-a-repo');
      const engNoGit = gitBackup.createEngine({ run: mkRun([]).run, where: async () => ({ found: false, path: null }), fs: mkFs(), path, getGitExePath: () => '' });
      const r2 = await engNoGit.backup(proj, 'x');
      check('git engine backup reports git-not-found, never silently', r2.ok === false && r2.reason === 'git-not-found');
      const engMerge = gitBackup.createEngine({ run: mkRun(statusHandlers('')).run, where: async () => ({ found: true, path: '/usr/bin/git' }), fs: mkFs([proj + '/.git/MERGE_HEAD']), path, getGitExePath: () => '' });
      const r3 = await engMerge.backup(proj, 'x');
      check('git engine backup refuses during a merge', r3.ok === false && r3.reason === 'merge-in-progress');
    }
    // Restore: dry-run plan derived from name-status; bad paths
    // and bad refs refused; nothing executed on a dry run.
    {
      const handlers = [
        (a) => a[0] === 'rev-parse' && a[1] === '--verify' ? { stdout: 'abc1234567890abcdef\n' } : null,
        (a) => a[0] === 'diff' ? { stdout: 'M\tAssets/Scripts/Player.cs\nD\tAssets/Old.cs\nA\tAssets/New.cs\n' } : null,
      ];
      const { run, calls } = mkRun(handlers);
      const eng = gitBackup.createEngine({ run, where: async () => ({ found: true, path: '/usr/bin/git' }), fs: mkFs(), path, getGitExePath: () => '' });
      const plan = await eng.restore(proj, 'abc1234', { dryRun: true });
      check('git engine restore dry-run derives checkout/delete lists from name-status',
        plan.ok === true && plan.dryRun === true && plan.sha === 'abc1234567890abcdef'
        && plan.checkout.includes('Assets/Scripts/Player.cs') && plan.checkout.includes('Assets/Old.cs')
        && plan.delete.includes('Assets/New.cs')
        && !calls.some(c => c.startsWith('checkout')));
      const badPath = await eng.restore(proj, 'abc1234', { filesToCheckout: ['../evil.cs'], dryRun: true });
      check('git engine restore refuses a path escaping the repo', badPath.ok === false && badPath.reason === 'bad-path');
      const engBadRef = gitBackup.createEngine({ run: async () => ({ code: 128, stdout: '', stderr: 'unknown revision', timedOut: false }), where: async () => ({ found: true, path: '/usr/bin/git' }), fs: mkFs(), path, getGitExePath: () => '' });
      const badRef = await engBadRef.restore(proj, 'nonsense', {});
      check('git engine restore refuses an unknown ref', badRef.ok === false && badRef.reason === 'bad-ref');
    }
    // Diff truncation through the engine.
    {
      const { run } = mkRun([(a) => a[0] === 'diff' ? { stdout: 'x'.repeat(300 * 1024) } : null]);
      const eng = gitBackup.createEngine({ run, where: async () => ({ found: true, path: '/usr/bin/git' }), fs: mkFs(), path, getGitExePath: () => '' });
      const d = await eng.diff(proj, {});
      check('git engine diff truncates a huge diff', d.ok === true && d.truncated === true && d.diff.includes('truncated at 200KB'));
    }
  }

  // v0.10.0 — real git round-trip in a throwaway repo (only when
  // git is on this VM; the stub tests above cover the engine when
  // it is not).
  {
    let gitVersion = null;
    try { gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(); } catch {}
    if (gitVersion) {
      const { spawn } = require('child_process');
      const realRun = (cmd, args, opts, timeoutMs) => new Promise((resolve) => {
        let stdout = '', stderr = '';
        let proc;
        try { proc = spawn(cmd, args, opts); } catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e), timedOut: false }); }
        const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve({ code: -1, stdout, stderr, timedOut: true }); }, timeoutMs || 30000);
        proc.stdout && proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr && proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + '\n' + e.message, timedOut: false }); });
        proc.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout, stderr, timedOut: false }); });
      });
      const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-git-real-'));
      try {
        const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
        const eng = gitBackup.createEngine({ run: realRun, where: async () => ({ found: true, path: gitPath }), fs, path, getGitExePath: () => '' });
        await realRun('git', ['init', '-b', 'main', tmpRepo], {}, 10000);
        await realRun('git', ['-C', tmpRepo, 'config', 'user.email', 'test@codefox.local'], {}, 5000);
        await realRun('git', ['-C', tmpRepo, 'config', 'user.name', 'CodeFox Test'], {}, 5000);
        fs.writeFileSync(path.join(tmpRepo, 'Player.cs'), 'v1\n');
        await realRun('git', ['-C', tmpRepo, 'add', '-A'], {}, 5000);
        await realRun('git', ['-C', tmpRepo, 'commit', '-m', 'initial'], {}, 5000);
        fs.writeFileSync(path.join(tmpRepo, 'Player.cs'), 'v2 broken\n');
        fs.writeFileSync(path.join(tmpRepo, 'NewFile.cs'), 'new\n');
        const b = await eng.backup(tmpRepo, 'fix the player');
        check('real git: backup commits the tracked change',
          b.ok === true && b.committed === true && !!b.sha, 'got ' + JSON.stringify(b));
        const l = await eng.log(tmpRepo, 5);
        check('real git: backup commit is in the log with the CodeFox message',
          l.ok === true && l.commits[0].isBackup === true && l.commits[0].message === 'CodeFox backup: before fix the player');
        fs.writeFileSync(path.join(tmpRepo, 'Player.cs'), 'v3 worse\n');
        const d = await eng.diff(tmpRepo, { ref: b.sha });
        check('real git: diff vs the backup shows the new change',
          d.ok === true && d.diff.includes('v3 worse'));
        const r = await eng.restore(tmpRepo, b.sha, {});
        check('real git: restore returns the file to the backup state',
          r.ok === true && fs.readFileSync(path.join(tmpRepo, 'Player.cs'), 'utf8') === 'v2 broken\n');
        check('real git: restore does not touch files that predate the backup',
          fs.existsSync(path.join(tmpRepo, 'NewFile.cs')));
        fs.writeFileSync(path.join(tmpRepo, 'Created.cs'), 'created\n');
        const r2 = await eng.restore(tmpRepo, b.sha, { filesToCheckout: [], filesToDelete: ['Created.cs'] });
        check('real git: restore deletes a file the change created',
          r2.ok === true && !fs.existsSync(path.join(tmpRepo, 'Created.cs')));
      } finally { fs.rmSync(tmpRepo, { recursive: true, force: true }); }
    } else {
      check('real-git integration skipped — git not on this VM (stub tests cover the engine)', true);
    }
  }
  // v0.21.0: MCP server dispatch — read tools run for real, mutating
  // tools are denied with the approval message, and the gated Unity
  // read path executes (and fails on the missing bridge) instead of
  // being denied.
  {
    const MCPServer = require(path.join(root, 'mcp-server', 'server.js'));
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-mcp-proj-'));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-mcp-data-'));
    try {
      fs.writeFileSync(path.join(tmpProj, 'Player.cs'), 'public class Player {\n  public float speed = 5f;\n}\n');
      const idx = DS.buildIndex(fixtureDocs);
      idx.unityVersion = '6000.3';
      fs.mkdirSync(path.join(tmpData, 'unity-docs', '6000.3'), { recursive: true });
      fs.writeFileSync(path.join(tmpData, 'unity-docs', '6000.3', 'index.json'), JSON.stringify(idx));
      const ctx = MCPServer.createContext({ project: tmpProj, dataDir: tmpData });
      const docsRes = await MCPServer.dispatch('docs_search', { query: 'transformpoint' }, ctx);
      check('mcp dispatch: docs_search runs against the fixture index',
        docsRes.isError === false && docsRes.content[0].text.includes('Transform.TransformPoint'), docsRes.content[0].text.slice(0, 120));
      const noIndex = await MCPServer.dispatch('docs_search', { query: 'rigidbody' }, MCPServer.createContext({ project: tmpProj, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'codefox-mcp-empty-')) }));
      check('mcp dispatch: docs_search says plainly when there is no index',
        noIndex.isError === true && /No Unity docs index yet/.test(noIndex.content[0].text));
      const viewRes = await MCPServer.dispatch('file_view', { path: 'Player.cs' }, ctx);
      check('mcp dispatch: file_view reads a project file',
        viewRes.isError === false && viewRes.content[0].text.includes('public float speed'));
      const grepRes = await MCPServer.dispatch('file_grep', { pattern: 'speed' }, ctx);
      check('mcp dispatch: file_grep finds the pattern',
        grepRes.isError === false && grepRes.content[0].text.includes('Player.cs:2:'));
      const deny1 = await MCPServer.dispatch('file_str_replace', { path: 'Player.cs', oldText: '5f', newText: '9f' }, ctx);
      check('mcp dispatch: file_str_replace is denied, and the file is untouched',
        deny1.isError === true && /Denied/.test(deny1.content[0].text) && /approval/i.test(deny1.content[0].text)
        && fs.readFileSync(path.join(tmpProj, 'Player.cs'), 'utf8').includes('5f'));
      const deny2 = await MCPServer.dispatch('comfyui_generate', { workflow: 'x', prompt: 'y' }, ctx);
      check('mcp dispatch: comfyui_generate is denied',
        deny2.isError === true && /Denied/.test(deny2.content[0].text));
      const deny3 = await MCPServer.dispatch('unity_command', { action: 'createPrefab', args: {} }, ctx);
      check('mcp dispatch: a Unity write action is denied',
        deny3.isError === true && /Denied/.test(deny3.content[0].text) && /createPrefab/.test(deny3.content[0].text));
      const readU = await MCPServer.dispatch('unity_command', { action: 'list_hierarchy', args: {} }, ctx);
      check('mcp dispatch: a Unity read action executes (and reports the missing bridge, not a denial)',
        readU.isError === true && !/Denied/.test(readU.content[0].text) && /bridge/i.test(readU.content[0].text));
      let gitHere = false;
      try { execFileSync('git', ['--version'], { stdio: 'pipe' }); gitHere = true; } catch {}
      if (gitHere) {
        execFileSync('git', ['init', tmpProj], { stdio: 'pipe' });
        execFileSync('git', ['-C', tmpProj, 'config', 'user.email', 'test@codefox.local'], { stdio: 'pipe' });
        execFileSync('git', ['-C', tmpProj, 'config', 'user.name', 'CodeFox Test'], { stdio: 'pipe' });
        execFileSync('git', ['-C', tmpProj, 'add', '.'], { stdio: 'pipe' });
        execFileSync('git', ['-C', tmpProj, 'commit', '-m', 'initial'], { stdio: 'pipe' });
        const gitRes = await MCPServer.dispatch('git_status', {}, ctx);
        check('mcp dispatch: git_status runs against a real repo',
          gitRes.isError === false && gitRes.content[0].text.includes('"clean": true'), gitRes.content[0].text.slice(0, 120));
        const logRes = await MCPServer.dispatch('git_log', { count: 5 }, ctx);
        check('mcp dispatch: git_log lists the commit',
          logRes.isError === false && logRes.content[0].text.includes('initial'));
      } else {
        check('mcp dispatch: git_status skipped — git not on this VM', true);
      }
      const unknown = await MCPServer.dispatch('no_such_tool', {}, ctx);
      check('mcp dispatch: an unknown tool is a plain error', unknown.isError === true && /Unknown tool/.test(unknown.content[0].text));
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
    }
  }
  finish();
})().catch((e) => {
  check('mock ComfyUI server tests ran without throwing', false, String(e && e.message));
  finish();
});

// 46. v0.21.1 — bridge brace-balance regression + GPU mode layout.
// The 0.16.0 bridge shipped with one extra '}' after
// SetPropertyHandler.ReadbackProblems (line ~4687). It closed the
// handler class early, so every handler after it — and ClickUI —
// landed at namespace level and Unity refused the whole file with
// CS8803 / CS0106 / CS1022. A brace-balance check on the .cs file
// would have caught it before it shipped: strip strings, chars and
// comments, count braces, and require final depth 0 with every
// handler class nested at depth 1 inside CodeFoxBridge.
{
  const cs = fs.readFileSync(path.join(root, 'unity-companion', 'CodeFoxBridge.cs'), 'utf8');
  let clean = '';
  let st = 'code';
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const nx = cs[i + 1] || '';
    if (st === 'code') {
      if (c === '/' && nx === '/') { st = 'line'; i++; continue; }
      if (c === '/' && nx === '*') { st = 'block'; i++; continue; }
      if (c === '$' && nx === '"') { st = 'str'; clean += '  '; i++; continue; }
      if (c === '@' && nx === '"') { st = 'verb'; clean += '  '; i++; continue; }
      if (c === '"') { st = 'str'; clean += ' '; continue; }
      if (c === "'") { st = 'char'; clean += ' '; continue; }
      clean += c;
    } else if (st === 'line') {
      if (c === '\n') { st = 'code'; clean += c; }
    } else if (st === 'block') {
      if (c === '*' && nx === '/') { st = 'code'; i++; continue; }
      if (c === '\n') clean += c;
    } else if (st === 'str') {
      if (c === '\\') { i++; continue; }
      if (c === '"') { st = 'code'; clean += ' '; continue; }
      if (c === '\n') clean += c;
    } else if (st === 'verb') {
      if (c === '"' && nx === '"') { i++; continue; }
      if (c === '"') { st = 'code'; clean += ' '; continue; }
      if (c === '\n') clean += c;
    } else if (st === 'char') {
      if (c === '\\') { i++; continue; }
      if (c === "'") { st = 'code'; clean += ' '; continue; }
    }
  }
  const cl = clean.split('\n');
  let depth = 0;
  const misplaced = [];
  cl.forEach((line, idx) => {
    const before = depth;
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    if (line.includes('static class ') && !line.includes('CodeFoxBridge') && before !== 1)
      misplaced.push((idx + 1) + ':' + line.trim().slice(0, 50));
    if (line.includes('ClickUI(string json') && before !== 1)
      misplaced.push((idx + 1) + ':ClickUI');
  });
  check('bridge braces balance to depth 0', depth === 0, 'final depth ' + depth);
  check('every bridge handler class is nested inside CodeFoxBridge', misplaced.length === 0, misplaced.join('; '));
  check('bridge version is 0.16.2 everywhere pinned',
    cs.includes('// CodeFoxBridge version: 0.16.2') && cs.includes('BridgeVersion = "0.16.2"')
    && fs.readFileSync(path.join(root, 'unity-bridge.js'), 'utf8').includes("BUNDLED_BRIDGE_VERSION = '0.16.2'"));
  const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  check('GPU mode select is width:auto so the settings-pane width:100% rule cannot crush the row',
    appJs.includes('setComfyuiGpuMode(this.value)" style="padding:4px 8px;font-size:12px;width:auto;max-width:340px;flex-shrink:0;"'));
}

// 47. v0.21.2 — bridge API fixes: the four errors the brace fix
// uncovered. Each one is pinned so a bad Unity API call cannot
// ship again — the smoke suite is the only compile check the
// bridge gets before Rob's Unity sees it.
{
  const cs = fs.readFileSync(path.join(root, 'unity-companion', 'CodeFoxBridge.cs'), 'utf8');
  check('bridge: Animator types are aliased to the public ones (no CS0104)',
    cs.includes('using AnimatorController = UnityEditor.Animations.AnimatorController;')
    && cs.includes('using AnimatorControllerParameter = UnityEngine.AnimatorControllerParameter;')
    && cs.includes('using AnimatorControllerParameterType = UnityEngine.AnimatorControllerParameterType;'));
  check('bridge: no SessionState.SetLong/GetLong anywhere (no CS0117)',
    !cs.includes('SessionState.SetLong') && !cs.includes('SessionState.GetLong'));
  check('bridge: longs ride as strings via SetSessionLong/GetSessionLong helpers',
    cs.includes('private static void SetSessionLong(string key, long value)')
    && cs.includes('private static long GetSessionLong(string key, long defaultValue)')
    && cs.includes('SetSessionLong(StartCursorKey, ConsoleBuffer.CurrentCursor())')
    && cs.includes('GetSessionLong(RequestedAtKey, 0)'));
  check('bridge: no PrefabUtility.IsPartOfPrefabContents anywhere (no CS0117)',
    !cs.includes('PrefabUtility.IsPartOfPrefabContents'));
  check('bridge: stale-edit cleanup identifies a LoadPrefabContents root by asset type + instance status',
    cs.includes('PrefabUtility.GetPrefabAssetType(go) == PrefabAssetType.NotAPrefab')
    && cs.includes('PrefabUtility.GetPrefabInstanceStatus(go) != PrefabInstanceStatus.NotAPrefab'));
  check('bridge: SetTransformParent uses the 4-argument form (no CS1503)',
    cs.includes('Undo.SetTransformParent(target.transform, newParentT, keepWorldPosition, "Agent: move " + target.name);')
    && !cs.includes('Undo.SetTransformParent(target.transform, newParentT, keepWorldPosition);'));
  check('bridge version is 0.16.2 everywhere pinned',
    cs.includes('// CodeFoxBridge version: 0.16.2') && cs.includes('BridgeVersion = "0.16.2"')
    && fs.readFileSync(path.join(root, 'unity-bridge.js'), 'utf8').includes("BUNDLED_BRIDGE_VERSION = '0.16.2'"));
}

function finish() {
  if (failures) {
    console.log('\n' + failures + ' check(s) FAILED');
    process.exit(1);
  }
  console.log('\nAll smoke checks passed.');
}
