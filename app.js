// Defaults for the Settings > Advanced lists (v0.4.0). The same lists
// are seeded into the settings table in main.js for fresh and existing
// databases; these copies are the fallback when a setting is missing.
const DEFAULT_SHELL_AUTO_APPROVE = ['git status', 'git diff', 'npm test', 'npm run test', 'dotnet build', 'dotnet test'];
const DEFAULT_EXCLUDED_FILE_TYPES = ['meta', 'mat', 'anim', 'controller', 'overrideController', 'physicMaterial', 'physicsMaterial2D', 'renderTexture', 'cubemap', 'flare', 'guiskin', 'avatarMask', 'terrainlayer', 'preset', 'playable', 'spriteatlas', 'scenetemplate', 'shadervariants', 'lighting', 'png', 'jpg', 'asset', 'package-lock.json'];

// ── State ────────────────────────────────────────────────────────
let state = {
  mode: 'home',          // 'home' | 'chat' | 'ruleset' | 'plan' | 'page' | 'connections' | 'references'
  activeThreadId: null,
  activeItemId: null,
  activeTable: null,
  activeFilePath: null,
  projectPath: '',
  activeProjectId: null,
  activeProject: null,
  projects: [],
  skillsInstalled: {},
  localFolders: [],
  homeMentionFile: null,
  ollamaModel: 'qwen2.5-coder:32b-instruct',
  ollamaUrl: 'http://localhost:11434',
  ollamaExePath: '',
  projectContext: '',
  messages: [],          // current thread messages
  streaming: false,
  expandedDirs: new Set(),
  // LLM provider (LM Studio is the default for new installs)
  provider: 'lmstudio',
  lmstudioUrl: 'http://localhost:1234/v1',
  lmstudioModel: '',
  lmstudioModels: [],
  lmstudioApiKey: '',
  temperature: 0.2,
  maxTokens: 4096,
  unityExePath: '',
  chatMode: 'agent',     // 'ask' | 'plan' | 'agent'
  projectScan: null,     // cached result of project:scan
  autoAccept: false,
  // Settings (v0.4.0) — loaded from the settings table in init().
  settingsSection: 'model',
  shellEnabled: false,
  shellAutoMode: false,
  autoAcceptChanges: false,
  // v0.5.1: new Unity-native asset files (.prefab, .asset, .unity,
  // …) are written straight away after a snapshot, no Apply click.
  autoApplyUnityAssets: true,
  shellAutoApprove: [],
  excludedFileTypes: [],
  rulesCharBudget: 4000,
  useCondensedRules: false,
  condensedRules: '',
  mcpServers: [],
  agentMaxRounds: 5,
  // ComfyUI (v0.6.0) — native local provider, alongside LM Studio.
  // Inert until a connection succeeds; nothing here blocks the app.
  comfyuiUrl: 'http://127.0.0.1:8188',
  comfyuiWorkflowsDir: '',
  comfyuiWorkflows: [],
  comfyuiStatus: null,
  comfyuiObjectInfo: null,
  comfyuiCapabilities: [],
  comfyuiNodeClasses: [],
  comfyuiScan: null,
  comfyuiSelectedId: null,
  comfyuiGenInputs: {},
  comfyuiOutputs: [],
  comfyuiHistory: [],
  comfyuiGenerating: null,
};

// ── Agent loop state (v0.5.0) ──────────────────────────────────────
// Set while an Agent-mode loop is running, null otherwise. The loop
// pauses here whenever an action needs the user's approval, and
// resumes when the approval bar calls the stored resolver.
let loopState = null;

// ── LLM management (LM Studio default, Ollama supported) ─────────
function setLlmStatus(dotClass, label) {
  const dot = document.getElementById('ollama-dot');
  const lbl = document.getElementById('ollama-label');
  if (dot) {
    dot.className = '';
    if (dotClass) dot.classList.add(dotClass);
  }
  if (lbl) lbl.textContent = label;
  const homeDot = document.getElementById('home-status-dot');
  if (homeDot) {
    homeDot.className = '';
    if (dotClass) homeDot.classList.add(dotClass);
  }
  updateHomeModelLabel();
}
// Backwards-compatible name used by the titlebar.
function setOllamaStatus(status, label) {
  if (status === 'running') setLlmStatus('green', label || providerLabel());
  else if (status === 'starting') setLlmStatus('yellow', label || 'Starting...');
  else setLlmStatus('red', label || 'Offline');
}
function providerLabel() {
  return state.provider === 'ollama' ? 'Ollama' : 'LM Studio';
}
function currentModel() {
  return state.provider === 'ollama' ? state.ollamaModel : state.lmstudioModel;
}
function currentUrl() {
  return state.provider === 'ollama' ? state.ollamaUrl : state.lmstudioUrl;
}

async function initLLM() {
  setLlmStatus('yellow', 'Checking...');
  try {
    const status = await rb.llm.status();
    if (status.running) {
      if (status.models) state.lmstudioModels = status.models;
      updateModelDropdown();
      if (!currentModel()) {
        setLlmStatus('yellow', providerLabel() + ' · No model selected');
        showToast('⚠ ' + providerLabel() + ' is reachable — pick a model in Settings');
      } else {
        setLlmStatus('green', providerLabel() + ' · ' + currentModel());
      }
      return;
    }
    // Offline. For Ollama, try to auto-launch it; LM Studio has no
    // auto-launch — the user starts its local server from the app.
    if (state.provider === 'ollama') {
      const oStatus = await rb.ollama.status();
      if (!oStatus.exePath) {
        setLlmStatus('red', 'Ollama · Not installed');
        showToast('⚠ Ollama not found. Install from ollama.com');
        return;
      }
      setLlmStatus('yellow', 'Starting...');
      const result = await rb.ollama.launch();
      if (result.status === 'running' || result.status === 'launched') {
        setLlmStatus('green', 'Ollama · ' + (state.ollamaModel || ''));
        showToast('✓ Ollama started');
      } else {
        setLlmStatus('red', 'Ollama · Offline');
        showToast('⚠ Could not start Ollama: ' + (result.error || result.status));
      }
    } else {
      setLlmStatus('red', providerLabel() + ' offline');
      showToast('⚠ LM Studio is not reachable at ' + state.lmstudioUrl + ' — start its local server and pick a model in Settings');
    }
  } catch (e) {
    setLlmStatus('red', providerLabel() + ' offline');
  }
}

async function refreshModels() {
  const res = await rb.llm.listModels({
    provider: state.provider,
    lmstudioUrl: state.lmstudioUrl,
    lmstudioApiKey: state.lmstudioApiKey,
    ollamaUrl: state.ollamaUrl,
  });
  if (res.ok) {
    state.lmstudioModels = res.models;
    updateModelDropdown();
    return res;
  }
  showToast('⚠ Could not list models: ' + res.error);
  return res;
}

function updateModelDropdown() {
  const sel = document.getElementById('s-lm-model');
  if (sel) {
    const current = state.lmstudioModel;
    sel.innerHTML = '<option value="">— Select a model —</option>' +
      state.lmstudioModels.map(m => `<option value="${escHtml(m.id)}" ${m.id === current ? 'selected' : ''}>${escHtml(m.id)}</option>`).join('');
    if (current && !state.lmstudioModels.some(m => m.id === current)) {
      sel.innerHTML += `<option value="${escHtml(current)}" selected>${escHtml(current)} (not loaded)</option>`;
    }
  }
  updateHomeModelLabel();
}

function updateHomeModelLabel() {
  const el = document.getElementById('home-model-label');
  if (!el) return;
  el.textContent = currentModel() || 'No model selected';
}

async function verifyLmStudio() {
  const statusEl = document.getElementById('s-lm-status');
  const url = document.getElementById('s-lm-url')?.value?.trim() || state.lmstudioUrl;
  const apiKey = document.getElementById('s-lm-key')?.value?.trim() || '';
  const model = document.getElementById('s-lm-model')?.value || '';
  if (statusEl) { statusEl.style.color = 'var(--text3)'; statusEl.textContent = 'Checking ' + url + ' …'; }
  const res = await rb.llm.verify({ provider: 'lmstudio', lmstudioUrl: url, lmstudioApiKey: apiKey, model });
  if (res.ok) {
    state.lmstudioModels = res.models || [];
    updateModelDropdown();
    if (statusEl) { statusEl.style.color = 'var(--green)'; statusEl.textContent = '✓ ' + (res.message || ('Connected — ' + (res.models || []).length + ' model(s) found.')); }
  } else {
    if (statusEl) { statusEl.style.color = 'var(--coral)'; statusEl.textContent = '✕ ' + (res.error || 'Connection failed'); }
  }
  return res;
}

let ollamaPoller = null;
function pollOllamaStatus() {
  if (ollamaPoller) return;
  ollamaPoller = setInterval(async () => {
    const status = await rb.ollama.status();
    if (status.running) {
      setLlmStatus('green', 'Ollama · ' + (state.ollamaModel || ''));
      clearInterval(ollamaPoller);
      ollamaPoller = null;
    }
  }, 3000);
}

async function retryOllama() {
  const dot = document.getElementById('ollama-dot');
  if (dot && dot.classList.contains('green')) return; // already running
  await initLLM();
}
// initOllama kept as an alias — older code / titlebar used that name.
async function initOllama() { return initLLM(); }

// ── Init ─────────────────────────────────────────────────────────
// ── Bridge self-check (v0.6.3) ────────────────────────────────────
// The v0.6.0 report — every button that needs the main process went
// dead at once (project dropdown, creating a conversation, LM Studio
// verify / refresh, even the Developer tools button) — took three
// releases to chase because the failure was silent: every dead
// handler awaits an rb.* call, and a missing bridge just never
// answers. So init() now proves the bridge is alive FIRST, and if
// it is not, the app says so in a banner on screen (pure DOM, needs
// no bridge, settings, or database) instead of failing silently.
// The banner lives in #bridge-banner, a direct child of <body>
// outside #app, so no view switch or pane re-render removes it.
// On failure init() returns early: without the bridge no init step
// can succeed, and proceeding would hang at the first rb await.
function showBridgeBanner(msg, kind) {
  const banner = document.getElementById('bridge-banner');
  if (!banner) return;
  banner.textContent = msg;
  banner.classList.remove('hidden');
  banner.classList.add(kind);
}

async function checkBridge() {
  if (typeof window.rb === 'undefined' || !window.rb || !window.rb.app || typeof window.rb.app.ping !== 'function') {
    console.error('[bridge] window.rb is missing — preload did not expose the bridge');
    showBridgeBanner('CodeFox cannot reach its main process (bridge missing) — buttons that save, load, or connect will not respond. Please report this exact message.', 'bridge-missing');
    return false;
  }
  try {
    const res = await Promise.race([
      window.rb.app.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ping timed out after 2s')), 2000)),
    ]);
    if (res && res.ok) {
      console.log('[bridge] ping ok, main process version ' + res.version);
      return true;
    }
    throw new Error('ping returned not-ok');
  } catch (e) {
    console.error('[bridge] main process is not answering:', e);
    showBridgeBanner('CodeFox loaded, but the main process is not answering (bridge timeout) — buttons that save, load, or connect will not respond. Please report this exact message.', 'bridge-timeout');
    return false;
  }
}

async function init() {
  // Bridge self-check first — see checkBridge above.
  if (!(await checkBridge())) return;
  // Projects first — the DB migration in main.js guarantees at least one.
  state.projects = await rb.project.list();
  const activeId = await rb.db.getSetting('active_project_id');
  state.activeProject = state.projects.find(p => Number(p.id) === Number(activeId)) || state.projects[0] || null;
  if (state.activeProject) {
    state.activeProjectId = Number(state.activeProject.id);
    state.projectPath = state.activeProject.path || '';
  }
  state.ollamaModel = await rb.db.getSetting('ollama_model') || state.ollamaModel;
  state.ollamaUrl   = await rb.db.getSetting('ollama_url')   || state.ollamaUrl;
  state.ollamaExePath = await rb.db.getSetting('ollama_exe_path') || '';
  state.projectContext = await rb.db.getSetting('project_context') || '';
  state.provider = await rb.db.getSetting('llm_provider') || 'lmstudio';
  state.lmstudioUrl = await rb.db.getSetting('lmstudio_url') || 'http://localhost:1234/v1';
  state.lmstudioModel = await rb.db.getSetting('lmstudio_model') || '';
  state.lmstudioApiKey = await rb.db.getSetting('lmstudio_api_key') || '';
  state.temperature = parseFloat(await rb.db.getSetting('llm_temperature') || '0.2') || 0.2;
  state.maxTokens = parseInt(await rb.db.getSetting('llm_max_tokens') || '4096', 10) || 4096;
  state.unityExePath = await rb.db.getSetting('unity_exe_path') || '';
  state.chatMode = await rb.db.getSetting('chat_mode') || 'agent';
  state.shellEnabled = (await rb.db.getSetting('shell_enabled') || '0') === '1';
  state.shellAutoMode = (await rb.db.getSetting('shell_auto_mode') || '0') === '1';
  state.autoAcceptChanges = (await rb.db.getSetting('auto_accept_changes') || '0') === '1';
  // v0.5.1: auto-apply new Unity asset files. Default on; the
  // setting is seeded to '1' in main.js, so a missing key means on.
  state.autoApplyUnityAssets = (await rb.db.getSetting('auto_apply_unity_assets') || '1') === '1';
  try { state.shellAutoApprove = JSON.parse(await rb.db.getSetting('shell_auto_approve') || 'null') || DEFAULT_SHELL_AUTO_APPROVE.slice(); }
  catch { state.shellAutoApprove = DEFAULT_SHELL_AUTO_APPROVE.slice(); }
  if (!Array.isArray(state.shellAutoApprove)) state.shellAutoApprove = DEFAULT_SHELL_AUTO_APPROVE.slice();
  try { state.excludedFileTypes = JSON.parse(await rb.db.getSetting('excluded_file_types') || 'null') || DEFAULT_EXCLUDED_FILE_TYPES.slice(); }
  catch { state.excludedFileTypes = DEFAULT_EXCLUDED_FILE_TYPES.slice(); }
  if (!Array.isArray(state.excludedFileTypes)) state.excludedFileTypes = DEFAULT_EXCLUDED_FILE_TYPES.slice();
  state.rulesCharBudget = parseInt(await rb.db.getSetting('rules_char_budget') || '4000', 10) || 4000;
  state.agentMaxRounds = clampAgentMaxRounds(parseInt(await rb.db.getSetting('agent_max_rounds') || '5', 10));
  state.useCondensedRules = (await rb.db.getSetting('use_condensed_rules') || '0') === '1';
  state.condensedRules = await rb.db.getSetting('condensed_rules') || '';
  state.comfyuiUrl = await rb.db.getSetting('comfyui_url') || 'http://127.0.0.1:8188';
  state.comfyuiWorkflowsDir = await rb.db.getSetting('comfyui_workflows_dir') || '';
  try { state.comfyuiWorkflows = JSON.parse(await rb.db.getSetting('comfyui_workflows') || '[]'); }
  catch { state.comfyuiWorkflows = []; }
  if (!Array.isArray(state.comfyuiWorkflows)) state.comfyuiWorkflows = [];
  try { state.mcpServers = JSON.parse(await rb.db.getSetting('mcp_servers') || '[]'); }
  catch { state.mcpServers = []; }
  if (!Array.isArray(state.mcpServers)) state.mcpServers = [];
  try { state.localFolders = JSON.parse(await rb.db.getSetting('local_folders') || '[]'); }
  catch { state.localFolders = []; }
  if (!Array.isArray(state.localFolders)) state.localFolders = [];
  if (state.ollamaExePath) await rb.ollama.setPath(state.ollamaExePath);
  setProjectPathLabels();
  renderProjectSelector();

  // Check the LLM backend in parallel — don't block UI
  initLLM();
  updateModeButtons();
  const homeSel = document.getElementById('home-mode-select');
  if (homeSel) homeSel.value = state.chatMode;

  await loadSkills();
  await refreshSidebar();
  await loadFileTree(state.projectPath, document.getElementById('file-tree'), 0);
  // Build flat index in background for search
  buildFileIndex(state.projectPath).then(() => {
    console.log(`File index built: ${allFiles.length} files`);
  });

  // Home is the default view; make sure the project has a conversation.
  await showHome();

  // Close the project dropdown when clicking anywhere else.
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('project-dropdown');
    if (!dd || dd.classList.contains('hidden')) return;
    const sel = document.getElementById('project-selector');
    if (!dd.contains(e.target) && !(sel && sel.contains(e.target))) dd.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const dd = document.getElementById('project-dropdown');
      if (dd) dd.classList.add('hidden');
    }
  });
}

function setProjectPathLabels() {
  const f = document.getElementById('file-path-label');
  if (f) f.textContent = state.projectPath || 'No project set';
}

// ── Sidebar ──────────────────────────────────────────────────────
async function refreshSidebar() {
  const [rulesets, plans, pages, threads] = await Promise.all([
    rb.db.getAll('rulesets'),
    rb.db.getAll('plans'),
    rb.db.getAll('pages'),
    rb.db.getAll('threads'),
  ]);
  // Per-project filtering. Rows with no project_id (pre-0.3.0 rows that
  // missed the migration backfill) are shown under the active project.
  const pid = state.activeProjectId;
  const mine = (rows) => pid == null ? rows : rows.filter(r => r.project_id == null || Number(r.project_id) === Number(pid));
  renderList('ruleset-list', mine(rulesets), 'rulesets');
  renderReferencesList(mine(pages), mine(plans));
  renderThreadList(mine(threads));
  // Snapshots isolated — table may not exist in older DBs
  try {
    const snapshots = await rb.db.getAll('snapshots');
    renderSnapshotList(snapshots || []);
  } catch (e) {
    renderSnapshotList([]);
  }
}

function renderSnapshotList(snapshots) {
  const el = document.getElementById('snapshots-list');
  if (!el) return;
  // Show most recent 5
  const recent = snapshots.slice(0, 5);
  if (!recent.length) {
    el.innerHTML = '<div style="padding:4px 14px;color:var(--text3);font-size:11px;">No snapshots yet</div>';
    return;
  }
  el.innerHTML = recent.map(s => `
    <div class="sidebar-link" style="flex-direction:column;align-items:flex-start;gap:2px;padding:5px 14px;">
      <div style="display:flex;width:100%;align-items:center;gap:6px;">
        <span class="sidebar-link-name" style="font-size:11px;color:var(--text2);">${escHtml(s.label)}</span>
        <span class="sidebar-link-del" onclick="revertFromHistory('${s.id}')">↩</span>
      </div>
      <span style="font-size:10px;color:var(--text3);">${s.file_count} file${s.file_count !== 1 ? 's' : ''} · ${formatTime(s.created_at)}</span>
    </div>
  `).join('');
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr.replace(' ', 'T') + 'Z');
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return isoStr; }
}

async function revertFromHistory(snapshotId) {
  const allBackups = await rb.db.getAll('file_backups');
  const snapBackups = allBackups.filter(b => b.snapshot_id === snapshotId);
  if (!snapBackups.length) { showToast('No backed-up files in this snapshot'); return; }

  // Create a fake bar for the revert UI
  const bar = { remove: () => {} };
  showToast('Reverting...');
  await confirmRevert(snapshotId, bar);
}

function renderList(containerId, items, table) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = items.map(item => `
    <div class="sidebar-link ${state.activeTable === table && state.activeItemId === item.id ? 'active' : ''}"
         onclick="loadItem('${table}', ${item.id})">
      <span class="sidebar-link-name">${escHtml(item.name)}</span>
      <span class="sidebar-link-del" onclick="event.stopPropagation(); deleteItem('${table}', ${item.id})">✕</span>
    </div>
  `).join('');
}

function renderThreadList(threads) {
  const el = document.getElementById('conversations-list');
  if (!el) return;
  const inChat = state.mode === 'chat' && state.activeThreadId != null;
  const newRow = `
    <div class="sidebar-link ${!inChat ? 'active' : ''}" onclick="newThread()">
      <span class="sidebar-link-name">＋ New conversation</span>
    </div>`;
  el.innerHTML = newRow + threads.map(t => `
    <div class="sidebar-link ${state.activeThreadId === Number(t.id) && state.mode === 'chat' ? 'active' : ''}"
         onclick="loadThread(${t.id})">
      <span class="sidebar-link-name">${escHtml(t.name)}</span>
      <span class="sidebar-link-del" onclick="event.stopPropagation(); deleteThread(${t.id})">✕</span>
    </div>
  `).join('');
}

// References = pages + plans in one list, labelled by kind.
function renderReferencesList(pages, plans) {
  const el = document.getElementById('references-list');
  if (!el) return;
  const items = [
    ...pages.map(p => ({ id: p.id, name: p.name, table: 'pages', kind: 'Reference' })),
    ...plans.map(p => ({ id: p.id, name: p.name, table: 'plans', kind: 'Plan' })),
  ].sort((a, b) => Number(b.id) - Number(a.id));
  if (!items.length) {
    el.innerHTML = '<div style="padding:4px 14px;color:var(--text3);font-size:11px;">No references yet</div>';
    return;
  }
  el.innerHTML = items.map(item => `
    <div class="sidebar-link ${state.activeTable === item.table && state.activeItemId === Number(item.id) ? 'active' : ''}"
         onclick="loadItem('${item.table}', ${item.id})">
      <span class="sidebar-link-name">${escHtml(item.name)}</span>
      <span style="font-size:10px;color:var(--text3);flex-shrink:0;">${item.kind}</span>
      <span class="sidebar-link-del" onclick="event.stopPropagation(); deleteItem('${item.table}', ${item.id})">✕</span>
    </div>
  `).join('');
}

// ── Mode switching ────────────────────────────────────────────────
function setMode(mode, title, badgeClass) {
  state.mode = mode;
  const badgeLabels = { chat: 'Chat', ruleset: 'Ruleset', plan: 'Plan', page: 'Reference', home: 'Home', connections: 'Connections', references: 'References', settings: 'Settings', comfyui: 'ComfyUI' };
  const badge = document.getElementById('center-mode-badge');
  badge.textContent = badgeLabels[mode] || (mode.charAt(0).toUpperCase() + mode.slice(1));
  badge.className = 'badge-' + (mode === 'chat' ? 'chat' : mode === 'plan' ? 'plan' : mode === 'page' ? 'page' : mode === 'home' ? 'home' : mode === 'connections' ? 'connections' : mode === 'references' ? 'references' : mode === 'settings' ? 'settings' : mode === 'comfyui' ? 'comfyui' : 'ruleset');
  document.getElementById('center-title').textContent = title;
  const topTitle = document.getElementById('topbar-title');
  if (topTitle) topTitle.textContent = mode === 'home' ? 'Home' : title;

  // Centre header is hidden on Home (the hero carries the project name).
  document.getElementById('center-header').classList.toggle('hidden', mode === 'home');

  const panes = { chat: 'chat-mode', ruleset: 'editor-mode', page: 'editor-mode', plan: 'plan-mode', home: 'home-mode', connections: 'connections-mode', references: 'references-mode', settings: 'settings-mode', comfyui: 'comfyui-mode' };
  for (const id of new Set(Object.values(panes))) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', panes[mode] !== id);
  }

  // Right panel: the build panel on Home, the file tree everywhere else.
  document.getElementById('app').classList.toggle('home-view', mode === 'home');
  document.getElementById('right-build').classList.toggle('hidden', mode !== 'home');
  document.getElementById('right-files').classList.toggle('hidden', mode === 'home');

  // Sidebar nav highlight.
  document.getElementById('nav-conversations')?.classList.toggle('active', mode === 'home' || mode === 'chat');
  document.getElementById('nav-references')?.classList.toggle('active', mode === 'references' || mode === 'page' || mode === 'plan');
  document.getElementById('nav-connections')?.classList.toggle('active', mode === 'connections');
  document.getElementById('nav-settings')?.classList.toggle('active', mode === 'settings');
  document.getElementById('nav-comfyui')?.classList.toggle('active', mode === 'comfyui');

  // Settings has its own Save button; clear any actions left over from
  // the editor / plan views.
  if (mode === 'settings') document.getElementById('center-actions').innerHTML = '';

  if (mode === 'home') renderHome();
  if (mode === 'connections') renderConnectionsView();
  if (mode === 'references') renderReferencesView();
  if (mode === 'settings') renderSettingsView();
  if (mode === 'comfyui') renderComfyUIView();
}

// ── Load items from sidebar ───────────────────────────────────────
async function loadItem(table, id) {
  state.activeTable = table;
  state.activeItemId = id;
  const item = await rb.db.get(table, id);
  if (!item) return;

  if (table === 'rulesets') {
    setMode('ruleset', item.name);
    document.getElementById('editor-content').value = item.content;
    document.getElementById('center-actions').innerHTML = `
      <button class="btn btn-primary" onclick="saveEditor()">Save</button>
    `;
  } else if (table === 'pages') {
    setMode('page', item.name);
    document.getElementById('editor-content').value = item.content;
    document.getElementById('center-actions').innerHTML = `
      <button class="btn btn-primary" onclick="saveEditor()">Save</button>
      <button class="btn btn-teal" onclick="sendPageToChat()">Discuss in chat</button>
    `;
  } else if (table === 'plans') {
    setMode('plan', item.name);
    renderPlanView(item);
    document.getElementById('center-actions').innerHTML = `
      <button class="btn btn-secondary" onclick="editPlan()">Edit</button>
      <button class="btn btn-teal" onclick="executePlan()">▶ Execute plan</button>
    `;
  }

  refreshSidebar();
}

function renderPlanView(item) {
  const content = item.content || '';
  const lines = content.split('\n');
  const files = [];
  const steps = [];

  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('FILE:')) files.push(trimmed.replace('FILE:', '').trim());
    else if (trimmed.match(/^\d+\./)) steps.push(trimmed.replace(/^\d+\./, '').trim());
  });

  const planView = document.getElementById('plan-view');
  planView.innerHTML = `
    ${files.length ? `
    <div class="plan-section">
      <h3>Files to be modified</h3>
      <div>${files.map(f => `<span class="plan-file-tag" onclick="loadFileInViewer('${f.replace(/'/g, "\\'")}')" title="Click to view">${f.split('\\').pop() || f.split('/').pop()}</span>`).join('')}</div>
    </div>` : ''}
    <div class="plan-section">
      <h3>Plan details</h3>
      <pre style="color:var(--text2);font-family:var(--font);font-size:13px;line-height:1.7;white-space:pre-wrap">${escHtml(content)}</pre>
    </div>
    ${item.status === 'executed' ? `<div style="color:var(--teal);font-size:12px;padding:8px 0;">✓ This plan has been executed</div>` : ''}
  `;
}

async function saveEditor() {
  const content = document.getElementById('editor-content').value;
  await rb.db.update(state.activeTable, state.activeItemId, { content });
  showToast('Saved');
}

function editPlan() {
  const item = { id: state.activeItemId };
  rb.db.get('plans', state.activeItemId).then(item => {
    setMode('page', item.name); // reuse editor
    state.activeTable = 'plans';
    document.getElementById('editor-content').value = item.content;
    document.getElementById('center-actions').innerHTML = `
      <button class="btn btn-primary" onclick="savePlanEdit()">Save plan</button>
    `;
    document.getElementById('editor-mode').classList.remove('hidden');
    document.getElementById('plan-mode').classList.add('hidden');
  });
}

async function savePlanEdit() {
  const content = document.getElementById('editor-content').value;
  await rb.db.update('plans', state.activeItemId, { content });
  await loadItem('plans', state.activeItemId);
  showToast('Plan saved');
}

// ── Thread / Chat ─────────────────────────────────────────────────
async function loadThread(id) {
  const numId = Number(id);
  console.log('[loadThread] id:', id, '-> numId:', numId, 'typeof:', typeof id);
  state.activeThreadId = numId;
  state.activeTable = null;
  state.activeItemId = null;
  const thread = await rb.db.get('threads', numId);
  console.log('[loadThread] thread:', thread ? thread.name : 'NULL — id was: ' + numId);
  if (!thread) { console.error('[loadThread] ABORT no thread'); return; }

  const msgs = await rb.db.getAll('messages');
  state.messages = msgs.filter(m => Number(m.thread_id) === numId).reverse();
  console.log('[loadThread] messages:', state.messages.length, '— calling setMode chat');

  setMode('chat', thread.name);
  document.getElementById('center-actions').innerHTML = `
    <button class="btn btn-secondary" onclick="renameThread()">Rename</button>
  `;

  renderMessages();
  await refreshSidebar();
}

function renderMessages() {
  const el = document.getElementById('chat-messages');
  el.innerHTML = state.messages.map(m => `
    <div class="msg msg-${m.role}">${escHtml(m.content)}</div>
  `).join('');
  el.scrollTop = el.scrollHeight;
}

