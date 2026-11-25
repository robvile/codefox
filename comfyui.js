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
// own JSON files (API-format graphs, or the UI-format graphs
// ComfyUI Desktop saves — converted to API format at import and
// submit time, see convertUiGraphToApi), imported from a folder the
// user picks, plus ComfyUI Desktop's built-in templates, which the
// scan finds on disk and imports labelled as built-ins. The
// catalogue stores the parsed definition (name, purpose, inputs,
// outputs, missing dependencies, approval) — never a sample
// workflow shipped as if it were the user's.

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

// ── Workflow parsing ──────────────────────────────────────────────
// A ComfyUI API-format workflow is a JSON object keyed by node id:
//   { "3": { "class_type": "KSampler", "inputs": { "seed": 1, ... } }, ... }
// UI-format workflows (a LiteGraph { nodes, links } object — what
// ComfyUI Desktop saves and ships as templates) are converted to
// API format first, when /object_info is available to read the
// node definitions from; without it they fail with the reason
// instead of importing as empty shells. See
// convertUiGraphToApi.
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
  // UI-format graphs (what ComfyUI Desktop saves, and what its
  // built-in templates are) convert first — see
  // convertUiGraphToApi. Without /object_info the conversion
  // cannot be done honestly, so the workflow fails with the
  // reason instead of importing as an empty shell.
  if (isUiWorkflowGraph(graph)) {
    if (!objectInfo) {
      return { ok: false, error: 'UI-format workflow — ComfyUI must be running so the node definitions can be read', inputs: [], outputs: [], missing: ['UI-format workflow'] };
    }
    const converted = convertUiGraphToApi(graph, objectInfo);
    if (!converted.ok) return { ok: false, error: converted.error, inputs: [], outputs: [], missing: [converted.error] };
    return parseWorkflowGraph(converted.graph, objectInfo);
  }
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return { ok: false, error: 'Not a ComfyUI API-format workflow (expected an object keyed by node id)', inputs: [], outputs: [], missing: ['Not a workflow graph'] };
  }
  const nodes = Object.entries(graph).map(([id, node]) => ({ id: String(id), node: node || {} }));
  const inputs = [];
  const outputs = [];
  const missing = [];
  const presentClasses = objectInfo ? new Set(Object.keys(objectInfo)) : null;

  // Which CLIPTextEncode node feeds each sampler's positive/negative
  // input — so the two prompt fields are labelled by role, not by
  // guesswork from node titles alone. The classic path is a
  // KSampler; Flux / SD3-style graphs run the conditioning through
  // a BasicGuider, a CFGGuider (or a SamplerCustom), which carries
  // the same positive/negative inputs — those count too.
  const clipRoleByNodeId = {};
  const samplerClasses = ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced', 'BasicGuider', 'CFGGuider'];
  for (const { id, node } of nodes) {
    if (samplerClasses.includes(node.class_type)) {
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

// ── UI-format (LiteGraph) → API-format conversion ─────────────
// ComfyUI Desktop saves workflows — and ships its built-in
// templates — as UI-format JSON: { nodes: [...], links: [...],
// definitions: { subgraphs: [...] } }. The /prompt endpoint only
// accepts API-format graphs (an object keyed by node id), and the
// old parser silently turned a UI graph into an empty workflow
// (0 inputs, 0 outputs, "available"), which is why a library full
// of real Desktop workflows showed up empty. This converter turns
// a UI graph into the equivalent API graph so templates and saved
// workflows generate exactly like API-format ones.
//
// It needs /object_info: a node's widget values are stored in
// `widgets_values` positionally — one entry per widget-typed input
// in the node's definition order — and only the definition knows
// which inputs are widgets (text, seed, model name) and which are
// links (MODEL, CLIP, LATENT). Without it the mapping cannot be
// done honestly, so conversion fails with a clear error instead of
// guessing. Node types absent from /object_info fail the same way,
// except the annotation nodes (Note / MarkdownNote), which are
// skipped — they are never executed.
//
// Subgraphs (the "blueprint" nodes the newer templates are built
// from, e.g. the Flux and Qwen text-to-image templates) are
// expanded first: the subgraph's internal nodes are spliced into
// the flat graph with fresh ids, links from the subgraph's inputs
// are rewired to whatever feeds the instance (an outer link, the
// instance's own widget value, or — when neither exists — dropped,
// so the internal node's own default widget value applies), and
// links to the subgraph's outputs are rewired to the internal node
// that produces them. Expansion is deterministic (fresh ids are
// handed out in traversal order from one counter), so the same file
// always converts to the same API graph and the catalogue's node
// ids stay valid. Nested subgraphs expand too, to a depth of 3;
// deeper than that fails honestly.
const UI_NOTE_TYPES = ['Note', 'MarkdownNote'];
const UI_SUBGRAPH_MAX_DEPTH = 3;
const UI_SUBGRAPH_INPUT_NODE = -10;
const UI_SUBGRAPH_OUTPUT_NODE = -20;

function isUiWorkflowGraph(graph) {
  return !!(graph && typeof graph === 'object' && !Array.isArray(graph) && Array.isArray(graph.nodes));
}

// Normalise a LiteGraph link to { id, originId, originSlot,
// targetId, targetSlot, type }. Links come in two shapes: arrays
// [id, originId, originSlot, targetId, targetSlot, type] in the
// outer graph, and objects { id, origin_id, origin_slot,
// target_id, target_slot, type } inside subgraph definitions.
function normalizeUiLink(link) {
  if (Array.isArray(link)) {
    return { id: link[0], originId: link[1], originSlot: link[2], targetId: link[3], targetSlot: link[4], type: link[5] };
  }
  if (link && typeof link === 'object') {
    return { id: link.id, originId: link.origin_id, originSlot: link.origin_slot, targetId: link.target_id, targetSlot: link.target_slot, type: link.type };
  }
  return null;
}

// A definition input spec is a widget (a value the user types)
// when its type is a plain scalar or a combo list; anything else
// (MODEL, CLIP, LATENT, CONDITIONING, IMAGE, VAE, …) is a link
// from another node's output.
function uiDefInputIsWidget(spec) {
  if (!spec) return false;
  const kind = spec[0];
  if (Array.isArray(kind)) return true; // a combo list — a widget
  return kind === 'STRING' || kind === 'INT' || kind === 'FLOAT' || kind === 'BOOLEAN';
}

// Widget-typed def inputs, in definition order. widgets_values[i]
// is the value of the i-th entry of this list.
function uiWidgetInputs(def) {
  const out = [];
  const groups = (def && def.input) || {};
  for (const group of [groups.required, groups.optional]) {
    if (!group) continue;
    for (const [name, spec] of Object.entries(group)) {
      if (uiDefInputIsWidget(spec)) out.push({ name, spec });
    }
  }
  return out;
}

// Def inputs in definition order (required, then optional).
function uiDefInputs(def) {
  const out = [];
  const groups = (def && def.input) || {};
  for (const group of [groups.required, groups.optional]) {
    if (!group) continue;
    for (const [name, spec] of Object.entries(group)) out.push({ name, spec });
  }
  return out;
}

// Expand every subgraph instance in a UI graph into flat nodes +
// links. Returns { ok, nodes, links, error }. `nodes` are cloned
// UI nodes; links are normalised link objects. An input entry that
// gets a literal value from the instance's own widget carries
// __literal on the entry — the converter below prefers it over the
// node's own widget value.
function expandUiSubgraphs(uiGraph) {
  const subgraphs = {};
  const defs = (uiGraph && uiGraph.definitions && uiGraph.definitions.subgraphs) || [];
  for (const s of defs) if (s && s.id != null) subgraphs[String(s.id)] = s;
  const plainNodes = (uiGraph.nodes || []).map(n => ({ ...n }));
  const plainLinks = (uiGraph.links || []).map(normalizeUiLink).filter(Boolean);
  if (!Object.keys(subgraphs).length) return { ok: true, nodes: plainNodes, links: plainLinks };
  let nodes = plainNodes.map(n => ({ ...n, __depth: 0 }));
  let links = plainLinks;
  let maxId = 0;
  for (const n of nodes) if (typeof n.id === 'number' && n.id > maxId) maxId = n.id;
  // Fresh link ids must not collide with ANY link id in the file —
  // subgraph definitions have their own link ids (e.g. up to 153
  // while the outer graph only reaches 131), so count those too.
  let maxLinkId = 0;
  for (const l of links) if (typeof l.id === 'number' && l.id > maxLinkId) maxLinkId = l.id;
  for (const s of Object.values(subgraphs)) {
    for (const l of (s.links || [])) {
      const nl = normalizeUiLink(l);
      if (nl && typeof nl.id === 'number' && nl.id > maxLinkId) maxLinkId = nl.id;
    }
  }
  const linkById = new Map();
  const rebuildLinkIndex = () => { linkById.clear(); for (const l of links) linkById.set(l.id, l); };
  rebuildLinkIndex();

  for (;;) {
    const idx = nodes.findIndex(n => subgraphs[String(n.type)] && (n.__depth || 0) < UI_SUBGRAPH_MAX_DEPTH);
    if (idx < 0) break;
    const inst = nodes[idx];
    const sub = subgraphs[String(inst.type)];
    const depth = inst.__depth || 0;
    const idMap = new Map();
    const newNodes = [];
    for (const sn of (sub.nodes || [])) {
      const fresh = ++maxId;
      idMap.set(sn.id, fresh);
      const clone = { ...sn, id: fresh, __depth: depth + 1 };
      if (Array.isArray(sn.inputs)) clone.inputs = sn.inputs.map(i => ({ ...i }));
      newNodes.push(clone);
    }
    const subLinks = (sub.links || []).map(normalizeUiLink).filter(Boolean);
    const subInputs = sub.inputs || [];
    // The instance node's widget inputs, in order, so a widget
    // value set on the instance maps to the right subgraph input.
    const instWidgetEntries = (inst.inputs || []).filter(i => i && i.widget);
    const instWidgetValue = (entry) => {
      const j = instWidgetEntries.indexOf(entry);
      if (j < 0) return undefined;
      const vals = Array.isArray(inst.widgets_values) ? inst.widgets_values : [];
      return j < vals.length ? vals[j] : undefined;
    };
    const findInstInput = (subInput, slotIdx) => {
      const byName = (inst.inputs || []).find(i => i && i.name === subInput.name);
      if (byName) return byName;
      return (inst.inputs || [])[slotIdx] || null;
    };
    // A link created by expansion gets a fresh id — the target
    // node's input entry must point at that id, or the converter
    // below cannot resolve the link. (The original entries still
    // hold the subgraph's own link ids, which no longer exist.)
    const setTargetLink = (targetId, targetSlot, linkId) => {
      const target = newNodes.find(n => n.id === targetId);
      const tEntry = target && Array.isArray(target.inputs) ? target.inputs[targetSlot] : null;
      if (tEntry) tEntry.link = linkId;
    };
    const newLinks = [];
    for (const L of subLinks) {
      const isFromInput = L.originId === UI_SUBGRAPH_INPUT_NODE;
      const isToOutput = L.targetId === UI_SUBGRAPH_OUTPUT_NODE;
      if (isFromInput && isToOutput) {
        // Passthrough: a subgraph input wired straight to an
        // output. Resolve it at the instance's boundary.
        const subInput = subInputs[L.originSlot] || {};
        const entry = findInstInput(subInput, L.originSlot);
        const outSlot = L.targetSlot;
        if (entry && entry.link != null && linkById.has(entry.link)) {
          const ol = linkById.get(entry.link);
          for (const outer of links) {
            if (outer.originId === inst.id && outer.originSlot === outSlot) {
              outer.originId = ol.originId; outer.originSlot = ol.originSlot;
            }
          }
        } else if (entry && instWidgetValue(entry) !== undefined) {
          const lit = instWidgetValue(entry);
          for (let k = links.length - 1; k >= 0; k--) {
            const outer = links[k];
            if (outer.originId === inst.id && outer.originSlot === outSlot) {
              const target = nodes.find(n => n.id === outer.targetId);
              const tEntry = target && Array.isArray(target.inputs) ? target.inputs[outer.targetSlot] : null;
              if (target && tEntry) tEntry.__literal = lit;
              links.splice(k, 1);
            }
          }
        } else {
          for (let k = links.length - 1; k >= 0; k--) {
            const outer = links[k];
            if (outer.originId === inst.id && outer.originSlot === outSlot) {
              const target = nodes.find(n => n.id === outer.targetId);
              const tEntry = target && Array.isArray(target.inputs) ? target.inputs[outer.targetSlot] : null;
              if (tEntry) tEntry.link = null;
              links.splice(k, 1);
            }
          }
        }
        continue;
      }
      if (isFromInput) {
        const subInput = subInputs[L.originSlot] || {};
        const entry = findInstInput(subInput, L.originSlot);
        if (entry && entry.link != null && linkById.has(entry.link)) {
          const ol = linkById.get(entry.link);
          const linkId = ++maxLinkId;
          newLinks.push({ id: linkId, originId: ol.originId, originSlot: ol.originSlot, targetId: idMap.get(L.targetId), targetSlot: L.targetSlot, type: L.type });
          setTargetLink(idMap.get(L.targetId), L.targetSlot, linkId);
        } else if (entry && instWidgetValue(entry) !== undefined) {
          const target = newNodes.find(n => n.id === idMap.get(L.targetId));
          const tEntry = target && Array.isArray(target.inputs) ? target.inputs[L.targetSlot] : null;
          if (tEntry) tEntry.__literal = instWidgetValue(entry);
        } else {
          // No outer value: drop the link — the target keeps its
          // own default widget value. Clear the entry's link so
          // the converter does not chase a link id that no
          // longer exists.
          const target = newNodes.find(n => n.id === idMap.get(L.targetId));
          const tEntry = target && Array.isArray(target.inputs) ? target.inputs[L.targetSlot] : null;
          if (tEntry) tEntry.link = null;
        }
        // No outer value: drop the link — the target keeps its
        // own default widget value.
        continue;
      }
      if (isToOutput) {
        const outSlot = L.targetSlot;
        const srcId = idMap.get(L.originId);
        if (srcId === undefined) continue;
        for (const outer of links) {
          if (outer.originId === inst.id && outer.originSlot === outSlot) {
            outer.originId = srcId; outer.originSlot = L.originSlot;
          }
        }
        continue;
      }
      if (!idMap.has(L.originId) || !idMap.has(L.targetId)) continue;
      const linkId = ++maxLinkId;
      newLinks.push({ id: linkId, originId: idMap.get(L.originId), originSlot: L.originSlot, targetId: idMap.get(L.targetId), targetSlot: L.targetSlot, type: L.type });
      setTargetLink(idMap.get(L.targetId), L.targetSlot, linkId);
    }
    // The instance's own input links are consumed by the rewiring
    // above; any outer link still pointing at the instance is
    // dangling (an output no internal node feeds) and goes too.
    links = links.filter(l => l.targetId !== inst.id && l.originId !== inst.id);
    nodes.splice(idx, 1, ...newNodes);
    links.push(...newLinks);
    rebuildLinkIndex();
  }
  const stuck = nodes.find(n => subgraphs[String(n.type)]);
  if (stuck) {
    return { ok: false, error: 'Subgraph nesting deeper than ' + UI_SUBGRAPH_MAX_DEPTH + ' levels is not supported (' + stuck.type + ')' };
  }
  for (const n of nodes) delete n.__depth;
  return { ok: true, nodes, links };
}

// Convert one flat UI node to its API-format inputs.
function convertUiNode(node, objectInfo, resolveOrigin) {
  const def = objectInfo[node.type];
  if (!def) {
    if (UI_NOTE_TYPES.includes(node.type)) return { ok: true, skip: true };
    return { ok: false, error: 'Node type not installed: ' + node.type + ' (node ' + node.id + ')' };
  }
  const inputs = {};
  const widgets = uiWidgetInputs(def);
  const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  const widgetValueByName = {};
  widgets.forEach((w, j) => { if (j < values.length) widgetValueByName[w.name] = values[j]; });
  const nodeInputs = Array.isArray(node.inputs) ? node.inputs : [];
  const entryByName = {};
  for (const e of nodeInputs) if (e && e.name) entryByName[e.name] = e;
  for (const { name, spec } of uiDefInputs(def)) {
    const entry = entryByName[name];
    if (entry && entry.__literal !== undefined) { inputs[name] = entry.__literal; continue; }
    if (entry && entry.link != null) {
      const resolved = resolveOrigin(entry.link);
      if (resolved) { inputs[name] = [String(resolved.nodeId), resolved.slot]; continue; }
      // The link dangled (a dropped subgraph link, or a reroute
      // to nowhere): fall through to the widget / default.
    }
    if (uiDefInputIsWidget(spec)) {
      if (name in widgetValueByName) inputs[name] = widgetValueByName[name];
      else if (spec[1] && spec[1].default !== undefined) inputs[name] = spec[1].default;
      continue;
    }
    // A link-typed input with no link: leave it out — the server
    // reports the missing input if it matters.
  }
  return { ok: true, inputs };
}

// Convert a UI-format workflow graph to its API-format equivalent.
// Returns { ok, graph, error }.
function convertUiGraphToApi(uiGraph, objectInfo) {
  if (!isUiWorkflowGraph(uiGraph)) return { ok: false, error: 'Not a UI-format workflow (expected a nodes array)' };
  if (!objectInfo || typeof objectInfo !== 'object') {
    return { ok: false, error: 'UI-format workflow — ComfyUI must be running so the node definitions can be read' };
  }
  const expanded = expandUiSubgraphs(uiGraph);
  if (!expanded.ok) return expanded;
  const nodes = expanded.nodes;
  const links = expanded.links;
  const byId = new Map();
  for (const n of nodes) byId.set(n.id, n);
  const linkMap = new Map();
  for (const l of links) linkMap.set(l.id, l);
  // Bypassed / muted nodes (mode 2 or 4) have no honest API
  // equivalent — the graph would silently do something else.
  // Fail with the reason instead of guessing.
  for (const n of nodes) {
    if (n && (n.mode === 2 || n.mode === 4)) {
      return { ok: false, error: 'Bypassed node "' + (n.type || '?') + '" (id ' + n.id + ') is not supported — un-bypass it in ComfyUI Desktop and save again' };
    }
  }
  const resolveOrigin = (linkId) => {
    let cur = linkMap.get(linkId);
    let guard = 0;
    while (cur) {
      if (guard++ > 20) return null;
      const origin = byId.get(cur.originId);
      if (!origin) return null;
      if (origin.type === 'Reroute') {
        const inp = Array.isArray(origin.inputs) ? origin.inputs[0] : null;
        if (!inp || inp.link == null) return null;
        cur = linkMap.get(inp.link);
        continue;
      }
      return { nodeId: cur.originId, slot: cur.originSlot };
    }
    return null;
  };
  const api = {};
  for (const n of nodes) {
    if (!n || !n.type) continue;
    if (n.type === 'Reroute') continue;
    if (UI_NOTE_TYPES.includes(n.type)) continue;
    const converted = convertUiNode(n, objectInfo, resolveOrigin);
    if (!converted.ok) return { ok: false, error: converted.error };
    if (converted.skip) continue;
    api[String(n.id)] = { class_type: n.type, inputs: converted.inputs };
    if (n._meta && n._meta.title) api[String(n.id)]._meta = { title: n._meta.title };
  }
  if (!Object.keys(api).length) return { ok: false, error: 'No executable nodes found in this workflow' };
  return { ok: true, graph: api };
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

// Every node class name ComfyUI reports, sorted — so the UI can
// show exactly what an install has, instead of only the familiar
// families. Returns [] when /object_info is missing or not an
// object; never invents a node.
function nodeClassNames(objectInfo) {
  if (!objectInfo || typeof objectInfo !== 'object' || Array.isArray(objectInfo)) return [];
  return Object.keys(objectInfo).sort();
}

// Capabilities actually present in this ComfyUI install, computed
// from the node class names in /object_info — never hardcoded.
// A capability is only listed when the install really has the nodes
// for it. Image generation is recognised two ways: the classic
// checkpoint path (KSampler + CheckpointLoader) and the newer
// split-model path (a sampler + a UNet loader + a CLIP loader +
// a VAE loader), which is how Flux / SD3-style graphs are built —
// those never use CheckpointLoaderSimple, so the old check missed
// them entirely. Matching is case-insensitive, so a custom node
// named e.g. "MyKSampler" still counts as a sampler.
function detectCapabilities(objectInfo) {
  if (!objectInfo || typeof objectInfo !== 'object') return [];
  const classes = Object.keys(objectInfo);
  const has = (...names) => names.some(n => classes.includes(n));
  const any = (re) => classes.some(c => re.test(c));
  const hasSampler = has('KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced') || any(/sampler/i);
  const hasCheckpoint = has('CheckpointLoader', 'CheckpointLoaderSimple') || any(/checkpointloader/i);
  const hasUnet = has('UNETLoader', 'UNETLoaderGGUF') || any(/unetloader/i);
  const hasClipLoader = has('CLIPLoader', 'DualCLIPLoader', 'CLIPLoaderGGUF') || any(/cliploader/i);
  const hasVaeLoader = has('VAELoader') || any(/vaeloader/i);
  const caps = [];
  if (hasSampler && (hasCheckpoint || (hasUnet && hasClipLoader && hasVaeLoader))) {
    caps.push({ id: 'image', label: 'Image generation' });
  }
  if (has('SaveVideo', 'SaveWEBM', 'SaveAnimatedWEBP', 'VHS_VideoCombine', 'CreateVideo') || any(/video/i)) {
    caps.push({ id: 'video', label: 'Video generation' });
  }
  if (any(/upscale/i)) caps.push({ id: 'upscale', label: 'Upscaling' });
  if (any(/controlnet/i)) caps.push({ id: 'controlnet', label: 'ControlNet' });
  if (any(/inpaint/i)) caps.push({ id: 'inpaint', label: 'Inpainting' });
  if (has('LoadImage', 'LoadImageMask')) caps.push({ id: 'img2img', label: 'Image-to-image' });
  if (any(/lora/i)) caps.push({ id: 'lora', label: 'LoRA support' });
  if (any(/ipadapter/i)) caps.push({ id: 'ipadapter', label: 'IP-Adapter' });
  return caps;
}

// Describe the SIMPLE generation form for a workflow, from its
// already-parsed inputs only — no guessing, no fake fields. The
// renderer builds the form from this; the advanced panel still
// shows every input, but this is the Midjourney-easy layer:
//   prompts — CLIPTextEncode text inputs, labelled by role when
//     the wiring says which is positive (KSampler / BasicGuider
//     links, see parseWorkflowGraph); when the wiring cannot tell
//     them apart, role is null and the renderer labels them
//     "Prompt 1" / "Prompt 2" and says so.
//   samplers — KSampler / KSamplerAdvanced nodes, with only the
//     seed / steps / cfg / denoise inputs that node actually has.
//   sizes — EmptyLatentImage nodes, with their width / height.
//   hasPrompt — false when no text-prompt input exists at all, so
//     the renderer can say so plainly instead of showing fake
//     prompt boxes.
function describeSimpleForm(parsedInputs) {
  const inputs = Array.isArray(parsedInputs) ? parsedInputs : [];
  const textInputs = inputs.filter(i => i.classType === 'CLIPTextEncode' && i.inputName === 'text');
  const prompts = textInputs.map(i => ({
    key: i.role === 'positive' ? 'positive' : i.role === 'negative' ? 'negative' : i.nodeId + '.text',
    nodeId: i.nodeId,
    role: i.role || null,
    label: i.role === 'positive' ? 'Prompt' : i.role === 'negative' ? 'Negative prompt' : null,
    value: i.value,
  }));
  const samplerFields = ['seed', 'steps', 'cfg', 'denoise'];
  const samplerByNode = {};
  for (const i of inputs) {
    if ((i.classType === 'KSampler' || i.classType === 'KSamplerAdvanced') && samplerFields.includes(i.inputName)) {
      (samplerByNode[i.nodeId] = samplerByNode[i.nodeId] || { nodeId: i.nodeId, classType: i.classType, fields: [] })
        .fields.push({ key: i.nodeId + '.' + i.inputName, inputName: i.inputName, value: i.value });
    }
  }
  const sizeByNode = {};
  for (const i of inputs) {
    if (i.classType === 'EmptyLatentImage' && (i.inputName === 'width' || i.inputName === 'height')) {
      const s = (sizeByNode[i.nodeId] = sizeByNode[i.nodeId] || { nodeId: i.nodeId, width: null, height: null });
      s[i.inputName] = typeof i.value === 'number' ? i.value : null;
    }
  }
  return {
    prompts,
    samplers: Object.values(samplerByNode),
    sizes: Object.values(sizeByNode),
    hasPrompt: prompts.length > 0,
  };
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

// Bounded recursive file lister: files with one of the given
// extensions under dir, at most maxDepth deep and maxFiles files,
// sorted. Returns [] when the folder does not exist. Never walks
// a whole drive — the caller names the root.
const MODEL_FILE_EXTS = ['.safetensors', '.ckpt', '.pt', '.pth', '.gguf', '.bin'];
function listFilesRecursive(dir, exts, maxDepth, maxFiles) {
  const out = [];
  const wanted = (exts || []).map(e => String(e).toLowerCase());
  const maxF = maxFiles || 500;
  const maxD = maxDepth == null ? 5 : maxDepth;
  function walk(d, depth) {
    if (out.length >= maxF || depth > maxD) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= maxF) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < maxD) walk(full, depth + 1); }
      else if (e.isFile() && wanted.includes(path.extname(e.name).toLowerCase())) out.push(full);
    }
  }
  try { if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) walk(dir, 0); } catch {}
  return out;
}

