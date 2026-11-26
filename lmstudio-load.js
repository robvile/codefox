// Tuned LM Studio model loading (v0.8.3).
//
// CodeFox does NOT start the LM Studio server and does NOT load models by
// itself — it connects to a running server and loads a model into it with
// the tuned settings below. The 2.55 t/s Rob saw is entirely about how the
// model is loaded inside LM Studio: a model loaded with LM Studio's own
// defaults (4 parallel predictions, FP16 KV cache, partial GPU offload)
// crawls, because every token pays for work split across VRAM and system
// RAM. The tuned load puts everything on the GPU.
//
// The recipe is the one already proven on this exact machine by the
// RHEND Marketing fix (commit 1517000, 2026-11-25) and confirmed against
// LM Studio's own docs (https://lmstudio.ai/docs/developer/rest/load,
// https://lmstudio.ai/docs/developer/rest/list,
// https://lmstudio.ai/docs/app/advanced/per-model):
//
// Two channels, because LM Studio splits the settings between them:
// - The REST load body (POST /api/v1/models/load) carries context length,
//   eval batch size, flash attention, KV-cache offload and echo_load_config.
// - K/V cache quantization, max concurrent predictions and the GPU offload
//   ratio are NOT REST load fields. They live in LM Studio's per-model
//   saved settings, under <LM Studio home>/.internal/
//   user-concrete-model-default-config/<model>.json (keys llm.load.*), and
//   LM Studio applies them on every load of that model, "anywhere in the
//   app". So before each REST load the loader writes them there first.
//   The internal file path is not in LM Studio's docs (the gear dialog is
//   the supported way to set them); the path and format below are verified
//   against the files LM Studio itself writes, as the RHEND fix did.
//
// The profile is GLOBAL: it comes only from TUNED_LOAD_DEFAULTS and there
// is no per-model override for any of it, so no model can silently drop
// it. A model that genuinely cannot fit fully on the GPU even with a q8_0
// cache fails its load, and the error names the remedy, instead of
// silently spilling layers to system RAM and crawling.
//
// Safety: this only edits LM Studio's own per-model settings files, never
// model files. A file whose shape is not recognised is left untouched;
// the original is backed up (<file>.codefox-bak) before any edit; and
// the preset write never throws — a failure is reported so the REST load
// can still go ahead with the settings it can set.
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── The tuned defaults ─────────────────────────────────────────────
// The six global values, in one place. Every load reads only from
// here — there is no per-model table and no other copy of these numbers.
// Values are the ones tuned for this machine (RX 7900 XTX 24 GB, 96 GB
// RAM, Ryzen 9 X3D) for the Qwen3 Coder 30B A3B Q4_K_M, and they apply
// to ANY model CodeFox loads.
const TUNED_LOAD_DEFAULTS = {
  kvCacheQuantization: 'q8_0', // K and V cache, halved vs FP16
  maxParallelPredictions: 1, // one slot: each extra slot reserves its own KV cache
  gpuOffloadRatio: 1, // full GPU offload — nothing split to system RAM/CPU
  contextLength: 16384,
  evalBatchSize: 512,
  flashAttention: true, // required for V-cache quantization
};

// Plain-words version of the same settings, shown in Settings so the
// user can see what CodeFox is about to do.
const TUNED_LOAD_DESCRIPTION =
  'Loads with full GPU offload, KV cache Q8, 1 concurrent prediction, 16K context, flash attention';

// The global profile, as the preset file and the load body consume it.
function tunedLoadProfile() {
  return { ...TUNED_LOAD_DEFAULTS };
}

// ── The REST load body ─────────────────────────────────────────────
// Built only from TUNED_LOAD_DEFAULTS. offload_kv_cache_to_gpu is a
// fixed part of "full GPU offload" (the KV cache lives in VRAM, not
// system RAM); echo_load_config asks LM Studio to report the config it
// actually applied, so a slow load is diagnosable.
function buildLoadBody(modelId, withFlash = true) {
  const p = tunedLoadProfile();
  return {
    model: modelId,
    context_length: p.contextLength,
    ...(withFlash ? { flash_attention: p.flashAttention } : {}),
    offload_kv_cache_to_gpu: true,
    eval_batch_size: p.evalBatchSize,
    echo_load_config: true,
  };
}