async function sendChat() {
  console.log('[sendChat] called — streaming:', state.streaming, 'threadId:', state.activeThreadId, 'mode:', state.mode);
  if (state.streaming) { console.warn('[sendChat] ABORT: streaming'); return; }

  // If mode isn't chat, force it — handles edge case where executePlan switches mode
  if (state.mode !== 'chat') {
    console.warn('[sendChat] mode is', state.mode, '— forcing chat mode');
    document.getElementById('chat-mode').classList.remove('hidden');
    document.getElementById('editor-mode').classList.add('hidden');
    document.getElementById('plan-mode').classList.add('hidden');
    state.mode = 'chat';
  }

  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  console.log('[sendChat] text length:', text.length);
  if (!text) { console.warn('[sendChat] ABORT: empty text'); return; }
  input.value = '';
  autoResize(input);

  // Save user message
  await rb.db.insert('messages', { thread_id: state.activeThreadId, role: 'user', content: text });
  state.messages.push({ role: 'user', content: text });
  renderMessages();

  // The thinking indicator is created per turn by streamOneTurn,
  // which also owns the assistant message element.

  // Build system prompt — use override if set by executePlan
  const usedExecPlanPrompt = !!(window._execPlanActive && window._execPlanSystemPrompt);
  let systemPrompt;
  if (usedExecPlanPrompt) {
    systemPrompt = window._execPlanSystemPrompt;
    window._execPlanActive = false;
    window._execPlanSystemPrompt = null;
  } else {
    const rulesets = await rb.db.getAll('rulesets');
    systemPrompt = buildSystemPrompt(rulesets);
  }

  // Diagnose-error context (v0.5.2): if the user's message reports
  // a Unity error naming a file, attach that file's surrounding
  // lines to the system prompt so the model can fix it instead of
  // guessing. (Not applied to an executePlan override prompt.)
  if (!usedExecPlanPrompt) systemPrompt += await diagnoseErrorContext(text);

  // Capture thread ID now — state may change if user navigates away
  const currentThreadId = state.activeThreadId;
  state.streaming = true;
  try {
    if (state.chatMode === 'agent') {
      // Agent mode: the loop (v0.5.0). The model runs commands,
      // applies file changes and installs packages, reads the results,
      // and tries again on its own — no further prompting needed.
      await runAgentTurn(systemPrompt, currentThreadId);
    } else {
      // Ask / Plan: exactly the v0.4.0 behaviour — one reply, then
      // the apply bar / shell bar / package bar. No looping.
      const content = await streamOneTurn(state.messages.map(m => ({ role: m.role, content: m.content })), systemPrompt, currentThreadId);
      if (content != null) {
        const changes = extractFileChanges(content);
        // v0.5.1: a pure set of NEW Unity asset files auto-applies
        // (snapshot first, revert bar shown); anything else gets the
        // Apply bar exactly as before.
        if (changes.length) await handleFileChanges(changes);
        // Shell blocks in the reply: auto-run only when auto-approved,
        // otherwise offer a Run button. Never runs when the shell is off.
        handleShellBlocks(content);
        // Package blocks: always ask first, via the package bar.
        handlePackageBlocks(content);
      }
    }
  } finally {
    state.streaming = false;
    hideLoopUI();
  }
}

// ── Agent loop (v0.5.0, Agent mode only) ──────────────────────────
// Ask and Plan modes never loop: they stream one reply and stop, as
// in v0.4.0. In Agent mode, after each reply the loop parses the
// reply for actions (file changes, shell blocks, package blocks),
// runs the ones that are allowed, asks about the rest, feeds every
// result back to the model as a tool-result message, and calls the
// model again — until a reply contains no actions, the user stops
// it, or agent_max_rounds is reached. The max is a hard cap.

// Refusal auto-retry (v0.5.2). A small local model sometimes refuses
// with "I cannot modify files" even though CodeFox applies the files
// it outputs — the capability statement in the system prompt is the
// first defence; this is the safety net. One automatic correction
// turn, counted as a loop round; a second refusal stops the loop
// with a clear message instead of looping forever.
const REFUSAL_PHRASES = [
  'cannot modify files', "can't modify files", 'can not modify files',
  'cannot edit', "can't edit", 'cannot write code', "can't write code",
  'cannot actually edit the file', 'restricted from making actual changes',
  'cannot modify the file', 'unable to modify files', 'unable to edit files',
  'cannot make changes to your files', 'i cannot edit files',
];
function isRefusal(text) {
  const t = String(text || '').toLowerCase();
  return REFUSAL_PHRASES.some(p => t.includes(p));
}
const REFUSAL_CORRECTION = 'You CAN modify files in this app. CodeFox applies the files you output — that is how this app works. Output the corrected file now in the required format: **File Path:** `path` then a fenced code block, or a ```file:path block. Do not describe the fix instead of making it.';

// No-actions enforcement (v0.5.2). The refusal retry above only
// catches models that SAY they cannot edit. The common case is
// worse: the model politely DESCRIBES the fix and stops, with no
// refusal phrase at all. When the user asked for a change and the
// reply produced no actions, that turn is INCOMPLETE, not an answer.
const CHANGE_INTENT_WORDS = ['fix', 'change', 'edit', 'update', 'create', 'add', 'remove', 'refactor', 'correct', 'repair', 'make it', 'do it'];
function asksForChange(text) {
  const t = String(text || '').toLowerCase();
  return CHANGE_INTENT_WORDS.some(k => t.includes(k));
}
function lastUserMessageText() {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i] && state.messages[i].role === 'user') return state.messages[i].content || '';
  }
  return '';
}
const ENFORCEMENT_FOLLOWUP = 'You did not output any file changes. The user asked you to fix this. Output the corrected file(s) now in the required format. An explanation without the file is not an answer.';

function clampAgentMaxRounds(n) {
  const v = parseInt(n, 10);
  if (isNaN(v)) return 5;
  return Math.min(10, Math.max(1, v));
}

function isValidPackageName(name) {
  return typeof name === 'string'
    && /^[a-z0-9][a-z0-9._-]*$/i.test(name)
    && name.indexOf('.') !== -1;
}

function isValidPackageVersion(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(s)) return true;
  if (/^(https?:\/\/[^\s]+\.git(?:#[^\s]+)?|git@[^\s]+\.git(?:#[^\s]+)?)$/i.test(s)) return true;
  if (/^(file:|https?:\/\/)/i.test(s)) return true;
  if (/\.tgz$|\.tar\.gz$/i.test(s)) return true;
  if (s.indexOf('/') !== -1 || s.indexOf('\\') !== -1) return true;
  return false;
}

// One line from a ```upm-install / ```upm-remove block, or null for
// blank lines and comments. See upm-manifest.js parsePackageSpec
// for the accepted forms (the renderer cannot require that file).
function parsePackageSpecLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('//') || raw.startsWith('#')) return null;
  if (/^(https?:\/\/[^\s]+\.git(?:#[^\s]+)?|git@[^\s]+\.git(?:#[^\s]+)?)$/i.test(raw)) {
    return { name: '', version: raw, isGit: true, raw, valid: true };
  }
  const at = raw.indexOf('@');
  if (at > 0) {
    const name = raw.slice(0, at).trim();
    const version = raw.slice(at + 1).trim();
    return { name, version, isGit: false, raw, valid: isValidPackageName(name) && isValidPackageVersion(version) };
  }
  return { name: raw, version: '', isGit: false, raw, valid: isValidPackageName(raw) };
}

function parseUpmBlocks(text, lang) {
  const out = [];
  const re = new RegExp('```' + lang + '\\s*\\n([\\s\\S]*?)```', 'gi');
  let m;
  while ((m = re.exec(text))) {
    for (const line of m[1].split('\n')) {
      const spec = parsePackageSpecLine(line);
      if (spec) out.push({ ...spec, index: m.index });
    }
  }
  return out;
}

function extractShellBlocksWithIndex(text) {
  const out = [];
  const re = /```(powershell|pwsh|shell)\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text))) {
    const cmd = m[2].trim();
    if (cmd) out.push({ command: cmd, index: m.index });
  }
  return out;
}

// ComfyUI blocks (v0.6.0, Agent mode only): ```comfyui with JSON
// {"workflow": "<name or id>", "inputs": {...}}. Ask/Plan never
// parse these — the block is shown as text only there.
function parseComfyuiBlocks(text) {
  const out = [];
  const re = /```comfyui\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text))) {
    let parsed = null;
    let error = null;
    try { parsed = JSON.parse(m[1].trim()); } catch (e) { error = e.message; }
    out.push({
      workflow: parsed ? (parsed.workflow || parsed.name || parsed.id || '') : '',
      inputs: (parsed && parsed.inputs && typeof parsed.inputs === 'object') ? parsed.inputs : {},
      raw: m[1].trim(),
      valid: !!parsed && !!(parsed.workflow || parsed.name || parsed.id),
      error,
      index: m.index,
    });
  }
  return out;
}

// All actions in one reply, in the order they appear: file changes
// (one action for the whole set, applied together), one action per
// shell block, one action per package line.
function parseAgentActions(text) {
  const actions = [];
  const changes = extractFileChanges(text);
  if (changes.length) {
    let idx = Infinity;
    for (const c of changes) {
      const i = text.indexOf(c.path);
      if (i >= 0 && i < idx) idx = i;
    }
    actions.push({ type: 'files', changes, index: idx === Infinity ? 0 : idx });
  }
  for (const b of extractShellBlocksWithIndex(text)) {
    actions.push({ type: 'shell', command: b.command, index: b.index });
  }
  for (const p of parseUpmBlocks(text, 'upm-install')) {
    actions.push({ type: 'package-install', name: p.name, version: p.version, isGit: p.isGit, raw: p.raw, valid: p.valid, index: p.index });
  }
  for (const b of parseComfyuiBlocks(text)) {
    actions.push({ type: 'comfyui', workflow: b.workflow, inputs: b.inputs, raw: b.raw, valid: b.valid, error: b.error, index: b.index });
  }
  for (const p of parseUpmBlocks(text, 'upm-remove')) {
    actions.push({ type: 'package-remove', name: p.name, version: '', isGit: false, raw: p.raw, valid: p.valid, index: p.index });
  }
  actions.sort((a, b) => a.index - b.index);
  return actions;
}

// A tool result is a real message in the thread (role "user" with a
// "Tool result —" prefix), saved to the database and sent to the
// model with the next turn — not just text on screen.
async function appendToolResult(text) {
  if (state.activeThreadId != null) {
    try { await rb.db.insert('messages', { thread_id: state.activeThreadId, role: 'user', content: text }); } catch {}
  }
  state.messages.push({ role: 'user', content: text });
  renderMessages();
}

function formatShellResult(cmd, res) {
  const output = ((res && res.stdout) || '') + (res && res.stderr ? '\n' + res.stderr : '');
  const trimmed = output.trim() || '(no output)';
  const code = res && res.code != null ? res.code : '?';
  let text = 'Tool result — ' + cmd + ' (exit ' + code + '):\n' + trimmed;
  if (res && res.ok === false && res.error) text += '\n' + res.error;
  return text;
}

function packageResultText(action, res) {
  const isInstall = action.type === 'package-install';
  const label = isInstall ? 'package install' : 'package removal';
  const what = action.name + (isInstall && action.version ? '@' + action.version : '');
  if (!res) return 'Tool result — ' + label + ': ' + what + ' — no result returned.';
  if (res.ok) {
    return 'Tool result — ' + label + ': ' + what + ' — done. Backup: ' + (res.backup || 'none')
      + '. Unity will resolve this on refresh — open Unity or wait for the refresh trigger.';
  }
  return 'Tool result — ' + label + ': ' + what + ' — failed: ' + (res.error || 'unknown error');
}

// Loop status line under the reply, e.g.
// "Working… round 2/5 — ran `dotnet build`".
function setLoopStatus(text) {
  const el = document.getElementById('loop-status');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
}

function showLoopUI() {
  const btn = document.getElementById('stop-loop-btn');
  if (btn) btn.classList.remove('hidden');
  setLoopStatus('Working…');
}

function hideLoopUI() {
  const btn = document.getElementById('stop-loop-btn');
  if (btn) btn.classList.add('hidden');
  const el = document.getElementById('loop-status');
  if (el) { el.textContent = ''; el.classList.add('hidden'); }
}

// Stop button: sets the flag the loop checks between rounds, drops
// any in-flight stream chunks, dismisses any approval bar, and wakes
// a loop that is paused waiting for approval so it can unwind.
// There is no stream-abort IPC in the main process, so a stream that
// is already in flight finishes in the background — the loop still
// never starts another round after a stop.
function stopAgentLoop() {
  if (!loopState) return;
  loopState.stopRequested = true;
  try { rb.llm.removeListeners(); } catch {}
  for (const id of ['apply-bar', 'shell-bar', 'package-bar', 'comfyui-bar']) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
  if (window._shellQueue) window._shellQueue = [];
  if (window._packageQueue) window._packageQueue = [];
  if (state.comfyuiGenerating) window._comfyuiPollStop = state.comfyuiGenerating.promptId;
  if (loopState.pendingResolve) {
    const settle = loopState.pendingResolve;
    loopState.pendingResolve = null;
    loopState.waitingApproval = false;
    settle({ decision: 'stopped' });
  }
  setLoopStatus('Stopping…');
}

// Show an approval bar and wait for the user's decision. `showFn`
// receives a settle callback to hand to the bar. Resolves exactly
// once — a late click after a Stop is ignored.
function waitForLoopDecision(showFn) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      if (loopState) { loopState.waitingApproval = false; loopState.pendingResolve = null; }
      resolve(outcome);
    };
    if (!loopState) return settle({ decision: 'stopped' });
    loopState.pendingResolve = settle;
    loopState.waitingApproval = true;
    showFn(settle);
  });
}

// One streamed assistant turn: creates the message element, streams
// chunks into it, saves the finished reply, and returns it. Returns
// null when the model could not be reached (the error is already
// shown in the message element).
async function streamOneTurn(messages, systemPrompt, threadId) {
  const msgsEl = document.getElementById('chat-messages');
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking';
  thinkingEl.innerHTML = '<span></span><span></span><span></span>';
  msgsEl.appendChild(thinkingEl);
  const assistantMsgEl = document.createElement('div');
  assistantMsgEl.className = 'msg msg-assistant';
  msgsEl.appendChild(assistantMsgEl);
  msgsEl.scrollTop = msgsEl.scrollHeight;
  let assistantContent = '';
  rb.llm.removeListeners();
  rb.llm.onChunk(chunk => {
    thinkingEl.remove();
    assistantContent += chunk;
    assistantMsgEl.textContent = assistantContent;
    msgsEl.scrollTop = msgsEl.scrollHeight;
  });
  try {
    const result = await rb.llm.chat({
      messages, systemPrompt,
      provider: state.provider,
      model: currentModel(),
      lmstudioUrl: state.lmstudioUrl,
      lmstudioApiKey: state.lmstudioApiKey,
      ollamaUrl: state.ollamaUrl,
      temperature: state.temperature,
      maxTokens: state.maxTokens,
    });
    if (!assistantContent && typeof result === 'string' && !(loopState && loopState.stopRequested)) {
      assistantContent = result;
      assistantMsgEl.textContent = result;
    }
  } catch (e) {
    thinkingEl.remove();
    assistantMsgEl.textContent = '⚠ Could not reach ' + providerLabel() + ' at ' + currentUrl() + '. ' + (e.message || '') + (currentModel() ? '' : ' No model is selected — open Settings, verify the connection, and pick a model.');
    rb.llm.removeListeners();
    return null;
  }
  thinkingEl.remove();
  rb.llm.removeListeners();
  try { await rb.db.insert('messages', { thread_id: threadId, role: 'assistant', content: assistantContent }); } catch {}
  if (state.activeThreadId === threadId) state.messages.push({ role: 'assistant', content: assistantContent });
  await handleSkillSaveFlags(assistantContent);
  return assistantContent;
}

// Audit / Game Design Document skills: save the finished reply into
// the Reference they created. Flags are cleared on first use, so
// only the first turn of a loop saves.
async function handleSkillSaveFlags(content) {
  if (window._saveAuditAsReference) {
    window._saveAuditAsReference = false;
    await rb.db.insert('pages', { name: 'Project Structure Audit', content, project_id: state.activeProjectId });
    await refreshSidebar();
    if (state.mode === 'home') renderHome();
    showToast('✓ Audit saved as a Reference');
  }
  if (window._saveGddAsReference && window._gddPageId) {
    window._saveGddAsReference = false;
    await rb.db.update('pages', window._gddPageId, { content });
    window._gddPageId = null;
    await refreshSidebar();
    if (state.mode === 'home') renderHome();
    showToast('✓ Game Design Document saved as a Reference');
  }
}

// The agent loop. Streams a turn, parses its actions, executes the
// allowed ones, pauses for approval on the rest, appends every
// outcome as a tool result, and streams the next turn with the
// extended history. Ends when a reply has no actions, the user stops
// it, the model cannot be reached, or agent_max_rounds is hit.
async function runAgentTurn(systemPrompt, threadId) {
  const maxRounds = clampAgentMaxRounds(state.agentMaxRounds);
  // The user's original request, captured before any tool results
  // (which are also role "user") are appended to the history.
  const userRequest = lastUserMessageText();
  loopState = {
    active: true, stopRequested: false, stopNoted: false,
    round: 0, maxRounds, threadId, systemPrompt,
    waitingApproval: false, pendingResolve: null, refusalRetries: 0, enforcementRetried: false,
  };
  showLoopUI();
  try {
    while (loopState.round < loopState.maxRounds) {
      if (loopState.stopRequested) break;
      setLoopStatus('Working… round ' + (loopState.round + 1) + '/' + loopState.maxRounds + ' — waiting for the model…');
      const content = await streamOneTurn(
        state.messages.map(m => ({ role: m.role, content: m.content })),
        systemPrompt, threadId);
      if (!loopState || loopState.stopRequested) break;
      if (content == null) break; // model unreachable — error already shown
      // Refusal auto-retry (v0.5.2): a "cannot modify files" reply
      // is a prompt failure, not a capability failure. Correct the
      // model once (counts as a loop round); a second refusal stops
      // with a clear message instead of looping forever.
      if (isRefusal(content)) {
        if (loopState.refusalRetries >= 1) {
          addSystemMessage('The model refused to output the change twice. Try rephrasing, or use Ask mode for an explanation.');
          break;
        }
        loopState.refusalRetries++;
        loopState.round++;
        setLoopStatus('Working… round ' + loopState.round + '/' + loopState.maxRounds + ' — correcting the model…');
        await appendToolResult(REFUSAL_CORRECTION);
        if (loopState.round >= loopState.maxRounds) {
          addSystemMessage('Stopped after ' + loopState.round + ' tool rounds — the task may need more steps. Ask me to continue if you want.');
          break;
        }
        continue;
      }
      const actions = parseAgentActions(content);
      if (!actions.length) {
        // No-actions enforcement (v0.5.2): the user asked for a
        // change and the model only described it. One automatic
        // enforcement retry, counted as a loop round; a second
        // reply with no actions stops with a clear message.
        if (asksForChange(userRequest) && !loopState.enforcementRetried) {
          loopState.enforcementRetried = true;
          loopState.round++;
          setLoopStatus('Working… round ' + loopState.round + '/' + loopState.maxRounds + ' — asking for the file, not the description…');
          await appendToolResult(ENFORCEMENT_FOLLOWUP);
          if (loopState.round >= loopState.maxRounds) {
            addSystemMessage('Stopped after ' + loopState.round + ' tool rounds — the task may need more steps. Ask me to continue if you want.');
            break;
          }
          continue;
        }
        if (asksForChange(userRequest) && loopState.enforcementRetried) {
          addSystemMessage('The model described the fix but did not output the change. Try asking again, or paste the error with Diagnose error.');
        }
        break; // final answer — no actions, loop ends
      }
      loopState.round++;
      const outcomes = await processAgentActions(actions);
      if (!loopState || loopState.stopRequested) break;
      if (outcomes === 0) break;
      if (loopState.round >= loopState.maxRounds) {
        addSystemMessage('Stopped after ' + loopState.round + ' tool rounds — the task may need more steps. Ask me to continue if you want.');
        break;
      }
    }
  } finally {
    if (loopState && loopState.stopRequested && !loopState.stopNoted) {
      loopState.stopNoted = true;
      addSystemMessage('Stopped by user.');
    }
    loopState = null;
    hideLoopUI();
  }
}

// Execute one round's actions in order. Returns how many outcomes
// (executed, declined, or skipped-with-note) were appended as tool
// results. An action that needs approval pauses the loop on its bar;
// the loop resumes when the user clicks Run / Apply / Install
// (action runs, result appended) or Dismiss (decline note appended,
// so the model can try a different approach).
async function processAgentActions(actions) {
  let outcomes = 0;
  for (const action of actions) {
    if (!loopState || loopState.stopRequested) break;
    const roundLabel = () => 'Working… round ' + loopState.round + '/' + loopState.maxRounds + ' — ';
    if (action.type === 'files') {
      const paths = action.changes.map(c => c.path).join(', ');
      // v0.5.1: a pure set of NEW Unity-native asset files
      // auto-applies — snapshot first, no Apply click, and the loop
      // keeps going. The tool result tells the model it was written.
      if (await isAutoApplyAssetSet(action.changes)) {
        const summary = await applyFileChanges(action.changes);
        await appendToolResult('Tool result — Unity asset files applied automatically: ' + paths
          + ' (' + summary.written + ' written, ' + summary.failed + ' failed)'
          + (summary.failed ? ' Errors: ' + summary.errors.join('; ') : '')
          + ' Snapshot taken — the user can still revert.');
        if (loopState) setLoopStatus(roundLabel() + 'auto-applied ' + summary.written + ' Unity asset file(s)');
        outcomes++;
      } else if (state.autoAcceptChanges) {
        const summary = await applyFileChanges(action.changes);
        await appendToolResult('Tool result — files applied: ' + paths
          + ' (' + summary.written + ' written, ' + summary.failed + ' failed)'
          + (summary.failed ? ' Errors: ' + summary.errors.join('; ') : ''));
        if (loopState) setLoopStatus(roundLabel() + 'applied ' + summary.written + ' file(s)');
        outcomes++;
      } else {
        const outcome = await waitForLoopDecision((settle) => showApplyBar(action.changes, settle));
        if (!loopState || loopState.stopRequested || outcome.decision === 'stopped') break;
        if (outcome.decision === 'applied') {
          const s = outcome.summary || { written: 0, failed: 0, errors: [] };
          await appendToolResult('Tool result — files applied: ' + paths
            + ' (' + s.written + ' written, ' + s.failed + ' failed)'
            + (s.failed ? ' Errors: ' + s.errors.join('; ') : ''));
          if (loopState) setLoopStatus(roundLabel() + 'applied ' + s.written + ' file(s)');
        } else {
          await appendToolResult('User declined: file changes (' + paths + ')');
        }
        outcomes++;
      }
    } else if (action.type === 'shell') {
      const cmd = action.command;
      if (!state.shellEnabled) {
        await appendToolResult('Tool result — ' + cmd + ':\nShell is disabled in Settings — command not run');
        outcomes++;
        continue;
      }
      const autoOk = state.shellAutoMode && matchesAutoApprove(cmd) && !isDangerousCommand(cmd);
      if (autoOk) {
        const res = await rb.shell.run({ command: cmd, cwd: state.projectPath });
        await appendToolResult(formatShellResult(cmd, res));
        if (loopState) setLoopStatus(roundLabel() + 'ran `' + firstCommandLine(cmd) + '`');
        outcomes++;
      } else {
        const outcome = await waitForLoopDecision((settle) => showShellBar(cmd, settle));
        if (!loopState || loopState.stopRequested || outcome.decision === 'stopped') break;
        if (outcome.decision === 'run') {
          await appendToolResult(formatShellResult(cmd, outcome.result));
          if (loopState) setLoopStatus(roundLabel() + 'ran `' + firstCommandLine(cmd) + '`');
        } else {
          const short = cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd;
          await appendToolResult('User declined: ' + short);
        }
        outcomes++;
      }
    } else if (action.type === 'package-install' || action.type === 'package-remove') {
      const isInstall = action.type === 'package-install';
      const label = isInstall ? 'package install' : 'package removal';
      if (!action.valid) {
        await appendToolResult('Tool result — ' + label + ': "' + action.raw + '" is not a valid package '
          + (isInstall ? 'spec' : 'name') + ' — skipped. Use `name@version`, a bare package name, or a git URL.');
        outcomes++;
        continue;
      }
      if (!state.projectPath) {
        await appendToolResult('Tool result — ' + label + ': ' + (action.name || action.raw)
          + ' — No project folder set, package not ' + (isInstall ? 'installed' : 'removed') + '. Pick a project folder in Settings first.');
        outcomes++;
        continue;
      }
      // Packages ALWAYS need approval — no auto-run path exists, not
      // in Auto Mode and not with auto-accept on.
      const outcome = await waitForLoopDecision((settle) => showPackageBar(action, {
        approved: (res, name, version) => settle({ decision: 'approved', result: res, name, version }),
        declined: () => settle({ decision: 'declined' }),
      }));
      if (!loopState || loopState.stopRequested || outcome.decision === 'stopped') break;
      if (outcome.decision === 'approved') {
        await appendToolResult(packageResultText(
          { ...action, name: outcome.name || action.name, version: outcome.version || action.version },
          outcome.result));
        if (loopState) setLoopStatus(roundLabel() + (isInstall ? 'installed ' : 'removed ')
          + (outcome.name || action.name) + (isInstall && (outcome.version || action.version) ? '@' + (outcome.version || action.version) : ''));
      } else {
        await appendToolResult('User declined ' + label + ': ' + (action.name || action.raw));
      }
      outcomes++;
    } else if (action.type === 'comfyui') {
      // ComfyUI generation (v0.6.0, Agent mode only). The workflow
      // must exist in the catalogue AND be Available; an unapproved
      // workflow pauses on a Run/Review bar instead of running.
      if (!action.valid) {
        await appendToolResult('Tool result — ComfyUI: could not parse the ```comfyui block'
          + (action.error ? ' (' + action.error + ')' : '')
          + ' — expected JSON {"workflow": "<name>", "inputs": {...}}.');
        outcomes++;
        continue;
      }
      const wf = findComfyuiWorkflow(action.workflow);
      if (!wf) {
        await appendToolResult('Tool result — ComfyUI: workflow "' + action.workflow + '" is not in the Workflow Library. Import it in the ComfyUI panel first.');
        outcomes++;
        continue;
      }
      if (!wf.available) {
        await appendToolResult('Tool result — ComfyUI: workflow "' + wf.name + '" is unavailable: '
          + (wf.availableReason || (wf.missing || []).join('; ') || 'missing dependencies') + '.');
        outcomes++;
        continue;
      }
      if (!wf.approved) {
        const outcome = await waitForLoopDecision((settle) => showComfyuiBar(wf, action.inputs, settle));
        if (!loopState || loopState.stopRequested || outcome.decision === 'stopped') break;
        if (outcome.decision !== 'run') {
          await appendToolResult('User declined: generate with ComfyUI workflow "' + wf.name + '".');
          outcomes++;
          continue;
        }
      }
      if (loopState) setLoopStatus(roundLabel() + 'generating with ComfyUI (' + wf.name + ')…');
      const res = await runComfyuiGeneration(wf, action.inputs);
      if (res.ok) {
        const imported = await importComfyuiOutputs(wf, res.outputs, action.inputs);
        await appendToolResult('Tool result — ComfyUI: generated ' + res.outputs.length + ' image(s) with workflow "' + wf.name + '"'
          + (imported.imported.length ? ' and imported them to ' + imported.dir + ': ' + imported.imported.map(i => i.filename).join(', ') : ' (nothing imported' + (imported.errors.length ? ': ' + imported.errors.join('; ') : '') + ')')
          + '.');
        if (loopState) setLoopStatus(roundLabel() + 'generated ' + res.outputs.length + ' image(s) with ' + wf.name);
      } else {
        await appendToolResult('Tool result — ComfyUI: generation with "' + wf.name + '" failed: ' + res.error);
      }
      outcomes++;
    }
  }
  return outcomes;
}

// ── Package approval bar (v0.5.0) ─────────────────────────────────
// Shown for ```upm-install / ```upm-remove blocks. Package installs
// and removals only ever run from this bar — there is no auto-run
// path. When the model gave no version, the bar shows an editable
// version field (pre-filled empty) and Install stays disabled until
// a valid version is typed; a git URL with no package name likewise
// needs a name typed in. `cb` is { approved(res, name, version),
// declined() }; with no callbacks the bar appends the result itself
// (the Ask / Plan path, via pumpPackageQueue).
function showPackageBar(action, cb) {
  const existing = document.getElementById('package-bar');
  if (existing) existing.remove();
  const isInstall = action.type === 'package-install';
  const callbacks = cb || {};
  const bar = document.createElement('div');
  bar.id = 'package-bar';
  bar.style.cssText = 'position:fixed;bottom:0;left:260px;right:280px;background:var(--bg2);border-top:1px solid var(--border2);padding:10px 16px;display:flex;align-items:center;gap:12px;z-index:50;box-shadow:0 -2px 12px rgba(0,0,0,0.3);';
  const label = document.createElement('span');
  label.style.cssText = 'color:var(--amber);font-size:13px;flex:1;';
  label.textContent = (isInstall ? 'Install Unity package ' : 'Remove Unity package ')
    + (action.name || '(package name needed)')
    + (isInstall && action.version ? '@' + action.version : '') + '?';
  bar.appendChild(label);
  let nameInput = null;
  let versionInput = null;
  const inputStyle = 'background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 10px;font-size:12px;font-family:var(--mono);';
  if (!action.name) {
    nameInput = document.createElement('input');
    nameInput.placeholder = 'package name, e.g. com.unity.textmeshpro';
    nameInput.style.cssText = inputStyle + 'width:260px;';
    bar.appendChild(nameInput);
  }
  if (isInstall && !action.version) {
    versionInput = document.createElement('input');
    versionInput.placeholder = 'version, e.g. 3.0.6';
    versionInput.style.cssText = inputStyle + 'width:130px;';
    bar.appendChild(versionInput);
  }
  const confirmBtn = document.createElement('button');
  confirmBtn.className = isInstall ? 'btn btn-teal' : 'btn btn-danger';
  confirmBtn.textContent = isInstall ? 'Install' : 'Remove';
  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn btn-secondary';
  dismissBtn.textContent = 'Dismiss';
  let decided = false;
  const validate = () => {
    const name = nameInput ? nameInput.value.trim() : action.name;
    const version = versionInput ? versionInput.value.trim() : action.version;
    const nameOk = isValidPackageName(name);
    const versionOk = !isInstall || isValidPackageVersion(version);
    const projectOk = !!state.projectPath;
    confirmBtn.disabled = !(nameOk && versionOk && projectOk);
    if (!projectOk) label.textContent = 'Set a project folder first — package installs need a project.';
  };
  if (nameInput) nameInput.addEventListener('input', validate);
  if (versionInput) versionInput.addEventListener('input', validate);
  confirmBtn.onclick = async () => {
    if (decided) return;
    decided = true;
    const name = nameInput ? nameInput.value.trim() : action.name;
    const version = versionInput ? versionInput.value.trim() : action.version;
    confirmBtn.disabled = true;
    confirmBtn.textContent = isInstall ? 'Installing…' : 'Removing…';
    // The only place a package is ever installed or removed.
    const res = isInstall
      ? await rb.unity.addPackage({ name, version, projectPath: state.projectPath })
      : await rb.unity.removePackage({ name, projectPath: state.projectPath });
    bar.remove();
    if (callbacks.approved) callbacks.approved(res, name, version);
    else addSystemMessage(packageResultText({ ...action, name, version }, res));
  };
  dismissBtn.onclick = () => {
    if (decided) return;
    decided = true;
    bar.remove();
    if (callbacks.declined) callbacks.declined();
  };
  bar.appendChild(confirmBtn);
  bar.appendChild(dismissBtn);
  document.body.appendChild(bar);
  validate();
  if (nameInput) nameInput.focus();
  else if (versionInput) versionInput.focus();
}

