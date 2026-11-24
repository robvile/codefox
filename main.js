const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile } = require('child_process');
const upm = require('./upm-manifest');
const unityBridge = require('./unity-bridge');

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


// ── LLM provider helpers (LM Studio default, Ollama supported) ──
function readSetting(key, fallback) {
  try {
    const r = db.exec(`SELECT value FROM settings WHERE key = '${key}'`);
    if (r.length && r[0].values.length && r[0].values[0][0] != null) return r[0].values[0][0];
  } catch {}
  return fallback;
}

// Normalise an LM Studio base URL: strip trailing slash and any pasted
// /chat/completions suffix, and strip a trailing /v1 so callers can
// always append /v1/models and /v1/chat/completions.
function normalizeLmStudioRoot(raw) {
  let u = String(raw || 'http://localhost:1234/v1').trim();
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/v1\/chat\/completions$/, '').replace(/\/chat\/completions$/, '');
  u = u.replace(/\/v1$/, '');
  return u || 'http://localhost:1234';
}
function lmStudioModelsUrl(base) { return normalizeLmStudioRoot(base) + '/v1/models'; }
function lmStudioChatUrl(base) { return normalizeLmStudioRoot(base) + '/v1/chat/completions'; }
function lmStudioHeaders(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = 'Bearer ' + apiKey;
  return h;
}
async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 5000);
  try {
    const res = await fetch(url, { ...(opts || {}), signal: ctrl.signal });
    return res;
  } finally { clearTimeout(t); }
}
async function listLmStudioModels(base, apiKey) {
  const res = await fetchJson(lmStudioModelsUrl(base), { headers: lmStudioHeaders(apiKey) }, 5000);
  if (!res.ok) throw new Error('LM Studio returned HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  return (data.data || []).map(m => ({ id: m.id }));
}
async function listOllamaModels(base) {
  const root = String(base || 'http://localhost:11434').replace(/\/+$/, '');
  const res = await fetchJson(root + '/api/tags', {}, 5000);
  if (!res.ok) throw new Error('Ollama returned HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  return (data.models || []).map(m => ({ id: m.name }));
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
  // v0.3.0: multi-project workspaces. Threads, rulesets, plans and pages
  // belong to one project; snapshots/file_backups stay global for now.
  db.run(`CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY,
    installed INTEGER NOT NULL DEFAULT 0,
    installed_at TEXT
  )`);
  for (const t of ['threads', 'rulesets', 'plans', 'pages']) {
    try { db.run(`ALTER TABLE ${t} ADD COLUMN project_id INTEGER`); } catch {}
  }

  // v0.4.0: rulesets gain an enabled flag and a priority (higher = sent
  // to the model first) for the Rules budget in Settings.
  try { db.run('ALTER TABLE rulesets ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1'); } catch {}
  try { db.run('ALTER TABLE rulesets ADD COLUMN priority INTEGER NOT NULL DEFAULT 0'); } catch {}

  // Default settings. A brand-new database defaults to LM Studio; an
  // existing database (which already has a project_path) keeps Ollama
  // as its provider so existing users are not switched silently.
  const existing = db.exec("SELECT value FROM settings WHERE key='project_path'");
  const isNewDb = !existing.length || !existing[0].values.length;
  if (isNewDb) {
    db.run("INSERT OR IGNORE INTO settings VALUES ('project_path', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('llm_provider', 'lmstudio')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('lmstudio_url', 'http://localhost:1234/v1')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('lmstudio_model', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('lmstudio_api_key', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('llm_temperature', '0.2')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('llm_max_tokens', '4096')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('unity_exe_path', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('ollama_model', 'qwen2.5-coder:32b-instruct')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('ollama_url', 'http://localhost:11434')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('shell_enabled', '0')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('shell_auto_mode', '0')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('auto_accept_changes', '0')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('shell_auto_approve', '[\"git status\", \"git diff\", \"npm test\", \"npm run test\", \"dotnet build\", \"dotnet test\"]')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('excluded_file_types', '[\"meta\", \"mat\", \"anim\", \"controller\", \"overrideController\", \"physicMaterial\", \"physicsMaterial2D\", \"renderTexture\", \"cubemap\", \"flare\", \"guiskin\", \"avatarMask\", \"terrainlayer\", \"preset\", \"playable\", \"spriteatlas\", \"scenetemplate\", \"shadervariants\", \"lighting\", \"png\", \"jpg\", \"asset\", \"package-lock.json\"]')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('rules_char_budget', '4000')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('use_condensed_rules', '0')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('condensed_rules', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('mcp_servers', '[]')");
  } else {
    // Migration for existing databases: add the new keys without
    // overwriting anything the user already set.
    db.run("INSERT OR IGNORE INTO settings VALUES ('llm_provider', 'ollama')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('lmstudio_url', 'http://localhost:1234/v1')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('lmstudio_model', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('lmstudio_api_key', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('llm_temperature', '0.2')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('llm_max_tokens', '4096')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('unity_exe_path', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('ollama_model', 'qwen2.5-coder:32b-instruct')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('ollama_url', 'http://localhost:11434')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('shell_enabled', '0')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('shell_auto_mode', '0')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('auto_accept_changes', '0')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('shell_auto_approve', '[\"git status\", \"git diff\", \"npm test\", \"npm run test\", \"dotnet build\", \"dotnet test\"]')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('excluded_file_types', '[\"meta\", \"mat\", \"anim\", \"controller\", \"overrideController\", \"physicMaterial\", \"physicsMaterial2D\", \"renderTexture\", \"cubemap\", \"flare\", \"guiskin\", \"avatarMask\", \"terrainlayer\", \"preset\", \"playable\", \"spriteatlas\", \"scenetemplate\", \"shadervariants\", \"lighting\", \"png\", \"jpg\", \"asset\", \"package-lock.json\"]')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('rules_char_budget', '4000')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('use_condensed_rules', '0')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('condensed_rules', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('mcp_servers', '[]')");
  }

  // v0.5.0: max agent-loop rounds (default 5, range 1–10).
  db.run("INSERT OR IGNORE INTO settings VALUES ('agent_max_rounds', '5')");

  // ── v0.3.0 migration: one project row per workspace ─────────────
  // If no projects exist, create one from the existing project_path
  // setting (name = last folder segment, or "My Project" if empty)
  // and make it active. Existing rows get the active project's id.
  const projCount = db.exec('SELECT COUNT(*) as c FROM projects');
  const projTotal = projCount.length ? projCount[0].values[0][0] : 0;
  let activeProjectId = readSetting('active_project_id', null);
  if (projTotal === 0) {
    const ppath = readSetting('project_path', '') || '';
    const segs = String(ppath).split(/[\\/]+/).filter(Boolean);
    const pname = segs.length ? segs[segs.length - 1] : 'My Project';
    db.run('INSERT INTO projects (name, path) VALUES (?, ?)', [pname, ppath]);
    const idRes = db.exec('SELECT CAST(last_insert_rowid() AS TEXT) as id');
    activeProjectId = idRes.length ? idRes[0].values[0][0] : null;
    if (activeProjectId) {
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('active_project_id', ?)", [String(activeProjectId)]);
    }
  } else if (!activeProjectId) {
    const first = db.exec('SELECT CAST(id AS TEXT) as id FROM projects ORDER BY id ASC LIMIT 1');
    if (first.length) {
      activeProjectId = first[0].values[0][0];
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('active_project_id', ?)", [String(activeProjectId)]);
    }
  }
  if (activeProjectId) {
    for (const t of ['threads', 'rulesets', 'plans', 'pages']) {
      try { db.run(`UPDATE ${t} SET project_id = ? WHERE project_id IS NULL`, [Number(activeProjectId)]); } catch {}
    }
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
    icon: path.join(__dirname, 'build', 'icon.png'),
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
  // Auto-install the bridge for the already-connected active project
  // (v0.5.0): the project was connected in an earlier session, so no
  // create / switch / update call will trigger it. Silent when the
  // bridge is already there or the folder is not a Unity project.
  try { unityBridge.ensureBridge(readSetting('project_path', ''), __dirname); } catch {}
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

// ── Project workspaces (v0.3.0) ────────────────────────────────────
function projectRows() {
  const result = db.exec('SELECT id, name, path, created_at FROM projects ORDER BY id ASC');
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}
function projectById(id) {
  const result = db.exec(`SELECT id, name, path, created_at FROM projects WHERE id = ${Number(id)}`);
  if (!result.length) return null;
  const { columns, values } = result[0];
  return Object.fromEntries(columns.map((c, i) => [c, values[0][i]]));
}
function setActiveProject(project) {
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('active_project_id', ?)", [String(project.id)]);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('project_path', ?)", [project.path || '']);
  saveDB();
}

ipcMain.handle('project:list', () => projectRows());

ipcMain.handle('project:create', (_, name, projectPath) => {
  const cleanName = String(name || '').trim() || 'My Project';
  db.run('INSERT INTO projects (name, path) VALUES (?, ?)', [cleanName, projectPath || '']);
  const project = projectById(db.exec('SELECT CAST(last_insert_rowid() AS TEXT) as id')[0].values[0][0]);
  setActiveProject(project);
  // Connecting a project installs its bridge automatically (v0.5.0).
  const bridge = unityBridge.ensureBridge(project.path || '', __dirname);
  return { ...project, bridge };
});

ipcMain.handle('project:switch', (_, id) => {
  const project = projectById(id);
  if (!project) return null;
  setActiveProject(project);
  // Switching to a project installs its bridge automatically (v0.5.0).
  const bridge = unityBridge.ensureBridge(project.path || '', __dirname);
  return { ...project, bridge };
});

ipcMain.handle('project:update', (_, id, data) => {
  const project = projectById(id);
  if (!project) return false;
  const name = data && data.name != null ? String(data.name).trim() || project.name : project.name;
  const projectPath = data && data.path != null ? String(data.path) : project.path;
  db.run('UPDATE projects SET name = ?, path = ? WHERE id = ?', [name, projectPath, Number(id)]);
  const activeId = readSetting('active_project_id', null);
  if (activeId != null && Number(activeId) === Number(id)) {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('project_path', ?)", [projectPath]);
  }
  saveDB();
  // Changing a project's folder connects it — install its bridge
  // automatically when the new folder is a Unity project (v0.5.0).
  if (data && data.path != null) unityBridge.ensureBridge(projectPath, __dirname);
  return true;
});

// Deleting a project deletes its threads (and their messages), pages,
// plans and rulesets with it. Refused when it is the last project left.
ipcMain.handle('project:delete', (_, id) => {
  const all = projectRows();
  if (all.length <= 1) return { ok: false, error: 'Cannot delete the last project.' };
  const target = projectById(id);
  if (!target) return { ok: false, error: 'Project not found.' };
  const pid = Number(id);
  db.run('DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)', [pid]);
  for (const t of ['threads', 'rulesets', 'plans', 'pages']) {
    db.run(`DELETE FROM ${t} WHERE project_id = ?`, [pid]);
  }
  db.run('DELETE FROM projects WHERE id = ?', [pid]);
  let nextActive = null;
  const activeId = readSetting('active_project_id', null);
  if (activeId != null && Number(activeId) === pid) {
    const remaining = projectRows();
    nextActive = remaining[0] || null;
    if (nextActive) setActiveProject(nextActive);
  }
  saveDB();
  return { ok: true, activeProjectId: nextActive ? nextActive.id : null };
});

// ── Skills install state (v0.3.0) ──────────────────────────────────
ipcMain.handle('skills:list', () => {
  const result = db.exec('SELECT name, installed, installed_at FROM skills');
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
});

ipcMain.handle('skills:set', (_, name, installed) => {
  const on = installed ? 1 : 0;
  db.run('INSERT OR REPLACE INTO skills (name, installed, installed_at) VALUES (?, ?, ?)',
    [String(name), on, on ? new Date().toISOString() : null]);
  saveDB();
  return true;
});

// ── File system IPC handlers ─────────────────────────────────────

ipcMain.handle('fs:readFile', (_, filePath) => {
  try { return { ok: true, content: fs.readFileSync(filePath, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:writeFile', (_, filePath, content) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8'); return { ok: true };
  }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('fs:deleteFile', (_, filePath) => {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Move a file AND its .meta sibling (preserves the Unity GUID).
ipcMain.handle('fs:moveFile', (_, srcPath, destPath) => {
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.renameSync(srcPath, destPath);
    const srcMeta = srcPath + '.meta';
    if (fs.existsSync(srcMeta)) fs.renameSync(srcMeta, destPath + '.meta');
    return { ok: true };
  }
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

ipcMain.handle('fs:pickExe', async (_, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Select an executable',
    filters: [{ name: 'Executable', extensions: ['exe'] }],
    properties: ['openFile']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('fs:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('fs:exists', (_, filePath) => {
  try { return !!filePath && fs.existsSync(filePath); }
  catch { return false; }
});

// ── Unified LLM IPC (LM Studio + Ollama) ─────────────────────────

function resolveLlmConfig(payload) {
  const provider = (payload && payload.provider) || readSetting('llm_provider', 'lmstudio') || 'lmstudio';
  const temperature = payload && payload.temperature != null ? Number(payload.temperature)
    : Number(readSetting('llm_temperature', '0.2') || 0.2);
  const maxTokens = payload && payload.maxTokens != null ? Number(payload.maxTokens)
    : Number(readSetting('llm_max_tokens', '4096') || 4096);
  if (provider === 'ollama') {
    return {
      provider, temperature, maxTokens,
      model: (payload && payload.model) || readSetting('ollama_model', 'qwen2.5-coder:32b-instruct'),
      url: (payload && payload.ollamaUrl) || readSetting('ollama_url', 'http://localhost:11434'),
    };
  }
  return {
    provider, temperature, maxTokens,
    model: (payload && payload.model) || readSetting('lmstudio_model', ''),
    url: (payload && payload.lmstudioUrl) || readSetting('lmstudio_url', 'http://localhost:1234/v1'),
    apiKey: (payload && payload.lmstudioApiKey) || readSetting('lmstudio_api_key', ''),
  };
}

ipcMain.handle('llm:status', async () => {
  const cfg = resolveLlmConfig({});
  try {
    const models = cfg.provider === 'ollama'
      ? await listOllamaModels(cfg.url)
      : await listLmStudioModels(cfg.url, cfg.apiKey);
    return { provider: cfg.provider, running: true, url: cfg.url, model: cfg.model, modelsAvailable: models.length, models };
  } catch (e) {
    return { provider: cfg.provider, running: false, url: cfg.url, model: cfg.model, modelsAvailable: 0, error: e.message };
  }
});

ipcMain.handle('llm:listModels', async (_, payload) => {
  const cfg = resolveLlmConfig(payload || {});
  try {
    const models = cfg.provider === 'ollama'
      ? await listOllamaModels(cfg.url)
      : await listLmStudioModels(cfg.url, cfg.apiKey);
    return { ok: true, provider: cfg.provider, models };
  } catch (e) {
    return { ok: false, provider: cfg.provider, error: e.message, models: [] };
  }
});

// Verify: connection + model list, plus a tiny non-streaming chat probe
// ONLY when a model is selected. No model selected is not a failure.
ipcMain.handle('llm:verify', async (_, payload) => {
  const cfg = resolveLlmConfig(payload || {});
  try {
    const models = cfg.provider === 'ollama'
      ? await listOllamaModels(cfg.url)
      : await listLmStudioModels(cfg.url, cfg.apiKey);
    const result = { ok: true, provider: cfg.provider, url: cfg.url, models, model: cfg.model, probe: null };
    if (!cfg.model) {
      result.message = 'Connected — ' + models.length + ' model(s) found. Pick a model to finish setup.';
      return result;
    }
    if (!models.some(m => m.id === cfg.model)) {
      result.ok = false;
      result.error = 'Model "' + cfg.model + '" is not loaded on the server. Loaded models: ' + (models.map(m => m.id).join(', ') || 'none');
      return result;
    }
    // Tiny probe (non-streaming, 5 tokens).
    if (cfg.provider === 'ollama') {
      const res = await fetchJson(String(cfg.url).replace(/\/+$/, '') + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false }),
      }, 30000);
      if (!res.ok) throw new Error('Ollama probe failed: HTTP ' + res.status);
      result.probe = 'ok';
    } else {
      const res = await fetchJson(lmStudioChatUrl(cfg.url), {
        method: 'POST', headers: lmStudioHeaders(cfg.apiKey),
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'Reply with OK.' }], temperature: 0, max_tokens: 5, stream: false }),
      }, 30000);
      if (!res.ok) throw new Error('LM Studio probe failed: HTTP ' + res.status + ' — ' + (await res.text()).slice(0, 300));
      result.probe = 'ok';
    }
    result.message = 'Connected — model "' + cfg.model + '" answered the probe.';
    return result;
  } catch (e) {
    return { ok: false, provider: cfg.provider, url: cfg.url, model: cfg.model, error: e.message, models: [] };
  }
});

async function lmStudioChat(event, cfg, messages, systemPrompt) {
  const res = await fetch(lmStudioChatUrl(cfg.url), {
    method: 'POST',
    headers: lmStudioHeaders(cfg.apiKey),
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'system', content: systemPrompt || '' }, ...messages],
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      stream: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('LM Studio returned HTTP ' + res.status + (body ? ': ' + body.slice(0, 500) : ''));
  }
  let fullContent = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const emit = (text) => {
    if (!text) return;
    fullContent += text;
    event.sender.send('llm:stream-chunk', text);
    event.sender.send('ollama:stream-chunk', text); // legacy listeners
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          event.sender.send('llm:stream-done');
          event.sender.send('ollama:stream-done');
          return fullContent;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
          const content = (delta && delta.content) || (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || '';
          emit(content);
        } catch {}
      }
    }
  } finally { try { reader.releaseLock(); } catch {} }
  event.sender.send('llm:stream-done');
  event.sender.send('ollama:stream-done');
  return fullContent;
}

