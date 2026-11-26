// comfyui-client.js — the thin ComfyUI HTTP client (split out of
// comfyui.js in v0.17.0).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// it directly with `node`. Every call goes through fetchWithTimeout
// so a missing server fails fast instead of hanging the app, and no
// call ever reports a fake "ok".
//
// Endpoints used (docs.comfy.org, ComfyUI server routes):
//   GET  /system_stats, /object_info, /queue, /history[/id], /view
//   GET  /api/workflow_templates
//   POST /prompt, /upload/image
//   POST /queue {"delete": [prompt_id]} — drop a queued prompt
//   POST /interrupt — stop the running prompt
//   POST /free {"unload_models": true, "free_memory": true} —
//     unload ComfyUI's models and clear its execution cache

const fs = require('fs');
const path = require('path');

const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';
const CLIENT_ID_PREFIX = 'codefox-';

function normalizeComfyuiUrl(raw) {
  const u = String(raw || DEFAULT_COMFYUI_URL).trim().replace(/\/+$/, '');
  return u || DEFAULT_COMFYUI_URL;
}

function comfyuiClientId() {
  return CLIENT_ID_PREFIX + Date.now().toString(36) + Math.floor(Math.random() * 100000).toString(36);
}

// fetch with a hard timeout. Every ComfyUI call goes through here so
// a missing server fails fast (5s for status, longer for the rest)
// instead of hanging the app. Never throws a fake "ok".
async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    return await fetch(url, { ...(opts || {}), signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function comfyuiGet(baseUrl, endpoint, timeoutMs) {
  const url = normalizeComfyuiUrl(baseUrl) + endpoint;
  try {
    const res = await fetchWithTimeout(url, {}, timeoutMs || 10000);
    if (!res.ok) return { ok: false, error: 'ComfyUI returned HTTP ' + res.status + ' for ' + endpoint };
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Timed out reaching ComfyUI at ' + url : String((e && e.message) || e) };
  }
}

// Status: /system_stats first; some ComfyUI versions do not serve
// it, so fall back to /object_info. Returns { ok, version?, ... } —
// ok is only ever true when the server really answered.
async function getComfyuiStatus(baseUrl) {
  const root = normalizeComfyuiUrl(baseUrl);
  const stats = await comfyuiGet(root, '/system_stats', 5000);
  if (stats.ok) {
    const sys = (stats.data && stats.data.system) || {};
    return {
      ok: true,
      version: (stats.data && stats.data.comfyui_version) || sys.comfyui_version || null,
      systemStats: stats.data,
      url: root,
    };
  }
  const info = await comfyuiGet(root, '/object_info', 5000);
  if (info.ok) return { ok: true, version: null, systemStats: null, url: root, note: '/system_stats not available on this ComfyUI version — status confirmed via /object_info' };
  return { ok: false, error: info.error || stats.error || 'ComfyUI is not running at ' + root, url: root };
}

async function getObjectInfo(baseUrl) {
  return comfyuiGet(baseUrl, '/object_info', 15000);
}

async function getQueue(baseUrl) {
  return comfyuiGet(baseUrl, '/queue', 10000);
}

async function getHistory(baseUrl, promptId) {
  return comfyuiGet(baseUrl, promptId ? '/history/' + encodeURIComponent(promptId) : '/history', 10000);
}

// GET /api/workflow_templates — the server's own catalogue of its
// built-in templates (name → title / description / category).
// Documented at docs.comfy.org/custom-nodes/workflow_templates.
// Defensive: the shape has changed before, so anything unexpected
// returns ok:false and the disk import proceeds with filename
// names instead of titles. Never throws.
async function getWorkflowTemplates(baseUrl) {
  const r = await comfyuiGet(baseUrl, '/api/workflow_templates', 10000);
  if (!r.ok) return { ok: false, error: r.error, byName: {} };
  const byName = {};
  const add = (t) => {
    if (!t || typeof t !== 'object') return;
    const name = t.name || t.id;
    if (!name) return;
    byName[String(name)] = {
      title: t.title || String(name),
      description: t.description || '',
      category: t.category || '',
      type: t.type || '',
    };
  };
  const data = r.data;
  if (Array.isArray(data)) {
    for (const cat of data) {
      if (cat && Array.isArray(cat.templates)) {
        for (const t of cat.templates) add({ ...t, category: t.category || cat.category || cat.title || '' });
      } else add(cat);
    }
  } else if (data && typeof data === 'object') {
    if (Array.isArray(data.templates)) for (const t of data.templates) add(t);
    else for (const t of Object.values(data)) add(t);
  }
  return { ok: true, byName, count: Object.keys(byName).length };
}

// Submit a workflow graph for execution. Returns the prompt_id the
// caller polls /queue + /history for. The graph passed in is the
// caller's to own — buildSubmitPrompt() clones before substituting.
async function submitPrompt(baseUrl, promptGraph, clientId) {
  const url = normalizeComfyuiUrl(baseUrl) + '/prompt';
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptGraph, client_id: clientId || comfyuiClientId() }),
    }, 30000);
    if (!res.ok) return { ok: false, error: 'ComfyUI returned HTTP ' + res.status + ' for /prompt: ' + (await res.text()).slice(0, 300) };
    const data = await res.json();
    if (!data.prompt_id) return { ok: false, error: 'ComfyUI accepted the prompt but returned no prompt_id' };
    return { ok: true, prompt_id: data.prompt_id, data };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Timed out submitting to ComfyUI' : String((e && e.message) || e) };
  }
}

