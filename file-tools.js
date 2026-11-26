// file-tools.js — read / search / surgically edit project files (v0.11.0).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// this file directly with `node` (like git-backup.js and
// upm-manifest.js). main.js requires it for the file:view /
// file:grep IPCs.
//
// The model reads with `view` and `grep` and edits with
// `str_replace` — it never rewrites a whole file to change a few
// lines, and it never edits blind. The text operation
// applyStrReplaceText is mirrored inline in app.js (the renderer
// cannot require this file — the same reason unity-assets.js has
// an inline mirror); the smoke test pins the two copies to agree.
//
// Grep is a plain-text substring search, case-insensitive — NOT a
// regex. A small model is sloppy about case, and a missed match is
// a worse failure than an extra one.

const fs = require('fs');
const path = require('path');

const VIEW_MAX_LINES = 200;
const VIEW_MAX_BYTES = 32 * 1024;
const GREP_MAX_MATCHES = 50;
const GREP_MAX_FILE_BYTES = 1024 * 1024;

// Directories never searched or viewed, same list as the project
// scan (SCAN_IGNORE in main.js) — Library, .git, node_modules and
// the rest are not the model's business.
const FILE_TOOL_IGNORE = new Set(['.git', 'Library', 'Temp', 'obj', 'bin', 'node_modules', '.vs', 'Logs', '.idea', 'dist']);

// Extensions that are never text, however they are reached.
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tga', '.psd', '.dll', '.exe', '.so', '.dylib', '.zip', '.gz', '.mp3', '.wav', '.ogg', '.mp4', '.fbx', '.ttf', '.otf', '.woff', '.woff2', '.ico']);

// A project-relative path resolved to an absolute path inside the
// project, or null when it escapes. Absolute paths, drive letters,
// UNC paths and `..` segments are all refused — a ```file block
// can only ever touch the project folder.
function resolveInProject(projectPath, relPath) {
  const raw = String(relPath || '').trim();
  if (!raw) return null;
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) return null;
  if (raw.indexOf('\0') !== -1) return null;
  const parts = raw.split(/[\\/]+/).filter(s => s.length > 0);
  if (parts.some(s => s === '..')) return null;
  const root = path.resolve(projectPath || '');
  const full = path.resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

// Split file content into lines. A trailing newline does not make
// an extra empty line: "a\nb\n" is two lines, not three.
function splitLines(content) {
  const lines = String(content || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Pure: slice a file's lines into a numbered range.
// start/end are 1-based inclusive; end defaults to start + 199.
// At most VIEW_MAX_LINES lines and VIEW_MAX_BYTES of text come
// back — the rest sets truncated, so the model knows it did not
// see the whole range.
function viewFileText(content, start, end) {
  const lines = splitLines(content);
  const totalLines = lines.length;
  let s = Math.floor(Number(start) || 1);
  if (s < 1) s = 1;
  // An explicit end is a request for exactly that range — getting
  // it whole is not a truncation. No end means "the whole file",
  // so a file that runs past the returned lines IS truncated.
  const explicitEnd = Math.floor(Number(end) || 0);
  let e = explicitEnd || (s + VIEW_MAX_LINES - 1);
  if (e < s) e = s + VIEW_MAX_LINES - 1;
  e = Math.min(e, totalLines);
  const out = [];
  let bytes = 0;
  let truncated = false;
  for (let n = s; n <= e; n++) {
    const text = lines[n - 1];
    if (out.length >= VIEW_MAX_LINES || bytes + Buffer.byteLength(text, 'utf8') + 1 > VIEW_MAX_BYTES) { truncated = true; break; }
    out.push({ n, text });
    bytes += Buffer.byteLength(text, 'utf8') + 1;
  }
  if (!explicitEnd && e < totalLines) truncated = true;
  return { lines: out, totalLines, truncated };
}

// Pure: count non-overlapping occurrences of needle in haystack.
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let at = 0;
  for (;;) {
    const i = haystack.indexOf(needle, at);
    if (i === -1) return count;
    count++;
    at = i + needle.length;
  }
}

// Map a position in CRLF-normalized text back to the original
// offsets, so a match found after normalizing still replaces the
// exact span in the original file (whose own line endings then
// survive everywhere else).
function mapNormToOrig(src, normPos) {
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    if (n === normPos) return i;
    if (src[i] === '\r' && src[i + 1] === '\n') { i++; n++; }
    else n++;
  }
  return src.length;
}

