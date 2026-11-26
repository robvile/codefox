// comfyui-scan.js — finding ComfyUI on disk and importing
// workflow files (split out of comfyui.js in v0.17.0).
//
// Plain Node, no Electron dependency. The scan checks the standard
// Windows locations for a ComfyUI install (Desktop user data,
// Documents, portable installs, the program folder, Desktop 1.x
// locations, and whatever Desktop's own config points at) and
// reports exactly what it found at each place — never invented.
// importWorkflowsFromFiles catalogues *.json files as workflow
// graphs; a file that is not a workflow at all is silently
// ignored, a file that fails to parse is reported.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseWorkflowGraph, describeSimpleForm, isWorkflowGraph, isWorkflowJsonFile, slugifyWorkflowId } = require('./comfyui-workflows');

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

// Count *.json files in a folder (top level only) that are
// actually workflow graphs. 0 when the folder does not exist.
// The template package ships locale files (index*.json) next to
// its workflows — those are not workflows and must not inflate
// the count. See isWorkflowGraph.
function countWorkflowJsonFiles(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')); } catch { return 0; }
  let count = 0;
  for (const f of files) {
    if (isWorkflowJsonFile(path.join(dir, f))) count++;
  }
  return count;
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
      const count = countWorkflowJsonFiles(dir);
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
      const count = countWorkflowJsonFiles(dir);
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
      const count = countWorkflowJsonFiles(dir);
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
        const count = countWorkflowJsonFiles(dir);
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
          // Only workflow graphs count — a workflows folder can
          // hold other JSON too, and those are not workflows.
          const files = listFilesRecursive(dir, ['.json'], 5, 500).filter(isWorkflowJsonFile);
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
// { ok, workflows, errors }. A file that is not valid JSON, or
// (for UI-format graphs) cannot be converted without
// /object_info, is reported in `errors` with its filename and
// reason — never a silent zero. A file that is not a workflow at
// all (a locale file, a random JSON file) is silently ignored
// instead: it is not an import problem.
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
    let graph;
    let rawText = '';
    try {
      rawText = fs.readFileSync(full, 'utf8');
      graph = JSON.parse(rawText);
    } catch (e) {
      errors.push(file + ': not valid JSON — ' + e.message);
      continue;
    }
    // Not a workflow at all (a locale file, a random JSON file):
    // silently ignored — it is not an import problem, it does
    // not count as a file found, and it must not claim an id a
    // real workflow of the same name would need. See
    // isWorkflowGraph.
    if (!isWorkflowGraph(graph)) continue;
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
      // v0.17.0: the content hash of the workflow file, so the
      // provenance sidecar can say exactly which version of the
      // workflow made an image — and a Regenerate can refuse when
      // the workflow has changed since. The import profile chosen
      // for this workflow survives a rescan like purpose and
      // approval do.
      hash: fnv1aHash(rawText),
      importProfile: (prev && prev.importProfile) || '',
      // v0.8.0: pin / hide / last-used survive a rescan exactly
      // like purpose and approval — the library is the user's
      // curated view, and a rescan must never un-pin, un-hide, or
      // forget what was used recently.
      pinned: !!(prev && prev.pinned),
      hidden: !!(prev && prev.hidden),
      lastUsedAt: (prev && typeof prev.lastUsedAt === 'number') ? prev.lastUsedAt : 0,
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

// FNV-1a over a string, as a hex digest — a cheap content hash for
// a workflow file, so the provenance sidecar can say exactly which
// version of a workflow made an image. No new dependency; this is
// an identifier, not a security hash.
function fnv1aHash(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function workflowFileHash(file) {
  try { return fnv1aHash(fs.readFileSync(file, 'utf8')); } catch { return ''; }
}

module.exports = {
  scanComfyui,
  defaultWorkflowsDir,
  importWorkflowsFromDir,
  importWorkflowsFromFiles,
  readDesktopConfig,
  findDesktopExe,
  findFrontendTemplateDirs,
  findCustomNodeExampleDirs,
  findUvCacheTemplateDirs,
  fnv1aHash,
  workflowFileHash,
};
