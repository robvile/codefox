// comfyui-workflows.js — workflow graphs (split out of comfyui.js
// in v0.17.0).
//
// Everything CodeFox knows about a ComfyUI workflow without running
// it: parsing an API-format graph (inputs labelled by role,
// outputs, missing nodes/models), converting UI-format (LiteGraph)
// graphs to API format, the simple prompt-first form, capability
// detection from /object_info, variation planning, and the import
// profiles applied when a generated image lands in the project.
// Plain Node, no Electron dependency.

const fs = require('fs');

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

// Where a missing node type comes from, when that is actually
// known — so the error can tell the user what to pull into
// ComfyUI instead of just naming the type. Only entries a source
// really attributes are listed; anything else reports no pack
// (the message stays the plain "Node type not installed").
//   * ImageRemoveAlpha+ is in ComfyUI Essentials
//     (ComfyUI_essentials) — ComfyUI Registry node list and the
//     runcomfy install page both list it there.
//   * LumaImageModifyNode / LumaReferenceNode /
//     LumaImageToVideoNode / LumaVideoNode are NOT a custom-node
//     pack: they are ComfyUI's own built-in Luma Partner Nodes
//     (comfy_api_nodes, category "api node/..."), documented on
//     docs.comfy.org as natively integrated nodes that ship with
//     ComfyUI and can be switched off with --disable-partner-nodes
//     or offline mode — so there is nothing to install via
//     Manager, and the message says that instead of sending the
//     user to install something that does not exist.
const MISSING_NODE_PACKS = {
  'ImageRemoveAlpha+': {
    pack: 'ComfyUI Essentials (ComfyUI_essentials)',
    action: 'install it in ComfyUI Desktop (ComfyUI Manager) and Rescan',
  },
  'LumaImageModifyNode': {
    pack: "ComfyUI's built-in Luma Partner Nodes",
    action: 'they ship with ComfyUI, not a custom-node pack — update ComfyUI Desktop and make sure Partner Nodes are enabled, then Rescan',
  },
  'LumaReferenceNode': {
    pack: "ComfyUI's built-in Luma Partner Nodes",
    action: 'they ship with ComfyUI, not a custom-node pack — update ComfyUI Desktop and make sure Partner Nodes are enabled, then Rescan',
  },
  'LumaImageToVideoNode': {
    pack: "ComfyUI's built-in Luma Partner Nodes",
    action: 'they ship with ComfyUI, not a custom-node pack — update ComfyUI Desktop and make sure Partner Nodes are enabled, then Rescan',
  },
  'LumaVideoNode': {
    pack: "ComfyUI's built-in Luma Partner Nodes",
    action: 'they ship with ComfyUI, not a custom-node pack — update ComfyUI Desktop and make sure Partner Nodes are enabled, then Rescan',
  },
};

