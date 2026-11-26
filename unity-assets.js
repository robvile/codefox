// unity-assets.js — Unity-native asset files (v0.5.1).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// this file directly with `node`. The main process requires it and
// serves the list to preload over the 'app:staticData' sync channel
// (v0.6.4); preload exposes it as rb.unityAssets, so there is still
// one source of truth for which files count as Unity-native assets.
// The preload itself must NEVER require this file: real Electron
// refuses local requires in preload ("module not found"), which
// silently killed the whole bridge in v0.6.0 (see preload.js).
//
// A Unity-native asset file is a data file Unity itself owns — a
// prefab, scene, material, animation or similar. These contain no
// executable code, so creating a NEW one is low-risk: CodeFox can
// write it straight away after taking a snapshot, without asking
// for an Apply click. Code files (.cs, .shader, .js, .ts) and edits
// to files that already exist always ask first (unless auto-accept
// is on). See app.js `isAutoApplyAssetSet`.

const UNITY_ASSET_EXTS = [
  '.prefab', '.asset', '.unity', '.mat', '.anim',
  '.controller', '.overrideController',
  '.physicMaterial', '.physicsMaterial2D',
  '.guiskin', '.flare', '.cubemap', '.renderTexture',
  '.spriteatlas', '.preset', '.scenetemplate', '.lighting', '.mixer',
];

// Extension of a path (lowercase, including the dot), '' when none.
function extOf(p) {
  const s = String(p || '');
  const base = s.split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function isUnityAssetPath(p) {
  return UNITY_ASSET_EXTS.indexOf(extOf(p)) !== -1;
}

// True only when the whole change set qualifies for auto-apply:
// every file is a NEW Unity-native asset file. `changes` is an
// array of { path }; `resolvePath` turns a change path into a full
// filesystem path; `existsSync` reports whether that path already
// exists on disk. Any code file, any edit to an existing file, or
// any extension outside the list makes the whole set ineligible —
// auto-apply is all-or-nothing, never half a set.
function isAutoApplyAssetSet(changes, resolvePath, existsSync) {
  if (!Array.isArray(changes) || !changes.length) return false;
  for (const c of changes) {
    if (!c || !isUnityAssetPath(c.path)) return false;
    if (existsSync(resolvePath(c.path))) return false; // already exists — an edit, not a new file
  }
  return true;
}

// Revert one snapshot backup row on disk, with the same semantics
// as app.js confirmRevert: a row whose content is the new-file
// sentinel means the file did not exist before the apply, so
// revert DELETES it (and its .meta); otherwise the saved content
// is written back. Returns 'deleted', 'restored', or null when
// nothing could be done (e.g. the file was already gone).
// `fs` is Node's fs module, passed in so tests can use a real
// temp directory.
function revertBackupFile(backup, sentinel, fs) {
  if (!backup || !backup.file_path) return null;
  if (backup.content === sentinel) {
    try {
      if (!fs.existsSync(backup.file_path)) return null;
      fs.unlinkSync(backup.file_path);
      try { fs.unlinkSync(backup.file_path + '.meta'); } catch (e) { /* .meta is optional */ }
      return 'deleted';
    } catch (e) { return null; }
  }
  try {
    fs.mkdirSync(require('path').dirname(backup.file_path), { recursive: true });
    fs.writeFileSync(backup.file_path, backup.content, 'utf8');
    return 'restored';
  } catch (e) { return null; }
}

// Files Unity itself owns and CodeFox must never hand-write
// (v0.9.0): prefabs and scenes are created and changed through the
// Unity bridge (```unity-command blocks: createPrefab /
// modifyPrefab), never by writing YAML — hand-writing them is how
// the model invented a script guid, a YAML node literally named
// "Image:", and Button fields on an Image. app.js applyFileChanges
// refuses these files with handWrittenUnityRefusal below; the
// refusal is a failed entry in its summary, so the caller's tool
// result carries it back to the model — never a silent skip.
const HAND_WRITTEN_UNITY_EXTS = ['.prefab', '.unity'];

function isHandWrittenUnityFile(p) {
  return HAND_WRITTEN_UNITY_EXTS.indexOf(extOf(p)) !== -1;
}

// Split a change set into the files applyFileChanges may write and
// the ones it must refuse (Unity writes those itself through the
// bridge). Returns { allowed, refused }.
function partitionHandWrittenUnityFiles(changes) {
  const allowed = [];
  const refused = [];
  for (const c of (changes || [])) {
    if (c && isHandWrittenUnityFile(c.path)) refused.push(c);
    else allowed.push(c);
  }
  return { allowed, refused };
}

// The refusal text applyFileChanges returns for a refused file —
// it names the file and tells the model, in plain words, what to
// do instead.
function handWrittenUnityRefusal(filePath) {
  return filePath + ': CodeFox does not write .prefab or .unity files by hand — Unity writes those files itself. Use a ```unity-command block (createPrefab to create a prefab, modifyPrefab to change one) instead.';
}

module.exports = { UNITY_ASSET_EXTS, HAND_WRITTEN_UNITY_EXTS, extOf, isUnityAssetPath, isAutoApplyAssetSet, revertBackupFile, isHandWrittenUnityFile, partitionHandWrittenUnityFiles, handWrittenUnityRefusal };