// Ask / Plan path for package blocks: no loop, so queue the bars one
// at a time and append each result as a system message.
function handlePackageBlocks(text) {
  const actions = parseAgentActions(text)
    .filter(a => a.type === 'package-install' || a.type === 'package-remove');
  if (!actions.length) return;
  if (!window._packageQueue) window._packageQueue = [];
  window._packageQueue.push(...actions);
  pumpPackageQueue();
}

function pumpPackageQueue() {
  if (document.getElementById('package-bar')) return;
  const next = (window._packageQueue || []).shift();
  if (!next) return;
  showPackageBar(next, {
    approved: (res, name, version) => {
      addSystemMessage(packageResultText({ ...next, name, version }, res));
      pumpPackageQueue();
    },
    declined: () => {
      addSystemMessage('User declined package ' + (next.type === 'package-install' ? 'install' : 'removal') + ': ' + (next.name || next.raw));
      pumpPackageQueue();
    },
  });
}

function buildSystemPrompt(rulesets) {
  const ctx = state.projectContext || 'a software project';
  let prompt = 'You are an expert software developer working on ' + ctx + '.\n';
  // Capability statement (v0.5.2) — first, in every mode, in plain
  // words a small local model cannot misread: this app WRITES the
  // files the model outputs. Without this, a local model falls back
  // on its generic "I'm just a chat window, I can't edit files"
  // refusal — which is not true here. Kept short (~330 chars) so it
  // does not eat the rules budget; it is separate from the rulesets.
  prompt += 'You are CodeFox, a coding assistant running inside an app. You CAN edit the project\'s files. When you output a changed file, CodeFox writes it to disk for you (after taking a snapshot, so it can be reverted). Never say you cannot modify files, cannot write code, or cannot provide code — that is not true here.\n\n';
  prompt += 'You run locally on the user\'s machine, on a local model with a smaller context window than cloud models. Keep answers focused, work one step at a time, and never invent files, APIs, or asset paths that are not in the project context below. If you do not know something, say so instead of guessing.\n';
  prompt += 'Always write code that fits the existing patterns and architecture. Be specific about file paths and complete implementations.\n\n';
  const scan = projectScanSummary();
  if (scan) prompt += '## Project context (from a scan of the project folder)\n\n' + scan + '\n\n';
  // Rules budget (Settings > Rules): enabled rulesets only, highest
  // priority first, whole rulesets only — never cut one off mid-way.
  const budget = state.rulesCharBudget || 4000;
  const enabled = (rulesets || []).filter(r => r.enabled == null || Number(r.enabled) !== 0);
  enabled.sort((a, b) => (Number(b.priority || 0) - Number(a.priority || 0)) || (Number(b.id || 0) - Number(a.id || 0)));
  const totalChars = enabled.reduce((n, r) => n + (r.content || '').length, 0);
  const included = [];
  const leftOut = [];
  let usedChars = 0;
  if (enabled.length) {
    if (totalChars > budget && state.useCondensedRules && state.condensedRules) {
      // Over budget and the user asked for condensed rules: send the
      // condensed version instead of dropping rules silently.
      prompt += '## Project Rules (condensed — the full rules exceeded the ' + budget + '-character budget)\n\n' + state.condensedRules + '\n\n';
      included.push('Condensed rules');
      usedChars = state.condensedRules.length;
      enabled.forEach(r => leftOut.push(r.name));
    } else {
      for (const r of enabled) {
        const len = (r.content || '').length;
        if (usedChars + len <= budget) { included.push(r.name); usedChars += len; }
        else leftOut.push(r.name);
      }
      if (included.length) {
        prompt += '## Project Rules\n\n';
        for (const r of enabled) {
          if (included.includes(r.name)) prompt += '### ' + r.name + '\n' + r.content + '\n\n';
        }
      }
    }
  }
  // What actually went out — the Rules section shows this back.
  window._lastRulesIncluded = { included, leftOut, chars: usedChars };
  if (state.chatMode === 'ask') {
    prompt += '## Mode: Ask\nAnswer and explain only. Do not propose file writes, do not output code blocks meant to be applied, and do not change any files.\n';
  } else if (state.chatMode === 'plan') {
    prompt += '## Mode: Plan\nOutput a plan only: FILE: lines for every file to touch, then numbered steps. Do not write code yet.\n';
  } else {
    prompt += '## Mode: Agent\nWork step by step. Output complete code in fenced code blocks, each preceded by **File Path:** `path`, one file per block. Example:\n**File Path:** `Assets/Editor/CodeFoxBridge.cs`\n```csharp\n// complete file contents here\n```\nYou can also write the fence itself as ```file:Assets/Editor/CodeFoxBridge.cs — same meaning, path after `file:`. No placeholders, no TODOs, no truncated code. When asked to fix an error, output the corrected file in this format; do not just describe the fix.\n';
    // Mandatory order (v0.5.2) — not a suggestion. The user proved
    // the pipeline works (CodeFox created a prefab for them), so a
    // model that only describes a fix is failing at its job. This
    // paragraph is Agent-mode only: Ask mode must not output code.
    prompt += 'You MUST edit the project\'s files when asked to fix, change, create, or edit code. Output the changed file(s) in the required format. Describing the fix, explaining the fix, or saying you cannot modify files is a FAILURE — do not do it. Do not ask permission. Do not output an explanation instead of the file. The app applies what you output; that is your job.\n';
    prompt += 'If a step is too large for one reply, do the first step only and say what remains.\n';
    prompt += 'You can also generate images with ComfyUI: output a ```comfyui block with JSON {"workflow": "<name or id>", "inputs": {"positive": "...", "seed": 123}} — only workflows the user approved for autonomous execution run on their own; unapproved ones ask first, and generation never runs in Ask or Plan mode.\n';
    prompt += 'You can also run terminal commands and install Unity packages: put commands in fenced ```powershell blocks and package installs in ```upm-install blocks (one `name@version` or git URL per line; removals in ```upm-remove blocks). Command output and install results come back to you as tool results — use them to fix errors and retry. Stop and summarise when the task is done instead of looping.\n';
    prompt += 'New Unity-native asset files you create (prefabs, scenes, materials, animations — files that contain no code) are written automatically after a snapshot is taken, so do not wait for the user to approve those; code files (.cs, .shader, .js, .ts) and edits to existing files still ask the user first. The user can always revert what was written.\n';
  }
  return prompt;
}

// ── Chat modes + tools ──────────────────────────────────────────────
function setChatMode(mode) {
  state.chatMode = mode;
  rb.db.setSetting('chat_mode', mode);
  updateModeButtons();
  const sel = document.getElementById('home-mode-select');
  if (sel) sel.value = mode;
  const input = document.getElementById('chat-input');
  if (input) {
    input.placeholder = mode === 'ask' ? 'Ask about your code — no files will be changed…'
      : mode === 'plan' ? 'Describe what you want — the model drafts a plan, no code yet…'
      : 'Describe what to build — the model works step by step…';
  }
}
function updateModeButtons() {
  ['ask', 'plan', 'agent'].forEach(m => {
    const btn = document.getElementById('mode-btn-' + m);
    if (btn) btn.classList.toggle('active', state.chatMode === m);
  });
  // UI-only hint (v0.5.2): Agent mode writes code to the project.
  const hint = document.getElementById('agent-hint');
  if (hint) hint.classList.toggle('hidden', state.chatMode !== 'agent');
}
function insertPrompt(text) {
  if (state.mode !== 'chat') {
    document.getElementById('chat-mode').classList.remove('hidden');
    document.getElementById('editor-mode').classList.add('hidden');
    document.getElementById('plan-mode').classList.add('hidden');
    state.mode = 'chat';
  }
  const input = document.getElementById('chat-input');
  input.value = text;
  input.focus();
  autoResize(input);
}
function addSystemMessage(text) {
  state.messages.push({ role: 'system', content: text });
  renderMessages();
}
function projectScanSummary() {
  const scan = state.projectScan;
  if (!scan || !scan.ok) return '';
  const parts = [];
  if (scan.unityVersion) parts.push('Unity version: ' + scan.unityVersion);
  const pkgs = Object.keys(scan.packages || {});
  if (pkgs.length) parts.push('Packages: ' + pkgs.slice(0, 30).map(n => n + '@' + (scan.packages[n] || '') + (scan.locked && scan.locked[n] && scan.locked[n] !== scan.packages[n] ? ' (locked ' + scan.locked[n] + ')' : '')).join(', '));
  if (scan.scenes && scan.scenes.length) parts.push('Scenes: ' + scan.scenes.map(x => x.path + (x.gameObjects.length ? ' (' + x.gameObjects.slice(0, 10).join(', ') + ')' : '')).join('; ').slice(0, 1200));
  if (scan.prefabs && scan.prefabs.length) parts.push('Prefabs: ' + scan.prefabs.map(x => x.path).slice(0, 40).join(', '));
  parts.push('Scripts: ' + scan.scriptCount + ' C# files' + (scan.scripts ? ' — ' + scan.scripts.slice(0, 60).join(', ') : ''));
  parts.push('Files: ' + scan.fileCount);
  return parts.join('\n').slice(0, 4000);
}
async function scanProject() {
  showToast('Scanning project…');
  const scan = await rb.project.scan(state.projectPath);
  if (!scan.ok) { showToast('⚠ ' + scan.error); return scan; }
  state.projectScan = scan;
  const pkgCount = Object.keys(scan.packages || {}).length;
  showToast(`✓ Scanned: ${scan.scriptCount} scripts, ${scan.scenes.length} scenes, ${scan.prefabs.length} prefabs, ${pkgCount} packages`);
  addSystemMessage(`Project scan — Unity ${scan.unityVersion || 'unknown'}, ${scan.scriptCount} scripts, ${scan.scenes.length} scenes, ${scan.prefabs.length} prefabs, ${pkgCount} packages. This context is now included in every chat prompt.`);
  return scan;
}
function diagnoseError() {
  // Agent mode (v0.5.2): diagnosing ends in a fix — the model
  // outputs the corrected file, and CodeFox applies it. The file
  // named in the error is attached automatically when the message
  // is sent (see diagnoseErrorContext, called from sendChat).
  setChatMode('agent');
  insertPrompt(`I pasted a Unity console error / log below. Diagnose it and fix it:
1. What the error means, in plain language
2. The file and line causing it
3. Output the corrected file in the required format — do not just describe the fix

\`\`\`
PASTE THE ERROR OR LOG HERE
\`\`\`
`);
}

// When a message reports a Unity error naming a file (e.g.
// "Assets/Editor/CodeFoxBridge.cs(156,45): error CS1501 ..."),
// read that file and attach the lines around the reported line to
// the system prompt, with an instruction to output the fixed file.
// Returns '' when the message names no file. When the file cannot
// be read, the note says so instead of silently omitting it.
async function diagnoseErrorContext(userText) {
  if (!/error|diagnose/i.test(userText || '')) return '';
  const m = userText.match(/(Assets[\\/][^\s:'"\)\]]+?)(?:\((\d+)(?:,\d+)?\)|:(\d+))?/);
  if (!m) return '';
  const filePath = m[1].replace(/\\/g, '/').replace(/[.,;]+$/, '');
  const lineNo = parseInt(m[2] || m[3] || '0', 10) || 0;
  let read = null;
  try { read = await rb.fs.readFile(resolvePath(filePath)); } catch { read = null; }
  if (!read || !read.ok) {
    return '\n\n[CodeFox note: the error names ' + filePath + ' but that file could not be read from the project folder — say so and ask the user to check the path.]\n';
  }
  const lines = String(read.content || '').split('\n');
  const centre = lineNo ? lineNo - 1 : 0;
  const start = Math.max(0, centre - 20);
  const end = Math.min(lines.length, centre + 21);
  const excerpt = lines.slice(start, end).map((l, i) => (start + i + 1) + ': ' + l).join('\n');
  return '\n\n[CodeFox note: the error names ' + filePath + (lineNo ? ' line ' + lineNo : '') + '. That file is in the project — here are the surrounding lines:\n```\n' + excerpt + '\n```\nOutput the corrected file in the required format (**File Path:** `' + filePath + '` then a fenced code block). Do not just describe the fix.]\n';
}
function generateTests() {
  const file = state.activeFilePath ? state.activeFilePath.split(/[\\/]/).pop() : null;
  setChatMode('agent');
  insertPrompt(file
    ? `Write EditMode tests for ${file} (currently open in the viewer). Create a new test file under Assets/Tests/ named after the class under test, using NUnit. Cover the main behaviour and the obvious edge cases. Output the complete test file with **File Path:** \`Assets/Tests/...\` and a fenced code block. Then tell me how to run it with the Run tests button.`
    : 'Write EditMode tests for a script in this project. First ask me which file to test, or pick the most central gameplay script from the project scan and say which one you chose. Create the test file under Assets/Tests/ using NUnit, and output it with **File Path:** and a fenced code block.');
}
function buildAnimator() {
  setChatMode('agent');
  insertPrompt(`Generate a Unity Editor script that builds an Animator Controller for me. I will describe the states and parameters below — fill in what I leave out with sensible defaults, and say so.

Controller name: 
Parameters (name, type: Float/Int/Bool/Trigger): 
States (name, motion clip if any, speed): 
Transitions (from -> to, parameter + condition): 

Output the complete C# Editor script with **File Path:** \`Assets/Editor/GenerateAnimator.cs\` in a fenced code block. The script must use AnimatorController.CreateAnimatorControllerAtPath and be runnable from the Unity menu. Do not invent motion clips that do not exist in the project — check the project scan first and only reference clips that are listed there.`);
}
function buildUI() {
  setChatMode('agent');
  insertPrompt(`Generate a Unity Editor script that builds a UI screen for me. Describe the screen below (Canvas, panels, text, buttons, layout) and I will generate the complete C# Editor script with **File Path:** \`Assets/Editor/GenerateUI.cs\` in a fenced code block. The script must create the Canvas, RectTransforms and Unity UI components (Text, Button, Image, Panel) in code, use anchors sensibly, and be runnable from the Unity menu. Keep it simple — local models do layout best one screen at a time.

Screen to build: `);
}
async function runTests() {
  showToast('Running EditMode tests… (Unity batch mode, up to 10 min)');
  addSystemMessage('Running EditMode tests in Unity batch mode…');
  const res = await rb.unity.runTests({ projectPath: state.projectPath, unityExePath: state.unityExePath });
  if (!res.ok && !res.summary) {
    addSystemMessage('⚠ Tests could not run: ' + res.error);
    showToast('⚠ ' + res.error);
    return res;
  }
  const sum = res.summary || {};
  const msg = 'Test results: ' + (sum.passed ?? '?') + ' passed, ' + (sum.failed ?? '?') + ' failed, ' + (sum.skipped ?? 0) + ' skipped (total ' + (sum.total ?? '?') + ')' + (res.exitCode != null ? ' ' + String.fromCharCode(8212) + ' Unity exit code ' + res.exitCode : '') + '.' + (sum.failed ? '\n\nTail of the test output:\n' + (res.rawTail || '').slice(-1500) + '\n\nAsk the model to fix the failures, one at a time.' : '\nAll tests passed.');
  addSystemMessage(msg);
  showToast(sum.failed ? `⚠ Tests: ${sum.failed} failed` : '✓ All tests passed');
  return res;
}
async function buildCheck() {
  showToast('Running dotnet build check…');
  const res = await rb.unity.buildCheck({ projectPath: state.projectPath });
  if (!res.ok && !res.solution) {
    addSystemMessage('⚠ Build check could not run: ' + res.error);
    showToast('⚠ ' + res.error);
    return res;
  }
  addSystemMessage(res.ok
    ? `✓ Build check passed (${res.solution}).`
    : `⚠ Build check failed (exit ${res.exitCode}, ${res.solution}). Tail:
${(res.rawTail || '').slice(-2000)}

Paste this into chat and ask the model to fix the first error.`);
  showToast(res.ok ? '✓ Build check passed' : '⚠ Build check failed');
  return res;
}

// ── Plan execution ────────────────────────────────────────────────
async function executePlan() {
  console.log('[executePlan] START — activeItemId:', state.activeItemId, 'streaming:', state.streaming);
  // Capture plan before any state changes
  const planId = state.activeItemId;
  const item = await rb.db.get('plans', planId);
  console.log('[executePlan] item fetched:', item ? item.name : 'NULL');
  if (!item) { console.error('[executePlan] ABORT: no item'); return; }
  if (state.streaming) { showToast('Wait for current response to finish'); console.warn('[executePlan] ABORT: streaming'); return; }

  // Build prompt before switching threads
  const rulesets = await rb.db.getAll('rulesets');
  const systemPrompt = buildSystemPrompt(rulesets);
  const scan = projectScanSummary();
  const prompt = `You are executing a development plan for this project.

Project context: ${state.projectContext || 'a Unity project'}${scan ? '\n' + scan : ''}

Read the plan carefully. For each step, write the complete C# code. Be specific about:
- Exact file paths
- Complete method implementations (no placeholders)
- How the new code fits the existing architecture

PLAN TO EXECUTE:
${item.content}

Begin with Step 1. Work through each step in order.`;

  console.log('[executePlan] creating thread...');
  // Create thread first — don't parseInt, use raw return value
  const rawThreadId = await rb.db.insert('threads', { name: 'Execute: ' + item.name, project_id: state.activeProjectId });
  const threadId = Number(rawThreadId);
  console.log('[executePlan] thread created raw:', rawThreadId, 'as Number:', threadId, 'typeof:', typeof rawThreadId);

  // Switch to the new thread — wait for it to fully complete
  await loadThread(threadId);
  console.log('[executePlan] loadThread done — activeThreadId:', state.activeThreadId, 'mode:', state.mode);
  await refreshSidebar();

  // Let the DOM fully paint before we touch it
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 150));

  // Verify we are on the right thread and in chat mode
  console.log('[executePlan] after wait — activeThreadId:', state.activeThreadId, 'expected:', threadId);
  if (state.activeThreadId !== threadId) {
    console.error('[executePlan] ABORT: thread mismatch', state.activeThreadId, '!==', threadId);
    return;
  }

  // Check input exists
  const input = document.getElementById('chat-input');
  console.log('[executePlan] chat-input element:', input ? 'FOUND' : 'NULL');
  console.log('[executePlan] chat-mode hidden?', document.getElementById('chat-mode')?.classList.contains('hidden'));
  if (!input) { console.error('[executePlan] ABORT: no chat-input element'); return; }

  input.value = prompt;
  console.log('[executePlan] prompt set, length:', prompt.length, '— calling sendChat...');

  window._execPlanSystemPrompt = systemPrompt;
  window._execPlanActive = true;

  await sendChat();
  console.log('[executePlan] sendChat returned');

  await rb.db.update('plans', planId, { status: 'executed' });
  console.log('[executePlan] DONE');
}
async function sendPageToChat() {
  const item = await rb.db.get('pages', state.activeItemId);
  if (!item) return;
  const threadId = await rb.db.insert('threads', { name: `Discuss: ${item.name}`, project_id: state.activeProjectId });
  await refreshSidebar();
  await loadThread(threadId);
  document.getElementById('chat-input').value = `Here is the architecture page for "${item.name}":\n\n${item.content}\n\nLet's discuss this.`;
  await sendChat();
}

// ── File search ───────────────────────────────────────────────────
let allFiles = []; // flat list of all file paths, built on load

// Same match as main.js isExcludedFile: an entry matches a file name
// exactly (e.g. package-lock.json) or as its extension (e.g. .meta).
function isExcludedFileName(name) {
  const lower = String(name || '').toLowerCase();
  for (const entry of state.excludedFileTypes || []) {
    const e = String(entry).toLowerCase();
    if (!e) continue;
    if (lower === e || lower.endsWith('.' + e)) return true;
  }
  return false;
}

async function buildFileIndex(dirPath) {
  const items = await rb.fs.readDir(dirPath);
  for (const item of items) {
    if (item.isDir) {
      await buildFileIndex(item.path);
    } else if (!isExcludedFileName(item.name)) {
      allFiles.push({ name: item.name, path: item.path });
    }
  }
}

function searchFiles(query) {
  const resultsEl = document.getElementById('file-search-results');
  const treeEl = document.getElementById('file-tree');
  const q = query.trim().toLowerCase();

  if (!q) {
    resultsEl.style.display = 'none';
    treeEl.style.display = 'block';
    return;
  }

  treeEl.style.display = 'none';
  resultsEl.style.display = 'block';

  const matches = allFiles.filter(f => !isExcludedFileName(f.name) && f.name.toLowerCase().includes(q)).slice(0, 50);

  if (!matches.length) {
    resultsEl.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:12px;">No files found</div>';
    return;
  }

  resultsEl.innerHTML = matches.map(f => `
    <div class="tree-item${f.name.endsWith('.cs') ? ' tree-cs' : ''}" 
         title="${f.path}" 
         onclick="loadFileInViewer('${f.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${f.name}</span>
      <span style="font-size:10px;color:var(--text3);margin-left:4px;flex-shrink:0;">${getShortPath(f.path)}</span>
    </div>
  `).join('');
}

function getShortPath(fullPath) {
  const parts = fullPath.replace(/\\/g, '/').split('/');
  // Show last 2 folder segments
  const relevant = parts.slice(-3, -1).join('/');
  return relevant;
}

// ── File tree ─────────────────────────────────────────────────────
async function loadFileTree(dirPath, container, depth) {
  const items = await rb.fs.readDir(dirPath);
  if (!items.length) return;

  const frag = document.createDocumentFragment();
  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'tree-item' + (item.isDir ? ' tree-dir' : getFileClass(item.name));
    div.style.paddingLeft = (10 + depth * 14) + 'px';
    div.textContent = (item.isDir ? '▸ ' : '  ') + item.name;
    div.title = item.path;

    if (item.isDir) {
      let expanded = false;
      let childContainer = null;
      div.onclick = async () => {
        expanded = !expanded;
        div.textContent = (expanded ? '▾ ' : '▸ ') + item.name;
        if (expanded) {
          childContainer = document.createElement('div');
          container.insertBefore(childContainer, div.nextSibling);
          await loadFileTree(item.path, childContainer, depth + 1);
        } else if (childContainer) {
          childContainer.remove();
          childContainer = null;
        }
      };
    } else {
      div.onclick = () => loadFileInViewer(item.path);
    }
    frag.appendChild(div);
  }
  container.appendChild(frag);
}

function getFileClass(name) {
  if (name.endsWith('.cs')) return ' tree-cs';
  return '';
}

async function loadFileInViewer(filePath) {
  state.activeFilePath = filePath;
  document.getElementById('active-file-name').textContent = filePath.split('\\').pop() || filePath.split('/').pop();
  document.getElementById('load-to-chat-btn').style.display = 'block';

  const result = await rb.fs.readFile(filePath);
  const viewer = document.getElementById('file-viewer-content');
  if (result.ok) {
    viewer.textContent = result.content;
  } else {
    viewer.textContent = '⚠ Could not read file: ' + result.error;
  }

  // Highlight active in tree
  document.querySelectorAll('.tree-item').forEach(el => {
    el.classList.toggle('active', el.title === filePath);
  });
}

function loadFileToChat() {
  if (!state.activeFilePath) return;
  rb.fs.readFile(state.activeFilePath).then(result => {
    if (!result.ok) return;
    const name = state.activeFilePath.split('\\').pop() || state.activeFilePath.split('/').pop();
    document.getElementById('chat-input').value = `Here is the file ${name}:\n\`\`\`csharp\n${result.content}\n\`\`\`\n\n`;
    document.getElementById('chat-input').focus();
    autoResize(document.getElementById('chat-input'));
    if (state.mode !== 'chat') {
      const t = state.activeThreadId;
      loadThread(t);
    }
  });
}

// ── Folder picker ─────────────────────────────────────────────────
async function pickProjectFolder() {
  const folder = await rb.fs.pickFolder();
  if (!folder) return;
  state.projectPath = folder;
  await rb.db.setSetting('project_path', folder);
  if (state.activeProjectId != null) {
    await rb.project.update(state.activeProjectId, { path: folder });
    state.activeProject = { ...state.activeProject, path: folder };
  }
  setProjectPathLabels();
  document.getElementById('file-tree').innerHTML = '';
  allFiles = [];
  await loadFileTree(folder, document.getElementById('file-tree'), 0);
  buildFileIndex(folder);
  if (state.mode === 'home') renderHome();
}

// ── New item modal ────────────────────────────────────────────────
let modalCallback = null;
function newItem(table) {
  const titles = { rulesets: 'New ruleset', plans: 'New plan', pages: 'New reference' };
  document.getElementById('modal-title').textContent = titles[table] || 'New item';
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('modal-name').focus();
  modalCallback = async () => {
    const name = document.getElementById('modal-name').value.trim();
    if (!name) return;
    const id = await rb.db.insert(table, { name, content: '', project_id: state.activeProjectId });
    await refreshSidebar();
    await loadItem(table, id);
    closeModal();
  };
}

async function newThread() {
  document.getElementById('modal-title').textContent = 'New conversation';
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('modal-name').focus();
  modalCallback = async () => {
    const name = document.getElementById('modal-name').value.trim();
    if (!name) return;
    const id = parseInt(await rb.db.insert('threads', { name, project_id: state.activeProjectId }), 10);
    await loadThread(id);
    await refreshSidebar();
    closeModal();
  };
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  modalCallback = null;
}

function confirmModal() {
  if (modalCallback) modalCallback();
}

document.getElementById('modal-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmModal();
  if (e.key === 'Escape') closeModal();
});

// ── Delete ────────────────────────────────────────────────────────
async function deleteItem(table, id) {
  await rb.db.delete(table, id);
  if (state.activeItemId === id) {
    setMode('chat', 'New conversation');
    state.activeItemId = null;
    state.activeTable = null;
  }
  await refreshSidebar();
  if (state.mode === 'home') renderHome();
}

async function deleteThread(id) {
  await rb.db.delete('threads', id);
  const threads = await rb.db.getAll('threads');
  const mine = state.activeProjectId == null ? threads : threads.filter(t => t.project_id == null || Number(t.project_id) === Number(state.activeProjectId));
  if (mine.length) {
    await loadThread(parseInt(mine[0].id, 10));
  } else {
    const newId = parseInt(await rb.db.insert('threads', { name: 'General', project_id: state.activeProjectId }), 10);
    await loadThread(newId);
    await refreshSidebar();
  }
}

async function renameThread() {
  document.getElementById('modal-title').textContent = 'Rename conversation';
  const t = await rb.db.get('threads', state.activeThreadId);
  document.getElementById('modal-name').value = t ? t.name : '';
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('modal-name').focus();
  modalCallback = async () => {
    const name = document.getElementById('modal-name').value.trim();
    if (!name) return;
    await rb.db.update('threads', state.activeThreadId, { name });
    document.getElementById('center-title').textContent = name;
    await refreshSidebar();
    closeModal();
  };
}

// ── Settings (full window, v0.4.0) ──────────────────────────────
// Settings is a centre view (mode 'settings'), not a popup modal.
// The left sidebar stays visible; the view has its own sub-nav:
// Model / Connections / MCPs / Rules / Advanced. There is deliberately
// no account, subscription, or multi-user section — CodeFox is a
// single-user local app.

function showSettings(section) {
  if (section) state.settingsSection = section;
  setMode('settings', 'Settings');
}

function setSettingsSection(section) {
  state.settingsSection = section;
  renderSettingsView();
}

function renderSettingsView() {
  const el = document.getElementById('settings-mode');
  if (!el) return;
  const sections = [
    { id: 'model', label: 'Model' },
    { id: 'connections', label: 'Connections' },
    { id: 'mcps', label: 'MCPs' },
    { id: 'rules', label: 'Rules' },
    { id: 'advanced', label: 'Advanced' },
  ];
  const meta = {
    model: ['Model', 'Which local model answers, and how CodeFox reaches it.'],
    connections: ['Your Connections', 'Local integrations for this project. Nothing here phones home.'],
    mcps: ['MCPs', 'Connect local MCP servers so the assistant can use their tools. Servers run on this machine; CodeFox never sends your code to them or anywhere else.'],
    rules: ['Rules', 'Rules are your instructions to the assistant — how CodeFox should write code, what to never do, your architecture contracts. They are the system prompt the model sees.'],
    advanced: ['Advanced', 'Shell tool, agent loop, approvals, and which files CodeFox ignores.'],
  };
  const sec = state.settingsSection || 'model';
  el.innerHTML = `
    <div class="settings-wrap">
      <div class="settings-subnav">
        ${sections.map(s2 => `<div class="settings-nav-item ${s2.id === sec ? 'active' : ''}" onclick="setSettingsSection('${s2.id}')">${s2.label}</div>`).join('')}
      </div>
      <div class="settings-pane">
        <h2 class="settings-heading">${meta[sec][0]}</h2>
        <p class="settings-desc">${meta[sec][1]}</p>
        <div id="settings-pane-body"></div>
      </div>
    </div>`;
  renderSettingsPane();
}

function renderSettingsPane() {
  const body = document.getElementById('settings-pane-body');
  if (!body) return;
  const sec = state.settingsSection || 'model';
  if (sec === 'model') renderModelPane(body);
  else if (sec === 'connections') renderConnectionsPane(body);
  else if (sec === 'mcps') renderMcpsPane(body);
  else if (sec === 'rules') renderRulesPane(body);
  else if (sec === 'advanced') renderAdvancedPane(body);
}