// ── The recommended coding model ───────────────────────────────────
// Rob's target: Qwen3 Coder 30B A3B Instruct, Q4_K_M quant. Matched by
// id substring, case-insensitive, against the model's loadable
// identifier (selected_variant when LM Studio reports one, else the
// key). All five tokens must be present, so a different Qwen3 Coder
// size, a non-A3B 30B, or another quant does not match.
function isRecommendedCodingModel(model) {
  const id = typeof model === 'string' ? model : (model && (model.selected_variant || model.key || model.id)) || '';
  const norm = String(id).toLowerCase().replace(/-/g, '_');
  return norm.includes('qwen3') && norm.includes('coder') && norm.includes('30b')
    && norm.includes('a3b') && norm.includes('q4_k_m');
}

// ── Native model listing (v0.8.4) ─────────────────────────────────
// GET /v1/models (OpenAI-compatible) cannot be trusted for load
// state. LM Studio's own docs say it "returns the models visible to
// the server" and "may include all downloaded models when
// Just-In-Time loading is enabled"
// (https://www.lmstudio.ai/docs/developer/openai-compat/models), so a
// model appearing there may or may not be in memory. The native
// endpoints say so explicitly, and they also carry the context the
// model was actually loaded with — which is what the reply cap needs:
//   GET /api/v1/models -> { models: [{ key, type, display_name,
//     quantization: { name }, params_string, size_bytes, format,
//     selected_variant, max_context_length,
//     loaded_instances: [{ id, config: { context_length } }] }] }
//   GET /api/v0/models -> { data: [{ id, type, state:
//     'loaded' | 'not-loaded', loaded_context_length,
//     max_context_length, quantization }] }
//   (https://lmstudio.ai/docs/developer/rest/list,
//    https://lmstudio.ai/docs/developer/rest/endpoints)
// List order is newest first: /api/v1, then /api/v0 (LM Studio
// 0.3.6+), then the OpenAI-compatible list as a last resort, which
// only reports loaded models and carries no context length.

// Connection failures, in Inkwell's wording: unreachable vs timed
// out are different failures and say so. HTTP errors are not
// connection failures and keep their own wording upstream.
function lmStudioConnectionError(url, err) {
  const u = String(url || 'http://localhost:1234');
  if (err && err.name === 'AbortError') {
    return new Error('LM Studio at ' + u + ' did not answer in time — the server may be busy or still starting up.');
  }
  return new Error('Can\'t reach LM Studio at ' + u + '. Start the local server in LM Studio (Developer tab) and check the address in Settings.');
}

function positiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// One native-list entry, normalised across the v1 and v0 shapes.
// loadedContextLength is the window the running instance actually
// serves — never the architectural max_context_length.
function normalizeNativeModel(m, source) {
  if (!m || typeof m !== 'object') return null;
  if (source === 'v0') {
    const id = typeof m.id === 'string' ? m.id : (typeof m.key === 'string' ? m.key : null);
    if (!id) return null;
    const q = typeof m.quantization === 'string' ? m.quantization
      : (m.quantization && m.quantization.name) || null;
    return {
      id, displayName: id, type: m.type || 'llm', quantization: q,
      params: null, sizeBytes: null, format: null, variant: null,
      loaded: m.state === 'loaded',
      loadedContextLength: m.state === 'loaded' ? positiveNumber(m.loaded_context_length) : null,
      maxContextLength: positiveNumber(m.max_context_length),
      loadedIds: [],
    };
  }
  const id = typeof m.key === 'string' ? m.key : (typeof m.id === 'string' ? m.id : null);
  if (!id) return null;
  const instances = Array.isArray(m.loaded_instances) ? m.loaded_instances : [];
  const firstCtx = instances.length && instances[0] && instances[0].config
    ? positiveNumber(instances[0].config.context_length) : null;
  return {
    id, displayName: m.display_name || id, type: m.type || 'llm',
    quantization: (m.quantization && m.quantization.name) || null,
    params: m.params_string || null, sizeBytes: m.size_bytes || null,
    format: m.format || null, variant: m.selected_variant || null,
    loaded: instances.length > 0, loadedContextLength: firstCtx,
    maxContextLength: positiveNumber(m.max_context_length),
    loadedIds: instances.map(i => i && i.id).filter(Boolean),
  };
}

