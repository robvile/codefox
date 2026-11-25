// comfyui.js — Native ComfyUI provider helpers (v0.6.0).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// this file directly with `node`. main.js requires it for the
// comfyui:* IPCs; the renderer never talks to ComfyUI directly.
//
// This is a NATIVE provider, not an MCP server: CodeFox talks to a
// locally running ComfyUI instance over its own HTTP API
// (/system_stats, /object_info, /prompt, /queue, /history, /view,
// /upload/image). ComfyUI handles generation; CodeFox handles
// intelligence, orchestration, and getting the results into the
// project. Monitoring is by POLLING /queue + /history — there is no
// WebSocket client here, by design.
//
// No workflow is hardcoded into CodeFox. Workflows are the user's
// own JSON files (API-format graphs), imported from a folder the
// user picks. The catalogue stores the parsed definition
// (name, purpose, inputs, outputs, missing dependencies, approval)
// — never a sample workflow shipped as if it were the user's.

const fs = require('fs');
const os = require('os');
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

// ── Workflow parsing ──────────────────────────────────────────────
// A ComfyUI API-format workflow is a JSON object keyed by node id:
//   { "3": { "class_type": "KSampler", "inputs": { "seed": 1, ... } }, ... }
// parseWorkflowGraph(graph, objectInfo) catalogues it without
// running anything:
//   inputs  — every string/number input, with the well-known ones
//             labelled (positive/negative prompt, seed, steps, cfg,
//             checkpoint, image, filename prefix)
//   outputs — SaveImage / PreviewImage / SaveVideo nodes
//   missing — node class_types absent from /object_info, and
//             checkpoint/model names absent from the model lists
//             in /object_info (when objectInfo is supplied; when it
//             is not, missing is empty and available is false with a
//             reason — never claimed checked when it was not).
function slugifyWorkflowId(name) {
  return String(name || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}

function modelListFromObjectInfo(objectInfo, classType, inputName) {
  try {
    const node = objectInfo && objectInfo[classType];
    const list = node && node.input && node.input.required && node.input.required[inputName];
    return Array.isArray(list) && Array.isArray(list[0]) ? list[0] : [];
  } catch { return []; }
}

function parseWorkflowGraph(graph, objectInfo) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return { ok: false, error: 'Not a ComfyUI API-format workflow (expected an object keyed by node id)', inputs: [], outputs: [], missing: ['Not a workflow graph'] };
  }
  const nodes = Object.entries(graph).map(([id, node]) => ({ id: String(id), node: node || {} }));
  const inputs = [];
  const outputs = [];
  const missing = [];
  const presentClasses = objectInfo ? new Set(Object.keys(objectInfo)) : null;

  // Which CLIPTextEncode node feeds each KSampler positive/negative
  // input — so the two prompt fields are labelled by role, not by
  // guesswork from node titles alone.
  const clipRoleByNodeId = {};
  for (const { id, node } of nodes) {
    if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') {
      for (const role of ['positive', 'negative']) {
        const link = node.inputs && node.inputs[role];
        if (Array.isArray(link) && link[0] != null) clipRoleByNodeId[String(link[0])] = role;
      }
    }
  }

  for (const { id, node } of nodes) {
    const classType = node.class_type || '';
    if (!classType) continue;
    if (presentClasses && !presentClasses.has(classType)) {
      missing.push('Node type not installed: ' + classType + ' (node ' + id + ')');
    }
    const title = String((node._meta && node._meta.title) || '');
    const ins = (node.inputs && typeof node.inputs === 'object') ? node.inputs : {};
    if (classType === 'SaveImage' || classType === 'PreviewImage' || classType === 'SaveVideo' || classType === 'SaveWEBM' || classType === 'SaveAnimatedWEBP') {
      outputs.push({ nodeId: id, classType, filenamePrefix: typeof ins.filename_prefix === 'string' ? ins.filename_prefix : '' });
    }
    for (const [inputName, value] of Object.entries(ins)) {
      if (Array.isArray(value)) continue; // a link to another node, not a value
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
      let role = null;
      if (classType === 'CLIPTextEncode' && inputName === 'text') {
        role = clipRoleByNodeId[id]
          || (/neg/i.test(title) ? 'negative' : /pos/i.test(title) ? 'positive' : null);
      }
      inputs.push({
        nodeId: id, classType, inputName,
        value, type: typeof value,
        role,
        label: role === 'positive' ? 'Positive prompt' : role === 'negative' ? 'Negative prompt'
          : classType === 'CheckpointLoader' || classType === 'CheckpointLoaderSimple' ? 'Checkpoint'
          : classType === 'LoadImage' && inputName === 'image' ? 'Input image'
          : inputName,
      });
    }
  }

  // Checkpoint / model names actually referenced by the workflow,
  // checked against the model lists ComfyUI reports.
  if (objectInfo) {
    const ckpts = modelListFromObjectInfo(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name')
      .concat(modelListFromObjectInfo(objectInfo, 'CheckpointLoader', 'ckpt_name'));
    if (ckpts.length) {
      for (const inp of inputs) {
        if ((inp.classType === 'CheckpointLoader' || inp.classType === 'CheckpointLoaderSimple')
          && inp.inputName === 'ckpt_name' && typeof inp.value === 'string' && !ckpts.includes(inp.value)) {
          missing.push('Checkpoint not installed: ' + inp.value);
        }
      }
    }
  }

  const available = presentClasses ? missing.length === 0 : false;
  return {
    ok: true, inputs, outputs,
    missing: [...new Set(missing)],
    available,
    availableReason: presentClasses
      ? (missing.length ? 'Missing: ' + [...new Set(missing)].join('; ') : 'All nodes and models present')
      : 'ComfyUI not running — dependencies not checked yet',
  };
}