// The "Node type not installed" message, with the pack attached
// when it is known. The pack rides after an em-dash so the
// import-problems grouping can still group by node type.
function missingNodeTypeMessage(classType, id) {
  const base = 'Node type not installed: ' + classType + ' (node ' + id + ')';
  const known = MISSING_NODE_PACKS[classType];
  if (!known) return base;
  return base + ' — ' + known.pack + '; ' + known.action;
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
      missing.push(missingNodeTypeMessage(classType, id));
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
// skipped — they are never executed. Bypassed (mode 4) and muted
// (mode 2) nodes and PrimitiveNodes are NOT failures: the
// frontend's graphToPrompt resolves them before a prompt is ever
// built — a bypassed node becomes a pass-through link, a muted
// node and its links are dropped, a PrimitiveNode's value is
// written straight into the downstream widget — and this
// converter mirrors that (see resolveSkippedUiNodes). Only a
// required input left with nothing to feed it fails, naming the
// downstream node.
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

// An API-format workflow is an object with at least one
// numeric-keyed node carrying a class_type. A JSON file that is
// neither this nor a UI-format graph is not a workflow at all —
// the locale/translation files (index*.json) the template package
// ships, or any other stray JSON — and must be silently ignored
// by the import, never listed as an import problem.
function isApiWorkflowGraph(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return false;
  return Object.keys(graph).some(k => /^\d+$/.test(k)
    && graph[k] && typeof graph[k] === 'object' && typeof graph[k].class_type === 'string');
}

function isWorkflowGraph(graph) {
  return isUiWorkflowGraph(graph) || isApiWorkflowGraph(graph);
}

// True when a file on disk parses as a workflow graph (either
// format). Never throws — unreadable or malformed JSON is not a
// workflow; malformed files are still reported by the import
// itself (see importWorkflowsFromFiles), this is only the
// "is it a workflow at all" question the scan counts ask.
function isWorkflowJsonFile(file) {
  try {
    return isWorkflowGraph(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch { return false; }
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

// One def input by name: { spec, required }. Null when the def
// has no such input (a custom node whose definition the install
// does not report, or a stale name in an old file).
function uiDefInputSpec(def, name) {
  const groups = (def && def.input) || {};
  for (const [groupName, group] of [['required', groups.required], ['optional', groups.optional]]) {
    if (group && Object.prototype.hasOwnProperty.call(group, name)) {
      return { spec: group[name], required: groupName === 'required' };
    }
  }
  return null;
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
  // Clone nodes DEEPLY enough that conversion never mutates the
  // caller's graph: expansion and the skipped-node pass edit input
  // entries in place (link ids, __literal values), and a shallow
  // clone would share those entries with the stored workflow —
  // converting the same graph twice would then see the first
  // conversion's edits.
  const cloneUiNode = (n) => ({
    ...n,
    inputs: Array.isArray(n.inputs) ? n.inputs.map(i => ({ ...i })) : n.inputs,
    outputs: Array.isArray(n.outputs) ? n.outputs.map(o => ({ ...o, links: Array.isArray(o.links) ? [...o.links] : o.links })) : n.outputs,
  });
  const plainNodes = (uiGraph.nodes || []).map(cloneUiNode);
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
    // A bypassed (mode 4) or muted (mode 2) instance is NOT
    // expanded: the frontend never runs a muted/bypassed
    // subgraph's inner nodes — the instance is bypassed like any
    // other node (see resolveSkippedUiNodes below), so it stays
    // one node and the passthrough/drop logic handles it.
    const idx = nodes.findIndex(n => subgraphs[String(n.type)] && n.mode !== 2 && n.mode !== 4 && (n.__depth || 0) < UI_SUBGRAPH_MAX_DEPTH);
    if (idx < 0) break;
    const inst = nodes[idx];
    const sub = subgraphs[String(inst.type)];
    const depth = inst.__depth || 0;
    const idMap = new Map();
    const newNodes = [];
    for (const sn of (sub.nodes || [])) {
      const fresh = ++maxId;
      idMap.set(sn.id, fresh);
      const clone = { ...cloneUiNode(sn), id: fresh, __depth: depth + 1 };
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
  const stuck = nodes.find(n => subgraphs[String(n.type)] && n.mode !== 2 && n.mode !== 4);
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
    return { ok: false, error: missingNodeTypeMessage(node.type, node.id) };
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

// Resolve the nodes ComfyUI's own frontend never executes, the
// way its graphToPrompt does — before conversion, so a workflow
// full of them converts instead of failing:
//   * bypassed (mode 4): the node is left out and each outgoing
//     link is rewired to whatever feeds the node's matching
//     input — the same-slot input when it is connected, else the
//     first connected input. That is the frontend's passthrough:
//     the converter resolves a bypassed node into a pass-through
//     link and the node disappears. A bypassed source node
//     (LoadImage, RecordAudio, …) has no input to pass through,
//     so its outgoing links are dropped and the downstream input
//     is left unconnected — valid for optional inputs, and for a
//     widget-backed input the node's own widget/default value
//     applies instead.
//   * muted (mode 2): the node and all of its links are dropped;
//     its outputs simply stop existing.
//   * PrimitiveNode: a virtual node (isVirtualNode in the
//     frontend, never in /object_info) whose value is written
//     straight into each downstream widget-backed input —
//     exactly what its applyToGraph does in the editor.
// A downstream REQUIRED link-typed input left with nothing to
// feed it is a genuine problem — but only when the downstream
// node SURVIVES into the final graph. A consumer that is itself
// bypassed / muted (a dead either/or branch — a bypassed
// CLIPLoader feeding a bypassed CLIPTextEncode) is removed by
// the same pass, so its unfed input is irrelevant and the
// conversion succeeds. The graph could not run in ComfyUI
// Desktop either when a surviving node is left unfed, so that
// case still fails naming the downstream node instead of
// producing a broken graph.
// Returns { ok, nodes, links, error }. The caller's arrays are
// not mutated (nodes/links are fresh copies); node objects are
// the expanded clones, so input entries may be edited in place.
// The required-input check only fires for a consumer that
// survives this pass: a skipped consumer is a dead branch, and
// links between two skipped nodes are dropped silently.
function resolveSkippedUiNodes(nodes, links, objectInfo) {
  let outNodes = nodes.slice();
  let outLinks = links.slice();
  const byId = new Map();
  const rebuild = () => { byId.clear(); for (const n of outNodes) byId.set(n.id, n); };
  rebuild();
  const linkById = new Map();
  for (const l of outLinks) linkById.set(l.id, l);
  const findEntry = (node, slot) => (node && Array.isArray(node.inputs) ? node.inputs[slot] : null) || null;
  const isRequiredLinkInput = (target, entryName) => {
    const def = objectInfo && target && objectInfo[target.type];
    if (!def) return false;
    const found = uiDefInputSpec(def, entryName);
    return !!(found && found.required && !uiDefInputIsWidget(found.spec));
  };
  // Ultimate non-Reroute consumers of one link: the frontend
  // resolves links through Reroutes, so a dropped link's real
  // consumers may sit behind one. Returns [{ node, entry }].
  const ultimateConsumers = (linkId) => {
    const seen = new Set();
    const found = [];
    const walk = (id) => {
      if (id == null || seen.has(id)) return;
      seen.add(id);
      const l = linkById.get(id);
      if (!l) return;
      const target = byId.get(l.targetId);
      if (!target) return;
      const entry = findEntry(target, l.targetSlot);
      if (!entry) return;
      if (target.type === 'Reroute') {
        for (const out of outLinks) if (out.originId === target.id) walk(out.id);
        return;
      }
      found.push({ node: target, entry });
    };
    walk(linkId);
    return found;
  };
  const removeLink = (linkId) => {
    const l = linkById.get(linkId);
    if (l) {
      const target = byId.get(l.targetId);
      const entry = target ? findEntry(target, l.targetSlot) : null;
      if (entry) entry.link = null;
    }
    linkById.delete(linkId);
    outLinks = outLinks.filter(x => x.id !== linkId);
  };
  // A dropped link that fed a required input of a SURVIVING
  // node is a real problem — name the downstream node so the user
  // knows what is broken. A consumer that is itself skipped is
  // gone from the final graph, so its unfed input is not one.
  const droppedLinkError = (kind, node, linkId) => {
    const consumers = ultimateConsumers(linkId);
    const bad = consumers.find(c => c.entry && c.entry.name && !skippedIds.has(c.node.id) && isRequiredLinkInput(c.node, c.entry.name));
    if (!bad) return null;
    const head = (kind === 'bypassed' ? 'Bypassed' : 'Muted') + ' node "' + (node.type || '?') + '" (id ' + node.id + ')';
    const tail = 'required input "' + bad.entry.name + '" of "' + (bad.node.type || '?') + '" (id ' + bad.node.id + ')';
    return kind === 'bypassed'
      ? head + ' has no connected input to pass through to ' + tail
      : head + ' leaves ' + tail + ' with nothing to feed it';
  };
  const skipped = outNodes.filter(n => n && (n.mode === 2 || n.mode === 4 || n.type === 'PrimitiveNode'));
  // A dead branch needs no feeding: a consumer that is itself
  // skipped is removed from the graph later in this same pass,
  // so an input it can no longer be fed is irrelevant. Only a
  // consumer that SURVIVES into the final graph can be left
  // genuinely unfed. (Desktop's templates are full of either/or
  // branches — a bypassed CLIPLoader feeding a bypassed
  // CLIPTextEncode, a bypassed UNETLoader feeding a bypassed
  // LoraLoader — where the whole branch is off by design; the
  // old check fired on those and wrongly failed the import.)
  const skippedIds = new Set(skipped.map(n => n.id));
  for (const node of skipped) {
    if (!byId.has(node.id)) continue;
    const outgoing = outLinks.filter(x => x.originId === node.id);
    if (node.mode === 4) {
      // Bypassed: rewire each outgoing link to the matching input.
      for (const l of outgoing) {
        const inputs = Array.isArray(node.inputs) ? node.inputs : [];
        let src = null;
        const same = inputs[l.originSlot];
        if (same && same.link != null && linkById.has(same.link)) src = same;
        if (!src) src = inputs.find(e => e && e.link != null && linkById.has(e.link)) || null;
        if (src) {
          const srcLink = linkById.get(src.link);
          l.originId = srcLink.originId;
          l.originSlot = srcLink.originSlot;
        } else {
          const err = droppedLinkError('bypassed', node, l.id);
          if (err) return { ok: false, error: err };
          removeLink(l.id);
        }
      }
    } else if (node.mode === 2) {
      // Muted: drop the node and all of its links.
      for (const l of outgoing) {
        const err = droppedLinkError('muted', node, l.id);
        if (err) return { ok: false, error: err };
        removeLink(l.id);
      }
    } else {
      // PrimitiveNode: inline its value into each downstream input.
      const value = Array.isArray(node.widgets_values) && node.widgets_values.length ? node.widgets_values[0] : undefined;
      for (const l of outgoing) {
        if (value !== undefined) {
          for (const c of ultimateConsumers(l.id)) c.entry.__literal = value;
        }
        removeLink(l.id);
      }
    }
    // Drop every link into the node, then the node itself.
    for (const l of outLinks.filter(x => x.targetId === node.id)) removeLink(l.id);
    outNodes = outNodes.filter(n => n.id !== node.id);
    rebuild();
  }
  return { ok: true, nodes: outNodes, links: outLinks };
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
  const resolved = resolveSkippedUiNodes(expanded.nodes, expanded.links, objectInfo);
  if (!resolved.ok) return resolved;
  const nodes = resolved.nodes;
  const links = resolved.links;
  const byId = new Map();
  for (const n of nodes) byId.set(n.id, n);
  const linkMap = new Map();
  for (const l of links) linkMap.set(l.id, l);
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

// ── Import profiles ──────────────────────────────────────────────
// The Unity TextureImporter settings applied to a generated image
// when it is imported into the project. The profile is chosen per
// workflow in the ComfyUI panel and stored on the workflow; the
// bridge owns the actual importer settings (apply_import_profile)
// — this list is only the names, labels and descriptions the UI
// shows. The smoke test pins the two lists to agree, so a profile
// renamed in one place fails loudly instead of silently never
// applying.
const IMPORT_PROFILES = [
  { id: 'sprite', label: 'Sprite', description: 'Sprite (2D): 100 pixels per unit, bilinear filtering, no mipmaps, repeat wrap — for sprites in the scene.' },
  { id: 'pixel-sprite', label: 'Pixel sprite', description: 'Pixel-art sprite: 16 pixels per unit, point filtering, no mipmaps, no compression — crisp pixels, no blur.' },
  { id: 'texture', label: 'Texture', description: 'Plain texture: mipmaps on, bilinear filtering, repeat wrap — for materials and 3D surfaces.' },
  { id: 'normal-map', label: 'Normal map', description: 'Normal map: linear (not sRGB), mipmaps on — a texture marked as a normal map is read correctly by the shader.' },
  { id: 'ui', label: 'UI image', description: 'UI sprite: 100 pixels per unit, bilinear filtering, no mipmaps, clamp wrap — for Canvas images and buttons.' },
];

function isValidImportProfile(id) {
  return IMPORT_PROFILES.some(p => p.id === String(id || '').trim().toLowerCase());
}

function normalizeImportProfile(id) {
  const v = String(id || '').trim().toLowerCase();
  return isValidImportProfile(v) ? v : '';
}

// ── Variation planning ────────────────────────────────────────────
// Decide how to run N variations of one generation, from the
// workflow's already-parsed inputs (its catalogue `inputs` array):
//   * a node with a `batch_size` input → one run with batch_size N
//     (the batch node renders N images in one go);
//   * else a `seed` input → N sequential runs, seed +0, +1, …
//   * else (no seed, no batch) → one run, with a plain note that
//     this workflow cannot vary (the outputs would be identical).
// `requested` is clamped to 1–4. Returns
// { count, mode: 'batch'|'sequential'|'single', batchNodeId?,
//   seedNodeId?, baseSeed?, note? }.
function clampVariations(n) {
  const v = Math.floor(Number(n));
  if (!isFinite(v) || v < 1) return 1;
  if (v > 4) return 4;
  return v;
}

function planVariations(parsedInputs, requested) {
  const count = clampVariations(requested);
  const inputs = Array.isArray(parsedInputs) ? parsedInputs : [];
  const batch = inputs.find(i => i.inputName === 'batch_size' && typeof i.value === 'number');
  if (batch) {
    return { count, mode: count > 1 ? 'batch' : 'single', batchNodeId: batch.nodeId, seedNodeId: null, baseSeed: null, note: null };
  }
  const seed = inputs.find(i => i.inputName === 'seed' && typeof i.value === 'number');
  if (seed) {
    return { count, mode: count > 1 ? 'sequential' : 'single', batchNodeId: null, seedNodeId: seed.nodeId, baseSeed: seed.value, note: null };
  }
  return {
    count: 1, mode: 'single', batchNodeId: null, seedNodeId: null, baseSeed: null,
    note: count > 1 ? 'This workflow has no seed or batch-size input, so variations would be identical — ran once.' : null,
  };
}

module.exports = {
  slugifyWorkflowId,
  parseWorkflowGraph,
  buildSubmitPrompt,
  detectCapabilities,
  nodeClassNames,
  describeSimpleForm,
  isUiWorkflowGraph,
  isApiWorkflowGraph,
  isWorkflowGraph,
  isWorkflowJsonFile,
  resolveSkippedUiNodes,
  convertUiGraphToApi,
  missingNodeTypeMessage,
  IMPORT_PROFILES,
  isValidImportProfile,
  normalizeImportProfile,
  clampVariations,
  planVariations,
};