function ollamaChat(event, cfg, messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: cfg.model || 'qwen2.5-coder:32b-instruct',
      messages: [{ role: 'system', content: systemPrompt || '' }, ...messages],
      stream: true
    });
    const url = new URL(cfg.url || 'http://localhost:11434');
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
              event.sender.send('llm:stream-chunk', parsed.message.content);
              event.sender.send('ollama:stream-chunk', parsed.message.content);
            }
            if (parsed.done) {
              event.sender.send('llm:stream-done');
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
}

ipcMain.handle('llm:chat', async (event, payload) => {
  const cfg = resolveLlmConfig(payload || {});
  if (!cfg.model) throw new Error('No model selected. Open Settings, verify the connection, and pick a model.');
  const messages = (payload && payload.messages) || [];
  const systemPrompt = (payload && payload.systemPrompt) || '';
  if (cfg.provider === 'ollama') return ollamaChat(event, cfg, messages, systemPrompt);
  return lmStudioChat(event, cfg, messages, systemPrompt);
});

// Legacy Ollama chat handler — routes through the unified path.
ipcMain.handle('ollama:chat', async (event, payload) => {
  const cfg = resolveLlmConfig({ ...(payload || {}), provider: 'ollama' });
  return ollamaChat(event, cfg, (payload && payload.messages) || [], (payload && payload.systemPrompt) || '');
});

