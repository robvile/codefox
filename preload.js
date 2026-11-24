const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rb', {
  db: {
    getAll: (table) => ipcRenderer.invoke('db:getAll', table),
    get: (table, id) => ipcRenderer.invoke('db:get', table, id),
    insert: (table, data) => ipcRenderer.invoke('db:insert', table, data),
    update: (table, id, data) => ipcRenderer.invoke('db:update', table, id, data),
    delete: (table, id) => ipcRenderer.invoke('db:delete', table, id),
    getSetting: (key) => ipcRenderer.invoke('db:getSetting', key),
    setSetting: (key, value) => ipcRenderer.invoke('db:setSetting', key, value),
  },
  fs: {
    readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
    deleteFile: (path) => ipcRenderer.invoke('fs:deleteFile', path),
    moveFile: (src, dest) => ipcRenderer.invoke('fs:moveFile', src, dest),
    readDir: (path) => ipcRenderer.invoke('fs:readDir', path),
    pickFolder: () => ipcRenderer.invoke('fs:pickFolder'),
    pickExe: (title) => ipcRenderer.invoke('fs:pickExe', title),
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
  project: {
    scan: (projectPath) => ipcRenderer.invoke('project:scan', projectPath),
    moveAsset: (src, dest) => ipcRenderer.invoke('fs:moveFile', src, dest),
  },
  unity: {
    refresh: (projectPath) => ipcRenderer.invoke('unity:refresh', projectPath),
    runTests: (payload) => ipcRenderer.invoke('unity:runTests', payload || {}),
    buildCheck: (payload) => ipcRenderer.invoke('unity:buildCheck', payload || {}),
  }
});