// Only LLM entries are offered as chat models — embedding (and
// decision) models are filtered out, as before.
function mapNativeModels(raw, source) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    const n = normalizeNativeModel(m, source);
    if (n && String(n.type).toLowerCase() === 'llm') out.push(n);
  }
  return out;
}

// One native-list fetch: { found: true, data } when the endpoint
// exists and answered, { found: false } on 404/405 (endpoint not
// on this server). Any other HTTP error throws; a connection
// failure throws too, and the caller turns it into plain words.
async function fetchNativeList(root, headers, path, fetchImpl, timeoutMs) {
  const res = await withTimeout(fetchImpl, root + path, { headers }, timeoutMs);
  if (res.status === 404 || res.status === 405) return { found: false };
  if (!res.ok) throw new Error('LM Studio returned HTTP ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 300));
  return { found: true, data: await readJsonBody(res) };
}

// The native model list, newest endpoint first, with a compat
// fallback. Never throws a raw fetch error: connection failures
// come back as { ok: false, error } in plain words.
// @returns {{ok: boolean, models: array, source: string, downloadedList: boolean, error?: string}}
async function listNativeLmStudioModels(opts) {
  const root = String((opts && opts.baseUrl) || 'http://localhost:1234').replace(/\/+$/, '');
  const apiKey = (opts && opts.apiKey) || '';
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const timeoutMs = (opts && opts.timeoutMs) || 5000;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const fail = (error) => ({ ok: false, models: [], source: 'none', downloadedList: false, error });
  try {
    const v1 = await fetchNativeList(root, headers, '/api/v1/models', fetchImpl, timeoutMs);
    if (v1.found) {
      if (!v1.data || !Array.isArray(v1.data.models)) return fail('LM Studio answered, but not with a model list.');
      return { ok: true, models: mapNativeModels(v1.data.models, 'v1'), source: 'v1', downloadedList: true };
    }
    const v0 = await fetchNativeList(root, headers, '/api/v0/models', fetchImpl, timeoutMs);
    if (v0.found) {
      if (!v0.data || !Array.isArray(v0.data.data)) return fail('LM Studio answered, but not with a model list.');
      return { ok: true, models: mapNativeModels(v0.data.data, 'v0'), source: 'v0', downloadedList: true };
    }
    const compat = await fetchNativeList(root, headers, '/v1/models', fetchImpl, timeoutMs);
    if (compat.found) {
      const list = (compat.data && compat.data.data) || [];
      return { ok: true, models: list.filter(m => m && m.id).map(m => ({ id: m.id, displayName: m.id, type: 'llm', quantization: null, params: null, sizeBytes: null, format: null, variant: null, loaded: true, loadedContextLength: null, maxContextLength: null, loadedIds: [] })), source: 'compat', downloadedList: false };
    }
    return fail('LM Studio answered, but none of its model-list endpoints exist — is this an LM Studio server?');
  } catch (e) {
    if (e && (e.name === 'AbortError' || e instanceof TypeError || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed/i.test(String(e && e.message)))) {
      return fail(lmStudioConnectionError(root, e).message);
    }
    return fail(e && e.message ? e.message : 'Could not list models.');
  }
}

// Load state of one model from a native list: found means the model
// is downloaded (or, on the compat fallback, loaded); loaded means
// it is actually in memory.
function loadedContextForModel(models, modelId) {
  const id = String(modelId || '');
  const entry = (models || []).find(m => m && (m.id === id || (m.loadedIds || []).includes(id)));
  if (!entry) return { found: false, loaded: false, loadedContextLength: null };
  return { found: true, loaded: !!entry.loaded, loadedContextLength: entry.loaded ? (entry.loadedContextLength || null) : null };
}

// Inkwell's budget pattern: the reply may use at most half the
// window the model was actually loaded with, so the prompt plus the
// reply still fit. The configured maxTokens stays the ceiling —
// this only ever caps it down. Unknown context falls back to 4096.
function effectiveMaxTokens(configuredMaxTokens, loadedContextLength) {
  const configured = Number(configuredMaxTokens);
  const ceiling = Number.isFinite(configured) && configured > 0 ? configured : 4096;
  const ctx = Number(loadedContextLength);
  if (Number.isFinite(ctx) && ctx > 0) return Math.max(1, Math.min(ceiling, Math.floor(ctx / 2)));
  return Math.min(ceiling, 4096);
}

// ── LM Studio home + per-model settings files ──────────────────────
// Where LM Studio keeps its own files. Overridable with
// LM_STUDIO_HOME (used by the tests). On Windows this is
// %USERPROFILE%\.lmstudio.
function lmStudioHomeDir(env = process.env) {
  if (env.LM_STUDIO_HOME) return env.LM_STUDIO_HOME;
  return path.join(os.homedir(), '.lmstudio');
}

const PROFILE_DIR_NAME = path.join('.internal', 'user-concrete-model-default-config');

// The per-model settings directory for an LM Studio home, or null
// when it does not exist.
function profileDir(home) {
  const dir = path.join(home, PROFILE_DIR_NAME);
  return fs.existsSync(dir) ? dir : null;
}

// A model id is safe to use as a path: plain segments, no "..", no
// absolute path. A "@variant" suffix (qwen/...@q4_k_m) is stripped —
// the saved settings belong to the model, not the variant, and the
// files LM Studio writes never contain "@".
function safeModelId(model) {
  if (typeof model !== 'string') return null;
  const id = model.split('@')[0];
  const parts = id.split('/');
  if (parts.length < 1 || parts.length > 4) return null;
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[\\:*?"<>|]/.test(part)) return null;
  }
  return parts.join('/');
}

// All *.json files under the profile dir, as paths relative to it
// (posix separators).
function listProfileFiles(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

// The saved-settings files that belong to `model`: the file named
// after the id (<id>.json) and any file under the id's directory
// (<id>/<file>.gguf.json) — LM Studio has used both layouts.
// Returns [] when the id is unsafe.
function profileFilesForModel(model, home) {
  const id = safeModelId(model);
  const dir = home ? profileDir(home) : null;
  if (!id || !dir) return [];
  return listProfileFiles(dir)
    .filter((rel) => rel === `${id}.json` || rel.startsWith(`${id}/`))
    .map((rel) => path.join(dir, rel));
}

// The load-setting fields the global profile sets, as LM Studio stores
// them (key/value pairs in the file's load.fields array). Quantization
// is stored as { checked, value } in the per-model files LM Studio
// itself writes; when a file already stores a plain string for one,
// that shape is kept instead (see mergeProfileFields).
function wantedFields(profile) {
  return [
    { key: 'llm.load.numParallelSessions', value: profile.maxParallelPredictions },
    { key: 'llm.load.llama.kCacheQuantizationType', value: { checked: true, value: profile.kvCacheQuantization } },
    { key: 'llm.load.llama.vCacheQuantizationType', value: { checked: true, value: profile.kvCacheQuantization } },
    { key: 'llm.load.llama.acceleration.offloadRatio', value: profile.gpuOffloadRatio },
    { key: 'llm.load.offloadKVCacheToGpu', value: true },
  ];
}

// Merge the wanted fields into a parsed per-model settings file.
// Returns the file object to write, or null when the file's shape is
// not recognised (the caller then leaves the file alone). An existing
// entry keeps its own value shape — a plain string stays a plain
// string, a { checked, value } stays one — only the value itself is
// set to the profile's. Unrelated fields are never touched.
function mergeProfileFields(parsed, profile) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const fields = parsed.load && parsed.load.fields;
  if (!Array.isArray(fields)) return null;
  for (const wanted of wantedFields(profile)) {
    const existing = fields.find((f) => f && f.key === wanted.key);
    if (existing) {
      const current = existing.value;
      const wantedValue = wanted.value && typeof wanted.value === 'object' ? wanted.value.value : wanted.value;
      existing.value = current && typeof current === 'object' && !Array.isArray(current) && 'value' in current
        ? { ...current, checked: true, value: wantedValue }
        : wantedValue;
    } else {
      fields.push({ key: wanted.key, value: wanted.value });
    }
  }
  return parsed;
}

// A fresh per-model settings file carrying only the global profile.
function newProfileFile(profile) {
  return { load: { fields: wantedFields(profile).map(({ key, value }) => ({ key, value })) } };
}

// Make the wanted model's LM Studio saved settings carry the global
// tuned profile, so the next load of that model — by this app or
// anywhere else in LM Studio — uses it. Creates the file when the
// model has none yet. Never throws; a failure is reported in the
// result and the caller (the REST load) goes ahead anyway.
// @param {string} model the model id, e.g. "qwen/qwen3-coder-30b-a3b-instruct"
// @param {{home?: string}} [opts] `home` overrides the LM Studio home directory
// @returns {{applied: boolean, files: string[], skipped: {file: string, reason: string}[], created?: boolean, reason?: string}}
function applyTunedLoadProfile(model, { home = lmStudioHomeDir() } = {}) {
  const profile = tunedLoadProfile();
  // The LM Studio home must exist (LM Studio installed); the
  // per-model settings dir may not — a fresh install has never saved
  // per-model settings — so create it rather than giving up.
  if (!fs.existsSync(home)) return { applied: false, files: [], skipped: [], reason: 'lm-studio-home-not-found' };
  const dir = path.join(home, PROFILE_DIR_NAME);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
    return { applied: false, files: [], skipped: [], reason: String((err && err.message) || err) };
  }
  const id = safeModelId(model);
  if (!id) return { applied: false, files: [], skipped: [], reason: 'unsafe-model-id' };
  try {
    const files = profileFilesForModel(model, home);
    if (files.length === 0) {
      const created = path.join(dir, `${id}.json`);
      fs.mkdirSync(path.dirname(created), { recursive: true });
      fs.writeFileSync(created, `${JSON.stringify(newProfileFile(profile), null, 2)}\n`);
      return { applied: true, files: [created], skipped: [], created: true };
    }
    const written = [];
    const skipped = [];
    for (const file of files) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
        skipped.push({ file, reason: 'unparseable' });
        continue;
      }
      const merged = mergeProfileFields(parsed, profile);
      if (!merged) {
        skipped.push({ file, reason: 'unexpected-shape' });
        continue;
      }
      fs.copyFileSync(file, `${file}.codefox-bak`);
      fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
      written.push(file);
    }
    return { applied: written.length > 0, files: written, skipped };
  } catch (err) {
    return { applied: false, files: [], skipped: [], reason: String((err && err.message) || err) };
  }
}