// ── Model section (the old popup's contents, moved into the window)
function renderModelPane(body) {
  const isLm = state.provider === 'lmstudio';
  const inp = (id, val, ph) => `<input id="${id}" value="${escHtml(val || '')}" placeholder="${ph || ''}" />`;
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <label class="field-label">LLM provider
        <select id="s-provider" onchange="onProviderChange()">
          <option value="lmstudio" ${isLm ? 'selected' : ''}>LM Studio (default)</option>
          <option value="ollama" ${!isLm ? 'selected' : ''}>Ollama</option>
        </select>
      </label>

      <div id="s-lm-section" style="display:${isLm ? 'flex' : 'none'};flex-direction:column;gap:12px;">
        <label class="field-label">LM Studio server URL
          ${inp('s-lm-url', state.lmstudioUrl, 'http://localhost:1234/v1')}
          <span class="field-note">Default: http://localhost:1234/v1 — start the local server in LM Studio first. A trailing /chat/completions is stripped automatically.</span>
        </label>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn-secondary" onclick="verifyLmStudio()">Verify connection</button>
          <button class="btn btn-secondary" onclick="refreshModels().then(r => { const el = document.getElementById('s-lm-status'); if (el && r.ok) { el.style.color = 'var(--green)'; el.textContent = '✓ ' + r.models.length + ' model(s) found.'; } })">Refresh models</button>
        </div>
        <div id="s-lm-status" style="font-size:12px;color:var(--text3);">Not verified yet — click Verify connection.</div>
        <label class="field-label">Model (from the live server list)
          <select id="s-lm-model">
            <option value="">— Select a model —</option>
          </select>
        </label>
        <label class="field-label">API key (optional — LM Studio needs none by default)
          <input id="s-lm-key" type="password" value="${escHtml(state.lmstudioApiKey || '')}" placeholder="Leave blank unless your server requires one" />
        </label>
      </div>

      <div id="s-ollama-section" style="display:${!isLm ? 'flex' : 'none'};flex-direction:column;gap:12px;">
        <label class="field-label">Ollama URL
          ${inp('s-url', state.ollamaUrl)}
        </label>
        <label class="field-label">Ollama model name
          ${inp('s-model', state.ollamaModel)}
        </label>
        <label class="field-label">Ollama executable path
          <span class="field-note">Leave blank to auto-detect</span>
          <div style="display:flex;gap:6px;">
            <input id="s-exe" value="${escHtml(state.ollamaExePath || '')}" placeholder="C:\\...\\ollama.exe" style="flex:1;" />
            <button class="btn btn-secondary" onclick="browseOllamaExe()" style="flex-shrink:0;">Browse</button>
          </div>
          <div id="s-exe-detected" style="margin-top:4px;font-size:11px;color:var(--text3);"></div>
        </label>
      </div>

      <label class="field-label">Temperature (0 = focused, 1 = creative)
        ${inp('s-temp', String(state.temperature), '0.2')}
      </label>
      <label class="field-label">Max tokens per reply
        ${inp('s-maxtokens', String(state.maxTokens), '4096')}
      </label>
      <label class="field-label">Project path
        ${inp('s-path', state.projectPath)}
      </label>
      <label class="field-label">Project context
        <input id="s-ctx" value="${escHtml(state.projectContext || '')}" placeholder="e.g. a Unity 6 card game" />
      </label>
      <label class="field-label">Unity Editor executable path
        <span class="field-note">Needed for Run tests</span>
        <div style="display:flex;gap:6px;">
          <input id="s-unity-exe" value="${escHtml(state.unityExePath || '')}" placeholder="C:\\Program Files\\Unity\\Hub\\Editor\\...\\Unity.exe" style="flex:1;" />
          <button class="btn btn-secondary" onclick="browseUnityExe()" style="flex-shrink:0;">Browse</button>
        </div>
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-primary" onclick="saveSettings()">Save</button>
      </div>
      <p class="settings-note">Settings save without losing the current thread — no reload.</p>
    </div>`;
  updateModelDropdown();
  // Try to populate the model list right away if LM Studio is up.
  if (isLm) refreshModels();
  rb.ollama.status().then(st => {
    const el = document.getElementById('s-exe-detected');
    if (el) el.textContent = st.exePath ? 'Auto-detected: ' + st.exePath : 'Could not auto-detect — use Browse to locate ollama.exe';
  });
}

function onProviderChange() {
  const provider = document.getElementById('s-provider')?.value || 'lmstudio';
  document.getElementById('s-lm-section').style.display = provider === 'lmstudio' ? 'flex' : 'none';
  document.getElementById('s-ollama-section').style.display = provider === 'ollama' ? 'flex' : 'none';
  if (provider === 'lmstudio') refreshModels();
}

async function browseOllamaExe() {
  const chosen = await rb.ollama.pickExe();
  if (chosen) {
    const input = document.getElementById('s-exe');
    if (input) input.value = chosen;
  }
}

async function browseUnityExe() {
  const chosen = await rb.fs.pickExe('Find Unity.exe');
  if (chosen) {
    const input = document.getElementById('s-unity-exe');
    if (input) input.value = chosen;
  }
}

async function saveSettings() {
  const provider = document.getElementById('s-provider')?.value || state.provider;
  state.provider = provider;
  await rb.db.setSetting('llm_provider', provider);
  if (provider === 'lmstudio') {
    const url = document.getElementById('s-lm-url')?.value?.trim();
    const model = document.getElementById('s-lm-model')?.value || '';
    const apiKey = document.getElementById('s-lm-key')?.value?.trim() || '';
    if (url) { state.lmstudioUrl = url; await rb.db.setSetting('lmstudio_url', url); }
    state.lmstudioModel = model;
    await rb.db.setSetting('lmstudio_model', model);
    state.lmstudioApiKey = apiKey;
    await rb.db.setSetting('lmstudio_api_key', apiKey);
  } else {
    const url = document.getElementById('s-url')?.value?.trim();
    const model = document.getElementById('s-model')?.value?.trim();
    const exe = document.getElementById('s-exe')?.value?.trim();
    if (url) { state.ollamaUrl = url; await rb.db.setSetting('ollama_url', url); }
    if (model) { state.ollamaModel = model; await rb.db.setSetting('ollama_model', model); }
    state.ollamaExePath = exe || '';
    await rb.db.setSetting('ollama_exe_path', exe || '');
    await rb.ollama.setPath(exe || '');
  }
  const temp = parseFloat(document.getElementById('s-temp')?.value);
  if (!isNaN(temp)) { state.temperature = Math.min(2, Math.max(0, temp)); await rb.db.setSetting('llm_temperature', String(state.temperature)); }
  const mt = parseInt(document.getElementById('s-maxtokens')?.value, 10);
  if (!isNaN(mt) && mt > 0) { state.maxTokens = mt; await rb.db.setSetting('llm_max_tokens', String(mt)); }
  const pathVal = document.getElementById('s-path')?.value?.trim();
  if (pathVal && pathVal !== state.projectPath) {
    state.projectPath = pathVal;
    await rb.db.setSetting('project_path', pathVal);
    if (state.activeProjectId != null) {
      await rb.project.update(state.activeProjectId, { path: pathVal });
      state.activeProject = { ...state.activeProject, path: pathVal };
    }
    document.getElementById('file-tree').innerHTML = '';
    allFiles = [];
    await loadFileTree(pathVal, document.getElementById('file-tree'), 0);
    buildFileIndex(pathVal);
  }
  const ctx = document.getElementById('s-ctx')?.value?.trim();
  if (ctx !== undefined) { state.projectContext = ctx; await rb.db.setSetting('project_context', ctx); }
  const unityExe = document.getElementById('s-unity-exe')?.value?.trim() || '';
  state.unityExePath = unityExe;
  await rb.db.setSetting('unity_exe_path', unityExe);
  // Re-init the LLM connection without losing the thread (no reload).
  setProjectPathLabels();
  if (state.mode === 'home') renderHome();
  if (state.mode === 'settings') renderSettingsView();
  await initLLM();
  showToast('✓ Settings saved');
}

// ── Connections section ───────────────────────────────────────────
function renderConnectionsPane(body) {
  const filter = window._connFilter || 'all';
  const tab = (id, label) => `<button class="chip-tab ${filter === id ? 'active' : ''}" onclick="setConnFilter('${id}')">${label}</button>`;
  body.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      ${tab('all', 'All')}${tab('unity', 'Unity')}${tab('folders', 'Folders')}
    </div>
    <div style="display:flex;gap:8px;margin:14px 0;">
      <button class="btn btn-teal" onclick="addUnityProject()">+ Add Unity project</button>
      <button class="btn btn-secondary" onclick="addLocalFolderFromSettings()">+ Add folder</button>
    </div>
    <div id="settings-connections-list"><div style="color:var(--text3);font-size:12px;">Checking statuses…</div></div>
    <button class="btn btn-secondary" onclick="showSettings('mcps')">Manage MCP connections →</button>`;
  renderSettingsConnections();
}

function setConnFilter(f) {
  window._connFilter = f;
  renderSettingsPane();
}

async function renderSettingsConnections() {
  const list = document.getElementById('settings-connections-list');
  if (!list) return;
  const filter = window._connFilter || 'all';
  const proj = state.activeProject;
  const bridgePath = state.projectPath ? state.projectPath + '/Assets/Editor/CodeFoxBridge.cs' : '';
  // Bridge status comes from the main process (v0.5.2): whether the
  // file exists on disk, whether the user has it toggled on for this
  // project, and whether the installed copy is older than the bundled
  // one. Status is always re-read after any operation — never from
  // optimistic local state.
  let status = null;
  try { status = await rb.unity.bridgeStatus(state.projectPath); } catch { status = null; }
  let bridgeExists = bridgePath ? await rb.fs.exists(bridgePath) : false;
  let bridgeEnabled = true;
  if (status) { bridgeExists = status.exists; bridgeEnabled = status.enabled; }
  // Auto-install / auto-update (v0.5.0/0.5.2): opening Connections on
  // a Unity project installs the bridge when it is missing and
  // overwrites it when the installed copy is out of date. Gated on
  // the toggle: when the user turned the bridge off, ensureBridge
  // no-ops, so a toggle-off is never undone by this re-render.
  // (That re-render was the v0.5.1 toggle bug: removing the bridge
  // then re-rendering re-installed it immediately.)
  let bridgeError = null;
  if (bridgeEnabled && state.projectPath) {
    const hasAssets = await rb.fs.exists(state.projectPath + '/Assets');
    if (hasAssets) {
      try {
        const ensured = await rb.unity.ensureBridge(state.projectPath);
        if (ensured && ensured.ok) {
          bridgeExists = true;
          if (ensured.updated) showToast('✓ Bridge updated to v' + (ensured.toVersion || '') + ' — restart Unity if the old error is still showing');
        } else if (ensured && !ensured.skipped) bridgeError = ensured.error || 'Bridge install failed';
      } catch (e) { bridgeError = e.message || 'Bridge install failed'; }
    }
  }
  // Re-read status after any ensure, so the Update button and the
  // version shown reflect what is actually on disk now.
  try { const s2 = await rb.unity.bridgeStatus(state.projectPath); if (s2) status = s2; } catch {}
  const updateAvailable = !!(state.projectPath && status && status.updateAvailable);
  const installedVersion = status ? status.installedVersion : null;
  // Installed Unity packages, from Packages/manifest.json — read live
  // so the list (and the model, via the project scan) never goes stale.
  let pkgInfo = null;
  try { pkgInfo = await rb.unity.listPackages(state.projectPath); } catch { pkgInfo = null; }
  const rows = [];
  if (filter === 'all' || filter === 'unity') {
    rows.push(`
    <div class="conn-row">
      <span class="conn-ico">⬢</span>
      <span class="conn-row-info"><span class="conn-name">Unity Project — ${escHtml(proj ? proj.name : 'No project')}</span><br>
      <span class="conn-status ${bridgeExists ? 'connected' : ''}">${bridgeExists ? 'Connected — bridge installed' + (installedVersion ? ' (v' + escHtml(installedVersion) + ')' : '') + (updateAvailable ? ' — update available' : '') : (bridgeError ? 'Bridge install failed: ' + escHtml(bridgeError) : (bridgeEnabled ? 'Not connected — bridge not installed' : 'Bridge disabled'))}</span><br>
      <span style="font-size:11px;color:var(--text3);font-family:var(--mono);">${escHtml(state.projectPath || 'No folder set')}</span></span>
      <button class="btn btn-secondary" onclick="updateUnityBridge()" ${updateAvailable ? '' : 'disabled'} title="${!bridgeEnabled ? 'Bridge is disabled — turn it on to update it' : (updateAvailable ? 'Install the newer bundled bridge (v' + escHtml(status && status.bundledVersion ? status.bundledVersion : '') + ') into Assets/Editor/' : 'Bridge is up to date' + (installedVersion ? ' (v' + escHtml(installedVersion) + ')' : ''))}">Update plugin</button>
      <label class="switch" title="${bridgeExists ? 'Disable the bridge (removes it from the project)' : 'Enable the bridge (installs it into the project)'}"><input type="checkbox" ${bridgeExists ? 'checked' : ''} onchange="toggleUnityBridge(this.checked)"><span class="slider"></span></label>
      <button class="btn btn-secondary" onclick="toggleConnMenu()">⋯</button>
    </div>
    <div id="conn-menu-row" class="hidden" style="margin:-4px 0 10px;text-align:right;">
      <button class="btn btn-danger" onclick="disconnectUnityBridge()">Disconnect — remove the bridge from this project</button>
    </div>`);
    rows.push(unityPackagesSectionHtml(pkgInfo));
  }
  if (filter === 'all' || filter === 'folders') {
    state.localFolders.forEach((folder, i) => {
      const base = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
      rows.push(`
      <div class="conn-row">
        <span class="conn-ico">▣</span>
        <span class="conn-row-info"><span class="conn-name">${escHtml(base)}</span><br>
        <span class="conn-status">Local folder</span><br>
        <span style="font-size:11px;color:var(--text3);font-family:var(--mono);">${escHtml(folder)}</span></span>
        <button class="btn btn-secondary" onclick="removeLocalFolderByIndex(${i})">Remove</button>
      </div>`);
    });
    if (!state.localFolders.length) {
      rows.push('<div style="color:var(--text3);font-size:12px;padding:6px 0 12px;">No local folders yet — add one with “+ Add folder”.</div>');
    }
  }
    // ComfyUI (v0.6.0) — a first-class provider alongside LM Studio.
    // Status is the last verified result (Verify fetches it live);
    // nothing here is guessed from a missing server.
    const cStatus = state.comfyuiStatus;
    const cText = cStatus
      ? (cStatus.ok ? 'Connected — ComfyUI at ' + escHtml(state.comfyuiUrl) + (cStatus.version ? ' (v' + escHtml(String(cStatus.version)) + ')' : '') : 'Not running — ' + escHtml(cStatus.error || 'could not reach ComfyUI'))
      : 'Not checked yet — click Verify';
    rows.push(`
    <h3 class="settings-subhead">ComfyUI</h3>
    <div class="conn-row">
      <span class="conn-ico">◈</span>
      <span class="conn-row-info"><span class="conn-name">ComfyUI</span><br>
      <span class="conn-status ${cStatus && cStatus.ok ? 'connected' : ''}">${cText}</span><br>
      <span style="font-size:11px;color:var(--text3);font-family:var(--mono);">${escHtml(state.comfyuiUrl)}</span></span>
      <button class="btn btn-secondary" onclick="verifyComfyuiFromSettings(this)">Verify</button>
      <button class="btn btn-teal" onclick="showComfyUI()">Open ComfyUI panel →</button>
    </div>`);
  list.innerHTML = rows.join('');
}

// Packages section, shared by Settings > Connections and the
// Connections view: installed packages read live from
// Packages/manifest.json, each with a Remove button that needs a
// confirm click. Returns '' when no project folder is set.
function unityPackagesSectionHtml(pkgInfo) {
  if (!state.projectPath) return '';
  let inner = '';
  if (pkgInfo && pkgInfo.ok) {
    const deps = pkgInfo.dependencies || {};
    const names = Object.keys(deps);
    inner = names.length
      ? names.map(n => {
          const locked = pkgInfo.locked && pkgInfo.locked[n];
          const ver = deps[n] || '';
          return `<div class="conn-row">
            <span class="conn-ico">▣</span>
            <span class="conn-row-info"><span class="conn-name">${escHtml(n)}</span><br>
            <span class="conn-status" style="font-family:var(--mono);">${escHtml(ver)}${locked && locked !== ver ? ' · locked ' + escHtml(locked) : ''}</span></span>
            <button class="btn btn-secondary" onclick="removeUnityPackage('${n.replace(/'/g, "\\'")}', this)">Remove</button>
          </div>`;
        }).join('')
      : '<div style="color:var(--text3);font-size:12px;padding:6px 0 12px;">No packages in Packages/manifest.json yet — ask the assistant to install one, or add it by hand.</div>';
  } else {
    inner = '<div style="color:var(--text3);font-size:12px;padding:6px 0 12px;">No Packages/manifest.json in this project yet — package installs need a Unity project folder.</div>';
  }
  return `<h3 class="settings-subhead">Packages</h3>
    <p class="settings-note">Installed Unity packages, read live from Packages/manifest.json. Removing a package backs the manifest up first and asks Unity to refresh. The assistant can install packages too — every install asks first.</p>
    ${inner}`;
}

// Remove a package from the manifest. First click arms the button;
// the second click really removes it (via unity:removePackage,
// which backs the manifest up first).
async function removeUnityPackage(name, btn) {
  if (!name) return;
  if (!btn || btn.dataset.armed !== '1') {
    if (btn) { btn.dataset.armed = '1'; btn.textContent = 'Click again to confirm'; }
    return;
  }
  const res = await rb.unity.removePackage({ name, projectPath: state.projectPath });
  if (res.ok) showToast('✓ Removed ' + name + ' — manifest backed up, Unity will refresh');
  else showToast('⚠ ' + (res.error || 'Remove failed'));
  if (state.mode === 'settings') renderSettingsView();
  if (state.mode === 'connections') renderConnectionsView();
}

function toggleConnMenu() {
  const row = document.getElementById('conn-menu-row');
  if (row) row.classList.toggle('hidden');
}

async function toggleUnityBridge(enabled) {
  const res = enabled
    ? await rb.unity.installBridge(state.projectPath)
    : await rb.unity.removeBridge(state.projectPath);
  if (res.ok) {
    showToast(enabled ? '✓ Bridge installed in Assets/Editor/CodeFoxBridge.cs' : '✓ Bridge removed from this project');
  } else {
    showToast('⚠ ' + (res.error || 'Bridge change failed'));
  }
  await refreshConnectionCards();
  if (state.mode === 'settings') renderSettingsView();
}

async function disconnectUnityBridge() {
  await toggleUnityBridge(false);
}

async function updateUnityBridge() {
  await toggleUnityBridge(true);
}

async function addUnityProject() {
  const folder = await rb.fs.pickFolder();
  if (!folder) return;
  if (state.activeProjectId != null) {
    await rb.project.update(state.activeProjectId, { path: folder });
    state.activeProject = { ...state.activeProject, path: folder };
  }
  state.projectPath = folder;
  setProjectPathLabels();
  document.getElementById('file-tree').innerHTML = '';
  allFiles = [];
  await loadFileTree(folder, document.getElementById('file-tree'), 0);
  buildFileIndex(folder);
  showToast('✓ Unity project folder set');
  await refreshConnectionCards();
  if (state.mode === 'settings') renderSettingsView();
}

async function addLocalFolderFromSettings() {
  const folder = await rb.fs.pickFolder();
  if (!folder) return;
  if (!state.localFolders.includes(folder)) {
    state.localFolders.push(folder);
    await rb.db.setSetting('local_folders', JSON.stringify(state.localFolders));
  }
  showToast('✓ Folder added — ' + state.localFolders.length + ' connected.');
  await refreshConnectionCards();
  renderSettingsView();
}

async function removeLocalFolderByIndex(i) {
  state.localFolders.splice(i, 1);
  await rb.db.setSetting('local_folders', JSON.stringify(state.localFolders));
  await refreshConnectionCards();
  renderSettingsView();
}

// ── MCPs section ──────────────────────────────────────────────────
// Configuration + storage only. The assistant does not call MCP tools
// yet — that wiring is the next step, and these settings are stored so
// it can be added without reconfiguring. Nothing here is a cloud
// marketplace: the six presets below are curated recommendations,
// and adding one only adds the *configuration* in one click — the
// app, token, addon, or plugin each one needs is separate, and each
// card says what it needs.
function renderMcpsPane(body) {
  body.innerHTML = `
    <p class="settings-note">MCP servers are configured here for now. The assistant does not call MCP tools yet — that wiring is the next step, and these settings are stored so it can be added without reconfiguring.</p>
    <h3 style="font-size:13px;margin:14px 0 4px;">Recommended for game development</h3>
    <p class="settings-note" style="margin:0 0 8px;">Ten presets, each genuinely useful for making a Unity game. Adding one only adds the configuration — the app, token, addon, or plugin it needs is separate, and each card says what it needs. <b>Add</b> opens a guided setup prompt that walks through the steps and checks the token or the app for real; <b>Quick add</b> (on cards that need a token or folder) skips the prompt and uses the values typed on the card.</p>
    <div id="mcp-presets"></div>
    <h3 style="font-size:13px;margin:18px 0 4px;">Your configured servers</h3>
    <div id="mcp-list"></div>
    <button class="btn btn-teal" onclick="showMcpForm()">+ Add MCP server</button>
    <div id="mcp-form"></div>`;
  renderMcpPresets();
  renderMcpList();
  renderMcpForm();
}

// Per-preset inline input state, keyed by preset id:
// { expanded, token, folder }. Window-scoped so it survives a
// re-render of the settings pane (e.g. after saving another server).
function mcpPresetInput(id) {
  window._mcpPresetInputs = window._mcpPresetInputs || {};
  if (!window._mcpPresetInputs[id]) window._mcpPresetInputs[id] = { expanded: false, token: '', folder: '', fields: {} };
  return window._mcpPresetInputs[id];
}

function isMcpPresetAdded(preset) {
  return state.mcpServers.some(s => s.presetId === preset.id || s.name === preset.name);
}

function renderMcpPresets() {
  const el = document.getElementById('mcp-presets');
  if (!el) return;
  const presets = (window.rb && rb.mcpPresets) ? rb.mcpPresets.list : [];
  el.innerHTML = presets.map(p => {
    const added = isMcpPresetAdded(p);
    const inp = mcpPresetInput(p.id);
    const needsToken = !!(p.requiresToken && p.requiresToken.envKey);
    const needsFolder = !!p.requiresFolder;
    const needsInput = needsToken || needsFolder;
    let action = '';
    if (added) {
      action = '<button class="btn btn-secondary" disabled>Added ✓</button>';
    } else if (needsInput && !inp.expanded) {
      action = `<button class="btn btn-teal" onclick="openMcpSetupModal('${p.id}')">Add</button><button class="btn btn-secondary" onclick="expandMcpPreset('${p.id}')" title="Skip the guided prompt — type the token or folder on the card instead">Quick add</button>`;
    } else if (needsInput && inp.expanded) {
      const ready = (!needsToken || (inp.token || '').trim()) && (!needsFolder || (inp.folder || '').trim());
      const hint = needsToken ? 'Enter your ' + escHtml(p.requiresToken.label.toLowerCase()) + ' first' : 'Pick a folder first';
      action = `<button class="btn btn-teal" id="mcp-preset-install-${p.id}" onclick="installMcpPreset('${p.id}')" ${ready ? '' : 'disabled title="' + escHtml(hint) + '"'}>Install</button>`;
    } else {
      action = `<button class="btn btn-teal" onclick="openMcpSetupModal('${p.id}')">Add</button>`;
    }
    const inputBlock = (needsInput && inp.expanded && !added) ? `
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;">
        ${needsToken ? `<label class="field-label">${escHtml(p.requiresToken.label)}
          <input type="password" id="mcp-preset-token-${p.id}" value="${escHtml(inp.token || '')}" placeholder="${escHtml(p.requiresToken.placeholder || '')}" oninput="onMcpPresetTokenInput('${p.id}', this)" />
        </label>` : ''}
        ${needsFolder ? `<label class="field-label">Folder
          <span style="display:flex;gap:8px;"><input id="mcp-preset-folder-${p.id}" value="${escHtml(inp.folder || '')}" placeholder="${escHtml(state.projectPath || 'C:\\\\path\\\\to\\\\folder')}" oninput="onMcpPresetFolderInput('${p.id}', this)" style="flex:1;" /><button class="btn btn-secondary" onclick="browseMcpPresetFolder('${p.id}')">Browse</button></span>
        </label>` : ''}
      </div>` : '';
    return `
    <div class="conn-row" style="align-items:flex-start;">
      <span class="conn-ico">▣</span>
      <span class="conn-row-info" style="flex:1;">
        <span class="conn-name">${escHtml(p.name)}</span><br>
        <span style="font-size:12px;color:var(--text2);">${escHtml(p.tagline)}</span><br>
        <span style="font-size:12px;color:var(--text3);">${escHtml(p.description)}</span><br>
        <span style="font-size:11px;color:var(--text3);">What you need: ${escHtml((p.needs || []).join(' · '))}</span>
        ${p.note ? `<br><span style="font-size:11px;color:var(--text3);">${escHtml(p.note)}</span>` : ''}
        <details style="font-size:11px;color:var(--text3);margin-top:4px;"><summary style="cursor:pointer;">Setup steps</summary><ol style="margin:6px 0 0 16px;padding:0;">${(p.setupSteps || []).map(s => `<li>${escHtml(s)}</li>`).join('')}</ol></details>
        <span style="font-family:var(--mono);font-size:11px;color:var(--text3);">${escHtml(p.command + ' ' + (p.args || []).join(' '))}</span>
        ${inputBlock}
      </span>
      <span style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">${action}</span>
    </div>`;
  }).join('');
}

function expandMcpPreset(id) {
  const inp = mcpPresetInput(id);
  inp.expanded = true;
  if (!inp.folder) inp.folder = state.projectPath || '';
  renderMcpPresets();
  const tokenEl = document.getElementById('mcp-preset-token-' + id);
  if (tokenEl) tokenEl.focus();
}

function updateMcpPresetInstallBtn(id) {
  const p = rb.mcpPresets.get(id);
  const inp = mcpPresetInput(id);
  const btn = document.getElementById('mcp-preset-install-' + id);
  if (!p || !btn) return;
  const ready = (!p.requiresToken || (inp.token || '').trim()) && (!p.requiresFolder || (inp.folder || '').trim());
  btn.disabled = !ready;
}

function onMcpPresetTokenInput(id, el) {
  mcpPresetInput(id).token = el.value;
  updateMcpPresetInstallBtn(id);
}

function onMcpPresetFolderInput(id, el) {
  mcpPresetInput(id).folder = el.value;
  updateMcpPresetInstallBtn(id);
}

async function browseMcpPresetFolder(id) {
  const folder = await rb.fs.pickFolder();
  if (!folder) return;
  mcpPresetInput(id).folder = folder;
  const el = document.getElementById('mcp-preset-folder-' + id);
  if (el) el.value = folder;
  updateMcpPresetInstallBtn(id);
}

async function installMcpPreset(id) {
  const preset = rb.mcpPresets.get(id);
  if (!preset) return;
  if (isMcpPresetAdded(preset)) { showToast(preset.name + ' is already added'); return; }
  const inp = mcpPresetInput(id);
  // Read the live DOM values too — they are the source of truth for
  // what the user typed, in case an oninput event was missed.
  const tokenEl = document.getElementById('mcp-preset-token-' + id);
  const folderEl = document.getElementById('mcp-preset-folder-' + id);
  const token = tokenEl ? tokenEl.value : (inp.token || '');
  const folder = folderEl ? folderEl.value : (inp.folder || state.projectPath || '');
  const res = rb.mcpPresets.buildServerEntry(preset, { token, folder, fields: inp.fields || {} });
  if (!res.ok) { showToast(res.error || 'Could not add this preset'); return; }
  state.mcpServers.push(res.entry);
  await persistMcpServers();
  renderSettingsView();
  showToast('✓ ' + preset.name + ' MCP server added');
}

function renderMcpList() {
  const el = document.getElementById('mcp-list');
  if (!el) return;
  if (!state.mcpServers.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:6px 0 12px;">No MCP servers configured yet.</div>';
    return;
  }
  el.innerHTML = state.mcpServers.map(s2 => `
    <div class="conn-row">
      <span class="conn-ico">▣</span>
      <span class="conn-row-info"><span class="conn-name">${escHtml(s2.name)}</span><br>
      <span class="conn-status" style="font-family:var(--mono);">${escHtml(s2.command + (s2.args ? ' ' + s2.args : ''))}</span><br>
      <span style="font-size:11px;color:var(--text3);">${Object.keys(s2.env || {}).length} env var(s)</span></span>
      <label class="switch" title="Enable this MCP server"><input type="checkbox" ${s2.enabled ? 'checked' : ''} onchange="toggleMcpServer('${s2.id}', this.checked)"><span class="slider"></span></label>
      <button class="btn btn-secondary" onclick="editMcpServer('${s2.id}')">Edit</button>
      <button class="btn btn-secondary" onclick="removeMcpServer('${s2.id}')">Remove</button>
    </div>`).join('');
}

function mcpId() {
  return 'mcp_' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
}

async function persistMcpServers() {
  await rb.db.setSetting('mcp_servers', JSON.stringify(state.mcpServers));
}

function showMcpForm() {
  window._mcpEditingId = null;
  window._mcpFormOpen = true;
  renderMcpForm();
}

function editMcpServer(id) {
  window._mcpEditingId = id;
  window._mcpFormOpen = true;
  renderMcpForm();
}

function cancelMcpForm() {
  window._mcpFormOpen = false;
  window._mcpEditingId = null;
  renderMcpForm();
}

