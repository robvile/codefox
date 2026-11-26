// unity-command.js — run one command through the Unity bridge (v0.12.0).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// this file directly with `node` (stub fs / sleep). main.js requires
// it for the unity:command IPC.
//
// How it works: the CodeFox bridge (Assets/Editor/CodeFoxBridge.cs,
// 0.12.0+) polls <project>/.bridge/inbox/ in the Editor. This
// writes the command there as <id>.json.tmp and renames it to
// <id>.json (so the bridge never reads a half-written command),
// then waits for the result in <project>/.bridge/outbox/<id>.json
// and deletes it after reading. The bridge writes a "pending"
// result first while it works (a compile report), then the final
// one — pending is alive, not a timeout.
//
// Before sending anything, this reads the bridge heartbeat
// (<project>/.bridge/heartbeat.json, written every poll tick): a
// fresh heartbeat means Unity is open with the bridge loaded; a
// stale or missing one means it is not responding, and the command
// fails fast with that message instead of waiting 60 seconds.
// While waiting, a heartbeat that goes stale (and is not
// compiling) also fails fast — that is what "Unity was killed
// mid-command" looks like. A compile extends the wait: while the
// heartbeat says Unity is compiling, the deadline does not advance.
//
// Every failure is a plain message, never a raw exception: a
// missing bridge, an out-of-date bridge (the .bridge/ transport
// arrived in 0.12.0 — an older bridge never sees the inbox, so
// this refuses rather than sending), a stale heartbeat, a timeout,
// and a malformed result are all reported in words the model and
// the user can act on.
//
// The old single-file protocol (Assets/.codefox-command.json /
// Assets/.codefox-result.json) is gone from this runner. The
// install path deletes those legacy files when it updates the
// bridge; the bridge itself never reads them.

const fs = require('fs');
const path = require('path');
const unityBridge = require('./unity-bridge');

const BRIDGE_DIR = '.bridge';
const INBOX_DIR = 'inbox';
const OUTBOX_DIR = 'outbox';
const HEARTBEAT_FILE = 'heartbeat.json';
const PROTOCOL_VERSION = 1;
const HEARTBEAT_FRESH_MS = 5000;
const BRIDGE_MISSING_ERROR = 'The CodeFox bridge is not installed in this project — install it in Settings → Connections, then open the project in Unity.';
const TIMEOUT_ERROR = 'Unity did not answer in 60 seconds — is the project open in Unity with the bridge loaded?';
const HEARTBEAT_ERROR = 'Unity is not responding — the bridge heartbeat is missing or stale. Is the project open in Unity with the bridge loaded?';
const HEARTBEAT_DIED_ERROR = 'Unity stopped responding while the command was running — the bridge heartbeat went stale. Check whether Unity is still open, then try again.';

// The oldest bridge that speaks the .bridge/ transport. main.js
// updates an older bridge before calling this; this check is the
// safety net, so an inbox command can never be sent to a bridge
// that would never see it.
function oldBridgeError(installed) {
  return 'The bridge installed in this project is from an older CodeFox (v' + (installed || '0.0.0')
    + '). It will be updated automatically the next time the project connects — or update it now in Settings → Connections (Update plugin) and wait for Unity to reload, then try again.';
}

// Request ids are file names. A name with a separator or a dot in
// it could escape the inbox — the bridge refuses to act on one,
// and this refuses to write one.
function isSafeBridgeRequestId(id) {
  if (!id || typeof id !== 'string' || id.length > 64) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);
}

// Unique per command: millisecond timestamp plus random hex, safe
// characters only.
function makeBridgeRequestId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Parse a heartbeat file's contents. Returns { ok, protocol,
// timeMs, isCompiling, isPlaying } or { ok:false, error } — never
// throws, so a half-written heartbeat (the bridge writes it
// atomically, but a torn read is still possible) is a plain miss.
function parseHeartbeat(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, error: 'empty heartbeat' };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, error: 'unreadable heartbeat' }; }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'unreadable heartbeat' };
  if (parsed.protocol !== PROTOCOL_VERSION) return { ok: false, error: 'unsupported heartbeat protocol' };
  const timeMs = Number(parsed.timeMs);
  if (!Number.isFinite(timeMs)) return { ok: false, error: 'heartbeat has no time' };
  return {
    ok: true,
    protocol: parsed.protocol,
    timeMs,
    isCompiling: parsed.isCompiling === true,
    isPlaying: parsed.isPlaying === true,
  };
}