// Count model files per category under a models/ folder. The
// categories are the ones ComfyUI actually uses: modern models
// (Flux, Qwen, LTX) live in diffusion_models / text_encoders, not
// checkpoints — an earlier list that only counted checkpoints,
// loras, vae, clip, unet, controlnet, embeddings and
// upscale_models reported "vae 1" for an install running those
// models, which looked wrong because it was.
function countModels(modelsDir) {
  const categories = ['checkpoints', 'diffusion_models', 'text_encoders', 'clip', 'clip_vision', 'vae', 'loras', 'unet', 'controlnet', 'embeddings', 'upscale_models'];
  const counts = {};
  for (const cat of categories) {
    counts[cat] = listFilesRecursive(path.join(modelsDir, cat), MODEL_FILE_EXTS, 4, 10000).length;
  }
  return counts;
}

// Candidate ComfyUI install roots on Windows, in check order.
// `overrides` ({ home, appData, localAppData, drives }) exists so
// tests can point the scan at temp folders; in the app it is
// omitted and the real locations are used. The program-folder
// entry is special: it lists subdirectories whose name contains
// "comfyui" instead of being a root itself.
function comfyuiCandidateRoots(overrides) {
  const o = overrides || {};
  const home = o.home || os.homedir();
  const appData = o.appData || process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = o.localAppData || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const drives = o.drives !== undefined ? o.drives : ['C:', 'D:'];
  const roots = [
    { label: 'ComfyUI Desktop user data', path: path.join(appData, 'ComfyUI') },
    { label: 'Documents', path: path.join(home, 'Documents', 'ComfyUI') },
    { label: 'Home folder', path: path.join(home, 'ComfyUI') },
  ];
  for (const d of drives) roots.push({ label: 'Portable install (' + d + ')', path: path.join(d + path.sep, 'ComfyUI') });
  roots.push({ label: 'Program folder', path: path.join(localAppData, 'Programs'), programFolder: true });
  return roots;
}