function renderMcpForm() {
  const el = document.getElementById('mcp-form');
  if (!el) return;
  if (!window._mcpFormOpen) { el.innerHTML = ''; return; }
  const s2 = window._mcpEditingId ? state.mcpServers.find(x => x.id === window._mcpEditingId) : null;
  const envText = s2 && s2.env ? Object.entries(s2.env).map(([k, v]) => k + '=' + v).join('\n') : '';
  el.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;margin-top:12px;display:flex;flex-direction:column;gap:10px;">
      <h3 style="font-size:13px;">${s2 ? 'Edit MCP server' : 'Add MCP server'}</h3>
      <label class="field-label">Name
        <input id="mcp-name" value="${escHtml(s2 ? s2.name : '')}" placeholder="e.g. filesystem" />
      </label>
      <label class="field-label">Command
        <input id="mcp-command" value="${escHtml(s2 ? s2.command : '')}" placeholder="e.g. npx" />
      </label>
      <label class="field-label">Arguments
        <input id="mcp-args" value="${escHtml(s2 ? (s2.args || '') : '')}" placeholder="e.g. -y @modelcontextprotocol/server-filesystem C:\\projects" />
      </label>
      <label class="field-label">Environment variables — one KEY=value per line
        <textarea id="mcp-env" placeholder="API_KEY=...">${escHtml(envText)}</textarea>
      </label>
      <label style="display:flex;align-items:center;gap:8px;color:var(--text2);font-size:12px;"><input type="checkbox" id="mcp-enabled" ${!s2 || s2.enabled ? 'checked' : ''} style="width:auto;" /> Enabled</label>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="cancelMcpForm()">Cancel</button>
        <button class="btn btn-primary" onclick="saveMcpServer()">Save server</button>
      </div>
    </div>`;
}

async function saveMcpServer() {
  const name = document.getElementById('mcp-name')?.value?.trim();
  const command = document.getElementById('mcp-command')?.value?.trim();
  if (!name || !command) { showToast('Give the MCP server a name and a command'); return; }
  const args = document.getElementById('mcp-args')?.value?.trim() || '';
  const envText = document.getElementById('mcp-env')?.value || '';
  const env = {};
  envText.split('\n').forEach(line => {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  const enabled = document.getElementById('mcp-enabled')?.checked !== false;
  const editingId = window._mcpEditingId;
  if (editingId) {
    const s2 = state.mcpServers.find(x => x.id === editingId);
    if (s2) Object.assign(s2, { name, command, args, env, enabled });
  } else {
    state.mcpServers.push({ id: mcpId(), name, command, args, env, enabled });
  }
  window._mcpEditingId = null;
  window._mcpFormOpen = false;
  await persistMcpServers();
  renderSettingsView();
  showToast('✓ MCP server saved');
}

async function toggleMcpServer(id, enabled) {
  const s2 = state.mcpServers.find(x => x.id === id);
  if (!s2) return;
  s2.enabled = !!enabled;
  await persistMcpServers();
}

async function removeMcpServer(id) {
  state.mcpServers = state.mcpServers.filter(x => x.id !== id);
  await persistMcpServers();
  renderSettingsView();
}

// ── Guided MCP setup prompt (v0.6.0) ────────────────────────────
// The Add button on any preset that needs externals opens this
// modal instead of silently adding a server. It shows what the
// preset does, numbered steps the user can follow, the exact
// input(s) needed, a Check button that runs a real check, and an
// Add server button that stays disabled until the check passes or
// the user ticks "I have done the steps — add it anyway". A failed
// check never blocks adding; a pass is never faked.
function openMcpSetupModal(id) {
  const preset = rb.mcpPresets.get(id);
  if (!preset) return;
  const inp = mcpPresetInput(id);
  if (!inp.folder) inp.folder = state.projectPath || '';
  window._mcpSetup = { id, checkPassed: false, checkRan: false };
  const overlay = document.getElementById('mcp-setup-modal-overlay');
  const modal = document.getElementById('mcp-setup-modal');
  if (!overlay || !modal) return;
  const fieldsHtml = (preset.requiresFields || []).map(f => `
    <label class="field-label">${escHtml(f.label)}
      <input id="mcp-setup-field-${f.key}" type="${f.password ? 'password' : 'text'}" value="${escHtml((inp.fields && inp.fields[f.key]) || '')}" placeholder="${escHtml(f.placeholder || '')}" />
    </label>`).join('');
  const tokenHtml = preset.requiresToken ? `
    <label class="field-label">${escHtml(preset.requiresToken.label)}
      <input id="mcp-setup-token" type="password" value="${escHtml(inp.token || '')}" placeholder="${escHtml(preset.requiresToken.placeholder || '')}" />
    </label>` : '';
  const folderHtml = preset.requiresFolder ? `
    <label class="field-label">Folder
      <span style="display:flex;gap:8px;"><input id="mcp-setup-folder" value="${escHtml(inp.folder || '')}" style="flex:1;" /><button class="btn btn-secondary" onclick="browseMcpSetupFolder()">Browse</button></span>
    </label>` : '';
  const hasCheck = preset.checkKind && preset.checkKind !== 'none';
  modal.innerHTML = `
    <h2>Set up ${escHtml(preset.name)}</h2>
    <p style="color:var(--text2);font-size:12px;line-height:1.6;">${escHtml(preset.description)}</p>
    <div>
      <div style="font-size:13px;font-weight:600;margin-bottom:6px;">Steps</div>
      <ol style="margin:0 0 0 18px;padding:0;color:var(--text2);font-size:12px;line-height:1.7;">${(preset.setupSteps || []).map(s => `<li>${escHtml(s)}</li>`).join('')}</ol>
      ${preset.helpUrl ? `<div style="margin-top:8px;"><button class="btn btn-secondary" onclick="rb.shell.openExternal('${escHtml(preset.helpUrl)}')">Open setup page ↗</button></div>` : ''}
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">${tokenHtml}${fieldsHtml}${folderHtml}</div>
    <div>
      <div style="font-size:13px;font-weight:600;margin-bottom:6px;">Check</div>
      ${hasCheck
        ? `<p style="color:var(--text3);font-size:12px;margin-bottom:8px;">${escHtml(preset.checkLabel || '')}</p>
           <button class="btn btn-secondary" id="mcp-setup-check-btn" onclick="runMcpSetupCheck()">Check</button>`
        : `<p style="color:var(--text3);font-size:12px;">${escHtml(preset.checkLabel || 'No automatic check for this one — follow the steps, then tick the box.')}</p>`}
      <div id="mcp-setup-check-result" style="font-size:12px;margin-top:8px;color:var(--text2);white-space:pre-wrap;"></div>
    </div>
    <label style="display:flex;gap:8px;align-items:flex-start;color:var(--text2);font-size:12px;cursor:pointer;">
      <input type="checkbox" id="mcp-setup-anyway" onchange="updateMcpSetupAddBtn()" style="width:auto;margin-top:2px;" />
      <span>I have done the steps above — add it anyway</span>
    </label>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn btn-secondary" onclick="closeMcpSetupModal()">Cancel</button>
      <button class="btn btn-primary" id="mcp-setup-add-btn" onclick="confirmMcpSetupAdd()" disabled>Add server</button>
    </div>`;
  overlay.classList.add('open');
  updateMcpSetupAddBtn();
}

function closeMcpSetupModal() {
  const overlay = document.getElementById('mcp-setup-modal-overlay');
  if (overlay) overlay.classList.remove('open');
  window._mcpSetup = null;
}

// Live values from the modal inputs (DOM first, stored input state
// as the fallback), so a Check or an Add always uses what the user
// actually typed.
function mcpSetupValues() {
  const setup = window._mcpSetup;
  const inp = setup ? mcpPresetInput(setup.id) : { token: '', folder: '', fields: {} };
  const tokenEl = document.getElementById('mcp-setup-token');
  const folderEl = document.getElementById('mcp-setup-folder');
  const fields = { ...(inp.fields || {}) };
  document.querySelectorAll('[id^="mcp-setup-field-"]').forEach(el => {
    fields[el.id.replace('mcp-setup-field-', '')] = el.value;
  });
  return {
    token: tokenEl ? tokenEl.value : (inp.token || ''),
    folder: folderEl ? folderEl.value : (inp.folder || ''),
    fields,
  };
}

function updateMcpSetupAddBtn() {
  const setup = window._mcpSetup;
  const btn = document.getElementById('mcp-setup-add-btn');
  if (!setup || !btn) return;
  const anyway = document.getElementById('mcp-setup-anyway');
  btn.disabled = !(setup.checkPassed || (anyway && anyway.checked));
}

async function browseMcpSetupFolder() {
  const folder = await rb.fs.pickFolder();
  if (!folder) return;
  const el = document.getElementById('mcp-setup-folder');
  if (el) el.value = folder;
}

async function runMcpSetupCheck() {
  const setup = window._mcpSetup;
  if (!setup) return;
  const preset = rb.mcpPresets.get(setup.id);
  if (!preset) return;
  const btn = document.getElementById('mcp-setup-check-btn');
  const resultEl = document.getElementById('mcp-setup-check-result');
  const vals = mcpSetupValues();
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  if (resultEl) { resultEl.textContent = 'Checking…'; resultEl.style.color = 'var(--text2)'; }
  let res = { ok: false, message: 'No check for this preset.' };
  try {
    if (preset.checkKind === 'blender' || preset.checkKind === 'uvx') {
      res = await rb.mcp.checkApp({ presetId: preset.id });
      if (resultEl) {
        const lines = (res.checks || []).map(c => (c.found ? '✓ ' : '✗ ') + c.label + ' — ' + c.detail).join('\n');
        resultEl.textContent = (lines ? lines + '\n' : '') + (res.message || '');
        resultEl.style.color = res.ok ? 'var(--green)' : 'var(--amber)';
      }
    } else {
      res = await rb.mcp.checkToken({
        presetId: preset.id,
        token: vals.token,
        site: vals.fields.site,
        email: vals.fields.email,
        apiKey: vals.fields.apiKey,
      });
      if (resultEl) {
        resultEl.textContent = (res.ok ? '✓ ' : '✗ ') + (res.message || '');
        resultEl.style.color = res.ok ? 'var(--green)' : 'var(--amber)';
      }
    }
  } catch (e) {
    res = { ok: false, message: 'Check failed: ' + (e.message || e) };
    if (resultEl) { resultEl.textContent = '✗ ' + res.message; resultEl.style.color = 'var(--amber)'; }
  }
  setup.checkPassed = !!(res && res.ok);
  setup.checkRan = true;
  if (btn) { btn.disabled = false; btn.textContent = 'Check'; }
  updateMcpSetupAddBtn();
}

async function confirmMcpSetupAdd() {
  const setup = window._mcpSetup;
  if (!setup) return;
  const vals = mcpSetupValues();
  const inp = mcpPresetInput(setup.id);
  inp.token = vals.token;
  inp.folder = vals.folder;
  inp.fields = vals.fields;
  closeMcpSetupModal();
  await installMcpPreset(setup.id);
}

// ── ComfyUI (v0.6.0) ─────────────────────────────────────────────
// Native provider alongside LM Studio: CodeFox talks to a locally
// running ComfyUI instance over its own HTTP API (/system_stats,
// /object_info, /prompt, /queue, /history, /view, /upload/image).
// Monitoring is by POLLING /queue + /history every 2 seconds —
// there is no WebSocket client. Every call is guarded with a
// timeout; when ComfyUI is not running every panel says so honestly
// and nothing is faked. No workflow is hardcoded: workflows are the
// user's own JSON files, imported from a folder they pick, and the
// catalogue stores the parsed definition (never a sample workflow).
function showComfyUI() {
  setMode('comfyui', 'ComfyUI');
}

function comfyuiSlug(name) {
  return String(name || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}

function findComfyuiWorkflow(nameOrId) {
  const key = String(nameOrId || '').trim().toLowerCase();
  if (!key) return null;
  return state.comfyuiWorkflows.find(w => w.id === key || String(w.name || '').toLowerCase() === key) || null;
}

async function persistComfyuiWorkflows() {
  await rb.db.setSetting('comfyui_workflows', JSON.stringify(state.comfyuiWorkflows));
  await rb.db.setSetting('comfyui_workflows_dir', state.comfyuiWorkflowsDir || '');
  await rb.db.setSetting('comfyui_url', state.comfyuiUrl || 'http://127.0.0.1:8188');
}

async function verifyComfyui() {
  const url = state.comfyuiUrl || 'http://127.0.0.1:8188';
  let st;
  try { st = await rb.comfyui.status({ url }); }
  catch (e) { st = { ok: false, error: String((e && e.message) || e), url }; }
  state.comfyuiStatus = st;
  if (st.ok) {
    try {
      const info = await rb.comfyui.objectInfo({ url });
      if (info.ok) {
        state.comfyuiObjectInfo = info.data;
        state.comfyuiCapabilities = info.capabilities || [];
        state.comfyuiNodeClasses = info.nodeClasses || Object.keys(info.data || {}).sort();
      }
    } catch {}
  }
  return st;
}

async function verifyComfyuiFromSettings(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  const st = await verifyComfyui();
  showToast(st.ok ? '✓ ComfyUI connected' + (st.version ? ' (v' + st.version + ')' : '') : '⚠ ' + (st.error || 'ComfyUI is not running'));
  if (state.mode === 'settings') renderSettingsView();
  if (state.mode === 'comfyui') renderComfyUIView();
}

async function refreshComfyuiWorkflows() {
  let r;
  try { r = await rb.comfyui.listWorkflows({ dir: state.comfyuiWorkflowsDir, url: state.comfyuiUrl }); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  if (!r.ok) return r;
  state.comfyuiWorkflows = r.workflows || [];
  state.comfyuiWorkflowsDir = r.dir || state.comfyuiWorkflowsDir;
  if (!state.comfyuiSelectedId && state.comfyuiWorkflows.length) {
    state.comfyuiSelectedId = state.comfyuiWorkflows[0].id;
  }
  await persistComfyuiWorkflows();
  return { ok: true, errors: r.errors || [] };
}

async function refreshComfyuiHistory() {
  let r;
  try { r = await rb.comfyui.history({ url: state.comfyuiUrl }); }
  catch (e) { state.comfyuiHistory = []; return; }
  if (!r.ok || !r.data || typeof r.data !== 'object') { state.comfyuiHistory = []; return; }
  const entries = Object.entries(r.data).slice(-20).reverse().map(([promptId, entry]) => ({
    promptId,
    status: (entry && entry.status && entry.status.status_str) || (entry && entry.status && entry.status.completed ? 'completed' : 'unknown'),
    completed: !!(entry && entry.status && entry.status.completed),
    outputs: comfyuiOutputsFromHistoryEntry(entry),
  }));
  state.comfyuiHistory = entries;
}

// History entries carry outputs as { nodeId: { images: [{ filename,
// subfolder, type }] } } (and video nodes the same shape).
function comfyuiOutputsFromHistoryEntry(entry) {
  const out = [];
  const outputs = (entry && entry.outputs) || {};
  for (const nodeOut of Object.values(outputs)) {
    for (const img of (nodeOut.images || [])) {
      out.push({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
    }
    for (const vid of (nodeOut.video || nodeOut.gifs || [])) {
      out.push({ filename: vid.filename, subfolder: vid.subfolder || '', type: vid.type || 'output' });
    }
  }
  return out;
}

function comfyuiFileUrl(p) {
  return encodeURI('file:///' + String(p || '').replace(/\\/g, '/').replace(/^\//, ''));
}

async function browseComfyuiWorkflowsDir() {
  const folder = await rb.fs.pickFolder();
  if (!folder) return;
  state.comfyuiWorkflowsDir = folder;
  await persistComfyuiWorkflows();
  await refreshComfyuiWorkflows();
  renderComfyUIView();
  showToast('✓ Workflows folder set — ' + state.comfyuiWorkflows.length + ' workflow(s) found');
}

// Scan the standard ComfyUI locations on this machine — no hunting
// by hand. The main process checks the usual install folders, the
// server URL, and the model folders, and reports exactly what it
// found at each place. When a workflows folder is found it is
// adopted automatically and its workflows imported; the manual
// Browse picker stays as the fallback.
async function scanComfyui() {
  state.comfyuiScan = { scanning: true };
  renderComfyUIView();
  let r;
  try { r = await rb.comfyui.scan({ url: state.comfyuiUrl }); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (r && r.ok) {
    if (r.server && r.server.ok) {
      state.comfyuiStatus = r.server;
      try {
        const info = await rb.comfyui.objectInfo({ url: state.comfyuiUrl });
        if (info.ok) {
          state.comfyuiObjectInfo = info.data;
          state.comfyuiCapabilities = info.capabilities || [];
          state.comfyuiNodeClasses = info.nodeClasses || Object.keys(info.data || {}).sort();
        }
      } catch {}
    }
    if (r.dir) {
      state.comfyuiWorkflowsDir = r.dir;
      state.comfyuiWorkflows = r.workflows || [];
      if (!state.comfyuiSelectedId && state.comfyuiWorkflows.length) {
        state.comfyuiSelectedId = state.comfyuiWorkflows[0].id;
      }
      await persistComfyuiWorkflows();
    }
  }
  state.comfyuiScan = r;
  renderComfyUIView();
  if (r && r.ok) {
    showToast(r.dir
      ? '✓ Scan found ' + (r.workflows || []).length + ' workflow(s) in ' + r.dir
      : 'Scan finished — no workflows folder found in the usual locations');
  } else {
    showToast('⚠ Scan failed: ' + ((r && r.error) || 'unknown error'));
  }
}

// Randomise one sampler's seed in the simple form (per-node key,
// so a workflow with two samplers randomises only that one).
function randomiseComfyuiSeedFor(key, inputId) {
  const seed = Math.floor(Math.random() * 1000000000000000);
  state.comfyuiGenInputs[key] = seed;
  const el = document.getElementById(inputId);
  if (el) el.value = String(seed);
}

// Set one latent node's width/height from a size preset.
function setComfyuiSize(nodeId, w, h) {
  state.comfyuiGenInputs[nodeId + '.width'] = w;
  state.comfyuiGenInputs[nodeId + '.height'] = h;
  const wEl = document.getElementById('comfyui-simple-' + nodeId + '.width');
  const hEl = document.getElementById('comfyui-simple-' + nodeId + '.height');
  if (wEl) wEl.value = String(w);
  if (hEl) hEl.value = String(h);
}

// The SIMPLE generation form for one workflow (v0.7.0): prompt
// boxes, sampler settings, and size presets — built only from
// what the workflow actually contains. No iframe, no node editor:
// CodeFox's own UI over the workflow's inputs. Everything here
// writes the same state.comfyuiGenInputs the advanced panel and
// the Run button use, so the two forms never disagree.
//
// The shape comes from comfyui.js describeSimpleForm(), computed
// at import time and stored on the workflow (see
// importWorkflowsFromDir). The renderer cannot require comfyui.js,
// so for catalogue entries imported before 0.7.0 — which have no
// simpleForm yet — the same rules are mirrored here over
// wf.inputs (simpleFormFromInputs). The mirror is only a fallback
// for those legacy entries; the next rescan replaces them.
function simpleFormFromInputs(inputs) {
  const list = (inputs || []).filter(i => i && typeof i === 'object');
  const textInputs = list.filter(i => i.classType === 'CLIPTextEncode' && i.inputName === 'text');
  const prompts = textInputs.map(i => ({
    key: i.role === 'positive' ? 'positive' : i.role === 'negative' ? 'negative' : i.nodeId + '.text',
    nodeId: i.nodeId,
    role: i.role || null,
    label: i.role === 'positive' ? 'Prompt' : i.role === 'negative' ? 'Negative prompt' : null,
    value: i.value,
  }));
  const samplerFields = ['seed', 'steps', 'cfg', 'denoise'];
  const samplerByNode = {};
  for (const i of list) {
    if ((i.classType === 'KSampler' || i.classType === 'KSamplerAdvanced') && samplerFields.includes(i.inputName)) {
      (samplerByNode[i.nodeId] = samplerByNode[i.nodeId] || { nodeId: i.nodeId, classType: i.classType, fields: [] })
        .fields.push({ key: i.nodeId + '.' + i.inputName, inputName: i.inputName, value: i.value });
    }
  }
  const sizeByNode = {};
  for (const i of list) {
    if (i.classType === 'EmptyLatentImage' && (i.inputName === 'width' || i.inputName === 'height')) {
      const s = (sizeByNode[i.nodeId] = sizeByNode[i.nodeId] || { nodeId: i.nodeId, width: null, height: null });
      s[i.inputName] = typeof i.value === 'number' ? i.value : null;
    }
  }
  return { prompts, samplers: Object.values(samplerByNode), sizes: Object.values(sizeByNode), hasPrompt: prompts.length > 0 };
}

function simpleComfyuiFormHtml(wf) {
  const form = (wf.simpleForm && Array.isArray(wf.simpleForm.prompts)) ? wf.simpleForm : simpleFormFromInputs(wf.inputs);
  const val = (key, fallback) => state.comfyuiGenInputs[key] !== undefined ? state.comfyuiGenInputs[key] : fallback;
  let html = '';
  const pos = form.prompts.find(p => p.role === 'positive');
  const neg = form.prompts.find(p => p.role === 'negative');
  const unroled = form.prompts.filter(p => !p.role);
  if (pos) {
    html += `<label class="field-label">Prompt
      <textarea id="comfyui-simple-positive" oninput="onComfyuiInputChange('positive', this)" style="min-height:72px;">${escHtml(String(val('positive', pos.value == null ? '' : pos.value)))}</textarea>
    </label>`;
  }
  if (neg) {
    html += `<label class="field-label">Negative prompt
      <textarea id="comfyui-simple-negative" oninput="onComfyuiInputChange('negative', this)" style="min-height:56px;">${escHtml(String(val('negative', neg.value == null ? '' : neg.value)))}</textarea>
    </label>`;
  }
  if (!pos && !neg && unroled.length === 1) {
    const u = unroled[0];
    html += `<label class="field-label">Prompt
      <textarea id="comfyui-simple-${escHtml(u.key)}" oninput="onComfyuiInputChange('${escHtml(u.key)}', this)" style="min-height:72px;">${escHtml(String(val(u.key, u.value == null ? '' : u.value)))}</textarea>
    </label>`;
  }
  if (!pos && !neg && unroled.length >= 2) {
    html += `<p style="color:var(--amber);font-size:12px;">This workflow has two text inputs, but its wiring does not say which is the positive prompt and which is the negative — labelled Prompt 1 and Prompt 2. If the first generation comes out wrong, swap them.</p>`;
    unroled.slice(0, 2).forEach((u, i) => {
      html += `<label class="field-label">Prompt ${i + 1}
        <textarea id="comfyui-simple-${escHtml(u.key)}" oninput="onComfyuiInputChange('${escHtml(u.key)}', this)" style="min-height:56px;">${escHtml(String(val(u.key, u.value == null ? '' : u.value)))}</textarea>
      </label>`;
    });
  }
  if (!form.hasPrompt) {
    html += `<p style="color:var(--text2);font-size:12px;">This workflow has no text-prompt input CodeFox can fill in — use the advanced inputs below, or pick a workflow with a prompt.</p>`;
  }
  // Sampler settings — only KSampler nodes, only the inputs that
  // node actually exposes.
  for (const s of (form.samplers || [])) {
    html += `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">`;
    for (const f of s.fields) {
      const cur = val(f.key, f.value);
      if (f.inputName === 'seed') {
        html += `<label class="field-label" style="flex:1;min-width:180px;">Seed
          <span style="display:flex;gap:8px;"><input id="comfyui-simple-${escHtml(f.key)}" type="number" value="${escHtml(String(cur == null ? '' : cur))}" oninput="onComfyuiInputChange('${escHtml(f.key)}', this)" style="flex:1;" /><button class="btn btn-secondary" onclick="randomiseComfyuiSeedFor('${escHtml(f.key)}', 'comfyui-simple-${escHtml(f.key)}')">Random</button></span>
        </label>`;
      } else {
        html += `<label class="field-label" style="flex:0 0 110px;">${escHtml(f.inputName === 'cfg' ? 'CFG' : f.inputName[0].toUpperCase() + f.inputName.slice(1))}
          <input id="comfyui-simple-${escHtml(f.key)}" type="number" value="${escHtml(String(cur == null ? '' : cur))}" oninput="onComfyuiInputChange('${escHtml(f.key)}', this)" />
        </label>`;
      }
    }
    html += `</div>`;
  }
  // Size presets — only when the workflow has a latent-size node.
  for (const s of (form.sizes || [])) {
    html += `<div><span style="font-size:12px;color:var(--text2);">Size</span>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
        <button class="btn btn-secondary" onclick="setComfyuiSize('${escHtml(s.nodeId)}', 1024, 1024)">Square 1024×1024</button>
        <button class="btn btn-secondary" onclick="setComfyuiSize('${escHtml(s.nodeId)}', 832, 1216)">Portrait 832×1216</button>
        <button class="btn btn-secondary" onclick="setComfyuiSize('${escHtml(s.nodeId)}', 1216, 832)">Landscape 1216×832</button>
        <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text2);">W <input id="comfyui-simple-${escHtml(s.nodeId)}.width" type="number" value="${escHtml(String(val(s.nodeId + '.width', s.width == null ? '' : s.width)))}" oninput="onComfyuiInputChange('${escHtml(s.nodeId)}.width', this)" style="width:84px;" /></label>
        <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text2);">H <input id="comfyui-simple-${escHtml(s.nodeId)}.height" type="number" value="${escHtml(String(val(s.nodeId + '.height', s.height == null ? '' : s.height)))}" oninput="onComfyuiInputChange('${escHtml(s.nodeId)}.height', this)" style="width:84px;" /></label>
      </div></div>`;
  }
  return html;
}

async function onComfyuiUrlSave() {
  const el = document.getElementById('comfyui-url');
  if (el && el.value.trim()) state.comfyuiUrl = el.value.trim();
  await rb.db.setSetting('comfyui_url', state.comfyuiUrl);
  state.comfyuiStatus = null;
  state.comfyuiObjectInfo = null;
  state.comfyuiCapabilities = [];
  await verifyComfyui();
  await refreshComfyuiWorkflows();
  renderComfyUIView();
}

function onComfyuiInputChange(key, el) {
  state.comfyuiGenInputs[key] = el.type === 'number' ? Number(el.value) : el.value;
}

function randomiseComfyuiSeed() {
  const seed = Math.floor(Math.random() * 1000000000000000);
  state.comfyuiGenInputs.seed = seed;
  const el = document.getElementById('comfyui-input-seed');
  if (el) el.value = String(seed);
}

async function setComfyuiPurpose(id, el) {
  const wf = state.comfyuiWorkflows.find(w => w.id === id);
  if (!wf) return;
  wf.purpose = el.value;
  await persistComfyuiWorkflows();
}

async function toggleComfyuiApproved(id, checked) {
  const wf = state.comfyuiWorkflows.find(w => w.id === id);
  if (!wf) return;
  wf.approved = !!checked;
  await persistComfyuiWorkflows();
  renderComfyUIView();
  showToast(wf.approved
    ? '✓ "' + wf.name + '" approved for autonomous execution — the Agent loop may run it without asking'
    : '"' + wf.name + '" is no longer approved — the Agent loop will ask before running it');
}

function selectComfyuiWorkflow(id) {
  state.comfyuiSelectedId = id;
  state.comfyuiGenInputs = {};
  state.comfyuiOutputs = [];
  renderComfyUIView();
}

// One generation, end to end: submit the stored workflow file with
// the caller's inputs, poll /queue + /history every 2 seconds until
// it completes (10-minute cap), then download each output to the
// local temp cache for thumbnails. Importing into the project is a
// separate step (importComfyuiOutputs) — the Agent loop does it
// automatically, the panel asks with Import buttons.
async function runComfyuiGeneration(wf, inputs, onProgress) {
  const sub = await rb.comfyui.submit({ file: wf.file, inputs: inputs || {}, url: state.comfyuiUrl });
  if (!sub.ok) return { ok: false, error: sub.error || 'Submit failed' };
  if (sub.unapplied && sub.unapplied.length && onProgress) {
    onProgress('Submitted — ignored inputs: ' + sub.unapplied.join(', '));
  }
  const poll = await pollComfyuiPrompt(sub.prompt_id, onProgress);
  if (!poll.ok) return poll;
  const outputs = [];
  for (const o of poll.outputs) {
    const dl = await rb.comfyui.view({ filename: o.filename, subfolder: o.subfolder || '', type: o.type || 'output', promptId: sub.prompt_id, url: state.comfyuiUrl });
    outputs.push({ ...o, localPath: dl.ok ? dl.path : null, downloadError: dl.ok ? null : dl.error });
  }
  return { ok: true, promptId: sub.prompt_id, outputs };
}

