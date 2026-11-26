const { contextBridge, ipcRenderer } = require('electron');

// ── NEVER require a local file in this file (v0.6.4) ─────────────
// This is the root cause of the v0.6.0 dead-buttons bug, proven in
// real Electron: this file used to start with
// require('./unity-assets') and require('./mcp-presets'). In real
// Electron that throws ("module not found: ./unity-assets") — the
// preload never reaches exposeInMainWorld below, window.rb is never
// created, and every button that awaits an rb.* call silently does
// nothing. Plain Node never showed it, because require works fine
// there, so the smoke test now enforces this invariant: the only
// require allowed here is 'electron' (plus Node built-ins).
//
// The two static data tables the old requires provided — the Unity
// asset extensions and the MCP preset list — now arrive from the
// main process over a synchronous channel ('app:staticData', see
// main.js), fetched once at load. The three pure helpers below are
// implemented here from that data, so the window.rb shape the
// renderer sees is unchanged and app.js needs no changes. The
// helpers intentionally mirror unity-assets.js (isUnityAssetPath)
// and mcp-presets.js (getPreset, buildServerEntry) line for line
// in behaviour; the smoke test checks both implementations agree
// on a matrix of inputs, so the two copies cannot drift silently.
let staticData = {};
try { staticData = ipcRenderer.sendSync('app:staticData') || {}; }
catch (e) { staticData = {}; /* bridge must never die over static data */ }
const UNITY_ASSET_EXTS = Array.isArray(staticData.unityAssetExts) ? staticData.unityAssetExts : [];
const MCP_PRESETS = Array.isArray(staticData.mcpPresets) ? staticData.mcpPresets : [];