// ── Project scan ─────────────────────────────────────────────────
const SCAN_IGNORE = new Set(['.git', 'Library', 'Temp', 'obj', 'bin', 'node_modules', '.vs', 'Logs', '.idea', 'dist']);
const DEFAULT_EXCLUDED_FILE_TYPES = ['meta', 'mat', 'anim', 'controller', 'overrideController', 'physicMaterial', 'physicsMaterial2D', 'renderTexture', 'cubemap', 'flare', 'guiskin', 'avatarMask', 'terrainlayer', 'preset', 'playable', 'spriteatlas', 'scenetemplate', 'shadervariants', 'lighting', 'png', 'jpg', 'asset', 'package-lock.json'];
function excludedFileList() {
  try {
    const v = JSON.parse(readSetting('excluded_file_types', '[]'));
    if (Array.isArray(v)) return v;
  } catch {}
  return DEFAULT_EXCLUDED_FILE_TYPES;
}
// A name is excluded when it matches an entry exactly (e.g.
// package-lock.json) or ends with '.' + an entry (e.g. .meta, .png).
function isExcludedFile(name) {
  const lower = String(name || '').toLowerCase();
  for (const entry of excludedFileList()) {
    const e = String(entry).toLowerCase();
    if (!e) continue;
    if (lower === e || lower.endsWith('.' + e)) return true;
  }
  return false;
}
function walkProject(dir, out, depth) {
  if (depth > 12) return;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const item of items) {
    if (SCAN_IGNORE.has(item.name) || item.name.startsWith('.codefox')) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walkProject(full, out, depth + 1);
    else if (item.isFile() && !isExcludedFile(item.name)) out.push(full);
  }
}
function parseUnityNames(filePath, cap) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const names = [];
    const re = /m_Name:\s*(.+)/g;
    let m;
    while ((m = re.exec(text)) && names.length < cap) names.push(m[1].trim());
    return names;
  } catch { return []; }
}
ipcMain.handle('project:scan', async (_, projectPath) => {
  const root = projectPath || readSetting('project_path', '');
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'No project folder set. Pick one in Settings.' };
  const files = [];
  walkProject(root, files, 0);
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  const scripts = files.filter(f => f.endsWith('.cs')).map(rel).slice(0, 300);
  const scenes = files.filter(f => f.endsWith('.unity')).slice(0, 50)
    .map(f => ({ path: rel(f), gameObjects: parseUnityNames(f, 40) }));
  const prefabs = files.filter(f => f.endsWith('.prefab')).slice(0, 100)
    .map(f => ({ path: rel(f), gameObjects: parseUnityNames(f, 40) }));
  let unityVersion = null;
  try {
    const pv = fs.readFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8');
    const m = pv.match(/m_EditorVersion:\s*(.+)/);
    if (m) unityVersion = m[1].trim();
  } catch {}
  let packages = {};
  try {
    const man = JSON.parse(fs.readFileSync(path.join(root, 'Packages', 'manifest.json'), 'utf8'));
    packages = man.dependencies || {};
  } catch {}
  // Resolved versions from packages-lock.json, when Unity has written
  // one — the model sees both the requested and the resolved version.
  let locked = {};
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'Packages', 'packages-lock.json'), 'utf8'));
    for (const [name, entry] of Object.entries(lock.dependencies || {})) {
      locked[name] = (entry && entry.version) || '';
    }
  } catch {}
  const assetsByExt = {};
  for (const f of files) {
    const ext = path.extname(f).toLowerCase() || '(no ext)';
    assetsByExt[ext] = (assetsByExt[ext] || 0) + 1;
  }
  const tree = {};
  for (const f of files) {
    const top = rel(f).split('/')[0];
    tree[top] = (tree[top] || 0) + 1;
  }
  return {
    ok: true, projectPath: root, unityVersion, packages, locked,
    scenes, prefabs, scripts, scriptCount: files.filter(f => f.endsWith('.cs')).length,
    fileCount: files.length, assetsByExt, tree,
  };
});

