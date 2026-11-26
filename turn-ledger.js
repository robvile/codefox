// turn-ledger.js — the per-turn ledger (v0.20.0).
//
// Plain JavaScript, no dependencies, no Node-only APIs: it runs in
// two places — the Electron renderer (classic <script>, where it is
// window.TurnLedger) and the smoke test (require). It must never
// touch the filesystem, the bridge, or the LLM; the caller owns all
// of that and hands this module plain data.
//
// What it is: one ledger per agent turn, recording what the turn
// changed so the user can undo the whole turn as a unit from the
// sidebar ("Undo agent turn"). The turn's scene writes share one
// undo group in Unity (the bridge owns the group — the app only
// records that the turn wrote the scene, and asks the bridge
// whether that group is still the current one when reverting).
// Prefab edits are file transactions: the bridge snapshots the
// prefab before the edit and returns the snapshot path plus the
// post-edit hash, and the app records what the bridge returned —
// it never invents a snapshot path of its own. Created assets are
// deleted on revert; file deletes (deleteAsset) are restored from
// their file snapshots.
//
// The ledger is only ever the LAST turn: a new agent turn clears
// it, because the undo stack has moved on by then and an older
// turn cannot be reverted as a unit any more.
(function () {
  var TurnLedger = {};

  // Snapshots live under this folder inside the project, written
  // by the bridge. A snapshot path the bridge returns must match
  // this shape exactly — anything else is refused, never copied.
  TurnLedger.SNAPSHOT_DIR = '.bridge/snapshots';

  function createTurnLedger(turnId) {
    return {
      turnId: turnId || '',
      // Prefab snapshots: {asset, snapshot, hash, kind} — the
      // snapshot is the relative path the bridge returned, the
      // hash is the post-edit file hash (the staleness guard a
      // later restore checks the current file against).
      snapshots: [],
      // Assets the turn created (createPrefab, create_material)
      // — deleted on revert, with their .meta files.
      createdAssets: [],
      // File snapshots (snapshot ids from the file-backup system)
      // for assets the turn deleted — restored by confirmRevert.
      deleteSnapshots: [],
      // Prefab edits, for display: {asset, summary}. One entry
      // per prefab asset; a later edit to the same prefab updates
      // the summary instead of adding a second line.
      prefabEdits: [],
      // True when the turn wrote the scene (not prefab-scoped) —
      // the revert asks the bridge about the turn's undo group.
      sceneWrites: false,
    };
  }
  TurnLedger.createTurnLedger = createTurnLedger;

  function isSnapshotRelPath(rel) {
    if (typeof rel !== 'string' || !rel) return false;
    var n = rel.replace(/\\/g, '/');
    if (n.indexOf(TurnLedger.SNAPSHOT_DIR + '/') !== 0) return false;
    if (n.indexOf('..') !== -1) return false;
    if (n.charAt(0) === '/') return false;
    return true;
  }
  TurnLedger.isSnapshotRelPath = isSnapshotRelPath;

  function addSnapshotToLedger(ledger, entry) {
    if (!ledger || !entry || !entry.snapshot) return ledger;
    if (!isSnapshotRelPath(entry.snapshot)) return ledger;
    var exists = ledger.snapshots.some(function (s) { return s.snapshot === entry.snapshot; });
    if (exists) return ledger;
    ledger.snapshots.push({
      asset: entry.asset || '?',
      snapshot: entry.snapshot,
      hash: entry.hash || null,
      kind: entry.kind || '',
    });
    return ledger;
  }
  TurnLedger.addSnapshotToLedger = addSnapshotToLedger;

  function addCreatedAssetToLedger(ledger, assetPath) {
    if (!ledger || !assetPath) return ledger;
    if (ledger.createdAssets.indexOf(assetPath) === -1) ledger.createdAssets.push(assetPath);
    return ledger;
  }
  TurnLedger.addCreatedAssetToLedger = addCreatedAssetToLedger;

  function addDeleteSnapshotToLedger(ledger, snapshotId) {
    if (!ledger || !snapshotId) return ledger;
    if (ledger.deleteSnapshots.indexOf(snapshotId) === -1) ledger.deleteSnapshots.push(snapshotId);
    return ledger;
  }
  TurnLedger.addDeleteSnapshotToLedger = addDeleteSnapshotToLedger;

  function addPrefabEditToLedger(ledger, asset, summary) {
    if (!ledger || !asset) return ledger;
    var found = null;
    for (var i = 0; i < ledger.prefabEdits.length; i++) {
      if (ledger.prefabEdits[i].asset === asset) { found = ledger.prefabEdits[i]; break; }
    }
    if (found) { if (summary) found.summary = summary; return ledger; }
    ledger.prefabEdits.push({ asset: asset, summary: summary || '' });
    return ledger;
  }
  TurnLedger.addPrefabEditToLedger = addPrefabEditToLedger;

  function noteSceneWrites(ledger) {
    if (!ledger) return ledger;
    ledger.sceneWrites = true;
    return ledger;
  }
  TurnLedger.noteSceneWrites = noteSceneWrites;

  function ledgerHasWork(ledger) {
    if (!ledger) return false;
    return ledger.snapshots.length > 0
      || ledger.createdAssets.length > 0
      || ledger.deleteSnapshots.length > 0
      || ledger.prefabEdits.length > 0
      || ledger.sceneWrites === true;
  }
  TurnLedger.ledgerHasWork = ledgerHasWork;

  // Display lines for the sidebar section, most specific first.
  function ledgerSummaryLines(ledger) {
    var lines = [];
    if (!ledger) return lines;
    for (var i = 0; i < ledger.prefabEdits.length; i++) {
      var e = ledger.prefabEdits[i];
      lines.push('Prefab ' + e.asset + (e.summary ? ' — ' + e.summary : ''));
    }
    if (ledger.createdAssets.length) {
      lines.push(ledger.createdAssets.length + ' created asset' + (ledger.createdAssets.length !== 1 ? 's' : '') + ': ' + ledger.createdAssets.join(', '));
    }
    if (ledger.deleteSnapshots.length) {
      lines.push(ledger.deleteSnapshots.length + ' deleted asset snapshot' + (ledger.deleteSnapshots.length !== 1 ? 's' : ''));
    }
    if (ledger.sceneWrites) lines.push('Scene changes (one Ctrl+Z in Unity)');
    return lines;
  }
  TurnLedger.ledgerSummaryLines = ledgerSummaryLines;

  // The one-line description for the turn-revert approval bar:
  // exactly what the revert would do, so the user approves the
  // real plan, not a vague "undo". scenePlan is the bridge's
  // revert_turn dry-run result (or null when the turn wrote no
  // scene changes and the bridge was never asked).
  function describeLedgerForRevert(ledger, scenePlan) {
    var parts = [];
    if (!ledger) return 'Undo the last agent turn? Nothing to undo.';
    for (var i = 0; i < ledger.snapshots.length; i++) parts.push('restore ' + ledger.snapshots[i].asset);
    for (var j = 0; j < ledger.createdAssets.length; j++) parts.push('delete ' + ledger.createdAssets[j]);
    for (var k = 0; k < ledger.deleteSnapshots.length; k++) parts.push('restore deleted file(s) from snapshot');
    if (scenePlan) {
      if (scenePlan.canRevert) parts.push('undo the scene changes as one step');
      else parts.push('scene changes: cannot undo as one step (' + (scenePlan.reason || 'the undo stack moved on') + ')');
    } else if (ledger.sceneWrites) {
      parts.push('scene changes: Unity did not answer');
    }
    if (!parts.length) return 'Undo the last agent turn? Nothing to undo.';
    return 'Undo the last agent turn? ' + parts.join('; ') + '.';
  }
  TurnLedger.describeLedgerForRevert = describeLedgerForRevert;

  if (typeof module !== 'undefined' && module.exports) module.exports = TurnLedger;
  if (typeof window !== 'undefined') window.TurnLedger = TurnLedger;
})();