// Extension of a path (lowercase, including the dot), '' when none.
function extOf(p) {
  const s = String(p || '');
  const base = s.split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function isUnityAssetPath(p) {
  return UNITY_ASSET_EXTS.indexOf(extOf(p)) !== -1;
}

function getPreset(id) {
  return MCP_PRESETS.find(p => p.id === id) || null;
}

// Build a server entry (the shape stored in the `mcp_servers`
// setting) from a preset plus the values the preset needs.
// `opts` is { token, folder, fields: { site, email, apiKey, ... } }.
// Returns { ok, error, entry }. Mirrors buildServerEntry in
// mcp-presets.js: refuses — never guesses — when a required token,
// field, or folder is missing. `args` is stored as the joined
// string the manual form uses. Env placeholders are substituted
// from the matching value: '<token>' from opts.token (or
// fields.token), '<site>' from fields.site, '<email>' from
// fields.email, '<apiKey>' from fields.apiKey.
function buildServerEntry(preset, opts) {
  const o = opts || {};
  const fields = o.fields || {};
  if (!preset) return { ok: false, error: 'Unknown preset', entry: null };
  if (preset.requiresToken && !(o.token || fields.token || '').trim()) {
    return { ok: false, error: preset.requiresToken.label + ' is required', entry: null };
  }
  for (const f of (preset.requiresFields || [])) {
    const v = f.key === 'token' ? (o.token || fields.token || '') : (fields[f.key] || '');
    if (!String(v).trim()) return { ok: false, error: f.label + ' is required', entry: null };
  }
  if (preset.requiresFolder && !(o.folder || '').trim()) {
    return { ok: false, error: 'A folder is required', entry: null };
  }
  const valueFor = (placeholder) => {
    if (placeholder === '<token>') return (o.token || fields.token || '').trim();
    if (placeholder === '<site>') return (fields.site || '').trim();
    if (placeholder === '<email>') return (fields.email || '').trim();
    if (placeholder === '<apiKey>') return (fields.apiKey || '').trim();
    return placeholder;
  };
  const env = {};
  for (const [k, v] of Object.entries(preset.env || {})) {
    env[k] = valueFor(v);
  }
  const args = (preset.args || []).map(a => (a === '<folder>' ? (o.folder || '').trim() : a)).join(' ');
  return {
    ok: true,
    error: null,
    entry: {
      id: 'preset_' + preset.id,
      presetId: preset.id,
      name: preset.name,
      command: preset.command,
      args,
      env,
      enabled: true,
    },
  };
}

contextBridge.exposeInMainWorld('rb', {
  // Unity-native asset files (v0.5.1) — one source of truth, shared
  // with the smoke test via unity-assets.js. Used by the auto-apply
  // check in app.js: new .prefab / .asset / .unity / … files.
  // The list itself arrives from the main process (see above).
  unityAssets: {
    exts: UNITY_ASSET_EXTS,
    isUnityAssetPath: (p) => isUnityAssetPath(p),
  },
  // Curated MCP presets (v0.5.3) — one source of truth, shared with
  // the smoke test via mcp-presets.js. Used by the MCPs section in
  // app.js: six recommended servers, one click to add the config.
  // The list itself arrives from the main process (see above).
  mcpPresets: {
    list: MCP_PRESETS,
    get: (id) => getPreset(id),
    buildServerEntry: (preset, opts) => buildServerEntry(preset, opts),
  },
  db: {
    getAll: (table) => ipcRenderer.invoke('db:getAll', table),
    get: (table, id) => ipcRenderer.invoke('db:get', table, id),
    insert: (table, data) => ipcRenderer.invoke('db:insert', table, data),
    update: (table, id, data) => ipcRenderer.invoke('db:update', table, id, data),
    delete: (table, id) => ipcRenderer.invoke('db:delete', table, id),
    // v0.5.1: discard a snapshot and its backed-up files (Keep).
    deleteSnapshot: (snapshotId) => ipcRenderer.invoke('db:deleteSnapshot', snapshotId),
    getSetting: (key) => ipcRenderer.invoke('db:getSetting', key),
    setSetting: (key, value) => ipcRenderer.invoke('db:setSetting', key, value),
  },
  fs: {
    readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
    deleteFile: (path) => ipcRenderer.invoke('fs:deleteFile', path),
    moveFile: (src, dest) => ipcRenderer.invoke('fs:moveFile', src, dest),
    readDir: (path) => ipcRenderer.invoke('fs:readDir', path),
    exists: (path) => ipcRenderer.invoke('fs:exists', path),
    pickFolder: () => ipcRenderer.invoke('fs:pickFolder'),
    pickExe: (title) => ipcRenderer.invoke('fs:pickExe', title),
    // v0.11.0: model read tools — line-range view and project grep.
    view: (payload) => ipcRenderer.invoke('file:view', payload || {}),
    grep: (payload) => ipcRenderer.invoke('file:grep', payload || {}),
  },
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    create: (name, path) => ipcRenderer.invoke('project:create', name, path),
    switch: (id) => ipcRenderer.invoke('project:switch', id),
    update: (id, data) => ipcRenderer.invoke('project:update', id, data),
    delete: (id) => ipcRenderer.invoke('project:delete', id),
    scan: (projectPath) => ipcRenderer.invoke('project:scan', projectPath),
    moveAsset: (src, dest) => ipcRenderer.invoke('fs:moveFile', src, dest),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    set: (name, installed) => ipcRenderer.invoke('skills:set', name, installed),
  },
  // File-based skills (v0.13.0) — folders of markdown the model
  // reads on demand. Distinct from `skills` above, which is the
  // install state of the Home screen's one-click workflow
  // shortcuts. scan merges the builtin, user-data and project
  // roots and reports per-project enablement; install copies a
  // skill into the project; setEnabled toggles it for a project.
  skillFiles: {
    scan: (projectPath, projectId) => ipcRenderer.invoke('skillFiles:scan', { projectPath: projectPath || '', projectId: projectId == null ? null : projectId }),
    install: (name, source, projectPath) => ipcRenderer.invoke('skillFiles:install', { name, source, projectPath: projectPath || '' }),
    setEnabled: (projectId, name, enabled) => ipcRenderer.invoke('skillFiles:setEnabled', { projectId, name, enabled }),
  },
  llm: {
    status: () => ipcRenderer.invoke('llm:status'),
    listModels: (payload) => ipcRenderer.invoke('llm:listModels', payload || {}),
    listDownloaded: (payload) => ipcRenderer.invoke('llm:listDownloaded', payload || {}),
    loadModel: (modelId) => ipcRenderer.invoke('llm:loadModel', { model: modelId }),
    unloadModel: (modelId) => ipcRenderer.invoke('llm:unloadModel', { model: modelId }),
    verify: (payload) => ipcRenderer.invoke('llm:verify', payload || {}),
    chat: (payload) => ipcRenderer.invoke('llm:chat', payload),
    onChunk: (cb) => ipcRenderer.on('llm:stream-chunk', (_, chunk) => cb(chunk)),
    onDone: (cb) => ipcRenderer.on('llm:stream-done', () => cb()),
    // v0.19.0: the server's numbers for the calibrated counter —
    // usage.prompt_tokens and finish_reason, sent once per stream
    // by the main process (see lmStudioChat / ollamaChat). Absent
    // when the server does not report them; the renderer then
    // estimates and never invents a number.
    onMeta: (cb) => ipcRenderer.on('llm:stream-meta', (_, meta) => cb(meta)),
    removeListeners: () => {
      ipcRenderer.removeAllListeners('llm:stream-chunk');
      ipcRenderer.removeAllListeners('llm:stream-done');
      ipcRenderer.removeAllListeners('llm:stream-meta');
      ipcRenderer.removeAllListeners('ollama:stream-chunk');
      ipcRenderer.removeAllListeners('ollama:stream-done');
    }
  },
  ollama: {
    status: () => ipcRenderer.invoke('ollama:status'),
    launch: () => ipcRenderer.invoke('ollama:launch'),
    setPath: (p) => ipcRenderer.invoke('ollama:setPath', p),
    pickExe: () => ipcRenderer.invoke('ollama:pickExe'),
    // Legacy Ollama API, delegated to the unified llm channel.
    chat: (payload) => ipcRenderer.invoke('llm:chat', { ...(payload || {}), provider: 'ollama' }),
    onChunk: (cb) => ipcRenderer.on('ollama:stream-chunk', (_, chunk) => cb(chunk)),
    onDone: (cb) => ipcRenderer.on('ollama:stream-done', () => cb()),
    removeListeners: () => {
      ipcRenderer.removeAllListeners('ollama:stream-chunk');
      ipcRenderer.removeAllListeners('ollama:stream-done');
    }
  },
  unity: {
    refresh: (projectPath) => ipcRenderer.invoke('unity:refresh', projectPath),
    runTests: (payload) => ipcRenderer.invoke('unity:runTests', payload || {}),
    buildCheck: (payload) => ipcRenderer.invoke('unity:buildCheck', payload || {}),
    installBridge: (projectPath) => ipcRenderer.invoke('unity:installBridge', projectPath),
    removeBridge: (projectPath) => ipcRenderer.invoke('unity:removeBridge', projectPath),
    ensureBridge: (projectPath) => ipcRenderer.invoke('unity:ensureBridge', projectPath),
    bridgeStatus: (projectPath) => ipcRenderer.invoke('unity:bridgeStatus', projectPath),
    listPackages: (projectPath) => ipcRenderer.invoke('unity:listPackages', projectPath),
    addPackage: (payload) => ipcRenderer.invoke('unity:addPackage', payload || {}),
    removePackage: (payload) => ipcRenderer.invoke('unity:removePackage', payload || {}),
    // Run one command through the Unity bridge (v0.9.0) — prefabs
    // are created and changed in Unity itself, never by writing
    // .prefab YAML by hand. See unity-command.js.
    runCommand: (payload) => ipcRenderer.invoke('unity:command', payload || {}),
    // Bridge heartbeat (v0.12.0): whether the bridge is ticking
    // right now, without waiting for it. The compile check reads
    // this before trying Unity's own compiler.
    heartbeat: (projectPath) => ipcRenderer.invoke('unity:heartbeat', projectPath),
  },
  shell: {
    run: (payload) => ipcRenderer.invoke('shell:run', payload || {}),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  },
  // Git backups (v0.10.0) — local backup commits before changes,
  // diff / log / restore. The engine is the git CLI on the user's
  // machine; it never touches remotes.
  git: {
    repoInfo: (payload) => ipcRenderer.invoke('git:repoInfo', payload || {}),
    status: (payload) => ipcRenderer.invoke('git:status', payload || {}),
    diff: (payload) => ipcRenderer.invoke('git:diff', payload || {}),
    log: (payload) => ipcRenderer.invoke('git:log', payload || {}),
    backup: (payload) => ipcRenderer.invoke('git:backup', payload || {}),
    restore: (payload) => ipcRenderer.invoke('git:restore', payload || {}),
  },
  mcp: {
    checkToken: (payload) => ipcRenderer.invoke('mcp:checkToken', payload || {}),
    checkApp: (payload) => ipcRenderer.invoke('mcp:checkApp', payload || {}),
  },
  comfyui: {
    status: (payload) => ipcRenderer.invoke('comfyui:status', payload || {}),
    objectInfo: (payload) => ipcRenderer.invoke('comfyui:objectInfo', payload || {}),
    queue: (payload) => ipcRenderer.invoke('comfyui:queue', payload || {}),
    history: (payload) => ipcRenderer.invoke('comfyui:history', payload || {}),
    submit: (payload) => ipcRenderer.invoke('comfyui:submit', payload || {}),
    cancel: (payload) => ipcRenderer.invoke('comfyui:cancel', payload || {}),
    freeMemory: (payload) => ipcRenderer.invoke('comfyui:freeMemory', payload || {}),
    planVariations: (payload) => ipcRenderer.invoke('comfyui:planVariations', payload || {}),
    view: (payload) => ipcRenderer.invoke('comfyui:view', payload || {}),
    uploadImage: (payload) => ipcRenderer.invoke('comfyui:uploadImage', payload || {}),
    listWorkflows: (payload) => ipcRenderer.invoke('comfyui:listWorkflows', payload || {}),
    scan: (payload) => ipcRenderer.invoke('comfyui:scan', payload || {}),
    readWorkflow: (payload) => ipcRenderer.invoke('comfyui:readWorkflow', payload || {}),
    defaultWorkflowsDir: () => ipcRenderer.invoke('comfyui:defaultWorkflowsDir'),
  },
  // Diagnostics (v0.6.2) — Settings → Advanced has a "Developer
  // tools" button for this; the same panel as Ctrl+Shift+I, for
  // users whose keyboard shortcut is intercepted by other software.
  // ping (v0.6.3) is the bridge self-check init() runs first: if
  // the main process does not answer it, the app says so on screen.
  app: {
    openDevTools: () => ipcRenderer.invoke('app:openDevTools'),
    ping: () => ipcRenderer.invoke('app:ping'),
    quit: () => ipcRenderer.invoke('app:quit'),
  },
  // Eval harness (v0.18.0) — fixture reset + file hashing, main
  // process only (the renderer has no Node fs).
  eval: {
    resetFixture: (payload) => ipcRenderer.invoke('eval:resetFixture', payload || {}),
    hashTree: (payload) => ipcRenderer.invoke('eval:hashTree', payload || {}),
  },
});