const SCAN_WORKFLOW_RELS = ['user/default/workflows', 'workflows', 'ComfyUI/user/default/workflows'];
const SCAN_MODEL_RELS = ['models', 'user/default/models', 'ComfyUI/models'];
const SCAN_CUSTOM_NODES_RELS = ['custom_nodes', 'ComfyUI/custom_nodes'];

// ComfyUI Desktop's own config: %APPDATA%\ComfyUI\config.json
// carries the user-chosen base directory as `basePath`, and
// extra_models_config.yaml carries `base_path:` for legacy installs
// (Desktop 1.x also writes per-install model paths under
// %APPDATA%\Comfy Desktop\instance-model-paths\, which is not a
// single path — not read here). Best-effort: a missing or
// unreadable config just means no extra root. The YAML read is
// deliberately minimal — one top-level `base_path:` line —
// because CodeFox has no YAML dependency.
function readDesktopConfig(overrides) {
  const o = overrides || {};
  const home = o.home || os.homedir();
  const appData = o.appData || process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const out = { basePath: null, modelPaths: null, configFile: null, extraModelsFile: null };
  const cfgFile = path.join(appData, 'ComfyUI', 'config.json');
  try {
    if (fs.existsSync(cfgFile)) {
      out.configFile = cfgFile;
      const data = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      if (data && typeof data.basePath === 'string' && data.basePath.trim()) out.basePath = data.basePath.trim();
    }
  } catch {}
  const yamlFile = path.join(appData, 'ComfyUI', 'extra_models_config.yaml');
  try {
    if (fs.existsSync(yamlFile)) {
      out.extraModelsFile = yamlFile;
      const text = fs.readFileSync(yamlFile, 'utf8');
      const m = text.match(/^\s*base_path\s*:\s*["']?([^"'\r\n#]+?)["']?\s*$/m);
      if (m && m[1].trim()) out.modelPaths = m[1].trim();
    }
  } catch {}
  return out;
}

