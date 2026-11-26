const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile } = require('child_process');
const upm = require('./upm-manifest');
const unityBridge = require('./unity-bridge');
const comfyui = require('./comfyui');
// Static data the renderer needs (v0.6.4) — see 'app:staticData'
// below. The main process is plain Node and can require these;
// the preload cannot (real Electron refuses local requires there).
const { UNITY_ASSET_EXTS } = require('./unity-assets');
const { MCP_PRESETS } = require('./mcp-presets');
const lmLoad = require('./lmstudio-load');

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
    db.run("INSERT OR IGNORE INTO settings VALUES ('auto_apply_unity_assets', '1')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('shell_auto_approve', '[\"git status\", \"git diff\", \"npm test\", \"npm run test\", \"dotnet build\", \"dotnet test\"]')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('excluded_file_types', '[\"meta\", \"mat\", \"anim\", \"controller\", \"overrideController\", \"physicMaterial\", \"physicsMaterial2D\", \"renderTexture\", \"cubemap\", \"flare\", \"guiskin\", \"avatarMask\", \"terrainlayer\", \"preset\", \"playable\", \"spriteatlas\", \"scenetemplate\", \"shadervariants\", \"lighting\", \"png\", \"jpg\", \"asset\", \"package-lock.json\"]')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('rules_char_budget', '4000')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('use_condensed_rules', '0')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('condensed_rules', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('mcp_servers', '[]')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('comfyui_url', 'http://127.0.0.1:8188')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('comfyui_enabled', '1')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('comfyui_workflows_dir', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('comfyui_workflows', '[]')");
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
    db.run("INSERT OR IGNORE INTO settings VALUES ('auto_apply_unity_assets', '1')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('shell_auto_approve', '[\"git status\", \"git diff\", \"npm test\", \"npm run test\", \"dotnet build\", \"dotnet test\"]')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('excluded_file_types', '[\"meta\", \"mat\", \"anim\", \"controller\", \"overrideController\", \"physicMaterial\", \"physicsMaterial2D\", \"renderTexture\", \"cubemap\", \"flare\", \"guiskin\", \"avatarMask\", \"terrainlayer\", \"preset\", \"playable\", \"spriteatlas\", \"scenetemplate\", \"shadervariants\", \"lighting\", \"png\", \"jpg\", \"asset\", \"package-lock.json\"]')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('rules_char_budget', '4000')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('use_condensed_rules', '0')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('condensed_rules', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('mcp_servers', '[]')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('comfyui_url', 'http://127.0.0.1:8188')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('comfyui_enabled', '1')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('comfyui_workflows_dir', '')");
    db.run("INSERT OR IGNORE INTO settings VALUES ('comfyui_workflows', '[]')");
  }

  // v0.5.0: max agent-loop rounds (default 5, range 1–10).
  db.run("INSERT OR IGNORE INTO settings VALUES ('agent_max_rounds', '5')");

  // v0.5.1: auto-apply new Unity-native asset files (default on).
  db.run("INSERT OR IGNORE INTO settings VALUES ('auto_apply_unity_assets', '1')");

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
  // Auto-install (or auto-update, v0.5.2) the bridge for the
  // already-connected active project: the project was connected in
  // an earlier session, so no create / switch / update call will
  // trigger it. Silent when the bridge is already current, when the
  // folder is not a Unity project, or when the user toggled the
  // bridge off for this project.
  try {
    unityBridge.ensureBridge(readSetting('project_path', ''), __dirname,
      { enabled: bridgeEnabledForProject(readSetting('active_project_id', null)) });
  } catch {}
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