// Download one output image (or video) and write it to destPath.
// Returns { ok, path } — bytes go straight to disk, never base64
// through the renderer.
async function downloadView(baseUrl, params, destPath) {
  const root = normalizeComfyuiUrl(baseUrl);
  const q = new URLSearchParams({
    filename: params.filename || '',
    subfolder: params.subfolder || '',
    type: params.type || 'output',
  });
  const url = root + '/view?' + q.toString();
  try {
    const res = await fetchWithTimeout(url, {}, 30000);
    if (!res.ok) return { ok: false, error: 'ComfyUI returned HTTP ' + res.status + ' for /view' };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return { ok: true, path: destPath, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Timed out downloading from ComfyUI' : String((e && e.message) || e) };
  }
}

// Upload an input image (e.g. for an img2img / inpaint workflow).
// Node 20+ provides global fetch + FormData — no new dependency.
async function uploadImage(baseUrl, filePath, opts) {
  const root = normalizeComfyuiUrl(baseUrl);
  try {
    if (!fs.existsSync(filePath)) return { ok: false, error: 'File not found: ' + filePath };
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('image', new Blob([buf], { type: (opts && opts.mime) || 'image/png' }), path.basename(filePath));
    if (opts && opts.subfolder) form.append('subfolder', opts.subfolder);
    if (opts && opts.overwrite) form.append('overwrite', 'true');
    const res = await fetchWithTimeout(root + '/upload/image', { method: 'POST', body: form }, 30000);
    if (!res.ok) return { ok: false, error: 'ComfyUI returned HTTP ' + res.status + ' for /upload/image: ' + (await res.text()).slice(0, 300) };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Timed out uploading to ComfyUI' : String((e && e.message) || e) };
  }
}

// Cancel a prompt that is still in ComfyUI's queue or running.
// The caller checks /queue first: a queued prompt is deleted from
// the queue (POST /queue {"delete": [prompt_id]}); a running one is
// stopped with POST /interrupt — but only after the queue check
// confirmed the running item really is this prompt_id, so a cancel
// never kills someone else's job. A prompt that is in neither list
// already finished (or never existed): nothing to cancel.
// Returns { ok, action: 'deleted'|'interrupted'|'already-done', error? }.
async function cancelPrompt(baseUrl, promptId) {
  const root = normalizeComfyuiUrl(baseUrl);
  if (!promptId) return { ok: false, error: 'cancelPrompt needs a prompt_id.' };
  const q = await getQueue(root);
  if (!q.ok) return { ok: false, error: 'Could not read the ComfyUI queue to cancel safely: ' + q.error };
  const data = q.data || {};
  const pending = Array.isArray(data.queue_pending) ? data.queue_pending : [];
  const running = Array.isArray(data.queue_running) ? data.queue_running : [];
  const isPending = pending.some(item => String(item[1]) === String(promptId));
  const isRunning = running.some(item => String(item[1]) === String(promptId));
  if (!isPending && !isRunning) return { ok: true, action: 'already-done' };
  if (isPending) {
    try {
      const res = await fetchWithTimeout(root + '/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [String(promptId)] }),
      }, 10000);
      if (!res.ok) return { ok: false, error: 'ComfyUI returned HTTP ' + res.status + ' for /queue delete' };
      return { ok: true, action: 'deleted' };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? 'Timed out deleting the queued prompt' : String((e && e.message) || e) };
    }
  }
  // Running: POST /interrupt stops the current execution. The
  // queue check above already confirmed the running item is ours.
  try {
    const res = await fetchWithTimeout(root + '/interrupt', { method: 'POST' }, 10000);
    if (!res.ok) return { ok: false, error: 'ComfyUI returned HTTP ' + res.status + ' for /interrupt' };
    return { ok: true, action: 'interrupted' };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Timed out interrupting the running prompt' : String((e && e.message) || e) };
  }
}

// Free GPU memory on the ComfyUI server: unload its models and
// clear the execution cache. POST /free {"unload_models": true,
// "free_memory": true} — the documented system route. Used after
// a generation in GPU swap mode, so the thing that runs next (the
// chat model reloading) has the VRAM. Returns { ok, error? }.
async function freeComfyuiMemory(baseUrl) {
  const root = normalizeComfyuiUrl(baseUrl);
  try {
    const res = await fetchWithTimeout(root + '/free', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }, 30000);
    if (!res.ok) return { ok: false, error: 'ComfyUI returned HTTP ' + res.status + ' for /free' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Timed out freeing ComfyUI memory' : String((e && e.message) || e) };
  }
}

module.exports = {
  DEFAULT_COMFYUI_URL,
  normalizeComfyuiUrl,
  comfyuiClientId,
  fetchWithTimeout,
  getComfyuiStatus,
  getObjectInfo,
  getWorkflowTemplates,
  getQueue,
  getHistory,
  submitPrompt,
  downloadView,
  uploadImage,
  cancelPrompt,
  freeComfyuiMemory,
};