// ── The load flow ──────────────────────────────────────────────────
// True when a loaded instance's reported config matches the wanted
// settings. Settings LM Studio does not report are treated as
// matching (it only reports what it applied).
function matchesTunedSettings(instanceConfig) {
  const p = tunedLoadProfile();
  const same = (reported, expected) => reported === undefined || reported === null || expected === undefined || reported === expected;
  return same(instanceConfig.context_length, p.contextLength)
    && same(instanceConfig.eval_batch_size, p.evalBatchSize)
    && same(instanceConfig.flash_attention, p.flashAttention)
    && same(instanceConfig.offload_kv_cache_to_gpu, true)
    && same(instanceConfig.parallel, p.maxParallelPredictions);
}

function withTimeout(fetchImpl, url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetchImpl(url, { ...(opts || {}), signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

async function readJsonBody(res) {
  const text = await res.text().catch(() => '');
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// Load `modelId` into a running LM Studio server with the tuned
// settings, then verify it is actually loaded. Never reports success
// it did not see: the model must appear in GET /api/v1/models'
// loaded_instances afterwards.
// @param {{modelId: string, baseUrl: string, apiKey?: string, home?: string, fetchImpl?: function, loadTimeoutMs?: number, listTimeoutMs?: number}} opts
// @returns {{ok: boolean, model: string, loaded?: boolean, loadConfig?: object|null, profile?: object, warning?: string, error?: string}}
async function loadLmStudioModel(opts) {
  const modelId = String((opts && opts.modelId) || '').trim();
  const root = String((opts && opts.baseUrl) || 'http://localhost:1234').replace(/\/+$/, '');
  const apiKey = (opts && opts.apiKey) || '';
  const fetchImpl = (opts && opts.fetchImpl) || fetch;
  const loadTimeoutMs = (opts && opts.loadTimeoutMs) || 10 * 60 * 1000;
  const listTimeoutMs = (opts && opts.listTimeoutMs) || 5000;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  if (!modelId) return { ok: false, model: modelId, error: 'No model selected.' };

  // 1. The server must be reachable — a load against a dead server is
  // a plain failure, never a fake success.
  let listed;
  try {
    const res = await withTimeout(fetchImpl, root + '/api/v1/models', { headers }, listTimeoutMs);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    listed = await readJsonBody(res);
  } catch (e) {
    return { ok: false, model: modelId, error: 'LM Studio server is not running — start the server in LM Studio first (' + root + ').' };
  }
  if (!listed || !Array.isArray(listed.models)) {
    return { ok: false, model: modelId, error: 'LM Studio answered, but not with a model list — is this an LM Studio server?' };
  }

  // 2. The preset write carries the settings the REST load cannot
  // (KV cache quant, parallel predictions, GPU offload ratio). A
  // failure here never blocks the load: the REST body still carries
  // context, flash attention and KV-cache offload.
  const profile = applyTunedLoadProfile(modelId, { home: (opts && opts.home) || lmStudioHomeDir() });

  // 3. The REST load. Flash attention is rejected by some model
  // types, so a failed load is retried once without it (same body,
  // same other settings — the retry never drops a setting).
  let loadRes;
  let loadJson = null;
  try {
    loadRes = await withTimeout(fetchImpl, root + '/api/v1/models/load', {
      method: 'POST', headers, body: JSON.stringify(buildLoadBody(modelId, true)),
    }, loadTimeoutMs);
    loadJson = await readJsonBody(loadRes);
    if (!loadRes.ok) {
      const retry = await withTimeout(fetchImpl, root + '/api/v1/models/load', {
        method: 'POST', headers, body: JSON.stringify(buildLoadBody(modelId, false)),
      }, loadTimeoutMs);
      const retryJson = await readJsonBody(retry);
      if (!retry.ok) {
        const detail = (retryJson && (retryJson.error || retryJson.message)) || ('HTTP ' + retry.status);
        return { ok: false, model: modelId, profile, error: 'LM Studio could not load "' + modelId + '" (' + detail + '). If the model does not fit in GPU memory with full offload, use a smaller model or a smaller quant — CodeFox will not silently spill layers to system RAM.' };
      }
      loadRes = retry;
      loadJson = retryJson;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, model: modelId, profile, error: 'Timed out waiting for LM Studio to load "' + modelId + '" — the model may still be loading in LM Studio; check there before trying again.' };
    }
    return { ok: false, model: modelId, profile, error: 'LM Studio server is not running — start the server in LM Studio first (' + root + ').' };
  }

  // 4. Verify: the model must actually be in the loaded list now.
  // A load that "succeeded" but left nothing loaded is a failure.
  let verify;
  try {
    const res = await withTimeout(fetchImpl, root + '/api/v1/models', { headers }, listTimeoutMs);
    verify = await readJsonBody(res);
  } catch {
    verify = null;
  }
  const entry = verify && Array.isArray(verify.models)
    ? verify.models.find((m) => m && (m.key === modelId || (m.loaded_instances || []).some((i) => i && i.id === modelId)))
    : null;
  const instances = (entry && entry.loaded_instances) || [];
  if (!instances.length) {
    return { ok: false, model: modelId, profile, error: 'LM Studio said the load finished, but "' + modelId + '" is not in the loaded list — it did not actually load. Check LM Studio for the error.' };
  }
  const result = {
    ok: true, model: modelId, loaded: true,
    loadConfig: (loadJson && loadJson.load_config) || null, profile,
  };
  // The echoed config is the proof of what was applied. If LM Studio
  // reports a setting that is not the tuned one (e.g. parallel is
  // still 4 because the saved-settings write did not take), say so
  // instead of letting a slow model look like a tuned one.
  const reported = instances[0].config || {};
  if (!matchesTunedSettings(reported)) {
    result.warning = 'Loaded, but LM Studio reports different load settings than the tuned ones (e.g. parallel is ' + reported.parallel + ', not 1). Check the model\u2019s settings in LM Studio — the saved-settings change may not have applied.';
  }
  return result;
}

module.exports = {
  TUNED_LOAD_DEFAULTS,
  TUNED_LOAD_DESCRIPTION,
  tunedLoadProfile,
  buildLoadBody,
  isRecommendedCodingModel,
  lmStudioConnectionError,
  normalizeNativeModel,
  mapNativeModels,
  listNativeLmStudioModels,
  loadedContextForModel,
  effectiveMaxTokens,
  lmStudioHomeDir,
  safeModelId,
  profileFilesForModel,
  mergeProfileFields,
  applyTunedLoadProfile,
  matchesTunedSettings,
  loadLmStudioModel,
};
