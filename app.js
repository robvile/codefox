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
};

// ── Ollama management ────────────────────────────────────────────
function setOllamaStatus(status, label) {
  const dot = document.getElementById('ollama-dot');
  const lbl = document.getElementById('ollama-label');
  if (!dot || !lbl) return;
  dot.className = '';
  if (status === 'running') {
    dot.classList.add('green');
    lbl.textContent = 'Ollama';
  } else if (status === 'starting') {
    dot.classList.add('yellow');
    lbl.textContent = 'Starting...';
  } else if (status === 'not_found') {
    dot.classList.add('red');
    lbl.textContent = 'Not installed';
  } else {
    dot.classList.add('red');
    lbl.textContent = 'Offline';
  }
}

async function initOllama() {
  setOllamaStatus('starting', 'Checking...');
  const status = await rb.ollama.status();
  if (status.running) {
    setOllamaStatus('running');
    return;
  }
  if (!status.exePath) {
    setOllamaStatus('not_found');
    showToast('⚠ Ollama not found. Install from ollama.com');
    return;
  }
  // Not running but found — launch it
  setOllamaStatus('starting', 'Starting...');
  const result = await rb.ollama.launch();
  if (result.status === 'running' || result.status === 'launched') {
    setOllamaStatus('running');
    showToast('✓ Ollama started');
  } else if (result.status === 'timeout') {
    setOllamaStatus('red', 'Timeout');
    showToast('⚠ Ollama is taking a while to start...');
    // Keep polling
    pollOllamaStatus();
  } else {
    setOllamaStatus('red', 'Error');
    showToast('⚠ Could not start Ollama: ' + (result.error || result.status));
  }
}

let ollamaPoller = null;
function pollOllamaStatus() {
  if (ollamaPoller) return;
  ollamaPoller = setInterval(async () => {
    const status = await rb.ollama.status();
    if (status.running) {
      setOllamaStatus('running');
      clearInterval(ollamaPoller);
      ollamaPoller = null;
    }
  }, 3000);
}

async function retryOllama() {
  const dot = document.getElementById('ollama-dot');
  if (dot && dot.classList.contains('green')) return; // already running
  await initOllama();
}

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  state.projectPath = await rb.db.getSetting('project_path') || state.projectPath;
  state.ollamaModel = await rb.db.getSetting('ollama_model') || state.ollamaModel;
  state.ollamaUrl   = await rb.db.getSetting('ollama_url')   || state.ollamaUrl;
  state.ollamaExePath = await rb.db.getSetting('ollama_exe_path') || '';
  state.projectContext = await rb.db.getSetting('project_context') || '';
  if (state.ollamaExePath) await rb.ollama.setPath(state.ollamaExePath);
  document.getElementById('project-path-label').textContent = state.projectPath || 'No project set';
  document.getElementById('file-path-label').textContent = state.projectPath || 'No project set';

  // Start Ollama check/launch in parallel — don't block UI
  initOllama();

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

  rb.ollama.removeListeners();
  rb.ollama.onChunk(chunk => {
    thinkingEl.remove();
    assistantContent += chunk;
    assistantMsgEl.textContent = assistantContent;
    msgsEl.scrollTop = msgsEl.scrollHeight;
  });
  // Capture thread ID now — state may change if user navigates away
  const currentThreadId = state.activeThreadId;

  rb.ollama.onDone(async () => {
    state.streaming = false;
    await rb.db.insert('messages', { thread_id: currentThreadId, role: 'assistant', content: assistantContent });
    if (state.activeThreadId === currentThreadId) {
      state.messages.push({ role: 'assistant', content: assistantContent });
    }
    rb.ollama.removeListeners();
    // Parse response for file changes and show apply bar if any found
    const changes = extractFileChanges(assistantContent);
    if (changes.length) showApplyBar(changes);
  });

  try {
    await rb.ollama.chat({
      messages: state.messages.map(m => ({ role: m.role, content: m.content })),
      systemPrompt,
      model: state.ollamaModel,
      ollamaUrl: state.ollamaUrl,
    });
  } catch (e) {
    thinkingEl.remove();
    assistantMsgEl.textContent = '⚠ Could not reach Ollama. Is it running at ' + state.ollamaUrl + '?';
    state.streaming = false;
  }
}

