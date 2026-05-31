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
    readDir: (path) => ipcRenderer.invoke('fs:readDir', path),
    pickFolder: () => ipcRenderer.invoke('fs:pickFolder'),
  },
  ollama: {
    status: () => ipcRenderer.invoke('ollama:status'),
    launch: () => ipcRenderer.invoke('ollama:launch'),
    setPath: (p) => ipcRenderer.invoke('ollama:setPath', p),
    pickExe: () => ipcRenderer.invoke('ollama:pickExe'),
    chat: (payload) => ipcRenderer.invoke('ollama:chat', payload),
    onChunk: (cb) => ipcRenderer.on('ollama:stream-chunk', (_, chunk) => cb(chunk)),
    onDone: (cb) => ipcRenderer.on('ollama:stream-done', () => cb()),
    removeListeners: () => {
      ipcRenderer.removeAllListeners('ollama:stream-chunk');
      ipcRenderer.removeAllListeners('ollama:stream-done');
    }
  },
  unity: {
    refresh: (projectPath) => ipcRenderer.invoke('unity:refresh', projectPath),
  }
});
