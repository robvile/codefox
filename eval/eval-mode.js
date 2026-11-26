// eval-mode.js — the in-app eval driver (v0.18.0).
//
// Loaded on demand by app.js (maybeStartEvalMode) only when the app
// was launched with --eval-* flags. It drives the REAL agent loop
// (sendChat -> runAgentTurn) with a scripted approval policy,
// grades each task against the fixture project, and writes the
// results JSON the runner waits for. It never runs in a normal
// launch, and it never calls the model for judging — every check
// is programmatic (see eval-tasks.js).
//
// What a run looks like, per task, per repetition:
//   reset fixture -> baseline grade (checks must FAIL on the
//   untouched fixture, unless baselineMustFail is false) ->
//   fresh thread -> send the prompt through the real loop ->
//   grade the result -> reference run (reset, apply the reference
//   solution, grade) -> record. The fixture is reset again before
//   the next repetition, so runs are independent.
//
// Mock mode (--eval-mock) replaces the model with the task's canned
// replies. It proves the harness pipeline end to end on this VM
// (no Unity, no LM Studio needed) — it does NOT prove the model.
// Unity-backed checks are skipped in mock mode and the results
// file says so; task failures there are expected.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const EvalTasks = window.EvalTasks;
  if (!EvalTasks) { console.error('[eval] eval-tasks.js not loaded'); return; }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Per-run state, shared by the wrappers and runOneTask:
  // M = current run's metrics (the streamOneTurn wrapper reads it),
  // policy = the scripted approval decision for this task,
  // decisions = every decision the policy made this run,
  // mockReplies/mockIdx = the canned replies in mock mode.
  let M = null;
  let policy = 'auto';
  const decisions = [];
  let mockReplies = [];
  let mockIdx = 0;
  let promptHash = '';

  // ── status overlay (so a headless run is visible) ─────────────
  let overlayEl = null;
  function showOverlay() {
    overlayEl = document.createElement('div');
    overlayEl.id = 'eval-status';
    overlayEl.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;background:#111;color:#0f0;font:12px monospace;padding:10px 12px;border:1px solid #0f0;border-radius:6px;max-width:420px;white-space:pre-wrap;';
    overlayEl.textContent = 'eval: starting…';
    document.body.appendChild(overlayEl);
  }
  function setStatus(text) {
    console.log('[eval] ' + text);
    if (overlayEl) overlayEl.textContent = 'eval: ' + text;
  }

  function outDirOf(outPath) {
    const i = Math.max(outPath.lastIndexOf('/'), outPath.lastIndexOf('\\'));
    return i >= 0 ? outPath.slice(0, i) : '.';
  }

  // rb.fs.readFile returns { ok, content } (or { ok: false, error }),
  // not a plain string — unwrap it. Returns null when unreadable.
  async function readText(filePath) {
    let r = null;
    try { r = await rb.fs.readFile(filePath); } catch (e) { return null; }
    if (typeof r === 'string') return r;
    if (r && r.ok) return r.content;
    return null;
  }

  // ── the driver ─────────────────────────────────────────────────
  async function start(args) {
    showOverlay();
    const runId = args.runId || ('eval-' + Date.now().toString(36));
    const outPath = args.out || (args.evalDir + '/results/' + runId + '.json');
    const outDir = outDirOf(outPath);
    const projectDir = args.projectDir || (args.workDir + '/' + runId + '/project');
    const suite = args.suite || 'canary';
    const runs = Math.max(1, Math.min(5, Number(args.runs) || 1));
    const mock = !!args.mock;
    const startedAt = new Date().toISOString();
    let results = null;
    try {
      results = await runSuite({ runId, outPath, outDir, projectDir, suite, runs, mock, taskId: args.task || null, evalDir: args.evalDir, startedAt });
    } catch (e) {
      setStatus('FATAL: ' + (e && e.message ? e.message : e));
      results = {
        runId, suite, mock, startedAt, endedAt: new Date().toISOString(),
        error: String((e && e.message) || e), tasks: [],
        summary: { total: 0, passed: 0, passRate: 0, byTag: {} },
      };
    }
    // Always write the results file — the runner waits for it.
    try { await rb.fs.writeFile(outPath, JSON.stringify(results, null, 2)); } catch (e) { console.error('[eval] could not write results:', e); }
    setStatus('done — results at ' + outPath + ' — quitting');
    try { await sleep(500); } catch (e) {}
    try { await rb.app.quit(); } catch (e) { console.error('[eval] quit failed:', e); }
  }

  async function runSuite(opts) {
    const { runId, outDir, projectDir, suite, runs, mock, taskId, evalDir, startedAt } = opts;
    const noSanity = !!opts.noSanity;
    setStatus('loading tasks from ' + evalDir + '/tasks');
    const entries = await rb.fs.readDir(evalDir + '/tasks');
    // readDir returns [{ name, isDir, path }] (main.js), not strings.
    const names = (entries || []).map((e) => (typeof e === 'string' ? e : e.name)).filter((n) => /\.ya?ml$/.test(n)).sort();
    const tasks = [];
    const parseErrors = [];
    for (const name of names) {
      const text = await readText(evalDir + '/tasks/' + name);
      if (text == null) { parseErrors.push(name + ': could not read the file'); continue; }
      const parsed = EvalTasks.parseTask(text, name);
      if (!parsed.ok) { parseErrors.push(name + ': ' + parsed.errors.join('; ')); continue; }
      tasks.push(parsed.task);
    }
    if (parseErrors.length) throw new Error('task parse errors: ' + parseErrors.join(' | '));
    if (!tasks.length) throw new Error('no tasks found in ' + evalDir + '/tasks');
    const selected = EvalTasks.selectTasks(tasks, { suite, taskId }) || [];
    if (!selected.length) throw new Error('no tasks selected for suite=' + suite + (taskId ? ' task=' + taskId : ''));
    setStatus('selected ' + selected.length + ' task(s) x ' + runs + ' run(s)' + (mock ? ' [MOCK — no Unity, no model]' : ''));

    // Model + app identity, for the result key.
    let appVersion = 'unknown';
    try { appVersion = (await rb.app.ping()).version || appVersion; } catch (e) {}
    let llmStatus = null;
    try { llmStatus = await rb.llm.status(); } catch (e) { llmStatus = { error: String((e && e.message) || e) }; }
    // The profile only records what is actually known: the loaded
    // context length from lmstudio status, the tuned-load defaults
    // are NOT claimed unless this app loaded the model.
    const modelProfile = {
      provider: state.provider,
      model: currentModel(),
      quant: '',
      loadedContext: (llmStatus && llmStatus.loadedContextLength) || null,
      kvCacheQuant: '',
      flashAttention: null,
      loaded: !!(llmStatus && llmStatus.loaded),
    };
    let rulesetHash = '';
    try {
      const rulesets = await rb.db.getAll('rulesets');
      rulesetHash = EvalTasks.fnv1a(JSON.stringify((rulesets || []).map((r) => ({ name: r.name, content: r.content }))));
    } catch (e) {}
    let skillHash = '';
    try { skillHash = EvalTasks.fnv1a(JSON.stringify(enabledSkillFiles().map((s) => s.name || s.id))); } catch (e) {}

    // Save the user's settings; eval mode changes them in memory
    // only, and restores them before quitting.
    const savedSettings = {
      chatMode: state.chatMode, autoAcceptChanges: state.autoAcceptChanges,
      shellAutoMode: state.shellAutoMode, shellEnabled: state.shellEnabled,
      agentMaxRounds: state.agentMaxRounds,
    };
    state.autoAcceptChanges = false; // file writes go through the
    // apply bar by default; runOneTask switches this per task —
    // 'auto' tasks use the app's direct-apply path, 'deny' tasks
    // leave the bar up so the policy can decline it (see there).
    state.shellAutoMode = false;
    state.shellEnabled = true;

    // Scripted approval policy. The bar never renders headlessly:
    // the decision is returned directly. 'auto' approves everything,
    // 'deny' declines every bar (the denied-approval task).
    const origWait = window.waitForLoopDecision;
    window.waitForLoopDecision = function (/* showFn */) {
      const decision = policy === 'deny' ? 'declined' : 'approved';
      decisions.push(decision);
      return Promise.resolve({ decision });
    };

    // streamOneTurn wrapper: metrics + prompt hash in both modes,
    // canned replies in mock mode (mirroring the real function's
    // persistence so the loop behaves identically).
    const origStream = window.streamOneTurn;
    window.streamOneTurn = async function (messages, systemPrompt, threadId) {
      if (!promptHash && systemPrompt) promptHash = EvalTasks.fnv1a(systemPrompt);
      if (!mock) {
        const content = await origStream(messages, systemPrompt, threadId);
        if (M && content != null) {
          const actions = parseAgentActions(content);
          M.toolCalls += actions.length;
          M.invalidCalls += actions.filter((a) => a.valid === false).length;
          M.rounds += 1;
          M.estTokens += EvalTasks.estimateTokens(content) + EvalTasks.estimateTokens(JSON.stringify(messages));
        }
        return content;
      }
      const reply = mockReplies[mockIdx++] || '';
      try { await rb.db.insert('messages', { thread_id: threadId, role: 'assistant', content: reply }); } catch (e) {}
      if (state.activeThreadId === threadId) state.messages.push({ role: 'assistant', content: reply });
      if (M) {
        const actions = parseAgentActions(reply);
        M.toolCalls += actions.length;
        M.invalidCalls += actions.filter((a) => a.valid === false).length;
        M.rounds += 1;
        M.estTokens += EvalTasks.estimateTokens(reply) + EvalTasks.estimateTokens(JSON.stringify(messages));
      }
      return reply;
    };

    // The eval project: one project entry for the whole suite, its
    // folder wiped and re-seeded per run by resetFixture.
    setStatus('setting up eval project at ' + projectDir);
    const projects = (await rb.project.list()) || [];
    let proj = projects.find((p) => p.path === projectDir);
    if (!proj) proj = await rb.project.create('Eval ' + runId, projectDir);
    await switchProject(proj.id);

    let unityAvailable = false;
    if (!mock) {
      setStatus('waiting for Unity (bridge heartbeat, up to 90s)…');
      unityAvailable = await waitForUnity(projectDir, 90000);
      setStatus(unityAvailable ? 'Unity is answering' : 'Unity is NOT answering — Unity-backed checks will be skipped');
    } else {
      setStatus('mock mode — skipping the Unity wait entirely');
    }

    const taskResults = [];
    const totalRuns = selected.length * runs;
    let doneRuns = 0;
    for (const task of selected) {
      const runResults = [];
      for (let n = 1; n <= runs; n++) {
        setStatus(task.id + ' run ' + n + '/' + runs);
        const rr = await runOneTask(task, n, { projectDir, evalDir, outDir, mock, unityAvailable, noSanity });
        runResults.push(rr);
        doneRuns++;
        try {
          await rb.fs.writeFile(outDir + '/progress.json', JSON.stringify({ runId, done: doneRuns, total: totalRuns, currentTask: task.id, currentRun: n, startedAt }));
        } catch (e) {}
      }
      const agg = EvalTasks.aggregateRuns(runResults.map((r) => ({ pass: !!r.pass, checks: r.checks || [] })));
      taskResults.push({
        id: task.id, title: task.title, tags: task.tags,
        pass: agg.passRate === 1, passRate: agg.passRate, consistent: agg.consistent,
        ciLow: agg.ciLow, ciHigh: agg.ciHigh, runs: runResults,
      });
    }

    const passedCount = taskResults.filter((t) => t.pass).length;
    const summary = {
      total: taskResults.length, passed: passedCount,
      passRate: taskResults.length ? passedCount / taskResults.length : 0,
      byTag: EvalTasks.sliceByTag(taskResults),
    };
    const resultKey = EvalTasks.buildResultKey({
      model: modelProfile, appVersion, rulesetHash, skillHash, promptHash,
    });
    const results = {
      runId, suite, mock, startedAt, endedAt: new Date().toISOString(),
      appVersion, modelProfile, resultKey,
      unityAvailable, promptHash, rulesetHash, skillHash,
      tasks: taskResults, summary,
      note: mock
        ? 'MOCK RUN — no Unity and no model: Unity-backed checks were skipped, so task passes here prove the harness pipeline, not the model. Run live (npm run eval) for real pass rates.'
        : 'Live run against Unity + the configured LM Studio model.',
    };

    // Restore everything, then the caller writes results + quits.
    window.waitForLoopDecision = origWait;
    window.streamOneTurn = origStream;
    state.chatMode = savedSettings.chatMode;
    state.autoAcceptChanges = savedSettings.autoAcceptChanges;
    state.shellAutoMode = savedSettings.shellAutoMode;
    state.shellEnabled = savedSettings.shellEnabled;
    state.agentMaxRounds = savedSettings.agentMaxRounds;
    setStatus('suite done: ' + summary.passed + '/' + summary.total + ' tasks passed');
    return results;
  }

  // Goal checks are the ones that must fail on the untouched
  // fixture (state, compiles, file, probe, console_clean). Guard
  // checks (no_collateral, nothing_changed, approval_denied) pass
  // on the untouched fixture by construction and say nothing about
  // whether the grader works.
  function goalOutcome(checkResults) {
    const goal = (checkResults || []).filter((c) => ['state', 'compiles', 'file', 'probe', 'console_clean'].indexOf(c.type) >= 0);
    return {
      ran: goal.filter((c) => !c.skipped).length,
      passed: goal.filter((c) => c.pass && !c.skipped).length,
      failed: goal.filter((c) => !c.pass && !c.skipped).length,
    };
  }
  // Baseline sanity: true = the grader is sound for this task,
  // false = broken (a goal check passed on the untouched fixture,
  // or failed when it should have passed), null = no goal check
  // actually ran (e.g. mock mode with no Unity) — ungradeable,
  // not broken.
  function baselineOutcome(task, checkResults) {
    const g = goalOutcome(checkResults);
    if (!task.baselineMustFail) return g.failed > 0 ? false : true;
    if (g.failed > 0 && g.passed === 0) return true;
    if (g.passed > 0) return false;
    return null;
  }

  // Wait for a fresh bridge heartbeat (Unity open, bridge loaded).
  async function waitForUnity(projectDir, budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      try {
        const hb = await rb.unity.heartbeat(projectDir);
        if (hb && hb.ok) return true;
      } catch (e) {}
      await sleep(1000);
    }
    return false;
  }

  // Reset the fixture and make sure the bridge is in place
  // afterwards. The bridge is preserved across resets (main.js
  // stashes it), so this is usually a no-op version check — but
  // the first reset of a fresh project has no bridge at all, and
  // a stale one must be updated before any command runs. In live
  // mode, wait for a fresh heartbeat after the reset in case the
  // bridge rewrite triggered a domain reload (nearly free when
  // the bridge was already current).
  async function resetFixtureAndBridge(ctx) {
    const reset = await rb.eval.resetFixture({ projectDir: ctx.projectDir, fixture: ctx.fixture, evalDir: ctx.evalDir });
    if (!reset.ok) return reset;
    try { await rb.unity.ensureBridge(ctx.projectDir); } catch (e) {}
    // Re-hash AFTER the bridge ensure: ensureBridge writes the
    // bridge file (and the refresh trigger) into the project, and
    // the baseline must include them or every task fails
    // no_collateral on files the harness itself created.
    const after = await rb.eval.hashTree({ projectDir: ctx.projectDir });
    if (after && after.ok) {
      if (!ctx.mock && ctx.unityAvailable) await waitForUnity(ctx.projectDir, 60000);
      return { ok: true, files: after.files, hashes: after.hashes };
    }
    if (!ctx.mock && ctx.unityAvailable) await waitForUnity(ctx.projectDir, 60000);
    return reset;
  }

  // One task, one repetition. Returns the run result record.
  async function runOneTask(task, n, ctx) {
    const { projectDir, evalDir, mock } = ctx;
    // Fresh metrics for this run (the streamOneTurn wrapper reads M).
    M = { toolCalls: 0, invalidCalls: 0, rounds: 0, estTokens: 0, maxRoundSeen: 0, refusalRetries: 0, enforcementRetried: false };
    decisions.length = 0;
    policy = task.approvals || 'auto';
    // File writes go through the apply bar, and that bar's only
    // success decision is 'applied' — the write happens in the
    // bar's Apply handler, so the policy wrapper's 'approved'
    // would read as a decline. Auto-accept is the app's own
    // direct-apply path for file writes (snapshots + git backup
    // still apply), so 'auto' tasks set it on and 'deny' tasks
    // leave it off — in deny mode a file write reaches the bar
    // and the wrapper declines it. Scene / shell / package /
    // git-restore bars settle 'approved' / 'declined' directly,
    // so the wrapper covers those.
    state.autoAcceptChanges = (policy === 'auto');
    mockReplies = task.mockReplies || [];
    mockIdx = 0;

    // Reset the fixture; its file list + hashes are the baseline
    // every no_collateral / nothing_changed check compares against.
    const reset = await resetFixtureAndBridge({ projectDir, fixture: task.fixture, evalDir, mock, unityAvailable: ctx.unityAvailable });
    if (!reset.ok) {
      return { run: n, pass: false, error: 'fixture reset failed: ' + (reset.error || 'unknown'), checks: [], metrics: M, wallMs: 0 };
    }
    const baseline = { files: reset.files, hashes: reset.hashes };
    const unityAvailable = ctx.unityAvailable;

    // Baseline sanity: the checks must FAIL on the untouched
    // fixture (unless baselineMustFail is false, e.g. read-only).
    // A baseline that already passes means the grader is broken
    // for this task — the run is marked failed and the note says why.
    // Skipped with --no-sanity (quicker, weaker).
    let baselineOk = null;
    if (!ctx.noSanity) {
      const baseWorld = await collectWorld(task, { projectDir, baseline, unityAvailable, decisions: [] });
      const baseGraded = EvalTasks.evaluateChecks(task.checks, baseWorld);
      baselineOk = baselineOutcome(task, baseGraded.results);
    }

    // Fresh thread for the turn.
    let threadId = null;
    try {
      threadId = await rb.db.insert('threads', { name: 'eval ' + task.id + ' #' + n, project_id: state.activeProjectId });
    } catch (e) {
      return { run: n, pass: false, error: 'could not create eval thread: ' + e.message, checks: [], metrics: M, wallMs: 0 };
    }
    await loadThread(Number(threadId));
    setChatMode(task.mode);
    state.agentMaxRounds = task.budget.maxTurns;

    const started = Date.now();
    const poller = setInterval(() => {
      if (typeof loopState !== 'undefined' && loopState) {
        M.maxRoundSeen = Math.max(M.maxRoundSeen, loopState.round || 0);
        M.refusalRetries = loopState.refusalRetries || 0;
        M.enforcementRetried = !!loopState.enforcementRetried;
      }
    }, 500);
    let sendError = null;
    try {
      document.getElementById('chat-input').value = task.prompt;
      await sendChat();
    } catch (e) { sendError = String((e && e.message) || e); }
    clearInterval(poller);
    const wallMs = Date.now() - started;

    // Transcript (JSONL) next to the results file.
    const transcript = (state.messages || []).map((m) => ({ role: m.role, content: m.content }));
    let transcriptFile = null;
    try {
      transcriptFile = task.id + '-run' + n + '.jsonl';
      await rb.fs.writeFile(ctx.outDir + '/' + transcriptFile, transcript.map((m) => JSON.stringify(m)).join('\n') + '\n');
    } catch (e) { transcriptFile = null; }

    // Grade the world the model left behind.
    const world = await collectWorld(task, { projectDir, baseline, unityAvailable, decisions: decisions.slice() });
    const graded = EvalTasks.evaluateChecks(task.checks, world);
    const checks = graded.results;
    let pass = graded.passed && baselineOk !== false;
    if (baselineOk === false) {
      checks.push({ type: 'baseline_sanity', pass: false, skipped: false, detail: 'baseline sanity failed — a goal check ' + (task.baselineMustFail ? 'passed' : 'failed') + ' on the untouched fixture, so this task cannot grade anything' });
      pass = false;
    }
    if (sendError) {
      checks.push({ type: 'harness', pass: false, skipped: false, detail: 'sendChat threw: ' + sendError });
      pass = false;
    }

    // Reference run: reset, apply the reference solution, grade.
    // A reference that does not pass means the grader (or the
    // reference) is broken — recorded, never silently ignored.
    // reference: null skips it (e.g. the denied-approval task).
    // Skipped with --no-sanity.
    let referenceOk = null;
    let referenceDetail = null;
    if (task.reference !== null && !ctx.noSanity) {
      const r2 = await resetFixtureAndBridge({ projectDir, fixture: task.fixture, evalDir, mock, unityAvailable: ctx.unityAvailable });
      if (!r2.ok) {
        referenceOk = false;
        referenceDetail = 'reference reset failed: ' + (r2.error || 'unknown');
      } else {
        let cmdFailed = null;
        for (const [rel, content] of Object.entries(task.reference.files || {})) {
          const w = await rb.fs.writeFile(projectDir + '/' + rel, content);
          if (w && w.ok === false) cmdFailed = 'could not write reference file ' + rel + ': ' + (w.error || '');
        }
        for (const cmd of (task.reference.commands || [])) {
          if (cmdFailed) break;
          const r = await rb.unity.runCommand({ projectPath: projectDir, command: cmd });
          if (!r.ok) cmdFailed = 'reference command failed (' + (cmd.action || '?') + '): ' + (r.error || 'unknown');
        }
        if (cmdFailed) {
          if (!unityAvailable) {
            // No Unity answering (mock mode, or Unity closed):
            // the command never reached Unity, so this is
            // unconfirmed, not a broken reference.
            referenceOk = null;
            referenceDetail = 'reference commands need Unity — unconfirmed: ' + cmdFailed;
          } else {
            referenceOk = false;
            referenceDetail = cmdFailed;
          }
        } else {
          const refWorld = await collectWorld(task, { projectDir, baseline, unityAvailable, decisions: [] });
          const refGraded = EvalTasks.evaluateChecks(task.checks, refWorld);
          const g = goalOutcome(refGraded.results);
          if (!refGraded.passed || g.failed > 0) {
            referenceOk = false;
            referenceDetail = 'reference solution did not pass: ' + refGraded.results.filter((c) => !c.pass && !c.skipped).map((c) => c.type + ' — ' + (c.detail || '')).join('; ');
          } else if (g.passed > 0) {
            referenceOk = true;
          } else {
            referenceOk = null; // no goal check ran — cannot confirm the reference
            referenceDetail = 'reference run graded only guard checks (no Unity) — unconfirmed';
          }
        }
      }
    }
    if (referenceOk === false) {
      checks.push({ type: 'reference_sanity', pass: false, skipped: false, detail: referenceDetail || 'reference solution did not pass' });
      pass = false;
    }

    return {
      run: n, pass, baselineOk, referenceOk, referenceDetail,
      checks, metrics: { ...M, wallMs },
      transcript: transcriptFile, error: sendError,
    };
  }

  // Read the world a task's checks grade against. Unity-backed
  // reads return skipped=true when Unity is not answering, so a
  // mock run (or a closed Unity) degrades to the file checks
  // instead of failing every task.
  async function collectWorld(task, ctx) {
    const { projectDir, baseline, unityAvailable } = ctx;
    const world = {
      files: {}, state: {}, compiles: null, consoleReport: null,
      probeLines: null, fileChanges: [],
      transcriptActions: [], declines: (ctx.decisions || []).filter((d) => d === 'declined').length,
      unityAvailable: !!unityAvailable,
    };
    // File contents for file checks.
    for (const c of task.checks) {
      if (c.type !== 'file') continue;
      world.files[c.path] = await readText(projectDir + '/' + c.path);
    }
    // What changed vs the fixture baseline.
    try {
      const after = await rb.eval.hashTree({ projectDir });
      if (after && after.ok) {
        const base = baseline.hashes || {};
        for (const rel of Object.keys(after.hashes)) {
          if (base[rel] !== after.hashes[rel]) world.fileChanges.push(rel);
        }
        for (const rel of Object.keys(base)) {
          if (!(rel in after.hashes)) world.fileChanges.push(rel);
        }
      }
    } catch (e) {}
    // Which actions the model actually attempted (from the
    // transcript) — the approval_denied check needs it.
    try {
      for (const m of (state.messages || [])) {
        if (m.role !== 'assistant') continue;
        for (const a of parseAgentActions(m.content || '')) {
          if (a.type === 'unity-command' && a.command && a.command.action) world.transcriptActions.push({ type: a.command.action });
        }
      }
    } catch (e) {}
    // Bridge-backed reads, only when Unity is answering. Without
    // Unity the check functions skip on world.unityAvailable, so
    // the world stays empty here and the run degrades to the file
    // checks instead of failing every task.
    const hasState = task.checks.some((c) => c.type === 'state');
    const hasCompiles = task.checks.some((c) => c.type === 'compiles');
    const consoleCheck = task.checks.find((c) => c.type === 'console_clean');
    const probeCheck = task.checks.find((c) => c.type === 'probe');
    if (!unityAvailable) return world;
    for (const c of task.checks.filter((x) => x.type === 'state')) {
      const res = await rb.unity.runCommand({ projectPath: projectDir, command: { action: 'read_component_values', path: c.path, component: c.component } });
      const key = c.path + '|' + c.component;
      if (res.ok && res.data) {
        world.state[key] = { ok: true, exists: true, values: res.data.values || {}, runtime: res.data.runtime || {} };
      } else {
        world.state[key] = { ok: false, exists: false, error: (res && res.error) || 'read failed' };
      }
    }
    if (hasCompiles) {
      const res = await rb.unity.runCommand({ projectPath: projectDir, command: { action: 'recompile_and_report_errors' } });
      if (res.ok) {
        world.compiles = { success: !!(res.data && res.data.success !== false), errors: (res.data && res.data.errors) || [] };
      } else {
        world.compiles = { success: false, errors: [] };
      }
    }
    if (consoleCheck) {
      const res = await rb.unity.runCommand({ projectPath: projectDir, command: { action: 'set_play_mode', enabled: true, durationSeconds: consoleCheck.seconds || 5 } });
      world.consoleReport = (res.ok && res.data) ? { errorCount: res.data.errorCount, warningCount: res.data.warningCount, firstErrors: res.data.firstErrors || [] } : { error: (res && res.error) || 'timed run failed' };
    }
    if (probeCheck) {
      const pr = await runProbe(task, probeCheck, projectDir);
      world.probeLines = pr.lines || null;
      if (pr.error) console.error('[eval] probe error:', pr.error);
    }
    return world;
  }

  // Scripted play-test for a probe check: mark the console, enter
  // Play Mode without a duration, inject the scripted input, wait,
  // read the [EVAL] lines since the mark, exit Play Mode. Always
  // exits Play Mode, even when a step fails. Returns
  // { lines: [{key, value}] } or { error }.
  async function runProbe(task, probeCheck, projectDir) {
    const seconds = probeCheck.seconds || 5;
    const mark = await rb.unity.runCommand({ projectPath: projectDir, command: { action: 'readConsole', mark: true } });
    if (!mark.ok || !mark.data || mark.data.cursor == null) {
      return { error: 'could not mark the console: ' + ((mark && mark.error) || 'no cursor') };
    }
    const cursor = mark.data.cursor;
    try {
      const enter = await rb.unity.runCommand({ projectPath: projectDir, command: { action: 'set_play_mode', enabled: true } });
      if (!enter.ok) return { error: 'could not enter Play Mode: ' + (enter.error || 'unknown') };
      if (Array.isArray(probeCheck.inject) && probeCheck.inject.length) {
        const inj = await rb.unity.runCommand({ projectPath: projectDir, command: { action: 'inject_input', steps: probeCheck.inject } });
        if (!inj.ok) return { error: 'inject_input failed: ' + (inj.error || 'unknown') };
      }
      await sleep(seconds * 1000);
      const read = await rb.unity.runCommand({ projectPath: projectDir, command: { action: 'readConsole', sinceSeq: cursor } });
      if (!read.ok || !read.data) return { error: 'could not read the console: ' + ((read && read.error) || 'unknown') };
      const lines = [];
      for (const e of (read.data.entries || [])) {
        const m = String(e.message || '').match(/^\[EVAL\] ([A-Za-z0-9_]+)=(.+)$/);
        if (m) lines.push({ key: m[1], value: m[2].trim() });
      }
      return { lines };
    } finally {
      try { await rb.unity.runCommand({ projectPath: projectDir, command: { action: 'set_play_mode', enabled: false } }); } catch (e) {}
    }
  }

  window.__evalMode = { start };
})();