// What a parsed heartbeat (or a missing one) means right now:
// 'fresh' — Unity is alive; 'stale-compiling' — the bridge has
// not ticked recently but was compiling when it last wrote, so
// give it more time; 'stale' — the bridge has not ticked and was
// not compiling; 'missing' — no heartbeat at all. Pure, so the
// smoke test can pin the decision without a clock.
function heartbeatStatus(heartbeat, nowMs) {
  if (!heartbeat || !heartbeat.ok) return 'missing';
  if (nowMs - heartbeat.timeMs < HEARTBEAT_FRESH_MS) return 'fresh';
  return heartbeat.isCompiling ? 'stale-compiling' : 'stale';
}

// Read and classify the heartbeat for a project. Returns
// { exists, fresh, isCompiling, isPlaying, timeMs, protocol } or
// { exists:false }. Used by main.js's unity:heartbeat IPC (the
// compile check's fast path) and by runUnityCommand below.
function readHeartbeat(projectPath, fsOverride) {
  const f = fsOverride || fs;
  const heartbeatPath = path.join(projectPath || '', BRIDGE_DIR, HEARTBEAT_FILE);
  let raw = null;
  try {
    if (!f.existsSync(heartbeatPath)) return { exists: false };
    raw = f.readFileSync(heartbeatPath, 'utf8');
  } catch (e) { return { exists: false }; }
  const parsed = parseHeartbeat(raw);
  if (!parsed.ok) return { exists: true, fresh: false, unparsable: true };
  const status = heartbeatStatus(parsed, Date.now());
  return {
    exists: true,
    fresh: status === 'fresh',
    staleCompiling: status === 'stale-compiling',
    isCompiling: parsed.isCompiling,
    isPlaying: parsed.isPlaying,
    timeMs: parsed.timeMs,
    protocol: parsed.protocol,
  };
}

// Classify one outbox file's contents: 'ok' / 'error' / 'pending'
// / 'unreadable'. Pure — the wait loop below only acts on the
// classification, never on raw JSON.
function classifyBridgeResult(raw) {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { return { state: 'unreadable', error: 'Unity returned a result CodeFox could not read: ' + String(raw).slice(0, 200) }; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.status !== 'string') {
    return { state: 'unreadable', error: 'Unity returned a result CodeFox could not read: ' + String(raw).slice(0, 200) };
  }
  if (parsed.status === 'ok') {
    return { state: 'ok', message: parsed.message || '', path: parsed.path || '', data: parsed.data };
  }
  if (parsed.status === 'pending') return { state: 'pending', message: parsed.message || '' };
  if (parsed.status === 'error') {
    return { state: 'error', error: parsed.message || 'Unity reported a failure with no message.', message: parsed.message || '' };
  }
  return { state: 'unreadable', error: 'Unity returned an unknown result status "' + parsed.status + '".' };
}