// ── Unity tests / build check ────────────────────────────────────
function runProcess(cmd, args, opts, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let proc;
    try { proc = spawn(cmd, args, opts); } catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e), timedOut: false }); }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve({ code: -1, stdout, stderr, timedOut: true }); }, timeoutMs);
    proc.stdout && proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr && proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + '\n' + e.message, timedOut: false }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout, stderr, timedOut: false }); });
  });
}
const tail = (s, n) => String(s || '').slice(-(n || 4000));

ipcMain.handle('unity:runTests', async (_, payload) => {
  const projectPath = (payload && payload.projectPath) || readSetting('project_path', '');
  const exePath = (payload && payload.unityExePath) || readSetting('unity_exe_path', '');
  if (!exePath) return { ok: false, error: 'No Unity Editor path set. Open Settings and set the Unity Editor exe path (e.g. Unity.exe), then try again.' };
  if (!fs.existsSync(exePath)) return { ok: false, error: 'Unity Editor not found at: ' + exePath + '. Check the path in Settings.' };
  if (!projectPath || !fs.existsSync(projectPath)) return { ok: false, error: 'No project folder set.' };
  const resultsPath = path.join(require('os').tmpdir(), 'codefox-test-results.xml');
  const r = await runProcess(exePath, ['-batchmode', '-quit', '-projectPath', projectPath, '-runTests', '-testPlatform', 'EditMode', '-testResults', resultsPath], { windowsHide: true }, 10 * 60 * 1000);
  if (r.timedOut) return { ok: false, error: 'Test run timed out after 10 minutes.', rawTail: tail(r.stdout + r.stderr) };
  let summary = null;
  try {
    if (fs.existsSync(resultsPath)) {
      const xml = fs.readFileSync(resultsPath, 'utf8');
      const attr = (name) => { const m = xml.match(new RegExp(name + '="([0-9]+)"')); return m ? Number(m[1]) : null; };
      const passed = (xml.match(/result="Passed"/g) || []).length;
      const failed = (xml.match(/result="Failed"/g) || []).length;
      const skipped = (xml.match(/result="Skipped"/g) || []).length;
      summary = { total: attr('total') ?? (passed + failed + skipped), passed: attr('passed') ?? passed, failed: attr('failed') ?? failed, skipped: attr('skipped') ?? skipped };
    }
  } catch {}
  return { ok: summary ? summary.failed === 0 : r.code === 0, exitCode: r.code, summary, resultsPath, rawTail: tail(r.stdout + r.stderr) };
});