function buildSystemPrompt(rulesets) {
  const ctx = state.projectContext || 'a software project';
  let prompt = 'You are an expert software developer working on ' + ctx + '.\n';
  prompt += 'Always write code that fits the existing patterns and architecture. Be specific about file paths and complete implementations.\n\n';
  if (rulesets.length) {
    prompt += '## Project Rules\n\n';
    rulesets.forEach(r => { prompt += '### ' + r.name + '\n' + r.content + '\n\n'; });
  }
  return prompt;
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
  const prompt = `You are executing a development plan for the CodeFox Unity project (Unity 6000.3, URP 2D).

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
  const inp = (id, val) => `<input id="${id}" value="${val}" style="margin-top:4px;display:block;width:100%;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px;font-family:var(--font);outline:none;" />`;

  modal.innerHTML = `
    <h2>Settings</h2>
    <div style="display:flex;flex-direction:column;gap:12px;max-height:70vh;overflow-y:auto;padding-right:4px;">
      <label style="color:var(--text2);font-size:12px;">Ollama URL
        ${inp('s-url', state.ollamaUrl)}
      </label>
      <label style="color:var(--text2);font-size:12px;">Model name
        ${inp('s-model', state.ollamaModel)}
      </label>
      <label style="color:var(--text2);font-size:12px;">
        Ollama executable path
        <span style="color:var(--text3);font-size:11px;margin-left:6px;">leave blank to auto-detect</span>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <input id="s-exe" value="${state.ollamaExePath}" placeholder="C:\...\ollama.exe"
            style="flex:1;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px;font-family:var(--font);outline:none;" />
          <button class="btn btn-secondary" onclick="browseOllamaExe()" style="flex-shrink:0;">Browse</button>
        </div>
        <div id="s-exe-detected" style="margin-top:4px;font-size:11px;color:var(--text3);"></div>
      </label>
      <label style="color:var(--text2);font-size:12px;">Project path
        ${inp('s-path', state.projectPath)}
      </label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
      <button class="btn btn-secondary" onclick="location.reload()">Cancel</button>
      <button class="btn btn-primary" onclick="saveSettings()">Save</button>
    </div>
  `;
  overlay.classList.add('open');

  // Show auto-detected path as hint
  rb.ollama.status().then(s => {
    const el = document.getElementById('s-exe-detected');
    if (el) el.textContent = s.exePath ? 'Auto-detected: ' + s.exePath : 'Could not auto-detect — use Browse to locate ollama.exe';
  });
}

async function browseOllamaExe() {
  const chosen = await rb.ollama.pickExe();
  if (chosen) {
    const input = document.getElementById('s-exe');
    if (input) input.value = chosen;
  }
}

async function saveSettings() {
  const url   = document.getElementById('s-url')?.value?.trim();
  const model = document.getElementById('s-model')?.value?.trim();
  const path  = document.getElementById('s-path')?.value?.trim();
  const exe   = document.getElementById('s-exe')?.value?.trim();
  if (url)   { state.ollamaUrl      = url;   await rb.db.setSetting('ollama_url', url); }
  if (model) { state.ollamaModel    = model; await rb.db.setSetting('ollama_model', model); }
  if (path)  { state.projectPath    = path;  await rb.db.setSetting('project_path', path); }
  // exe can be empty string (to clear custom path)
  state.ollamaExePath = exe || '';
  await rb.db.setSetting('ollama_exe_path', exe || '');
  await rb.ollama.setPath(exe || '');
  const ctx = document.getElementById('s-ctx')?.value?.trim();
  if (ctx !== undefined) { state.projectContext = ctx; await rb.db.setSetting('project_context', ctx); }
  location.reload();
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

function extractFileChanges(responseText) {
  const changes = [];
  // Match patterns like:
  //   **File Path:** `Assets/Scripts/Foo.cs`
  //   Assets/Scripts/Foo.cs
  //   // Assets/Scripts/Foo.cs
  // followed by a ```csharp or ``` code block

  const lines = responseText.split('\n');
  let pendingPath = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect file path hints
    const pathPatterns = [
      /\*\*File Path:\*\*\s*`([^`]+\.cs)`/i,
      /\*\*Script:\*\*\s*`([^`]+\.cs)`/i,
      /\*\*File:\*\*\s*`([^`]+\.cs)`/i,
      /^[`\s]*([A-Za-z][\w/\.-]+\.cs)\s*$/,
      /`([A-Za-z\/\][\w/\.-]+\.cs)`/,
    ];

    for (const pat of pathPatterns) {
      const m = line.match(pat);
      if (m) { pendingPath = m[1].trim(); break; }
    }

    // Detect opening code fence
    if (line.match(/^```(csharp|cs|c#)?\s*$/i)) {
      // Collect until closing fence
      let code = '';
      let j = i + 1;
      while (j < lines.length && !lines[j].match(/^```\s*$/)) {
        // Check if first line of code block is a path comment
        if (j === i + 1 && lines[j].match(/^\/\/\s*([A-Za-z][\w/\.-]+\.cs)/)) {
          const m = lines[j].match(/^\/\/\s*([A-Za-z][\w/\.-]+\.cs)/);
          if (!pendingPath) pendingPath = m[1].trim();
          j++;
          continue;
        }
        code += lines[j] + '\n';
        j++;
      }
      i = j; // skip past closing fence

      if (pendingPath && code.trim()) {
        changes.push({ path: pendingPath, code: code.trimEnd() });
      }
      pendingPath = null;
    }
  }
  return changes;
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

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn btn-secondary';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.onclick = () => bar.remove();

  bar.appendChild(label);
  bar.appendChild(fileList);
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
    }
    // New files have no backup entry — revert will delete them
  }

  // Record the snapshot
  await rb.db.insert('snapshots', {
    id: snapshotId,
    label: label.substring(0, 200),
    file_count: backedUp.length
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
  showRevertBar(snapshotId, label, backedUp.length, changes.length - backedUp.length);
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