// Build the prompt graph to submit: deep-clone the stored workflow
// (the stored definition is NEVER mutated — a generation that edited
// it would corrupt the catalogue), then substitute the caller's
// inputs. Override keys:
//   "positive" / "negative" — the CLIPTextEncode text by role
//   "<nodeId>.<inputName>" — one exact input
//   "<inputName>" — applied when exactly one node has that input
// Returns { prompt, applied: [keys], unapplied: [keys] }.
function buildSubmitPrompt(workflowGraph, overrides) {
  const prompt = JSON.parse(JSON.stringify(workflowGraph));
  const applied = [];
  const unapplied = [];
  const o = overrides || {};
  // Pre-compute roles for positive/negative mapping.
  const parsed = parseWorkflowGraph(workflowGraph, null);
  const roleNode = {};
  for (const inp of parsed.inputs) {
    if (inp.role && inp.inputName === 'text') roleNode[inp.role] = inp.nodeId;
  }
  for (const [key, value] of Object.entries(o)) {
    if (value === undefined || value === null) { unapplied.push(key); continue; }
    let done = false;
    if ((key === 'positive' || key === 'negative') && roleNode[key] && prompt[roleNode[key]]) {
      prompt[roleNode[key]].inputs.text = value;
      done = true;
    } else if (key.includes('.')) {
      const [nodeId, ...rest] = key.split('.');
      const inputName = rest.join('.');
      if (prompt[nodeId] && prompt[nodeId].inputs && inputName in prompt[nodeId].inputs) {
        prompt[nodeId].inputs[inputName] = value;
        done = true;
      }
    } else {
      const matches = [];
      for (const [nodeId, node] of Object.entries(prompt)) {
        if (node && node.inputs && key in node.inputs) matches.push(nodeId);
      }
      if (matches.length === 1) {
        prompt[matches[0]].inputs[key] = value;
        done = true;
      }
    }
    if (done) applied.push(key); else unapplied.push(key);
  }
  return { prompt, applied, unapplied };
}

