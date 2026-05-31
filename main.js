const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile } = require('child_process');

// ── Ollama process management ─────────────────────────────────────
let ollamaProcess = null;

const OLLAMA_PATHS = [
  // User-saved custom path (checked first)
  null, // placeholder — filled dynamically from DB
  // Standard install locations
  'C:\\Users\\' + (process.env.USERNAME || 'user') + '\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
  'C:\\Users\\' + (process.env.USERPROFILE ? process.env.USERPROFILE.split('\\').pop() : 'user') + '\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
  'C:\\Program Files\\Ollama\\ollama.exe',
  'C:\\Program Files (x86)\\Ollama\\ollama.exe',
  // Scoop
  'C:\\Users\\' + (process.env.USERNAME || 'user') + '\\scoop\\apps\\ollama\\current\\ollama.exe',
  // Winget default
  'C:\\Users\\' + (process.env.USERNAME || 'user') + '\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Ollama.Ollama_Microsoft.Winget.Source_8wekyb3d8bbwe\\ollama.exe',
];

// Also try PATH resolution
function findOllamaOnPath() {
  try {
    const { execSync } = require('child_process');
    const result = execSync('where ollama', { timeout: 3000 }).toString().trim().split('\n')[0].trim();
    if (result && fs.existsSync(result)) return result;
  } catch {}
  return null;
}

let _customOllamaPath = null;
function setCustomOllamaPath(p) { _customOllamaPath = p; }