// The ComfyUI Desktop executable: *.exe files at the top level of
// a program-folder install. Never guessed — only a file that
// actually exists is returned, preferring one whose name contains
// "ComfyUI".
function findDesktopExe(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.exe')).sort(); } catch { return null; }
  if (!files.length) return null;
  const preferred = files.find(f => /comfyui/i.test(f)) || files[0];
  return path.join(dir, preferred);
}

// Count *.json files in a folder (top level only). 0 when the
// folder does not exist.
function countJsonFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).length; } catch { return 0; }
}

// Where ComfyUI Desktop's built-in/template workflows live on disk
// (verified against the Desktop layout, see README):
//   - <install>/web_custom_versions/<frontend-pkg>/<ver>/templates/*.json
//     (the workflow-templates package, served by the frontend)
//   - %LOCALAPPDATA%\uv\cache\archive-v0\<hash>\comfyui_workflow_templates_json\templates/*.json
//     (the same package in uv's cache — the installer's copy)
//   - <install>/custom_nodes/<pack>/example_workflows/*.json
//     (also `workflows`, `workflow`, `example`, `examples` — a
//     single directory level only, per ComfyUI's own rule)
// Each finder returns [{ dir, count, kind }]. Only files that
// exist are listed; a missing location is simply absent, never
// invented.
function findFrontendTemplateDirs(base) {
  const out = [];
  const wcv = path.join(base, 'web_custom_versions');
  let pkgs = [];
  try { pkgs = fs.readdirSync(wcv, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return out; }
  for (const pkg of pkgs) {
    let vers = [];
    try { vers = fs.readdirSync(path.join(wcv, pkg), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { continue; }
    for (const v of vers) {
      const dir = path.join(wcv, pkg, v, 'templates');
      const count = countJsonFiles(dir);
      if (count) out.push({ dir, count, kind: 'frontend' });
    }
  }
  return out;
}

function findCustomNodeExampleDirs(base) {
  const out = [];
  const cn = path.join(base, 'custom_nodes');
  let packs = [];
  try { packs = fs.readdirSync(cn, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return out; }
  for (const pack of packs) {
    for (const rel of ['example_workflows', 'workflows', 'workflow', 'example', 'examples']) {
      const dir = path.join(cn, pack, rel);
      const count = countJsonFiles(dir);
      if (count) out.push({ dir, count, kind: 'custom-node' });
    }
  }
  return out;
}

function findUvCacheTemplateDirs(localAppData) {
  const out = [];
  const cacheRoot = path.join(localAppData, 'uv', 'cache');
  // The package is an extracted archive/wheel: check the cache
  // subtrees that hold extracted packages directly (one level of
  // hash folders), then a bounded generic walk as a fallback.
  for (const sub of ['archive-v0', 'wheels-v5']) {
    let hashes = [];
    try { hashes = fs.readdirSync(path.join(cacheRoot, sub), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { continue; }
    for (const h of hashes) {
      const dir = path.join(cacheRoot, sub, h, 'comfyui_workflow_templates_json', 'templates');
      const count = countJsonFiles(dir);
      if (count) out.push({ dir, count, kind: 'uv-cache' });
      if (out.length >= 5) return out;
    }
  }
  if (out.length) return out;
  let visited = 0;
  const walk = (d, depth) => {
    if (out.length >= 5 || visited > 500 || depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      visited++;
      const full = path.join(d, e.name);
      if (e.name === 'comfyui_workflow_templates_json') {
        const dir = path.join(full, 'templates');
        const count = countJsonFiles(dir);
        if (count) out.push({ dir, count, kind: 'uv-cache' });
        continue;
      }
      if (depth < 6) walk(full, depth + 1);
      if (out.length >= 5 || visited > 500) return;
    }
  };
  try { if (fs.existsSync(cacheRoot) && fs.statSync(cacheRoot).isDirectory()) walk(cacheRoot, 0); } catch {}
  return out;
}

// Scan the standard Windows locations for a ComfyUI install.
// Filesystem only, synchronous, fast and bounded: only the listed
// candidate roots are checked, no whole-drive walk. Returns
// { ok, roots, workflowsDir, desktopExe, templateDirs,
//   desktopConfig } where each root reports exactly what was found
// there (workflows folder + .json count, model counts per
// category + which models folder was checked, custom_nodes
// presence, the Desktop exe when the root is a program folder,
// and any built-in template folders) or found: false.
// workflowsDir is the first workflows folder with files in it,
// falling back to the first workflows folder that exists at all.
// desktopExe is the first ComfyUI Desktop executable actually
// found on disk, or null. templateDirs lists every built-in
// template folder found (frontend package, uv cache, custom-node
// examples), each with its .json count — only folders that exist.
// desktopConfig is what Desktop's own config said (basePath /
// base_path), or nulls when there is no config to read.
function scanComfyui(overrides) {
  const o = overrides || {};
  const home = o.home || os.homedir();
  const localAppData = o.localAppData || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roots = comfyuiCandidateRoots(overrides);
  roots.push({ label: 'ComfyUI Desktop shared models', path: path.join(localAppData, 'Comfy-Desktop', 'ComfyUI-Shared') });
  roots.push({ label: 'ComfyUI Desktop installs', path: path.join(localAppData, 'Comfy-Desktop', 'ComfyUI-Installs'), programFolder: 'all' });
  const desktopConfig = readDesktopConfig(overrides);
  if (desktopConfig.basePath) roots.unshift({ label: 'ComfyUI Desktop user data (from config.json)', path: desktopConfig.basePath });
  if (desktopConfig.modelPaths) roots.push({ label: 'ComfyUI models (from extra_models_config.yaml)', path: desktopConfig.modelPaths });
  const results = [];
  const seenBases = new Set();
  let firstWithFiles = null;
  let firstExisting = null;
  let desktopExe = null;
  const templateDirs = [];
  const noteTemplateDir = (t) => {
    if (!templateDirs.some(x => x.dir === t.dir)) templateDirs.push(t);
  };
  for (const root of roots) {
    let bases = [root.path];
    if (root.programFolder) {
      let programsExists = false;
      try { programsExists = fs.existsSync(root.path) && fs.statSync(root.path).isDirectory(); } catch {}
      if (!programsExists) {
        results.push({ label: root.label, path: root.path, found: false, workflows: null, models: null, modelsDir: null, customNodes: false, checked: [], exe: null, templates: null });
        continue;
      }
      const found = [];
      try {
        for (const e of fs.readdirSync(root.path, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          if (root.programFolder === 'all' || /comfyui/i.test(e.name)) found.push(path.join(root.path, e.name));
        }
      } catch {}
      if (!found.length) {
        results.push({ label: root.label, path: root.path, found: true, note: root.programFolder === 'all' ? 'No installs inside' : 'No folder named *ComfyUI* inside', workflows: null, models: null, modelsDir: null, customNodes: false, checked: [], exe: null, templates: null });
        continue;
      }
      bases = found;
    }
    for (const base of bases) {
      const baseKey = base.toLowerCase();
      if (seenBases.has(baseKey)) continue; // same folder via two roots (e.g. config.json == Documents) — report once
      seenBases.add(baseKey);
      const entry = { label: root.label, path: base, found: false, workflows: null, models: null, modelsDir: null, customNodes: false, checked: [], exe: null, templates: null };
      let baseExists = false;
      try { baseExists = fs.existsSync(base) && fs.statSync(base).isDirectory(); } catch {}
      if (!baseExists) { results.push(entry); continue; }
      entry.found = true;
      for (const rel of SCAN_WORKFLOW_RELS) {
        const dir = path.join(base, rel);
        entry.checked.push(rel);
        let exists = false;
        try { exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory(); } catch {}
        if (exists) {
          const files = listFilesRecursive(dir, ['.json'], 5, 500);
          entry.workflows = { dir, count: files.length };
          if (files.length && !firstWithFiles) firstWithFiles = dir;
          if (!firstExisting) firstExisting = dir;
          break;
        }
      }
      for (const rel of SCAN_MODEL_RELS) {
        const dir = path.join(base, rel);
        let exists = false;
        try { exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory(); } catch {}
        if (exists) {
          entry.modelsDir = dir;
          entry.models = countModels(dir);
          break;
        }
      }
      for (const rel of SCAN_CUSTOM_NODES_RELS) {
        const dir = path.join(base, rel);
        try { if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) { entry.customNodes = true; break; } } catch {}
      }
      if (root.programFolder) {
        const exe = findDesktopExe(base);
        if (exe) { entry.exe = exe; if (!desktopExe) desktopExe = exe; }
      }
      const tpl = [...findFrontendTemplateDirs(base), ...findCustomNodeExampleDirs(base)];
      if (tpl.length) {
        entry.templates = { count: tpl.reduce((a, t) => a + t.count, 0), dirs: tpl.map(t => t.dir) };
        for (const t of tpl) noteTemplateDir(t);
      }
      results.push(entry);
    }
  }
  for (const t of findUvCacheTemplateDirs(localAppData)) noteTemplateDir(t);
  return {
    ok: true,
    roots: results,
    workflowsDir: firstWithFiles || firstExisting || null,
    checkedRoots: results.length,
    foundRoots: results.filter(r => r.found).length,
    desktopExe,
    templateDirs,
    desktopConfig,
  };
}

// Read the given *.json files as workflow graphs and catalogue
// them. `stored` is the previously saved catalogue (by id) so a
// user's purpose label and approval survive a rescan.
// opts.source is 'user' (workflows the user saved) or 'builtin'
// (ComfyUI Desktop's built-in templates); opts.titleByName maps a
// filename stem to { title, description } from the server's
// /api/workflow_templates catalogue, and opts.defaultPurpose is
// the purpose label for entries with no stored label. Returns
// { ok, workflows, errors }. A file that is not valid JSON, is
// not a workflow graph, or (for UI-format graphs) cannot be
// converted without /object_info is reported in `errors` with its
// filename and reason — never a silent zero.
function importWorkflowsFromFiles(files, objectInfo, stored, opts) {
  const byId = {};
  for (const s of (stored || [])) if (s && s.id) byId[s.id] = s;
  const source = (opts && opts.source) || 'user';
  const defaultPurpose = (opts && opts.defaultPurpose) || 'Unlabelled — set a purpose';
  const titleByName = (opts && opts.titleByName) || {};
  const workflows = [];
  const errors = [];
  const seenIds = new Set();
  for (const full of (files || [])) {
    const file = path.basename(full);
    const stem = file.replace(/\.json$/i, '');
    const meta = titleByName[stem] || titleByName[file] || null;
    const name = (source === 'builtin' && meta && meta.title) ? meta.title : stem;
    let id = (source === 'builtin' ? 'tpl-' : '') + slugifyWorkflowId(name);
    if (seenIds.has(id)) {
      // Two folders with the same filename: keep both, labelled
      // by their parent folder. Stored labels keyed by the plain id
      // do not carry over to the suffixed copy.
      id = id + '-' + slugifyWorkflowId(path.basename(path.dirname(full)));
    }
    seenIds.add(id);
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
      id, name, file: full, source,
      description: (source === 'builtin' && meta && meta.description) ? meta.description : '',
      purpose: (prev && prev.purpose) || defaultPurpose,
      inputs: parsed.inputs,
      outputs: parsed.outputs,
      missing: parsed.missing,
      available: parsed.available,
      availableReason: parsed.availableReason,
      approved: !!(prev && prev.approved),
      // The simple generation form for this workflow (prompt /
      // sampler / size), computed once here so the renderer never
      // has to guess at it. See describeSimpleForm().
      simpleForm: describeSimpleForm(parsed.inputs),
    });
  }
  return { ok: true, workflows, errors };
}

// Read every *.json in a folder as a workflow graph and catalogue
// them. `stored` is the previously saved catalogue (by id) so a
// user's purpose label and approval survive a rescan. With
// opts.recursive, subfolders are walked too (bounded); without it
// only the top level is read, as before. Returns
// { ok, workflows, errors }.
function importWorkflowsFromDir(dir, objectInfo, stored, opts) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Workflows folder not found: ' + (dir || '(none set)'), workflows: [] };
  let files = [];
  if (opts && opts.recursive) {
    files = listFilesRecursive(dir, ['.json'], 5, 500);
  } else {
    try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).sort().map(f => path.join(dir, f)); } catch (e) {
      return { ok: false, error: 'Could not read workflows folder: ' + e.message, workflows: [] };
    }
  }
  return importWorkflowsFromFiles(files, objectInfo, stored, opts);
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
  slugifyWorkflowId,
  parseWorkflowGraph,
  buildSubmitPrompt,
  detectCapabilities,
  nodeClassNames,
  describeSimpleForm,
  scanComfyui,
  defaultWorkflowsDir,
  importWorkflowsFromDir,
  importWorkflowsFromFiles,
  isUiWorkflowGraph,
  convertUiGraphToApi,
  readDesktopConfig,
  findDesktopExe,
  findFrontendTemplateDirs,
  findCustomNodeExampleDirs,
  findUvCacheTemplateDirs,
};