// Pure: replace ONE exact chunk. Returns { ok, content } or
// { ok: false, error } with a message that says what to do next.
// The old text must match EXACTLY ONCE: 0 matches and 2+ matches
// are both plain failures, never a guess.
//
// Windows files often use CRLF while the model writes LF: when an
// exact match fails, the search retries with line endings
// normalized, and the replacement is mapped back to the original
// offsets. A replacement inserted into a CRLF file gets CRLF line
// endings, so the file does not come back with mixed endings.
function applyStrReplaceText(content, oldText, newText) {
  const src = String(content == null ? '' : content);
  const oldS = String(oldText == null ? '' : oldText);
  const newS = String(newText == null ? '' : newText);
  if (!oldS) return { ok: false, error: 'The "old" text is empty — view the file and copy the exact lines to replace.' };
  // Keep the file's own line endings in the replacement.
  const newAdj = src.includes('\r\n') ? newS.replace(/(?<!\r)\n/g, '\r\n') : newS;
  const rawCount = countOccurrences(src, oldS);
  if (rawCount === 1) {
    const at = src.indexOf(oldS);
    return { ok: true, content: src.slice(0, at) + newAdj + src.slice(at + oldS.length) };
  }
  if (rawCount > 1) return { ok: false, error: 'The old text matched ' + rawCount + ' times — include more surrounding context to make it unique.' };
  const normSrc = src.replace(/\r\n/g, '\n');
  const normOld = oldS.replace(/\r\n/g, '\n');
  const normCount = countOccurrences(normSrc, normOld);
  if (normCount === 0) return { ok: false, error: 'The old text was not found in the file — view the file and check the exact text (including indentation).' };
  if (normCount > 1) return { ok: false, error: 'The old text matched ' + normCount + ' times — include more surrounding context to make it unique.' };
  const normAt = normSrc.indexOf(normOld);
  const start = mapNormToOrig(src, normAt);
  const end = mapNormToOrig(src, normAt + normOld.length);
  return { ok: true, content: src.slice(0, start) + newAdj + src.slice(end) };
}

// Plain-text substring match, case-insensitive. Not a regex.
function matchGrepLine(line, pattern) {
  return String(line || '').toLowerCase().includes(String(pattern || '').toLowerCase());
}