ipcMain.handle('unity:buildCheck', async (_, payload) => {
  const projectPath = (payload && payload.projectPath) || readSetting('project_path', '');
  if (!projectPath || !fs.existsSync(projectPath)) return { ok: false, error: 'No project folder set.' };
  const files = [];
  walkProject(projectPath, files, 0);
  const solution = files.find(f => f.endsWith('.sln') || f.endsWith('.csproj'));
  if (!solution) return { ok: false, error: 'no .NET solution found' };
  const dir = path.dirname(solution);
  const r = await runProcess('dotnet', ['build', '--nologo', '-v', 'q'], { cwd: dir, windowsHide: true }, 5 * 60 * 1000);
  if (r.timedOut) return { ok: false, error: 'Build timed out after 5 minutes.', rawTail: tail(r.stdout + r.stderr) };
  return { ok: r.code === 0, exitCode: r.code, solution: path.relative(projectPath, solution), rawTail: tail(r.stdout + '\n' + r.stderr) };
});

// ── Unity bridge ─────────────────────────────────────────────────

// Writes the refresh sentinel the Unity bridge watches (same trigger
// the bridge install uses). Shared by unity:refresh and the package
// handlers so a manifest edit is picked up by Unity.
function writeRefreshTrigger(projectPath) {
  try {
    fs.writeFileSync(path.join(projectPath, 'Assets', '.codefox-refresh-trigger'), Date.now().toString());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Manifest edits go through the shared helper in upm-manifest.js:
// it backs the manifest up to manifest.json.codefox-bak first, then
// applies the mutator and writes the JSON back with 2-space indent.
// The helper is plain Node (no Electron) so the smoke test can
// exercise it directly.
function updateManifest(projectPath, mutator) {
  return upm.updateManifest(projectPath, mutator);
}

ipcMain.handle('unity:refresh', async (_, projectPath) => {
  // Touches a sentinel file that the Unity Editor script watches
  return writeRefreshTrigger(projectPath);
});

// Copies the bundled companion script into the project's Assets/Editor
// folder (creating it if needed). The source is the bundled file when
// the install has it, and the embedded copy (unity-bridge-source.js,
// regenerated by scripts/embed-bridge.js at build time) when it does
// not — so installing the bridge never fails for a missing source
// file. A failure that is reported is the real filesystem error.
ipcMain.handle('unity:installBridge', async (_, projectPath) => {
  const root = projectPath || readSetting('project_path', '');
  return unityBridge.installBridgeFile(root, __dirname);
});

// Install the bridge for a project that does not have it yet.
// No-ops when it is already there; skips when the folder has no
// Assets folder. Used by the Connections view and by the project
// connect / startup paths, which call ensureBridge directly.
ipcMain.handle('unity:ensureBridge', async (_, projectPath) => {
  const root = projectPath || readSetting('project_path', '');
  return unityBridge.ensureBridge(root, __dirname);
});

// Removes the companion script from the project's Assets/Editor folder
// (and the refresh sentinel if one is present). Returns whether the
// bridge file was actually there.
ipcMain.handle('unity:removeBridge', async (_, projectPath) => {
  const root = projectPath || readSetting('project_path', '');
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'No project folder set.' };
  const dest = path.join(root, 'Assets', 'Editor', 'CodeFoxBridge.cs');
  const sentinel = path.join(root, 'Assets', '.codefox-refresh-trigger');
  let removed = false;
  try {
    if (fs.existsSync(dest)) { fs.unlinkSync(dest); removed = true; }
    if (fs.existsSync(sentinel)) fs.unlinkSync(sentinel);
    return { ok: true, removed };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Unity Package Manager (v0.5.0, manifest-based) ───────────────
// CodeFox edits <project>/Packages/manifest.json directly — it does
// not talk to Unity's Package Manager API. Unity resolves the
// packages itself when it refreshes (triggered below via the same
// sentinel the bridge watches). Every edit is backed up first to
// Packages/manifest.json.codefox-bak by updateManifest.
ipcMain.handle('unity:listPackages', async (_, projectPath) => {
  const root = projectPath || readSetting('project_path', '');
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'No project folder set.' };
  const read = upm.readManifest(root);
  if (!read.ok) return read;
  const locked = {};
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'Packages', 'packages-lock.json'), 'utf8'));
    for (const [name, entry] of Object.entries(lock.dependencies || {})) {
      locked[name] = (entry && entry.version) || '';
    }
  } catch {}
  return { ok: true, dependencies: read.manifest.dependencies || {}, scopedRegistries: read.manifest.scopedRegistries || [], locked };
});

