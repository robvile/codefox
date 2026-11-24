// ── State ────────────────────────────────────────────────────────
let state = {
  mode: 'chat',          // 'chat' | 'ruleset' | 'plan' | 'page'
  activeThreadId: null,
  activeItemId: null,
  activeTable: null,
  activeFilePath: null,
  projectPath: '',
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
};

// ── LLM management (LM Studio default, Ollama supported) ─────────
function setLlmStatus(dotClass, label) {
  const dot = document.getElementById('ollama-dot');
  const lbl = document.getElementById('ollama-label');
  if (!dot || !lbl) return;
  dot.className = '';
  if (dotClass) dot.classList.add(dotClass);
  lbl.textContent = label;
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
  if (!sel) return;
  const current = state.lmstudioModel;
  sel.innerHTML = '<option value="">— Select a model —</option>' +
    state.lmstudioModels.map(m => `<option value="${escHtml(m.id)}" ${m.id === current ? 'selected' : ''}>${escHtml(m.id)}</option>`).join('');
  if (current && !state.lmstudioModels.some(m => m.id === current)) {
    sel.innerHTML += `<option value="${escHtml(current)}" selected>${escHtml(current)} (not loaded)</option>`;
  }
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
async function init() {
  state.projectPath = await rb.db.getSetting('project_path') || state.projectPath;
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
  if (state.ollamaExePath) await rb.ollama.setPath(state.ollamaExePath);
  document.getElementById('project-path-label').textContent = state.projectPath || 'No project set';
  document.getElementById('file-path-label').textContent = state.projectPath || 'No project set';

  // Check the LLM backend in parallel — don't block UI
  initLLM();
  updateModeButtons();

  await refreshSidebar();
  await loadFileTree(state.projectPath, document.getElementById('file-tree'), 0);
  // Build flat index in background for search
  buildFileIndex(state.projectPath).then(() => {
    console.log(`File index built: ${allFiles.length} files`);
  });

  // Load or create default thread
  const threads = await rb.db.getAll('threads');
  if (threads.length) {
    await loadThread(threads[0].id);
  } else {
    const id = await rb.db.insert('threads', { name: 'General' });
    await refreshSidebar();
    await loadThread(id);
  }
}

// ── Sidebar ──────────────────────────────────────────────────────
async function refreshSidebar() {
  const [rulesets, plans, pages, threads] = await Promise.all([
    rb.db.getAll('rulesets'),
    rb.db.getAll('plans'),
    rb.db.getAll('pages'),
    rb.db.getAll('threads'),
  ]);
  renderList('ruleset-list', rulesets, 'rulesets');
  renderList('plans-list', plans, 'plans');
  renderList('pages-list', pages, 'pages');
  renderThreadList(threads);
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
  el.innerHTML = items.map(item => `
    <div class="sidebar-link ${state.activeTable === table && state.activeItemId === item.id ? 'active' : ''}"
         onclick="loadItem('${table}', ${item.id})">
      <span class="sidebar-link-name">${escHtml(item.name)}</span>
      <span class="sidebar-link-del" onclick="event.stopPropagation(); deleteItem('${table}', ${item.id})">✕</span>
    </div>
  `).join('');
}

function renderThreadList(threads) {
  const el = document.getElementById('threads-list');
  el.innerHTML = threads.map(t => `
    <div class="sidebar-link ${state.activeThreadId === t.id && state.mode === 'chat' ? 'active' : ''}"
         onclick="loadThread(${t.id})">
      <span class="sidebar-link-name">${escHtml(t.name)}</span>
      <span class="sidebar-link-del" onclick="event.stopPropagation(); deleteThread(${t.id})">✕</span>
    </div>
  `).join('');
}

// ── Mode switching ────────────────────────────────────────────────
function setMode(mode, title, badgeClass) {
  state.mode = mode;
  document.getElementById('center-mode-badge').textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
  document.getElementById('center-mode-badge').className = 'badge-' + (mode === 'chat' ? 'chat' : mode === 'plan' ? 'plan' : mode === 'page' ? 'page' : 'ruleset');
  document.getElementById('center-title').textContent = title;

  document.getElementById('chat-mode').classList.toggle('hidden', mode !== 'chat');
  document.getElementById('editor-mode').classList.toggle('hidden', mode !== 'ruleset' && mode !== 'page');
  document.getElementById('plan-mode').classList.toggle('hidden', mode !== 'plan');
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

  // Show thinking
  const msgsEl = document.getElementById('chat-messages');
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking';
  thinkingEl.innerHTML = '<span></span><span></span><span></span>';
  msgsEl.appendChild(thinkingEl);
  msgsEl.scrollTop = msgsEl.scrollHeight;

  // Build system prompt — use override if set by executePlan
  let systemPrompt;
  if (window._execPlanActive && window._execPlanSystemPrompt) {
    systemPrompt = window._execPlanSystemPrompt;
    window._execPlanActive = false;
    window._execPlanSystemPrompt = null;
  } else {
    const rulesets = await rb.db.getAll('rulesets');
    systemPrompt = buildSystemPrompt(rulesets);
  }

  // Stream response
  state.streaming = true;
  let assistantContent = '';
  const assistantMsgEl = document.createElement('div');
  assistantMsgEl.className = 'msg msg-assistant';
  msgsEl.appendChild(assistantMsgEl);

  rb.llm.removeListeners();
  rb.llm.onChunk(chunk => {
    thinkingEl.remove();
    assistantContent += chunk;
    assistantMsgEl.textContent = assistantContent;
    msgsEl.scrollTop = msgsEl.scrollHeight;
  });
  // Capture thread ID now — state may change if user navigates away
  const currentThreadId = state.activeThreadId;

  rb.llm.onDone(async () => {
    state.streaming = false;
    await rb.db.insert('messages', { thread_id: currentThreadId, role: 'assistant', content: assistantContent });
    if (state.activeThreadId === currentThreadId) {
      state.messages.push({ role: 'assistant', content: assistantContent });
    }
    rb.llm.removeListeners();
    // Parse response for file changes and show apply bar if any found
    const changes = extractFileChanges(assistantContent);
    if (changes.length) showApplyBar(changes);
  });

  try {
    await rb.llm.chat({
      messages: state.messages.map(m => ({ role: m.role, content: m.content })),
      systemPrompt,
      provider: state.provider,
      model: currentModel(),
      lmstudioUrl: state.lmstudioUrl,
      lmstudioApiKey: state.lmstudioApiKey,
      ollamaUrl: state.ollamaUrl,
      temperature: state.temperature,
      maxTokens: state.maxTokens,
    });
  } catch (e) {
    thinkingEl.remove();
    assistantMsgEl.textContent = '⚠ Could not reach ' + providerLabel() + ' at ' + currentUrl() + '. ' + (e.message || '') + (currentModel() ? '' : ' No model is selected — open Settings, verify the connection, and pick a model.');
    state.streaming = false;
  }
}

function buildSystemPrompt(rulesets) {
  const ctx = state.projectContext || 'a software project';
  let prompt = 'You are an expert software developer working on ' + ctx + '.\n';
  prompt += 'You run locally on the user\'s machine, on a local model with a smaller context window than cloud models. Keep answers focused, work one step at a time, and never invent files, APIs, or asset paths that are not in the project context below. If you do not know something, say so instead of guessing.\n';
  prompt += 'Always write code that fits the existing patterns and architecture. Be specific about file paths and complete implementations.\n\n';
  const scan = projectScanSummary();
  if (scan) prompt += '## Project context (from a scan of the project folder)\n\n' + scan + '\n\n';
  if (rulesets.length) {
    prompt += '## Project Rules\n\n';
    rulesets.forEach(r => { prompt += '### ' + r.name + '\n' + r.content + '\n\n'; });
  }
  if (state.chatMode === 'ask') {
    prompt += '## Mode: Ask\nAnswer and explain only. Do not propose file writes, do not output code blocks meant to be applied, and do not change any files.\n';
  } else if (state.chatMode === 'plan') {
    prompt += '## Mode: Plan\nOutput a plan only: FILE: lines for every file to touch, then numbered steps. Do not write code yet.\n';
  } else {
    prompt += '## Mode: Agent\nWork step by step. Output complete code in fenced code blocks, each preceded by **File Path:** `path`, one file per block. No placeholders, no TODOs, no truncated code. If a step is too large for one reply, do the first step only and say what remains.\n';
  }
  return prompt;
}

// ── Chat modes + tools ──────────────────────────────────────────────
function setChatMode(mode) {
  state.chatMode = mode;
  rb.db.setSetting('chat_mode', mode);
  updateModeButtons();
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
  if (pkgs.length) parts.push('Packages: ' + pkgs.slice(0, 30).join(', '));
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
  setChatMode('ask');
  insertPrompt(`I pasted a Unity console error / log below. Diagnose it:
1. What the error means, in plain language
2. The most likely file(s) and line(s) causing it
3. The smallest fix to try first

\`\`\`
PASTE THE ERROR OR LOG HERE
\`\`\`
`);
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
  const rawThreadId = await rb.db.insert('threads', { name: 'Execute: ' + item.name });
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
  const threadId = await rb.db.insert('threads', { name: `Discuss: ${item.name}` });
  await refreshSidebar();
  await loadThread(threadId);
  document.getElementById('chat-input').value = `Here is the architecture page for "${item.name}":\n\n${item.content}\n\nLet's discuss this.`;
  await sendChat();
}

// ── File search ───────────────────────────────────────────────────
let allFiles = []; // flat list of all file paths, built on load

async function buildFileIndex(dirPath) {
  const items = await rb.fs.readDir(dirPath);
  for (const item of items) {
    if (item.isDir) {
      await buildFileIndex(item.path);
    } else {
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

  const matches = allFiles.filter(f => f.name.toLowerCase().includes(q)).slice(0, 50);

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
  document.getElementById('project-path-label').textContent = folder;
  document.getElementById('file-path-label').textContent = folder;
  document.getElementById('file-tree').innerHTML = '';
  await loadFileTree(folder, document.getElementById('file-tree'), 0);
}

// ── New item modal ────────────────────────────────────────────────
let modalCallback = null;
function newItem(table) {
  const titles = { rulesets: 'New ruleset', plans: 'New plan', pages: 'New page' };
  document.getElementById('modal-title').textContent = titles[table] || 'New item';
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('modal-name').focus();
  modalCallback = async () => {
    const name = document.getElementById('modal-name').value.trim();
    if (!name) return;
    const id = await rb.db.insert(table, { name, content: '' });
    await refreshSidebar();
    await loadItem(table, id);
    closeModal();
  };
}

async function newThread() {
  document.getElementById('modal-title').textContent = 'New thread';
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('modal-name').focus();
  modalCallback = async () => {
    const name = document.getElementById('modal-name').value.trim();
    if (!name) return;
    const id = parseInt(await rb.db.insert('threads', { name }), 10);
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
    setMode('chat', 'New thread');
    state.activeItemId = null;
    state.activeTable = null;
  }
  await refreshSidebar();
}

async function deleteThread(id) {
  await rb.db.delete('threads', id);
  const threads = await rb.db.getAll('threads');
  if (threads.length) {
    await loadThread(parseInt(threads[0].id, 10));
  } else {
    const newId = parseInt(await rb.db.insert('threads', { name: 'General' }), 10);
    await loadThread(newId);
    await refreshSidebar();
  }
}

async function renameThread() {
  document.getElementById('modal-title').textContent = 'Rename thread';
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

// ── Settings ──────────────────────────────────────────────────────
function openSettings() {
  const overlay = document.getElementById('modal-overlay');
  const modal = document.getElementById('modal');
  const isLm = state.provider === 'lmstudio';
  const inp = (id, val, ph) => `<input id="${id}" value="${escHtml(val || '')}" placeholder="${ph || ''}" style="margin-top:4px;display:block;width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px;font-family:var(--font);outline:none;" />`;

  modal.innerHTML = `
    <h2>Settings</h2>
    <div style="display:flex;flex-direction:column;gap:14px;max-height:70vh;overflow-y:auto;padding-right:4px;">
      <label style="color:var(--text2);font-size:12px;">LLM provider
        <select id="s-provider" onchange="onProviderChange()" style="margin-top:4px;display:block;width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px;font-family:var(--font);outline:none;">
          <option value="lmstudio" ${isLm ? 'selected' : ''}>LM Studio (default)</option>
          <option value="ollama" ${!isLm ? 'selected' : ''}>Ollama</option>
        </select>
      </label>

      <div id="s-lm-section" style="display:${isLm ? 'flex' : 'none'};flex-direction:column;gap:12px;">
        <label style="color:var(--text2);font-size:12px;">LM Studio server URL
          ${inp('s-lm-url', state.lmstudioUrl, 'http://localhost:1234/v1')}
          <span style="color:var(--text3);font-size:11px;">Default: http://localhost:1234/v1 — start the local server in LM Studio first. A trailing /chat/completions is stripped automatically.</span>
        </label>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn-secondary" onclick="verifyLmStudio()">Verify connection</button>
          <button class="btn btn-secondary" onclick="refreshModels().then(r => { const el = document.getElementById('s-lm-status'); if (el && r.ok) { el.style.color = 'var(--green)'; el.textContent = '✓ ' + r.models.length + ' model(s) found.'; } })">Refresh models</button>
        </div>
        <div id="s-lm-status" style="font-size:12px;color:var(--text3);">Not verified yet — click Verify connection.</div>
        <label style="color:var(--text2);font-size:12px;">Model (from the live server list)
          <select id="s-lm-model" style="margin-top:4px;display:block;width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px;font-family:var(--font);outline:none;">
            <option value="">— Select a model —</option>
          </select>
        </label>
        <label style="color:var(--text2);font-size:12px;">API key (optional — LM Studio needs none by default)
          <input id="s-lm-key" type="password" value="${escHtml(state.lmstudioApiKey || '')}" placeholder="Leave blank unless your server requires one"
            style="margin-top:4px;display:block;width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px;font-family:var(--font);outline:none;" />
        </label>
      </div>

      <div id="s-ollama-section" style="display:${!isLm ? 'flex' : 'none'};flex-direction:column;gap:12px;">
        <label style="color:var(--text2);font-size:12px;">Ollama URL
          ${inp('s-url', state.ollamaUrl)}
        </label>
        <label style="color:var(--text2);font-size:12px;">Ollama model name
          ${inp('s-model', state.ollamaModel)}
        </label>
        <label style="color:var(--text2);font-size:12px;">
          Ollama executable path
          <span style="color:var(--text3);font-size:11px;margin-left:6px;">leave blank to auto-detect</span>
          <div style="display:flex;gap:6px;margin-top:4px;">
            <input id="s-exe" value="${escHtml(state.ollamaExePath || '')}" placeholder="C:\\...\\ollama.exe"
              style="flex:1;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px;font-family:var(--font);outline:none;" />
            <button class="btn btn-secondary" onclick="browseOllamaExe()" style="flex-shrink:0;">Browse</button>
          </div>
          <div id="s-exe-detected" style="margin-top:4px;font-size:11px;color:var(--text3);"></div>
        </label>
      </div>

      <label style="color:var(--text2);font-size:12px;">Temperature (0 = focused, 1 = creative)
        ${inp('s-temp', String(state.temperature), '0.2')}
      </label>
      <label style="color:var(--text2);font-size:12px;">Max tokens per reply
        ${inp('s-maxtokens', String(state.maxTokens), '4096')}
      </label>
      <label style="color:var(--text2);font-size:12px;">Project path
        ${inp('s-path', state.projectPath)}
      </label>
      <label style="color:var(--text2);font-size:12px;">Project context
        <input id="s-ctx" value="${escHtml(state.projectContext || '')}" placeholder="e.g. a Unity 6 card game"
          style="margin-top:4px;display:block;width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px;font-family:var(--font);outline:none;" />
      </label>
      <label style="color:var(--text2);font-size:12px;">
        Unity Editor executable path
        <span style="color:var(--text3);font-size:11px;margin-left:6px;">needed for Run tests</span>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <input id="s-unity-exe" value="${escHtml(state.unityExePath || '')}" placeholder="C:\\Program Files\\Unity\\Hub\\Editor\\...\\Unity.exe"
            style="flex:1;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px;font-family:var(--font);outline:none;" />
          <button class="btn btn-secondary" onclick="browseUnityExe()" style="flex-shrink:0;">Browse</button>
        </div>
      </label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button class="btn btn-secondary" onclick="closeSettings()">Cancel</button>
      <button class="btn btn-primary" onclick="saveSettings()">Save</button>
    </div>
  `;
  overlay.classList.add('open');
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

function closeSettings() {
  // Restore the generic modal content so newItem/newThread still work.
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('modal').innerHTML = `
    <h2 id="modal-title">New item</h2>
    <input id="modal-name" placeholder="Name..." />
    <div id="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="confirmModal()">Create</button>
    </div>
  `;
  document.getElementById('modal-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmModal();
    if (e.key === 'Escape') closeModal();
  });
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
  if (pathVal) { state.projectPath = pathVal; await rb.db.setSetting('project_path', pathVal); }
  const ctx = document.getElementById('s-ctx')?.value?.trim();
  if (ctx !== undefined) { state.projectContext = ctx; await rb.db.setSetting('project_context', ctx); }
  const unityExe = document.getElementById('s-unity-exe')?.value?.trim() || '';
  state.unityExePath = unityExe;
  await rb.db.setSetting('unity_exe_path', unityExe);
  closeSettings();
  // Re-init the LLM connection without losing the thread (no reload).
  document.getElementById('project-path-label').textContent = state.projectPath || 'No project set';
  document.getElementById('file-path-label').textContent = state.projectPath || 'No project set';
  await initLLM();
  showToast('✓ Settings saved');
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
    // Any fenced code block (```csharp, ```json, ```, …)
    if (line.match(/^```\s*\S*\s*$/)) {
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
async function showDiffOverlay(changes) {
  pendingDiffChanges = changes;
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
  closeDiffOverlay();
  applyFileChanges(pendingDiffChanges);
}

function showApplyBar(changes) {
  // Remove existing bar if any
  const existing = document.getElementById('apply-bar');
  if (existing) existing.remove();
  if (!changes.length) return;

  const bar = document.createElement('div');
  bar.id = 'apply-bar';
  bar.style.cssText = 'position:fixed;bottom:0;left:220px;right:280px;background:var(--bg2);border-top:1px solid var(--border2);padding:10px 16px;display:flex;align-items:center;gap:12px;z-index:50;';

  const label = document.createElement('span');
  label.style.cssText = 'color:var(--teal);font-size:13px;flex:1;';
  label.textContent = `${changes.length} file${changes.length > 1 ? 's' : ''} ready to write`;

  const fileList = document.createElement('span');
  fileList.style.cssText = 'color:var(--text3);font-size:11px;font-family:var(--mono);flex:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  fileList.textContent = changes.map(c => c.path.split(/[\/]/).pop()).join(', ');

  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn btn-teal';
  applyBtn.textContent = '▶ Apply changes';
  applyBtn.onclick = () => applyFileChanges(changes);

  const diffBtn = document.createElement('button');
  diffBtn.className = 'btn btn-secondary';
  diffBtn.textContent = 'Review diff';
  diffBtn.onclick = () => showDiffOverlay(changes);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn btn-secondary';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.onclick = () => bar.remove();

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

  const bar = document.createElement('div');
  bar.id = 'revert-bar';
  bar.style.cssText = 'position:fixed;bottom:0;left:220px;right:280px;background:var(--bg2);border-top:2px solid var(--amber);padding:10px 16px;display:flex;align-items:center;gap:12px;z-index:50;box-shadow:0 -2px 12px rgba(0,0,0,0.4);';

  const info = document.createElement('span');
  info.style.cssText = 'color:var(--amber);font-size:12px;flex:1;';
  info.textContent = `Snapshot saved (${backedUpCount} modified, ${newFileCount} new) — revert if Unity errors appear`;

  const revertBtn = document.createElement('button');
  revertBtn.className = 'btn btn-danger';
  revertBtn.textContent = '↩ Revert changes';
  revertBtn.onclick = () => confirmRevert(snapshotId, bar);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn btn-secondary';
  dismissBtn.textContent = 'Keep changes';
  dismissBtn.onclick = () => bar.remove();

  bar.appendChild(info);
  bar.appendChild(revertBtn);
  bar.appendChild(dismissBtn);
  document.body.appendChild(bar);
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
}

// ── Start ─────────────────────────────────────────────────────────
init();
