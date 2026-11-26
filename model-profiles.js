// model-profiles.js — per-model profiles, vision routing and the
// model swap state machine (v0.21.0).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// this file directly with `node` (like context-budget.js and
// turn-ledger.js). The renderer uses it to decide which model runs a
// turn and to drive a model swap; main.js does the actual load /
// unload through the existing llm:* IPCs.
//
// The rule that matters: routing is deterministic and never
// model-picks-model. The coder model never decides which model runs
// next — the profile says so, in code, before the turn starts.
// Vision is a TOOL, not a second agent: the vision model is asked a
// question about one image, its findings come back as text the coder
// model can use, and the coder never sees the pixels.

(function () {
  'use strict';

  var ModelProfiles = {};

  ModelProfiles.VERSION = '0.21.0';
  ModelProfiles.SCHEMA_VERSION = 1;

  // The tuned load settings from v0.8.3 are the bare minimum for
  // every profile: KV cache q8_0, one concurrent prediction, full
  // GPU offload, context 16384, eval batch 512, flash attention on.
  var TUNED_LOAD = {
    kvCacheQuant: 'q8_0',
    parallel: 1,
    offloadRatio: 1,
    contextLength: 16384,
    evalBatch: 512,
    flashAttention: true,
  };

  function createProfile(overrides) {
    var p = {
      id: '',
      lmStudioKey: '',
      fileHash: '',
      quant: '',
      roles: ['chat'],
      capabilities: { vision: false, tools: true, contextLength: 0 },
      load: {
        kvCacheQuant: TUNED_LOAD.kvCacheQuant,
        parallel: TUNED_LOAD.parallel,
        offloadRatio: TUNED_LOAD.offloadRatio,
        contextLength: TUNED_LOAD.contextLength,
        evalBatch: TUNED_LOAD.evalBatch,
        flashAttention: TUNED_LOAD.flashAttention,
      },
      sampling: { temperature: 0.2, chatTemperature: 0.7, topP: 0.9 },
      limits: { maxTokens: 4096 },
      prompt: '',
      measured: { tokensPerSecond: null, loadSeconds: null, promptTokensPerSecond: null },
      evals: {},
    };
    var o = overrides || {};
    Object.keys(o).forEach(function (k) {
      if (k === 'capabilities' || k === 'load' || k === 'sampling' || k === 'limits' || k === 'measured' || k === 'evals') {
        Object.keys(o[k] || {}).forEach(function (sub) { p[k][sub] = o[k][sub]; });
      } else {
        p[k] = o[k];
      }
    });
    return p;
  }
  ModelProfiles.createProfile = createProfile;
  ModelProfiles.TUNED_LOAD = TUNED_LOAD;

  // The primary profile is the chat / agent coder. A vision model is
  // a separate profile the user picks in Settings; until one is
  // configured, vision simply says so.
  function defaultCoderProfile(modelId) {
    return createProfile({
      id: 'primary',
      lmStudioKey: modelId || '',
      roles: ['chat', 'agent'],
      capabilities: { vision: false, tools: true, contextLength: 16384 },
    });
  }
  ModelProfiles.defaultCoderProfile = defaultCoderProfile;

  function defaultProfiles(modelId) {
    return {
      schemaVersion: ModelProfiles.SCHEMA_VERSION,
      primary: defaultCoderProfile(modelId),
      vision: null,
      // autoSwap: 'auto' swaps without asking (the cost is shown in
      // the tool result); 'ask' needs an explicit confirmSwap on the
      // vision block; 'never' refuses vision that needs a swap.
      autoSwap: 'auto',
      // coResidency: load the vision model alongside the coder
      // instead of unloading first. Only honest on a GPU with room
      // for both — two 30B models do not fit on a 24 GB card, and
      // the Settings UI says so.
      coResidency: false,
    };
  }
  ModelProfiles.defaultProfiles = defaultProfiles;

  // A profile is usable when it names a model and its load block is
  // sane. Returns a list of problems (empty = usable).
  function validateProfile(p) {
    var errors = [];
    if (!p || typeof p !== 'object') return ['No profile.'];
    if (!p.id || typeof p.id !== 'string') errors.push('Profile id is missing.');
    if (!p.lmStudioKey || typeof p.lmStudioKey !== 'string') errors.push('No LM Studio model key set.');
    if (!p.capabilities || typeof p.capabilities !== 'object') errors.push('Capabilities are missing.');
    if (!p.load || typeof p.load !== 'object') errors.push('Load settings are missing.');
    else if (!(p.load.contextLength > 0)) errors.push('Load context length must be positive.');
    if (p.sampling && p.sampling.temperature != null
      && (typeof p.sampling.temperature !== 'number' || p.sampling.temperature < 0 || p.sampling.temperature > 2)) {
      errors.push('Sampling temperature must be between 0 and 2.');
    }
    if (p.roles != null && !Array.isArray(p.roles)) errors.push('Roles must be a list.');
    return errors;
  }
  ModelProfiles.validateProfile = validateProfile;

  // Where does a vision question run? Deterministic, in this order:
  // 1. the primary model, if it is vision-capable (no swap at all);
  // 2. the configured vision profile, with a swap;
  // 3. nowhere — with a plain reason, never a pretence that the
  //    coder saw the image.
  function routeVision(profiles) {
    var p = profiles || {};
    var primary = p.primary || null;
    var vision = p.vision || null;
    if (primary && primary.capabilities && primary.capabilities.vision && primary.lmStudioKey) {
      return { kind: 'primary', profile: primary, swap: false, reason: 'Primary model is vision-capable — no swap.' };
    }
    if (vision && vision.lmStudioKey && validateProfile(vision).length === 0) {
      return { kind: 'swap', profile: vision, swap: true, reason: 'Vision model configured — swap from the coder.' };
    }
    return {
      kind: 'none',
      profile: null,
      swap: false,
      reason: 'No vision model is configured — pick one in Settings → Model → Vision model.',
    };
  }
  ModelProfiles.routeVision = routeVision;

  // Swap cost, in seconds: the vision model's measured (or default)
  // load time plus the time to re-prime it with the prompt. The
  // defaults are honest guesses (30 s to load, 20 prompt tokens/s)
  // and are replaced by measured numbers once a swap has run.
  function estimateSwapCost(profile, promptTokens) {
    var loadSeconds = (profile && profile.measured && profile.measured.loadSeconds != null)
      ? profile.measured.loadSeconds : 30;
    var pps = (profile && profile.measured && profile.measured.promptTokensPerSecond != null)
      ? profile.measured.promptTokensPerSecond : 20;
    var tokens = Math.max(0, promptTokens | 0);
    var seconds = Math.round(loadSeconds + tokens / Math.max(1, pps));
    return { seconds: seconds, text: 'about ' + seconds + ' s to swap' };
  }
  ModelProfiles.estimateSwapCost = estimateSwapCost;

  // The model state machine: one model at a time on the GPU, one
  // lock. States: unloaded, loading, ready, busy, unloading.
  // 'busy' is set while a model call is in flight so a swap can
  // never unload a model mid-call. Invalid transitions are refused
  // with a plain error — they never silently happen.
  var TRANSITIONS = {
    unloaded: { 'load-start': 'loading' },
    loading: { 'load-ok': 'ready', 'load-fail': 'unloaded' },
    ready: { 'unload-start': 'unloading', busy: 'busy' },
    busy: { free: 'ready' },
    unloading: { 'unload-ok': 'unloaded' },
  };

  function createModelState() {
    return { state: 'unloaded', current: null, busy: false };
  }
  ModelProfiles.createModelState = createModelState;

  function modelTransition(s, event, modelId) {
    var from = s && s.state ? s.state : 'unloaded';
    var allowed = TRANSITIONS[from] || {};
    var to = allowed[event];
    if (!to) {
      var busyNote = from === 'busy' && event === 'unload-start'
        ? 'Cannot unload a model while it is busy — wait for the call to finish.'
        : 'Cannot ' + event + ' while the model is ' + from + '.';
      return { ok: false, error: busyNote, state: s };
    }
    var next = { state: to, current: s.current, busy: to === 'busy' };
    if (event === 'load-ok') next.current = modelId || s.current;
    if (event === 'unload-ok') next.current = null;
    if (event === 'load-start') next.current = modelId || s.current;
    return { ok: true, state: next };
  }
  ModelProfiles.modelTransition = modelTransition;

  // The vision call uses a fresh, minimal context — the system
  // prompt below plus the question plus the image. The conversation
  // history is never sent to the vision model, and the vision
  // model's reply comes back to the coder as a capped text tool
  // result.
  function visionSystemPrompt() {
    return 'You are a vision model. Look at the attached image and answer the question about it. ' +
      'Be concrete and brief: name what you can see, and say plainly when something is not visible. ' +
      'Do not guess about anything outside the image.';
  }
  ModelProfiles.visionSystemPrompt = visionSystemPrompt;

  // Best-effort structure for a vision reply. The coder gets the
  // capped raw text either way — this parse only adds structure when
  // the reply actually has it (bullets under a Matches/Issues
  // heading, or "Matches: ..." / "Issues: ..." lines). A reply with
  // no structure parses to empty lists, never to invented findings.
  function parseVisionResult(text, maxChars) {
    var cap = maxChars == null ? 1600 : maxChars;
    var raw = String(text || '').trim().slice(0, cap);
    var matches = [];
    var issues = [];
    var current = null;
    raw.split(/\r?\n/).forEach(function (line) {
      var t = line.trim();
      if (/^matches?\s*:/i.test(t)) {
        current = matches;
        var rest = t.replace(/^matches?\s*:\s*/i, '');
        if (rest) matches.push(rest);
        return;
      }
      if (/^(issues?|problems?|doesn'?t match|mismatches?)\s*:/i.test(t)) {
        current = issues;
        var rest2 = t.replace(/^(issues?|problems?|doesn'?t match|mismatches?)\s*:\s*/i, '');
        if (rest2) issues.push(rest2);
        return;
      }
      if (/^#{1,3}\s*(matches?|issues?|problems?)/i.test(t)) {
        current = /issue|problem/i.test(t) ? issues : matches;
        return;
      }
      var bullet = /^[-*•]\s+(.+)/.exec(t);
      if (bullet && current) current.push(bullet[1].trim());
    });
    return { matches: matches, issues: issues, raw: raw };
  }
  ModelProfiles.parseVisionResult = parseVisionResult;

  // Safety net: no image ever reaches the coder's history. Vision
  // findings arrive as text tool results; if a message somehow
  // carries an image part, it is replaced with a plain note.
  function stripImagesFromHistory(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map(function (m) {
      if (!m || !Array.isArray(m.content)) return m;
      var dropped = false;
      var kept = [];
      m.content.forEach(function (part) {
        if (part && (part.type === 'image_url' || part.type === 'image')) dropped = true;
        else kept.push(part);
      });
      if (!dropped) return m;
      kept.push({ type: 'text', text: '[image removed — the vision findings are in the tool result]' });
      return { role: m.role, content: kept };
    });
  }
  ModelProfiles.stripImagesFromHistory = stripImagesFromHistory;

  if (typeof module !== 'undefined' && module.exports) module.exports = ModelProfiles;
  if (typeof window !== 'undefined') window.ModelProfiles = ModelProfiles;
})();