ipcMain.handle('unity:addPackage', async (_, payload) => {
  const root = (payload && payload.projectPath) || readSetting('project_path', '');
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'No project folder set.' };
  const name = String((payload && payload.name) || '').trim();
  const version = String((payload && payload.version) || '').trim();
  if (!upm.isValidPackageName(name)) {
    return { ok: false, error: 'Invalid package name "' + name + '". Package names look like com.unity.textmeshpro.' };
  }
  if (!upm.isValidPackageVersion(version)) {
    return { ok: false, error: 'Invalid version "' + version + '". Use a version like 3.0.6, a git URL, or a tarball / file path.' };
  }
  const res = updateManifest(root, (manifest) => {
    manifest.dependencies[name] = version;
    return { name, version };
  });
  if (!res.ok) return res;
  writeRefreshTrigger(root);
  return { ok: true, name, version, backup: res.backup };
});

ipcMain.handle('unity:removePackage', async (_, payload) => {
  const root = (payload && payload.projectPath) || readSetting('project_path', '');
  if (!root || !fs.existsSync(root)) return { ok: false, error: 'No project folder set.' };
  const name = String((payload && payload.name) || '').trim();
  if (!upm.isValidPackageName(name)) {
    return { ok: false, error: 'Invalid package name "' + name + '".' };
  }
  const read = upm.readManifest(root);
  if (!read.ok) return read;
  if (!read.manifest.dependencies || !(name in read.manifest.dependencies)) {
    return { ok: false, error: 'Package "' + name + '" is not in Packages/manifest.json.' };
  }
  const res = updateManifest(root, (manifest) => {
    delete manifest.dependencies[name];
    return { name };
  });
  if (!res.ok) return res;
  writeRefreshTrigger(root);
  return { ok: true, name, backup: res.backup };
});

