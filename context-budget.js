// context-budget.js — calibrated context budgeting (v0.19.0).
//
// Plain JavaScript, no dependencies, no Node-only APIs: it runs in
// three places — the main process (require, for stream metadata),
// the smoke test (require), and the Electron renderer (classic
// <script>, where it is window.ContextBudget). It must never touch
// the filesystem, the bridge, or the LLM; the caller owns all of
// that and hands this module plain data.
//
// What lives here:
//   - calibrated token counting: chars-per-token estimation, updated
//     from server-reported prompt tokens when a stream carries them
//   - the budget formula and the elide / summarize / drop triggers
//   - compaction of a message list into the working set sent to the
//     model — the full transcript is never touched, only the copy
//     the model sees. Groups (one user turn + its replies) are
//     atomic: a tool call is never split from its result, and the
//     last two turns are never compacted.
//   - the deterministic project map (from a project scan) and its
//     delta notes, so the map in the system prompt only ever
//     changes at a compaction boundary
//   - the context-meter segment math
//   - stream-metadata parsing (SSE usage / finish_reason, Ollama
//     done messages)
//
// Deliberate limits, stated plainly:
//   - The working-memory note is built BY CODE from the mutation
//     ledger, the user messages, and the failed tool results —
//     never by the model. Compaction must never invent a decision
//     the user did not make, so there is no LLM summarizer here.
//   - Counting is calibrated, not exact: only the server's own
//     prompt_tokens are ground truth, and they arrive only when
//     the stream carries them. Everything else is chars divided by
//     a learned ratio, with a 15% safety margin.
(function () {
  'use strict';

  var ContextBudget = {};

  // ── Constants ─────────────────────────────────────────────────
  // chars-per-token for code/JSON-heavy text. Plain prose runs
  // closer to 4, but the model mostly reads code, tool JSON and
  // logs here — 3 is the conservative (larger) estimate, so the
  // budget errs on the side of compacting early.
  var DEFAULT_CHARS_PER_TOKEN = 3;
  // The window assumed when the loaded context is unknown. It is
  // the tuned load default (context 16384) — an assumption, never
  // presented as a measured value: the meter says so.
  var CONTEXT_FALLBACK = 16384;
  var SAFETY_MARGIN = 0.15;
  var ELIDE_AT = 0.6;
  var SUMMARIZE_AT = 0.75;
  var DROP_AT = 0.9;
  var COMPACT_TO = 0.4;
  // The project map is hard-capped at 1500 tokens (~4500 chars).
  var MAP_TOKEN_CAP = 1500;
  // Tool-result caps, scaled to the loaded window: ~600 tokens per
  // result at 8k, ~2000 at 32k.
  var RESULT_CAP_AT_8K = 600;
  var RESULT_CAP_AT_32K = 2000;
  // How many of the newest turns compaction never touches.
  var KEEP_GROUPS = 2;

  ContextBudget.DEFAULT_CHARS_PER_TOKEN = DEFAULT_CHARS_PER_TOKEN;
  ContextBudget.CONTEXT_FALLBACK = CONTEXT_FALLBACK;
  ContextBudget.SAFETY_MARGIN = SAFETY_MARGIN;
  ContextBudget.ELIDE_AT = ELIDE_AT;
  ContextBudget.SUMMARIZE_AT = SUMMARIZE_AT;
  ContextBudget.DROP_AT = DROP_AT;
  ContextBudget.COMPACT_TO = COMPACT_TO;
  ContextBudget.MAP_TOKEN_CAP = MAP_TOKEN_CAP;
  ContextBudget.KEEP_GROUPS = KEEP_GROUPS;

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function ceilDiv(n, d) { return Math.ceil(n / d); }

  // ── Counting ──────────────────────────────────────────────────
  function estimateTokens(text, ratio) {
    var r = (typeof ratio === 'number' && ratio > 0) ? ratio : DEFAULT_CHARS_PER_TOKEN;
    return ceilDiv(String(text || '').length, r);
  }
  ContextBudget.estimateTokens = estimateTokens;

  function estimateMessagesTokens(messages, ratio) {
    var total = 0;
    for (var i = 0; i < (messages || []).length; i++) {
      total += estimateTokens((messages[i] && messages[i].content) || '', ratio);
    }
    return total;
  }
  ContextBudget.estimateMessagesTokens = estimateMessagesTokens;

  // Learn the ratio from server ground truth: one sample per
  // stream ({chars sent, prompt_tokens reported}). Each sample
  // blends 50/50 with the running value, so one odd reading never
  // swings the estimate, and the ratio stays inside [2, 6].
  function calibrateCharsPerToken(current, samples) {
    var ratio = (typeof current === 'number' && current > 0) ? current : DEFAULT_CHARS_PER_TOKEN;
    for (var i = 0; i < (samples || []).length; i++) {
      var s = samples[i] || {};
      var chars = Number(s.chars) || 0;
      var tokens = Number(s.actualTokens) || 0;
      if (chars <= 0 || tokens <= 0) continue;
      var observed = clamp(chars / tokens, 2, 6);
      ratio = clamp((ratio + observed) / 2, 2, 6);
    }
    return Math.round(ratio * 100) / 100;
  }
  ContextBudget.calibrateCharsPerToken = calibrateCharsPerToken;

  // The reply reserve: the reply may use up to maxTokens, but
  // never more than half the loaded window (the v0.8.4 cap) — the
  // prompt plus the reply still has to fit. Unknown window: the
  // configured max on its own.
  function outputReserveFor(maxTokens, loadedContext) {
    var mt = Math.max(0, Math.floor(Number(maxTokens) || 0));
    if (loadedContext && loadedContext > 0) return Math.min(mt, Math.floor(loadedContext / 2));
    return mt;
  }
  ContextBudget.outputReserveFor = outputReserveFor;

  // Result cap, linear between 600 @ 8k and 2000 @ 32k.
  function capResultTokens(loadedContext) {
    var loaded = Number(loadedContext) || 0;
    if (loaded <= 8192) return RESULT_CAP_AT_8K;
    if (loaded >= 32768) return RESULT_CAP_AT_32K;
    return Math.round(RESULT_CAP_AT_8K + (loaded - 8192) * (RESULT_CAP_AT_32K - RESULT_CAP_AT_8K) / (32768 - 8192));
  }
  ContextBudget.capResultTokens = capResultTokens;

  // u = estimated prompt tokens / (loaded context − output
  // reserve). The safety margin inflates the estimate: the budget
  // acts as if the prompt were 15% larger than estimated, because
  // an estimate that runs long is what strands a reply mid-token.
  function contextUsage(o) {
    o = o || {};
    var loaded = Number(o.loadedContext) || CONTEXT_FALLBACK;
    var reserve = Number(o.outputReserve) || 0;
    var prompt = Number(o.promptTokens) || 0;
    var history = Number(o.historyTokens) || 0;
    var total = prompt + history;
    var denom = Math.max(1, loaded - reserve);
    var adjusted = Math.ceil(total * (1 + SAFETY_MARGIN));
    return {
      loaded: loaded,
      known: !!o.loadedContext,
      reserve: reserve,
      promptTokens: prompt,
      historyTokens: history,
      total: total,
      adjustedTotal: adjusted,
      available: denom,
      availableHistory: Math.max(0, denom - prompt),
      u: adjusted / denom,
      uRaw: total / denom,
    };
  }
  ContextBudget.contextUsage = contextUsage;

  function compactionAction(u) {
    if (u < ELIDE_AT) return 'none';
    if (u < SUMMARIZE_AT) return 'elide';
    if (u <= DROP_AT) return 'summarize';
    return 'drop';
  }
  ContextBudget.compactionAction = compactionAction;

  // ── Tool results: what they are, what can be elided ──────────
  // A tool result is a role-"user" message the app appended (the
  // user never writes these). Shapes, as the model sees them:
  //   'Tool result — ...' (unity commands, git, shell, ComfyUI…)
  //   'View <path> — lines N–M of T:' (file view)
  //   'Grep "<pattern>": …' (file grep)
  //   'Compile check: …' (per-edit / post-turn compile check)
  //   'File tool failed: …' / 'str_replace applied to …'
  function isToolResultMessage(m) {
    if (!m || m.role !== 'user') return false;
    var t = String(m.content || '');
    if (t.indexOf('Tool result — ') === 0) return true;
    if (/^View \S+ — lines \d+/.test(t)) return true;
    if (/^Grep "/.test(t)) return true;
    if (t.indexOf('Compile check:') === 0) return true;
    if (t.indexOf('File tool failed:') === 0) return true;
    if (t.indexOf('str_replace applied to ') === 0) return true;
    if (t === 'File tool: done.') return true;
    return false;
  }
  ContextBudget.isToolResultMessage = isToolResultMessage;

  // Bridge read actions — re-runnable, so their results are
  // re-derivable. Writes are never elidable: they are what changed.
  var READ_ACTIONS = ['readConsole', 'read_component_values', 'list_hierarchy', 'listComponentTypes', 'describeComponent', 'list_assets', 'recompile_and_report_errors'];
  ContextBudget.READ_ACTIONS = READ_ACTIONS.slice();

  function isElidableToolResult(text) {
    var t = String(text || '');
    if (!t) return false;
    // A failed tool call is evidence, not bulk: the failed
    // approaches in the working-memory note are built from these.
    if (/failed/i.test(t)) return false;
    if (/could not parse/i.test(t)) return false;
    if (/not run:/.test(t)) return false;
    var um = t.match(/^Tool result — Unity command "([^"]+)"/);
    if (um) return READ_ACTIONS.indexOf(um[1]) !== -1;
    if (/^View \S+ — lines \d+/.test(t)) return true;
    if (/^Grep "/.test(t)) return true;
    if (/^Tool result — Git (status|diff|log)/.test(t)) return true;
    if (/^Compile check: compile clean/.test(t)) return true;
    return false;
  }
  ContextBudget.isElidableToolResult = isElidableToolResult;

  // The stub keeps the call visible and says how to get the data
  // back: the first line, cut short, plus the re-run hint.
  function elideToolResult(text) {
    var t = String(text || '');
    var first = t.split(/\r?\n/)[0] || t;
    if (first.length > 100) first = first.slice(0, 100) + '…';
    return first + ' [elided — ' + t.length + ' chars, re-run to see]';
  }
  ContextBudget.elideToolResult = elideToolResult;

  // ── Grouping ──────────────────────────────────────────────────
  // Turns are atomic: a group starts at a user message that is not
  // a tool result, and holds everything after it (assistant
  // replies, tool results) until the next such message. System
  // messages are singletons — always kept, never grouped, never
  // compacted: they are small and they carry approvals, backups
  // and compaction notes the model needs.
  function groupMessages(messages) {
    var out = [];
    var cur = null;
    for (var i = 0; i < (messages || []).length; i++) {
      var m = messages[i];
      if (!m) continue;
      if (m.role === 'system') {
        if (cur) { out.push(cur); cur = null; }
        out.push({ kind: 'system', messages: [m] });
        continue;
      }
      if (m.role === 'user' && !isToolResultMessage(m)) {
        if (cur) out.push(cur);
        cur = { kind: 'turn', messages: [m] };
        continue;
      }
      if (!cur) cur = { kind: 'turn', messages: [] };
      cur.messages.push(m);
    }
    if (cur) out.push(cur);
    return out;
  }
  ContextBudget.groupMessages = groupMessages;

  // ── Mutation ledger (deterministic) ───────────────────────────
  // What the turns actually changed, read off the assistant's own
  // output — never summarized by a model. File writes from the
  // **File Path:** / ```file: markers and str_replace blocks;
  // bridge actions from ```unity-command blocks. Capped at 20
  // entries, oldest dropped, with a count of the rest.
  function buildMutationLedger(messages) {
    var entries = [];
    var dropped = 0;
    function add(text) {
      if (entries.length >= 20) { dropped++; return; }
      if (entries.indexOf(text) === -1) entries.push(text);
    }
    for (var i = 0; i < (messages || []).length; i++) {
      var m = messages[i];
      if (!m || m.role !== 'assistant') continue;
      var c = String(m.content || '');
      var fp = c.match(/\*\*File Path:\*\*\s*`([^`]+)`/g) || [];
      for (var a = 0; a < fp.length; a++) {
        var p = fp[a].match(/`([^`]+)`/);
        if (p) add('wrote ' + p[1]);
      }
      var ff = c.match(/```file:([^\s`\n]+)/g) || [];
      for (var b = 0; b < ff.length; b++) add('wrote ' + ff[b].replace('```file:', ''));
      var sr = c.match(/"action"\s*:\s*"str_replace"[^}]*"path"\s*:\s*"([^"]+)"/g) || [];
      for (var d = 0; d < sr.length; d++) {
        var sp = sr[d].match(/"path"\s*:\s*"([^"]+)"/);
        if (sp) add('edited ' + sp[1]);
      }
      var uc = c.match(/```unity-command\s*([\s\S]*?)```/g) || [];
      for (var e = 0; e < uc.length; e++) {
        var am = uc[e].match(/"action"\s*:\s*"([^"]+)"/);
        if (!am) continue;
        var nm = uc[e].match(/"(?:path|name)"\s*:\s*"([^"]+)"/);
        add('ran ' + am[1] + (nm ? ' ' + nm[1] : ''));
      }
    }
    return { entries: entries, dropped: dropped };
  }
  ContextBudget.buildMutationLedger = buildMutationLedger;

  // The working-memory note, built by code from the ledger, the
  // user messages, and the failed tool results in the summarized
  // range. It states what was done and what failed — it never
  // invents a decision, a goal, or a conclusion.
  function buildWorkingMemoryNote(groups) {
    var flat = [];
    for (var i = 0; i < (groups || []).length; i++) {
      var g = groups[i];
      if (g && g.messages) flat = flat.concat(g.messages);
    }
    var ledger = buildMutationLedger(flat);
    var userMsgs = flat.filter(function (m) { return m.role === 'user' && !isToolResultMessage(m); });
    var goal = userMsgs.length ? String(userMsgs[0].content || '').slice(0, 300) : '';
    var open = userMsgs.length > 1 ? String(userMsgs[userMsgs.length - 1].content || '').slice(0, 300) : '';
    var failed = [];
    for (var j = 0; j < flat.length; j++) {
      var fm = flat[j];
      if (!fm || !isToolResultMessage(fm)) continue;
      var ft = String(fm.content || '');
      if (!/failed/i.test(ft) && !/could not parse/i.test(ft)) continue;
      var firstLine = ft.split(/\r?\n/)[0] || ft;
      if (firstLine.length > 160) firstLine = firstLine.slice(0, 160) + '…';
      if (failed.indexOf(firstLine) === -1) failed.push(firstLine);
      if (failed.length >= 5) break;
    }
    var lines = [];
    lines.push('[Context note — older turns were compacted to save context. The full transcript is still saved; re-run a tool to see anything below again.]');
    if (goal) lines.push('Goal: ' + goal);
    if (ledger.entries.length) {
      lines.push('Done:');
      for (var k = 0; k < ledger.entries.length; k++) lines.push('- ' + ledger.entries[k]);
      if (ledger.dropped) lines.push('- …and ' + ledger.dropped + ' earlier changes');
    }
    if (failed.length) {
      lines.push('Failed approaches (do not repeat without a new idea):');
      for (var f = 0; f < failed.length; f++) lines.push('- ' + failed[f]);
    }
    if (open && open !== goal) lines.push('Still open: ' + open);
    return lines.join('\n');
  }
  ContextBudget.buildWorkingMemoryNote = buildWorkingMemoryNote;

  // ── Compaction ────────────────────────────────────────────────
  // Pure: given the full history and the budget, return the working
  // set for the model plus a log of what changed. The full history
  // is never modified — the caller keeps it and the database keeps
  // it. Phases, in order, each stopping as soon as the target is
  // met: elide stale tool results, summarize the oldest turns into
  // one working-memory note, drop the oldest turns outright. The
  // last KEEP_GROUPS turns are never touched, the first turn (the
  // user's original request) is never summarized or dropped, and a
  // group is never split: a tool call stays with its result, or the
  // whole turn goes. When nothing can be compacted further (only the newest
  // turns are left), the log says floorHit — the caller must not
  // pretend the history shrank.
  function compactHistory(messages, opts) {
    opts = opts || {};
    var ratio = opts.ratio || DEFAULT_CHARS_PER_TOKEN;
    var loaded = Number(opts.loadedContext) || CONTEXT_FALLBACK;
    var reserve = Number(opts.outputReserve) || 0;
    var promptTokens = Number(opts.promptTokens) || 0;
    var compactTo = opts.compactTo || COMPACT_TO;
    var keepGroups = opts.keepGroups != null ? opts.keepGroups : KEEP_GROUPS;
    var all = (messages || []).slice();
    var historyTokens = estimateMessagesTokens(all, ratio);
    var usage = contextUsage({ loadedContext: loaded, outputReserve: reserve, promptTokens: promptTokens, historyTokens: historyTokens });
    var log = {
      action: 'none', tokensBefore: usage.total, uBefore: usage.u,
      tokensAfter: usage.total, uAfter: usage.u,
      groupsSummarized: 0, groupsDropped: 0, resultsElided: 0,
      changed: 0, floorHit: false,
    };
    if (usage.u < ELIDE_AT) return { messages: all, action: 'none', log: null, u: usage.u, tokens: usage.total };

    var groups = groupMessages(all);
    // Ordinal of each turn group among turn groups only.
    var turnOrdinals = [];
    var turnCount = 0;
    for (var gi = 0; gi < groups.length; gi++) {
      if (groups[gi].kind === 'turn') { turnOrdinals[gi] = turnCount; turnCount++; }
      else turnOrdinals[gi] = -1;
    }
    function isProtected(gi) {
      if (turnOrdinals[gi] === -1) return true; // system singletons are never compacted
      return turnOrdinals[gi] >= turnCount - keepGroups;
    }
    // v0.21.4: the first turn is the user's original request — it
    // is never summarized or dropped, so the model always works
    // from the user's words, not from a note about them. Its tool
    // results can still be elided (Phase 1 only checks
    // isProtected), so this pins the request itself, not the whole
    // turn's bulk.
    function isFirstTurn(gi) {
      return turnOrdinals[gi] === 0;
    }
    function flatten(gs) {
      var out = [];
      for (var i = 0; i < gs.length; i++) out = out.concat(gs[i].messages);
      return out;
    }
    function currentU(gs) {
      var t = estimateMessagesTokens(flatten(gs), ratio);
      return contextUsage({ loadedContext: loaded, outputReserve: reserve, promptTokens: promptTokens, historyTokens: t });
    }

    var action = compactionAction(usage.u);
    var working = groups.slice();

    // Phase 1 — elide: stub re-derivable tool results in old turns.
    if (action !== 'none') {
      for (var ei = 0; ei < working.length; ei++) {
        if (isProtected(ei)) continue;
        var msgs = working[ei].messages;
        for (var mi = 0; mi < msgs.length; mi++) {
          if (isToolResultMessage(msgs[mi]) && isElidableToolResult(msgs[mi].content)) {
            msgs[mi] = { role: msgs[mi].role, content: elideToolResult(msgs[mi].content) };
            log.resultsElided++;
          }
        }
      }
      var afterElide = currentU(working);
      log.tokensAfter = afterElide.total;
      log.uAfter = afterElide.u;
      if (afterElide.u < SUMMARIZE_AT) {
        log.action = 'elide';
        log.changed = log.resultsElided;
        return { messages: flatten(working), action: 'elide', log: log.resultsElided ? log : null, u: afterElide.u, tokens: afterElide.total };
      }
      action = 'summarize';
    }

    // Phase 2 — summarize: replace the oldest turns, one at a time,
    // with a single working-memory note, until the target is met.
    var summarized = [];
    while (action === 'summarize') {
      var next = -1;
      for (var si = 0; si < working.length; si++) {
        if (working[si].kind === 'turn' && !isProtected(si) && !isFirstTurn(si)) { next = si; break; }
      }
      if (next === -1) break;
      summarized.push(working[next]);
      working.splice(next, 1);
      // Recompute ordinals: the removed group shifts the rest.
      turnOrdinals = [];
      turnCount = 0;
      for (var qi = 0; qi < working.length; qi++) {
        if (working[qi].kind === 'turn') { turnOrdinals[qi] = turnCount; turnCount++; }
        else turnOrdinals[qi] = -1;
      }
      var afterSum = currentU(working);
      log.tokensAfter = afterSum.total;
      log.uAfter = afterSum.u;
      if (afterSum.u <= compactTo) break;
    }
    if (summarized.length) {
      var note = buildWorkingMemoryNote(summarized);
      // The note goes where the oldest summarized turn was: find
      // the earliest surviving position that is not after a
      // protected turn — in practice the front of the history.
      var insertAt = 0;
      for (var ii = 0; ii < working.length; ii++) {
        if (working[ii].kind === 'turn') { insertAt = ii; break; }
        insertAt = ii + 1;
      }
      working.splice(insertAt, 0, { kind: 'system', messages: [{ role: 'system', content: note }] });
      // The insert shifts later groups: rebuild the ordinal map
      // before the drop phase reads it.
      turnOrdinals = [];
      turnCount = 0;
      for (var ni = 0; ni < working.length; ni++) {
        if (working[ni].kind === 'turn') { turnOrdinals[ni] = turnCount; turnCount++; }
        else turnOrdinals[ni] = -1;
      }
      log.groupsSummarized = summarized.length;
      var afterNote = currentU(working);
      log.tokensAfter = afterNote.total;
      log.uAfter = afterNote.u;
      if (afterNote.u > compactTo) {
        var moreSummarizable = false;
        for (var ms = 0; ms < working.length; ms++) {
          if (working[ms].kind === 'turn' && !isProtected(ms) && !isFirstTurn(ms)) { moreSummarizable = true; break; }
        }
        if (!moreSummarizable) log.floorHit = true;
      }
      if (afterNote.u <= DROP_AT) {
        log.action = 'summarize';
        log.changed = log.groupsSummarized + log.resultsElided;
        return { messages: flatten(working), action: 'summarize', log: log, u: afterNote.u, tokens: afterNote.total };
      }
      action = 'drop';
    } else if (action === 'summarize') {
      // Nothing was summarizable (only the newest turns exist).
      log.floorHit = true;
      log.changed = log.resultsElided;
      if (log.resultsElided) { log.action = 'elide'; return { messages: flatten(working), action: 'elide', log: log, u: log.uAfter, tokens: log.tokensAfter }; }
      return { messages: flatten(working), action: compactionAction(usage.u), log: log, u: usage.u, tokens: usage.total };
    }

    // Phase 3 — drop: oldest turns outright, until the target is
    // met or only protected turns remain.
    while (action === 'drop') {
      var di = -1;
      for (var d = 0; d < working.length; d++) {
        if (working[d].kind === 'turn' && !isProtected(d) && !isFirstTurn(d)) { di = d; break; }
      }
      if (di === -1) { log.floorHit = true; break; }
      working.splice(di, 1);
      log.groupsDropped++;
      turnOrdinals = [];
      turnCount = 0;
      for (var dq = 0; dq < working.length; dq++) {
        if (working[dq].kind === 'turn') { turnOrdinals[dq] = turnCount; turnCount++; }
        else turnOrdinals[dq] = -1;
      }
      var afterDrop = currentU(working);
      log.tokensAfter = afterDrop.total;
      log.uAfter = afterDrop.u;
      if (afterDrop.u <= compactTo) break;
    }
    log.action = 'drop';
    log.changed = log.groupsSummarized + log.groupsDropped + log.resultsElided;
    var finalU = currentU(working);
    log.tokensAfter = finalU.total;
    log.uAfter = finalU.u;
    return { messages: flatten(working), action: 'drop', log: log, u: finalU.u, tokens: finalU.total };
  }
  ContextBudget.compactHistory = compactHistory;

  // ── Deterministic project map ────────────────────────────────
  // Built from a project scan — never by the model. Unity version,
  // render pipeline and input system from the package list, folder
  // counts, a script index, depth-1 scene listings. Hard-capped at
  // MAP_TOKEN_CAP tokens: the script list shrinks first, then
  // scenes, then prefabs; the header lines never shrink.
  function buildProjectMap(scan) {
    var s = scan || {};
    var pkgs = s.packages || {};
    var names = Object.keys(pkgs);
    var pipeline = 'Built-in';
    if (names.indexOf('com.unity.render-pipelines.high-definition') !== -1) pipeline = 'HDRP';
    else if (names.indexOf('com.unity.render-pipelines.universal') !== -1) pipeline = 'URP';
    else if (names.indexOf('com.unity.render-pipelines.core') !== -1) pipeline = 'SRP (custom)';
    var input = names.indexOf('com.unity.inputsystem') !== -1
      ? 'new Input System (package present)'
      : 'legacy Input Manager (no Input System package)';
    var tree = s.tree || {};
    var folders = Object.keys(tree).sort(function (a, b) { return tree[b] - tree[a]; }).slice(0, 10)
      .map(function (f) { return f + ' (' + tree[f] + ')'; });
    var allScripts = (s.scripts || []).slice();
    var scriptCount = s.scriptCount != null ? s.scriptCount : allScripts.length;
    var allScenes = (s.scenes || []).slice();
    var allPrefabs = (s.prefabs || []).slice();
    var capChars = MAP_TOKEN_CAP * DEFAULT_CHARS_PER_TOKEN;
    var shownScripts = allScripts.slice(0, 60);
    var shownScenes = allScenes.slice(0, 20);
    var shownPrefabs = allPrefabs.slice(0, 20);
    var truncated = false;
    function render() {
      var lines = [];
      lines.push('Unity ' + (s.unityVersion || 'unknown version'));
      lines.push('Render pipeline: ' + pipeline);
      lines.push('Input: ' + input);
      if (names.length) lines.push('Packages (' + names.length + '): ' + names.slice(0, 12).map(function (n) { return n + '@' + (pkgs[n] || ''); }).join(', '));
      if (folders.length) lines.push('Folders: ' + folders.join(', '));
      lines.push('Scripts (' + scriptCount + ' C# files): ' + shownScripts.join(', '));
      if (shownScenes.length) {
        lines.push('Scenes (' + allScenes.length + '): ' + shownScenes.map(function (sc) {
          return sc.path + ((sc.gameObjects && sc.gameObjects.length) ? ' (' + sc.gameObjects.slice(0, 8).join(', ') + ')' : '');
        }).join('; '));
      }
      if (shownPrefabs.length) lines.push('Prefabs (' + allPrefabs.length + '): ' + shownPrefabs.map(function (p) { return p.path; }).join(', '));
      return lines.join('\n');
    }
    var text = render();
    while (text.length > capChars && shownScripts.length > 10) {
      shownScripts = shownScripts.slice(0, Math.max(10, Math.floor(shownScripts.length / 2)));
      truncated = true;
      text = render();
    }
    while (text.length > capChars && shownScenes.length > 5) {
      shownScenes = shownScenes.slice(0, 5);
      truncated = true;
      text = render();
    }
    while (text.length > capChars && shownPrefabs.length > 5) {
      shownPrefabs = shownPrefabs.slice(0, 5);
      truncated = true;
      text = render();
    }
    if (text.length > capChars) { text = text.slice(0, capChars); truncated = true; }
    return {
      text: text,
      truncated: truncated,
      scripts: shownScripts,
      scriptCount: scriptCount,
      scenes: allScenes.map(function (sc) { return sc.path; }),
      prefabs: allPrefabs.map(function (p) { return p.path; }),
      packages: pkgs,
      unityVersion: s.unityVersion || null,
      pipeline: pipeline,
      input: input,
    };
  }
  ContextBudget.buildProjectMap = buildProjectMap;

  // Delta between two structured maps: added / removed scripts,
  // scenes and prefabs, package changes, version changes. At most 8
  // lines, then a count of the rest — the note is appended to the
  // chat, so it has to stay short. When either list was truncated
  // the diff says so: a truncated list cannot prove an absence.
  function diffProjectMap(oldMap, newMap) {
    var lines = [];
    var more = 0;
    function push(line) {
      if (lines.length < 8) lines.push(line);
      else more++;
    }
    if (!oldMap) return { lines: ['full map (first scan)'], more: 0 };
    if ((oldMap.unityVersion || null) !== (newMap.unityVersion || null)) {
      push('Unity version: ' + (oldMap.unityVersion || 'unknown') + ' → ' + (newMap.unityVersion || 'unknown'));
    }
    if (oldMap.pipeline !== newMap.pipeline) push('Render pipeline: ' + oldMap.pipeline + ' → ' + newMap.pipeline);
    if (oldMap.input !== newMap.input) push('Input: ' + oldMap.input + ' → ' + newMap.input);
    var oldPkgs = oldMap.packages || {};
    var newPkgs = newMap.packages || {};
    var pkgNames = {};
    Object.keys(oldPkgs).forEach(function (n) { pkgNames[n] = true; });
    Object.keys(newPkgs).forEach(function (n) { pkgNames[n] = true; });
    Object.keys(pkgNames).sort().forEach(function (n) {
      if (!(n in oldPkgs)) push('+ package ' + n + '@' + (newPkgs[n] || ''));
      else if (!(n in newPkgs)) push('− package ' + n);
      else if (oldPkgs[n] !== newPkgs[n]) push('~ package ' + n + ': ' + oldPkgs[n] + ' → ' + newPkgs[n]);
    });
    function listDiff(label, oldList, newList) {
      var oldSet = {};
      (oldList || []).forEach(function (p) { oldSet[p] = true; });
      var newSet = {};
      (newList || []).forEach(function (p) { newSet[p] = true; });
      (newList || []).forEach(function (p) { if (!oldSet[p]) push('+ ' + (label ? label + ' ' : '') + p); });
      (oldList || []).forEach(function (p) { if (!newSet[p]) push('− ' + (label ? label + ' ' : '') + p); });
    }
    listDiff('', oldMap.scripts, newMap.scripts);
    listDiff('', oldMap.scenes, newMap.scenes);
    listDiff('', oldMap.prefabs, newMap.prefabs);
    if ((oldMap.truncated || newMap.truncated) && lines.length) lines.push('(script/scene lists truncated — changes may be incomplete)');
    return { lines: lines, more: more };
  }
  ContextBudget.diffProjectMap = diffProjectMap;

  // ── Meter segments ────────────────────────────────────────────
  // Splits the loaded window into fixed (system prompt minus the
  // map), map, history (non-result messages), results (tool-result
  // messages), the reply reserve, and free space. Percentages are
  // of the loaded window.
  function meterSegments(o) {
    o = o || {};
    var loaded = Number(o.loadedContext) || CONTEXT_FALLBACK;
    var reserve = Number(o.outputReserve) || 0;
    var system = Math.max(0, Number(o.systemTokens) || 0);
    var map = Math.max(0, Number(o.mapTokens) || 0);
    var history = Math.max(0, Number(o.historyTokens) || 0);
    var results = Math.max(0, Math.min(history, Number(o.resultTokens) || 0));
    var historyOnly = history - results;
    var used = system + map + history + reserve;
    var free = Math.max(0, loaded - used);
    function seg(key, tokens) {
      return { key: key, tokens: tokens, pct: Math.round(tokens / loaded * 1000) / 10 };
    }
    return {
      loaded: loaded,
      known: !!o.loadedContext,
      segments: [seg('fixed', system), seg('map', map), seg('history', historyOnly), seg('results', results), seg('reserve', reserve), seg('free', free)],
      used: used,
      free: free,
      usedPct: Math.round(used / loaded * 1000) / 10,
    };
  }
  ContextBudget.meterSegments = meterSegments;

  // ── Stream metadata ───────────────────────────────────────────
  // The server's own numbers, when the stream carries them. LM
  // Studio with stream_options.include_usage puts `usage` in the
  // final chunk; Ollama's done message carries prompt_eval_count
  // and done_reason. Anything else returns nulls — the caller
  // falls back to estimation and never invents a number.
  function parseStreamMeta(parsed) {
    var out = { promptTokens: null, finishReason: null };
    if (!parsed || typeof parsed !== 'object') return out;
    if (parsed.usage && typeof parsed.usage.prompt_tokens === 'number') out.promptTokens = parsed.usage.prompt_tokens;
    if (typeof parsed.prompt_eval_count === 'number') out.promptTokens = parsed.prompt_eval_count;
    var ch = parsed.choices && parsed.choices[0];
    if (ch && typeof ch.finish_reason === 'string' && ch.finish_reason) out.finishReason = ch.finish_reason;
    if (typeof parsed.done_reason === 'string' && parsed.done_reason) out.finishReason = parsed.done_reason;
    return out;
  }
  ContextBudget.parseStreamMeta = parseStreamMeta;

  if (typeof module !== 'undefined' && module.exports) module.exports = ContextBudget;
  if (typeof window !== 'undefined') window.ContextBudget = ContextBudget;
})();