function isBinaryBuffer(buf) {
  if (!buf || !buf.length) return false;
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// The engine main.js wires to the IPCs. `deps` is { fs, path }
// so the smoke test can pass the real ones (or stubs).
function createFileEngine(deps) {
  const f = (deps && deps.fs) || fs;
  const p = (deps && deps.path) || path;

  function readTextFile(fullPath) {
    let buf;
    try { buf = f.readFileSync(fullPath); } catch (e) { return { ok: false, error: e.message }; }
    if (BINARY_EXTS.has(p.extname(fullPath).toLowerCase())) return { ok: false, error: 'binary file' };
    if (isBinaryBuffer(buf)) return { ok: false, error: 'binary file' };
    return { ok: true, content: buf.toString('utf8') };
  }

  // Read a file in line ranges, with line numbers.
  function view(opts) {
    const o = opts || {};
    const projectPath = o.projectPath || '';
    const relPath = String(o.path || o.relPath || '');
    const full = resolveInProject(projectPath, relPath);
    if (!full) return { ok: false, error: 'Path must be inside the project folder: ' + (relPath || '(empty)') };
    let stat = null;
    try { stat = f.statSync(full); } catch (e) { return { ok: false, error: 'File not found: ' + relPath }; }
    if (!stat || !stat.isFile()) return { ok: false, error: 'Not a file: ' + relPath };
    const read = readTextFile(full);
    if (!read.ok) return { ok: false, error: read.error + ': ' + relPath };
    const totalLines = splitLines(read.content).length;
    const start = Math.floor(Number(o.start) || 1);
    if (start < 1 || start > totalLines) return { ok: false, error: 'Start line ' + start + ' is outside the file (' + totalLines + ' lines): ' + relPath };
    const slice = viewFileText(read.content, o.start, o.end);
    return { ok: true, path: relPath.replace(/\\/g, '/'), start, end: slice.lines.length ? slice.lines[slice.lines.length - 1].n : start, totalLines, lines: slice.lines, truncated: slice.truncated };
  }

  // Search a plain-text substring across the project.
  function grep(opts) {
    const o = opts || {};
    const projectPath = o.projectPath || '';
    const pattern = String(o.pattern || '');
    if (!pattern) return { ok: false, error: 'grep needs a pattern.' };
    if (!projectPath || !f.existsSync(projectPath)) return { ok: false, error: 'No project folder set.' };
    // Optional restriction to relative dirs / files.
    let roots = null;
    if (Array.isArray(o.paths) && o.paths.length) {
      roots = [];
      for (const entry of o.paths) {
        const full = resolveInProject(projectPath, entry);
        if (full) roots.push(full);
      }
      if (!roots.length) return { ok: false, error: 'No searchable paths inside the project folder.' };
    } else if (typeof o.path === 'string' && o.path) {
      const full = resolveInProject(projectPath, o.path);
      if (!full) return { ok: false, error: 'Path must be inside the project folder: ' + o.path };
      roots = [full];
    }
    const matches = [];
    let filesSearched = 0;
    let truncated = false;
    const walk = (dir, depth) => {
      if (truncated || depth > 12) return;
      let items;
      try { items = f.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const item of items) {
        if (truncated) return;
        if (FILE_TOOL_IGNORE.has(item.name) || item.name.startsWith('.codefox')) continue;
        const full = p.join(dir, item.name);
        if (item.isDirectory()) { walk(full, depth + 1); continue; }
        if (!item.isFile()) continue;
        if (BINARY_EXTS.has(p.extname(item.name).toLowerCase())) continue;
        let stat = null;
        try { stat = f.statSync(full); } catch { continue; }
        if (!stat || stat.size > GREP_MAX_FILE_BYTES) continue;
        const read = readTextFile(full);
        if (!read.ok) continue;
        filesSearched++;
        const lines = splitLines(read.content);
        const rel = p.relative(projectPath, full).split(p.sep).join('/');
        for (let i = 0; i < lines.length; i++) {
          if (matchGrepLine(lines[i], pattern)) {
            matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 500) });
            if (matches.length >= GREP_MAX_MATCHES) { truncated = true; return; }
          }
        }
      }
    };
    if (!roots) {
      walk(projectPath, 0);
    } else {
      for (const root of roots) {
        let stat = null;
        try { stat = f.statSync(root); } catch { continue; }
        if (stat && stat.isFile()) {
          // A single file as the root: search it directly.
          if (BINARY_EXTS.has(p.extname(root).toLowerCase())) continue;
          if (stat.size > GREP_MAX_FILE_BYTES) continue;
          const read = readTextFile(root);
          if (!read.ok) continue;
          filesSearched++;
          const lines = splitLines(read.content);
          const rel = p.relative(projectPath, root).split(p.sep).join('/');
          for (let i = 0; i < lines.length; i++) {
            if (matchGrepLine(lines[i], pattern)) {
              matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 500) });
              if (matches.length >= GREP_MAX_MATCHES) { truncated = true; break; }
            }
          }
        } else {
          walk(root, 0);
        }
        if (truncated) break;
      }
    }
    return { ok: true, pattern, matches, truncated, filesSearched };
  }

  return { view, grep };
}

module.exports = {
  VIEW_MAX_LINES,
  VIEW_MAX_BYTES,
  GREP_MAX_MATCHES,
  GREP_MAX_FILE_BYTES,
  FILE_TOOL_IGNORE,
  BINARY_EXTS,
  resolveInProject,
  splitLines,
  viewFileText,
  countOccurrences,
  mapNormToOrig,
  applyStrReplaceText,
  matchGrepLine,
  createFileEngine,
};