// v0.5.1: discard a snapshot (Keep changes). Deletes the snapshot
// row and every backed-up file row that belongs to it, so the change
// can no longer be reverted — only ever called from an explicit
// Keep click, never automatically.
ipcMain.handle('db:deleteSnapshot', (_, snapshotId) => {
  db.run(`DELETE FROM file_backups WHERE snapshot_id = ?`, [snapshotId]);
  db.run(`DELETE FROM snapshots WHERE id = ?`, [snapshotId]);
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

// ── Unity bridge on/off per project (v0.5.2) ───────────────────────
// The toggle in Settings → Connections persists here, keyed by
// project id ('bridge_enabled_<id>', '1' = on, '0' = off; no key
// means on). Every auto-install / auto-update path must consult it:
// without it, the Connections view re-rendered right after a
// toggle-off and its auto-install put the bridge straight back, so
// the toggle appeared to never change.
function projectIdByPath(projectPath) {
  try {
    const result = db.exec(`SELECT id FROM projects WHERE path = '${String(projectPath || '').replace(/'/g, "''")}'`);
    if (result.length && result[0].values.length) return result[0].values[0][0];
  } catch {}
  return null;
}
function bridgeEnabledForProject(projectId) {
  if (projectId == null) return true;
  return readSetting('bridge_enabled_' + projectId, '1') !== '0';
}
function setBridgeEnabled(projectId, enabled) {
  if (projectId == null) return;
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['bridge_enabled_' + projectId, enabled ? '1' : '0']);
  saveDB();
}

ipcMain.handle('project:list', () => projectRows());

ipcMain.handle('project:create', (_, name, projectPath) => {
  const cleanName = String(name || '').trim() || 'My Project';
  db.run('INSERT INTO projects (name, path) VALUES (?, ?)', [cleanName, projectPath || '']);
  const project = projectById(db.exec('SELECT CAST(last_insert_rowid() AS TEXT) as id')[0].values[0][0]);
  setActiveProject(project);
  // Connecting a project installs its bridge automatically (v0.5.0).
  // A new project has the bridge on by default.
  const bridge = unityBridge.ensureBridge(project.path || '', __dirname, { enabled: bridgeEnabledForProject(project.id) });
  return { ...project, bridge };
});

ipcMain.handle('project:switch', (_, id) => {
  const project = projectById(id);
  if (!project) return null;
  setActiveProject(project);
  // Switching to a project installs its bridge automatically (v0.5.0)
  // — unless the user toggled it off for that project (v0.5.2).
  const bridge = unityBridge.ensureBridge(project.path || '', __dirname, { enabled: bridgeEnabledForProject(project.id) });
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
  // automatically when the new folder is a Unity project (v0.5.0),
  // unless the bridge is toggled off for this project (v0.5.2).
  if (data && data.path != null) unityBridge.ensureBridge(projectPath, __dirname, { enabled: bridgeEnabledForProject(id) });
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

// Downloaded models (LM Studio only): GET /api/v1/models lists ALL
// models on the system, downloaded or not, with loaded_instances
// (empty when not loaded) — unlike the OpenAI-compatible /v1/models,
// which only lists loaded ones. Each entry carries its load state, so
// Settings can offer a Load action per model. On an older server that
// has no such endpoint, fall back to the loaded-only list and say so.
ipcMain.handle('llm:listDownloaded', async (_, payload) => {
  const cfg = resolveLlmConfig(payload || {});
  if (cfg.provider !== 'lmstudio') return { ok: false, provider: cfg.provider, error: 'Downloaded-model listing is only supported for LM Studio.', models: [], downloadedList: false };
  const root = normalizeLmStudioRoot(cfg.url);
  try {
    const res = await fetchJson(root + '/api/v1/models', { headers: lmStudioHeaders(cfg.apiKey) }, 5000);
    if (res.status === 404 || res.status === 405) {
      const loaded = await listLmStudioModels(cfg.url, cfg.apiKey);
      return { ok: true, provider: cfg.provider, downloadedList: false, models: loaded.map(m => ({ id: m.id, displayName: m.id, type: 'llm', loaded: true })) };
    }
    if (!res.ok) throw new Error('LM Studio returned HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    if (!Array.isArray(data.models)) throw new Error('LM Studio answered, but not with a model list.');
    const models = data.models
      .filter(m => !m.type || String(m.type).toLowerCase() === 'llm')
      .map(m => ({
        id: m.key,
        displayName: m.display_name || m.key,
        type: m.type || 'llm',
        quantization: (m.quantization && m.quantization.name) || null,
        params: m.params_string || null,
        sizeBytes: m.size_bytes || null,
        format: m.format || null,
        variant: m.selected_variant || null,
        loaded: Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0,
        recommended: lmLoad.isRecommendedCodingModel(m),
      }));
    return { ok: true, provider: cfg.provider, downloadedList: true, models };
  } catch (e) {
    return { ok: false, provider: cfg.provider, error: e.message, models: [], downloadedList: false };
  }
});

// Load a model into the running LM Studio server with the tuned
// settings (lmstudio-load.js). Explicit only — never on startup, and
// it never unloads other models. The renderer sets it as the active
// model after a successful load.
ipcMain.handle('llm:loadModel', async (_, payload) => {
  const cfg = resolveLlmConfig(payload || {});
  if (cfg.provider !== 'lmstudio') return { ok: false, error: 'Model loading is only supported for LM Studio.' };
  const modelId = String((payload && payload.model) || '').trim();
  if (!modelId) return { ok: false, error: 'No model selected.' };
  try {
    return await lmLoad.loadLmStudioModel({
      modelId,
      baseUrl: normalizeLmStudioRoot(cfg.url),
      apiKey: cfg.apiKey,
    });
  } catch (e) {
    return { ok: false, model: modelId, error: e.message };
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
  const res = unityBridge.installBridgeFile(root, __dirname);
  // An explicit install (toggle on / Update plugin) turns the bridge
  // back on for this project.
  if (res.ok) setBridgeEnabled(projectIdByPath(root), true);
  return res;
});

// Install the bridge for a project that does not have it yet, or
// update it when the installed copy is older than the bundled one
// (v0.5.2). No-ops when it is already current; skips when the folder
// has no Assets folder, and when the bridge is toggled off for this
// project. Used by the Connections view and by the project connect /
// startup paths, which call ensureBridge directly.
ipcMain.handle('unity:ensureBridge', async (_, projectPath) => {
  const root = projectPath || readSetting('project_path', '');
  return unityBridge.ensureBridge(root, __dirname, { enabled: bridgeEnabledForProject(projectIdByPath(root)) });
});

// Bridge status for the Settings → Connections row: whether the file
// exists on disk, whether the user has it toggled on for this
// project, the installed vs bundled versions, and whether an update
// is available. The Update plugin button's disabled state is driven
// by updateAvailable (v0.5.2).
ipcMain.handle('unity:bridgeStatus', async (_, projectPath) => {
  const root = projectPath || readSetting('project_path', '');
  const enabled = bridgeEnabledForProject(projectIdByPath(root));
  return {
    exists: unityBridge.bridgeInstalled(root),
    enabled,
    installedVersion: unityBridge.getInstalledBridgeVersion(root),
    bundledVersion: unityBridge.BUNDLED_BRIDGE_VERSION,
    updateAvailable: enabled && unityBridge.isBridgeUpdateAvailable(root),
  };
});

// Removes the companion script from the project's Assets/Editor folder
// (and the refresh sentinel if one is present). Returns whether the
// bridge file was actually there. Turning it off persists (v0.5.2):
// the flag is what stops every auto-install path from putting the
// bridge straight back after a toggle-off.
ipcMain.handle('unity:removeBridge', async (_, projectPath) => {
  const root = projectPath || readSetting('project_path', '');
  setBridgeEnabled(projectIdByPath(root), false);
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


// ── Open a link in the user's browser ────────────────────────────
// Links in guided setup prompts (and the ComfyUI panel) open here,
// never by navigating the app window. Only http(s) URLs are allowed.
ipcMain.handle('shell:openExternal', async (_, url) => {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'Only http(s) links can be opened.' };
  try { await shell.openExternal(u); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── Open a file with its default app (v0.7.1) ────────────────────
// Launches a file the scan actually found on disk (the ComfyUI
// Desktop exe) with the operating system's default handler —
// Electron shell.openPath, never the PowerShell shell tool, which
// is off by default. The path must exist and be an .exe; anything
// else is refused, and a path that was never found on disk is
// never launched.
ipcMain.handle('shell:openPath', async (_, filePath) => {
  const p = String(filePath || '').trim();
  if (!p) return { ok: false, error: 'No file to open.' };
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { ok: false, error: 'File not found: ' + p };
  } catch { return { ok: false, error: 'File not found: ' + p }; }
  if (process.platform === 'win32' && !/\.exe$/i.test(p)) return { ok: false, error: 'Only an executable can be launched this way.' };
  try {
    const err = await shell.openPath(p);
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Diagnostics: open DevTools (v0.6.2) ─────────────────────────
// Settings → Advanced has a "Developer tools" button for this.
// It is the same panel as Ctrl+Shift+I, for users whose keyboard
// shortcut is intercepted by other software. No keyboard shortcut
// is needed. Deliberately tiny: it only opens the panel.
ipcMain.handle('app:openDevTools', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.openDevTools();
  return true;
});

// ── Diagnostics: bridge ping (v0.6.3) ────────────────────────────
// The renderer calls this first thing in init() to prove the bridge
// is alive. app.getVersion() reads the version from package.json.
// If this has no handler or never answers, the renderer shows a
// banner on screen instead of failing silently.
ipcMain.handle('app:ping', () => ({ ok: true, version: app.getVersion() }));

// ── Static data for preload (v0.6.4) ─────────────────────────────
// ROOT CAUSE of the v0.6.0 dead-buttons bug, proven in real Electron:
// preload.js used to load two helper files with require('./…').
// In real Electron that throws ("module not found") — the preload
// never reaches exposeInMainWorld, window.rb is never created, and
// every button that awaits an rb.* call silently does nothing.
// Plain Node never showed it, because require works fine there.
// So the preload must NEVER require a local file (the smoke test
// enforces this), and the two static data tables it needs — the
// Unity asset extensions and the MCP preset list — come from here
// instead, over a synchronous channel. sendSync is safe here: the
// data is small and constant, and this handler is registered at
// load time, before any window (and its preload) exists. The pure
// helpers (isUnityAssetPath, getPreset, buildServerEntry) live in
// preload.js itself, implemented from this data, so the window.rb
// shape the renderer sees is unchanged.
ipcMain.on('app:staticData', (event) => {
  event.returnValue = { unityAssetExts: UNITY_ASSET_EXTS, mcpPresets: MCP_PRESETS };
});

// ── MCP guided-setup checks (v0.6.0) ────────────────────────────
// These are CodeFox's own checks, not user commands: they run even
// when the shell tool is off, via child_process directly, never via
// shell:run. A check reports exactly what was measured — a pass is
// never claimed without a real response from the service or the
// machine. A failed check never blocks adding; the guided prompt
// also offers an "add it anyway" checkbox.
function runWhere(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, [cmd], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ found: false, path: null });
      const p = String(stdout || '').split('\n')[0].trim();
      resolve({ found: !!p, path: p || null });
    });
  });
}
function runVersion(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, output: '' });
      resolve({ ok: true, output: String(stdout || '').trim().split('\n')[0] });
    });
  });
}
async function checkTokenAgainstApi(url, headers, timeoutMs) {
  try {
    const res = await fetchJson(url, { headers }, timeoutMs || 10000);
    if (res.ok) {
      let who = null;
      try { const d = await res.json(); who = (d && (d.name || d.login || d.username || (d.user && d.user.name))) || null; } catch {}
      return { ok: true, checked: true, message: 'Token accepted' + (who ? ' — signed in as ' + who : '') + '.' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, checked: true, message: 'Token rejected (HTTP ' + res.status + ') — check the token and try again.' };
    }
    return { ok: false, checked: true, message: 'Service answered HTTP ' + res.status + ' — the token could not be verified.' };
  } catch (e) {
    return { ok: false, checked: false, message: 'Could not reach the service: ' + (e.message || e) };
  }
}
ipcMain.handle('mcp:checkToken', async (_, payload) => {
  const p = payload || {};
  const presetId = String(p.presetId || '');
  const token = String(p.token || '').trim();
  if (!token && presetId !== 'atlassian' && presetId !== 'trello') {
    return { ok: false, checked: false, message: 'No token given — paste one first.' };
  }
  try {
    if (presetId === 'figma') {
      return await checkTokenAgainstApi('https://api.figma.com/v1/me', { 'X-Figma-Token': token });
    }
    if (presetId === 'github') {
      return await checkTokenAgainstApi('https://api.github.com/user', { Authorization: 'Bearer ' + token, 'User-Agent': 'CodeFox' });
    }
    if (presetId === 'notion') {
      return await checkTokenAgainstApi('https://api.notion.com/v1/users/me', { Authorization: 'Bearer ' + token, 'Notion-Version': '2022-06-28' });
    }
    if (presetId === 'atlassian') {
      const site = String(p.site || '').trim().replace(/\/+$/, '');
      const email = String(p.email || '').trim();
      if (!site || !email || !token) return { ok: false, checked: false, message: 'Site URL, email, and API token are all needed for the check.' };
      if (!/^https?:\/\//i.test(site)) return { ok: false, checked: false, message: 'Site URL must start with https:// — e.g. https://your-team.atlassian.net' };
      const basic = Buffer.from(email + ':' + token).toString('base64');
      return await checkTokenAgainstApi(site + '/rest/api/3/myself', { Authorization: 'Basic ' + basic });
    }
    if (presetId === 'trello') {
      const apiKey = String(p.apiKey || '').trim();
      if (!apiKey || !token) return { ok: false, checked: false, message: 'Both the API key and the token are needed for the check.' };
      return await checkTokenAgainstApi('https://api.trello.com/1/members/me?key=' + encodeURIComponent(apiKey) + '&token=' + encodeURIComponent(token), {});
    }
    return { ok: false, checked: false, message: 'No automatic check for this preset.' };
  } catch (e) {
    return { ok: false, checked: false, message: 'Check failed: ' + (e.message || e) };
  }
});
ipcMain.handle('mcp:checkApp', async (_, payload) => {
  const presetId = String((payload || {}).presetId || '');
  const checks = [];
  try {
    if (presetId === 'blender') {
      const blender = await runWhere('blender');
      const uvx = await runWhere('uvx');
      checks.push({ label: 'Blender on PATH', found: blender.found, detail: blender.found ? blender.path : 'Blender not found on PATH — install Blender 3.0+ first' });
      checks.push({ label: 'uvx on PATH', found: uvx.found, detail: uvx.found ? uvx.path : 'uvx not found on PATH — install uv first' });
      if (uvx.found) {
        const v = await runVersion('uvx', ['--version']);
        checks.push({ label: 'uvx runs', found: v.ok, detail: v.ok ? v.output : 'uvx --version failed' });
      }
    } else if (presetId === 'unity' || presetId === 'git') {
      const uvx = await runWhere('uvx');
      checks.push({ label: 'uvx on PATH', found: uvx.found, detail: uvx.found ? uvx.path : 'uvx not found on PATH — install uv first' });
      if (presetId === 'git') {
        const git = await runWhere('git');
        checks.push({ label: 'git on PATH', found: git.found, detail: git.found ? git.path : 'git not found on PATH — install git first' });
      }
    } else {
      return { ok: false, checked: false, checks: [], message: 'No automatic check for this preset.' };
    }
    const allOk = checks.length > 0 && checks.every(c => c.found);
    return { ok: allOk, checked: true, checks, message: allOk ? 'All prerequisites found.' : 'Some prerequisites are missing — see the list.' };
  } catch (e) {
    return { ok: false, checked: false, checks, message: 'Check failed: ' + (e.message || e) };
  }
});

// ── ComfyUI native integration (v0.6.0) ─────────────────────────
// CodeFox talks to a locally running ComfyUI instance over its own
// HTTP API. Every call is guarded with a timeout and try/catch, and
// the integration is inert until a connection succeeds — a missing
// ComfyUI never blocks the app and no status is ever faked.
let _comfyuiObjectInfoCache = { at: 0, data: null };
ipcMain.handle('comfyui:status', async (_, payload) => {
  const url = (payload && payload.url) || readSetting('comfyui_url', comfyui.DEFAULT_COMFYUI_URL);
  try { return await comfyui.getComfyuiStatus(url); }
  catch (e) { return { ok: false, error: String((e && e.message) || e), url: comfyui.normalizeComfyuiUrl(url) }; }
});
ipcMain.handle('comfyui:objectInfo', async (_, payload) => {
  const url = (payload && payload.url) || readSetting('comfyui_url', comfyui.DEFAULT_COMFYUI_URL);
  if (_comfyuiObjectInfoCache.data && Date.now() - _comfyuiObjectInfoCache.at < 5 * 60 * 1000) {
    const data = _comfyuiObjectInfoCache.data;
    return { ok: true, data, cached: true, capabilities: comfyui.detectCapabilities(data), nodeClasses: comfyui.nodeClassNames(data) };
  }
  try {
    const r = await comfyui.getObjectInfo(url);
    if (r.ok) {
      _comfyuiObjectInfoCache = { at: Date.now(), data: r.data };
      return { ok: true, data: r.data, capabilities: comfyui.detectCapabilities(r.data), nodeClasses: comfyui.nodeClassNames(r.data), cached: false };
    }
    return r;
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('comfyui:queue', async (_, payload) => {
  const url = (payload && payload.url) || readSetting('comfyui_url', comfyui.DEFAULT_COMFYUI_URL);
  try { return await comfyui.getQueue(url); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('comfyui:history', async (_, payload) => {
  const url = (payload && payload.url) || readSetting('comfyui_url', comfyui.DEFAULT_COMFYUI_URL);
  try { return await comfyui.getHistory(url, payload && payload.promptId); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('comfyui:submit', async (_, payload) => {
  const url = (payload && payload.url) || readSetting('comfyui_url', comfyui.DEFAULT_COMFYUI_URL);
  let graph = (payload && payload.prompt) || null;
  let unapplied = [];
  if (!graph && payload && payload.file) {
    // Submit from a stored workflow file: read the graph, then
    // substitute the caller's inputs into a clone — the stored
    // workflow file is never mutated.
    try {
      if (!fs.existsSync(payload.file)) return { ok: false, error: 'Workflow file not found: ' + payload.file };
      const stored = JSON.parse(fs.readFileSync(payload.file, 'utf8'));
      let apiGraph = stored;
      if (comfyui.isUiWorkflowGraph(stored)) {
        // UI-format (Desktop-saved or template): convert with the
        // live node definitions before submitting. The stored
        // file is never mutated, and the conversion is the same
        // one the catalogue used at import time.
        let objectInfo = _comfyuiObjectInfoCache.data || null;
        if (!objectInfo) {
          try {
            const r = await comfyui.getObjectInfo(url);
            if (r.ok) { objectInfo = r.data; _comfyuiObjectInfoCache = { at: Date.now(), data: r.data }; }
            else return { ok: false, error: 'Could not read /object_info to convert this workflow: ' + (r.error || 'ComfyUI not running') };
          } catch (e) { return { ok: false, error: 'Could not read /object_info to convert this workflow: ' + String((e && e.message) || e) }; }
        }
        const converted = comfyui.convertUiGraphToApi(stored, objectInfo);
        if (!converted.ok) return { ok: false, error: 'Could not convert this workflow: ' + converted.error };
        apiGraph = converted.graph;
      }
      const built = comfyui.buildSubmitPrompt(apiGraph, (payload.inputs && typeof payload.inputs === 'object') ? payload.inputs : {});
      graph = built.prompt;
      unapplied = built.unapplied;
    } catch (e) { return { ok: false, error: 'Could not read workflow file: ' + e.message }; }
  }
  if (!graph || typeof graph !== 'object') return { ok: false, error: 'No workflow graph to submit.' };
  try {
    const r = await comfyui.submitPrompt(url, graph, (payload && payload.clientId) || undefined);
    if (r.ok && unapplied.length) r.unapplied = unapplied;
    return r;
  }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// Download one output and save it to destPath on disk. Bytes never
// go base64 through the renderer.
ipcMain.handle('comfyui:view', async (_, payload) => {
  const p = payload || {};
  const url = p.url || readSetting('comfyui_url', comfyui.DEFAULT_COMFYUI_URL);
  if (!p.filename) return { ok: false, error: 'comfyui:view needs a filename.' };
  const destPath = p.destPath || path.join(require('os').tmpdir(), 'codefox-comfyui', String(p.promptId || 'cache'), String(p.filename).split(/[\\/]/).pop());
  try {
    return await comfyui.downloadView(url, { filename: p.filename, subfolder: p.subfolder || '', type: p.type || 'output' }, destPath);
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('comfyui:uploadImage', async (_, payload) => {
  const p = payload || {};
  const url = p.url || readSetting('comfyui_url', comfyui.DEFAULT_COMFYUI_URL);
  if (!p.filePath) return { ok: false, error: 'comfyui:uploadImage needs a filePath.' };
  try { return await comfyui.uploadImage(url, p.filePath, { subfolder: p.subfolder || '', overwrite: !!p.overwrite }); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// Collect the full ComfyUI workflow catalogue: the user's own
// workflows from their workflows folder, plus ComfyUI Desktop's
// built-in templates found on disk by the filesystem scan. The
// server's /api/workflow_templates catalogue supplies titles and
// descriptions for the built-ins when it answers; when it does
// not, the template filenames are used instead. `scan` may be a
// precomputed scanComfyui() result (the scan handler passes its
// own); otherwise the scan runs here. When ComfyUI is not running,
// /object_info cannot be fetched, so UI-format workflows cannot be
// converted and every workflow is marked unavailable with the
// honest reason — never "checked" when it was not. Returns
// { workflows, errors, objectInfoError, desktopExe, templateDirs,
//   templatesMetaOk, scan }.
async function collectComfyuiWorkflows(url, userDir, stored, scan) {
  const root = comfyui.normalizeComfyuiUrl(url);
  let objectInfo = null;
  let objectInfoError = null;
  try {
    const r = await comfyui.getObjectInfo(root);
    if (r.ok) objectInfo = r.data; else objectInfoError = r.error;
  } catch (e) { objectInfoError = String((e && e.message) || e); }
  let templatesMeta = { ok: false, byName: {} };
  if (objectInfo) {
    try { templatesMeta = await comfyui.getWorkflowTemplates(root); }
    catch (e) { templatesMeta = { ok: false, error: String((e && e.message) || e), byName: {} }; }
  }
  const fsScan = scan || (() => { try { return comfyui.scanComfyui(); } catch { return null; } })();
  const errors = [];
  let workflows = [];
  if (userDir) {
    const imported = comfyui.importWorkflowsFromDir(userDir, objectInfo, stored, { recursive: true, source: 'user' });
    if (!imported.ok) {
      errors.push(imported.error);
      // The folder could not be read (a sync hiccup, a moved
      // folder): keep the last-known user workflows — labels and
      // approvals intact — marked unavailable with the reason,
      // instead of wiping the catalogue.
      for (const s of (stored || [])) {
        if (!s || !s.id || s.source === 'builtin') continue;
        workflows.push({ ...s, source: 'user', available: false, availableReason: imported.error });
      }
    } else { workflows = imported.workflows; errors.push(...imported.errors); }
  }
  const templateFiles = [];
  for (const t of ((fsScan && fsScan.templateDirs) || [])) {
    try {
      const files = fs.readdirSync(t.dir).filter(f => f.toLowerCase().endsWith('.json')).sort().map(f => path.join(t.dir, f));
      templateFiles.push(...files);
    } catch {}
  }
  if (templateFiles.length) {
    const builtins = comfyui.importWorkflowsFromFiles(templateFiles, objectInfo, stored, {
      source: 'builtin',
      defaultPurpose: 'Built-in template — from ComfyUI Desktop',
      titleByName: templatesMeta.byName || {},
    });
    workflows = workflows.concat(builtins.workflows);
    errors.push(...builtins.errors);
  }
  if (!objectInfo) {
    for (const w of workflows) {
      w.available = false;
      w.availableReason = 'ComfyUI not running — dependencies not checked yet' + (objectInfoError ? ' (' + objectInfoError + ')' : '');
      if (!w.missing.includes('ComfyUI not running')) w.missing = ['ComfyUI not running — could not check nodes/models'];
    }
  }
  return {
    workflows, errors, objectInfoError,
    desktopExe: (fsScan && fsScan.desktopExe) || null,
    templateDirs: (fsScan && fsScan.templateDirs) || [],
    templatesMetaOk: !!templatesMeta.ok,
    scan: fsScan,
  };
}
// Scan the standard ComfyUI locations on this machine, probe the
// server, and import whatever workflows the scan found — the user's
// own workflows plus ComfyUI Desktop's built-in templates. The
// scan itself is filesystem-only (see comfyui.scanComfyui); the
// server probe and the import happen here so the renderer gets one
// complete answer. The workflows folder is only adopted when the
// scan actually found one — nothing is invented.
ipcMain.handle('comfyui:scan', async (_, payload) => {
  const p = payload || {};
  const url = p.url || readSetting('comfyui_url', comfyui.DEFAULT_COMFYUI_URL);
  let scan;
  try { scan = comfyui.scanComfyui(); }
  catch (e) { return { ok: false, error: 'Scan failed: ' + String((e && e.message) || e) }; }
  let server = { ok: false, url: comfyui.normalizeComfyuiUrl(url), error: 'Not probed' };
  try { server = await comfyui.getComfyuiStatus(url); }
  catch (e) { server = { ok: false, url: comfyui.normalizeComfyuiUrl(url), error: String((e && e.message) || e) }; }
  const dir = (scan && scan.workflowsDir) || '';
  let stored = [];
  try { stored = JSON.parse(readSetting('comfyui_workflows', '[]') || '[]'); } catch { stored = []; }
  const collected = await collectComfyuiWorkflows(url, dir, stored, scan);
  return {
    ok: true, scan, server, dir,
    workflows: collected.workflows, errors: collected.errors,
    objectInfoError: collected.objectInfoError,
    desktopExe: collected.desktopExe,
    templateDirs: collected.templateDirs,
    templatesMetaOk: collected.templatesMetaOk,
  };
});
ipcMain.handle('comfyui:defaultWorkflowsDir', async () => {
  try { return { ok: true, dir: comfyui.defaultWorkflowsDir() }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e), dir: '' }; }
});
// Read the user's workflow folder and catalogue every *.json in
// it, plus ComfyUI Desktop's built-in templates found on disk.
// The stored catalogue (purpose labels + approvals) is merged back
// in by id, so a rescan never wipes the user's labels. When
// ComfyUI is not running, object_info cannot be fetched, so
// UI-format workflows cannot be converted and every workflow is
// marked unavailable with the honest reason — never "checked"
// when it was not.
ipcMain.handle('comfyui:listWorkflows', async (_, payload) => {
  const p = payload || {};
  const dir = p.dir || readSetting('comfyui_workflows_dir', '') || comfyui.defaultWorkflowsDir();
  let stored = [];
  try { stored = JSON.parse(readSetting('comfyui_workflows', '[]') || '[]'); } catch { stored = []; }
  const collected = await collectComfyuiWorkflows(p.url || readSetting('comfyui_url', comfyui.DEFAULT_COMFYUI_URL), dir, stored, null);
  return {
    ok: true, dir, workflows: collected.workflows, errors: collected.errors,
    objectInfoError: collected.objectInfoError, desktopExe: collected.desktopExe,
    templateDirs: collected.templateDirs, templatesMetaOk: collected.templatesMetaOk,
  };
});
// Read one stored workflow graph back from its file, for submit.
ipcMain.handle('comfyui:readWorkflow', async (_, payload) => {
  const file = (payload && payload.file) || '';
  try {
    if (!file || !fs.existsSync(file)) return { ok: false, error: 'Workflow file not found: ' + file };
    const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, graph };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
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