function findOllamaExe() {
  // Check user-set custom path first
  if (_customOllamaPath && fs.existsSync(_customOllamaPath)) return _customOllamaPath;
  // Check PATH
  const onPath = findOllamaOnPath();
  if (onPath) return onPath;
  // Check known locations
  for (const p of OLLAMA_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

async function isOllamaRunning() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:11434/api/tags', (res) => {
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForOllama(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isOllamaRunning()) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function launchOllama() {
  // Already running?
  if (await isOllamaRunning()) {
    return { status: 'running', pid: null };
  }

  const exePath = findOllamaExe();
  if (!exePath) {
    return { status: 'not_found', pid: null };
  }

  try {
    ollamaProcess = spawn(exePath, ['serve'], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    ollamaProcess.unref();

    // Wait up to 30s for it to be ready
    const ready = await waitForOllama(30000);
    if (ready) {
      return { status: 'launched', pid: ollamaProcess.pid };
    } else {
      return { status: 'timeout', pid: ollamaProcess.pid };
    }
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

app.on('will-quit', () => {
  // Don't kill Ollama on exit — user may want it running for other things
  // If we launched it, it becomes independent
});

let mainWindow;
let db;
let SQL;

async function initDB() {
  // Handle both dev (node_modules) and packaged (app.asar) environments
  const isDev = !app.isPackaged;
  const sqlJsPath = isDev
    ? path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.js')
    : path.join(process.resourcesPath, 'app.asar', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js');
  const wasmDir = isDev
    ? path.join(__dirname, 'node_modules', 'sql.js', 'dist')
    : path.join(process.resourcesPath, 'app.asar', 'node_modules', 'sql.js', 'dist');
  const initSqlJs = require(sqlJsPath);
  SQL = await initSqlJs({
    locateFile: file => path.join(wasmDir, file)
  });

  const dbPath = path.join(app.getPath('userData'), 'CodeFox.db');
  if (fs.existsSync(dbPath)) {
    const data = fs.readFileSync(dbPath);
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS rulesets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS file_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    file_count INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Default settings
  const existing = db.exec("SELECT value FROM settings WHERE key='project_path'");
  if (!existing.length || !existing[0].values.length) {
    db.run("INSERT OR IGNORE INTO settings VALUES ('project_path', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('ollama_model', 'qwen2.5-coder:32b-instruct')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('ollama_url', 'http://localhost:11434')");
  }

  saveDB();
}

function saveDB() {
  const dbPath = path.join(app.getPath('userData'), 'CodeFox.db');
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
  await initDB();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── DB IPC handlers ──────────────────────────────────────────────

ipcMain.handle('db:getAll', (_, table) => {
  try {
    const result = db.exec(`SELECT * FROM ${table} ORDER BY id DESC`);
    if (!result.length) return [];
    const { columns, values } = result[0];
    return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
  } catch { return []; }
});

ipcMain.handle('db:get', (_, table, id) => {
  const result = db.exec(`SELECT * FROM ${table} WHERE id = ${id}`);
  if (!result.length) return null;
  const { columns, values } = result[0];
  return Object.fromEntries(columns.map((c, i) => [c, values[0][i]]));
});

ipcMain.handle('db:insert', (_, table, data) => {
  const keys = Object.keys(data).join(', ');
  const placeholders = Object.keys(data).map(() => '?').join(', ');
  const vals = Object.values(data);
  db.run(`INSERT INTO ${table} (${keys}) VALUES (${placeholders})`, vals);
  // Cast to TEXT before returning — BigInt can't be serialized over Electron IPC
  const result = db.exec('SELECT CAST(last_insert_rowid() AS TEXT) as id');
  const id = result[0].values[0][0];
  saveDB();
  console.log('[main db:insert]', table, '-> id:', id, 'typeof:', typeof id);
  return id; // returns as string e.g. "11" — app.js uses Number() to convert
});

ipcMain.handle('db:update', (_, table, id, data) => {
  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const vals = [...Object.values(data), id];
  db.run(`UPDATE ${table} SET ${sets} WHERE id = ?`, vals);
  saveDB();
  return true;
});

ipcMain.handle('db:delete', (_, table, id) => {
  db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  saveDB();
  return true;
});

ipcMain.handle('db:getSetting', (_, key) => {
  const result = db.exec(`SELECT value FROM settings WHERE key = '${key}'`);
  return result.length ? result[0].values[0][0] : null;
});

ipcMain.handle('db:setSetting', (_, key, value) => {
  db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
  saveDB();
  return true;
});

// ── File system IPC handlers ─────────────────────────────────────

ipcMain.handle('fs:readFile', (_, filePath) => {
  try { return { ok: true, content: fs.readFileSync(filePath, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:writeFile', (_, filePath, content) => {
  try { fs.writeFileSync(filePath, content, 'utf8'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:readDir', (_, dirPath) => {
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    return items.map(item => ({
      name: item.name,
      isDir: item.isDirectory(),
      path: path.join(dirPath, item.name)
    })).filter(i => !i.name.startsWith('.') && i.name !== 'node_modules' && i.name !== 'Library' && i.name !== 'Temp');
  } catch (e) { return []; }
});

ipcMain.handle('fs:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

// ── Ollama streaming IPC ─────────────────────────────────────────

ipcMain.handle('ollama:chat', async (event, { messages, systemPrompt, model, ollamaUrl }) => {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: model || 'qwen2.5-coder:32b-instruct',
      messages: [
        { role: 'system', content: systemPrompt || '' },
        ...messages
      ],
      stream: true
    });

    const url = new URL(ollamaUrl || 'http://localhost:11434');
    const options = {
      hostname: url.hostname,
      port: url.port || 11434,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = http.request(options, (res) => {
      let fullContent = '';
      res.on('data', chunk => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.message?.content) {
              fullContent += parsed.message.content;
              event.sender.send('ollama:stream-chunk', parsed.message.content);
            }
            if (parsed.done) {
              event.sender.send('ollama:stream-done');
              resolve(fullContent);
            }
          } catch {}
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
});

// ── Unity bridge ─────────────────────────────────────────────────

ipcMain.handle('unity:refresh', async (_, projectPath) => {
  // Touches a sentinel file that the Unity Editor script watches
  const sentinelPath = path.join(projectPath, 'Assets', '.codefox-refresh-trigger');
  try {
    fs.writeFileSync(sentinelPath, Date.now().toString());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Ollama management IPC ─────────────────────────────────────────

ipcMain.handle('ollama:status', async () => {
  const running = await isOllamaRunning();
  return { running, exePath: findOllamaExe() };
});

ipcMain.handle('ollama:launch', async () => {
  return await launchOllama();
});

ipcMain.handle('ollama:setPath', async (_, customPath) => {
  setCustomOllamaPath(customPath || null);
  return { exePath: findOllamaExe() };
});

ipcMain.handle('ollama:pickExe', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Find ollama.exe',
    filters: [{ name: 'Executable', extensions: ['exe'] }],
    properties: ['openFile']
  });
  if (result.canceled) return null;
  const chosen = result.filePaths[0];
  setCustomOllamaPath(chosen);
  return chosen;
});