// Poll /queue + /history for one prompt_id. Returns
// { ok, outputs } on completion, { ok:false, error } on timeout,
// failure, or user cancel. Polling, not a WebSocket, by design.
async function pollComfyuiPrompt(promptId, onProgress) {
  const start = Date.now();
  const timeoutMs = 10 * 60 * 1000;
  while (Date.now() - start < timeoutMs) {
    if (window._comfyuiPollStop === promptId) {
      window._comfyuiPollStop = null;
      return { ok: false, error: 'Cancelled by user.' };
    }
    let hist = null;
    try { hist = await rb.comfyui.history({ promptId, url: state.comfyuiUrl }); } catch {}
    if (hist && hist.ok && hist.data && hist.data[promptId]) {
      const entry = hist.data[promptId];
      if (entry.status && entry.status.completed) {
        return { ok: true, outputs: comfyuiOutputsFromHistoryEntry(entry) };
      }
      if (entry.status && entry.status.status_str === 'error') {
        return { ok: false, error: 'ComfyUI reported an error for this prompt — check the ComfyUI console.' };
      }
    }
    try {
      const q = await rb.comfyui.queue({ url: state.comfyuiUrl });
      if (q && q.ok && q.data) {
        const running = (q.data.queue_running || []).some(item => String(item[1]) === String(promptId));
        const pending = (q.data.queue_pending || []).findIndex(item => String(item[1]) === String(promptId));
        if (onProgress) onProgress(running ? 'Running…' : pending >= 0 ? 'Queued — position ' + (pending + 1) : 'Waiting for ComfyUI…');
      } else if (onProgress) onProgress('Waiting for ComfyUI…');
    } catch {
      if (onProgress) onProgress('Waiting for ComfyUI…');
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return { ok: false, error: 'Generation timed out after 10 minutes.' };
}

function stopComfyuiGeneration() {
  if (state.comfyuiGenerating && state.comfyuiGenerating.promptId) {
    window._comfyuiPollStop = state.comfyuiGenerating.promptId;
  }
  state.comfyuiGenerating = null;
  renderComfyUIView();
}

async function runComfyuiFromPanel() {
  const wf = findComfyuiWorkflow(state.comfyuiSelectedId);
  if (!wf) { showToast('Pick a workflow first'); return; }
  if (!wf.available) { showToast('⚠ Workflow unavailable: ' + (wf.availableReason || (wf.missing || []).join('; '))); return; }
  state.comfyuiGenerating = { workflowId: wf.id, promptId: null, status: 'Submitting…' };
  state.comfyuiOutputs = [];
  renderComfyUIView();
  const res = await runComfyuiGeneration(wf, { ...state.comfyuiGenInputs }, (msg) => {
    if (state.comfyuiGenerating) state.comfyuiGenerating.status = msg;
    const el = document.getElementById('comfyui-progress');
    if (el) el.textContent = msg;
  });
  state.comfyuiGenerating = null;
  if (!res.ok) {
    showToast('⚠ ' + res.error);
    renderComfyUIView();
    return;
  }
  state.comfyuiOutputs = res.outputs;
  renderComfyUIView();
  showToast('✓ Generated ' + res.outputs.length + ' image(s) — use Import to copy them into the project');
}

// Copy generated outputs into the active project under
// Assets/Generated/<workflow-name>/, snapshotted first so revert
// can delete them (new files, like the v0.5.1 auto-apply rule), and
// add a Reference entry noting the workflow and settings used.
async function importComfyuiOutputs(wf, outputs, inputs) {
  const slug = comfyuiSlug(wf.name);
  const dir = 'Assets/Generated/' + slug + '/';
  const imported = [];
  const errors = [];
  if (!state.projectPath) {
    return { dir, imported, errors: ['No project folder set — pick a project first'] };
  }
  const snapshotId = 'snap_' + Date.now();
  let wroteAny = false;
  for (const o of (outputs || [])) {
    const dest = resolvePath(dir + o.filename);
    let exists = false;
    try { exists = await rb.fs.exists(dest); } catch {}
    if (exists) {
      errors.push(o.filename + ': already exists in the project — skipped, existing file kept');
      continue;
    }
    const res = await rb.comfyui.view({ filename: o.filename, subfolder: o.subfolder || '', type: o.type || 'output', destPath: dest, url: state.comfyuiUrl });
    if (res.ok) {
      imported.push({ filename: o.filename, path: dest });
      wroteAny = true;
      try { await rb.db.insert('file_backups', { snapshot_id: snapshotId, file_path: dest, content: NEW_FILE_SENTINEL }); } catch {}
    } else {
      errors.push(o.filename + ': ' + (res.error || 'download failed'));
    }
  }
  if (wroteAny) {
    try {
      await rb.db.insert('snapshots', { id: snapshotId, label: 'ComfyUI — ' + wf.name + ' (' + imported.length + ' file' + (imported.length !== 1 ? 's' : '') + ')', file_count: imported.length });
    } catch {}
    showRevertBar(snapshotId, 'ComfyUI — ' + wf.name, 0, imported.length);
    refreshSidebar().catch(() => {});
    try {
      await rb.db.insert('pages', {
        name: 'ComfyUI — ' + wf.name + ' — ' + new Date().toLocaleString(),
        content: 'Generated with ComfyUI workflow "' + wf.name + '" (' + (wf.file || 'from history') + ').\n'
          + 'Outputs imported to ' + dir + ': ' + imported.map(i => i.filename).join(', ') + '\n'
          + 'Inputs: ' + JSON.stringify(inputs || {}) + '\n',
        project_id: state.activeProjectId,
      });
    } catch {}
    await rb.unity.refresh(state.projectPath);
  }
  return { dir, imported, errors };
}

async function importComfyuiOutputAt(index) {
  const wf = findComfyuiWorkflow(state.comfyuiSelectedId);
  const o = state.comfyuiOutputs[index];
  if (!wf || !o) return;
  const res = await importComfyuiOutputs(wf, [o], { ...state.comfyuiGenInputs });
  if (res.imported.length) showToast('✓ Imported ' + res.imported[0].filename + ' to ' + res.dir);
  else showToast('⚠ ' + (res.errors[0] || 'Import failed'));
  renderComfyUIView();
}

async function importAllComfyuiOutputs() {
  const wf = findComfyuiWorkflow(state.comfyuiSelectedId);
  if (!wf || !state.comfyuiOutputs.length) return;
  const res = await importComfyuiOutputs(wf, state.comfyuiOutputs, { ...state.comfyuiGenInputs });
  if (res.imported.length) showToast('✓ Imported ' + res.imported.length + ' image(s) to ' + res.dir);
  else showToast('⚠ ' + (res.errors[0] || 'Import failed'));
  renderComfyUIView();
}

async function viewComfyuiHistoryOutputs(promptId) {
  const entry = state.comfyuiHistory.find(h => h.promptId === promptId);
  if (!entry || !entry.outputs.length) { showToast('No outputs for this generation'); return; }
  const withLocal = [];
  for (const o of entry.outputs) {
    const dl = await rb.comfyui.view({ filename: o.filename, subfolder: o.subfolder || '', type: o.type || 'output', promptId, url: state.comfyuiUrl });
    withLocal.push({ ...o, localPath: dl.ok ? dl.path : null });
  }
  state.comfyuiOutputs = withLocal;
  renderComfyUIView();
  showToast(withLocal.some(o => o.localPath) ? '✓ Outputs downloaded — use Import to copy them into the project' : '⚠ Could not download the outputs — is ComfyUI still running?');
}

// Run/Review bar for an unapproved workflow in the Agent loop.
// Run submits and resumes the loop with the tool result; Dismiss
// resumes it with a "User declined" note.
function showComfyuiBar(wf, inputs, settle) {
  const existing = document.getElementById('comfyui-bar');
  if (existing) existing.remove();
  const bar = document.createElement('div');
  bar.id = 'comfyui-bar';
  bar.style.cssText = 'position:fixed;bottom:0;left:260px;right:280px;background:var(--bg2);border-top:1px solid var(--border2);padding:10px 16px;display:flex;align-items:center;gap:12px;z-index:50;box-shadow:0 -2px 12px rgba(0,0,0,0.3);';
  const summary = Object.entries(inputs || {}).map(([k, v]) => k + ': ' + String(v).slice(0, 60)).join(', ') || 'default inputs';
  const label = document.createElement('span');
  label.style.cssText = 'color:var(--amber);font-size:13px;flex:1;';
  label.textContent = 'Generate with ComfyUI workflow "' + wf.name + '"? ' + summary + ' (This workflow is not approved for autonomous execution.)';
  const runBtn = document.createElement('button');
  runBtn.className = 'btn btn-teal';
  runBtn.textContent = 'Run';
  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn btn-secondary';
  dismissBtn.textContent = 'Dismiss';
  let decided = false;
  runBtn.onclick = () => { if (decided) return; decided = true; bar.remove(); settle({ decision: 'run' }); };
  dismissBtn.onclick = () => { if (decided) return; decided = true; bar.remove(); settle({ decision: 'declined' }); };
  bar.appendChild(label);
  bar.appendChild(runBtn);
  bar.appendChild(dismissBtn);
  document.body.appendChild(bar);
}

// ── ComfyUI centre view ───────────────────────────────────────────
async function renderComfyUIView() {
  const el = document.getElementById('comfyui-mode');
  if (!el) return;
  if (!state._comfyuiLoaded) {
    state._comfyuiLoaded = true;
    el.innerHTML = '<h2 style="font-size:15px;font-weight:600;margin-bottom:4px;">ComfyUI</h2><p style="color:var(--text3);font-size:12px;">Checking ComfyUI…</p>';
    await verifyComfyui();
    await refreshComfyuiWorkflows();
    await refreshComfyuiHistory();
    if (state.mode !== 'comfyui') return;
  }
  const st = state.comfyuiStatus;
  const statusText = st
    ? (st.ok ? 'Connected — ComfyUI at ' + state.comfyuiUrl + (st.version ? ' (v' + st.version + ')' : '') : 'Not running — ' + (st.error || 'could not reach ComfyUI'))
    : 'Not checked yet';
  const caps = state.comfyuiCapabilities || [];
  const selected = findComfyuiWorkflow(state.comfyuiSelectedId);
  const gen = state.comfyuiGenerating;
  // Every node class /object_info reported — never only the
  // familiar families, so an install with none of them still shows
  // exactly what it does have.
  const nodeClasses = state.comfyuiNodeClasses || (state.comfyuiObjectInfo ? Object.keys(state.comfyuiObjectInfo).sort() : []);
  const capabilitiesHtml = !st || !st.ok
    ? '<p style="color:var(--text3);font-size:12px;">Capabilities appear here once ComfyUI answers — they are read live from /object_info, never assumed.</p>'
    : (state.comfyuiObjectInfo == null
      ? '<p style="color:var(--text3);font-size:12px;">ComfyUI answered, but /object_info could not be read — capabilities cannot be listed. Press Save + Verify again.</p>'
      : (nodeClasses.length === 0
      ? '<p style="color:var(--text3);font-size:12px;">ComfyUI answered, but /object_info came back empty — 0 nodes listed. If ComfyUI only just started, wait a moment and press Save + Verify again.</p>'
      : (caps.length
        ? `<div class="chip-row">${caps.map(c => `<span class="chip">${escHtml(c.label)}</span>`).join('')}</div>`
        : '<p style="color:var(--text3);font-size:12px;">Connected, but no familiar node families were found in /object_info. Everything this install has is listed below.</p>')
      + `<details style="margin-top:8px;"><summary style="cursor:pointer;font-size:12px;color:var(--text2);">All nodes in /object_info (${nodeClasses.length})</summary><div style="max-height:140px;overflow:auto;font-family:var(--mono);font-size:11px;color:var(--text2);margin-top:6px;line-height:1.7;">${nodeClasses.map(c => escHtml(c)).join(', ')}</div></details>`));
  // Scan results — what was checked, what was found, what was not.
  const scanHtml = (() => {
    const s = state.comfyuiScan;
    if (!s) return '<p style="color:var(--text3);font-size:12px;">CodeFox checks the usual ComfyUI install folders on this computer — Desktop user data, Documents, portable installs — and reports what it finds. Nothing is guessed.</p>';
    if (s.scanning) return '<p style="color:var(--text2);font-size:12px;">Scanning the usual ComfyUI locations…</p>';
    if (!s.ok) return `<p style="color:var(--amber);font-size:12px;">Scan failed: ${escHtml(s.error || 'unknown error')}</p>`;
    const serverLine = s.server && s.server.ok
      ? `Server: connected at ${escHtml(s.server.url || '')}${s.server.version ? ' (v' + escHtml(String(s.server.version)) + ')' : ''}`
      : `Server: not running at ${escHtml((s.server && s.server.url) || state.comfyuiUrl)}${s.server && s.server.error ? ' — ' + escHtml(s.server.error) : ''}`;
    const rootRows = ((s.scan && s.scan.roots) || []).map(r => {
      if (!r.found) return `<div style="color:var(--text3);font-size:12px;">✕ ${escHtml(r.label)} — <span style="font-family:var(--mono);font-size:11px;">${escHtml(r.path)}</span> (not found)</div>`;
      const bits = [];
      if (r.workflows) bits.push(r.workflows.count + ' workflow(s)');
      if (r.models) {
        const parts = Object.entries(r.models).filter(([, n]) => n > 0).map(([k, n]) => k + ' ' + n);
        bits.push(parts.length ? 'models: ' + parts.join(', ') : 'models folder, no model files counted');
      }
      bits.push(r.customNodes ? 'custom_nodes present' : 'no custom_nodes');
      if (r.note) bits.push(escHtml(r.note));
      return `<div style="font-size:12px;color:var(--text2);">✓ ${escHtml(r.label)} — <span style="font-family:var(--mono);font-size:11px;">${escHtml(r.path)}</span><br><span style="color:var(--text3);">${bits.join(' · ')}</span></div>`;
    }).join('');
    return `<p style="font-size:12px;color:var(--text2);">${serverLine}</p>
      ${s.dir ? `<p style="font-size:12px;color:var(--teal);">Workflows folder found: <span style="font-family:var(--mono);font-size:11px;">${escHtml(s.dir)}</span> — ${(s.workflows || []).length} workflow(s) imported.</p>` : '<p style="font-size:12px;color:var(--amber);">No workflows folder found in the usual locations — pick one with Browse below.</p>'}
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">${rootRows}</div>
      ${(s.errors || []).length ? `<p style="font-size:11px;color:var(--amber);">${escHtml(s.errors.join('; '))}</p>` : ''}`;
  })();

  const inputFieldHtml = (inp) => {
    const key = inp.role === 'positive' ? 'positive' : inp.role === 'negative' ? 'negative' : inp.nodeId + '.' + inp.inputName;
    const cur = state.comfyuiGenInputs[key] !== undefined ? state.comfyuiGenInputs[key] : inp.value;
    const esc = escHtml(String(cur == null ? '' : cur));
    if (inp.role === 'positive' || inp.role === 'negative') {
      return `<label class="field-label">${escHtml(inp.label)}
        <textarea id="comfyui-input-${key}" oninput="onComfyuiInputChange('${key}', this)" style="min-height:56px;">${esc}</textarea>
      </label>`;
    }
    if (inp.inputName === 'seed') {
      return `<label class="field-label">Seed
        <span style="display:flex;gap:8px;"><input id="comfyui-input-seed" type="number" value="${esc}" oninput="onComfyuiInputChange('${key}', this)" style="flex:1;" /><button class="btn btn-secondary" onclick="randomiseComfyuiSeed()">Randomise</button></span>
      </label>`;
    }
    if (inp.type === 'number') {
      return `<label class="field-label">${escHtml(inp.label)} <span style="color:var(--text3);font-size:11px;">(${escHtml(inp.classType)} · node ${escHtml(inp.nodeId)})</span>
        <input type="number" value="${esc}" oninput="onComfyuiInputChange('${key}', this)" />
      </label>`;
    }
    return `<label class="field-label">${escHtml(inp.label)} <span style="color:var(--text3);font-size:11px;">(${escHtml(inp.classType)} · node ${escHtml(inp.nodeId)})</span>
      <input type="text" value="${esc}" oninput="onComfyuiInputChange('${key}', this)" />
    </label>`;
  };

  const libraryHtml = state.comfyuiWorkflows.length
    ? state.comfyuiWorkflows.map(w => {
        const isSel = selected && selected.id === w.id;
        return `<div class="conn-row" style="align-items:flex-start;${isSel ? 'border-color:var(--accent);' : ''}">
          <span class="conn-ico">◈</span>
          <span class="conn-row-info" style="flex:1;">
            <span class="conn-name">${escHtml(w.name)}</span>
            <span style="font-size:11px;color:${w.available ? 'var(--teal)' : 'var(--amber)'};"> ${w.available ? 'Available' : 'Unavailable — ' + escHtml(w.availableReason || (w.missing || []).join('; '))}</span><br>
            <span style="font-size:12px;color:var(--text2);">Purpose: </span>
            <input value="${escHtml(w.purpose || '')}" onchange="setComfyuiPurpose('${w.id}', this)" style="width:260px;padding:3px 8px;font-size:12px;" />
            <br><span style="font-size:11px;color:var(--text3);">${escHtml((w.inputs || []).length)} configurable input(s) · ${escHtml((w.outputs || []).length)} output node(s)${(w.missing || []).length ? ' · Missing: ' + escHtml(w.missing.join('; ')) : ''}</span>
            <br><span style="font-size:11px;color:var(--text3);font-family:var(--mono);">${escHtml(w.file)}</span>
          </span>
          <span style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
            <label style="display:flex;align-items:center;gap:6px;color:var(--text2);font-size:12px;cursor:pointer;" title="Only approved workflows run from the Agent loop without asking">
              <input type="checkbox" ${w.approved ? 'checked' : ''} onchange="toggleComfyuiApproved('${w.id}', this.checked)" style="width:auto;" /> Approved
            </label>
            <button class="btn ${isSel ? 'btn-secondary' : 'btn-teal'}" onclick="selectComfyuiWorkflow('${w.id}')" ${w.available ? '' : 'disabled'}>${isSel ? 'Selected' : 'Generate'}</button>
          </span>
        </div>`;
      }).join('')
    : '<div style="color:var(--text3);font-size:12px;padding:6px 0 12px;">No workflows imported yet — pick the folder where your ComfyUI workflow JSON files live, then Rescan. Workflows are your own files; CodeFox never ships a sample workflow.</div>';

  const generateHtml = selected
    ? `<h3 class="settings-subhead">Generate — ${escHtml(selected.name)}</h3>
      ${selected.available ? '' : `<p style="color:var(--amber);font-size:12px;">Unavailable: ${escHtml(selected.availableReason || (selected.missing || []).join('; '))}</p>`}
      <div style="display:flex;flex-direction:column;gap:10px;max-width:560px;">
        ${simpleComfyuiFormHtml(selected)}
      </div>
      <h3 class="settings-subhead" style="margin-top:16px;">Advanced — all inputs</h3>
      <p style="color:var(--text3);font-size:11px;">Every input this workflow exposes, including the ones above. Same values, same Run button.</p>
      <div style="display:flex;flex-direction:column;gap:10px;max-width:560px;">
        ${(selected.inputs || []).map(inputFieldHtml).join('')}
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:12px;">
        <button class="btn btn-teal" onclick="runComfyuiFromPanel()" ${selected.available && !gen ? '' : 'disabled'}>${gen ? 'Generating…' : 'Run'}</button>
        ${gen ? `<button class="btn btn-danger" onclick="stopComfyuiGeneration()">Cancel</button>` : ''}
        <span id="comfyui-progress" style="font-size:12px;color:var(--text2);">${gen ? escHtml(gen.status || 'Working…') : ''}</span>
      </div>
      ${state.comfyuiOutputs.length ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">
          ${state.comfyuiOutputs.map((o, i) => `
            <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px;width:180px;">
              ${o.localPath ? `<img src="${comfyuiFileUrl(o.localPath)}" style="width:100%;border-radius:6px;display:block;" />` : `<div style="color:var(--text3);font-size:11px;">Could not download thumbnail${o.downloadError ? ': ' + escHtml(o.downloadError) : ''}</div>`}
              <div style="font-size:11px;color:var(--text2);font-family:var(--mono);margin:6px 0;word-break:break-all;">${escHtml(o.filename)}</div>
              <button class="btn btn-secondary" onclick="importComfyuiOutputAt(${i})" style="font-size:11px;">Import to project</button>
            </div>`).join('')}
        </div>
        <div style="margin-top:10px;"><button class="btn btn-teal" onclick="importAllComfyuiOutputs()">Import all to project</button>
        <span style="font-size:11px;color:var(--text3);margin-left:8px;">Imports to Assets/Generated/${escHtml(comfyuiSlug(selected.name))}/ — snapshotted first, so revert can delete them.</span></div>
      ` : ''}`
    : '<p style="color:var(--text3);font-size:12px;">Select a workflow above to generate with it.</p>';

  const historyHtml = state.comfyuiHistory.length
    ? state.comfyuiHistory.map(h => `
      <div class="conn-row">
        <span class="conn-ico">◈</span>
        <span class="conn-row-info"><span class="conn-name" style="font-family:var(--mono);font-size:11px;">${escHtml(h.promptId)}</span><br>
        <span class="conn-status">${escHtml(h.status)}${h.completed ? ' ✓' : ''} · ${h.outputs.length} output(s)</span></span>
        <button class="btn btn-secondary" onclick="viewComfyuiHistoryOutputs('${escHtml(h.promptId)}')" ${h.outputs.length ? '' : 'disabled'}>View outputs</button>
      </div>`).join('')
    : '<div style="color:var(--text3);font-size:12px;">No generations in ComfyUI history yet — or ComfyUI is not running.</div>';

  el.innerHTML = `
    <h2 style="font-size:15px;font-weight:600;margin-bottom:4px;">ComfyUI</h2>
    <p style="color:var(--text3);font-size:12px;margin-bottom:16px;">Generate images with your local ComfyUI, and bring the results into the project. ComfyUI handles generation; CodeFox handles the workflow. Monitoring is by polling — there is no WebSocket client.</p>
    <h3 class="settings-subhead">Connection</h3>
    <div class="conn-row">
      <span class="conn-ico">◈</span>
      <span class="conn-row-info" style="flex:1;">
        <span style="display:flex;gap:8px;align-items:center;">
          <input id="comfyui-url" value="${escHtml(state.comfyuiUrl)}" style="flex:1;" placeholder="http://127.0.0.1:8188" />
          <button class="btn btn-secondary" onclick="onComfyuiUrlSave()">Save + Verify</button>
        </span>
        <span class="conn-status ${st && st.ok ? 'connected' : ''}" style="display:block;margin-top:6px;">${escHtml(statusText)}</span>
      </span>
      <button class="btn btn-secondary" onclick="rb.shell.openExternal('${escHtml(state.comfyuiUrl)}')">Open ComfyUI ↗</button>
    </div>
    <h3 class="settings-subhead">Find ComfyUI</h3>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
      <button class="btn btn-teal" onclick="scanComfyui()">Scan for ComfyUI</button>
      <span style="font-size:11px;color:var(--text3);">Checks the usual install folders and the server, and imports any workflows it finds. Browse below still works by hand.</span>
    </div>
    ${scanHtml}
    <h3 class="settings-subhead">Discovered capabilities</h3>
    ${capabilitiesHtml}
    <h3 class="settings-subhead">Workflow Library</h3>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
      <input id="comfyui-workflows-dir" value="${escHtml(state.comfyuiWorkflowsDir || '')}" placeholder="Folder with your ComfyUI workflow JSON files" style="flex:1;" readonly />
      <button class="btn btn-secondary" onclick="browseComfyuiWorkflowsDir()">Browse</button>
      <button class="btn btn-secondary" onclick="refreshComfyuiWorkflows().then(() => renderComfyUIView())">Rescan</button>
    </div>
    ${libraryHtml}
    ${generateHtml}
    <h3 class="settings-subhead">History</h3>
    <p class="settings-note">Last 20 generations from ComfyUI /history.</p>
    ${historyHtml}`;
}

// ── Rules section ─────────────────────────────────────────────────
function renderRulesPane(body) {
  const last = window._lastRulesIncluded;
  const includedLine = last
    ? `<p class="settings-note">Included in the last message: ${last.included.length ? escHtml(last.included.join(', ')) : 'none'} (${last.chars} characters)${last.leftOut.length ? '<br>Left out this time: ' + escHtml(last.leftOut.join(', ')) : ''}</p>`
    : '<p class="settings-note">No message sent yet in this session — send a chat message, then come back here to see which rules were included.</p>';
  body.innerHTML = `
    <label class="field-label">Prompt budget — max characters of rules sent with each message
      <div style="display:flex;gap:8px;">
        <input id="rules-budget" type="number" min="1000" max="12000" step="500" value="${state.rulesCharBudget}" style="flex:1;" />
        <button class="btn btn-secondary" onclick="saveRulesBudget()" style="flex-shrink:0;">Save budget</button>
      </div>
      <span class="field-note">Local models have small memories. CodeFox only sends this many characters of rules with each message — your highest-priority rules first. Anything over the budget is left out of that message, and the list below shows what was included last time.</span>
    </label>
    ${includedLine}
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0;">
      <button class="btn btn-secondary" id="condense-btn" onclick="condenseRules()">Condense rules</button>
      <label style="display:flex;align-items:center;gap:8px;color:var(--text2);font-size:12px;"><input type="checkbox" id="use-condensed" ${state.useCondensedRules ? 'checked' : ''} onchange="toggleUseCondensed(this.checked)" style="width:auto;" /> Use condensed rules when over budget</label>
    </div>
    ${state.condensedRules ? `<div class="settings-note-box"><strong>Condensed rules</strong><br>${escHtml(state.condensedRules)}</div>` : ''}
    <div id="rules-list"><div style="color:var(--text3);font-size:12px;">Loading rulesets…</div></div>`;
  renderRulesList();
}

async function renderRulesList() {
  const el = document.getElementById('rules-list');
  if (!el) return;
  const rulesets = await rb.db.getAll('rulesets');
  const pid = state.activeProjectId;
  const mine = pid == null ? rulesets : rulesets.filter(r => r.project_id == null || Number(r.project_id) === Number(pid));
  mine.sort((a, b) => (Number(b.priority || 0) - Number(a.priority || 0)) || (Number(b.id) - Number(a.id)));
  if (!mine.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;">No rulesets yet — create one from the sidebar.</div>';
    return;
  }
  el.innerHTML = mine.map(r => {
    const len = (r.content || '').length;
    const enabled = r.enabled == null || Number(r.enabled) !== 0;
    return `<div class="conn-row">
      <span class="conn-row-info"><span class="conn-name">${escHtml(r.name)}</span><br>
      <span class="conn-status">${len} characters · priority ${Number(r.priority || 0)}</span></span>
      <button class="btn btn-secondary" onclick="moveRulesetPriority(${r.id}, 1)" title="Send this ruleset sooner">↑</button>
      <button class="btn btn-secondary" onclick="moveRulesetPriority(${r.id}, -1)" title="Send this ruleset later">↓</button>
      <label class="switch" title="Include this ruleset in prompts"><input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleRulesetEnabled(${r.id}, this.checked)"><span class="slider"></span></label>
      <button class="btn btn-secondary" onclick="loadItem('rulesets', ${r.id})">Edit</button>
    </div>`;
  }).join('');
}

async function toggleRulesetEnabled(id, enabled) {
  await rb.db.update('rulesets', id, { enabled: enabled ? 1 : 0 });
  await refreshSidebar();
  renderSettingsView();
}

async function moveRulesetPriority(id, delta) {
  const row = await rb.db.get('rulesets', id);
  if (!row) return;
  await rb.db.update('rulesets', id, { priority: Number(row.priority || 0) + delta });
  renderSettingsView();
}

async function saveRulesBudget() {
  const raw = parseInt(document.getElementById('rules-budget')?.value, 10);
  if (isNaN(raw)) { showToast('Enter a number from 1000 to 12000'); return; }
  const budget = Math.min(12000, Math.max(1000, raw));
  state.rulesCharBudget = budget;
  await rb.db.setSetting('rules_char_budget', String(budget));
  renderSettingsView();
  showToast('✓ Prompt budget saved: ' + budget + ' characters');
}

async function toggleUseCondensed(checked) {
  state.useCondensedRules = !!checked;
  await rb.db.setSetting('use_condensed_rules', checked ? '1' : '0');
}

async function condenseRules() {
  const rulesets = await rb.db.getAll('rulesets');
  const pid = state.activeProjectId;
  const enabled = (rulesets || []).filter(r => (r.enabled == null || Number(r.enabled) !== 0) && (pid == null || r.project_id == null || Number(r.project_id) === Number(pid)));
  if (!enabled.length) { showToast('No enabled rulesets to condense'); return; }
  const btn = document.getElementById('condense-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Condensing…'; }
  const full = enabled.map(r => '### ' + r.name + '\n' + r.content).join('\n\n');
  const prompt = 'Condense these project rules into one short version under 500 characters. Keep every hard constraint, every "never do" rule, and every naming/architecture rule — drop examples and explanations, never drop a constraint.\n\n' + full;
  let out = '';
  rb.llm.removeListeners();
  const done = new Promise((resolve) => {
    rb.llm.onChunk(chunk => { out += chunk; });
    rb.llm.onDone(() => resolve(true));
  });
  try {
    await rb.llm.chat({
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: 'You condense coding rules. Reply with only the condensed rules, under 500 characters.',
      provider: state.provider,
      model: currentModel(),
      lmstudioUrl: state.lmstudioUrl,
      lmstudioApiKey: state.lmstudioApiKey,
      ollamaUrl: state.ollamaUrl,
      temperature: 0,
      maxTokens: 1024,
    });
    await done;
  } catch (e) {
    rb.llm.removeListeners();
    if (btn) { btn.disabled = false; btn.textContent = 'Condense rules'; }
    showToast('⚠ Could not reach ' + providerLabel() + ': ' + (e.message || ''));
    return;
  }
  rb.llm.removeListeners();
  const condensed = out.trim().slice(0, 2000);
  if (!condensed) {
    if (btn) { btn.disabled = false; btn.textContent = 'Condense rules'; }
    showToast('⚠ The model returned nothing — condensed rules unchanged');
    return;
  }
  state.condensedRules = condensed;
  await rb.db.setSetting('condensed_rules', condensed);
  showToast('✓ Condensed rules saved');
  renderSettingsView();
}

// ── Advanced section ──────────────────────────────────────────────
function renderAdvancedPane(body) {
  const disabled = state.shellEnabled ? '' : 'settings-disabled';
  body.innerHTML = `
    <h3 class="settings-subhead">Shell Tool</h3>
    <label class="settings-toggle-row"><span>Allow CodeFox to run PowerShell commands</span>
      <span class="switch"><input type="checkbox" ${state.shellEnabled ? 'checked' : ''} onchange="setShellToggle('shell_enabled', this.checked)"><span class="slider"></span></span></label>
    <p class="settings-note">Shell: PowerShell — used to run terminal commands in the project folder.</p>
    <div class="${disabled}">
      <h3 class="settings-subhead">Auto Mode</h3>
      <label class="settings-toggle-row"><span>Run eligible commands automatically</span>
        <span class="switch"><input type="checkbox" ${state.shellAutoMode ? 'checked' : ''} onchange="setShellToggle('shell_auto_mode', this.checked)"><span class="slider"></span></span></label>
      <p class="settings-note">When on, commands that match your auto-approved list run without asking. Everything else asks first.</p>
      <h3 class="settings-subhead">Approvals</h3>
      <label class="settings-toggle-row"><span>Auto-accept project changes</span>
        <span class="switch"><input type="checkbox" ${state.autoAcceptChanges ? 'checked' : ''} onchange="setShellToggle('auto_accept_changes', this.checked)"><span class="slider"></span></span></label>
      <p class="settings-note">Keep project changes automatically when the assistant finishes a response. Changes are still snapshotted first, and the revert bar is always shown so you can undo.</p>
      <label class="settings-toggle-row"><span>Auto-apply new Unity asset files</span>
        <span class="switch"><input type="checkbox" ${state.autoApplyUnityAssets ? 'checked' : ''} onchange="setShellToggle('auto_apply_unity_assets', this.checked)"><span class="slider"></span></span></label>
      <p class="settings-note">When the assistant creates a new Unity-native file — a prefab, scene, material, animation or similar — CodeFox writes it straight away after taking a snapshot, without asking you to click Apply. Code files (.cs, .shader, .js, .ts) and edits to existing files still ask first, unless auto-accept is on. The revert bar is always shown afterwards, so you can still undo.</p>
      <h3 class="settings-subhead">Auto-approved commands</h3>
      <p class="settings-note">Commands starting with one of these run automatically when Auto Mode is on. Anything else asks first.</p>
      <div class="chip-row">${state.shellAutoApprove.map((c, i) => `<span class="chip">${escHtml(c)} <span class="chip-x" onclick="removeAutoApprove(${i})">✕</span></span>`).join('')}</div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <input id="auto-approve-input" placeholder="e.g. git log" style="flex:1;" />
        <button class="btn btn-secondary" onclick="addAutoApprove()">Add</button>
      </div>
      <h3 class="settings-subhead">Excluded File Types</h3>
      <p class="settings-note">Files matching these patterns are hidden from project scans and file search.</p>
      <div class="chip-row">${state.excludedFileTypes.map((c, i) => `<span class="chip">${escHtml(c)} <span class="chip-x" onclick="removeExcludedType(${i})">✕</span></span>`).join('')}</div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <input id="excluded-type-input" placeholder="e.g. tmp" style="flex:1;" />
        <button class="btn btn-secondary" onclick="addExcludedType()">Add</button>
        <button class="btn btn-secondary" onclick="restoreExcludedDefaults()">Restore default</button>
      </div>
      <h3 class="settings-subhead">Run a command</h3>
      <p class="settings-note">Test the shell tool directly. Commands run in the project folder.</p>
      <div style="display:flex;gap:8px;">
        <input id="shell-manual-cmd" placeholder="e.g. git status" style="flex:1;" onkeydown="if(event.key==='Enter') runManualCommand()" />
        <button class="btn btn-teal" onclick="runManualCommand()">Run</button>
      </div>
      <pre id="shell-manual-output" class="settings-output">No command run yet.</pre>
      <p class="settings-note">Dangerous commands are never run automatically: rm, del, Remove-Item, format, rm -rf, Remove-Item -Recurse, Remove-Item -Force -Recurse, rmdir /s, and rd /s always ask first, even if they match an auto-approved prefix.</p>
    </div>
    <h3 class="settings-subhead">Diagnostics</h3>
    <p class="settings-note">If buttons stop responding or a connection check does nothing, the developer console usually says why — the red errors there are the first thing to check. This button opens it without needing a keyboard shortcut.</p>
    <button class="btn btn-secondary" onclick="openDevTools()">Developer tools</button>
    <h3 class="settings-subhead">Agent loop</h3>
    <p class="settings-note">In Agent mode, CodeFox runs a loop: after each reply it runs the model's safe commands, applies its file changes, and installs the packages it asked for, then sends the results back to the model so it can fix errors and try again — without you prompting again. Ask and Plan modes never loop.</p>
    <label class="field-label">Max tool rounds per reply (1–10)
      <div style="display:flex;gap:8px;">
        <input id="agent-max-rounds" type="number" min="1" max="10" step="1" value="${state.agentMaxRounds}" style="flex:1;" />
        <button class="btn btn-secondary" onclick="saveAgentMaxRounds()" style="flex-shrink:0;">Save</button>
      </div>
      <span class="field-note">Default: 5. When the max is reached the loop stops and says so — it never runs unbounded. Click Stop under the reply to end a loop early.</span>
    </label>
    <h3 class="settings-subhead">What runs automatically, what always asks</h3>
    <div class="settings-note-box">• Safe auto-approved commands run automatically in Auto Mode.
• Dangerous commands (rm, del, Remove-Item, format, rm -rf, rmdir /s, rd /s, Remove-Item -Recurse) always ask first.
• Package installs and removals always ask first — even in Auto Mode, even with auto-accept on.
• New Unity asset files (prefabs, scenes, materials…) are written automatically after a snapshot — revert is always available afterwards.
• File changes ask first unless auto-accept is on (and are snapshotted first either way).
• Nothing runs while the shell is off, and no package is installed while no project folder is set.</div>
    <h3 class="settings-subhead">Editor Integration</h3>
    <p class="settings-note">The Unity bridge is CodeFox's editor integration — it refreshes Unity's AssetDatabase when CodeFox writes files, and runs editor commands from Unity. There is nothing else to configure here.</p>
    <button class="btn btn-secondary" onclick="showSettings('connections')">Manage the Unity bridge in Connections →</button>`;
}

async function setShellToggle(key, checked) {
  const on = !!checked;
  if (key === 'shell_enabled') state.shellEnabled = on;
  else if (key === 'shell_auto_mode') state.shellAutoMode = on;
  else if (key === 'auto_accept_changes') state.autoAcceptChanges = on;
  else if (key === 'auto_apply_unity_assets') state.autoApplyUnityAssets = on;
  await rb.db.setSetting(key, on ? '1' : '0');
  renderSettingsView();
  if (key === 'shell_enabled') {
    showToast(on ? 'Shell tool enabled — commands can run from this app' : 'Shell tool disabled — no commands can run');
  }
}

async function saveAgentMaxRounds() {
  const raw = parseInt(document.getElementById('agent-max-rounds')?.value, 10);
  if (isNaN(raw)) { showToast('Enter a number from 1 to 10'); return; }
  const max = clampAgentMaxRounds(raw);
  state.agentMaxRounds = max;
  await rb.db.setSetting('agent_max_rounds', String(max));
  renderSettingsView();
  showToast('✓ Max agent rounds saved: ' + max);
}

async function addAutoApprove() {
  const v = document.getElementById('auto-approve-input')?.value?.trim();
  if (!v) return;
  if (!state.shellAutoApprove.includes(v)) state.shellAutoApprove.push(v);
  await rb.db.setSetting('shell_auto_approve', JSON.stringify(state.shellAutoApprove));
  renderSettingsView();
}

async function removeAutoApprove(i) {
  state.shellAutoApprove.splice(i, 1);
  await rb.db.setSetting('shell_auto_approve', JSON.stringify(state.shellAutoApprove));
  renderSettingsView();
}

async function addExcludedType() {
  const v = document.getElementById('excluded-type-input')?.value?.trim().replace(/^\./, '');
  if (!v) return;
  if (!state.excludedFileTypes.includes(v)) state.excludedFileTypes.push(v);
  await rb.db.setSetting('excluded_file_types', JSON.stringify(state.excludedFileTypes));
  renderSettingsView();
}

async function removeExcludedType(i) {
  state.excludedFileTypes.splice(i, 1);
  await rb.db.setSetting('excluded_file_types', JSON.stringify(state.excludedFileTypes));
  renderSettingsView();
}

async function restoreExcludedDefaults() {
  state.excludedFileTypes = DEFAULT_EXCLUDED_FILE_TYPES.slice();
  await rb.db.setSetting('excluded_file_types', JSON.stringify(state.excludedFileTypes));
  renderSettingsView();
  showToast('✓ Excluded file types restored to the default list');
}

// Diagnostics (v0.6.2) — opens the developer console, the same
// panel as Ctrl+Shift+I, for users whose keyboard shortcut is
// intercepted by other software. (v0.6.3) If this call itself fails
// the bridge is down, so the failure must be visible on screen —
// showToast is pure DOM and needs no bridge — instead of only
// logging to a console the user cannot open.
async function openDevTools() {
  try { await rb.app.openDevTools(); }
  catch (e) {
    console.error('Could not open Developer tools:', e);
    showToast('Developer tools could not be opened — the app bridge is not responding.');
  }
}

async function runManualCommand() {
  const input = document.getElementById('shell-manual-cmd');
  const out = document.getElementById('shell-manual-output');
  if (!input || !out) return;
  const cmd = input.value.trim();
  if (!cmd) return;
  if (!state.shellEnabled) {
    out.textContent = 'Shell tool is off. Turn on "Allow CodeFox to run PowerShell commands" above first.';
    return;
  }
  out.textContent = 'Running…';
  const res = await rb.shell.run({ command: cmd, cwd: state.projectPath });
  appendShellResultTo(out, cmd, res);
}

function appendShellResultTo(el, cmd, res) {
  const output = ((res.stdout || '') + (res.stderr ? '\n' + res.stderr : '')).trim() || '(no output)';
  el.textContent = '$ ' + cmd + '\n' + output + (res.ok === false ? '\n⚠ ' + (res.error || ('Command exited with code ' + res.code)) : '');
}

// ── Shell commands from assistant replies ─────────────────────────
// A command is only ever run automatically when ALL of these hold:
// the shell tool is on, Auto Mode is on, the command's first line
// starts with an auto-approved prefix, and the command is not
// dangerous. Dangerous commands — rm, del, Remove-Item, format,
// rm -rf, Remove-Item -Recurse, Remove-Item -Force -Recurse,
// rmdir /s, rd /s — always require an explicit Run click, even if
// they match a prefix. Anything else the assistant suggests gets a
// Run / Dismiss bar instead.
function extractShellBlocks(text) {
  const out = [];
  const re = /```(powershell|pwsh|shell)\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text))) {
    const cmd = m[2].trim();
    if (cmd) out.push(cmd);
  }
  return out;
}