// Capabilities actually present in this ComfyUI install, computed
// from the node class names in /object_info — never hardcoded.
// A capability is only listed when the install really has the nodes
// for it.
function detectCapabilities(objectInfo) {
  if (!objectInfo || typeof objectInfo !== 'object') return [];
  const classes = new Set(Object.keys(objectInfo));
  const has = (...names) => names.some(n => classes.has(n));
  const caps = [];
  if (has('KSampler', 'KSamplerAdvanced') && has('CheckpointLoader', 'CheckpointLoaderSimple')) {
    caps.push({ id: 'image', label: 'Image generation' });
  }
  if (has('SaveVideo', 'SaveWEBM', 'SaveAnimatedWEBP', 'VHS_VideoCombine', 'CreateVideo')) {
    caps.push({ id: 'video', label: 'Video generation' });
  }
  if ([...classes].some(c => /upscale/i.test(c))) caps.push({ id: 'upscale', label: 'Upscaling' });
  if ([...classes].some(c => /controlnet/i.test(c))) caps.push({ id: 'controlnet', label: 'ControlNet' });
  if ([...classes].some(c => /inpaint/i.test(c))) caps.push({ id: 'inpaint', label: 'Inpainting' });
  if (has('LoadImage', 'LoadImageMask')) caps.push({ id: 'img2img', label: 'Image-to-image' });
  if ([...classes].some(c => /lora/i.test(c))) caps.push({ id: 'lora', label: 'LoRA support' });
  if ([...classes].some(c => /ipadapter/i.test(c))) caps.push({ id: 'ipadapter', label: 'IP-Adapter' });
  return caps;
}

// Where ComfyUI Desktop keeps user workflows, when it can be found.
// Checked in order; returns '' when none of the usual folders exist
// — the user then picks a folder by hand. Never invented.
function defaultWorkflowsDir() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const candidates = [
    path.join(appData, 'ComfyUI', 'user', 'default', 'workflows'),
    path.join(home, 'Documents', 'ComfyUI', 'workflows'),
    path.join(home, 'ComfyUI', 'user', 'default', 'workflows'),
    path.join(home, 'ComfyUI', 'workflows'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c; } catch {}
  }
  return '';
}

// Read every *.json in a folder as a workflow graph and catalogue
// them. `stored` is the previously saved catalogue (by id) so a
// user's purpose label and approval survive a rescan. Returns
// { ok, workflows, errors }.
function importWorkflowsFromDir(dir, objectInfo, stored) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Workflows folder not found: ' + (dir || '(none set)'), workflows: [] };
  const byId = {};
  for (const s of (stored || [])) if (s && s.id) byId[s.id] = s;
  const workflows = [];
  const errors = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).sort(); } catch (e) {
    return { ok: false, error: 'Could not read workflows folder: ' + e.message, workflows: [] };
  }
  for (const file of files) {
    const full = path.join(dir, file);
    const name = file.replace(/\.json$/i, '');
    const id = slugifyWorkflowId(name);
    let graph;
    try {
      graph = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      errors.push(file + ': not valid JSON — ' + e.message);
      continue;
    }
    const parsed = parseWorkflowGraph(graph, objectInfo);
    if (!parsed.ok) { errors.push(file + ': ' + parsed.error); continue; }
    const prev = byId[id];
    workflows.push({
      id, name, file: full,
      purpose: (prev && prev.purpose) || 'Unlabelled — set a purpose',
      inputs: parsed.inputs,
      outputs: parsed.outputs,
      missing: parsed.missing,
      available: parsed.available,
      availableReason: parsed.availableReason,
      approved: !!(prev && prev.approved),
    });
  }
  return { ok: true, workflows, errors };
}

module.exports = {
  DEFAULT_COMFYUI_URL,
  normalizeComfyuiUrl,
  comfyuiClientId,
  fetchWithTimeout,
  getComfyuiStatus,
  getObjectInfo,
  getQueue,
  getHistory,
  submitPrompt,
  downloadView,
  uploadImage,
  slugifyWorkflowId,
  parseWorkflowGraph,
  buildSubmitPrompt,
  detectCapabilities,
  defaultWorkflowsDir,
  importWorkflowsFromDir,
};