// Run one bridge command and return the parsed result:
//   { ok: true, message, path, data } on success, or
//   { ok: false, error } on failure (error is always a plain
//   message). `overrides` exists for the smoke test: { fs, sleep,
//   timeoutMs, pollMs, heartbeatWaitMs, now, bridgeInstalled,
//   getInstalledVersion }.
async function runUnityCommand(projectPath, command, overrides) {
  const o = overrides || {};
  const f = o.fs || fs;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : 60000;
  const pollMs = o.pollMs != null ? o.pollMs : 250;
  const heartbeatWaitMs = o.heartbeatWaitMs != null ? o.heartbeatWaitMs : 10000;
  const now = o.now || Date.now;
  const bridgeInstalled = o.bridgeInstalled || ((p) => unityBridge.bridgeInstalled(p));
  const getInstalledVersion = o.getInstalledVersion || ((p) => unityBridge.getInstalledBridgeVersion(p));

  const root = projectPath || '';
  if (!root || !bridgeInstalled(root)) return { ok: false, error: BRIDGE_MISSING_ERROR };
  if (!command || typeof command !== 'object' || !command.action) {
    return { ok: false, error: 'No Unity command given — expected an object like {"action": "createPrefab", ...}.' };
  }

  // Never send an inbox command to a bridge that predates the
  // transport — it would sit in the inbox forever, unread.
  const installed = getInstalledVersion(root);
  if (!installed || unityBridge.compareVersions(installed, unityBridge.MIN_TRANSPORT_VERSION) < 0) {
    return { ok: false, error: oldBridgeError(installed) };
  }

  // Wait for a fresh heartbeat: Unity open with the bridge loaded.
  // A heartbeat that says "compiling" is alive too — a compile can
  // starve the poll tick, so staleness alone is not a failure
  // while it compiles. After the wait budget, a missing or stale
  // heartbeat means Unity is not responding.
  const heartbeatPath = path.join(root, BRIDGE_DIR, HEARTBEAT_FILE);
  const heartbeatDeadline = now() + heartbeatWaitMs;
  let heartbeatOk = false;
  for (;;) {
    let raw = null;
    try { raw = f.existsSync(heartbeatPath) ? f.readFileSync(heartbeatPath, 'utf8') : null; } catch (e) { raw = null; }
    const status = heartbeatStatus(raw != null ? parseHeartbeat(raw) : null, now());
    if (status === 'fresh' || status === 'stale-compiling') { heartbeatOk = true; break; }
    if (now() >= heartbeatDeadline) break;
    await sleep(pollMs);
  }
  if (!heartbeatOk) return { ok: false, error: HEARTBEAT_ERROR };

  const id = makeBridgeRequestId();
  if (!isSafeBridgeRequestId(id)) return { ok: false, error: 'Could not make a safe bridge request id.' };
  const inboxDir = path.join(root, BRIDGE_DIR, INBOX_DIR);
  const outboxPath = path.join(root, BRIDGE_DIR, OUTBOX_DIR, id + '.json');
  const tmpPath = path.join(inboxDir, id + '.json.tmp');
  const inboxPath = path.join(inboxDir, id + '.json');
  try {
    f.mkdirSync(inboxDir, { recursive: true });
  } catch (e) { /* the bridge creates it too — the write below is the real test */ }
  try {
    f.writeFileSync(tmpPath, JSON.stringify({ ...command, protocol: PROTOCOL_VERSION, requestId: id }), 'utf8');
    f.renameSync(tmpPath, inboxPath);
  } catch (e) {
    return { ok: false, error: 'Could not write the Unity command file: ' + e.message };
  }

  // Wait for the outbox file. A "pending" result means the bridge
  // is alive and working (a compile report) — the deadline extends
  // while pending results arrive or the heartbeat says compiling.
  // The absolute cap stops a dead bridge waiting forever.
  const startMs = now();
  const absoluteDeadline = startMs + Math.max(timeoutMs, 360000);
  let deadline = startMs + timeoutMs;
  let lastFreshHeartbeatMs = startMs;
  let pendingSeen = false;
  for (;;) {
    // Heartbeat watch: if the bridge has not ticked (and was not
    // compiling) for a while, it died mid-command. Before a pending
    // result the budget is short — a reload has not started yet, so
    // ten seconds of silence means Unity is gone. After pending,
    // a domain reload is in progress (10–30s), so the budget is
    // a minute.
    let hbRaw = null;
    try { hbRaw = f.existsSync(heartbeatPath) ? f.readFileSync(heartbeatPath, 'utf8') : null; } catch (e) { hbRaw = null; }
    const hb = hbRaw != null ? parseHeartbeat(hbRaw) : null;
    if (hb && hb.ok && heartbeatStatus(hb, now()) !== 'stale') lastFreshHeartbeatMs = now();
    const staleBudgetMs = pendingSeen ? 60000 : 10000;
    if (now() - lastFreshHeartbeatMs > staleBudgetMs) return { ok: false, error: HEARTBEAT_DIED_ERROR };
    if (hb && hb.ok && hb.isCompiling) deadline = now() + timeoutMs;

    let exists = false;
    try { exists = f.existsSync(outboxPath); } catch (e) { return { ok: false, error: e.message }; }
    if (exists) {
      let raw = '';
      try { raw = f.readFileSync(outboxPath, 'utf8'); } catch (e) { raw = ''; }
      if (raw) {
        try { f.unlinkSync(outboxPath); } catch (e) { /* result already read */ }
        const classified = classifyBridgeResult(raw);
        if (classified.state === 'ok') {
          return { ok: true, message: classified.message, path: classified.path, data: classified.data };
        }
        if (classified.state === 'error') {
          return { ok: false, error: classified.error, message: classified.message };
        }
        if (classified.state === 'pending') {
          pendingSeen = true;
          deadline = now() + timeoutMs;
        } else {
          return { ok: false, error: classified.error };
        }
      }
      // A present-but-unreadable outbox file is retried next poll
      // (the bridge writes it atomically, so this is a transient
      // read racing the replace, not a torn write).
    }
    if (now() >= absoluteDeadline) return { ok: false, error: TIMEOUT_ERROR };
    if (now() >= deadline) return { ok: false, error: TIMEOUT_ERROR };
    await sleep(pollMs);
  }
}

module.exports = {
  runUnityCommand,
  readHeartbeat,
  parseHeartbeat,
  heartbeatStatus,
  classifyBridgeResult,
  isSafeBridgeRequestId,
  makeBridgeRequestId,
  oldBridgeError,
  BRIDGE_DIR,
  INBOX_DIR,
  OUTBOX_DIR,
  HEARTBEAT_FILE,
  PROTOCOL_VERSION,
  HEARTBEAT_FRESH_MS,
  BRIDGE_MISSING_ERROR,
  TIMEOUT_ERROR,
  HEARTBEAT_ERROR,
  HEARTBEAT_DIED_ERROR,
};
