// eval-tasks.js — the eval harness's pure core (v0.18.0).
//
// Plain JavaScript, no dependencies, no Node-only APIs: it runs in
// three places — the Node runner (require), the smoke test
// (require), and the Electron renderer (classic <script>, where it
// is window.EvalTasks). It must never touch the filesystem, the
// bridge, or the LLM; the driver (eval-mode.js / the runner) owns
// all of that and hands this module plain data.
//
// What lives here:
//   - a minimal YAML-subset parser (exactly what eval/tasks/*.yaml
//     uses: nested maps, lists, block scalars, inline flow lists,
//     quoted strings, numbers, booleans)
//   - task parsing + validation + defaults
//   - check evaluation against a plain "world" object (all
//     programmatic — no LLM-as-judge, ever)
//   - k-run aggregation (pass rate, consistency, Wilson interval)
//   - flip detection vs a previous run, canary selection, and the
//     result-key builder (model profile + app version + ruleset
//     hash + skill hash + prompt hash).
(function () {
  'use strict';

  var EvalTasks = {};

  // ── Small hash ────────────────────────────────────────────────
  // FNV-1a, 32-bit, rendered as 8 hex chars. Used for ruleset /
  // skill / prompt hashes in the result key. It is not a security
  // hash — it only has to change when the input changes.
  function fnv1a(str) {
    var h = 0x811c9dc5;
    var s = String(str == null ? '' : str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  EvalTasks.fnv1a = fnv1a;

  // Token estimate for metrics (non-gating): ~4 chars per token,
  // the same rough rule the rest of the app uses. Labelled as an
  // estimate wherever it is shown — LM Studio's streaming endpoint
  // does not report usage.
  function estimateTokens(text) {
    return Math.ceil(String(text == null ? '' : text).length / 4);
  }
  EvalTasks.estimateTokens = estimateTokens;

  // ── Minimal YAML-subset parser ────────────────────────────────
  // Supports only what the task files use. Anything else is an
  // error, not a silent misread — a task that does not parse never
  // runs, and the error names the line.
  //
  //   key: value            (string, number, boolean, null)
  //   key:                  (nested map, indented +2)
  //   key: [a, b]           (inline flow list)
  //   key: |                (literal block scalar, newlines kept)
  //   - item                (list item; "- key: value" starts a map)
  //   # full-line comments, and " # trailing" comments outside quotes
  //   'single' / "double" quoted scalars
  function parseYaml(text, filename) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    // Drop full-line comments and '---' markers, but KEEP blank
    // lines: they are content inside block scalars, and skipped
    // everywhere else.
    var src = [];
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (/^\s*#/.test(raw)) continue;
      if (/^---\s*$/.test(raw)) continue;
      src.push({ text: raw, line: i + 1, blank: /^\s*$/.test(raw) });
    }
    var pos = 0;

    function err(msg, line) {
      return (filename ? filename + ':' : '') + 'line ' + line + ': ' + msg;
    }
    function indentOf(s) {
      var m = /^ */.exec(s);
      return m ? m[0].length : 0;
    }
    function skipBlanks() {
      while (pos < src.length && src[pos].blank) pos++;
    }
    // Collect a literal block scalar: lines more indented than
    // `keyIndent`, newlines kept, common indent stripped. Blank
    // lines inside are kept as empty lines.
    function collectBlock(keyIndent) {
      var blockLines = [];
      var blockIndent = null;
      while (pos < src.length) {
        var bl = src[pos];
        if (bl.blank) { blockLines.push(''); pos++; continue; }
        var bi = indentOf(bl.text);
        if (bi <= keyIndent) break;
        if (blockIndent == null) blockIndent = bi;
        blockLines.push(bl.text.slice(blockIndent));
        pos++;
      }
      // A trailing blank line is the file's own newline, not content.
      while (blockLines.length && blockLines[blockLines.length - 1] === '') blockLines.pop();
      return blockLines.join('\n') + (blockLines.length ? '\n' : '');
    }
    // Strip a trailing " # comment" that sits outside quotes.
    function stripTrailingComment(s) {
      var inSingle = false, inDouble = false;
      for (var i = 0; i < s.length; i++) {
        var c = s[i];
        if (c === "'" && !inDouble) inSingle = !inSingle;
        else if (c === '"' && !inSingle) inDouble = !inDouble;
        else if (c === '#' && !inSingle && !inDouble && i > 0 && s[i - 1] === ' ') {
          return s.slice(0, i).replace(/\s+$/, '');
        }
      }
      return s;
    }
    function parseScalar(s) {
      var t = String(s).replace(/^\s+|\s+$/g, '');
      if (t === '' || t === '~' || t === 'null') return null;
      if (t === 'true') return true;
      if (t === 'false') return false;
      if ((t[0] === "'" && t[t.length - 1] === "'") || (t[0] === '"' && t[t.length - 1] === '"')) {
        var inner = t.slice(1, -1);
        if (t[0] === "'") return inner.replace(/''/g, "'");
        try { return JSON.parse(t); } catch (e) { return inner; }
      }
      if (/^-?\d+$/.test(t)) return parseInt(t, 10);
      if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
      if (t === '{}') return {};
      if (t[0] === '[' && t[t.length - 1] === ']') return parseFlowList(t);
      return t;
    }
    function parseFlowList(t) {
      var inner = t.slice(1, -1).trim();
      if (!inner) return [];
      // Split on commas outside quotes / brackets.
      var parts = [], cur = '', inSingle = false, inDouble = false, depth = 0;
      for (var i = 0; i < inner.length; i++) {
        var c = inner[i];
        if (c === "'" && !inDouble) inSingle = !inSingle;
        else if (c === '"' && !inSingle) inDouble = !inDouble;
        else if (!inSingle && !inDouble && (c === '[' || c === '{')) depth++;
        else if (!inSingle && !inDouble && (c === ']' || c === '}')) depth--;
        if (c === ',' && !inSingle && !inDouble && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += c;
      }
      parts.push(cur);
      return parts.map(function (p) { return parseScalar(p); });
    }
    // Parse a block starting at src[pos] whose lines are indented
    // at least `minIndent`. Returns { value, error }.
    function parseBlock(minIndent) {
      skipBlanks();
      if (pos >= src.length) return { value: null };
      var first = src[pos];
      var ind = indentOf(first.text);
      if (ind < minIndent) return { value: null };
      if (/^ *- /.test(first.text.slice(ind)) || first.text.slice(ind) === '-') {
        return parseList(ind);
      }
      return parseMap(ind);
    }
    function parseList(ind) {
      var out = [];
      while (pos < src.length) {
        skipBlanks();
        if (pos >= src.length) break;
        var item = src[pos];
        var cur = indentOf(item.text);
        if (cur !== ind) break;
        var body = item.text.slice(ind);
        if (!/^- /.test(body) && body !== '-') break;
        var after = body === '-' ? '' : body.slice(2);
        var lineNo = item.line;
        if (after === '') {
          pos++;
          var sub = parseBlock(ind + 1);
          if (sub.error) return sub;
          out.push(sub.value);
          continue;
        }
        if (after === '|') {
          pos++;
          out.push(collectBlock(ind));
          continue;
        }
        // "- key: value" — an inline map start. Rewrite the line
        // in place as a map entry at ind+2 and parse a map.
        var keyMatch = /^([^:#]+):(.*)$/.exec(after);
        if (keyMatch) {
          src[pos] = { text: ' '.repeat(ind + 2) + after, line: lineNo, blank: false };
          var m = parseMap(ind + 2);
          if (m.error) return m;
          out.push(m.value);
          continue;
        }
        out.push(parseScalar(stripTrailingComment(after)));
        pos++;
      }
      return { value: out };
    }
    function parseMap(ind) {
      var out = {};
      while (pos < src.length) {
        skipBlanks();
        if (pos >= src.length) break;
        var item = src[pos];
        var cur = indentOf(item.text);
        if (cur !== ind) break;
        var body = item.text.slice(ind);
        if (/^- /.test(body) || body === '-') break;
        var lineNo = item.line;
        var m = /^([^:#][^:]*):(.*)$/.exec(body);
        if (!m) return { error: err('expected "key: value"', lineNo) };
        var key = m[1].replace(/\s+$/, '');
        var rest = stripTrailingComment(m[2]).replace(/^\s+|\s+$/g, '');
        pos++;
        if (rest === '|') {
          out[key] = collectBlock(ind);
          continue;
        }
        if (rest === '') {
          var sub = parseBlock(ind + 1);
          if (sub.error) return sub;
          out[key] = sub.value;
          continue;
        }
        out[key] = parseScalar(rest);
      }
      return { value: out };
    }

    var top = parseMap(0);
    if (top.error) return { ok: false, error: top.error };
    skipBlanks();
    if (pos < src.length) {
      return { ok: false, error: err('unexpected content (bad indentation?)', src[pos].line) };
    }
    return { ok: true, value: top.value };
  }
  EvalTasks.parseYaml = parseYaml;

  // ── Task format ───────────────────────────────────────────────
  // A task is one YAML file in eval/tasks/. Fields:
  //   id (required), title, tags [], canary false,
  //   fixture 'base' | overlay dir name,
  //   prompt (required — the user message the harness sends),
  //   mode 'agent' | 'ask' | 'plan' (default 'agent'),
  //   budget { maxToolCalls 30, maxTurns 6, maxMinutes 10 },
  //   approvals 'auto' | 'deny' | 'ask' (default 'auto'),
  //   baselineMustFail true (a task whose checks already pass on
  //     the untouched fixture is a broken grader — except
  //     read-only style tasks, which set this false),
  //   checks [] (see CHECK_TYPES),
  //   reference null | { files { rel: content }, commands [bridge
  //     command objects] } — null skips the reference sanity run,
  //   mockReplies [] — canned assistant replies the mock LLM
  //     returns in order (the last one should be a plain summary
  //     with no actions, so the loop ends).
  var CHECK_TYPES = ['state', 'compiles', 'console_clean', 'probe', 'file', 'no_collateral', 'nothing_changed', 'approval_denied'];
  EvalTasks.CHECK_TYPES = CHECK_TYPES;

  var DEFAULT_BUDGET = { maxToolCalls: 30, maxTurns: 6, maxMinutes: 10 };

  function isPlainObject(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v);
  }

  function normalizeTask(raw, filename) {
    var errors = [];
    if (!isPlainObject(raw)) return { ok: false, errors: ['task is not a map'] };
    var t = {};
    t.id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!t.id) errors.push('missing id');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id)) errors.push('id must be lowercase letters, digits and dashes: ' + t.id);
    t.title = typeof raw.title === 'string' ? raw.title : t.id;
    t.tags = Array.isArray(raw.tags) ? raw.tags.map(String) : [];
    t.canary = raw.canary === true;
    t.fixture = typeof raw.fixture === 'string' && raw.fixture ? raw.fixture : 'base';
    t.prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
    if (!t.prompt.trim()) errors.push('missing prompt');
    t.mode = raw.mode === 'ask' || raw.mode === 'plan' ? raw.mode : 'agent';
    var b = isPlainObject(raw.budget) ? raw.budget : {};
    t.budget = {
      maxToolCalls: typeof b.maxToolCalls === 'number' && b.maxToolCalls > 0 ? Math.floor(b.maxToolCalls) : DEFAULT_BUDGET.maxToolCalls,
      maxTurns: typeof b.maxTurns === 'number' && b.maxTurns > 0 ? Math.floor(b.maxTurns) : DEFAULT_BUDGET.maxTurns,
      maxMinutes: typeof b.maxMinutes === 'number' && b.maxMinutes > 0 ? b.maxMinutes : DEFAULT_BUDGET.maxMinutes,
    };
    t.approvals = raw.approvals === 'deny' || raw.approvals === 'ask' ? raw.approvals : 'auto';
    t.baselineMustFail = raw.baselineMustFail !== false;
    t.checks = Array.isArray(raw.checks) ? raw.checks : [];
    for (var i = 0; i < t.checks.length; i++) {
      var c = t.checks[i];
      if (!isPlainObject(c) || CHECK_TYPES.indexOf(c.type) < 0) {
        errors.push('check #' + (i + 1) + ' has an unknown type: ' + (c && c.type));
      }
    }
    if (!t.checks.length) errors.push('no checks — a task with nothing to grade always passes');
    t.reference = raw.reference == null ? null : raw.reference;
    if (t.reference != null && !isPlainObject(t.reference)) errors.push('reference must be a map or null');
    t.mockReplies = Array.isArray(raw.mockReplies) ? raw.mockReplies.map(String) : [];
    if (errors.length) return { ok: false, errors: errors, file: filename || '' };
    return { ok: true, task: t };
  }
  EvalTasks.normalizeTask = normalizeTask;

  function parseTask(text, filename) {
    var parsed = parseYaml(text, filename);
    if (!parsed.ok) return { ok: false, errors: [parsed.error] };
    return normalizeTask(parsed.value, filename);
  }
  EvalTasks.parseTask = parseTask;

  // Pick the tasks for a run: suite 'canary' (canary: true only),
  // 'full' (everything), or a single task id.
  function selectTasks(tasks, opts) {
    var o = opts || {};
    if (o.taskId) {
      var one = (tasks || []).filter(function (t) { return t.id === o.taskId; });
      return one.length ? one : null;
    }
    if (o.suite === 'canary') return (tasks || []).filter(function (t) { return t.canary === true; });
    return (tasks || []).slice();
  }
  EvalTasks.selectTasks = selectTasks;

  // ── Check evaluation ──────────────────────────────────────────
  // evaluateCheck(check, world) -> { type, pass, skipped, detail }.
  // The world is plain data collected by the driver:
  //   unityAvailable bool — false when no bridge heartbeat (no
  //     Unity); bridge checks are then SKIPPED, never passed.
  //   state { "path|component": { ok, values } | { ok:false, error } }
  //   stateBaseline { "path|component": values } — for changed:
  //   compiles { success, errors } | null
  //   consoleReport { errorCount, warningCount, firstErrors } | null
  //   probeLines [{ key, value }] | null
  //   files { relPath: content } — contents the file checks read
  //   fileChanges [relPath] — changed vs the baseline snapshot
  //   transcriptActions [{ type, ... }] — tool actions the model
  //     emitted, parsed from its replies
  //   declines — how many approval decisions were declined
  //
  // Pass rule (evaluateChecks): every check passes or is skipped,
  // AND at least one check actually passed. A task whose checks
  // all skipped proves nothing and fails.
  var PROBE_GUARD = 'Assets/EvalProbe.cs'; // the harness-owned probe
  // is protected by every no_collateral / nothing_changed check,
  // whatever the task lists — the model must never touch it.

  function numEq(a, b) {
    return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 0.001;
  }
  function valueMatches(actual, expected) {
    if (expected != null && typeof expected === 'object') {
      if (typeof actual !== 'number') return false;
      if (expected.gt != null) return actual > expected.gt;
      if (expected.gte != null) return actual >= expected.gte;
      if (expected.lt != null) return actual < expected.lt;
      if (expected.lte != null) return actual <= expected.lte;
      return false;
    }
    if (typeof expected === 'number' && typeof actual === 'number') return numEq(actual, expected);
    return String(actual) === String(expected);
  }
  function stateKey(path, component) {
    return String(path || '') + '|' + String(component || '');
  }

  function evaluateCheck(check, world) {
    var w = world || {};
    var type = check.type;
    var skip = function (detail) { return { type: type, pass: false, skipped: true, detail: detail }; };
    var fail = function (detail) { return { type: type, pass: false, skipped: false, detail: detail }; };
    var pass = function (detail) { return { type: type, pass: true, skipped: false, detail: detail }; };

    if (type === 'state') {
      if (!w.unityAvailable) return skip('no Unity — state check needs the bridge');
      var key = stateKey(check.path, check.component);
      var res = (w.state || {})[key];
      if (!res) return fail('no state read for ' + check.path + ' / ' + check.component);
      if (!res.ok) {
        if (check.exists === false) return pass(check.path + ' correctly has no ' + check.component + ' (' + (res.error || 'not found') + ')');
        return fail(check.path + ' / ' + check.component + ': ' + (res.error || 'not found'));
      }
      if (check.exists === true) return pass(check.component + ' exists on ' + check.path);
      if (check.property == null) return pass(check.component + ' read on ' + check.path);
      var values = res.values || {};
      if (!(check.property in values)) {
        var names = Object.keys(values).slice(0, 8).join(', ');
        return fail('property ' + check.property + ' not on ' + check.component + ' (has: ' + names + ')');
      }
      var actual = values[check.property];
      if (check.changed === true) {
        var base = ((w.stateBaseline || {})[key] || {})[check.property];
        if (base === undefined) return fail('no baseline value for ' + check.property + ' to compare against');
        if (String(actual) === String(base)) return fail(check.property + ' unchanged (' + JSON.stringify(actual) + ')');
        return pass(check.property + ' changed ' + JSON.stringify(base) + ' -> ' + JSON.stringify(actual));
      }
      if (check.equals != null) {
        return valueMatches(actual, check.equals)
          ? pass(check.property + ' = ' + JSON.stringify(actual))
          : fail(check.property + ' is ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(check.equals));
      }
      if (check.gt != null || check.lt != null || check.gte != null || check.lte != null) {
        var exp = {};
        if (check.gt != null) exp.gt = check.gt;
        if (check.gte != null) exp.gte = check.gte;
        if (check.lt != null) exp.lt = check.lt;
        if (check.lte != null) exp.lte = check.lte;
        return valueMatches(actual, exp)
          ? pass(check.property + ' = ' + JSON.stringify(actual))
          : fail(check.property + ' is ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(exp));
      }
      return pass(check.property + ' = ' + JSON.stringify(actual));
    }

    if (type === 'compiles') {
      if (!w.unityAvailable) return skip('no Unity — compile check needs the bridge');
      if (!w.compiles) return fail('no compile result collected');
      if (w.compiles.success) return pass('project compiles');
      var errs = (w.compiles.errors || []).slice(0, 2).map(function (e) { return (e.file ? e.file + ':' + (e.line || '?') + ' ' : '') + (e.message || e); }).join('; ');
      return fail('compile errors: ' + (errs || 'unknown'));
    }

    if (type === 'console_clean') {
      if (!w.unityAvailable) return skip('no Unity — console check needs a Play Mode run');
      if (!w.consoleReport) return fail('no console report collected');
      if (w.consoleReport.errorCount === 0) return pass('console clean over the timed run');
      var first = ((w.consoleReport.firstErrors || [])[0] || '');
      return fail(w.consoleReport.errorCount + ' error(s) in the timed run' + (first ? ': ' + String(first).slice(0, 200) : ''));
    }

    if (type === 'probe') {
      if (!w.unityAvailable) return skip('no Unity — probe check needs a Play Mode run');
      var lines = w.probeLines || null;
      if (!lines) return fail('no probe lines collected');
      var expect = check.expect || {};
      var keys = Object.keys(expect);
      if (!keys.length) return fail('probe check has no expect map');
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var found = null;
        for (var j = 0; j < lines.length; j++) {
          if (lines[j].key === k) { found = lines[j]; break; }
        }
        if (!found) return fail('probe never logged ' + k);
        var want = expect[k];
        var got = found.value;
        var num = parseFloat(got);
        if (want != null && typeof want === 'object') {
          if (isNaN(num) || !valueMatches(num, want)) return fail('probe ' + k + ' = ' + got + ', expected ' + JSON.stringify(want));
        } else if (String(got) !== String(want)) {
          return fail('probe ' + k + ' = ' + got + ', expected ' + want);
        }
      }
      return pass('probe lines match: ' + keys.map(function (k) { return k + '=' + expect[k]; }).join(', '));
    }

    if (type === 'file') {
      var content = (w.files || {})[check.path];
      if (content == null) return fail('file not found: ' + check.path);
      if (check.contains != null) {
        return content.indexOf(check.contains) >= 0
          ? pass(check.path + ' contains the expected text')
          : fail(check.path + ' does not contain: ' + JSON.stringify(String(check.contains).slice(0, 120)));
      }
      if (check.regex != null) {
        var re;
        try { re = new RegExp(check.regex); } catch (e) { return fail('bad regex in check: ' + check.regex); }
        return re.test(content) ? pass(check.path + ' matches ' + check.regex) : fail(check.path + ' does not match ' + check.regex);
      }
      if (check.absent != null) {
        return content.indexOf(check.absent) < 0
          ? pass(check.path + ' does not contain the forbidden text')
          : fail(check.path + ' still contains: ' + JSON.stringify(String(check.absent).slice(0, 120)));
      }
      return pass(check.path + ' exists');
    }

    if (type === 'no_collateral' || type === 'nothing_changed') {
      var changed = w.fileChanges || [];
      var protect = ((check.protect || []).slice());
      if (protect.indexOf(PROBE_GUARD) < 0) protect.push(PROBE_GUARD);
      for (var p = 0; p < protect.length; p++) {
        if (changed.indexOf(protect[p]) >= 0) return fail('protected file changed: ' + protect[p]);
      }
      if (type === 'nothing_changed') {
        return changed.length === 0
          ? pass('nothing changed')
          : fail('files changed: ' + changed.slice(0, 5).join(', ') + (changed.length > 5 ? ' (+' + (changed.length - 5) + ' more)' : ''));
      }
      var allow = check.allowlist || null;
      if (allow) {
        var outside = changed.filter(function (f) { return allow.indexOf(f) < 0; });
        if (outside.length) return fail('changed outside the allowlist: ' + outside.slice(0, 5).join(', '));
      }
      return pass(changed.length ? 'only allowlisted files changed: ' + changed.join(', ') : 'nothing changed');
    }

    if (type === 'approval_denied') {
      var acts = w.transcriptActions || [];
      var asked = acts.some(function (a) { return a.type === (check.action || 'delete_gameobject'); });
      if (!asked) return fail('the model never asked to ' + (check.action || 'delete_gameobject'));
      if (!(w.declines > 0)) return fail('no approval was declined');
      var ch = w.fileChanges || [];
      if (ch.length) return fail('files changed despite the denial: ' + ch.slice(0, 3).join(', '));
      return pass('model asked, user denied, nothing changed');
    }

    return fail('unknown check type: ' + type);
  }
  EvalTasks.evaluateCheck = evaluateCheck;

  function evaluateChecks(checks, world) {
    var results = (checks || []).map(function (c) { return evaluateCheck(c, world); });
    var passedCount = results.filter(function (r) { return r.pass; }).length;
    var failed = results.filter(function (r) { return !r.pass && !r.skipped; });
    var passed = failed.length === 0 && passedCount > 0;
    return { results: results, passed: passed, passedCount: passedCount, failedCount: failed.length };
  }
  EvalTasks.evaluateChecks = evaluateChecks;

  // ── k-run aggregation ─────────────────────────────────────────
  // runs: [{ pass: bool }] — one entry per run of the same task.
  // A 5-point change on 15 tasks x 3 runs is noise, so the
  // interval is reported next to the rate and the runner never
  // calls a small move a regression. Wilson 95% interval.
  function wilsonInterval(passed, total) {
    if (!total) return { low: 0, high: 0 };
    var z = 1.96, p = passed / total;
    var denom = 1 + (z * z) / total;
    var centre = p + (z * z) / (2 * total);
    var spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
    return {
      low: Math.max(0, (centre - spread) / denom),
      high: Math.min(1, (centre + spread) / denom),
    };
  }
  EvalTasks.wilsonInterval = wilsonInterval;

  function aggregateRuns(runs) {
    var list = runs || [];
    var passed = list.filter(function (r) { return r.pass === true; }).length;
    var total = list.length;
    var ci = wilsonInterval(passed, total);
    var first = total ? list[0].pass : null;
    var consistent = total > 0 && list.every(function (r) { return r.pass === first; });
    return {
      runs: total,
      passed: passed,
      passRate: total ? passed / total : 0,
      consistent: consistent,
      ciLow: ci.low,
      ciHigh: ci.high,
    };
  }
  EvalTasks.aggregateRuns = aggregateRuns;

  // Flips vs a previous run: regressions matter more than the
  // headline rate. prev/curr are { taskId: passBool }.
  function detectFlips(prev, curr) {
    var out = [];
    var p = prev || {}, c = curr || {};
    var ids = {};
    Object.keys(p).forEach(function (k) { ids[k] = true; });
    Object.keys(c).forEach(function (k) { ids[k] = true; });
    Object.keys(ids).sort().forEach(function (id) {
      if (id in p && id in c && p[id] !== c[id]) {
        out.push({ id: id, from: !!p[id], to: !!c[id], regression: p[id] === true && c[id] === false });
      }
    });
    return out;
  }
  EvalTasks.detectFlips = detectFlips;

  // ── Result key ────────────────────────────────────────────────
  // A result is only comparable to another result with the same
  // key: model profile (id + quant + load settings), app version,
  // ruleset hash, skill hash, prompt hash. A changed quant is a
  // different model; a changed prompt is a different harness.
  function buildResultKey(parts) {
    var p = parts || {};
    var model = p.model || {};
    var modelId = [
      model.provider || 'unknown',
      model.model || 'unknown',
      model.quant || '',
      'ctx' + (model.loadedContext || model.contextLength || ''),
      'kv' + (model.kvCacheQuant || ''),
      'flash' + (model.flashAttention === true ? '1' : model.flashAttention === false ? '0' : ''),
    ].join('/');
    var key = [
      'app=' + (p.appVersion || '?'),
      'model=' + modelId,
      'rules=' + (p.rulesetHash || fnv1a(JSON.stringify(p.rulesets || []))),
      'skills=' + (p.skillHash || fnv1a(JSON.stringify(p.skills || []))),
      'prompt=' + (p.promptHash || fnv1a(p.systemPrompt || '')),
    ].join(' | ');
    return { key: key, hash: fnv1a(key) };
  }
  EvalTasks.buildResultKey = buildResultKey;

  // Slice results by tag for the summary.
  function sliceByTag(taskResults) {
    var out = {};
    (taskResults || []).forEach(function (tr) {
      (tr.tags || []).forEach(function (tag) {
        if (!out[tag]) out[tag] = { total: 0, passed: 0 };
        out[tag].total++;
        if (tr.pass) out[tag].passed++;
      });
    });
    return out;
  }
  EvalTasks.sliceByTag = sliceByTag;

  // ── Dual-mode export ──────────────────────────────────────────
  if (typeof module !== 'undefined' && module.exports) module.exports = EvalTasks;
  if (typeof window !== 'undefined') window.EvalTasks = EvalTasks;
  // Plain-script globals (classic scripts share one global scope):
  // eval-mode.js reads EvalTasks directly.
  if (typeof globalThis !== 'undefined') globalThis.EvalTasks = EvalTasks;
})();