// ── Shell execution (Settings > Advanced) ─────────────────────────
// Runs one command through the system shell. Refused outright while
// the shell tool is off (Settings > Advanced, default off). On Windows
// this is PowerShell (pwsh if powershell.exe is missing); elsewhere it
// is the system shell via sh -c. 60-second timeout, output truncated
// to 8000 characters per stream.
ipcMain.handle('shell:run', async (_, payload) => {
  if (readSetting('shell_enabled', '0') !== '1') {
    return { ok: false, error: 'Shell tool is disabled. Turn it on in Settings > Advanced to run commands.' };
  }
  const command = String((payload && payload.command) || '').trim();
  if (!command) return { ok: false, error: 'No command given.' };
  const cwd = (payload && payload.cwd) || readSetting('project_path', '') || undefined;
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'powershell.exe' : 'sh';
  const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
  let r = await runProcess(shell, args, { cwd, windowsHide: true }, 60000);
  // powershell.exe missing (e.g. a minimal Windows install) — retry with pwsh.
  if (isWin && r.code === -1 && /ENOENT/i.test(r.stderr || '')) {
    r = await runProcess('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true }, 60000);
  }
  if (r.timedOut) return { ok: false, error: 'Command timed out after 60 seconds.', stdout: String(r.stdout || '').slice(0, 8000), stderr: String(r.stderr || '').slice(0, 8000) };
  return { ok: r.code === 0, code: r.code, stdout: String(r.stdout || '').slice(0, 8000), stderr: String(r.stderr || '').slice(0, 8000) };
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
