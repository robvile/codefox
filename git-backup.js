// git-backup.js — automatic git backups + self-restore (v0.10.0).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// this file directly with `node`. main.js requires it for the git:*
// IPCs. The renderer never shells out to git itself — everything
// goes through those IPCs.
//
// The engine is the git CLI on the user's machine (Rob: git
// 2.56.0.windows.4 on PATH). There is no bundled git and no
// fallback: if git is not found, every call says so plainly
// (reason 'git-not-found') instead of silently doing nothing.
// All commands run as `git -C <projectPath> ...`, non-interactive,
// with timeouts — and NEVER touch remotes (no fetch/pull/push:
// backups are local commits in the project's own .git folder, so
// they show up in whatever git program the user already runs,
// e.g. GitKraken, exactly like any other commit).
//
// A backup commit only ever contains TRACKED changes (`git add -u`):
// untracked files are left alone, so a Unity project without a
// .gitignore can never have its Library/ swept into a backup
// commit. CodeFox's own transient bridge files are excluded by
// pathspec as well. When the tree is clean, no empty commit is
// made — HEAD itself is the restore point.
//
// Restore never destroys anything the caller did not name: tracked
// files are checked out from the backup commit, files the change
// created are deleted by explicit path. No `git clean`, no
// `reset --hard`, ever.

const fs = require('fs');
const path = require('path');

const STATUS_TIMEOUT_MS = 30000;
const COMMIT_TIMEOUT_MS = 60000;
const DIFF_MAX_BYTES = 200 * 1024;
const BACKUP_PREFIX = 'CodeFox backup: before ';

// Transient bridge files — never part of a backup commit.
const TRANSIENT_EXCLUDES = [
  ':!Assets/.codefox-command.json',
  ':!Assets/.codefox-result.json',
  ':!Assets/.codefox-refresh-trigger',
];

// A path inside a repo, or an escape attempt? `..`, absolute
// paths, and anything outside the project folder are refused.
function isPathInsideRepo(projectPath, relPath) {
  const p = String(relPath || '');
  if (!p || path.isAbsolute(p)) return false;
  const root = path.resolve(projectPath);
  const full = path.resolve(root, p);
  return full === root || full.startsWith(root + path.sep);
}

// --- Pure parsers (unit-tested directly) --------------------------

// Parse `git status --porcelain=v1 -uall` into staged / modified /
// untracked / deleted / renamed lists. XY codes: first char is the
// staged state, second the working-tree state. Renames come as
// "old -> new" after the status columns.
function parsePorcelainStatus(text) {
  const out = { staged: [], modified: [], untracked: [], deleted: [], renamed: [] };
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    let p = line.slice(3);
    // Porcelain quotes paths containing special characters.
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (x === '?' && y === '?') { out.untracked.push(p); continue; }
    if (x === 'R' || y === 'R') {
      const arrow = p.indexOf(' -> ');
      const oldPath = arrow >= 0 ? p.slice(0, arrow) : p;
      const newPath = arrow >= 0 ? p.slice(arrow + 4) : p;
      out.renamed.push({ from: oldPath, to: newPath });
      continue;
    }
    if (x === 'D' || y === 'D') out.deleted.push(p);
    else if (x !== ' ' && x !== '?') out.staged.push(p);
    if (y === 'M' || y === 'A' || y === 'T') out.modified.push(p);
    else if (y === 'D') { /* already in deleted */ }
    else if (x === 'A') out.staged.push(p);
  }
  // De-duplicate (a file can be both staged and modified).
  for (const k of ['staged', 'modified', 'untracked', 'deleted']) {
    out[k] = [...new Set(out[k])];
  }
  return out;
}

// Parse `git log --format=%H%x1f%h%x1f%an%x1f%ad%x1f%s`.
function parseLogOutput(text) {
  const commits = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\x1f');
    if (parts.length < 5) continue;
    const [sha, short, author, date, ...msgParts] = parts;
    const message = msgParts.join('\x1f');
    commits.push({
      sha, short, author, date, message,
      isBackup: message.startsWith('CodeFox backup:'),
    });
  }
  return commits;
}

// Parse `git diff --name-status <ref>` into modified / deleted /
// added lists (paths are relative to the repo root).
function parseNameStatus(text) {
  const out = { modified: [], deleted: [], added: [] };
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const code = line.slice(0, tab).trim();
    let p = line.slice(tab + 1);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (code === 'M' || code === 'T') out.modified.push(p);
    else if (code === 'D') out.deleted.push(p);
    else if (code === 'A') out.added.push(p);
    else if (code.startsWith('R')) {
      // R100\told\tnew — the new path is the one that exists now.
      const parts = p.split('\t');
      out.modified.push(parts[parts.length - 1]);
    }
  }
  return out;
}

