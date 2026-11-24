// upm-manifest.js — Unity Package Manager manifest helpers (v0.5.0).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// this file directly with `node`. main.js requires it for the
// unity:listPackages / unity:addPackage / unity:removePackage IPCs.
//
// Everything here edits <project>/Packages/manifest.json only —
// CodeFox does not talk to Unity's Package Manager API directly.
// Unity itself resolves the packages when it refreshes. Every write
// is backed up first to Packages/manifest.json.codefox-bak.

const fs = require('fs');
const path = require('path');

function manifestPath(projectPath) {
  return path.join(projectPath, 'Packages', 'manifest.json');
}

// A package name must look like a reverse-domain id: lowercase
// letters/digits with dots, dashes and underscores, and at least one
// dot (e.g. com.unity.textmeshpro). Anything else is refused rather
// than written into the manifest.
function isValidPackageName(name) {
  return typeof name === 'string'
    && /^[a-z0-9][a-z0-9._-]*$/i.test(name)
    && name.indexOf('.') !== -1;
}

// A git URL: https://...git (optionally #ref) or git@host:...git.
function isGitUrl(value) {
  return /^(https?:\/\/[^\s]+\.git(?:#[^\s]+)?|git@[^\s]+\.git(?:#[^\s]+)?)$/i
    .test(String(value || '').trim());
}

// A version is a semver (3.0.6), a git URL, a tarball URL / file path,
// or a file: URL. A bare word with no dots is not a version — the
// caller must ask the user for a real one instead of guessing.
function isValidPackageVersion(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(s)) return true;
  if (isGitUrl(s)) return true;
  if (/^(file:|https?:\/\/)/i.test(s)) return true;
  if (/\.tgz$|\.tar\.gz$/i.test(s)) return true;
  if (s.indexOf('/') !== -1 || s.indexOf('\\') !== -1) return true;
  return false;
}

// Parse one line from a ```upm-install block. Returns null for blank
// lines and comments. Accepted forms:
//   com.unity.textmeshpro@3.0.6   (name + version)
//   com.unity.textmeshpro         (name only — version is required
//                                  before install, never guessed)
//   https://github.com/user/repo.git#1.0.0   (git URL — the package
//                                  name still has to be supplied)
function parsePackageSpec(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('//') || raw.startsWith('#')) return null;
  if (isGitUrl(raw)) {
    return { name: '', version: raw, isGit: true, raw, valid: true };
  }
  const at = raw.indexOf('@');
  if (at > 0) {
    const name = raw.slice(0, at).trim();
    const version = raw.slice(at + 1).trim();
    return {
      name, version, isGit: false, raw,
      valid: isValidPackageName(name) && isValidPackageVersion(version),
    };
  }
  return {
    name: raw, version: '', isGit: false, raw,
    valid: isValidPackageName(raw),
  };
}

function readManifest(projectPath) {
  if (!projectPath) return { ok: false, error: 'No project folder set.' };
  const mPath = manifestPath(projectPath);
  if (!fs.existsSync(mPath)) {
    return { ok: false, error: 'Packages/manifest.json not found in this project.' };
  }
  let raw;
  try {
    raw = fs.readFileSync(mPath, 'utf8');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: 'Packages/manifest.json is not valid JSON: ' + e.message };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'Packages/manifest.json does not contain a JSON object.' };
  }
  return { ok: true, manifest, manifestPath: mPath };
}

// Read the manifest, back it up, apply `mutator(manifest)`, write it
// back with 2-space indent. The backup is written before the mutator
// runs, so a failed mutator still leaves the original on disk.
// Returns { ok, manifest, backup, manifestPath } or { ok:false, error }.
function updateManifest(projectPath, mutator) {
  const read = readManifest(projectPath);
  if (!read.ok) return read;
  const mPath = read.manifestPath;
  const backup = mPath + '.codefox-bak';
  let raw;
  try {
    raw = fs.readFileSync(mPath, 'utf8');
    fs.writeFileSync(backup, raw, 'utf8');
  } catch (e) {
    return { ok: false, error: 'Could not write manifest backup: ' + e.message };
  }
  if (!read.manifest.dependencies || typeof read.manifest.dependencies !== 'object') {
    read.manifest.dependencies = {};
  }
  let info = null;
  try {
    info = mutator(read.manifest) || null;
  } catch (e) {
    return { ok: false, error: e.message, backup };
  }
  try {
    fs.writeFileSync(mPath, JSON.stringify(read.manifest, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: e.message, backup };
  }
  return { ok: true, manifest: read.manifest, backup, manifestPath: mPath, info };
}

module.exports = {
  manifestPath,
  isValidPackageName,
  isGitUrl,
  isValidPackageVersion,
  parsePackageSpec,
  readManifest,
  updateManifest,
};
