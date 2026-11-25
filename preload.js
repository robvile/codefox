const { contextBridge, ipcRenderer } = require('electron');
const { UNITY_ASSET_EXTS, isUnityAssetPath } = require('./unity-assets');
const { MCP_PRESETS, getPreset, buildServerEntry } = require('./mcp-presets');

contextBridge.exposeInMainWorld('rb', {
  // Unity-native asset files (v0.5.1) — one source of truth, shared
  // with the smoke test via unity-assets.js. Used by the auto-apply
  // check in app.js: new .prefab / .asset / .unity / … files.
  unityAssets: {
    exts: UNITY_ASSET_EXTS,
    isUnityAssetPath: (p) => isUnityAssetPath(p),
  },
  // Curated MCP presets (v0.5.3) — one source of truth, shared with
  // the smoke test via mcp-presets.js. Used by the MCPs section in
  // app.js: six recommended servers, one click to add the config.
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
  llm: {
    status: () => ipcRenderer.invoke('llm:status'),
    listModels: (payload) => ipcRenderer.invoke('llm:listModels', payload || {}),
    verify: (payload) => ipcRenderer.invoke('llm:verify', payload || {}),
    chat: (payload) => ipcRenderer.invoke('llm:chat', payload),
    onChunk: (cb) => ipcRenderer.on('llm:stream-chunk', (_, chunk) => cb(chunk)),
    onDone: (cb) => ipcRenderer.on('llm:stream-done', () => cb()),
    removeListeners: () => {
      ipcRenderer.removeAllListeners('llm:stream-chunk');
      ipcRenderer.removeAllListeners('llm:stream-done');
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
  },
  shell: {
    run: (payload) => ipcRenderer.invoke('shell:run', payload || {}),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
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
    view: (payload) => ipcRenderer.invoke('comfyui:view', payload || {}),
    uploadImage: (payload) => ipcRenderer.invoke('comfyui:uploadImage', payload || {}),
    listWorkflows: (payload) => ipcRenderer.invoke('comfyui:listWorkflows', payload || {}),
    readWorkflow: (payload) => ipcRenderer.invoke('comfyui:readWorkflow', payload || {}),
    defaultWorkflowsDir: () => ipcRenderer.invoke('comfyui:defaultWorkflowsDir'),
  },
});
