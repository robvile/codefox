// log-triage.js — log-triage request detection (v0.12.0).
//
// Plain Node, no Electron dependency, so the smoke test can
// exercise this file directly with `node` (like file-tools.js and
// git-backup.js). The renderer carries an inline mirror of
// isLogTriageRequest (it cannot require this file — the same
// reason unity-assets.js and file-tools.js have inline mirrors);
// the smoke test pins the two copies to agree.
//
// Triage triggers when the user attaches or pastes a log (Editor,
// Player, build, device, or crash log) or asks why the editor is
// showing many errors, and the root cause needs to be found. A
// single error that can be read directly is NOT a triage request —
// that stays a normal fix turn, and the Diagnose error flow
// handles it. CodeFox has no file-attach UI, so "attaching" a log
// means pasting it into chat; detection works on the message text.

// Lines in a pasted log that count as error lines. A single
// exception plus its stack is ONE error (stack-frame lines do not
// count) — only lines naming an error do.
const TRIAGE_ERROR_LINE = /(error|exception|failed|fatal|crash)/i;

// How many error lines a pasted block needs before it counts as
// a log worth triaging, rather than one error pasted for a fix.
const TRIAGE_MIN_ERROR_LINES = 4;

function isLogTriageRequest(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  const lower = t.toLowerCase();
  // A pasted log: enough error lines to be a log, not one error.
  let errorLines = 0;
  for (const line of t.split(/\r?\n/)) {
    if (TRIAGE_ERROR_LINE.test(line)) errorLines++;
  }
  if (errorLines >= TRIAGE_MIN_ERROR_LINES) return true;
  // A named Unity log file. "Where is the Editor.log?" is a
  // location question, not a diagnosis — it does not trigger.
  if (/\b(editor|player|editor-prev)\.log\b/i.test(t)) {
    if (/where\s+(is|are|can\s+i\s+find)\b/i.test(lower)) return false;
    return true;
  }
  // A crash log, or a log file the user points at ("here is the
  // log file", "I attached the log file") — but not one they ask
  // to create ("create a log file" is a build request, not triage).
  if (/\bcrash\s+log\b/i.test(t)) return true;
  if (/(attach|paste|here is|here'?s|see|check|look at|read)[^.\n]{0,30}\blog\s+file\b/i.test(t)) return true;
  // Asking why there are many errors (plural — a single error is
  // a normal fix turn, not triage).
  if (/many errors|so many errors|lots of errors|tons of errors|full of errors|flooded with|spammed with|errors everywhere|all these errors|all the errors|a bunch of errors/i.test(lower)) return true;
  if (/why\b[^.\n]{0,80}\b(so many|lots of|all these|many)\s+errors?\b/i.test(lower)) return true;
  if (/why\b[^.\n]{0,60}\berrors\b/i.test(lower)) return true;
  // Explicitly asking for a log to be diagnosed or read.
  if (/diagnose\s+(the\s+|this\s+|my\s+|these\s+)?logs?\b/i.test(lower)) return true;
  if (/\btriage\b/i.test(lower)) return true;
  if (/read\s+(the\s+|my\s+)?(unity\s+)?(console|editor\.?log|player\.?log)\b/i.test(lower)) return true;
  if (/what('| i)s\s+(wrong|causing|in)\b[^.\n]{0,20}\b(log|console)\b/i.test(lower)) return true;
  return false;
}

module.exports = { isLogTriageRequest, TRIAGE_MIN_ERROR_LINES };