function firstCommandLine(cmd) {
  return String(cmd || '').split('\n').map(l => l.trim()).find(l => l) || '';
}

function isDangerousCommand(cmd) {
  const text = String(cmd || '');
  const first = firstCommandLine(cmd);
  const patterns = [/^\s*rm\b/i, /^\s*del\b/i, /^\s*format\b/i, /^\s*remove-item\b/i, /^\s*rmdir\b/i, /^\s*rd\b/i, /rm\s+-rf/i, /remove-item\s+.*-recurse/i, /remove-item\s+.*-force\s+.*-recurse/i, /remove-item\s+.*-recurse\s+.*-force/i, /rmdir\s+\/s/i, /\brd\s+\/s/i];
  return patterns.some(re => re.test(text) || re.test(first));
}

function matchesAutoApprove(cmd) {
  const first = firstCommandLine(cmd);
  return (state.shellAutoApprove || []).some(p => p && first.startsWith(p));
}

async function handleShellBlocks(text) {
  if (!state.shellEnabled) return;
  const blocks = extractShellBlocks(text);
  for (const cmd of blocks) {
    if (state.shellAutoMode && matchesAutoApprove(cmd) && !isDangerousCommand(cmd)) {
      const res = await rb.shell.run({ command: cmd, cwd: state.projectPath });
      const output = ((res.stdout || '') + (res.stderr ? '\n' + res.stderr : '')).trim() || '(no output)';
      addSystemMessage('$ ' + cmd + '\n' + output + (res.ok === false ? '\n⚠ ' + (res.error || ('Command exited with code ' + res.code)) : ''));
    } else {
      showShellBar(cmd);
    }
  }
}

function showShellBar(cmd, onDecision) {
  if (!window._shellQueue) window._shellQueue = [];
  window._shellQueue.push({ cmd, onDecision: onDecision || null });
  renderShellBar();
}

function renderShellBar() {
  const existing = document.getElementById('shell-bar');
  if (existing) existing.remove();
  const queue = window._shellQueue || [];
  const entry = queue[0];
  if (!entry) return;
  const cmd = entry.cmd || entry;
  const onDecision = entry.onDecision || null;
  const bar = document.createElement('div');
  bar.id = 'shell-bar';
  bar.style.cssText = 'position:fixed;bottom:0;left:260px;right:280px;background:var(--bg2);border-top:1px solid var(--border2);padding:10px 16px;display:flex;align-items:center;gap:12px;z-index:50;box-shadow:0 -2px 12px rgba(0,0,0,0.3);';
  const label = document.createElement('span');
  label.style.cssText = 'color:var(--amber);font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);';
  label.textContent = '$ ' + firstCommandLine(cmd);
  const runBtn = document.createElement('button');
  runBtn.className = 'btn btn-teal';
  runBtn.textContent = '▶ Run';
  runBtn.onclick = () => runShellCommand(cmd, onDecision);
  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn btn-secondary';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.onclick = () => {
    if (window._shellQueue) window._shellQueue.shift();
    renderShellBar();
    if (onDecision) onDecision({ decision: 'declined' });
  };
  bar.appendChild(label);
  bar.appendChild(runBtn);
  bar.appendChild(dismissBtn);
  document.body.appendChild(bar);
}

async function runShellCommand(cmd, onDecision) {
  const res = await rb.shell.run({ command: cmd, cwd: state.projectPath });
  if (window._shellQueue) {
    const i = window._shellQueue.findIndex(e => (e.cmd || e) === cmd);
    if (i >= 0) window._shellQueue.splice(i, 1);
  }
  renderShellBar();
  if (onDecision) {
    // Agent loop: the loop appends the tool result itself.
    onDecision({ decision: 'run', result: res });
    return;
  }
  const output = ((res.stdout || '') + (res.stderr ? '\n' + res.stderr : '')).trim() || '(no output)';
  addSystemMessage('$ ' + cmd + '\n' + output + (res.ok === false ? '\n⚠ ' + (res.error || ('Command exited with code ' + res.code)) : ''));
}


// ── Unity refresh ─────────────────────────────────────────────────
async function triggerUnityRefresh() {
  const result = await rb.unity.refresh(state.projectPath);
  showToast(result.ok ? '✓ Unity refresh triggered' : '⚠ ' + result.error);
}

// ── Helpers ───────────────────────────────────────────────────────
function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, { position:'fixed', bottom:'20px', right:'20px', background:'var(--bg4)', color:'var(--text)', padding:'8px 14px', borderRadius:'8px', fontSize:'13px', zIndex:'999', border:'1px solid var(--border2)', opacity:'1', transition:'opacity 0.4s' });
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2500);
}

// ── File apply from LLM response ─────────────────────────────────

const NEW_FILE_SENTINEL = '__CODEFOX_NEW_FILE__';
const CODE_EXTS = 'cs|unity|prefab|asset|json|shader|md|txt|js|ts';

function extractFileChanges(responseText) {
  const changes = [];
  const lines = responseText.split('\n');
  let pendingPath = null;
  const extRe = new RegExp('([A-Za-z][\\w/\\.-]+\\.(' + CODE_EXTS + '))', 'i');
  const pathPatterns = [
    /\*\*File Path:\*\*\s*`([^`]+)`/i,
    /\*\*Script:\*\*\s*`([^`]+)`/i,
    /\*\*File:\*\*\s*`([^`]+)`/i,
    /^FILE:\s*(.+?)\s*$/,
    /^[`\s]*([A-Za-z][\w/\.-]+\.(?:cs|unity|prefab|asset|json|shader|md|txt|js|ts))\s*$/,
    /`([A-Za-z\/\][\w/\.-]+\.(?:cs|unity|prefab|asset|json|shader|md|txt|js|ts))`/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of pathPatterns) {
      const m = line.match(pat);
      if (m) { pendingPath = m[1].trim(); break; }
    }
    // Any fenced code block (```csharp, ```json, ```, …) — except
    // action blocks (powershell / upm-install / upm-remove), which
    // are not files and are handled by the agent loop instead.
    const fenceMatch = line.match(/^```\s*(\S*)\s*$/);
    if (fenceMatch) {
      const fenceLang = (fenceMatch[1] || '').toLowerCase();
      // ```file:<path> (v0.5.2): the path is the fence itself, e.g.
      // ```file:Assets/Editor/CodeFoxBridge.cs — same meaning as a
      // **File Path:** line above the block. Use the raw capture,
      // not the lowercased one, so the path keeps its case.
      if (fenceLang.startsWith('file:')) {
        const fp = (fenceMatch[1] || '').slice(5).trim().replace(/^`|`$/g, '');
        if (fp) pendingPath = fp;
      }
      if (fenceLang === 'powershell' || fenceLang === 'pwsh' || fenceLang === 'shell' || fenceLang === 'upm-install' || fenceLang === 'upm-remove') {
        let j = i + 1;
        while (j < lines.length && !lines[j].match(/^```\s*$/)) j++;
        i = j;
        pendingPath = null;
        continue;
      }
      let code = '';
      let j = i + 1;
      while (j < lines.length && !lines[j].match(/^```\s*$/)) {
        if (j === i + 1) {
          const cm = lines[j].match(/^\/\/\s*([A-Za-z][\w/\.-]+\.(?:cs|unity|prefab|asset|json|shader|md|txt|js|ts))/);
          if (cm) { if (!pendingPath) pendingPath = cm[1].trim(); j++; continue; }
          const cm2 = lines[j].match(/^#\s*([A-Za-z][\w/\.-]+\.(?:cs|unity|prefab|asset|json|shader|md|txt|js|ts))/);
          if (cm2) { if (!pendingPath) pendingPath = cm2[1].trim(); j++; continue; }
        }
        code += lines[j] + '\n';
        j++;
      }
      i = j;
      if (pendingPath && code.trim()) {
        changes.push({ path: pendingPath, code: code.trimEnd() });
      }
      pendingPath = null;
    }
  }
  return changes;
}

// ── Diff preview (simple line-based diff) ─────────────────────────
function diffLines(oldLines, newLines) {
  // LCS diff; falls back to whole-file replace for very large files.
  if (oldLines.length * newLines.length > 250000) {
    return [
      ...oldLines.map(l => ({ type: 'del', text: l })),
      ...newLines.map(l => ({ type: 'add', text: l })),
    ];
  }
  const n = oldLines.length, m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { out.push({ type: 'ctx', text: oldLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: oldLines[i] }); i++; }
    else { out.push({ type: 'add', text: newLines[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: oldLines[i] }); i++; }
  while (j < m) { out.push({ type: 'add', text: newLines[j] }); j++; }
  return out;
}

let pendingDiffChanges = null;
async function showDiffOverlay(changes, onDecision) {
  pendingDiffChanges = changes;
  window._diffOnDecision = onDecision || null;
  const content = document.getElementById('diff-content');
  const overlay = document.getElementById('diff-overlay');
  if (!content || !overlay) return;
  content.innerHTML = '<div style="color:var(--text3);padding:12px;">Loading current files…</div>';
  overlay.classList.add('open');
  let html = '';
  for (const change of changes) {
    const fullPath = resolvePath(change.path);
    const existing = await rb.fs.readFile(fullPath);
    const oldText = existing.ok ? existing.content : '';
    const diff = diffLines(oldText.split('\n'), change.code.split('\n'));
    const adds = diff.filter(d => d.type === 'add').length;
    const dels = diff.filter(d => d.type === 'del').length;
    html += `<div style="margin-bottom:16px;">
      <div style="font-family:var(--mono);font-size:12px;color:var(--text);margin-bottom:6px;">${escHtml(change.path)} <span style="color:var(--text3);">${existing.ok ? `(${adds} added, ${dels} removed)` : '(new file)'}</span></div>
      <div class="diff-view">${diff.map(d => `<div class="diff-line diff-${d.type}">${escHtml(d.text) || ' '}</div>`).join('')}</div>
    </div>`;
  }
  content.innerHTML = html;
}
function closeDiffOverlay() {
  const overlay = document.getElementById('diff-overlay');
  if (overlay) overlay.classList.remove('open');
}
function applyFromDiff() {
  if (!pendingDiffChanges) return;
  const changes = pendingDiffChanges;
  const onDecision = window._diffOnDecision || null;
  window._diffOnDecision = null;
  closeDiffOverlay();
  applyFileChanges(changes).then(summary => {
    if (onDecision) onDecision({ decision: 'applied', summary });
  });
}

// ── Auto-apply new Unity asset files (v0.5.1) ────────────────────
// A change set auto-applies only when the setting is on AND every
// file is a NEW Unity-native asset file (see unity-assets.js, the
// single source of truth for the list, via preload's rb.unityAssets).
// Any code file, any edit to a file that already exists, or any
// extension outside the list makes the whole set ask first —
// auto-apply is all-or-nothing, never half a set. Existence is
// checked live on disk, not from a cache.
async function isAutoApplyAssetSet(changes) {
  if (!state.autoApplyUnityAssets || !changes || !changes.length) return false;
  const isAsset = rb.unityAssets && rb.unityAssets.isUnityAssetPath
    ? rb.unityAssets.isUnityAssetPath
    : (p) => /\.(prefab|asset|unity|mat|anim|controller|overrideController|physicMaterial|physicsMaterial2D|guiskin|flare|cubemap|renderTexture|spriteatlas|preset|scenetemplate|lighting|mixer)$/i.test(p);
  for (const c of changes) {
    if (!isAsset(c.path)) return false;
    let exists = false;
    try { exists = await rb.fs.exists(resolvePath(c.path)); } catch (e) { exists = false; }
    if (exists) return false; // already on disk — an edit, not a new file
  }
  return true;
}

// One-shot (Ask / Plan) entry point for file changes. Pure sets of
// new Unity asset files are written straight away — applyFileChanges
// snapshots first and shows the revert bar — and a chat note says
// so. Everything else gets the Apply bar exactly as before.
async function handleFileChanges(changes) {
  if (await isAutoApplyAssetSet(changes)) {
    const summary = await applyFileChanges(changes);
    addSystemMessage('Applied ' + summary.written + ' new Unity asset file'
      + (summary.written !== 1 ? 's' : '') + ' automatically ('
      + changes.map(c => c.path.split(/[\/\\]/).pop()).join(', ')
      + ') — snapshot taken, you can revert from the bar below'
      + (summary.failed ? '. ' + summary.failed + ' failed: ' + summary.errors.join('; ') : '.'));
    return;
  }
  showApplyBar(changes);
}

function showApplyBar(changes, onDecision) {
  // Remove existing bar if any
  const existing = document.getElementById('apply-bar');
  if (existing) existing.remove();
  if (!changes.length) return;
  // Auto-accept only applies on the plain (non-loop) path. When the
  // agent loop is waiting on this bar, the loop already applied
  // directly when auto-accept is on — reaching here means the user
  // must be asked.
  if (state.autoAcceptChanges && !onDecision) {
    // Auto-accept is on (Settings > Advanced): apply without waiting.
    // applyFileChanges snapshots first, and the revert bar is always
    // shown afterwards, so the user can still undo.
    applyFileChanges(changes);
    return;
  }

  const bar = document.createElement('div');
  bar.id = 'apply-bar';
  bar.style.cssText = 'position:fixed;bottom:0;left:260px;right:280px;background:var(--bg2);border-top:1px solid var(--border2);padding:10px 16px;display:flex;align-items:center;gap:12px;z-index:50;';

  const label = document.createElement('span');
  label.style.cssText = 'color:var(--teal);font-size:13px;flex:1;';
  label.textContent = `${changes.length} file${changes.length > 1 ? 's' : ''} ready to write`;

  const fileList = document.createElement('span');
  fileList.style.cssText = 'color:var(--text3);font-size:11px;font-family:var(--mono);flex:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  fileList.textContent = changes.map(c => c.path.split(/[\/]/).pop()).join(', ');

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn btn-teal';
  applyBtn.textContent = '▶ Apply changes';
  applyBtn.onclick = async () => {
    const summary = await applyFileChanges(changes);
    if (onDecision) onDecision({ decision: 'applied', summary });
  };

  const diffBtn = document.createElement('button');
  diffBtn.className = 'btn btn-secondary';
  diffBtn.textContent = 'Review diff';
  diffBtn.onclick = () => showDiffOverlay(changes, onDecision);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn btn-secondary';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.onclick = () => {
    bar.remove();
    if (onDecision) onDecision({ decision: 'declined' });
  };

  bar.appendChild(label);
  bar.appendChild(fileList);
  bar.appendChild(diffBtn);
  bar.appendChild(applyBtn);
  bar.appendChild(dismissBtn);
  document.body.appendChild(bar);
}

async function applyFileChanges(changes) {
  const bar = document.getElementById('apply-bar');
  if (bar) {
    const btn = bar.querySelector('.btn-teal');
    if (btn) btn.textContent = 'Snapshotting...';
  }

  // ── Step 1: Snapshot existing files before overwriting ──────────
  const snapshotId = 'snap_' + Date.now();
  const label = changes.map(c => c.path.split(/[\/]/).pop()).join(', ');
  const backedUp = [];

  const newFiles = [];
  for (const change of changes) {
    const fullPath = resolvePath(change.path);
    const existing = await rb.fs.readFile(fullPath);
    if (existing.ok) {
      // File exists — back it up
      await rb.db.insert('file_backups', {
        snapshot_id: snapshotId,
        file_path: fullPath,
        content: existing.content
      });
      backedUp.push(fullPath);
    } else {
      // New file — record a sentinel row so revert deletes it.
      await rb.db.insert('file_backups', {
        snapshot_id: snapshotId,
        file_path: fullPath,
        content: NEW_FILE_SENTINEL
      });
      newFiles.push(fullPath);
    }
  }

  // Record the snapshot
  await rb.db.insert('snapshots', {
    id: snapshotId,
    label: label.substring(0, 200),
    file_count: backedUp.length + newFiles.length
  });

  // ── Step 2: Write the new files ──────────────────────────────────
  if (bar) {
    const btn = bar.querySelector('.btn-teal');
    if (btn) btn.textContent = 'Writing...';
  }

  let written = 0;
  let failed = 0;
  const errors = [];

  for (const change of changes) {
    const fullPath = resolvePath(change.path);
    const result = await rb.fs.writeFile(fullPath, change.code);
    if (result.ok) { written++; }
    else { failed++; errors.push(change.path + ': ' + result.error); }
  }

  // ── Step 3: Trigger Unity refresh ───────────────────────────────
  if (written > 0) await rb.unity.refresh(state.projectPath);

  if (bar) bar.remove();

  if (failed === 0) {
    showToast(`✓ ${written} file${written > 1 ? 's' : ''} written`);
  } else {
    showToast(`⚠ ${written} written, ${failed} failed`);
    console.error('File write errors:', errors);
  }

  // ── Step 4: Show revert bar ──────────────────────────────────────
  showRevertBar(snapshotId, label, backedUp.length, newFiles.length);
  // The new snapshot should appear in the sidebar straight away,
  // so it can be reverted from there even after this bar is gone.
  refreshSidebar().catch(() => {});
  return { written, failed, errors, snapshotId, label };
}

function resolvePath(filePath) {
  // Absolute Windows path (C:\ or C:/)
  if (filePath.length > 2 && filePath[1] === ':') return filePath;
  // Absolute Unix path
  if (filePath[0] === '/') return filePath;
  // Relative — normalize forward slashes to backslashes and join
  const normalized = filePath.split('/').join('\\');
  return state.projectPath + '\\' + normalized;
}

function showRevertBar(snapshotId, label, backedUpCount, newFileCount) {
  const existing = document.getElementById('revert-bar');
  if (existing) existing.remove();

  // The revert bar stays until the user clicks Revert or Keep.
  // There is deliberately no timer here: it must NOT auto-dismiss,
  // and a later chat message must NOT replace it.
  const bar = document.createElement('div');
  bar.id = 'revert-bar';
  bar.style.cssText = 'position:fixed;bottom:0;left:260px;right:280px;background:var(--bg2);border-top:2px solid var(--amber);padding:10px 16px;display:flex;align-items:center;gap:12px;z-index:50;box-shadow:0 -2px 12px rgba(0,0,0,0.4);';

  const info = document.createElement('span');
  info.style.cssText = 'color:var(--amber);font-size:12px;flex:1;';
  info.textContent = `Changes applied — snapshot saved (${backedUpCount} modified, ${newFileCount} new). Revert restores the files as they were before this change; new files are deleted. Keep discards the snapshot, so the change can no longer be reverted.`;

  const revertBtn = document.createElement('button');
  revertBtn.className = 'btn btn-danger';
  revertBtn.textContent = '↩ Revert changes';
  revertBtn.title = 'Restore the files as they were before this change (new files are deleted)';
  revertBtn.onclick = () => confirmRevert(snapshotId, bar);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn btn-secondary';
  dismissBtn.textContent = 'Keep changes';
  dismissBtn.title = 'Keep discards the snapshot — this change can no longer be reverted';
  dismissBtn.onclick = async () => {
    bar.remove();
    await discardSnapshot(snapshotId);
  };

  bar.appendChild(info);
  bar.appendChild(revertBtn);
  bar.appendChild(dismissBtn);
  document.body.appendChild(bar);
}

// v0.5.1: "Keep changes" is a deliberate click that discards the
// snapshot — after this, the change can no longer be reverted.
// This is the ONLY place a snapshot is discarded, and it is never
// called automatically, on app close, or when a new conversation
// starts. (Before v0.5.1, Keep only hid the bar and the snapshot
// stayed in the sidebar forever; there was no auto-discard path
// then either — this just makes Keep mean what it says.)
async function discardSnapshot(snapshotId) {
  try { await rb.db.deleteSnapshot(snapshotId); }
  catch (e) { console.error('Could not discard snapshot:', e); }
  showToast('✓ Kept changes — snapshot discarded, this change can no longer be reverted');
  refreshSidebar().catch(() => {});
}

async function confirmRevert(snapshotId, bar) {
  if (bar) {
    const btn = bar.querySelector('.btn-danger');
    if (btn) { btn.textContent = 'Reverting...'; btn.disabled = true; }
  }

  // Load all backed-up files for this snapshot
  const allBackups = await rb.db.getAll('file_backups');
  const snapBackups = allBackups.filter(b => b.snapshot_id === snapshotId);

  let restored = 0;
  let failed = 0;

  for (const backup of snapBackups) {
    if (backup.content === NEW_FILE_SENTINEL) {
      // File did not exist before the apply — delete it (and its .meta).
      const result = await rb.fs.deleteFile(backup.file_path);
      if (result.ok) { restored++; await rb.fs.deleteFile(backup.file_path + '.meta'); }
      else { failed++; console.error('Revert failed for:', backup.file_path, result.error); }
      continue;
    }
    const result = await rb.fs.writeFile(backup.file_path, backup.content);
    if (result.ok) restored++;
    else { failed++; console.error('Revert failed for:', backup.file_path, result.error); }
  }

  // Trigger Unity refresh after revert
  await rb.unity.refresh(state.projectPath);

  if (bar) bar.remove();

  if (failed === 0) {
    showToast(`↩ Reverted ${restored} file${restored > 1 ? 's' : ''} — Unity refreshing`);
  } else {
    showToast(`⚠ Reverted ${restored}, ${failed} failed — check console`);
  }

  // The snapshot is spent: a reverted change cannot be reverted
  // again, so discard it (silently — the toast above already said
  // what happened) and drop its row from the sidebar.
  try { await rb.db.deleteSnapshot(snapshotId); } catch (e) {}
  refreshSidebar().catch(() => {});
}

