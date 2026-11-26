// unity-command.js — run one command through the Unity bridge (v0.9.0).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// this file directly with `node` (stub fs / sleep). main.js requires
// it for the unity:command IPC.
//
// How it works: the CodeFox bridge (Assets/Editor/CodeFoxBridge.cs)
// polls Assets/.codefox-command.json once a second in the Editor.
// This writes the command there, then polls for the result file
// Assets/.codefox-result.json the bridge writes back. The bridge
// deletes the command file; this deletes the result file after
// reading it, so a stale result can never be mistaken for a new one.
//
// Every failure is a plain message, never a raw exception: a missing
// bridge, a timeout (Unity not open, or the bridge not loaded), and
// a malformed result are all reported in words the model and the
// user can act on.

const fs = require('fs');
const path = require('path');
const unityBridge = require('./unity-bridge');

const COMMAND_FILE = '.codefox-command.json';
const RESULT_FILE = '.codefox-result.json';
const BRIDGE_MISSING_ERROR = 'The CodeFox bridge is not installed in this project — install it in Settings → Connections, then open the project in Unity.';
const TIMEOUT_ERROR = 'Unity did not answer in 60 seconds — is the project open in Unity with the bridge loaded?';

// Run one bridge command and return the parsed result:
//   { ok: true, message, path, data } on success, or
//   { ok: false, error } on failure (error is always a plain
//   message). `overrides` exists for the smoke test: { fs, sleep,
//   timeoutMs, pollMs, bridgeInstalled }.
async function runUnityCommand(projectPath, command, overrides) {
  const o = overrides || {};
  const f = o.fs || fs;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : 60000;
  const pollMs = o.pollMs != null ? o.pollMs : 250;
  const bridgeInstalled = o.bridgeInstalled || ((p) => unityBridge.bridgeInstalled(p));

  const root = projectPath || '';
  if (!root || !bridgeInstalled(root)) return { ok: false, error: BRIDGE_MISSING_ERROR };
  if (!command || typeof command !== 'object' || !command.action) {
    return { ok: false, error: 'No Unity command given — expected an object like {"action": "createPrefab", ...}.' };
  }

  const commandPath = path.join(root, 'Assets', COMMAND_FILE);
  const resultPath = path.join(root, 'Assets', RESULT_FILE);
  try { if (f.existsSync(resultPath)) f.unlinkSync(resultPath); } catch (e) { /* stale result is best-effort */ }
  try {
    f.writeFileSync(commandPath, JSON.stringify(command), 'utf8');
  } catch (e) {
    return { ok: false, error: 'Could not write the Unity command file: ' + e.message };
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let exists = false;
    try { exists = f.existsSync(resultPath); } catch (e) { return { ok: false, error: e.message }; }
    if (exists) {
      let raw = '';
      try { raw = f.readFileSync(resultPath, 'utf8'); } catch (e) {
        return { ok: false, error: 'Could not read Unity\'s result file: ' + e.message };
      }
      try { f.unlinkSync(resultPath); } catch (e) { /* result already read */ }
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) {
        return { ok: false, error: 'Unity returned a result CodeFox could not read: ' + String(raw).slice(0, 200) };
      }
      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: 'Unity returned a result CodeFox could not read: ' + String(raw).slice(0, 200) };
      }
      if (parsed.ok) {
        return { ok: true, message: parsed.message || '', path: parsed.path || '', data: parsed.data };
      }
      return { ok: false, error: parsed.message || 'Unity reported a failure with no message.', message: parsed.message || '' };
    }
    if (Date.now() >= deadline) return { ok: false, error: TIMEOUT_ERROR };
    await sleep(pollMs);
  }
}

module.exports = { runUnityCommand, COMMAND_FILE, RESULT_FILE, BRIDGE_MISSING_ERROR, TIMEOUT_ERROR };