function truncateDiff(text) {
  const s = String(text || '');
  if (s.length <= DIFF_MAX_BYTES) return { diff: s, truncated: false };
  return {
    diff: s.slice(0, DIFF_MAX_BYTES) + '\n... (diff truncated at 200KB — use "git diff" with a path to see one file)',
    truncated: true,
  };
}

function backupCommitMessage(summary) {
  const clean = String(summary || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'assistant change';
  return BACKUP_PREFIX + clean;
}

function isRepo(projectPath, f) {
  if (!projectPath) return false;
  try {
    const dotGit = path.join(projectPath, '.git');
    return f.existsSync(dotGit);
  } catch { return false; }
}

function mergeInProgress(projectPath, f) {
  try {
    const dotGit = path.join(projectPath, '.git');
    return f.existsSync(path.join(dotGit, 'MERGE_HEAD'))
      || f.existsSync(path.join(dotGit, 'rebase-merge'))
      || f.existsSync(path.join(dotGit, 'rebase-apply'));
  } catch { return false; }
}

// --- Engine --------------------------------------------------------

// deps: { run, where, fs, path, getGitExePath }.
// - run(cmd, args, opts, timeoutMs) -> Promise<{code, stdout, stderr, timedOut}>
//   (main.js passes its runProcess; tests pass a stub).
// - where(cmd) -> Promise<{found, path}> (main.js passes runWhere).
// - getGitExePath() -> the stored git_exe_path setting, or ''.
function createEngine(deps) {
  const run = deps.run;
  const where = deps.where;
  const f = deps.fs || fs;
  const p = deps.path || path;
  const getGitExePath = deps.getGitExePath || (() => '');

  let cachedGit = null; // { found, path } — git does not move mid-run.

  async function findGit() {
    if (cachedGit) return cachedGit;
    const onPath = await where('git');
    if (onPath && onPath.found) {
      cachedGit = { found: true, path: onPath.path };
      return cachedGit;
    }
    // Windows fallbacks (Git for Windows default install spots).
    for (const candidate of [
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    ]) {
      try {
        if (f.existsSync(candidate)) {
          cachedGit = { found: true, path: candidate };
          return cachedGit;
        }
      } catch {}
    }
    const override = String(getGitExePath() || '').trim();
    if (override) {
      try {
        if (f.existsSync(override)) {
          cachedGit = { found: true, path: override };
          return cachedGit;
        }
      } catch {}
      cachedGit = { found: false, path: null, overrideInvalid: true };
      return cachedGit;
    }
    cachedGit = { found: false, path: null };
    return cachedGit;
  }

  async function runGit(projectPath, args, timeoutMs) {
    const git = await findGit();
    if (!git.found) return { code: -1, stdout: '', stderr: '', timedOut: false, gitNotFound: true };
    const r = await run(git.path, ['-C', projectPath, ...args], { windowsHide: true }, timeoutMs || STATUS_TIMEOUT_MS);
    return r;
  }

  async function headSha(projectPath) {
    const r = await runGit(projectPath, ['rev-parse', 'HEAD'], STATUS_TIMEOUT_MS);
    if (r.code !== 0) return null; // unborn HEAD (no commits yet)
    return String(r.stdout || '').trim() || null;
  }

  async function branchName(projectPath) {
    // symbolic-ref, not rev-parse --abbrev-ref: on a repo with no
    // commits yet, rev-parse answers "HEAD", symbolic-ref answers
    // the real branch name ("main").
    const r = await runGit(projectPath, ['symbolic-ref', '--short', 'HEAD'], STATUS_TIMEOUT_MS);
    if (r.code !== 0) return null;
    return String(r.stdout || '').trim() || null;
  }

  async function status(projectPath) {
    if (!isRepo(projectPath, f)) return { ok: false, reason: 'not-a-repo', error: 'Not a git repository — no .git folder in this project.' };
    const git = await findGit();
    if (!git.found) return { ok: false, reason: 'git-not-found', error: 'Git is not installed or not on PATH. Install Git for Windows, or set the git exe path in Settings → Advanced.' };
    const r = await runGit(projectPath, ['status', '--porcelain=v1', '-uall'], STATUS_TIMEOUT_MS);
    if (r.code !== 0) return { ok: false, reason: 'git-error', error: 'git status failed: ' + String((r.stderr || r.stdout || '').trim()).slice(0, 300) };
    const parsed = parsePorcelainStatus(r.stdout);
    const head = await headSha(projectPath);
    const branch = await branchName(projectPath);
    const clean = !parsed.staged.length && !parsed.modified.length
      && !parsed.untracked.length && !parsed.deleted.length && !parsed.renamed.length;
    return {
      ok: true, isRepo: true, branch, head, clean,
      mergeInProgress: mergeInProgress(projectPath, f),
      ...parsed,
    };
  }

  async function diff(projectPath, opts) {
    const o = opts || {};
    if (!isRepo(projectPath, f)) return { ok: false, reason: 'not-a-repo', error: 'Not a git repository.' };
    const args = o.nameStatus ? ['diff', '--name-status'] : ['diff'];
    if (o.ref) args.push(o.ref);
    args.push('--');
    for (const pth of (o.paths || [])) args.push(pth);
    const r = await runGit(projectPath, args, STATUS_TIMEOUT_MS);
    if (r.code !== 0) return { ok: false, reason: 'git-error', error: 'git diff failed: ' + String((r.stderr || r.stdout || '').trim()).slice(0, 300) };
    if (o.nameStatus) return { ok: true, ref: o.ref || null, ...parseNameStatus(r.stdout) };
    const t = truncateDiff(r.stdout);
    return { ok: true, ref: o.ref || null, diff: t.diff, truncated: t.truncated };
  }

  async function log(projectPath, count) {
    const n = Math.max(1, Math.min(50, parseInt(count, 10) || 10));
    if (!isRepo(projectPath, f)) return { ok: false, reason: 'not-a-repo', error: 'Not a git repository.' };
    const r = await runGit(projectPath, ['log', '-n', String(n), '--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s', '--date=short'], STATUS_TIMEOUT_MS);
    if (r.code !== 0) return { ok: false, reason: 'git-error', error: 'git log failed: ' + String((r.stderr || r.stdout || '').trim()).slice(0, 300) };
    return { ok: true, commits: parseLogOutput(r.stdout) };
  }

  // The core: one backup commit before CodeFox changes anything.
  // Returns { ok:true, committed, sha, head, message, filesChanged }
  // or { ok:false, reason, error } — a failed/skipped backup never
  // throws, and the caller (the agent loop) carries on with the
  // snapshot system instead of blocking the user's work.
  async function backup(projectPath, summary) {
    if (!isRepo(projectPath, f)) return { ok: false, reason: 'not-a-repo', error: 'Not a git repository — no backup commit made.' };
    const git = await findGit();
    if (!git.found) return { ok: false, reason: 'git-not-found', error: 'Git is not installed or not on PATH — no backup commit made.' };
    if (mergeInProgress(projectPath, f)) return { ok: false, reason: 'merge-in-progress', error: 'A merge or rebase is in progress — CodeFox will not commit over it. Finish or abort it first.' };
    const st = await status(projectPath);
    if (!st.ok) return st;
    const head = st.head;
    if (st.clean && head) {
      return { ok: true, committed: false, sha: head, head, message: 'Working tree clean — no commit needed. Restore point is HEAD ' + head.slice(0, 7) + '.' };
    }
    // Stage tracked changes only (never untracked files), minus
    // CodeFox's own transient bridge files.
    const add = await runGit(projectPath, ['add', '-u', '--', ...TRANSIENT_EXCLUDES], COMMIT_TIMEOUT_MS);
    if (add.code !== 0) return { ok: false, reason: 'git-error', error: 'git add failed: ' + String((add.stderr || add.stdout || '').trim()).slice(0, 300) };
    // Nothing staged (e.g. only untracked changes)? Then there is
    // nothing to commit — HEAD is still the restore point.
    const staged = await runGit(projectPath, ['diff', '--cached', '--quiet'], STATUS_TIMEOUT_MS);
    if (staged.code === 0) {
      return { ok: true, committed: false, sha: head, head, message: 'Nothing tracked to commit — restore point is HEAD ' + (head ? head.slice(0, 7) : '(no commits yet)') + '.' };
    }
    // Author: the repo's own git config when set, else CodeFox.
    const nameR = await runGit(projectPath, ['config', 'user.name'], STATUS_TIMEOUT_MS);
    const emailR = await runGit(projectPath, ['config', 'user.email'], STATUS_TIMEOUT_MS);
    const authorName = String(nameR.stdout || '').trim();
    const authorEmail = String(emailR.stdout || '').trim();
    const commitArgs = [];
    if (!authorName) commitArgs.push('-c', 'user.name=CodeFox');
    if (!authorEmail) commitArgs.push('-c', 'user.email=codefox@local');
    commitArgs.push('commit', '-m', backupCommitMessage(summary));
    const c = await runGit(projectPath, commitArgs, COMMIT_TIMEOUT_MS);
    if (c.code !== 0) return { ok: false, reason: 'git-error', error: 'git commit failed: ' + String((c.stderr || c.stdout || '').trim()).slice(0, 300) };
    const sha = await headSha(projectPath);
    const filesChanged = st.staged.length + st.modified.length + st.deleted.length + st.renamed.length;
    return { ok: true, committed: true, sha, head: sha, message: 'Backup committed: ' + (sha || '').slice(0, 7) + ' — ' + backupCommitMessage(summary), filesChanged };
  }

  // Restore tracked files to a backup commit, and delete files the
  // change created (they were never in the commit, so checkout
  // cannot remove them). `filesToCheckout` / `filesToDelete` may be
  // given explicitly; without them the lists are derived from
  // `git diff --name-status <ref>` (modified/deleted → checkout,
  // added → delete). With dryRun:true nothing is executed — the
  // plan is returned for the approval bar. Paths escaping the repo
  // are refused, never executed.
  async function restore(projectPath, ref, opts) {
    const o = opts || {};
    if (!isRepo(projectPath, f)) return { ok: false, reason: 'not-a-repo', error: 'Not a git repository.' };
    const git = await findGit();
    if (!git.found) return { ok: false, reason: 'git-not-found', error: 'Git is not installed or not on PATH.' };
    const r = String(ref || '').trim();
    if (!r) return { ok: false, reason: 'bad-ref', error: 'No backup commit given to restore.' };
    const verify = await runGit(projectPath, ['rev-parse', '--verify', r + '^{commit}'], STATUS_TIMEOUT_MS);
    if (verify.code !== 0) return { ok: false, reason: 'bad-ref', error: 'Not a commit in this repo: ' + r };
    const sha = String(verify.stdout || '').trim();

    let checkout = o.filesToCheckout || null;
    let toDelete = o.filesToDelete || null;
    if (!checkout || !toDelete) {
      const d = await diff(projectPath, { ref: r, nameStatus: true });
      if (!d.ok) return d;
      if (!checkout) checkout = [...d.modified, ...d.deleted];
      if (!toDelete) toDelete = [...d.added];
    }
    for (const pth of [...checkout, ...toDelete]) {
      if (!isPathInsideRepo(projectPath, pth)) {
        return { ok: false, reason: 'bad-path', error: 'Refusing to restore a path outside the project: ' + pth };
      }
    }
    if (o.dryRun) {
      return { ok: true, dryRun: true, ref: r, sha, checkout: checkout.slice(), delete: toDelete.slice() };
    }
    const checkedOut = [];
    const deleted = [];
    if (checkout.length) {
      const co = await runGit(projectPath, ['checkout', sha, '--', ...checkout], COMMIT_TIMEOUT_MS);
      if (co.code !== 0) return { ok: false, reason: 'git-error', error: 'git checkout failed: ' + String((co.stderr || co.stdout || '').trim()).slice(0, 300) };
      checkedOut.push(...checkout);
    }
    for (const pth of toDelete) {
      const full = p.join(projectPath, pth);
      try {
        if (f.existsSync(full)) {
          f.unlinkSync(full);
          deleted.push(pth);
          // A Unity asset's .meta goes with it, so Unity does not
          // keep a stale import for a file that no longer exists.
          try { if (f.existsSync(full + '.meta')) f.unlinkSync(full + '.meta'); } catch {}
        }
      } catch (e) {
        return { ok: false, reason: 'fs-error', error: 'Could not delete ' + pth + ': ' + e.message, checkedOut, deleted };
      }
    }
    return { ok: true, ref: r, sha, checkedOut, deleted, leftInPlace: [] };
  }

  async function repoInfo(projectPath) {
    if (!projectPath || !isRepo(projectPath, f)) {
      const git = await findGit();
      return { ok: true, isRepo: false, gitFound: git.found, gitPath: git.path || null, branch: null, head: null, lastBackup: null };
    }
    const git = await findGit();
    const st = await status(projectPath);
    let lastBackup = null;
    if (st.ok) {
      const l = await log(projectPath, 20);
      if (l.ok) lastBackup = l.commits.find(c => c.isBackup) || null;
    }
    return {
      ok: true, isRepo: true, gitFound: git.found, gitPath: git.path || null,
      branch: st.ok ? st.branch : null, head: st.ok ? st.head : null,
      clean: st.ok ? st.clean : null, mergeInProgress: st.ok ? st.mergeInProgress : null,
      lastBackup,
    };
  }

  return {
    findGit, status, diff, log, backup, restore, repoInfo,
    isRepo: (pp) => isRepo(pp, f),
    mergeInProgress: (pp) => mergeInProgress(pp, f),
  };
}

module.exports = {
  createEngine,
  parsePorcelainStatus,
  parseLogOutput,
  parseNameStatus,
  truncateDiff,
  backupCommitMessage,
  isPathInsideRepo,
  BACKUP_PREFIX,
  TRANSIENT_EXCLUDES,
  DIFF_MAX_BYTES,
};