// ── Top bar ───────────────────────────────────────────────────────
function toggleSidebar() {
  document.getElementById('app').classList.toggle('sidebar-hidden');
}
function toggleRightPanel() {
  document.getElementById('app').classList.toggle('right-hidden');
}
function toggleZen() {
  const app = document.getElementById('app');
  app.classList.toggle('sidebar-hidden');
  app.classList.toggle('right-hidden');
}

// ── Sub-modal (project settings, new project, skills, tokens) ─────
function openSubModal(html) {
  document.getElementById('sub-modal').innerHTML = html;
  document.getElementById('sub-modal-overlay').classList.add('open');
}
function closeSubModal() {
  document.getElementById('sub-modal-overlay').classList.remove('open');
  window._newProjectPath = null;
  window._projectSettingsPath = null;
}

// ── Projects ──────────────────────────────────────────────────────
function renderProjectSelector() {
  const proj = state.activeProject;
  const name = proj ? proj.name : 'My Project';
  document.getElementById('project-name-label').textContent = name;
  const initial = (name.trim()[0] || 'M').toUpperCase();
  document.getElementById('project-avatar').textContent = initial;
}

async function toggleProjectDropdown(e) {
  if (e) e.stopPropagation();
  const dd = document.getElementById('project-dropdown');
  if (!dd.classList.contains('hidden')) { dd.classList.add('hidden'); return; }
  state.projects = await rb.project.list();
  const sel = document.getElementById('project-selector');
  const r = sel.getBoundingClientRect();
  dd.style.left = r.left + 'px';
  dd.style.top = (r.bottom + 6) + 'px';
  dd.innerHTML = state.projects.map(p => `
    <div class="dd-item ${state.activeProjectId === Number(p.id) ? 'current' : ''}" onclick="switchProject(${p.id})">
      <span class="dd-avatar">${escHtml((p.name.trim()[0] || 'M').toUpperCase())}</span>
      <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(p.name)}</span>
    </div>`).join('') + `
    <div class="dd-sep"></div>
    <button class="dd-action" onclick="openProjectSettings()">⚙ Project Settings</button>
    <button class="dd-action" onclick="openNewProject()">＋ New Project</button>`;
  dd.classList.remove('hidden');
}

async function switchProject(id) {
  const dd = document.getElementById('project-dropdown');
  if (dd) dd.classList.add('hidden');
  const proj = await rb.project.switch(id);
  if (!proj) { showToast('⚠ Could not switch project'); return; }
  if (proj.bridge && !proj.bridge.ok && !proj.bridge.skipped) {
    showToast('⚠ Bridge install failed: ' + proj.bridge.error);
  }
  state.activeProjectId = Number(proj.id);
  state.activeProject = proj;
  state.projectPath = proj.path || '';
  state.projectScan = null;
  state.activeThreadId = null;
  state.activeItemId = null;
  state.activeTable = null;
  try { state.localFolders = JSON.parse(await rb.db.getSetting('local_folders') || '[]'); }
  catch { state.localFolders = []; }
  if (!Array.isArray(state.localFolders)) state.localFolders = [];
  renderProjectSelector();
  setProjectPathLabels();
  document.getElementById('file-tree').innerHTML = '';
  allFiles = [];
  await loadFileTree(state.projectPath, document.getElementById('file-tree'), 0);
  buildFileIndex(state.projectPath);
  await showHome();
  showToast('Switched to ' + proj.name);
}

function openNewProject() {
  const dd = document.getElementById('project-dropdown');
  if (dd) dd.classList.add('hidden');
  window._newProjectPath = '';
  openSubModal(`
    <h2>New Project</h2>
    <label class="field-label">Project name
      <input id="np-name" placeholder="e.g. My Unity Game" />
    </label>
    <label class="field-label">Project folder
      <div style="display:flex;gap:6px;">
        <input id="np-path" placeholder="Optional — pick a folder, or set it later" readonly style="flex:1;" />
        <button class="btn btn-secondary" onclick="pickNewProjectFolder()">Choose…</button>
      </div>
      <span class="field-note">Local project — stored on this machine.</span>
    </label>
    <div class="sub-modal-actions">
      <button class="btn btn-secondary" onclick="closeSubModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createProject()">Create project</button>
    </div>
  `);
  document.getElementById('np-name').focus();
}

async function pickNewProjectFolder() {
  const folder = await rb.fs.pickFolder();
  if (!folder) return;
  window._newProjectPath = folder;
  const input = document.getElementById('np-path');
  if (input) input.value = folder;
}

async function createProject() {
  const name = document.getElementById('np-name')?.value?.trim();
  if (!name) { showToast('Give the project a name'); return; }
  const pathVal = window._newProjectPath || '';
  const proj = await rb.project.create(name, pathVal);
  closeSubModal();
  await switchProject(proj.id);
}

function openProjectSettings() {
  const dd = document.getElementById('project-dropdown');
  if (dd) dd.classList.add('hidden');
  const proj = state.activeProject;
  if (!proj) return;
  window._projectSettingsPath = proj.path || '';
  window._confirmDeleteProject = false;
  openSubModal(`
    <h2>Project Settings</h2>
    <label class="field-label">Project name
      <input id="ps-name" value="${escHtml(proj.name)}" />
    </label>
    <label class="field-label">Project folder
      <div style="display:flex;gap:6px;">
        <input id="ps-path" value="${escHtml(proj.path || '')}" readonly style="flex:1;" />
        <button class="btn btn-secondary" onclick="pickProjectSettingsFolder()">Choose…</button>
      </div>
      <span class="field-note">Local project — stored on this machine.</span>
    </label>
    <div class="sub-modal-actions" style="justify-content:space-between;">
      <button class="btn btn-danger" id="ps-delete-btn" onclick="deleteActiveProject()">Delete project</button>
      <span style="display:flex;gap:8px;">
        <button class="btn btn-secondary" onclick="closeSubModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveProjectSettings()">Save</button>
      </span>
    </div>
  `);
}

async function pickProjectSettingsFolder() {
  const folder = await rb.fs.pickFolder();
  if (!folder) return;
  window._projectSettingsPath = folder;
  const input = document.getElementById('ps-path');
  if (input) input.value = folder;
}

async function saveProjectSettings() {
  const proj = state.activeProject;
  if (!proj) return;
  const name = document.getElementById('ps-name')?.value?.trim() || proj.name;
  const pathVal = window._projectSettingsPath != null ? window._projectSettingsPath : proj.path;
  await rb.project.update(proj.id, { name, path: pathVal });
  state.activeProject = { ...proj, name, path: pathVal };
  state.projectPath = pathVal || '';
  state.projects = await rb.project.list();
  renderProjectSelector();
  setProjectPathLabels();
  document.getElementById('file-tree').innerHTML = '';
  allFiles = [];
  await loadFileTree(state.projectPath, document.getElementById('file-tree'), 0);
  buildFileIndex(state.projectPath);
  closeSubModal();
  if (state.mode === 'home') renderHome();
  showToast('✓ Project settings saved');
}

async function deleteActiveProject() {
  const proj = state.activeProject;
  if (!proj) return;
  if (!window._confirmDeleteProject) {
    window._confirmDeleteProject = true;
    const btn = document.getElementById('ps-delete-btn');
    if (btn) btn.textContent = 'Click again to confirm — deletes its conversations and references';
    return;
  }
  const res = await rb.project.delete(proj.id);
  if (!res.ok) { showToast('⚠ ' + (res.error || 'Could not delete project')); closeSubModal(); return; }
  closeSubModal();
  state.projects = await rb.project.list();
  const next = state.projects.find(p => Number(p.id) === Number(res.activeProjectId)) || state.projects[0];
  if (next) await switchProject(next.id);
  else await showHome();
}

// ── Home view ─────────────────────────────────────────────────────
async function ensureDefaultThread() {
  const threads = await rb.db.getAll('threads');
  const pid = state.activeProjectId;
  const mine = pid == null ? threads : threads.filter(t => t.project_id == null || Number(t.project_id) === Number(pid));
  if (mine.length) {
    state.activeThreadId = Number(mine[0].id);
    return mine[0];
  }
  const id = parseInt(await rb.db.insert('threads', { name: 'General', project_id: pid }), 10);
  state.activeThreadId = id;
  return { id, name: 'General' };
}

async function showHome() {
  await ensureDefaultThread();
  setMode('home', state.activeProject ? state.activeProject.name : 'Home');
  await refreshSidebar();
}

function showConnections() {
  setMode('connections', 'Connections');
}

function showReferences() {
  setMode('references', 'References');
}

async function renderHome() {
  const proj = state.activeProject;
  const name = proj ? proj.name : 'My Project';
  const initial = (name.trim()[0] || 'M').toUpperCase();
  const heroName = document.getElementById('hero-project-name');
  if (heroName) heroName.textContent = name;
  const heroAvatar = document.getElementById('hero-avatar');
  if (heroAvatar) heroAvatar.textContent = initial;
  const chip = document.getElementById('home-context-chip');
  if (chip) chip.textContent = '# ' + name;
  updateHomeModelLabel();
  await refreshConnectionCards();
  renderSkillsGrid();
  await renderRecentReferences();
}

async function refreshConnectionCards() {
  const setStatus = (id, text, connected) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('connected', !!connected);
  };
  const unityConnected = state.projectPath ? await rb.fs.exists(state.projectPath + '/Assets') : false;
  const bridgeExists = state.projectPath ? await rb.fs.exists(state.projectPath + '/Assets/Editor/CodeFoxBridge.cs') : false;
  setStatus('conn-unity-status', bridgeExists ? 'Connected · Bridge installed' : unityConnected ? '1 Connected' : 'No connections yet', unityConnected || bridgeExists);
  const n = state.localFolders.length;
  setStatus('conn-folders-status', n ? n + ' connected' : 'No connections yet', n > 0);
}

async function renderRecentReferences() {
  const el = document.getElementById('recent-refs-list');
  if (!el) return;
  const [pages, plans] = await Promise.all([rb.db.getAll('pages'), rb.db.getAll('plans')]);
  const pid = state.activeProjectId;
  const mine = (rows) => pid == null ? rows : rows.filter(r => r.project_id == null || Number(r.project_id) === Number(pid));
  const items = [
    ...mine(pages).map(p => ({ id: p.id, name: p.name, table: 'pages', kind: 'Reference' })),
    ...mine(plans).map(p => ({ id: p.id, name: p.name, table: 'plans', kind: 'Plan' })),
  ].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 5);
  if (!items.length) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px;">No references yet — use a skill below or create one from the sidebar.</div>';
    return;
  }
  el.innerHTML = items.map(item => `
    <div class="ref-row" onclick="loadItem('${item.table}', ${item.id})">
      <span class="ref-name">${escHtml(item.name)}</span>
      <span class="ref-kind">${item.kind}</span>
    </div>`).join('');
}

function renderReferencesView() {
  const el = document.getElementById('references-mode');
  if (!el) return;
  el.innerHTML = '<h2 style="font-size:15px;font-weight:600;margin-bottom:4px;">References</h2>' +
    '<p style="color:var(--text3);font-size:12px;margin-bottom:14px;">Pages and plans for this project. Plans are labelled “Plan”, pages are “Reference”.</p>' +
    '<div id="references-view-list"><div style="color:var(--text3);font-size:12px;">Loading…</div></div>';
  Promise.all([rb.db.getAll('pages'), rb.db.getAll('plans')]).then(([pages, plans]) => {
    const pid = state.activeProjectId;
    const mine = (rows) => pid == null ? rows : rows.filter(r => r.project_id == null || Number(r.project_id) === Number(pid));
    const items = [
      ...mine(pages).map(p => ({ id: p.id, name: p.name, table: 'pages', kind: 'Reference' })),
      ...mine(plans).map(p => ({ id: p.id, name: p.name, table: 'plans', kind: 'Plan' })),
    ].sort((a, b) => Number(b.id) - Number(a.id));
    const list = document.getElementById('references-view-list');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<div style="color:var(--text3);font-size:12px;">No references yet. Create one from the sidebar, or run the /document-project skill from Home.</div>';
      return;
    }
    list.innerHTML = items.map(item => `
      <div class="ref-row" onclick="loadItem('${item.table}', ${item.id})">
        <span class="ref-name">${escHtml(item.name)}</span>
        <span class="ref-kind">${item.kind}</span>
      </div>`).join('');
  });
}

// ── Connection cards ──────────────────────────────────────────────
async function onUnityCard() {
  if (!state.projectPath) {
    const folder = await rb.fs.pickFolder();
    if (!folder) return;
    await rb.project.update(state.activeProjectId, { path: folder });
    state.activeProject = { ...state.activeProject, path: folder };
    state.projectPath = folder;
    setProjectPathLabels();
    document.getElementById('file-tree').innerHTML = '';
    allFiles = [];
    await loadFileTree(folder, document.getElementById('file-tree'), 0);
    buildFileIndex(folder);
    showToast('✓ Unity project folder set');
    await renderHome();
    return;
  }
  const connected = await rb.fs.exists(state.projectPath + '/Assets');
  if (connected) {
    await scanProject();
  } else {
    const folder = await rb.fs.pickFolder();
    if (!folder) return;
    await rb.project.update(state.activeProjectId, { path: folder });
    state.activeProject = { ...state.activeProject, path: folder };
    state.projectPath = folder;
    setProjectPathLabels();
    document.getElementById('file-tree').innerHTML = '';
    allFiles = [];
    await loadFileTree(folder, document.getElementById('file-tree'), 0);
    buildFileIndex(folder);
    showToast('✓ Unity project folder set');
  }
  await renderHome();
}

async function onLocalFoldersCard() {
  const folder = await rb.fs.pickFolder();
  if (!folder) return;
  if (!state.localFolders.includes(folder)) {
    state.localFolders.push(folder);
    await rb.db.setSetting('local_folders', JSON.stringify(state.localFolders));
  }
  showToast('✓ Folder added — ' + state.localFolders.length + ' connected. Open it as a project via New Project.');
  await renderHome();
}

// ── Skills ────────────────────────────────────────────────────────
const SKILLS = [
  { name: '/document-project', desc: 'Generate a Game Design Document for your project', action: 'documentProject' },
  { name: '/prototype-this', desc: 'Design and plan a new gameplay feature prototype', action: 'prototypeThis' },
  { name: '/convert-to-ui-toolkit', desc: 'Migrate your UGUI Canvas UI to Unity UI Toolkit', action: 'convertToUiToolkit' },
  { name: '/audit-project-structure', desc: "Audit and clean up your project's folder structure and naming", action: 'auditProjectStructure' },
  { name: '/work-with-figma', desc: 'Import Figma designs and build them in your project', action: 'figma', needsConnection: 'Figma' },
  { name: '/work-with-jira', desc: 'Pick a JIRA ticket and implement it in your project', action: 'jira', needsConnection: 'Jira' },
];

async function loadSkills() {
  try {
    const rows = await rb.skills.list();
    state.skillsInstalled = {};
    for (const r of rows) state.skillsInstalled[r.name] = !!r.installed;
  } catch { state.skillsInstalled = {}; }
}

function renderSkillsGrid() {
  const el = document.getElementById('skills-grid');
  if (!el) return;
  el.innerHTML = SKILLS.map(s => {
    const installed = !!state.skillsInstalled[s.name];
    const btn = s.needsConnection
      ? `<button class="skill-btn" onclick="runSkill('${s.name}')">Configure</button><span class="skill-note">Requires a ${s.needsConnection} connection</span>`
      : `<button class="skill-btn ${installed ? 'installed' : ''}" onclick="runSkill('${s.name}')">${installed ? 'Installed ✓' : 'Install'}</button>`;
    return `<div class="skill-card">
      <span class="skill-ico">✦</span>
      <span class="skill-name">${escHtml(s.name)}</span>
      <span class="skill-desc">${escHtml(s.desc)}</span>
      <span style="display:flex;gap:8px;align-items:center;">${btn}</span>
    </div>`;
  }).join('');
}

async function setSkillInstalled(name, installed) {
  await rb.skills.set(name, installed);
  state.skillsInstalled[name] = !!installed;
  renderSkillsGrid();
}

function openSkillsModal() {
  const rows = SKILLS.map(s => {
    const installed = !!state.skillsInstalled[s.name];
    const action = s.needsConnection
      ? `<button class="btn btn-secondary" onclick="closeSubModal(); showConnections();">Configure</button>`
      : `<button class="btn ${installed ? 'btn-danger' : 'btn-teal'}" onclick="toggleSkillFromModal('${s.name}', ${installed ? 'false' : 'true'})">${installed ? 'Uninstall' : 'Install'}</button>`;
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
      <span style="color:var(--teal);">✦</span>
      <span style="flex:1;min-width:0;"><span style="font-family:var(--mono);font-weight:700;">${escHtml(s.name)}</span><br>
      <span style="color:var(--text2);font-size:12px;">${escHtml(s.desc)}${s.needsConnection ? ' — requires a ' + s.needsConnection + ' connection.' : ''}</span></span>
      ${action}
    </div>`;
  }).join('');
  openSubModal(`
    <h2>Manage Skills</h2>
    <div style="max-height:60vh;overflow-y:auto;padding-right:4px;">${rows}</div>
    <div class="sub-modal-actions">
      <button class="btn btn-secondary" onclick="closeSubModal()">Close</button>
    </div>
  `);
}

async function toggleSkillFromModal(name, installed) {
  await setSkillInstalled(name, installed);
  openSkillsModal();
}

async function runSkill(name) {
  const skill = SKILLS.find(s => s.name === name);
  if (!skill) return;
  if (skill.needsConnection) { showConnections(); return; }
  if (skill.action === 'documentProject') return skillDocumentProject();
  if (skill.action === 'prototypeThis') return skillPrototypeThis();
  if (skill.action === 'convertToUiToolkit') return skillConvertToUiToolkit();
  if (skill.action === 'auditProjectStructure') return skillAuditProjectStructure();
}

async function startSkillChat(threadName, prompt, mode) {
  if (mode) setChatMode(mode);
  const id = parseInt(await rb.db.insert('threads', { name: threadName, project_id: state.activeProjectId }), 10);
  await loadThread(id);
  await refreshSidebar();
  const input = document.getElementById('chat-input');
  if (input) input.value = prompt;
  await sendChat();
}

async function skillDocumentProject() {
  await setSkillInstalled('/document-project', true);
  const scan = await rb.project.scan(state.projectPath);
  if (scan.ok) state.projectScan = scan;
  const pageId = await rb.db.insert('pages', {
    name: 'Game Design Document',
    content: 'Game Design Document — draft in progress. See the "Game Design Document" conversation for the model draft.',
    project_id: state.activeProjectId,
  });
  await refreshSidebar();
  window._gddPageId = Number(pageId);
  window._saveGddAsReference = true;
  const summary = projectScanSummary();
  await startSkillChat('Game Design Document',
    'Draft a Game Design Document for this project' + (summary ? ' using the project scan below' : '') + '.\n\n' +
    (summary ? 'Project scan:\n' + summary + '\n\n' : '') +
    'Structure it as: Overview, Pillars, Core loop, Systems, Progression, Art and audio direction, Scope and milestones. ' +
    'Base everything on the scan — do not invent features, files, or assets that are not in the project.',
    'agent');
}

async function skillPrototypeThis() {
  await setSkillInstalled('/prototype-this', true);
  const template = `# Prototype: New gameplay feature

## Goal
(One sentence: what should the player feel or do?)

## Files to touch
FILE: Assets/Scripts/

## Steps
1. Describe the first step
2. Describe the next step
3. How to test it in the editor
`;
  const id = await rb.db.insert('plans', { name: 'Prototype: New gameplay feature', content: template, project_id: state.activeProjectId });
  await refreshSidebar();
  await loadItem('plans', id);
  editPlan();
  showToast('Prototype plan created — fill in the goal and steps, then save');
}

async function skillConvertToUiToolkit() {
  await setSkillInstalled('/convert-to-ui-toolkit', true);
  const file = state.activeFilePath ? state.activeFilePath.split(/[\\/]/).pop() : null;
  const summary = projectScanSummary();
  await startSkillChat('Convert to UI Toolkit',
    'Plan the migration of this project\'s UGUI Canvas UI to Unity UI Toolkit.' +
    (file ? ' Start with the file currently open in the viewer: ' + file + '.' : ' Start with the UI scripts found in the project scan.') +
    (summary ? '\n\nProject scan:\n' + summary : '') +
    '\n\nOutput: 1) which UGUI components map to which UI Toolkit elements, 2) a step-by-step migration plan with FILE: lines, 3) the converted code for the first screen, one file per fenced block with **File Path:**. Do not invent UI files that are not in the scan.',
    'agent');
}

async function skillAuditProjectStructure() {
  await setSkillInstalled('/audit-project-structure', true);
  showToast('Scanning project…');
  const scan = await rb.project.scan(state.projectPath);
  if (!scan.ok) { showToast('⚠ ' + scan.error); return; }
  state.projectScan = scan;
  window._saveAuditAsReference = true;
  await startSkillChat('Project structure audit',
    'Audit this project\'s folder structure and naming using the scan below. Report: 1) folders that break the project\'s own conventions, 2) misnamed or misplaced scripts and assets, 3) empty or dead folders, 4) a concrete cleanup list with exact moves (old path → new path). Do not invent files that are not in the scan.\n\nProject scan:\n' + projectScanSummary(),
    'agent');
}

// ── Connections view ──────────────────────────────────────────────
async function renderConnectionsView() {
  const el = document.getElementById('connections-mode');
  if (!el) return;
  el.innerHTML = `
    <h2 style="font-size:15px;font-weight:600;margin-bottom:4px;">Connections</h2>
    <p style="color:var(--text3);font-size:12px;margin-bottom:16px;">Local integrations for this project. Nothing here phones home — tokens are stored locally on this machine.</p>
    <div id="connections-list"><div style="color:var(--text3);font-size:12px;">Checking statuses…</div></div>`;
  const list = document.getElementById('connections-list');
  if (!list) return;

  const [llmStatus, ollamaStatus, comfyuiStatus, bridgeExists, figmaToken, jiraToken, jiraUrl, pkgInfo] = await Promise.all([
    rb.llm.status().catch(() => ({ running: false })),
    rb.ollama.status().catch(() => ({ running: false })),
    rb.comfyui.status().catch(() => ({ ok: false, error: 'Could not reach ComfyUI' })),
    state.projectPath ? rb.fs.exists(state.projectPath + '/Assets/Editor/CodeFoxBridge.cs') : Promise.resolve(false),
    rb.db.getSetting('figma_token'),
    rb.db.getSetting('jira_token'),
    rb.db.getSetting('jira_url'),
    rb.unity.listPackages(state.projectPath).catch(() => null),
  ]);
  const lmRunning = llmStatus.provider !== 'ollama' && llmStatus.running;
  const rows = [
    {
      ico: '⬢', name: 'LM Studio',
      status: lmRunning ? 'Connected — ' + (llmStatus.modelsAvailable ?? 0) + ' model(s) available' : 'Not reachable at ' + (llmStatus.url || state.lmstudioUrl),
      connected: lmRunning,
      action: '<button class="btn btn-secondary" onclick="showSettings(\'model\')">Configure</button>',
    },
    {
      ico: '◉', name: 'Ollama',
      status: ollamaStatus.running ? 'Running' : 'Not running',
      connected: !!ollamaStatus.running,
      action: '<button class="btn btn-secondary" onclick="showSettings(\'model\')">Configure</button>',
    },
    {
      ico: '◈', name: 'ComfyUI',
      status: comfyuiStatus.ok ? 'Connected — ComfyUI at ' + (state.comfyuiUrl || 'http://127.0.0.1:8188') : 'Not running — ' + (comfyuiStatus.error || 'could not reach ComfyUI'),
      connected: !!comfyuiStatus.ok,
      action: '<button class="btn btn-secondary" onclick="showComfyUI()">Open ComfyUI panel</button>',
    },
    {
      ico: '⬡', name: 'Unity Bridge',
      status: bridgeExists ? 'Installed in Assets/Editor/CodeFoxBridge.cs' : 'Not installed in this project',
      connected: bridgeExists,
      action: bridgeExists
        ? '<button class="btn btn-secondary" disabled>Installed ✓</button>'
        : '<button class="btn btn-teal" onclick="installUnityBridge()">Install bridge</button>',
    },
    {
      ico: '◆', name: 'Figma',
      status: figmaToken ? 'Token saved locally' : 'Not connected — needs a token',
      connected: !!figmaToken,
      action: '<button class="btn btn-secondary" onclick="openFigmaModal()">Configure</button>',
    },
    {
      ico: '▤', name: 'Jira',
      status: jiraToken ? 'Token saved locally' + (jiraUrl ? ' — ' + jiraUrl : '') : 'Not connected — needs a token and site URL',
      connected: !!jiraToken,
      action: '<button class="btn btn-secondary" onclick="openJiraModal()">Configure</button>',
    },
    {
      ico: '⌘', name: 'GitHub',
      status: 'Managed in Muse, not in CodeFox',
      connected: false,
      action: '',
    },
  ];
  list.innerHTML = rows.map(r => `
    <div class="conn-row">
      <span class="conn-ico">${r.ico}</span>
      <span class="conn-row-info"><span class="conn-name">${escHtml(r.name)}</span><br>
      <span class="conn-status ${r.connected ? 'connected' : ''}">${escHtml(r.status)}</span></span>
      ${r.action}
    </div>`).join('') + unityPackagesSectionHtml(pkgInfo);
}

async function installUnityBridge() {
  showToast('Installing Unity bridge…');
  const res = await rb.unity.installBridge(state.projectPath);
  if (res.ok) {
    showToast('✓ Bridge installed in Assets/Editor/CodeFoxBridge.cs');
    renderConnectionsView();
  } else {
    showToast('⚠ ' + res.error);
  }
}

function openFigmaModal() {
  openSubModal(`
    <h2>Figma connection</h2>
    <label class="field-label">Personal access token
      <input id="figma-token" type="password" placeholder="Paste a Figma personal access token" />
      <span class="field-note">Stored locally, used only for Figma imports. CodeFox does not have a Figma import yet — this saves the token so the import can use it when it lands.</span>
    </label>
    <div class="sub-modal-actions">
      <button class="btn btn-secondary" onclick="closeSubModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveFigmaToken()">Save token</button>
    </div>
  `);
}

async function saveFigmaToken() {
  const token = document.getElementById('figma-token')?.value?.trim() || '';
  await rb.db.setSetting('figma_token', token);
  closeSubModal();
  showToast(token ? '✓ Figma token saved locally' : 'Figma token cleared');
  if (state.mode === 'connections') renderConnectionsView();
}

function openJiraModal() {
  openSubModal(`
    <h2>Jira connection</h2>
    <label class="field-label">Jira site URL
      <input id="jira-url" placeholder="https://your-team.atlassian.net" />
    </label>
    <label class="field-label">API token
      <input id="jira-token" type="password" placeholder="Paste a Jira API token" />
      <span class="field-note">Stored locally, used only for Jira ticket imports. CodeFox does not have a Jira import yet — this saves the token and URL so the import can use them when it lands.</span>
    </label>
    <div class="sub-modal-actions">
      <button class="btn btn-secondary" onclick="closeSubModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveJiraToken()">Save</button>
    </div>
  `);
}

async function saveJiraToken() {
  const token = document.getElementById('jira-token')?.value?.trim() || '';
  const url = document.getElementById('jira-url')?.value?.trim() || '';
  await rb.db.setSetting('jira_token', token);
  await rb.db.setSetting('jira_url', url);
  closeSubModal();
  showToast(token ? '✓ Jira credentials saved locally' : 'Jira credentials cleared');
  if (state.mode === 'connections') renderConnectionsView();
}

// ── Home build panel ──────────────────────────────────────────────
function setHomePrompt(kind) {
  const composer = document.getElementById('home-composer');
  if (!composer) return;
  if (kind === 'debug') {
    setChatMode('agent');
    composer.value = 'Debug this issue: ';
  } else if (kind === 'tool') {
    setChatMode('agent');
    composer.value = 'Build an editor tool that ';
  } else {
    setChatMode('agent');
    composer.value = 'Write a script that ';
  }
  composer.focus();
  autoResize(composer);
}

function homeComposerKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendHomeComposer(); }
}

function mentionActiveFile() {
  const composer = document.getElementById('home-composer');
  if (!composer) return;
  if (!state.activeFilePath) { showToast('Open a file in the viewer first to mention it'); return; }
  const name = state.activeFilePath.split(/[\\/]/).pop();
  state.homeMentionFile = state.activeFilePath;
  composer.value += '@' + name + ' ';
  composer.focus();
  autoResize(composer);
}

async function sendHomeComposer() {
  const composer = document.getElementById('home-composer');
  if (!composer) return;
  const text = composer.value.trim();
  if (!text) return;
  composer.value = '';
  autoResize(composer);
  await sendHomePrompt(text);
}

async function sendHomePrompt(text) {
  // Expand an @-mention of the open file into its contents.
  let finalText = text;
  if (state.homeMentionFile) {
    const name = state.homeMentionFile.split(/[\\/]/).pop();
    if (text.includes('@' + name)) {
      const result = await rb.fs.readFile(state.homeMentionFile);
      if (result.ok) {
        finalText = text.replace('@' + name, 'the file ' + name + ':\n```\n' + result.content + '\n```');
      }
    }
    state.homeMentionFile = null;
  }
  const name = finalText.slice(0, 40).trim() + (finalText.length > 40 ? '…' : '');
  const id = parseInt(await rb.db.insert('threads', { name: name || 'New conversation', project_id: state.activeProjectId }), 10);
  await loadThread(id);
  await refreshSidebar();
  const input = document.getElementById('chat-input');
  if (input) input.value = finalText;
  await sendChat();
}

// ── Start ─────────────────────────────────────────────────────────
init();
