// CodeFoxBridge.cs
// CodeFoxBridge version: 0.16.1
// Place this file in: Assets/Editor/CodeFoxBridge.cs
//
// The CodeFox app talks to this bridge through files in
// <ProjectRoot>/.bridge/ — OUTSIDE Assets, so Unity never imports
// the protocol files (v0.12.0; earlier versions used
// Assets/.codefox-command.json and Assets/.codefox-result.json):
//   .bridge/inbox/      <id>.json — the app writes <id>.json.tmp
//                       then renames it, so the bridge never reads
//                       a half-written command. The bridge claims
//                       a request by moving it to processing/.
//   .bridge/processing/ <id>.json — a request the bridge has
//                       claimed and is working on. A file left
//                       here after a script reload is proof the
//                       command was interrupted.
//   .bridge/outbox/     <id>.json — the result: "pending" first
//                       while the bridge works, then the final
//                       result. The app deletes it after reading.
//   .bridge/heartbeat.json — written every poll tick: protocol,
//                       unix time, isCompiling, isPlaying. The app
//                       reads it before sending anything, so a
//                       stale heartbeat means Unity is not
//                       responding — not a 60-second timeout.
//   .bridge/refresh-trigger — the app touches this to ask Unity
//                       to refresh the AssetDatabase.
// Every message carries "protocol": 1. The app never sends an
// inbox command to a bridge older than 0.12.0 (it updates the
// bridge first) — an old bridge would never see the inbox at all.
//
// Command format (JSON):
//   { "protocol": 1, "action": "refresh" }
//   { "protocol": 1, "action": "recompile_and_report_errors" }
//   { "protocol": 1, "action": "readConsole", "sinceSeq": 0 }
//   { "action": "createAnimatorController", "name": "Player",
//     "parameters": [{ "name": "Speed", "type": "Float" }],
//     "states": [{ "name": "Idle", "motion": "Assets/Anims/Idle.anim", "speed": 1 }],
//     "transitions": [{ "from": "Idle", "to": "Run", "parameter": "Speed", "condition": "Greater" }] }
//   { "action": "createUICanvas", "name": "MainMenu",
//     "elements": [{ "type": "Text", "name": "Title", "text": "Hello", "rect": "0,100,400,60" },
//                  { "type": "Button", "name": "PlayButton", "text": "Play", "rect": "0,0,200,60" }] }
// rect is "x,y,width,height" in canvas space (anchored position + size).
//
// Prefabs (v0.9.0) — Unity writes prefab files itself; CodeFox never
// hand-writes .prefab YAML (that is how invented script guids and
// "Unknown type 'Image'" happened). The actions below build,
// change, and delete prefabs through Unity's own API, and can ask
// Unity what actually exists in this install before touching
// anything:
//   { "action": "createPrefab", "name": "ImageContainer", "path": "Assets/Prefabs/ImageContainer.prefab",
//     "root": { "name": "ImageContainer",
//       "components": [{ "type": "RectTransform", "props": { "sizeDelta": [100, 100] } },
//                      { "type": "Image", "props": { "color": [1, 1, 1, 1] } }],
//       "children": [{ "name": "Title", "components": [{ "type": "TextMeshProUGUI", "props": { "text": "Hello" } }] }] } }
//   { "action": "modifyPrefab", "path": "Assets/Prefabs/ImageContainer.prefab",
//     "remove": [{ "object": "", "components": ["Image"] }],
//     "addChildren": [{ "object": "", "children": [{ "name": "Viewport", "components": [{ "type": "RectTransform" }, { "type": "RectMask2D" }, { "type": "Image" }], "children": [{ "name": "Content", "components": [{ "type": "RectTransform" }] }] }] }],
//     "add": [{ "object": "", "components": [{ "type": "ScrollRect", "props": { "viewport": "Viewport", "content": "Viewport/Content" } }] }],
//     "set": [{ "object": "", "component": "Image", "props": { "color": [1, 0, 0, 1] } }] }
//     ("object" is a '/'-separated child path inside the prefab;
//     "" or "." means the root. Component references such as a
//     ScrollRect's viewport/content are child names, not guids.
//     Edits run in order — addChildren, then add, then remove,
//     then set — so an added ScrollRect can reference children the
//     same command created. "remove" takes "component" (one name)
//     or "components" (a list of names).)
//   { "action": "deleteAsset", "path": "Assets/Prefabs/ImageContainer.prefab" }
//     (deletes the asset and its .meta; the app snapshots it first,
//     so the delete can be reverted. The path must start with
//     Assets/ and must exist; Assets itself is never deletable.)
//   { "action": "listComponentTypes", "filter": "Scroll" }
//   { "action": "describeComponent", "type": "Image" }
// Console (v0.11.0, unified v0.12.0) — the bridge keeps its own
// log buffer, fed by Application.logMessageReceivedThreaded and
// seeded once at load from the existing console, so it can report
// errors that happened before it loaded. readConsole reads that
// buffer by sequence number, never by re-scanning the console, and
// reading never recompiles or reimports (reading must not destroy
// the evidence it reads):
//   { "action": "readConsole", "sinceSeq": 0 }          — everything since the cursor, earliest first
//   { "action": "readConsole", "mark": true }           — just the cursor, for marking a point in time
//   { "action": "readConsole", "sinceSeq": 123, "minLevel": 1, "playModeOnly": true, "maxEntries": 30 }
//   ("logType": "Error" / "Warning" from the old shape still works —
//   it maps to minLevel 2 / 1. "All" was never accepted.)
//   The result carries cursor, omitted, hiddenByFilter, errorCount,
//   warningCount and missedEvictedEntries, so the caller knows what
//   it did NOT see. Compile errors do NOT come through here — they
//   belong to recompile_and_report_errors.
// Compile (v0.12.0) — ask Unity itself to compile and report the
// errors, with file:line, instead of the app shelling out to
// dotnet (which needs a .sln and is not Unity's own compiler):
//   { "action": "recompile_and_report_errors" }
//   The result data is {"success":bool,"compiled":bool,"errors":
//   [{"file","line","message"}],"errorCount":n,"warningCount":n}.
//   Compile errors are status "ok" with success:false — the tool
//   worked, the errors are the data. Status "error" is reserved
//   for the bridge itself failing (for example a compile that
//   never finishes). "compiled":false means there was nothing to
//   compile. A successful compile reloads the domain; a compile
//   WITH errors does not — the handler survives both, because its
//   state lives in SessionState and a poll tick finalizes it either
//   way.
// Play testing (v0.13.0) — run the game and watch what it does,
// without a screen to look at. The model only sees what the game
// logs, so Debug.Log / LogError are its eyes; deliberate log lines
// ("[Test] Player reached checkpoint 2") turn a run into a test.
//   { "action": "set_play_mode", "enabled": true, "durationSeconds": 10 }
//     — enter Play Mode, run 10 seconds, exit, report the console
//     since the run started (errorCount, errorOccurrences,
//     warningCount, firstErrors, startCursor for readConsole).
//     Without a duration it enters and stays — use that only when
//     live state must be read, and stop it afterwards with
//     {"enabled": false}. Duration is capped at 120 seconds.
//     Compile errors block Play Mode: fix them first.
//   { "action": "read_component_values", "path": "Player", "component": "Rigidbody" }
//     — Inspector-visible values, live in Play Mode; without
//     "component" it lists the components and children instead.
//     "members": ["linearVelocity", "position"] reads runtime
//     values that are not serialized, by explicit name. A timed
//     run destroys the scene objects when it exits, so values can
//     only be read while Play Mode is still running — enter without
//     a duration, wait, read, stop.
//   { "action": "inject_input", "steps": [{"key": "D", "action": "hold", "seconds": 1.5},
//     {"key": "Space", "action": "tap"}, {"wait": 0.5}] }
//     — scripted keyboard / gamepad input while the game runs,
//     through the new Input System. At most 50 steps, 30 seconds.
//     A project on the legacy input system only cannot receive
//     injected input; the action fails plainly and says so.
//   { "action": "click_ui", "path": "Canvas/MainMenu/PlayButton" }
//     — click a UI Button (or any click handler) while the game runs.
// Scene tools (v0.14.0) — edit the scene itself, with the same
// undo trail the user controls: one Ctrl+Z per agent turn covers
// every scene write of that turn, and every structural change
// reports pathChanges so the app can rewrite later calls to the
// new paths. Write actions dry-run first — the app shows the
// preview and the user approves before anything is applied:
//   { "action": "set_property", "path": "Player", "component": "PlayerController", "changes": [{"property": "moveSpeed", "value": 8}] }
//     — set Inspector values, all or nothing (one bad change fails
//     the whole call, nothing half-modified). Property names are
//     Unity's serialized names (Transform m_LocalPosition,
//     Rigidbody m_Mass, your own scripts use the field name) —
//     read them with read_component_values first, never guess.
//     component "GameObject" targets the object itself (m_Name,
//     m_IsActive, m_TagString, m_Layer); a rename emits
//     pathChanges. Scene objects only, never prefab assets.
//     expectedBefore rejects the apply when a property changed
//     since the preview.
//   { "action": "create_gameobject", "name": "Boss", "parent": "Level/Enemies", "primitive": "Cube", "position": [0, 1, 0], "components": ["Rigidbody"] }
//     — create an object; names are made unique among siblings
//     and the result tells you the final path. Takes no property
//     values — configure with set_property afterwards, in the
//     same turn, so one Ctrl+Z reverts the whole thing.
//   { "action": "add_component", "path": "Player", "type": "Rigidbody" }
//     — add a component; types resolve through TypeCache, and a
//     script you just wrote is not there until the project
//     compiles. [RequireComponent] dependencies are added
//     automatically and reported as alsoAdded.
//   { "action": "delete_gameobject", "path": "Level/Enemies/Boss" }
//     — delete an object and its subtree. The preview lists what
//     is lost and every other scene object that points at it
//     (those show as "Missing" after the delete); the real call
//     refuses when the subtree changed since the preview.
//     Prefab-instance children cannot be deleted.
//   { "action": "set_parent", "path": "Level/Enemies/Boss", "newParent": "Level/Bosses", "keepWorldPosition": true }
//     — move an object; every path under it changes, reported as
//     pathChanges. Cycles are refused; a name clash at the
//     destination is refused unless renameOnConflict is true.
//   { "action": "list_hierarchy" }
//     — print the scene tree as text (60 nodes, depth 2 by
//     default): name, (off) for inactive objects, [components],
//     (+N children) where branches are cut, ×N for collapsed
//     groups of same-named siblings, !dup where two siblings
//     share a name. "nameContains" / "hasComponent" return a flat
//     list of matching paths instead.
//   { "action": "create_material", "name": "HeroMat", "shader": "Standard", "color": [1, 0.5, 0, 1] }
//     — create a .mat asset (default folder Assets/Materials).
//   { "action": "list_assets", "type": "texture" }
//     — list asset files under Assets/ by type.
// Props take strings, numbers, bools, [x,y(,z)] vectors, [r,g,b(,a)]
// colours (or "#rrggbb"), enum names, and asset paths (Assets/…) for
// Sprite / Material / Texture2D / Font / AudioClip. An unknown type,
// an unknown property, or a missing asset fails the whole command
// with a plain message — nothing is guessed.

#if UNITY_EDITOR
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.Compilation;
using UnityEditor.SceneManagement;
using UnityEditorInternal;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.SceneManagement;
using UnityEngine.UI;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
#endif

[InitializeOnLoad]
public static class CodeFoxBridge
{
    // Version of this bridge file. CodeFox reads this marker to tell
    // whether the bridge installed in a project is older than the one
    // bundled with the app, so it can update it automatically.
    // 0.16.0 is the first bridge with prefab transactions
    // (snapshot-backed prefab edits, restore_prefab, and the
    // per-turn scene undo revert). 0.15.0 is the first bridge
    // with the ComfyUI import profile (apply_import_profile).
    // 0.14.0 is the first bridge with the scene tools
    // (set_property, create_gameobject, add_component,
    // delete_gameobject, set_parent, list_hierarchy,
    // create_material, list_assets). 0.13.0 is the first bridge
    // with the play-test loop
    // (set_play_mode, read_component_values, inject_input,
    // click_ui). 0.12.0 is the first bridge that speaks the
    // .bridge/ transport (protocol 1); the app never sends inbox
    // commands to anything older — it updates the bridge first.
    public const string BridgeVersion = "0.16.1";
    // Protocol version every message carries. Bump it only when the
    // message shape changes in a way an old app could not read.
    public const int ProtocolVersion = 1;

    [Serializable]
    private class CFCommand
    {
        public string action;
        public string name;
        public CFParam[] parameters;
        public CFState[] states;
        public CFTransition[] transitions;
        public CFElement[] elements;
    }
    [Serializable]
    private class CFParam { public string name; public string type; }
    [Serializable]
    private class CFState { public string name; public string motion; public float speed = 1f; }
    [Serializable]
    private class CFTransition { public string from; public string to; public string parameter; public string condition; }
    [Serializable]
    private class CFElement { public string type; public string name; public string text; public string rect; }

    static CodeFoxBridge()
    {
        BridgeTransport.Initialize();
        // A domain reload mid-prefab-edit leaves the loaded
        // contents orphaned — unload the leaked scene, if any.
        PrefabTransactions.ClearStaleEdit();
        // Unsubscribe first: with Enter Play Mode Options set to
        // skip the domain reload, the static constructor runs again
        // in the same domain, and a second subscription would poll
        // (and run commands) twice.
        EditorApplication.update -= OnEditorUpdate;
        EditorApplication.update += OnEditorUpdate;
        EditorApplication.delayCall -= BridgeTransport.RecoverInterruptedRequests;
        EditorApplication.delayCall += BridgeTransport.RecoverInterruptedRequests;
        ConsoleBuffer.Initialize();
        PlayMode.Initialize();
#if ENABLE_INPUT_SYSTEM
        InjectInputHandler.Initialize();
#endif
        BridgeTransport.WriteHeartbeat();
        Debug.Log("[CodeFox] Bridge active. Watching .bridge/ for commands.");
    }

    // One line: everything the tick does lives in the transport,
    // so the entry point never grows handler logic of its own.
    private static void OnEditorUpdate()
    {
        BridgeTransport.Poll();
    }

    // ── Result type ──────────────────────────────────────────────
    // One result shape for every action. "pending" means the bridge
    // is still working on it (a compile report): the app keeps
    // waiting instead of timing out. "ok" with success:false in
    // the data is a tool that worked and reported a failure (a
    // compile with errors); "error" is reserved for the bridge
    // itself failing. `data` is raw JSON the handler already built
    // — it is spliced into the outbox file verbatim, never
    // re-escaped, exactly as the old result writer did.
    public class BridgeResult
    {
        public string Status;
        public string Message;
        public string Path;
        public string Data;

        public static BridgeResult Ok(string message, string path = null, string data = null)
        {
            return new BridgeResult { Status = "ok", Message = message, Path = path, Data = data };
        }
        public static BridgeResult Error(string message)
        {
            return new BridgeResult { Status = "error", Message = message };
        }
        public static BridgeResult Pending(string message)
        {
            return new BridgeResult { Status = "pending", Message = message };
        }

        public string ToJson()
        {
            string json = "{\"status\":\"" + Status
                + "\",\"message\":\"" + EscapeJson(Message ?? "")
                + "\",\"path\":\"" + EscapeJson(Path ?? "") + "\"";
            if (!string.IsNullOrEmpty(Data)) json += ",\"data\":" + Data;
            json += "}";
            return json;
        }
    }

    // ── Transport ────────────────────────────────────────────────
    // The file protocol, and nothing else: paths, the poll tick,
    // the heartbeat, claiming requests, writing results, and
    // recovering from a script reload. It knows nothing about what
    // any action does — the dispatcher owns that.
    private static class BridgeTransport
    {
        private const double IdlePollSeconds = 1.0;
        private const double ActivePollSeconds = 0.15;
        private const double ActiveWindowSeconds = 5.0;
        private const double OutboxKeepMinutes = 30.0;
        private const double CleanupEverySeconds = 60.0;

        private static string _bridgeDir;
        private static string _inboxDir;
        private static string _processingDir;
        private static string _outboxDir;
        private static string _heartbeatPath;
        private static string _triggerPath;
        private static string _lastTriggerContent = "";
        private static double _nextPollTime = 0;
        private static double _activeUntil = 0;
        private static double _lastCleanupTime = 0;

        public static void Initialize()
        {
            string projectRoot = Path.GetDirectoryName(Application.dataPath);
            _bridgeDir = Path.Combine(projectRoot, ".bridge");
            _inboxDir = Path.Combine(_bridgeDir, "inbox");
            _processingDir = Path.Combine(_bridgeDir, "processing");
            _outboxDir = Path.Combine(_bridgeDir, "outbox");
            _heartbeatPath = Path.Combine(_bridgeDir, "heartbeat.json");
            _triggerPath = Path.Combine(_bridgeDir, "refresh-trigger");
            try
            {
                Directory.CreateDirectory(_inboxDir);
                Directory.CreateDirectory(_processingDir);
                Directory.CreateDirectory(_outboxDir);
            }
            catch (Exception e) { Debug.LogWarning("[CodeFox] Could not create .bridge folders: " + e.Message); }
        }

        public static void Poll()
        {
            double now = EditorApplication.timeSinceStartup;
            if (now < _nextPollTime) return;
            bool active = now < _activeUntil;
            _nextPollTime = now + (active ? ActivePollSeconds : IdlePollSeconds);

            // The heartbeat is written before anything else, and
            // before the compiling check — so it stays fresh while
            // a compile runs, and the app can tell "compiling"
            // from "dead". EditorApplication.isPlaying is
            // main-thread only; the console buffer reads the cached
            // value instead.
            WriteHeartbeat();
            ConsoleBuffer.NoteIsPlaying(EditorApplication.isPlaying);

            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;

            CheckRefreshTrigger();

            // A pending long-running request that finished — a
            // compile report (on either path: reload after success,
            // or errors with no reload), a play-mode change, an
            // input sequence — is finalized by the poll tick, not
            // by reload recovery. One per tick, in order; each
            // finalizer owns its state and reports when it is done.
            TryFinalizePending();

            ProcessInbox();
            CleanupOutbox(now);
        }

        // One pending finalizer per tick, in order: a compile
        // report, a play-mode change, an input sequence. Each owns
        // its SessionState or static state and reports when it is
        // done; the transport only writes the result and deletes
        // the processing file.
        private static bool TryFinalizePending()
        {
            BridgeResult finalResult;
            string finalId;
            if (CompileReport.TryFinalize(out finalResult, out finalId))
            {
                WriteOutbox(finalId, finalResult);
                DeleteProcessing(finalId);
                MarkActive();
                return true;
            }
            if (PlayMode.TryFinalize(out finalResult, out finalId))
            {
                WriteOutbox(finalId, finalResult);
                DeleteProcessing(finalId);
                MarkActive();
                return true;
            }
#if ENABLE_INPUT_SYSTEM
            if (InjectInputHandler.TryFinalize(out finalResult, out finalId))
            {
                WriteOutbox(finalId, finalResult);
                DeleteProcessing(finalId);
                MarkActive();
                return true;
            }
#endif
            return false;
        }

        private static void MarkActive()
        {
            double now = EditorApplication.timeSinceStartup;
            _activeUntil = now + ActiveWindowSeconds;
            _nextPollTime = now + ActivePollSeconds;
        }

        public static void WriteHeartbeat()
        {
            // Unix milliseconds — the app compares it against its
            // own clock, so wall time, not editor uptime.
            long ms = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            string json = "{\"protocol\":" + ProtocolVersion
                + ",\"timeMs\":" + ms
                + ",\"isCompiling\":" + (EditorApplication.isCompiling ? "true" : "false")
                + ",\"isPlaying\":" + (EditorApplication.isPlaying ? "true" : "false")
                + ",\"isPlayingOrWillChangePlaymode\":" + (EditorApplication.isPlayingOrWillChangePlaymode ? "true" : "false")
                + ",\"isPaused\":" + (EditorApplication.isPaused ? "true" : "false") + "}";
            WriteFileAtomic(_heartbeatPath, json);
        }

        // Write a file so a reader never sees a half-written one:
        // write the temp file, then move it over the destination.
        // File.Replace is atomic on Windows when the destination
        // exists; when it does not, a plain move is the atomic step.
        // Returns false when the write failed — the heartbeat is
        // re-written next tick, and a failed outbox write is logged
        // by the caller (the app will time out waiting for it).
        public static bool WriteFileAtomic(string path, string content)
        {
            string tmp = path + ".tmp";
            try
            {
                File.WriteAllText(tmp, content);
                try
                {
                    if (File.Exists(path)) File.Replace(tmp, path, null);
                    else File.Move(tmp, path);
                }
                catch
                {
                    // Replace is picky on some runtimes when the
                    // destination is missing or locked: delete and
                    // move is the fallback.
                    try { if (File.Exists(path)) File.Delete(path); } catch { }
                    File.Move(tmp, path);
                }
                return true;
            }
            catch (Exception e)
            {
                Debug.LogWarning("[CodeFox] Could not write " + Path.GetFileName(path) + ": " + e.Message);
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
                return false;
            }
        }

        private static void CheckRefreshTrigger()
        {
            if (!File.Exists(_triggerPath)) return;
            try
            {
                string content = File.ReadAllText(_triggerPath);
                if (content != _lastTriggerContent)
                {
                    _lastTriggerContent = content;
                    Debug.Log("[CodeFox] Change detected. Refreshing AssetDatabase...");
                    AssetDatabase.Refresh();
                }
            }
            catch (IOException) { }
        }

        private static void ProcessInbox()
        {
            string[] files;
            try { files = Directory.GetFiles(_inboxDir, "*.json"); }
            catch { return; }
            // Oldest first, so ten commands sent quickly come back
            // in the order they were sent. The glob is *.json only,
            // so a .tmp the app is still writing is never picked up.
            Array.Sort(files, (a, b) => File.GetCreationTimeUtc(a).CompareTo(File.GetCreationTimeUtc(b)));
            foreach (string file in files)
            {
                string id = Path.GetFileNameWithoutExtension(file);
                if (!IsSafeRequestId(id)) continue;
                string processingPath = Path.Combine(_processingDir, Path.GetFileName(file));
                try { File.Move(file, processingPath); }
                catch (IOException) { continue; } // the app still holds it — retry next tick
                BridgeResult result = ProcessRequest(processingPath, id);
                if (result != null && result.Status == "pending")
                {
                    // The handler is still working (a compile
                    // report): the pending result goes out now, the
                    // processing file STAYS, and the poll tick
                    // finalizes it. Stop here — a compile is
                    // starting, and anything after it must wait for
                    // the reload that follows.
                    WriteOutbox(id, result);
                    MarkActive();
                    break;
                }
                if (result != null) WriteOutbox(id, result);
                DeleteProcessing(id);
                MarkActive();
                // A handler that started a compile (or a compile
                // already running) means a reload is coming — stop
                // the inbox here so nothing runs against the
                // half-reloaded domain.
                if (EditorApplication.isCompiling || CompileReport.HasPending()) break;
            }
        }

        private static BridgeResult ProcessRequest(string processingPath, string id)
        {
            string json;
            try { json = File.ReadAllText(processingPath); }
            catch (IOException e) { return BridgeResult.Error("Could not read the command file: " + e.Message); }
            object parsed;
            try { parsed = JsonMini.Parse(json); }
            catch (Exception e) { return BridgeResult.Error("Could not parse command JSON: " + e.Message); }
            var args = parsed as Dictionary<string, object>;
            if (args == null) return BridgeResult.Error("Command JSON must be an object.");
            object proto;
            if (!args.TryGetValue("protocol", out proto) || !(proto is double) || (double)proto != ProtocolVersion)
                return BridgeResult.Error("Unsupported bridge protocol — expected protocol " + ProtocolVersion + ". Update CodeFox and the bridge.");
            string action = JStr(args, "action", "");
            if (string.IsNullOrEmpty(action)) return BridgeResult.Error("Command JSON has no action.");
            BridgeDispatcher.CurrentRequestId = id;
            try { return BridgeDispatcher.Dispatch(action, json, args); }
            catch (Exception e) { return BridgeResult.Error("Command failed: " + e.Message); }
            finally { BridgeDispatcher.CurrentRequestId = null; }
        }

        private static void WriteOutbox(string id, BridgeResult result)
        {
            if (!WriteFileAtomic(Path.Combine(_outboxDir, id + ".json"), result.ToJson()))
                Debug.LogWarning("[CodeFox] Could not write the result for request " + id + " — the app will time out waiting for it.");
        }

        private static void DeleteProcessing(string id)
        {
            try { File.Delete(Path.Combine(_processingDir, id + ".json")); } catch { }
        }

        // Request ids are file names the app generates. A name with
        // a separator or a dot in it could escape the inbox — the
        // app never sends one, but the bridge refuses to act on it
        // anyway. Letters, digits, '-' and '_' only, at most 64.
        public static bool IsSafeRequestId(string id)
        {
            if (string.IsNullOrEmpty(id) || id.Length > 64) return false;
            foreach (char c in id)
            {
                if (!(char.IsLetterOrDigit(c) || c == '-' || c == '_')) return false;
            }
            return true;
        }

        // Runs once, after the editor finishes loading (delayCall):
        // a file left in processing/ means the last domain died
        // mid-command — usually a script reload. A pending compile
        // report is NOT interrupted — its finalizer owns it.
        // Anything else either has a handler that can only finish
        // after a reload, or is reported as interrupted so the app
        // can retry it when it is safe to do so.
        public static void RecoverInterruptedRequests()
        {
            string[] files;
            try { files = Directory.GetFiles(_processingDir, "*.json"); }
            catch { return; }
            foreach (string file in files)
            {
                string id = Path.GetFileNameWithoutExtension(file);
                if (!IsSafeRequestId(id)) continue;
                if (CompileReport.IsPending(id)) continue;
                if (PlayMode.IsPending(id)) continue;
                string json = null;
                try { json = File.ReadAllText(file); } catch { }
                string action = "";
                Dictionary<string, object> args = null;
                if (json != null)
                {
                    try
                    {
                        object parsed = JsonMini.Parse(json);
                        args = parsed as Dictionary<string, object>;
                        if (args != null) action = JStr(args, "action", "");
                    }
                    catch { }
                }
                BridgeResult result;
                Func<string, Dictionary<string, object>, BridgeResult> afterReload;
                if (!string.IsNullOrEmpty(action) && BridgeDispatcher.CompleteAfterReloadHandlers.TryGetValue(action, out afterReload))
                {
                    BridgeDispatcher.CurrentRequestId = id;
                    try { result = afterReload(json, args); }
                    catch (Exception e) { result = BridgeResult.Error("Command failed after reload: " + e.Message); }
                    finally { BridgeDispatcher.CurrentRequestId = null; }
                }
                else
                {
                    result = BridgeResult.Error("Interrupted by a script reload. Safe to retry if idempotent.");
                }
                WriteOutbox(id, result);
                DeleteProcessing(id);
            }
        }

        private static void CleanupOutbox(double now)
        {
            if (now - _lastCleanupTime < CleanupEverySeconds) return;
            _lastCleanupTime = now;
            string[] files;
            try { files = Directory.GetFiles(_outboxDir, "*.json"); }
            catch { return; }
            foreach (string file in files)
            {
                try
                {
                    if ((DateTime.UtcNow - File.GetLastWriteTimeUtc(file)).TotalMinutes > OutboxKeepMinutes)
                        File.Delete(file);
                }
                catch { }
            }
        }
    }

    // ── Dispatcher ───────────────────────────────────────────────
    // One table: action name → handler. A handler gets the raw
    // command JSON (the three JsonUtility actions need it) and the
    // parsed args (everything else uses it — no handler re-parses).
    // An unknown action fails with the list of actions that exist,
    // so the model can correct itself instead of guessing.
    private static class BridgeDispatcher
    {
        // The request id of the command currently running, so a
        // handler that needs it (the compile report) can read it.
        // Set by the transport around the dispatch, cleared after.
        public static string CurrentRequestId;

        // Handlers that can only finish after a script reload
        // register here; the transport's recovery runs them for a
        // request left in processing/ by the reload. Nothing
        // registers yet — the compile report finalizes through the
        // poll tick instead (see CompileReport) — but the hook is
        // here for the next handler that needs it.
        public static readonly Dictionary<string, Func<string, Dictionary<string, object>, BridgeResult>> CompleteAfterReloadHandlers =
            new Dictionary<string, Func<string, Dictionary<string, object>, BridgeResult>>(StringComparer.Ordinal);

        private static readonly Dictionary<string, Func<string, Dictionary<string, object>, BridgeResult>> Handlers =
            new Dictionary<string, Func<string, Dictionary<string, object>, BridgeResult>>(StringComparer.Ordinal)
            {
                { "refresh", (json, args) => Refresh(json) },
                { "createAnimatorController", (json, args) => CreateAnimatorController(json) },
                { "createUICanvas", (json, args) => CreateUICanvas(json) },
                { "createPrefab", (json, args) => CreatePrefab(json, args) },
                { "modifyPrefab", (json, args) => ModifyPrefab(json, args) },
                { "restore_prefab", (json, args) => PrefabTransactions.RestoreSnapshotAction(json, args) },
                { "revert_turn", (json, args) => MutationScope.RevertTurn(json, args) },
                { "deleteAsset", (json, args) => DeleteAsset(json, args) },
                { "listComponentTypes", (json, args) => ListComponentTypes(json, args) },
                { "describeComponent", (json, args) => DescribeComponent(json, args) },
                { "readConsole", (json, args) => ConsoleBuffer.Read(json, args) },
                { "recompile_and_report_errors", (json, args) => CompileReport.Begin(json, args) },
                { "set_play_mode", (json, args) => PlayMode.Begin(json, args) },
                { "read_component_values", (json, args) => ReadComponentValuesHandler.Handle(json, args) },
                { "set_property", (json, args) => SetPropertyHandler.Handle(json, args) },
                { "create_gameobject", (json, args) => CreateGameObjectHandler.Handle(json, args) },
                { "add_component", (json, args) => AddComponentHandler.Handle(json, args) },
                { "delete_gameobject", (json, args) => DeleteGameObjectHandler.Handle(json, args) },
                { "set_parent", (json, args) => SetParentHandler.Handle(json, args) },
                { "list_hierarchy", (json, args) => ListHierarchyHandler.Handle(json, args) },
                { "create_material", (json, args) => CreateMaterialHandler.Handle(json, args) },
                { "apply_import_profile", (json, args) => ApplyImportProfileHandler.Handle(json, args) },
                { "list_assets", (json, args) => ListAssetsHandler.Handle(json, args) },
                { "click_ui", (json, args) => ClickUI(json, args) },
#if ENABLE_INPUT_SYSTEM
                { "inject_input", (json, args) => InjectInputHandler.Begin(json, args) },
#else
                // No new Input System in this project: input cannot
                // be injected from editor code (the legacy
                // UnityEngine.Input has no fakeable path). Say so
                // plainly and point at the opt-in hooks instead of
                // failing with "unknown action".
                { "inject_input", (json, args) => BridgeResult.Error("This project uses the legacy input system only (UnityEngine.Input) — input cannot be injected from editor code. Add opt-in [AgentCallable] hooks to the game code instead, or enable the new Input System in Project Settings → Player → Active Input Handler.") },
#endif
            };

        public static BridgeResult Dispatch(string action, string json, Dictionary<string, object> args)
        {
            Func<string, Dictionary<string, object>, BridgeResult> handler;
            if (!Handlers.TryGetValue(action, out handler))
            {
                var names = new List<string>(Handlers.Keys);
                names.Sort(StringComparer.Ordinal);
                return BridgeResult.Error("Unknown action: " + action + ". Available: " + string.Join(", ", names.ToArray()) + ".");
            }
            return handler(json, args);
        }
    }

    // ── Compile report ───────────────────────────────────────────
    // Ask Unity itself to compile and report the errors, with
    // file:line — Unity's own compiler, not dotnet, and it works
    // with no .sln in the project.
    //
    // THE TRAP: a successful compile ends with a domain reload and
    // the bridge restarts; a compile WITH errors does NOT reload —
    // Unity keeps the old assemblies and this code stays alive. A
    // design that only finalizes after the reload would hang
    // forever on exactly the case that matters (the errors). So
    // all state lives in SessionState (which survives reloads, not
    // editor restarts) and the poll tick finalizes the request
    // whichever path happened. The transport's reload recovery
    // skips pending compile ids — the finalizer owns them.
    private static class CompileReport
    {
        private const string PendingIdKey = "CodeFox.Compile.PendingId";
        private const string RequestedAtKey = "CodeFox.Compile.RequestedAt";
        private const string StartedKey = "CodeFox.Compile.Started";
        private const string FinishedKey = "CodeFox.Compile.Finished";
        private const string ErrorCountKey = "CodeFox.Compile.ErrorCount";
        private const string WarningCountKey = "CodeFox.Compile.WarningCount";
        private const string ErrorsJsonKey = "CodeFox.Compile.ErrorsJson";
        private const int MaxErrors = 20;
        private const int MaxErrorChars = 300;
        private const int NoChangesSeconds = 4;
        private const int HardTimeoutSeconds = 300;

        public static BridgeResult Begin(string json, Dictionary<string, object> args)
        {
            string id = BridgeDispatcher.CurrentRequestId;
            if (string.IsNullOrEmpty(id)) return BridgeResult.Error("recompile_and_report_errors needs a request id.");
            // Unity cannot compile while the game is running, and
            // entering Play Mode with a compile pending would
            // disrupt the run — the loop stops the game before
            // touching code, and the guard makes that a plain error
            // instead of a silent no-op.
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                return BridgeResult.Error("Stop Play Mode first: set_play_mode {\"enabled\": false} — Unity cannot compile while the game is running.");
            string pending = SessionState.GetString(PendingIdKey, "");
            if (!string.IsNullOrEmpty(pending) && pending != id)
                return BridgeResult.Error("A compile report is already running (request " + pending + "). Wait for it to finish, then try again.");
            if (pending == id) return BridgeResult.Pending("Compiling…");

            CompilationPipeline.compilationStarted -= OnCompilationStarted;
            CompilationPipeline.assemblyCompilationFinished -= OnAssemblyCompilationFinished;
            CompilationPipeline.compilationFinished -= OnCompilationFinished;
            CompilationPipeline.compilationStarted += OnCompilationStarted;
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
            CompilationPipeline.compilationFinished += OnCompilationFinished;

            SessionState.SetString(PendingIdKey, id);
            SessionState.SetInt(RequestedAtKey, UnixSeconds());
            // A compile already in progress counts as started, so
            // the "nothing to compile" path cannot fire while Unity
            // is actually compiling.
            SessionState.SetBool(StartedKey, EditorApplication.isCompiling);
            SessionState.SetBool(FinishedKey, false);
            SessionState.SetInt(ErrorCountKey, 0);
            SessionState.SetInt(WarningCountKey, 0);
            SessionState.SetString(ErrorsJsonKey, "[]");

            // Auto Refresh may be off — a refresh is what makes
            // Unity notice the .cs change on disk.
            AssetDatabase.Refresh();
            if (!EditorApplication.isCompiling) CompilationPipeline.RequestScriptCompilation();
            return BridgeResult.Pending("Compiling…");
        }

        public static bool HasPending()
        {
            return !string.IsNullOrEmpty(SessionState.GetString(PendingIdKey, ""));
        }

        public static bool IsPending(string id)
        {
            return !string.IsNullOrEmpty(id) && SessionState.GetString(PendingIdKey, "") == id;
        }

        // Called every poll tick. Returns true when the pending
        // report is final — the transport writes the result and
        // deletes the processing file.
        public static bool TryFinalize(out BridgeResult result, out string requestId)
        {
            result = null;
            requestId = null;
            string id = SessionState.GetString(PendingIdKey, "");
            if (string.IsNullOrEmpty(id)) return false;
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return false;

            bool finished = SessionState.GetBool(FinishedKey, false);
            bool started = SessionState.GetBool(StartedKey, false);
            int requestedAt = SessionState.GetInt(RequestedAtKey, 0);
            int waited = requestedAt > 0 ? UnixSeconds() - requestedAt : 0;

            if (!finished && !started && waited >= NoChangesSeconds)
            {
                // No compile started in 4 seconds: there were no
                // script changes to compile. Not a failure. (If
                // Unity recompiles anyway despite no changes, the
                // report comes back "Compile clean" once it
                // finishes instead — the 4-second path only covers
                // a compile that never starts.)
                ClearState();
                requestId = id;
                result = BridgeResult.Ok("No script changes — nothing to compile.", null,
                    "{\"success\":true,\"compiled\":false,\"errors\":[],\"errorCount\":0,\"warningCount\":0}");
                return true;
            }
            if (!finished && waited >= HardTimeoutSeconds)
            {
                ClearState();
                requestId = id;
                result = BridgeResult.Error("Compile did not finish within 5 minutes — Unity may be stuck compiling. Check the Console and try again.");
                return true;
            }
            if (!finished) return false;

            int errorCount = SessionState.GetInt(ErrorCountKey, 0);
            int warningCount = SessionState.GetInt(WarningCountKey, 0);
            string errorsJson = SessionState.GetString(ErrorsJsonKey, "[]");
            // A compile can report failure without any collected
            // error (for example an assembly that fails to load),
            // so Unity's own flag is part of the verdict.
            bool failed = errorCount > 0 || EditorUtility.scriptCompilationFailed;
            ClearState();
            requestId = id;
            string data = "{\"success\":" + (failed ? "false" : "true")
                + ",\"compiled\":true"
                + ",\"errors\":" + errorsJson
                + ",\"errorCount\":" + errorCount
                + ",\"warningCount\":" + warningCount
                + ",\"hint\":\"Fix the first error first; later errors are often caused by it.\"}";
            string message = failed
                ? "Compile failed: " + errorCount + " error" + (errorCount == 1 ? "" : "s") + (warningCount > 0 ? ", " + warningCount + " warning" + (warningCount == 1 ? "" : "s") + "." : ".")
                : "Compile clean." + (warningCount > 0 ? " " + warningCount + " warning" + (warningCount == 1 ? "" : "s") + "." : "");
            result = BridgeResult.Ok(message, null, data);
            return true;
        }

        private static void ClearState()
        {
            CompilationPipeline.compilationStarted -= OnCompilationStarted;
            CompilationPipeline.assemblyCompilationFinished -= OnAssemblyCompilationFinished;
            CompilationPipeline.compilationFinished -= OnCompilationFinished;
            SessionState.SetString(PendingIdKey, "");
            SessionState.SetBool(StartedKey, false);
            SessionState.SetBool(FinishedKey, false);
            SessionState.SetInt(ErrorCountKey, 0);
            SessionState.SetInt(WarningCountKey, 0);
            SessionState.SetString(ErrorsJsonKey, "[]");
        }

        private static void OnCompilationStarted(object obj)
        {
            SessionState.SetBool(StartedKey, true);
        }

        private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
        {
            if (messages == null) return;
            int errors = SessionState.GetInt(ErrorCountKey, 0);
            int warnings = SessionState.GetInt(WarningCountKey, 0);
            string errorsJson = SessionState.GetString(ErrorsJsonKey, "[]");
            foreach (CompilerMessage m in messages)
            {
                if (m.type == CompilerMessageType.Warning) { warnings++; continue; }
                if (m.type != CompilerMessageType.Error) continue;
                errors++;
                // errorCount is the true count; only the first 20
                // errors are stored, each truncated to 300 chars.
                if (errors > MaxErrors) continue;
                string entry = "{\"file\":\"" + EscapeJson(m.file ?? "")
                    + "\",\"line\":" + m.line
                    + ",\"message\":\"" + EscapeJson(TruncateString(m.message ?? "", MaxErrorChars)) + "\"}";
                if (errorsJson == "[]") errorsJson = "[" + entry + "]";
                else errorsJson = errorsJson.Substring(0, errorsJson.Length - 1) + "," + entry + "]";
            }
            SessionState.SetInt(ErrorCountKey, errors);
            SessionState.SetInt(WarningCountKey, warnings);
            SessionState.SetString(ErrorsJsonKey, errorsJson);
        }

        private static void OnCompilationFinished(object obj)
        {
            SessionState.SetBool(FinishedKey, true);
        }

        private static int UnixSeconds()
        {
            return (int)DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        }
    }

    private static string EscapeJson(string s)
    {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
    }

    private static string TruncateString(string s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Length <= max ? s : s.Substring(0, max);
    }

    // ── Console buffer ───────────────────────────────────────────
    // The bridge keeps its own log buffer instead of re-reading
    // Unity's console on every call. Two sources feed it:
    //   * Application.logMessageReceivedThreaded — a public API —
    //     catches everything logged after the bridge loads.
    //   * A one-time seed from UnityEditor.LogEntries (reached by
    //     reflection, the same pattern the old readConsole used)
    //     for the console as it stood when the bridge loaded —
    //     without it, "why are there so many errors" would be
    //     unanswerable from an empty buffer.
    // If the LogEntries reflection ever breaks on a future Unity
    // version, the seed is skipped and the buffer starts empty —
    // everything still works, it just cannot see pre-existing
    // entries. Logs emitted during a domain reload are lost (a
    // short window); the most recent 500 entries survive the
    // reload in SessionState.
    private static class ConsoleBuffer
    {
        private const int Capacity = 2000;
        private const int PersistCount = 500;
        private const int MaxMessageChars = 2000;
        private const int MaxPersistMessageChars = 500;
        private const int MaxStackLines = 5;
        private const int MaxStackLineChars = 300;
        private const string PersistKey = "CodeFox.Console.Persisted";

        private class Entry
        {
            public long seq;
            public long firstSeq;
            public long unixMs;
            public string type;
            public int level;
            public string message;
            public string stack;
            public int count;
            public bool playMode;
            public string file;
            public int line;
        }

        private static readonly List<Entry> _entries = new List<Entry>();
        private static long _nextSeq = 1;
        private static long _evictedTotal = 0;
        private static readonly object _lock = new object();
        private static volatile bool _isPlayingCache = false;
        private static bool _initialized = false;

        public static void Initialize()
        {
            if (_initialized) return;
            _initialized = true;
            Application.logMessageReceivedThreaded -= OnLogMessage;
            Application.logMessageReceivedThreaded += OnLogMessage;
            AssemblyReloadEvents.beforeAssemblyReload -= Persist;
            AssemblyReloadEvents.beforeAssemblyReload += Persist;
            _isPlayingCache = EditorApplication.isPlaying;
            // A reload restores the buffer from SessionState; a
            // fresh load seeds it from the console. Restoring AND
            // seeding would duplicate every entry, so the seed only
            // runs when there is nothing to restore.
            if (!Restore()) SeedFromLogEntries();
        }

        // EditorApplication.isPlaying is main-thread only; the
        // threaded log callback reads this cached value instead.
        // The transport updates it every poll tick.
        public static void NoteIsPlaying(bool isPlaying)
        {
            _isPlayingCache = isPlaying;
        }

        private static void OnLogMessage(string condition, string stackTrace, LogType type)
        {
            // Runs on whatever thread logged — lock around the
            // buffer, and never log from here (it would recurse
            // into this callback).
            int level = type == LogType.Log ? 0 : type == LogType.Warning ? 1 : 2;
            string message = TruncateString(FirstLine(condition), MaxMessageChars);
            string stack = "";
            if (level == 2 && !string.IsNullOrEmpty(stackTrace)) stack = FilterStack(stackTrace);
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Append(level, type.ToString(), message, stack, now, null, 0);
        }

        // One append path for the live callback and the seed: a
        // log in Update() is the same line 60 times a second, so
        // consecutive duplicates collapse into one entry with a
        // count instead of flooding the buffer with copies. A
        // collapsed entry keeps its firstSeq and takes the newest
        // seq, so a read since an old cursor still sees it when it
        // recurs after the cursor.
        private static void Append(int level, string type, string message, string stack, long unixMs, string file, int line)
        {
            lock (_lock)
            {
                if (_entries.Count > 0)
                {
                    Entry last = _entries[_entries.Count - 1];
                    if (last.message == message && last.type == type)
                    {
                        last.count++;
                        last.seq = _nextSeq++;
                        last.unixMs = unixMs;
                        return;
                    }
                }
                var entry = new Entry
                {
                    seq = _nextSeq, firstSeq = _nextSeq, unixMs = unixMs,
                    type = type, level = level, message = message,
                    stack = stack, count = 1, playMode = _isPlayingCache,
                    file = file, line = line,
                };
                _nextSeq++;
                _entries.Add(entry);
                if (_entries.Count > Capacity)
                {
                    _entries.RemoveAt(0);
                    _evictedTotal++;
                }
            }
        }

        private static string FirstLine(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            int nl = s.IndexOf('\n');
            return (nl >= 0 ? s.Substring(0, nl) : s).Trim();
        }

        // Stack lines for error-like entries only, at most 5,
        // with Unity-internal frames dropped (the same filter the
        // old readConsole used).
        private static string FilterStack(string stackTrace)
        {
            var kept = new List<string>();
            string[] lines = stackTrace.Split('\n');
            foreach (string raw in lines)
            {
                if (kept.Count >= MaxStackLines) break;
                string line = raw.Trim();
                if (line.Length == 0) continue;
                if (IsInternalStackLine(line)) continue;
                kept.Add(TruncateString(line, MaxStackLineChars));
            }
            return string.Join("\n", kept.ToArray());
        }

        private static bool IsInternalStackLine(string line)
        {
            string l = line.TrimStart();
            return l.StartsWith("UnityEngine.Debug:", StringComparison.Ordinal)
                || l.StartsWith("UnityEditor.", StringComparison.Ordinal)
                || l.StartsWith("UnityEngine.", StringComparison.Ordinal)
                || l.StartsWith("EditorGUIUtility:", StringComparison.Ordinal)
                || l.StartsWith("SystemState:", StringComparison.Ordinal)
                || l.StartsWith("(at Library/", StringComparison.Ordinal)
                || l.StartsWith("(at ./Library/", StringComparison.Ordinal);
        }

        // LogEntry.mode bits (the same masks the old readConsole
        // used): Error = Error(1<<0) | AssetImportError(1<<6) |
        // ScriptingError(1<<8) | ScriptCompileError(1<<11) |
        // StickyError(1<<13) plus Assert(1<<1) | Fatal(1<<4) |
        // ScriptingException(1<<17) | ScriptingAssertion(1<<21);
        // Warning = AssetImportWarning(1<<7) |
        // ScriptingWarning(1<<9) | ScriptCompileWarning(1<<12).
        private static readonly int[] ErrorModes = { 1 << 0, 1 << 6, 1 << 8, 1 << 11, 1 << 13, 1 << 1, 1 << 4, 1 << 17, 1 << 21 };
        private static readonly int[] WarningModes = { 1 << 7, 1 << 9, 1 << 12 };

        private static bool ModeMatches(int mode, int[] wanted)
        {
            foreach (int m in wanted) if ((mode & m) != 0) return true;
            return false;
        }

        private static int ModeToLevel(int mode)
        {
            if (ModeMatches(mode, ErrorModes)) return 2;
            if (ModeMatches(mode, WarningModes)) return 1;
            return 0;
        }

        private static string ModeToType(int mode)
        {
            if ((mode & (1 << 17)) != 0) return "Exception";
            if ((mode & (1 << 1)) != 0 || (mode & (1 << 21)) != 0) return "Assert";
            if (ModeMatches(mode, ErrorModes)) return "Error";
            if (ModeMatches(mode, WarningModes)) return "Warning";
            return "Log";
        }

        // Seed the buffer from the console as it stands at load:
        // oldest first, so sequence numbers ascend in console
        // order. Any reflection failure skips the seed silently —
        // the live callback is the source of truth, and a buffer
        // that starts empty still works.
        private static void SeedFromLogEntries()
        {
            Type logEntriesType = typeof(EditorApplication).Assembly.GetType("UnityEditor.LogEntries");
            if (logEntriesType == null) return;
            MethodInfo startGetting = logEntriesType.GetMethod("StartGettingEntries", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            MethodInfo endGetting = logEntriesType.GetMethod("EndGettingEntries", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            MethodInfo getCount = logEntriesType.GetMethod("GetCount", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            MethodInfo getEntry = logEntriesType.GetMethod("GetEntryInternal", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (startGetting == null || endGetting == null || getCount == null || getEntry == null) return;
            Type logEntryType = typeof(EditorApplication).Assembly.GetType("UnityEditor.LogEntry");
            if (logEntryType == null) return;
            FieldInfo modeField = logEntryType.GetField("mode", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            FieldInfo messageField = logEntryType.GetField("message", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            FieldInfo fileField = logEntryType.GetField("file", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            FieldInfo lineField = logEntryType.GetField("line", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (modeField == null || messageField == null) return;
            // LogEntry carries no timestamp — seeded entries share
            // the seed time.
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            try
            {
                startGetting.Invoke(null, null);
                try
                {
                    int count = Convert.ToInt32(getCount.Invoke(null, null));
                    for (int i = 0; i < count; i++)
                    {
                        object entry = Activator.CreateInstance(logEntryType);
                        getEntry.Invoke(null, new object[] { i, entry });
                        int mode = Convert.ToInt32(modeField.GetValue(entry));
                        int level = ModeToLevel(mode);
                        string raw = messageField.GetValue(entry) as string ?? "";
                        string message = TruncateString(FirstLine(raw), MaxMessageChars);
                        string stack = "";
                        if (level == 2)
                        {
                            // The rest of the message is the stack
                            // (LogEntries packs message + stack into
                            // one string).
                            string[] lines = raw.Split('\n');
                            var kept = new List<string>();
                            for (int j = 1; j < lines.Length && kept.Count < MaxStackLines; j++)
                            {
                                string sl = lines[j].Trim();
                                if (sl.Length == 0) continue;
                                if (IsInternalStackLine(sl)) continue;
                                kept.Add(TruncateString(sl, MaxStackLineChars));
                            }
                            stack = string.Join("\n", kept.ToArray());
                        }
                        string file = null;
                        int line = 0;
                        if (fileField != null) file = fileField.GetValue(entry) as string;
                        if (lineField != null) line = Convert.ToInt32(lineField.GetValue(entry));
                        Append(level, ModeToType(mode), message, stack, now, file, line);
                    }
                }
                finally { endGetting.Invoke(null, null); }
            }
            catch { /* seeding is best-effort */ }
        }

        private static void Persist()
        {
            Entry[] snapshot;
            lock (_lock)
            {
                int start = Math.Max(0, _entries.Count - PersistCount);
                snapshot = new Entry[_entries.Count - start];
                _entries.CopyTo(start, snapshot, 0, snapshot.Length);
            }
            var sb = new System.Text.StringBuilder();
            sb.Append('[');
            for (int i = 0; i < snapshot.Length; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(EntryToJson(snapshot[i], MaxPersistMessageChars, true));
            }
            sb.Append(']');
            try { SessionState.SetString(PersistKey, sb.ToString()); } catch { }
        }

        private static bool Restore()
        {
            string json = null;
            try { json = SessionState.GetString(PersistKey, ""); } catch { return false; }
            if (string.IsNullOrEmpty(json)) return false;
            object parsed;
            try { parsed = JsonMini.Parse(json); }
            catch { return false; }
            var list = parsed as List<object>;
            if (list == null || list.Count == 0) return false;
            lock (_lock)
            {
                foreach (object item in list)
                {
                    var d = item as Dictionary<string, object>;
                    if (d == null) continue;
                    Entry e = EntryFromDict(d);
                    if (e == null) continue;
                    _entries.Add(e);
                    if (e.seq >= _nextSeq) _nextSeq = e.seq + 1;
                }
                while (_entries.Count > Capacity) { _entries.RemoveAt(0); _evictedTotal++; }
            }
            return _entries.Count > 0;
        }

        private static Entry EntryFromDict(Dictionary<string, object> d)
        {
            try
            {
                var e = new Entry();
                e.seq = ToLong(NumField(d, "seq"), 0);
                e.firstSeq = ToLong(NumField(d, "firstSeq"), e.seq);
                e.unixMs = ToLong(NumField(d, "unixMs"), 0);
                e.type = JStr(d, "type", "Log");
                e.level = (int)ToLong(NumField(d, "level"), 0);
                e.message = JStr(d, "message", "");
                object stackObj;
                if (d.TryGetValue("stack", out stackObj) && stackObj is List<object>)
                {
                    var lines = new List<string>();
                    foreach (object l in (List<object>)stackObj) lines.Add(l as string ?? "");
                    e.stack = string.Join("\n", lines.ToArray());
                }
                else e.stack = JStr(d, "stack", "");
                e.count = Math.Max(1, (int)ToLong(NumField(d, "count"), 1));
                object pm;
                e.playMode = d.TryGetValue("playMode", out pm) && pm is bool && (bool)pm;
                e.file = JStr(d, "file", null);
                e.line = (int)ToLong(NumField(d, "line"), 0);
                if (e.seq <= 0 || string.IsNullOrEmpty(e.message)) return null;
                return e;
            }
            catch { return null; }
        }

        private static object NumField(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v : null;
        }

        private static long ToLong(object v, long def)
        {
            if (v is double) return (long)(double)v;
            if (v is long) return (long)v;
            if (v is int) return (int)v;
            if (v is string) { long l; if (long.TryParse((string)v, out l)) return l; }
            return def;
        }

        private static bool ToBool(object v, bool def)
        {
            if (v is bool) return (bool)v;
            return def;
        }

        private static string EntryToJson(Entry e, int maxMessageChars, bool includeStack)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append("{\"seq\":").Append(e.seq)
                .Append(",\"firstSeq\":").Append(e.firstSeq)
                .Append(",\"unixMs\":").Append(e.unixMs)
                .Append(",\"type\":\"").Append(EscapeJson(e.type ?? "Log")).Append("\"")
                .Append(",\"level\":").Append(e.level)
                .Append(",\"message\":\"").Append(EscapeJson(TruncateString(e.message ?? "", maxMessageChars))).Append("\"");
            if (includeStack && e.level == 2 && !string.IsNullOrEmpty(e.stack))
            {
                sb.Append(",\"stack\":[");
                string[] lines = e.stack.Split('\n');
                for (int i = 0; i < lines.Length; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append("\"").Append(EscapeJson(lines[i])).Append("\"");
                }
                sb.Append(']');
            }
            sb.Append(",\"count\":").Append(e.count)
                .Append(",\"playMode\":").Append(e.playMode ? "true" : "false");
            if (!string.IsNullOrEmpty(e.file)) sb.Append(",\"file\":\"").Append(EscapeJson(e.file)).Append("\"");
            if (e.line > 0) sb.Append(",\"line\":").Append(e.line);
            sb.Append('}');
            return sb.ToString();
        }

        // Args: sinceSeq (default 0), mark, minLevel (default 0),
        // contains, playModeOnly, includeStack (default true),
        // maxEntries (default 30, hard max 100). The old shape's
        // "logType" still works: "Error" means minLevel 2,
        // "Warning" means minLevel 1. Entries come back
        // earliest-first, so the root cause survives truncation.
        // The response carries cursor, omitted, hiddenByFilter,
        // errorCount, warningCount and missedEvictedEntries, so
        // the caller knows what it did NOT see: errorCount and
        // warningCount are the totals for the window (before the
        // content filters, after sinceSeq); omitted is what passed
        // the filters but was cut by maxEntries.
        public static BridgeResult Read(string json, Dictionary<string, object> args)
        {
            var cmd = args;
            if (cmd == null) return BridgeResult.Error("Command JSON must be an object.");
            long sinceSeq = ToLong(NumField(cmd, "sinceSeq"), 0);
            bool mark = ToBool(NumField(cmd, "mark"), false);
            long minLevelRaw = ToLong(NumField(cmd, "minLevel"), -1);
            string logType = JStr(cmd, "logType", "");
            int minLevel;
            if (minLevelRaw >= 0) minLevel = (int)Math.Min(minLevelRaw, 2);
            else if (!string.IsNullOrEmpty(logType) && logType.Equals("Error", StringComparison.OrdinalIgnoreCase)) minLevel = 2;
            else if (!string.IsNullOrEmpty(logType) && logType.Equals("Warning", StringComparison.OrdinalIgnoreCase)) minLevel = 1;
            else if (!string.IsNullOrEmpty(logType)) return BridgeResult.Error("readConsole logType must be \"Error\" or \"Warning\" — never \"All\". Ask for Error first, then Warning separately.");
            else minLevel = 0;
            string contains = JStr(cmd, "contains", "");
            bool playModeOnly = ToBool(NumField(cmd, "playModeOnly"), false);
            bool includeStack = ToBool(NumField(cmd, "includeStack"), true);
            int maxEntries = (int)ToLong(NumField(cmd, "maxEntries"), 30);
            if (maxEntries < 1) maxEntries = 1;
            if (maxEntries > 100) maxEntries = 100;

            long cursor;
            Entry[] snapshot;
            long evicted;
            lock (_lock)
            {
                cursor = _nextSeq;
                snapshot = _entries.ToArray();
                evicted = _evictedTotal;
            }
            if (mark)
            {
                return BridgeResult.Ok("Console marked at seq " + cursor + ".", null,
                    "{\"cursor\":" + cursor + ",\"marked\":true}");
            }

            long oldestSeq = snapshot.Length > 0 ? snapshot[0].seq : cursor;
            long missed = sinceSeq < oldestSeq ? Math.Min(oldestSeq - sinceSeq, evicted) : 0;
            int errorCount = 0;
            int warningCount = 0;
            int hiddenByFilter = 0;
            var shown = new List<Entry>();
            int omitted = 0;
            foreach (Entry e in snapshot)
            {
                if (e.seq < sinceSeq) continue;
                if (e.level == 2) errorCount++;
                else if (e.level == 1) warningCount++;
                if (e.level < minLevel) { hiddenByFilter++; continue; }
                if (playModeOnly && !e.playMode) { hiddenByFilter++; continue; }
                if (!string.IsNullOrEmpty(contains) && e.message.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0) { hiddenByFilter++; continue; }
                if (shown.Count >= maxEntries) { omitted++; continue; }
                shown.Add(e);
            }
            var sb = new System.Text.StringBuilder();
            sb.Append("{\"cursor\":").Append(cursor)
                .Append(",\"entries\":[");
            for (int i = 0; i < shown.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(EntryToJson(shown[i], MaxMessageChars, includeStack));
            }
            sb.Append("],\"returned\":").Append(shown.Count)
                .Append(",\"omitted\":").Append(omitted)
                .Append(",\"hiddenByFilter\":").Append(hiddenByFilter)
                .Append(",\"errorCount\":").Append(errorCount)
                .Append(",\"warningCount\":").Append(warningCount)
                .Append(",\"missedEvictedEntries\":").Append(missed)
                .Append('}');
            string message = shown.Count == 0
                ? "Console: no new entries since seq " + sinceSeq + "."
                : "Console: " + shown.Count + " entr" + (shown.Count == 1 ? "y" : "ies") + " since seq " + sinceSeq
                    + " (" + errorCount + " error" + (errorCount == 1 ? "" : "s") + ", " + warningCount + " warning" + (warningCount == 1 ? "" : "s") + ")"
                    + (omitted > 0 ? " — " + omitted + " more omitted, ask for fewer with maxEntries." : "")
                    + (missed > 0 ? " — " + missed + " older entries were evicted from the buffer; the full log is in Editor.log." : "");
            return BridgeResult.Ok(message, null, sb.ToString());
        }

        // The next sequence number — a cursor a caller can mark
        // before a run and read from afterwards. Used by the
        // play-mode report, which records the cursor when the game
        // starts and summarizes everything logged since.
        public static long CurrentCursor()
        {
            lock (_lock) { return _nextSeq; }
        }

        // A compact summary of everything logged since a cursor:
        // how many error entries (and how many times they
        // recurred), how many warnings, and the first few error
        // messages. An entry that recurs after the cursor counts —
        // its sequence number is the latest occurrence.
        public static void SummarySince(long sinceSeq, out int errorCount, out int errorOccurrences, out int warningCount, out List<string> firstErrors)
        {
            errorCount = 0;
            errorOccurrences = 0;
            warningCount = 0;
            firstErrors = new List<string>();
            Entry[] snapshot;
            lock (_lock) { snapshot = _entries.ToArray(); }
            foreach (Entry e in snapshot)
            {
                if (e.seq < sinceSeq) continue;
                if (e.level == 2)
                {
                    errorCount++;
                    errorOccurrences += e.count;
                    if (firstErrors.Count < 5) firstErrors.Add(TruncateString(e.message, 200));
                }
                else if (e.level == 1) warningCount++;
            }
        }
    }

    // The refresh action is a handler like any other now — the
    // dispatcher calls it with the raw JSON (unused here).
    private static BridgeResult Refresh(string json)
    {
        AssetDatabase.Refresh();
        return BridgeResult.Ok("AssetDatabase refreshed.");
    }

    private static BridgeResult CreateAnimatorController(string json)
    {
        CFCommand cmd;
        try { cmd = JsonUtility.FromJson<CFCommand>(json); }
        catch (Exception e) { return BridgeResult.Error("Could not parse command JSON: " + e.Message); }
        if (cmd == null) return BridgeResult.Error("Command JSON has no action.");
        string name = string.IsNullOrEmpty(cmd.name) ? "NewController" : cmd.name;
        string assetPath = name.EndsWith(".controller") ? "Assets/" + name : "Assets/" + name + ".controller";
        // NOTE (v0.5.1): CreateAnimatorControllerAtPath only has a
        // 1-argument overload — CreateAnimatorControllerAtPath(string
        // path) — in every Unity version (2021–2023 LTS and newer).
        // There is no 2-argument overload, so passing a layer count
        // here fails to compile (CS1501). The 1-argument call already
        // creates the controller with a single default "Base Layer",
        // which is the 1 layer the old call was asking for.
        var controller = AnimatorController.CreateAnimatorControllerAtPath(assetPath);
        if (controller == null)
            return BridgeResult.Error("Could not create Animator Controller at " + assetPath);

        if (cmd.parameters != null)
        {
            foreach (var p in cmd.parameters)
            {
                AnimatorControllerParameterType type = AnimatorControllerParameterType.Bool;
                switch ((p.type ?? "Bool").Trim().ToLowerInvariant())
                {
                    case "float": type = AnimatorControllerParameterType.Float; break;
                    case "int": type = AnimatorControllerParameterType.Int; break;
                    case "trigger": type = AnimatorControllerParameterType.Trigger; break;
                    default: type = AnimatorControllerParameterType.Bool; break;
                }
                controller.AddParameter(p.name, type);
            }
        }

        var layer = controller.layers[0];
        var stateMachine = layer.stateMachine;
        if (cmd.states != null)
        {
            foreach (var st in cmd.states)
            {
                var state = stateMachine.AddState(st.name);
                state.speed = st.speed > 0 ? st.speed : 1f;
                if (!string.IsNullOrEmpty(st.motion))
                {
                    Motion motion = AssetDatabase.LoadAssetAtPath<Motion>(st.motion);
                    if (motion == null)
                    {
                        string[] guids = AssetDatabase.FindAssets(Path.GetFileNameWithoutExtension(st.motion) + " t:AnimationClip");
                        if (guids.Length > 0)
                            motion = AssetDatabase.LoadAssetAtPath<Motion>(AssetDatabase.GUIDToAssetPath(guids[0]));
                    }
                    if (motion != null) state.motion = motion;
                    else Debug.LogWarning("[CodeFox] Motion not found, state created without motion: " + st.motion);
                }
            }
        }
        if (cmd.transitions != null)
        {
            foreach (var tr in cmd.transitions)
            {
                AnimatorState from = FindState(stateMachine, tr.from);
                AnimatorState to = FindState(stateMachine, tr.to);
                if (from == null || to == null)
                {
                    Debug.LogWarning("[CodeFox] Transition skipped, state not found: " + tr.from + " -> " + tr.to);
                    continue;
                }
                var transition = from.AddTransition(to);
                transition.hasExitTime = false;
                if (!string.IsNullOrEmpty(tr.parameter))
                {
                    AnimatorControllerParameter param = null;
                    foreach (var cp in controller.parameters)
                        if (cp.name == tr.parameter) { param = cp; break; }
                    if (param != null)
                    {
                        AnimatorConditionMode mode = AnimatorConditionMode.If;
                        string cond = (tr.condition ?? "").Trim();
                        if (param.type == AnimatorControllerParameterType.Float || param.type == AnimatorControllerParameterType.Int)
                        {
                            if (cond == "Less") mode = AnimatorConditionMode.Less;
                            else if (cond == "Equals") mode = AnimatorConditionMode.Equals;
                            else if (cond == "NotEqual") mode = AnimatorConditionMode.NotEqual;
                            else mode = AnimatorConditionMode.Greater;
                            transition.AddCondition(mode, 0.1f, tr.parameter);
                        }
                        else
                        {
                            if (cond == "IfNot") mode = AnimatorConditionMode.IfNot;
                            else mode = AnimatorConditionMode.If;
                            transition.AddCondition(mode, 0f, tr.parameter);
                        }
                    }
                }
            }
        }

        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        return BridgeResult.Ok("Animator Controller created.", assetPath);
    }

    private static AnimatorState FindState(AnimatorStateMachine sm, string name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        foreach (var child in sm.states)
            if (child.state != null && child.state.name == name) return child.state;
        return null;
    }

    private static BridgeResult CreateUICanvas(string json)
    {
        CFCommand cmd;
        try { cmd = JsonUtility.FromJson<CFCommand>(json); }
        catch (Exception e) { return BridgeResult.Error("Could not parse command JSON: " + e.Message); }
        if (cmd == null) return BridgeResult.Error("Command JSON has no action.");
        string name = string.IsNullOrEmpty(cmd.name) ? "Canvas" : cmd.name;
        var canvasGO = new GameObject(name);
        Undo.RegisterCreatedObjectUndo(canvasGO, "Create CodeFox Canvas");
        var canvas = canvasGO.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvasGO.AddComponent<CanvasScaler>();
        canvasGO.AddComponent<GraphicRaycaster>();

        if (cmd.elements != null)
        {
            foreach (var el in cmd.elements)
            {
                try { CreateUIElement(canvasGO.transform, el); }
                catch (Exception e) { Debug.LogWarning("[CodeFox] UI element skipped (" + el.name + "): " + e.Message); }
            }
        }

        AssetDatabase.Refresh();
        return BridgeResult.Ok("UI Canvas created: " + name, name);
    }

    private static void CreateUIElement(Transform parent, CFElement el)
    {
        var go = new GameObject(string.IsNullOrEmpty(el.name) ? (el.type ?? "Element") : el.name);
        Undo.RegisterCreatedObjectUndo(go, "Create CodeFox UI element");
        go.transform.SetParent(parent, false);
        var rt = go.AddComponent<RectTransform>();
        ParseRect(el.rect, rt);
        string type = (el.type ?? "Panel").Trim().ToLowerInvariant();
        switch (type)
        {
            case "text":
                var text = go.AddComponent<Text>();
                text.text = el.text ?? "";
                text.fontSize = 24;
                text.color = Color.white;
                text.alignment = TextAnchor.MiddleCenter;
                break;
            case "button":
                go.AddComponent<Image>().color = new Color(0.85f, 0.85f, 0.85f);
                go.AddComponent<Button>();
                var labelGO = new GameObject("Text");
                Undo.RegisterCreatedObjectUndo(labelGO, "Create CodeFox UI element");
                labelGO.transform.SetParent(go.transform, false);
                var labelRT = labelGO.AddComponent<RectTransform>();
                labelRT.anchorMin = Vector2.zero; labelRT.anchorMax = Vector2.one;
                labelRT.offsetMin = Vector2.zero; labelRT.offsetMax = Vector2.zero;
                var label = labelGO.AddComponent<Text>();
                label.text = el.text ?? "Button";
                label.fontSize = 18;
                label.color = Color.black;
                label.alignment = TextAnchor.MiddleCenter;
                break;
            case "image":
                go.AddComponent<Image>().color = Color.white;
                break;
            default: // Panel
                go.AddComponent<Image>().color = new Color(0.2f, 0.2f, 0.2f, 0.8f);
                break;
        }
    }

    private static void ParseRect(string rect, RectTransform rt)
    {
        // "x,y,width,height" — anchored position + size, centred anchor.
        float x = 0, y = 0, w = 200, h = 60;
        if (!string.IsNullOrEmpty(rect))
        {
            string[] parts = rect.Split(',');
            float.TryParse(parts.Length > 0 ? parts[0] : "0", out x);
            float.TryParse(parts.Length > 1 ? parts[1] : "0", out y);
            float.TryParse(parts.Length > 2 ? parts[2] : "200", out w);
            float.TryParse(parts.Length > 3 ? parts[3] : "60", out h);
        }
        rt.anchorMin = new Vector2(0.5f, 0.5f);
        rt.anchorMax = new Vector2(0.5f, 0.5f);
        rt.anchoredPosition = new Vector2(x, y);
        rt.sizeDelta = new Vector2(w, h);
    }

    // ── Prefabs through Unity's own API (v0.9.0) ────────────────
    // CodeFox never hand-writes .prefab YAML: the model invented
    // script guids, a YAML node literally named "Image:", Button
    // fields on an Image, and no CanvasRenderer. These actions build
    // the GameObject tree with AddComponent and let Unity write the
    // file (PrefabUtility.SaveAsPrefabAsset), so a component that
    // does not exist in this install cannot be written at all.
    //
    // JsonUtility cannot parse the nested command shapes these
    // actions need (components with arbitrary props), so they parse
    // the raw JSON with the small parser below instead. The existing
    // actions keep their JsonUtility path, byte for byte.

    // Serialize a plain value tree (null, string, bool, numbers,
    // List<object>, Dictionary<string, object>) to JSON. Handlers
    // build their `data` as values and splice the result verbatim
    // into the outbox file — this is the writer that makes that
    // possible without a JSON library. Any other enumerable is
    // written as an array; anything else falls back to its
    // ToString, escaped. Non-finite numbers (NaN, Infinity — a
    // live float can be either) are written as strings, because
    // "R" would emit bare NaN / Infinity, which is not JSON.
    private static string JsonWrite(object v)
    {
        if (v == null) return "null";
        if (v is string) return "\"" + EscapeJson((string)v) + "\"";
        if (v is bool) return (bool)v ? "true" : "false";
        if (v is double)
        {
            double d = (double)v;
            if (double.IsNaN(d) || double.IsInfinity(d)) return "\"" + d.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"";
            return d.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        }
        if (v is float)
        {
            float f = (float)v;
            if (float.IsNaN(f) || float.IsInfinity(f)) return "\"" + f.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\"";
            return f.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        }
        if (v is int) return ((int)v).ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (v is long) return ((long)v).ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (v is Dictionary<string, object>)
        {
            var dict = (Dictionary<string, object>)v;
            var sb = new System.Text.StringBuilder("{");
            bool first = true;
            foreach (var kv in dict)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append("\"").Append(EscapeJson(kv.Key)).Append("\":").Append(JsonWrite(kv.Value));
            }
            sb.Append('}');
            return sb.ToString();
        }
        if (v is System.Collections.IEnumerable)
        {
            var sb = new System.Text.StringBuilder("[");
            bool first = true;
            foreach (object item in (System.Collections.IEnumerable)v)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append(JsonWrite(item));
            }
            sb.Append(']');
            return sb.ToString();
        }
        return "\"" + EscapeJson(v.ToString()) + "\"";
    }

    // Minimal JSON parser: objects → Dictionary<string, object>,
    // arrays → List<object>, numbers → double, plus string / bool /
    // null. Throws FormatException on bad input.
    private static class JsonMini
    {
        public static object Parse(string s)
        {
            var p = new Parser(s);
            p.SkipWs();
            object v = p.ParseValue();
            p.SkipWs();
            if (p.Pos < s.Length) throw new FormatException("Unexpected content after JSON value at " + p.Pos + ".");
            return v;
        }

        private class Parser
        {
            private readonly string _s;
            public int Pos;
            public Parser(string s) { _s = s; Pos = 0; }
            public void SkipWs() { while (Pos < _s.Length && char.IsWhiteSpace(_s[Pos])) Pos++; }

            public object ParseValue()
            {
                SkipWs();
                if (Pos >= _s.Length) throw new FormatException("Unexpected end of JSON.");
                char c = _s[Pos];
                if (c == '{') return ParseObject();
                if (c == '[') return ParseArray();
                if (c == '"') return ParseString();
                if (c == 't') { Expect("true"); return true; }
                if (c == 'f') { Expect("false"); return false; }
                if (c == 'n') { Expect("null"); return null; }
                return ParseNumber();
            }

            private void Expect(string lit)
            {
                if (Pos + lit.Length > _s.Length || _s.Substring(Pos, lit.Length) != lit)
                    throw new FormatException("Expected '" + lit + "' at " + Pos + ".");
                Pos += lit.Length;
            }

            private Dictionary<string, object> ParseObject()
            {
                var d = new Dictionary<string, object>();
                Pos++; // {
                SkipWs();
                if (Pos < _s.Length && _s[Pos] == '}') { Pos++; return d; }
                while (true)
                {
                    SkipWs();
                    string key = ParseString();
                    SkipWs();
                    if (Pos >= _s.Length || _s[Pos] != ':') throw new FormatException("Expected ':' at " + Pos + ".");
                    Pos++;
                    d[key] = ParseValue();
                    SkipWs();
                    if (Pos >= _s.Length) throw new FormatException("Unexpected end of JSON object.");
                    if (_s[Pos] == ',') { Pos++; continue; }
                    if (_s[Pos] == '}') { Pos++; return d; }
                    throw new FormatException("Expected ',' or '}' at " + Pos + ".");
                }
            }

            private List<object> ParseArray()
            {
                var list = new List<object>();
                Pos++; // [
                SkipWs();
                if (Pos < _s.Length && _s[Pos] == ']') { Pos++; return list; }
                while (true)
                {
                    list.Add(ParseValue());
                    SkipWs();
                    if (Pos >= _s.Length) throw new FormatException("Unexpected end of JSON array.");
                    if (_s[Pos] == ',') { Pos++; continue; }
                    if (_s[Pos] == ']') { Pos++; return list; }
                    throw new FormatException("Expected ',' or ']' at " + Pos + ".");
                }
            }

            private string ParseString()
            {
                if (Pos >= _s.Length || _s[Pos] != '"') throw new FormatException("Expected string at " + Pos + ".");
                Pos++;
                var sb = new System.Text.StringBuilder();
                while (Pos < _s.Length)
                {
                    char c = _s[Pos++];
                    if (c == '"') return sb.ToString();
                    if (c == '\\')
                    {
                        if (Pos >= _s.Length) break;
                        char e = _s[Pos++];
                        switch (e)
                        {
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case '/': sb.Append('/'); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            case 'u':
                                if (Pos + 4 <= _s.Length) { sb.Append((char)Convert.ToInt32(_s.Substring(Pos, 4), 16)); Pos += 4; }
                                break;
                            default: sb.Append(e); break;
                        }
                    }
                    else sb.Append(c);
                }
                throw new FormatException("Unterminated string in JSON.");
            }

            private object ParseNumber()
            {
                int start = Pos;
                if (Pos < _s.Length && _s[Pos] == '-') Pos++;
                while (Pos < _s.Length && (char.IsDigit(_s[Pos]) || _s[Pos] == '.' || _s[Pos] == 'e' || _s[Pos] == 'E' || _s[Pos] == '+' || _s[Pos] == '-')) Pos++;
                string num = _s.Substring(start, Pos - start);
                double d;
                if (double.TryParse(num, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d)) return d;
                throw new FormatException("Invalid number '" + num + "'.");
            }
        }
    }

    private static string JStr(Dictionary<string, object> d, string key, string def)
    {
        object v;
        if (d == null || !d.TryGetValue(key, out v) || v == null) return def;
        if (v is string) return (string)v;
        return v.ToString();
    }

    private static Dictionary<string, object> JObj(Dictionary<string, object> d, string key)
    {
        object v;
        if (d != null && d.TryGetValue(key, out v)) return v as Dictionary<string, object>;
        return null;
    }

    private static List<object> JArr(Dictionary<string, object> d, string key)
    {
        object v;
        if (d != null && d.TryGetValue(key, out v)) return v as List<object>;
        return null;
    }

    private static double JNum(Dictionary<string, object> d, string key, double def)
    {
        object v;
        if (d == null || !d.TryGetValue(key, out v) || v == null) return def;
        if (v is double) return (double)v;
        if (v is string)
        {
            double f;
            if (double.TryParse((string)v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out f)) return f;
        }
        return def;
    }

    private static bool JBool(Dictionary<string, object> d, string key, bool def)
    {
        object v;
        if (d != null && d.TryGetValue(key, out v) && v is bool) return (bool)v;
        return def;
    }

    // Every non-abstract Component subclass in the loaded assemblies,
    // cached once per editor session: UnityEngine, UnityEngine.UI,
    // TMPro, every other UnityEngine.* module, and the project's own
    // Assembly-CSharp scripts. The cache is what lets the model ask
    // Unity what exists instead of guessing a type name.
    private static List<Type> _allComponentTypes;
    private static Dictionary<string, Type> _componentByName;
    private static Dictionary<string, Type> _componentByFullName;

    private static void EnsureComponentCache()
    {
        if (_allComponentTypes != null) return;
        _allComponentTypes = new List<Type>();
        _componentByName = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase);
        _componentByFullName = new Dictionary<string, Type>();
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type[] types = null;
            try { types = asm.GetTypes(); }
            catch (ReflectionTypeLoadException e) { types = e.Types; }
            catch { continue; }
            if (types == null) continue;
            foreach (var t in types)
            {
                if (t == null || !t.IsClass || t.IsAbstract) continue;
                if (!typeof(Component).IsAssignableFrom(t)) continue;
                _allComponentTypes.Add(t);
                if (!_componentByName.ContainsKey(t.Name)) _componentByName[t.Name] = t;
                if (!_componentByFullName.ContainsKey(t.FullName)) _componentByFullName[t.FullName] = t;
            }
        }
        _allComponentTypes.Sort((a, b) =>
        {
            int c = string.Compare(a.Name, b.Name, StringComparison.Ordinal);
            return c != 0 ? c : string.Compare(a.FullName, b.FullName, StringComparison.Ordinal);
        });
    }

    // Resolve a component type by simple name ("Image"), full name
    // ("UnityEngine.UI.Image"), or the common Unity prefixes. Never
    // guesses: null means the type is not in this Unity install.
    private static Type ResolveComponentType(string name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        EnsureComponentCache();
        string n = name.Trim();
        Type t;
        if (_componentByFullName.TryGetValue(n, out t)) return t;
        if (_componentByName.TryGetValue(n, out t)) return t;
        string[] prefixes = { "UnityEngine.", "UnityEngine.UI.", "TMPro.", "UnityEngine.EventSystems.", "UnityEngine.Rendering." };
        foreach (var p in prefixes)
        {
            t = Type.GetType(p + n);
            if (t != null && typeof(Component).IsAssignableFrom(t)) return t;
        }
        return null;
    }

    private static string UnknownTypeMessage(string typeName)
    {
        return "Unknown component type '" + typeName + "'. Use listComponentTypes to see what this Unity install has.";
    }

    private static float Num(object v)
    {
        if (v is double) return (float)(double)v;
        if (v is string)
        {
            float f;
            if (float.TryParse((string)v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out f)) return f;
        }
        return 0f;
    }

    private static string FriendlyTypeName(Type t)
    {
        if (t == typeof(int)) return "int";
        if (t == typeof(float)) return "float";
        if (t == typeof(double)) return "double";
        if (t == typeof(bool)) return "bool";
        if (t == typeof(string)) return "string";
        if (t == typeof(long)) return "long";
        if (t == typeof(void)) return "void";
        if (t.IsArray) return FriendlyTypeName(t.GetElementType()) + "[]";
        if (t.IsGenericType)
        {
            string name = t.Name;
            int tick = name.IndexOf('`');
            if (tick >= 0) name = name.Substring(0, tick);
            var args = t.GetGenericArguments();
            var parts = new string[args.Length];
            for (int i = 0; i < args.Length; i++) parts[i] = FriendlyTypeName(args[i]);
            return name + "<" + string.Join(", ", parts) + ">";
        }
        return t.Name;
    }

    // A '/'-separated child path inside a prefab ("Viewport/Content");
    // "" or "." is the root itself. Transform.Find only walks named
    // children, so a wrong path is a plain failure, never a guess.
    private static GameObject FindChild(GameObject root, string path)
    {
        if (root == null) return null;
        if (string.IsNullOrEmpty(path) || path == ".") return root;
        Transform t = root.transform.Find(path);
        return t != null ? t.gameObject : null;
    }

    // Convert one JSON value to the member's C# type. Strings,
    // numbers and bools are direct; arrays become Vector2 / Vector3
    // / Vector4 / Color / Rect; enums take a name ("Simple") or a
    // number; colours also take "#rrggbb(aa)". A string for a
    // Component (or Transform / GameObject) is a child path inside
    // the prefab — that is how a ScrollRect's viewport and content
    // are wired to the children by name. A string for an asset type
    // (Sprite, Material, Texture2D, Font, AudioClip…) is an asset
    // path that must start with Assets/ and must exist — a missing
    // asset fails the whole command, never a null reference.
    private static bool ConvertValue(object value, Type target, GameObject root, GameObject owner, out object result, out string error)
    {
        result = null; error = null;
        if (value == null)
        {
            if (!target.IsValueType || Nullable.GetUnderlyingType(target) != null) { result = null; return true; }
            error = "Cannot set a " + FriendlyTypeName(target) + " to null.";
            return false;
        }
        if (target == typeof(string)) { result = value.ToString(); return true; }
        if (target.IsEnum)
        {
            if (value is string)
            {
                try { result = Enum.Parse(target, (string)value, true); return true; }
                catch { error = "'" + value + "' is not a " + FriendlyTypeName(target) + " value."; return false; }
            }
            if (value is double) { result = Enum.ToObject(target, Convert.ToInt32((double)value)); return true; }
            error = "Cannot set a " + FriendlyTypeName(target) + " from this value.";
            return false;
        }
        if (target == typeof(bool))
        {
            if (value is bool) { result = value; return true; }
            error = "Expected true or false for a bool.";
            return false;
        }
        if (target == typeof(float) || target == typeof(double) || target == typeof(int) || target == typeof(long))
        {
            if (value is double)
            {
                double d = (double)value;
                if (target == typeof(float)) result = (float)d;
                else if (target == typeof(double)) result = d;
                else if (target == typeof(int)) result = (int)d;
                else result = (long)d;
                return true;
            }
            if (value is string)
            {
                double d;
                if (double.TryParse((string)value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d))
                {
                    if (target == typeof(float)) result = (float)d;
                    else if (target == typeof(double)) result = d;
                    else if (target == typeof(int)) result = (int)d;
                    else result = (long)d;
                    return true;
                }
            }
            error = "Expected a number for a " + FriendlyTypeName(target) + ".";
            return false;
        }
        if (value is List<object>)
        {
            var arr = (List<object>)value;
            if (target == typeof(Vector2) && arr.Count >= 2) { result = new Vector2(Num(arr[0]), Num(arr[1])); return true; }
            if (target == typeof(Vector3) && arr.Count >= 3) { result = new Vector3(Num(arr[0]), Num(arr[1]), Num(arr[2])); return true; }
            if (target == typeof(Vector4) && arr.Count >= 4) { result = new Vector4(Num(arr[0]), Num(arr[1]), Num(arr[2]), Num(arr[3])); return true; }
            if (target == typeof(Color) && arr.Count >= 3)
            {
                result = new Color(Num(arr[0]), Num(arr[1]), Num(arr[2]), arr.Count >= 4 ? Num(arr[3]) : 1f);
                return true;
            }
            if (target == typeof(Color32) && arr.Count >= 3)
            {
                result = new Color32((byte)Num(arr[0]), (byte)Num(arr[1]), (byte)Num(arr[2]), arr.Count >= 4 ? (byte)Num(arr[3]) : (byte)255);
                return true;
            }
            if (target == typeof(Rect) && arr.Count >= 4) { result = new Rect(Num(arr[0]), Num(arr[1]), Num(arr[2]), Num(arr[3])); return true; }
            error = "Cannot set a " + FriendlyTypeName(target) + " from an array of " + arr.Count + " values.";
            return false;
        }
        if (target == typeof(Color) && value is string)
        {
            Color c;
            if (ColorUtility.TryParseHtmlString((string)value, out c)) { result = c; return true; }
            error = "Could not parse '" + value + "' as a colour — use [r,g,b,a] or \"#rrggbb\".";
            return false;
        }
        if (typeof(UnityEngine.Object).IsAssignableFrom(target) && value is string)
        {
            string s = (string)value;
            if (typeof(Component).IsAssignableFrom(target))
            {
                GameObject go = FindChild(root, s) ?? (owner != null && owner.name == s ? owner : null);
                if (go == null) { error = "No GameObject named '" + s + "' under the prefab root to use as a " + FriendlyTypeName(target) + "."; return false; }
                Component found = go.GetComponent(target);
                if (found == null) { error = "GameObject '" + s + "' has no " + FriendlyTypeName(target) + " component."; return false; }
                result = found; return true;
            }
            if (target == typeof(GameObject))
            {
                GameObject go = FindChild(root, s) ?? (owner != null && owner.name == s ? owner : null);
                if (go == null) { error = "No GameObject named '" + s + "' under the prefab root."; return false; }
                result = go; return true;
            }
            if (target == typeof(Transform))
            {
                GameObject go = FindChild(root, s) ?? (owner != null && owner.name == s ? owner : null);
                if (go == null) { error = "No GameObject named '" + s + "' under the prefab root."; return false; }
                result = go.transform; return true;
            }
            if (!s.StartsWith("Assets/")) { error = "Asset paths must start with Assets/ — got '" + s + "'."; return false; }
            UnityEngine.Object asset = AssetDatabase.LoadAssetAtPath(s, target);
            if (asset == null) { error = "Asset not found: '" + s + "' — the file is not in this project."; return false; }
            result = asset; return true;
        }
        error = "Cannot set a " + FriendlyTypeName(target) + " from this value.";
        return false;
    }

    // Set one property or public field on a component, by name
    // (case-insensitive — Unity's own names are camelCase). Returns
    // false with a plain error when the member does not exist or the
    // value does not fit it.
    private static bool SetMember(Component comp, string name, object value, GameObject root, out string error)
    {
        error = null;
        Type t = comp.GetType();
        var prop = t.GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
        if (prop != null && prop.CanWrite)
        {
            object converted;
            if (!ConvertValue(value, prop.PropertyType, root, comp.gameObject, out converted, out error)) return false;
            try { prop.SetValue(comp, converted, null); return true; }
            catch (Exception e) { error = "Could not set " + t.Name + "." + prop.Name + ": " + e.Message; return false; }
        }
        var field = t.GetField(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
        if (field != null)
        {
            object converted;
            if (!ConvertValue(value, field.FieldType, root, comp.gameObject, out converted, out error)) return false;
            try { field.SetValue(comp, converted); return true; }
            catch (Exception e) { error = "Could not set " + t.Name + "." + field.Name + ": " + e.Message; return false; }
        }
        error = "No settable property or field named '" + name + "' on " + t.Name + ". Use describeComponent to see what can be set.";
        return false;
    }

    // One component added by the two-pass build below: the
    // GameObject it is on, the spec it came from, and the instance.
    // Keeping the triple together is what makes the second pass
    // set props on the right instance when a spec lists two
    // components of the same type.
    private class CreatedComponent
    {
        public GameObject go;
        public Dictionary<string, object> spec;
        public Component comp;
    }

    // Add the components in `specs` (list of {type, props}) to `go`
    // WITHOUT setting props. The created (go, spec, comp) triples
    // are appended to `created`, so the caller can set props in a
    // second pass — after the whole tree exists. That is what makes
    // a ScrollRect's viewport/content resolve to children declared
    // in the same command: props are only set once every GameObject
    // the command creates is in the tree (v0.9.3 — before this,
    // props were set while the tree was still being built, so a
    // root ScrollRect failed with "No GameObject named 'Viewport'"
    // even though the child was in the same command).
    private static string AddComponentsNoProps(GameObject go, List<object> specs, GameObject root, List<CreatedComponent> created)
    {
        if (specs == null) return null;
        foreach (var specObj in specs)
        {
            var spec = specObj as Dictionary<string, object>;
            if (spec == null) return "Each component must be an object like {\"type\": \"Image\", \"props\": {...}}.";
            string typeName = JStr(spec, "type", "");
            Type type = ResolveComponentType(typeName);
            if (type == null) return UnknownTypeMessage(typeName);
            Component comp;
            try { comp = go.AddComponent(type); }
            catch (Exception e) { return "Could not add " + type.Name + " to " + go.name + ": " + e.Message; }
            created.Add(new CreatedComponent { go = go, spec = spec, comp = comp });
            // An Image (or any Graphic) draws through a
            // CanvasRenderer — the editor adds one automatically, but
            // AddComponent does not. Its absence was one of the
            // hand-written prefab's bugs.
            if (comp is Graphic && go.GetComponent<CanvasRenderer>() == null)
                go.AddComponent<CanvasRenderer>();
        }
        return null;
    }

    // Set the props recorded by AddComponentsNoProps, in order.
    // Runs after the whole tree exists, so a prop that references
    // another object in the tree resolves against the complete
    // tree, not the half-built one.
    private static string SetComponentProps(List<CreatedComponent> created, GameObject root)
    {
        foreach (var c in created)
        {
            var props = JObj(c.spec, "props");
            if (props == null) continue;
            foreach (var kv in props)
            {
                string err;
                if (!SetMember(c.comp, kv.Key, kv.Value, root, out err)) return err;
            }
        }
        return null;
    }

    // Add the components in `specs` (list of {type, props}) to `go`.
    // Two passes, not one: components are added first, props are
    // set after — a prop that references another object in the tree
    // (ScrollRect.viewport → a child Viewport) only resolves once
    // that object exists. Returns null on success, or a plain
    // error message.
    private static string AddComponents(GameObject go, List<object> specs, GameObject root)
    {
        var created = new List<CreatedComponent>();
        string err = AddComponentsNoProps(go, specs, root, created);
        if (err != null) return err;
        return SetComponentProps(created, root);
    }

    // Build a GameObject subtree from a spec:
    // { name, components: [{type, props}], children: [spec, ...] }.
    // `treeRoot` is the prefab root — component references resolve
    // against it, not against the GameObject being built.
    // Two passes (v0.9.3): the whole structure is created first
    // (pass 1), props are set second (pass 2), so a component's
    // props can reference any child in the tree, including ones
    // declared after it in the same command. Returns null on
    // success, or a plain error message.
    private static string BuildTree(GameObject go, Dictionary<string, object> spec, GameObject treeRoot)
    {
        var created = new List<CreatedComponent>();
        string err = BuildTreeStructure(go, spec, treeRoot, created);
        if (err != null) return err;
        return SetComponentProps(created, treeRoot);
    }

    // Pass 1 of BuildTree: create every GameObject in the subtree
    // and add every component (no props yet), recording each
    // created component so pass 2 can set its props.
    private static string BuildTreeStructure(GameObject go, Dictionary<string, object> spec, GameObject treeRoot, List<CreatedComponent> created)
    {
        string err = AddComponentsNoProps(go, JArr(spec, "components"), treeRoot, created);
        if (err != null) return err;
        var children = JArr(spec, "children");
        if (children == null) return null;
        foreach (var childObj in children)
        {
            var childSpec = childObj as Dictionary<string, object>;
            if (childSpec == null) return "Each child must be an object like {\"name\": \"Title\", \"components\": [...]}.";
            string childName = JStr(childSpec, "name", "");
            if (string.IsNullOrEmpty(childName)) return "Every child needs a \"name\".";
            var childGO = new GameObject(childName);
            childGO.transform.SetParent(go.transform, false);
            err = BuildTreeStructure(childGO, childSpec, treeRoot, created);
            if (err != null) return err;
        }
        return null;
    }

    private static BridgeResult CreatePrefab(string json, Dictionary<string, object> args)
    {
        var cmd = args;
        if (cmd == null) return BridgeResult.Error("Command JSON must be an object.");
        string name = JStr(cmd, "name", "");
        if (string.IsNullOrEmpty(name)) return BridgeResult.Error("createPrefab needs a \"name\".");
        string assetPath = JStr(cmd, "path", "");
        if (string.IsNullOrEmpty(assetPath))
        {
            string file = name.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) ? name : name + ".prefab";
            assetPath = "Assets/Prefabs/" + file;
        }
        if (!assetPath.StartsWith("Assets/") || !assetPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
            return BridgeResult.Error("Prefab path must start with Assets/ and end with .prefab — got '" + assetPath + "'.");
        var rootSpec = JObj(cmd, "root");
        if (rootSpec == null) return BridgeResult.Error("createPrefab needs a \"root\" object with a name and components.");
        string rootName = JStr(rootSpec, "name", name);
        // Build the tree in the scene first, then save — if anything
        // fails, the scene copy is destroyed and no prefab file is
        // left half-written.
        GameObject rootGO = new GameObject(string.IsNullOrEmpty(rootName) ? name : rootName);
        try
        {
            string err = BuildTree(rootGO, rootSpec, rootGO);
            if (err != null) return BridgeResult.Error(err);
            string dir = Path.GetDirectoryName(assetPath);
            if (!string.IsNullOrEmpty(dir) && dir != "Assets")
            {
                // Relative to the project folder (Application.dataPath
                // is <project>/Assets). "Assets/".Length skips the
                // "Assets/" prefix; dir is at least "Assets/X" here
                // (assetPath was validated to start with Assets/),
                // so the substring is safe.
                string sub = dir.Substring("Assets/".Length).Replace('/', Path.DirectorySeparatorChar);
                string fullDir = Path.Combine(Application.dataPath, sub);
                if (!Directory.Exists(fullDir)) Directory.CreateDirectory(fullDir);
            }
            GameObject prefab = PrefabUtility.SaveAsPrefabAsset(rootGO, assetPath);
            if (prefab == null) return BridgeResult.Error("Unity could not save the prefab at " + assetPath + ".");
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return BridgeResult.Ok("Prefab created.", assetPath);
        }
        finally
        {
            // The scene copy is only scaffolding — the prefab asset
            // is the deliverable. Destroy it even on success.
            if (rootGO != null) { try { UnityEngine.Object.DestroyImmediate(rootGO); } catch { } }
        }
    }

    // Modify a prefab in place (v0.16.0: a snapshot-backed
    // transaction — the file is snapshotted before the edit, so
    // the whole turn can be undone from the sidebar; a dry run
    // loads, stages, and unloads without snapshotting or
    // saving). "ops" (v0.20.0) batches several edits to one
    // prefab in a single transaction — one snapshot, one
    // reimport — each op the same shape as the top-level call
    // (addChildren / add / remove / set). The summary lines are
    // real before/after facts from the staged edit, never
    // invented: they are what the approval bar shows.
    private static BridgeResult ModifyPrefab(string json, Dictionary<string, object> args)
    {
        var cmd = args;
        if (cmd == null) return BridgeResult.Error("Command JSON must be an object.");
        string assetPath = JStr(cmd, "path", "");
        if (string.IsNullOrEmpty(assetPath)) return BridgeResult.Error("modifyPrefab needs a \"path\" to the prefab.");
        bool dryRun = JBool(cmd, "dryRun", false);
        return PrefabTransactions.Transact(assetPath, cmd, (contents, summary) =>
        {
            var data = new Dictionary<string, object>();
            data["path"] = assetPath;
            var ops = JArr(cmd, "ops");
            if (ops != null)
            {
                foreach (var item in ops)
                {
                    var op = item as Dictionary<string, object>;
                    if (op == null) return new PrefabTransactions.EditOutcome { Error = "Each \"ops\" entry must be an object like {\"addChildren\": [...]}." };
                    string err = ApplyPrefabEdits(contents, op, summary);
                    if (err != null) return new PrefabTransactions.EditOutcome { Error = err };
                }
            }
            else
            {
                string err = ApplyPrefabEdits(contents, cmd, summary);
                if (err != null) return new PrefabTransactions.EditOutcome { Error = err };
            }
            string message = summary.Count > 0
                ? (dryRun ? "Preview: " : "") + "Prefab " + assetPath + ": " + string.Join("; ", summary.ToArray()) + (dryRun ? " (nothing changed yet)." : "")
                : "Prefab updated.";
            return new PrefabTransactions.EditOutcome { Message = message, Data = data };
        });
    }

    // Delete one asset (v0.9.3) — the answer to "delete the prefab".
    // AssetDatabase.DeleteAsset removes the file, its .meta, and
    // updates references; SaveAssets + Refresh make it stick. The
    // path must start with Assets/, must exist, and must not be the
    // Assets folder itself. The app snapshots the file (and .meta)
    // before sending this, so the delete can be reverted — the
    // bridge itself never restores anything.
    private static BridgeResult DeleteAsset(string json, Dictionary<string, object> args)
    {
        var cmd = args;
        if (cmd == null) return BridgeResult.Error("Command JSON must be an object.");
        string assetPath = JStr(cmd, "path", "");
        if (string.IsNullOrEmpty(assetPath)) return BridgeResult.Error("deleteAsset needs a \"path\" to the asset.");
        if (!assetPath.StartsWith("Assets/")) return BridgeResult.Error("deleteAsset path must start with Assets/ — got '" + assetPath + "'.");
        if (assetPath == "Assets/") return BridgeResult.Error("deleteAsset refuses to delete the Assets folder itself.");
        bool isFolder = AssetDatabase.IsValidFolder(assetPath);
        bool exists = isFolder || AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(assetPath) != null;
        if (!exists) return BridgeResult.Error("Asset not found: '" + assetPath + "' — the file is not in this project.");
        if (!AssetDatabase.DeleteAsset(assetPath)) return BridgeResult.Error("Unity could not delete " + assetPath + ".");
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        return BridgeResult.Ok("Asset deleted.", assetPath);
    }

    // addChildren / add / remove / set, in that order: children are
    // created before components are added to them, and components
    // are added before anything is set on them — so one call can
    // grow a prefab in place (add the Viewport/Content children,
    // then add a ScrollRect that references them). Returns null on
    // success, or a plain error naming the missing prefab object,
    // type, or property. The summary (v0.20.0) gets one line per
    // edit that actually happened — real facts from the staged
    // edit, never invented — so the approval bar can show the
    // diff before anything is saved. A line is only added after
    // its edit succeeded; a failure returns before saving, so a
    // half-built summary is never shown.
    private static string ApplyPrefabEdits(GameObject root, Dictionary<string, object> cmd, List<string> summary)
    {
        // addChildren (v0.9.3): create new child GameObjects under
        // an existing object, from the same tree specs createPrefab
        // uses — {name, components, children}. A child whose name
        // already exists under the parent is refused, so a later
        // reference to that name can never be ambiguous.
        var addChildren = JArr(cmd, "addChildren");
        if (addChildren != null)
        {
            foreach (var item in addChildren)
            {
                var entry = item as Dictionary<string, object>;
                if (entry == null) return "Each \"addChildren\" entry must be an object like {\"object\": \"\", \"children\": [...]}.";
                string objectPath = JStr(entry, "object", "");
                GameObject parent = FindChild(root, objectPath);
                if (parent == null) return "No object '" + objectPath + "' in the prefab.";
                var children = JArr(entry, "children");
                if (children == null) continue;
                foreach (var childObj in children)
                {
                    var childSpec = childObj as Dictionary<string, object>;
                    if (childSpec == null) return "Each child must be an object like {\"name\": \"Title\", \"components\": [...]}.";
                    string childName = JStr(childSpec, "name", "");
                    if (string.IsNullOrEmpty(childName)) return "Every child needs a \"name\".";
                    if (parent.transform.Find(childName) != null)
                        return "Object '" + (string.IsNullOrEmpty(objectPath) ? parent.name : objectPath) + "' already has a child named '" + childName + "'.";
                    var childGO = new GameObject(childName);
                    childGO.transform.SetParent(parent.transform, false);
                    string err = BuildTree(childGO, childSpec, root);
                    if (err != null) return err;
                    if (summary != null) summary.Add("add child '" + childName + "' under '" + (string.IsNullOrEmpty(objectPath) ? parent.name : objectPath) + "'");
                }
            }
        }
        var adds = JArr(cmd, "add");
        if (adds != null)
        {
            foreach (var item in adds)
            {
                var entry = item as Dictionary<string, object>;
                if (entry == null) return "Each \"add\" entry must be an object like {\"object\": \"\", \"components\": [...]}.";
                string objectPath = JStr(entry, "object", "");
                GameObject target = FindChild(root, objectPath);
                if (target == null) return "No object '" + objectPath + "' in the prefab.";
                string err = AddComponents(target, JArr(entry, "components"), root);
                if (err != null) return err;
                if (summary != null)
                {
                    var addedNames = new List<string>();
                    var compArr = JArr(entry, "components");
                    if (compArr != null)
                        foreach (var c in compArr)
                        {
                            var cObj = c as Dictionary<string, object>;
                            if (cObj != null) addedNames.Add(JStr(cObj, "type", "?"));
                        }
                    summary.Add("add " + string.Join(", ", addedNames.ToArray()) + " to '" + (string.IsNullOrEmpty(objectPath) ? target.name : objectPath) + "'");
                }
            }
        }
        var removes = JArr(cmd, "remove");
        if (removes != null)
        {
            foreach (var item in removes)
            {
                var entry = item as Dictionary<string, object>;
                if (entry == null) return "Each \"remove\" entry must be an object like {\"object\": \"\", \"components\": [\"Image\"]}.";
                string objectPath = JStr(entry, "object", "");
                GameObject target = FindChild(root, objectPath);
                if (target == null) return "No object '" + objectPath + "' in the prefab.";
                // "remove" takes either shape (v0.9.3): the
                // documented singular "component": "Image", or the
                // plural "components": ["Image", ...] the model
                // naturally emits, mirroring "add". Both at once is
                // allowed — every name listed is removed.
                var typeNames = new List<string>();
                string single = JStr(entry, "component", "");
                if (!string.IsNullOrEmpty(single)) typeNames.Add(single);
                var plural = JArr(entry, "components");
                if (plural != null)
                {
                    foreach (var t in plural)
                    {
                        string n = t as string;
                        if (n == null) return "Each \"components\" entry in \"remove\" must be a component type name, e.g. \"Image\".";
                        typeNames.Add(n);
                    }
                }
                if (typeNames.Count == 0) return "Each \"remove\" entry needs a \"component\" (\"Image\") or \"components\" ([\"Image\", ...]).";
                foreach (var typeName in typeNames)
                {
                    Type type = ResolveComponentType(typeName);
                    if (type == null) return UnknownTypeMessage(typeName);
                    Component comp = target.GetComponent(type);
                    if (comp == null) return "Object '" + (string.IsNullOrEmpty(objectPath) ? target.name : objectPath) + "' has no " + type.Name + " component.";
                    if (comp is Transform) return "The Transform cannot be removed.";
                    UnityEngine.Object.DestroyImmediate(comp);
                }
                if (summary != null) summary.Add("remove " + string.Join(", ", typeNames.ToArray()) + " from '" + (string.IsNullOrEmpty(objectPath) ? target.name : objectPath) + "'");
            }
        }
        var sets = JArr(cmd, "set");
        if (sets != null)
        {
            foreach (var item in sets)
            {
                var entry = item as Dictionary<string, object>;
                if (entry == null) return "Each \"set\" entry must be an object like {\"object\": \"\", \"component\": \"Image\", \"props\": {...}}.";
                string objectPath = JStr(entry, "object", "");
                GameObject target = FindChild(root, objectPath);
                if (target == null) return "No object '" + objectPath + "' in the prefab.";
                string typeName = JStr(entry, "component", "");
                Type type = ResolveComponentType(typeName);
                if (type == null) return UnknownTypeMessage(typeName);
                Component comp = target.GetComponent(type);
                if (comp == null) return "Object '" + (string.IsNullOrEmpty(objectPath) ? target.name : objectPath) + "' has no " + type.Name + " component.";
                var props = JObj(entry, "props");
                if (props != null)
                {
                    foreach (var kv in props)
                    {
                        string err;
                        if (!SetMember(comp, kv.Key, kv.Value, root, out err)) return err;
                    }
                    if (summary != null)
                    {
                        var propNames = new List<string>();
                        foreach (var kv in props) propNames.Add(kv.Key);
                        summary.Add("set " + type.Name + "." + string.Join(", ", propNames.ToArray()) + " on '" + (string.IsNullOrEmpty(objectPath) ? target.name : objectPath) + "'");
                    }
                }
            }
        }
        return null;
    }

    private static BridgeResult ListComponentTypes(string json, Dictionary<string, object> args)
    {
        var cmd = args;
        string filter = cmd != null ? JStr(cmd, "filter", "") : "";
        EnsureComponentCache();
        var matches = new List<Type>();
        foreach (var t in _allComponentTypes)
        {
            if (string.IsNullOrEmpty(filter) || t.Name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0)
                matches.Add(t);
        }
        int total = matches.Count;
        int shown = Math.Min(matches.Count, 500);
        var sb = new System.Text.StringBuilder();
        sb.Append("{\"total\":").Append(total).Append(",\"returned\":").Append(shown).Append(",\"types\":[");
        for (int i = 0; i < shown; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"name\":\"").Append(EscapeJson(matches[i].Name)).Append("\",\"fullName\":\"").Append(EscapeJson(matches[i].FullName)).Append("\"}");
        }
        sb.Append("]}");
        var result = BridgeResult.Ok(
            total + " component types" + (string.IsNullOrEmpty(filter) ? "" : " matching '" + filter + "'") + (total > shown ? " — showing the first " + shown + ", narrow the filter to see more." : "."),
            null, sb.ToString());
        return result;
    }

    private static BridgeResult DescribeComponent(string json, Dictionary<string, object> args)
    {
        var cmd = args;
        string typeName = cmd != null ? JStr(cmd, "type", "") : "";
        Type type = ResolveComponentType(typeName);
        if (type == null) return BridgeResult.Error(UnknownTypeMessage(typeName));
        var sb = new System.Text.StringBuilder();
        sb.Append("{\"name\":\"").Append(EscapeJson(type.Name)).Append("\",\"fullName\":\"").Append(EscapeJson(type.FullName)).Append("\",\"properties\":[");
        var seen = new HashSet<string>();
        bool first = true;
        // Walk the inheritance chain so Image shows Graphic's
        // properties (colour, raycast target, maskable) too, not
        // just its own. First occurrence wins — the most derived
        // declaration of a name.
        for (Type t = type; t != null && t != typeof(object); t = t.BaseType)
        {
            foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                if (!p.CanWrite) continue;
                if (p.GetIndexParameters().Length > 0) continue;
                if (!seen.Add(p.Name)) continue;
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"name\":\"").Append(EscapeJson(p.Name)).Append("\",\"type\":\"").Append(EscapeJson(FriendlyTypeName(p.PropertyType))).Append("\"}");
            }
        }
        sb.Append("],\"fields\":[");
        first = true;
        seen.Clear();
        for (Type t = type; t != null && t != typeof(object); t = t.BaseType)
        {
            foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                if (!seen.Add(f.Name)) continue;
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"name\":\"").Append(EscapeJson(f.Name)).Append("\",\"type\":\"").Append(EscapeJson(FriendlyTypeName(f.FieldType))).Append("\"}");
            }
        }
        sb.Append("]}");
        return BridgeResult.Ok(type.Name + " (" + type.FullName + ")", null, sb.ToString());
    }

    [MenuItem("CodeFox/Refresh")]
    private static void MenuRefresh()
    {
        AssetDatabase.Refresh();
        Debug.Log("[CodeFox] AssetDatabase refreshed.");
    }

    [MenuItem("CodeFox/Run EditMode Tests")]
    private static void MenuRunTests()
    {
        try
        {
            bool opened = EditorApplication.ExecuteMenuItem("Window/General/Test Runner");
            if (!opened)
                Debug.Log("[CodeFox] Could not open the Test Runner automatically. Open Window > General > Test Runner, select the EditMode tab, and click Run All.");
            else
                Debug.Log("[CodeFox] Test Runner opened — select the EditMode tab and click Run All.");
        }
        catch (Exception e)
        {
            Debug.Log("[CodeFox] Open Window > General > Test Runner and run the EditMode tests manually. (" + e.Message + ")");
        }
    }

    [MenuItem("CodeFox/Open Project Folder")]
    private static void MenuOpenProjectFolder()
    {
        EditorUtility.RevealInFinder(Application.dataPath);
    }

    // ── Path → object, shared by every action that reads a scene ──
    // read_component_values and the write actions (Build 6) all
    // resolve "Player/Arm/Hand" + a component name the same way,
    // so the lookup lives here once: roots from every loaded scene
    // (plus the DontDestroyOnLoad scene in Play Mode, found with a
    // short-lived probe — that scene has no other handle), inactive
    // children included (Transform.Find sees them), one match or an
    // error that says how to fix the path.
    private static class ComponentLocator
    {
        public static List<GameObject> FindGameObjects(string path)
        {
            var matches = new List<GameObject>();
            if (string.IsNullOrEmpty(path)) return matches;
            string[] segments = path.Split(new[] { '/' }, 2);
            foreach (GameObject root in EnumerateRoots())
            {
                if (root == null || root.name != segments[0]) continue;
                if (segments.Length == 1) { matches.Add(root); continue; }
                Transform child = root.transform.Find(segments[1]);
                if (child != null) matches.Add(child.gameObject);
            }
            return matches;
        }

        public static IEnumerable<GameObject> EnumerateRoots()
        {
            var roots = new List<GameObject>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded) continue;
                roots.AddRange(scene.GetRootGameObjects());
            }
            if (Application.isPlaying)
            {
                // The DontDestroyOnLoad scene has no handle except a
                // probe object: create one, read its scene, destroy
                // it again. The probe itself is filtered out.
                var probe = new GameObject("__codefox_probe");
                UnityEngine.Object.DontDestroyOnLoad(probe);
                foreach (GameObject root in probe.scene.GetRootGameObjects())
                    if (root != probe) roots.Add(root);
                UnityEngine.Object.DestroyImmediate(probe);
            }
            return roots;
        }

        public static bool TryResolve(Dictionary<string, object> args, out Component component, out string error)
        {
            component = null;
            string path = JStr(args, "path", "");
            string componentName = JStr(args, "component", "");
            if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(componentName))
            {
                error = "'path' and 'component' are required.";
                return false;
            }
            List<GameObject> matches = FindGameObjects(path);
            if (matches.Count != 1)
            {
                error = matches.Count == 0
                    ? "No GameObject at '" + path + "'. Start with the scene root name."
                    : matches.Count + " objects match '" + path + "'. Use a more specific path.";
                return false;
            }
            int index = (int)JNum(args, "componentIndex", 0);
            return TryResolveOn(matches[0], componentName, index, out component, out error);
        }

        // Resolve a component on a GameObject the caller already
        // has — the scene flow (via TryResolve) and the prefab
        // flow (the object lives inside loaded prefab contents,
        // not in any scene, so FindGameObjects cannot see it).
        public static bool TryResolveOn(GameObject go, string componentName, int index, out Component component, out string error)
        {
            component = null;
            var candidates = new List<Component>();
            foreach (Component c in go.GetComponents<Component>())
                if (c != null && string.Equals(c.GetType().Name, componentName, StringComparison.OrdinalIgnoreCase))
                    candidates.Add(c);
            if (candidates.Count == 0)
            {
                var available = new List<string>();
                foreach (Component c in go.GetComponents<Component>())
                    if (c != null) available.Add(c.GetType().Name);
                error = "No component '" + componentName + "' on '" + GetPath(go.transform) + "'. Available: " + string.Join(", ", available.ToArray()) + ".";
                return false;
            }
            component = candidates[Mathf.Clamp(index, 0, candidates.Count - 1)];
            error = null;
            return true;
        }

        public static string GetPath(Transform transform)
        {
            var names = new List<string>();
            for (Transform current = transform; current != null; current = current.parent)
                names.Add(current.name);
            names.Reverse();
            return string.Join("/", names.ToArray());
        }
    }

    // ── Play Mode ────────────────────────────────────────────────
    // Enter / exit Play Mode, optionally for a fixed time. Entering
    // usually reloads the domain, so — like the compile report —
    // all state lives in SessionState and the poll tick finalizes
    // the request. The report is the console since the run started:
    // the model only sees what the game logs, so the run's errors
    // and first error lines ARE the observation, plus a cursor for
    // readConsole when it needs the details.
    //
    // Phases: entering → (duration 0: report "still running" |
    // duration > 0: running) → exiting → settled edit. OnPlayMode-
    // StateChanged is the source of truth for what actually
    // happened; the timeouts are the backstop. A timed run exits
    // Play Mode at the end and the scene objects are destroyed —
    // values cannot be read after it, only the report.
    private static class PlayMode
    {
        private const string PendingIdKey = "CodeFox.PlayMode.PendingId";
        private const string PhaseKey = "CodeFox.PlayMode.Phase";
        private const string SettledStateKey = "CodeFox.PlayMode.SettledState";
        private const string StartCursorKey = "CodeFox.PlayMode.StartCursor";
        private const string RequestedAtKey = "CodeFox.PlayMode.RequestedAt";
        private const string RunningSinceKey = "CodeFox.PlayMode.RunningSince";
        private const string DurationKey = "CodeFox.PlayMode.Duration";
        private const string EndedByKey = "CodeFox.PlayMode.EndedBy";
        private const int EnterTimeoutSeconds = 60;
        private const int ExitTimeoutSeconds = 30;
        private const int MaxDurationSeconds = 120;

        public static void Initialize()
        {
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
            // A reload that landed back in Edit Mode while a change
            // was pending (exiting Play Mode reloads) settles the
            // state here; a reload that landed in Play Mode leaves
            // it alone — EnteredPlayMode fires next.
            if (HasPending() && !EditorApplication.isPlaying)
                SessionState.SetString(SettledStateKey, "edit");
        }

        public static BridgeResult Begin(string json, Dictionary<string, object> args)
        {
            string id = BridgeDispatcher.CurrentRequestId;
            if (string.IsNullOrEmpty(id)) return BridgeResult.Error("set_play_mode needs a request id.");
            string pending = SessionState.GetString(PendingIdKey, "");
            if (!string.IsNullOrEmpty(pending) && pending != id)
                return BridgeResult.Error("A play-mode change is already running (request " + pending + "). Wait for it to finish, then try again.");
            if (pending == id) return BridgeResult.Pending("Changing Play Mode…");
            if (!args.ContainsKey("enabled")) return BridgeResult.Error("'enabled' is required: true to enter Play Mode, false to leave it.");
            bool enabled = JBool(args, "enabled", false);
            double durationSeconds = JNum(args, "durationSeconds", 0);
            if (durationSeconds < 0) durationSeconds = 0;
            if (durationSeconds > MaxDurationSeconds) durationSeconds = MaxDurationSeconds;
            if (enabled && EditorApplication.isPlaying)
                return BridgeResult.Ok("Already in Play Mode.", null, ReportData("", 0, ConsoleBuffer.CurrentCursor()));
            if (!enabled && !EditorApplication.isPlaying)
                return BridgeResult.Ok("Already in Edit Mode.", null, ReportData("", 0, ConsoleBuffer.CurrentCursor()));
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
                return BridgeResult.Error("Unity is compiling — wait for the compile to finish, then try again.");
            if (CompileReport.HasPending())
                return BridgeResult.Error("A compile report is running — wait for it to finish, then try again.");
            if (enabled && EditorUtility.scriptCompilationFailed)
                return BridgeResult.Error("The project has compile errors — run recompile_and_report_errors first and fix them. Play Mode will not start while the project does not compile.");
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                return BridgeResult.Error("Play Mode is already changing state — wait a moment and try again.");

            SessionState.SetString(PendingIdKey, id);
            SessionState.SetString(PhaseKey, enabled ? "entering" : "exiting");
            SessionState.SetString(SettledStateKey, EditorApplication.isPlaying ? "play" : "edit");
            SessionState.SetLong(StartCursorKey, ConsoleBuffer.CurrentCursor());
            SessionState.SetLong(RequestedAtKey, UnixMs());
            SessionState.SetLong(RunningSinceKey, 0);
            SessionState.SetLong(DurationKey, (long)(durationSeconds * 1000));
            SessionState.SetString(EndedByKey, "");
            EditorApplication.isPlaying = enabled;
            return BridgeResult.Pending(enabled ? "Entering Play Mode…" : "Exiting Play Mode…");
        }

        public static bool HasPending()
        {
            return !string.IsNullOrEmpty(SessionState.GetString(PendingIdKey, ""));
        }

        public static bool IsPending(string id)
        {
            return !string.IsNullOrEmpty(id) && SessionState.GetString(PendingIdKey, "") == id;
        }

        // Called every poll tick. Returns true when the change is
        // final — the transport writes the result and deletes the
        // processing file.
        public static bool TryFinalize(out BridgeResult result, out string requestId)
        {
            result = null;
            requestId = null;
            string id = SessionState.GetString(PendingIdKey, "");
            if (string.IsNullOrEmpty(id)) return false;
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return false;

            string phase = SessionState.GetString(PhaseKey, "");
            string settled = SessionState.GetString(SettledStateKey, "");
            long requestedAt = SessionState.GetLong(RequestedAtKey, 0);
            long durationMs = SessionState.GetLong(DurationKey, 0);
            long runningSince = SessionState.GetLong(RunningSinceKey, 0);
            long startCursor = SessionState.GetLong(StartCursorKey, 0);
            string endedBy = SessionState.GetString(EndedByKey, "");
            long now = UnixMs();

            if (phase == "entering" && settled != "play" && requestedAt > 0 && now - requestedAt > EnterTimeoutSeconds * 1000)
            {
                ClearState();
                requestId = id;
                result = BridgeResult.Error("Timed out waiting for Play Mode to start (60s) — check Unity's Console for errors.");
                return true;
            }
            if (phase == "exiting" && settled != "edit" && requestedAt > 0 && now - requestedAt > ExitTimeoutSeconds * 1000)
            {
                ClearState();
                requestId = id;
                result = BridgeResult.Error("Timed out waiting for Play Mode to stop (30s).");
                return true;
            }
            if (phase == "entering" && settled == "play")
            {
                if (durationMs <= 0)
                {
                    // No duration: the game stays running and the
                    // model reads live state, then stops it itself.
                    ClearState();
                    requestId = id;
                    result = BridgeResult.Ok("In Play Mode (still running) — " + ConsoleSummaryText(startCursor) + " Stop it with set_play_mode {\"enabled\": false} when done.", null, ReportData("", 0, startCursor));
                    return true;
                }
                SessionState.SetString(PhaseKey, "running");
                SessionState.SetLong(RunningSinceKey, now);
                phase = "running";
                runningSince = now;
            }
            if (phase == "running")
            {
                if (settled == "edit")
                {
                    long played = runningSince > 0 ? (now - runningSince) / 1000 : 0;
                    ClearState();
                    requestId = id;
                    result = BridgeResult.Ok("Play Mode run finished (stopped early) — played " + played + "s, " + ConsoleSummaryText(startCursor), null, ReportData(string.IsNullOrEmpty(endedBy) ? "stopped early" : endedBy, played, startCursor));
                    return true;
                }
                if (durationMs > 0 && runningSince > 0 && now - runningSince >= durationMs)
                {
                    SessionState.SetString(PhaseKey, "exiting");
                    SessionState.SetString(EndedByKey, "duration elapsed");
                    EditorApplication.isPlaying = false;
                    return false;
                }
                return false;
            }
            if (phase == "exiting" && settled == "edit")
            {
                long played = runningSince > 0 ? (now - runningSince) / 1000 : 0;
                if (string.IsNullOrEmpty(endedBy)) endedBy = "stopped";
                ClearState();
                requestId = id;
                result = BridgeResult.Ok("Play Mode run finished (" + endedBy + ") — played " + played + "s, " + ConsoleSummaryText(startCursor), null, ReportData(endedBy, played, startCursor));
                return true;
            }
            return false;
        }

        private static void ClearState()
        {
            SessionState.SetString(PendingIdKey, "");
            SessionState.SetString(PhaseKey, "");
            SessionState.SetString(SettledStateKey, "");
            SessionState.SetLong(StartCursorKey, 0);
            SessionState.SetLong(RequestedAtKey, 0);
            SessionState.SetLong(RunningSinceKey, 0);
            SessionState.SetLong(DurationKey, 0);
            SessionState.SetString(EndedByKey, "");
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            if (state == PlayModeStateChange.EnteredPlayMode) SessionState.SetString(SettledStateKey, "play");
            else if (state == PlayModeStateChange.EnteredEditMode) SessionState.SetString(SettledStateKey, "edit");
        }

        private static string ConsoleSummaryText(long startCursor)
        {
            int errorCount;
            int errorOccurrences;
            int warningCount;
            List<string> firstErrors;
            ConsoleBuffer.SummarySince(startCursor, out errorCount, out errorOccurrences, out warningCount, out firstErrors);
            return errorCount + " error" + (errorCount == 1 ? "" : "s") + " (" + errorOccurrences + " occurrence" + (errorOccurrences == 1 ? "" : "s") + "), " + warningCount + " warning" + (warningCount == 1 ? "" : "s") + " since the run started.";
        }

        private static string ReportData(string endedBy, long playedSeconds, long startCursor)
        {
            int errorCount;
            int errorOccurrences;
            int warningCount;
            List<string> firstErrors;
            ConsoleBuffer.SummarySince(startCursor, out errorCount, out errorOccurrences, out warningCount, out firstErrors);
            var data = new Dictionary<string, object>();
            data["playing"] = EditorApplication.isPlaying;
            data["endedBy"] = endedBy;
            data["playedSeconds"] = playedSeconds;
            data["errorCount"] = errorCount;
            data["errorOccurrences"] = errorOccurrences;
            data["warningCount"] = warningCount;
            data["firstErrors"] = firstErrors;
            data["startCursor"] = startCursor;
            data["hint"] = "Use read_console with sinceSeq=" + startCursor + " for full details.";
            return JsonWrite(data);
        }

        private static long UnixMs()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
    }

    // ── Reading live values off a scene object ───────────────────
    // Two modes, because SerializedObject only exposes serialized
    // data and the runtime values the model actually wants to test
    // (a Rigidbody's velocity, a Transform's world position, a
    // private currentHealth) are not in it:
    //   (1) serialized properties — Inspector-visible fields
    //       (public or [SerializeField]), live values in Play Mode,
    //       no names needed up front;
    //   (2) runtime members — properties / fields named explicitly,
    //       read by reflection.
    // Read-only: writing is a separate action with approval and
    // undo (Build 6). Output is bounded — 40 properties by
    // default, 100 hard max, collection items 8, nesting depth 2,
    // strings 200 chars, floats to 3 decimals — and truncation
    // returns omitted + available names, so the model can ask for
    // specific ones next. Values are converted to plain JSON first:
    // a raw Vector3 can recurse through `normalized` and throw.
    // renderer.material / meshFilter.mesh instantiate a copy of the
    // asset every time they are read (and leak it), so those
    // members are refused and the shared* versions named instead.
    private static class ReadComponentValuesHandler
    {
        private const int DefaultMaxProperties = 40;
        private const int HardMaxProperties = 100;
        private const int MaxCollectionItems = 8;
        private const int MaxDepth = 2;
        private const int MaxStringChars = 200;
        private const int MaxMemberSuggestions = 8;
        private static readonly string[] NoiseProperties = { "m_Script", "m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset", "m_GameObject", "m_EditorHideFlags", "m_EditorClassIdentifier" };
        private static readonly string[] DeniedMembers = { "material", "materials", "mesh" };

        public static BridgeResult Handle(string json, Dictionary<string, object> args)
        {
            string path = JStr(args, "path", "");
            if (string.IsNullOrEmpty(path)) return BridgeResult.Error("'path' is required.");
            List<GameObject> matches = ComponentLocator.FindGameObjects(path);
            if (matches.Count != 1)
                return BridgeResult.Error(matches.Count == 0
                    ? "No GameObject at '" + path + "'. Start with the scene root name."
                    : matches.Count + " objects match '" + path + "'. Use a more specific path.");
            GameObject target = matches[0];
            string componentName = JStr(args, "component", "");
            if (string.IsNullOrEmpty(componentName))
            {
                // Discovery: what is on this object, and what is
                // under it — a model that cannot see the scene tree
                // has to guess paths.
                var compNames = new List<string>();
                foreach (Component c in target.GetComponents<Component>())
                    if (c != null) compNames.Add(c.GetType().Name);
                var children = new List<string>();
                foreach (Transform child in target.transform)
                    children.Add(ComponentLocator.GetPath(child));
                var discovery = new Dictionary<string, object>();
                discovery["path"] = ComponentLocator.GetPath(target.transform);
                discovery["components"] = compNames;
                discovery["children"] = children;
                discovery["matchCount"] = 1;
                discovery["isPlaying"] = EditorApplication.isPlaying;
                return BridgeResult.Ok(target.name + " has " + compNames.Count + " component(s) and " + children.Count + " child(ren).", null, JsonWrite(discovery));
            }
            if (!ComponentLocator.TryResolve(args, out Component component, out string locateError))
                return BridgeResult.Error(locateError);

            int maxProperties = (int)JNum(args, "maxProperties", DefaultMaxProperties);
            if (maxProperties < 1) maxProperties = 1;
            if (maxProperties > HardMaxProperties) maxProperties = HardMaxProperties;
            List<string> wanted = ToStringList(JArr(args, "properties"));
            List<string> members = ToStringList(JArr(args, "members"));

            var serialized = new SerializedObject(component);
            serialized.Update();
            // Top-level pass: every visible, non-noise property name.
            var topNames = new List<string>();
            SerializedProperty iterator = serialized.GetIterator();
            if (iterator.NextVisible(true))
            {
                do { if (!IsNoiseProperty(iterator.name)) topNames.Add(iterator.name); }
                while (iterator.NextVisible(false));
            }
            var values = new Dictionary<string, object>();
            var unknownProperties = new List<string>();
            int omitted = 0;
            if (wanted != null)
            {
                foreach (string name in wanted)
                {
                    SerializedProperty p = serialized.FindProperty(name);
                    if (p == null || IsNoiseProperty(p.name)) { unknownProperties.Add(name); continue; }
                    values[name] = ReadProperty(p, 0);
                }
            }
            else
            {
                foreach (string name in topNames)
                {
                    if (values.Count >= maxProperties) break;
                    SerializedProperty p = serialized.FindProperty(name);
                    if (p != null) values[name] = ReadProperty(p, 0);
                }
                omitted = topNames.Count - values.Count;
            }

            var runtime = new Dictionary<string, object>();
            var memberErrors = new Dictionary<string, object>();
            if (members != null)
            {
                Type type = component.GetType();
                foreach (string name in members)
                {
                    string denied = DeniedMemberMessage(name);
                    if (denied != null) { memberErrors[name] = denied; continue; }
                    FieldInfo field = FindField(type, name);
                    if (field != null)
                    {
                        try { runtime[name] = ConvertRuntimeValue(field.GetValue(component), 0); }
                        catch (Exception e) { memberErrors[name] = "Could not read " + type.Name + "." + name + ": " + UnwrapMessage(e); }
                        continue;
                    }
                    PropertyInfo property = FindProperty(type, name);
                    if (property != null)
                    {
                        if (property.GetIndexParameters().Length > 0) { memberErrors[name] = "'" + name + "' is an indexer — read a specific element instead."; continue; }
                        if (!property.CanRead) { memberErrors[name] = "'" + name + "' cannot be read."; continue; }
                        try { runtime[name] = ConvertRuntimeValue(property.GetValue(component, null), 0); }
                        catch (Exception e) { memberErrors[name] = "Could not read " + type.Name + "." + name + ": " + UnwrapMessage(e); }
                        continue;
                    }
                    List<string> similar = SuggestMembers(type, name);
                    memberErrors[name] = "No field or property named '" + name + "' on " + type.Name + "."
                        + (similar.Count > 0 ? " Similar: " + string.Join(", ", similar.ToArray()) + "." : "");
                }
            }

            var data = new Dictionary<string, object>();
            data["path"] = ComponentLocator.GetPath(target.transform);
            data["component"] = component.GetType().Name;
            data["matchCount"] = matches.Count;
            data["isPlaying"] = EditorApplication.isPlaying;
            data["values"] = values;
            data["runtime"] = runtime;
            data["totalProperties"] = topNames.Count;
            data["omitted"] = omitted;
            data["availableNames"] = topNames.Count > HardMaxProperties ? topNames.GetRange(0, HardMaxProperties) : topNames;
            data["unknownProperties"] = unknownProperties;
            data["memberErrors"] = memberErrors;
            string message = ComponentLocator.GetPath(target.transform) + " / " + component.GetType().Name + ": " + values.Count + " serialized value(s)"
                + (runtime.Count > 0 ? ", " + runtime.Count + " runtime member(s)" : "")
                + (unknownProperties.Count > 0 ? " — unknown properties: " + string.Join(", ", unknownProperties.ToArray()) : "")
                + (memberErrors.Count > 0 ? " — member errors: " + memberErrors.Count : "") + ".";
            return BridgeResult.Ok(message, null, JsonWrite(data));
        }

        private static bool IsNoiseProperty(string name)
        {
            foreach (string n in NoiseProperties) if (n == name) return true;
            return false;
        }

        private static List<string> ToStringList(List<object> raw)
        {
            if (raw == null) return null;
            var list = new List<string>();
            foreach (object v in raw) if (v != null) list.Add(v.ToString());
            return list;
        }

        private static string UnwrapMessage(Exception e)
        {
            if (e == null) return "";
            if (e.InnerException != null) return e.InnerException.Message;
            return e.Message;
        }

        private static string DeniedMemberMessage(string name)
        {
            foreach (string denied in DeniedMembers)
            {
                if (!string.Equals(name, denied, StringComparison.OrdinalIgnoreCase)) continue;
                if (denied == "material") return "'material' creates a copy of the material each time it is read — use 'sharedMaterial' instead.";
                if (denied == "materials") return "'materials' creates a copy of the materials each time they are read — use 'sharedMaterials' instead.";
                return "'mesh' creates a copy of the mesh each time it is read — use 'sharedMesh' instead.";
            }
            return null;
        }

        private static FieldInfo FindField(Type type, string name)
        {
            for (Type t = type; t != null && t != typeof(object); t = t.BaseType)
            {
                FieldInfo f = t.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly | BindingFlags.IgnoreCase);
                if (f != null) return f;
            }
            return null;
        }

        private static PropertyInfo FindProperty(Type type, string name)
        {
            for (Type t = type; t != null && t != typeof(object); t = t.BaseType)
            {
                PropertyInfo p = t.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly | BindingFlags.IgnoreCase);
                if (p != null) return p;
            }
            return null;
        }

        private static List<string> SuggestMembers(Type type, string wanted)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (Type t = type; t != null && t != typeof(object); t = t.BaseType)
            {
                foreach (FieldInfo f in t.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                    names.Add(f.Name);
                foreach (PropertyInfo p in t.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                    if (p.GetIndexParameters().Length == 0) names.Add(p.Name);
            }
            var scored = new List<KeyValuePair<string, int>>();
            foreach (string name in names)
            {
                int d;
                if (name.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0) d = 0;
                else d = LevenshteinDistance(name.ToLowerInvariant(), wanted.ToLowerInvariant());
                if (d <= 2) scored.Add(new KeyValuePair<string, int>(name, d));
            }
            scored.Sort((a, b) => a.Value != b.Value ? a.Value.CompareTo(b.Value) : string.Compare(a.Key, b.Key, StringComparison.Ordinal));
            var result = new List<string>();
            foreach (var kv in scored)
            {
                if (result.Count >= MaxMemberSuggestions) break;
                result.Add(kv.Key);
            }
            return result;
        }

        private static int LevenshteinDistance(string a, string b)
        {
            if (string.IsNullOrEmpty(a)) return string.IsNullOrEmpty(b) ? 0 : b.Length;
            if (string.IsNullOrEmpty(b)) return a.Length;
            int[] prev = new int[b.Length + 1];
            int[] cur = new int[b.Length + 1];
            for (int j = 0; j <= b.Length; j++) prev[j] = j;
            for (int i = 1; i <= a.Length; i++)
            {
                cur[0] = i;
                for (int j = 1; j <= b.Length; j++)
                {
                    int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                    cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                }
                int[] tmp = prev; prev = cur; cur = tmp;
            }
            return prev[b.Length];
        }

        private static double Round3(float f)
        {
            return Math.Round((double)f, 3);
        }

        // One serialized property → a plain value. Internal so the
        // write action (Build 6) can read before/after values with
        // the same conversion instead of inventing its own.
        internal static object ReadProperty(SerializedProperty prop, int depth)
        {
            switch (prop.propertyType)
            {
                case SerializedPropertyType.Integer: return prop.longValue;
                case SerializedPropertyType.Boolean: return prop.boolValue;
                case SerializedPropertyType.Float: return Math.Round(prop.doubleValue, 3);
                case SerializedPropertyType.String: return TruncateString(prop.stringValue ?? "", MaxStringChars);
                case SerializedPropertyType.Color:
                    {
                        Color c = prop.colorValue;
                        return new List<object> { Round3(c.r), Round3(c.g), Round3(c.b), Round3(c.a) };
                    }
                case SerializedPropertyType.ObjectReference:
                case SerializedPropertyType.ExposedReference:
                    {
                        UnityEngine.Object o = prop.objectReferenceValue;
                        if (o == null) return null;
                        return o.name + " (" + o.GetType().Name + ")";
                    }
                case SerializedPropertyType.Enum:
                    {
                        // A flags enum's combined value is an index
                        // past the end of the names — return the
                        // number then, not the wrong name.
                        string[] names = prop.enumNames;
                        int idx = prop.enumValueIndex;
                        if (names != null && idx >= 0 && idx < names.Length) return names[idx];
                        return idx;
                    }
                case SerializedPropertyType.Vector2:
                    {
                        Vector2 v = prop.vector2Value;
                        return new List<object> { Round3(v.x), Round3(v.y) };
                    }
                case SerializedPropertyType.Vector3:
                    {
                        Vector3 v = prop.vector3Value;
                        return new List<object> { Round3(v.x), Round3(v.y), Round3(v.z) };
                    }
                case SerializedPropertyType.Vector4:
                    {
                        Vector4 v = prop.vector4Value;
                        return new List<object> { Round3(v.x), Round3(v.y), Round3(v.z), Round3(v.w) };
                    }
                case SerializedPropertyType.Rect:
                    {
                        Rect r = prop.rectValue;
                        return new List<object> { Round3(r.x), Round3(r.y), Round3(r.width), Round3(r.height) };
                    }
                case SerializedPropertyType.ArraySize: return prop.intValue;
                case SerializedPropertyType.Character: return prop.intValue;
                case SerializedPropertyType.LayerMask: return prop.intValue;
                case SerializedPropertyType.Quaternion:
                    {
                        // Euler angles in degrees — easier to read
                        // than four quaternion components.
                        Vector3 e = prop.quaternionValue.eulerAngles;
                        return new List<object> { Round3(e.x), Round3(e.y), Round3(e.z) };
                    }
                case SerializedPropertyType.RectInt:
                    {
                        RectInt r = prop.rectIntValue;
                        return new List<object> { r.x, r.y, r.width, r.height };
                    }
                case SerializedPropertyType.Vector2Int:
                    {
                        Vector2Int v = prop.vector2IntValue;
                        return new List<object> { v.x, v.y };
                    }
                case SerializedPropertyType.Vector3Int:
                    {
                        Vector3Int v = prop.vector3IntValue;
                        return new List<object> { v.x, v.y, v.z };
                    }
                case SerializedPropertyType.Bounds:
                    {
                        Bounds b = prop.boundsValue;
                        var d = new Dictionary<string, object>();
                        d["center"] = new List<object> { Round3(b.center.x), Round3(b.center.y), Round3(b.center.z) };
                        d["extents"] = new List<object> { Round3(b.extents.x), Round3(b.extents.y), Round3(b.extents.z) };
                        return d;
                    }
                case SerializedPropertyType.BoundsInt:
                    {
                        BoundsInt b = prop.boundsIntValue;
                        var d = new Dictionary<string, object>();
                        d["center"] = new List<object> { b.center.x, b.center.y, b.center.z };
                        d["extents"] = new List<object> { b.size.x, b.size.y, b.size.z };
                        return d;
                    }
                case SerializedPropertyType.Hash128: return prop.hash128Value.ToString();
                case SerializedPropertyType.AnimationCurve: return "<curve>";
                case SerializedPropertyType.Gradient: return "<gradient>";
                case SerializedPropertyType.FixedBufferSize: return prop.intValue;
                case SerializedPropertyType.Generic:
                    {
                        if (depth >= MaxDepth) return "<" + prop.type + ">";
                        if (prop.isArray)
                        {
                            var items = new List<object>();
                            int count = prop.arraySize;
                            for (int i = 0; i < Math.Min(count, MaxCollectionItems); i++)
                                items.Add(ReadProperty(prop.GetArrayElementAtIndex(i), depth + 1));
                            var d = new Dictionary<string, object>();
                            d["items"] = items;
                            d["total"] = count;
                            if (count > items.Count) d["truncated"] = true;
                            return d;
                        }
                        var obj = new Dictionary<string, object>();
                        SerializedProperty end = prop.GetEndProperty();
                        SerializedProperty child = prop.Copy();
                        while (child.NextVisible(true) && !SerializedProperty.EqualContents(child, end))
                        {
                            if (child.depth == prop.depth + 1)
                                obj[child.name] = ReadProperty(child, depth + 1);
                        }
                        return obj;
                    }
                default: return "<" + prop.propertyType + ">";
            }
        }

        // One runtime value → a plain value. A Transform is an
        // IEnumerable, so it is caught by the Object check first;
        // a string is an IEnumerable too, so it is caught before
        // the collection check.
        private static object ConvertRuntimeValue(object v, int depth)
        {
            if (v == null) return null;
            if (v is string) return TruncateString((string)v, MaxStringChars);
            if (v is bool) return v;
            if (v is float) return Math.Round((double)(float)v, 3);
            if (v is double) return Math.Round((double)v, 3);
            if (v is int || v is long) return v;
            if (v is Vector2) { var x = (Vector2)v; return new List<object> { Round3(x.x), Round3(x.y) }; }
            if (v is Vector2Int) { var x = (Vector2Int)v; return new List<object> { x.x, x.y }; }
            if (v is Vector3) { var x = (Vector3)v; return new List<object> { Round3(x.x), Round3(x.y), Round3(x.z) }; }
            if (v is Vector3Int) { var x = (Vector3Int)v; return new List<object> { x.x, x.y, x.z }; }
            if (v is Vector4) { var x = (Vector4)v; return new List<object> { Round3(x.x), Round3(x.y), Round3(x.z), Round3(x.w) }; }
            if (v is Quaternion) { Vector3 e = ((Quaternion)v).eulerAngles; return new List<object> { Round3(e.x), Round3(e.y), Round3(e.z) }; }
            if (v is Color) { var x = (Color)v; return new List<object> { Round3(x.r), Round3(x.g), Round3(x.b), Round3(x.a) }; }
            if (v is Color32) { var x = (Color32)v; return new List<object> { x.r, x.g, x.b, x.a }; }
            if (v is Rect) { var x = (Rect)v; return new List<object> { Round3(x.x), Round3(x.y), Round3(x.width), Round3(x.height) }; }
            if (v is RectInt) { var x = (RectInt)v; return new List<object> { x.x, x.y, x.width, x.height }; }
            if (v is Bounds)
            {
                var x = (Bounds)v;
                var d = new Dictionary<string, object>();
                d["center"] = new List<object> { Round3(x.center.x), Round3(x.center.y), Round3(x.center.z) };
                d["extents"] = new List<object> { Round3(x.extents.x), Round3(x.extents.y), Round3(x.extents.z) };
                return d;
            }
            if (v is Enum) return v.ToString();
            if (v is UnityEngine.Object)
            {
                var o = (UnityEngine.Object)v;
                if (o == null) return "<destroyed or none>";
                return o.name + " (" + o.GetType().Name + ")";
            }
            if (depth >= MaxDepth) return "<" + v.GetType().Name + ">";
            if (v is System.Collections.IEnumerable)
            {
                var items = new List<object>();
                int total = 0;
                foreach (object item in (System.Collections.IEnumerable)v)
                {
                    total++;
                    if (items.Count < MaxCollectionItems) items.Add(ConvertRuntimeValue(item, depth + 1));
                }
                var d = new Dictionary<string, object>();
                d["items"] = items;
                d["total"] = total;
                if (total > items.Count) d["truncated"] = true;
                return d;
            }
            try { return TruncateString(v.ToString(), MaxStringChars); }
            catch { return "<" + v.GetType().Name + ">"; }
        }
    }

#if ENABLE_INPUT_SYSTEM
    // ── Scripted input in Play Mode ──────────────────────────────
    // Queue device state events through the new Input System — the
    // route with the highest fidelity, because it exercises the
    // game's real bindings instead of calling game code directly.
    // The old UnityEngine.Input cannot be faked from editor code,
    // and OS-level synthetic input is fragile (needs focus, steals
    // the keyboard) — neither is shipped. A project on the legacy
    // input system only gets a plain error from the dispatcher.
    //
    // The traps, all handled here rather than left to the caller:
    //   * Silent drops when Unity is not focused — the run saves
    //     the focus settings in SessionState, sets them to let
    //     input through while the editor is in the background, and
    //     restores them when the run finishes, is cancelled, or a
    //     script reload kills it. The result also reports whether
    //     the app was focused and the device enabled, so a deaf
    //     game does not look like a bug in the model's code.
    //   * Events are processed at the next input update — a tap
    //     holds for 3 frames, because a press and release inside
    //     the same update collapse into nothing.
    //   * Stuck keys — every key and button is released when the
    //     run finishes, is cancelled, or Play Mode ends.
    //   * Keyboard.current is never assumed: input goes into the
    //     existing device. A gamepad is the existing one, or one
    //     added for the run.
    //   * Per-frame granularity needs its own EditorApplication.
    //     update subscription — the transport polls at 150ms–1s,
    //     far too coarse for input. The transport only collects
    //     the final result.
    // The run starts with a self-check: one frame of a key, then
    // confirm the device reports it pressed. If it never lands,
    // the run fails plainly as "input is being dropped" instead
    // of pretending the game ignored the key.
    private static class InjectInputHandler
    {
        private const int MaxSteps = 50;
        private const double MaxTotalSeconds = 30.0;
        private const int DefaultTapFrames = 3;
        private const int NotStarted = -1;
        private const int SelfCheckFrames = 2;
        private const double SelfCheckTimeoutSeconds = 5.0;

        private const string ActiveKey = "CodeFox.Inject.Active";
        private const string BackgroundBehaviorKey = "CodeFox.Inject.BackgroundBehavior";
        private const string EditorInputBehaviorKey = "CodeFox.Inject.EditorInputBehavior";
        private const string RunInBackgroundKey = "CodeFox.Inject.RunInBackground";

        private sealed class Step
        {
            public Key key = Key.None;
            public bool hasPadButton;
            public GamepadButton padButton;
            public bool hasStick;
            public Vector2 stick;
            public int frames;
            public double seconds;
            public int startFrame = NotStarted;
            public double startTime;
        }

        private static List<Step> _steps;
        private static int _stepIndex;
        private static string _pendingRequestId;
        private static BridgeResult _finishedResult;
        private static HashSet<Key> _heldKeys = new HashSet<Key>();
        private static HashSet<GamepadButton> _heldPadButtons = new HashSet<GamepadButton>();
        private static Vector2 _stick;
        private static bool _hasStick;
        private static Gamepad _gamepad;
        private static bool _selfChecking;
        private static Key _selfCheckKey = Key.None;
        private static int _selfCheckStartFrame = NotStarted;
        private static double _selfCheckStartTime;
        private static bool _selfCheckPassed;
        private static bool _diagnosticsFocused;
        private static bool _diagnosticsDeviceEnabled;

        public static void Initialize()
        {
            EditorApplication.update -= Tick;
            EditorApplication.update += Tick;
            EditorApplication.playModeStateChanged -= OnPlayModeChanged;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            AssemblyReloadEvents.beforeAssemblyReload -= OnBeforeReload;
            AssemblyReloadEvents.beforeAssemblyReload += OnBeforeReload;
            // A domain reload killed a run mid-flight: the settings
            // the run changed are still changed, and the run's
            // state is gone. Restore the originals so the editor
            // is left as the user had it.
            if (SessionState.GetBool(ActiveKey, false))
            {
                RestoreFocusSettings();
                SessionState.SetBool(ActiveKey, false);
            }
        }

        public static BridgeResult Begin(string json, Dictionary<string, object> args)
        {
            string id = BridgeDispatcher.CurrentRequestId;
            if (string.IsNullOrEmpty(id)) return BridgeResult.Error("inject_input needs a request id.");
            if (_steps != null) return BridgeResult.Error("An input sequence is already running — wait for it to finish.");
            if (!EditorApplication.isPlaying)
                return BridgeResult.Error("Enter Play Mode first — input can only be injected while the game is running (set_play_mode without a duration, then inject_input, then set_play_mode {\"enabled\": false}).");
            List<object> rawSteps = JArr(args, "steps");
            if (rawSteps == null || rawSteps.Count < 1) return BridgeResult.Error("inject_input needs at least one step.");
            if (rawSteps.Count > MaxSteps) return BridgeResult.Error("inject_input takes at most " + MaxSteps + " steps — split the run into shorter ones.");
            List<Step> steps;
            string parseError;
            if (!TryParseSteps(rawSteps, out steps, out parseError)) return BridgeResult.Error(parseError);
            double totalSeconds = 0;
            bool needsKeyboard = false;
            bool needsGamepad = false;
            Key firstKey = Key.None;
            foreach (Step s in steps)
            {
                totalSeconds += s.seconds + s.frames / 60.0;
                if (s.key != Key.None) { needsKeyboard = true; if (firstKey == Key.None) firstKey = s.key; }
                if (s.hasPadButton || s.hasStick) needsGamepad = true;
            }
            if (totalSeconds > MaxTotalSeconds) return BridgeResult.Error("Input steps total more than " + MaxTotalSeconds + " seconds — split them into shorter runs.");
            if (needsKeyboard && Keyboard.current == null)
                return BridgeResult.Error("No keyboard device is connected — the game cannot receive keyboard input.");
            _gamepad = null;
            if (needsGamepad)
            {
                _gamepad = Gamepad.current;
                if (_gamepad == null)
                {
                    try { _gamepad = InputSystem.AddDevice<Gamepad>(); }
                    catch (Exception e) { return BridgeResult.Error("Could not add a gamepad device for input: " + e.Message); }
                }
            }

            _diagnosticsFocused = Application.isFocused;
            _diagnosticsDeviceEnabled = needsKeyboard
                ? (Keyboard.current != null && Keyboard.current.enabled)
                : (_gamepad != null && _gamepad.enabled);

            // Save the focus settings, then let input through while
            // the editor is in the background. Restored in Finish
            // — and in Initialize, if a reload kills the run first.
            InputSettings settings = InputSystem.settings;
            if (settings != null)
            {
                SessionState.SetInt(BackgroundBehaviorKey, (int)settings.backgroundBehavior);
                SessionState.SetInt(EditorInputBehaviorKey, (int)settings.editorInputBehaviorInPlayMode);
                SessionState.SetBool(RunInBackgroundKey, Application.runInBackground);
                settings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
                settings.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
            }
            Application.runInBackground = true;
            SessionState.SetBool(ActiveKey, true);

            _steps = steps;
            _stepIndex = 0;
            _pendingRequestId = id;
            _finishedResult = null;
            _selfCheckKey = firstKey;
            _selfChecking = firstKey != Key.None;
            _selfCheckPassed = false;
            _selfCheckStartFrame = NotStarted;
            return BridgeResult.Pending("Injecting input…");
        }

        public static bool HasPending()
        {
            return _steps != null;
        }

        public static bool IsPending(string id)
        {
            return _steps != null && _pendingRequestId == id;
        }

        public static bool TryFinalize(out BridgeResult result, out string requestId)
        {
            result = null;
            requestId = null;
            if (_finishedResult == null || string.IsNullOrEmpty(_pendingRequestId)) return false;
            result = _finishedResult;
            requestId = _pendingRequestId;
            _finishedResult = null;
            _pendingRequestId = null;
            return true;
        }

        private static void Tick()
        {
            if (_steps == null) return;
            if (_selfChecking) { SelfCheckTick(); return; }
            if (_stepIndex >= _steps.Count) return;
            Step step = _steps[_stepIndex];
            if (step.startFrame == NotStarted)
            {
                step.startFrame = Time.frameCount;
                step.startTime = Time.realtimeSinceStartup;
                if (step.key != Key.None) { _heldKeys.Add(step.key); FlushKeyboardState(); }
                if (step.hasPadButton) { _heldPadButtons.Add(step.padButton); FlushGamepadState(); }
                if (step.hasStick) { _stick = step.stick; _hasStick = true; FlushGamepadState(); }
            }
            bool done = step.frames > 0
                ? Time.frameCount - step.startFrame >= step.frames
                : Time.realtimeSinceStartup - step.startTime >= step.seconds;
            if (!done) return;
            if (step.key != Key.None) { _heldKeys.Remove(step.key); FlushKeyboardState(); }
            if (step.hasPadButton) { _heldPadButtons.Remove(step.padButton); FlushGamepadState(); }
            if (step.hasStick) { _hasStick = false; _stick = Vector2.zero; FlushGamepadState(); }
            _stepIndex++;
            if (_stepIndex >= _steps.Count)
                Finish(BridgeResult.Ok("Input done — " + _steps.Count + " step(s).", null, DiagnosticsJson(_steps.Count)));
        }

        private static void SelfCheckTick()
        {
            if (_selfCheckKey == Key.None) { _selfChecking = false; return; }
            if (Keyboard.current == null)
            {
                Abort("Input is being dropped — no keyboard device is connected.");
                return;
            }
            if (_selfCheckStartFrame == NotStarted)
            {
                _heldKeys.Add(_selfCheckKey);
                FlushKeyboardState();
                _selfCheckStartFrame = Time.frameCount;
                _selfCheckStartTime = Time.realtimeSinceStartup;
                return;
            }
            bool pressed;
            try { pressed = Keyboard.current[_selfCheckKey].isPressed; }
            catch { pressed = false; }
            if (pressed)
            {
                _heldKeys.Remove(_selfCheckKey);
                FlushKeyboardState();
                _selfChecking = false;
                _selfCheckPassed = true;
                _selfCheckStartFrame = NotStarted;
                return;
            }
            if (Time.realtimeSinceStartup - _selfCheckStartTime > SelfCheckTimeoutSeconds)
                Abort("Input is being dropped (focus or device disabled) — the game is not receiving keyboard input. Check that the Game View has focus and that the keyboard device is enabled, then try again.");
        }

        private static void FlushKeyboardState()
        {
            if (Keyboard.current == null) return;
            InputSystem.QueueStateEvent(Keyboard.current, new KeyboardState(_heldKeys.ToArray()));
        }

        private static void FlushGamepadState()
        {
            if (_gamepad == null) return;
            GamepadState state = new GamepadState();
            state.leftStick = _hasStick ? _stick : Vector2.zero;
            foreach (GamepadButton b in _heldPadButtons) state = state.WithButton(b);
            InputSystem.QueueStateEvent(_gamepad, state);
        }

        private static void OnPlayModeChanged(PlayModeStateChange state)
        {
            if (state == PlayModeStateChange.ExitingPlayMode || state == PlayModeStateChange.EnteredEditMode)
                Abort("Play Mode ended during input.");
        }

        private static void OnBeforeReload()
        {
            Abort("Script reload during input.");
        }

        private static void Abort(string reason)
        {
            if (_steps == null) return;
            Finish(BridgeResult.Error(reason));
        }

        private static void Finish(BridgeResult result)
        {
            _heldKeys.Clear();
            _heldPadButtons.Clear();
            _stick = Vector2.zero;
            _hasStick = false;
            try { FlushKeyboardState(); } catch { }
            try { FlushGamepadState(); } catch { }
            RestoreFocusSettings();
            SessionState.SetBool(ActiveKey, false);
            _steps = null;
            _selfChecking = false;
            _finishedResult = result;
        }

        private static void RestoreFocusSettings()
        {
            try
            {
                InputSettings settings = InputSystem.settings;
                if (settings == null) return;
                settings.backgroundBehavior = (InputSettings.BackgroundBehavior)SessionState.GetInt(BackgroundBehaviorKey, (int)InputSettings.BackgroundBehavior.ResetAndDisableNonBackgroundDevices);
                settings.editorInputBehaviorInPlayMode = (InputSettings.EditorInputBehaviorInPlayMode)SessionState.GetInt(EditorInputBehaviorKey, (int)InputSettings.EditorInputBehaviorInPlayMode.PointersAndKeyboardsRespectGameViewFocus);
                Application.runInBackground = SessionState.GetBool(RunInBackgroundKey, false);
            }
            catch { }
        }

        private static string DiagnosticsJson(int stepsRun)
        {
            var data = new Dictionary<string, object>();
            data["stepsRun"] = stepsRun;
            data["focused"] = _diagnosticsFocused;
            data["deviceEnabled"] = _diagnosticsDeviceEnabled;
            data["selfCheckPassed"] = _selfCheckPassed;
            return JsonWrite(data);
        }

        private static bool TryParseSteps(List<object> rawSteps, out List<Step> steps, out string error)
        {
            steps = new List<Step>();
            error = null;
            foreach (object raw in rawSteps)
            {
                var stepArgs = raw as Dictionary<string, object>;
                if (stepArgs == null) { error = "Each input step must be an object."; return false; }
                var step = new Step();
                string keyStr = JStr(stepArgs, "key", "");
                string padStr = JStr(stepArgs, "gamepadButton", "");
                List<object> stickRaw = JArr(stepArgs, "leftStick");
                if (stepArgs.ContainsKey("wait"))
                {
                    step.seconds = JNum(stepArgs, "wait", 0);
                    if (step.seconds <= 0) { error = "A wait step needs a positive number of seconds."; return false; }
                }
                else if (!string.IsNullOrEmpty(keyStr))
                {
                    object parsedKey;
                    if (!Enum.TryParse(typeof(Key), keyStr, true, out parsedKey) || (Key)parsedKey == Key.None)
                    {
                        error = "Unknown key '" + keyStr + "' — use the new Input System Key names (Space, W, A, S, D, LeftShift, Enter).";
                        return false;
                    }
                    step.key = (Key)parsedKey;
                    if (!TryParsePress(stepArgs, step, "key '" + keyStr + "'", out error)) return false;
                }
                else if (!string.IsNullOrEmpty(padStr))
                {
                    object parsedButton;
                    if (!Enum.TryParse(typeof(GamepadButton), padStr, true, out parsedButton))
                    {
                        error = "Unknown gamepad button '" + padStr + "' — use South, North, East, West, Start, Select, LeftShoulder, RightShoulder, LeftTrigger, RightTrigger, or a Dpad direction.";
                        return false;
                    }
                    step.hasPadButton = true;
                    step.padButton = (GamepadButton)parsedButton;
                    if (!TryParsePress(stepArgs, step, "button '" + padStr + "'", out error)) return false;
                }
                else if (stickRaw != null)
                {
                    if (stickRaw.Count != 2) { error = "A leftStick step needs two numbers: [x, y]."; return false; }
                    double x = ToDouble(stickRaw[0]);
                    double y = ToDouble(stickRaw[1]);
                    step.hasStick = true;
                    step.stick = new Vector2((float)Math.Max(-1, Math.Min(1, x)), (float)Math.Max(-1, Math.Min(1, y)));
                    step.seconds = JNum(stepArgs, "seconds", 0);
                    if (step.seconds <= 0) { error = "A leftStick step needs 'seconds'."; return false; }
                }
                else
                {
                    error = "Each input step needs a key, a gamepadButton, a leftStick, or a wait.";
                    return false;
                }
                steps.Add(step);
            }
            return true;
        }

        private static bool TryParsePress(Dictionary<string, object> stepArgs, Step step, string what, out string error)
        {
            error = null;
            string action = JStr(stepArgs, "action", "tap");
            if (action == "tap")
            {
                step.frames = (int)JNum(stepArgs, "frames", DefaultTapFrames);
                if (step.frames < 1) { error = "A tap for " + what + " needs at least 1 frame."; return false; }
            }
            else if (action == "hold")
            {
                step.seconds = JNum(stepArgs, "seconds", 0);
                if (step.seconds <= 0) { error = "A hold for " + what + " needs 'seconds'."; return false; }
            }
            else
            {
                error = "Unknown action '" + action + "' for " + what + " — use 'tap' or 'hold'.";
                return false;
            }
            return true;
        }

        private static double ToDouble(object v)
        {
            if (v is double) return (double)v;
            if (v is string)
            {
                double f;
                if (double.TryParse((string)v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out f)) return f;
            }
            return 0;
        }
    }
#endif

    // ── Shared mutation helpers ──────────────────────────────
    // Three scene write actions share the same shape — a Play
    // Mode guard, one undo group per agent turn, and a scene-dirty
    // mark at the end — so they live in one helper instead of
    // three copies that drift apart. A "turn" is one agent turn
    // (the app passes turnId); the first mutation of the turn
    // opens the group and later calls in the same turn merge into
    // it, so one Ctrl+Z reverts the whole turn.
    private static class MutationScope
    {
        private const string TurnIdKey = "CodeFox.Mutation.TurnId";
        private const string GroupKey = "CodeFox.Mutation.Group";
        private const string GroupNameKey = "CodeFox.Mutation.GroupName";
        public const string PlayModeWarning = "Play Mode: these changes will be lost when Play Mode stops.";

        // Returns an error message when the call must not run, or
        // null when it may. A dry run never changes anything, so
        // it is always allowed — the preview is the point. A real
        // call while the game runs needs allowPlayMode.
        public static string PlayModeError(Dictionary<string, object> args, bool dryRun)
        {
            if (dryRun) return null;
            if (!EditorApplication.isPlayingOrWillChangePlaymode) return null;
            if (JBool(args, "allowPlayMode", false)) return null;
            return "Stop Play Mode first — changes made while the game is running are lost when it stops. Pass \"allowPlayMode\": true to experiment anyway.";
        }

        public static int BeginUndoGroup(Dictionary<string, object> args, string defaultLabel)
        {
            string turnId = JStr(args, "turnId", "");
            string label = JStr(args, "label", defaultLabel);
            if (!string.IsNullOrEmpty(turnId) && SessionState.GetString(TurnIdKey, "") == turnId)
                return SessionState.GetInt(GroupKey, 0);
            // A fresh group for this turn (v0.16.0): increment
            // first, so the turn's group holds ONLY this turn's
            // operations. Before this, the first write of a turn
            // reused whatever group was current — which could
            // already hold the user's own edits, and a turn
            // revert would have undone those too.
            Undo.IncrementCurrentGroup();
            int group = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Agent: " + label);
            SessionState.SetString(TurnIdKey, string.IsNullOrEmpty(turnId) ? Guid.NewGuid().ToString() : turnId);
            SessionState.SetInt(GroupKey, group);
            SessionState.SetString(GroupNameKey, "Agent: " + label);
            return group;
        }

        public static void Commit(int undoGroup, Scene scene)
        {
            Undo.CollapseUndoOperations(undoGroup);
            if (!EditorApplication.isPlaying && scene.IsValid())
                EditorSceneManager.MarkSceneDirty(scene);
        }

        // Revert one agent turn's scene changes as a unit
        // (v0.16.0). The gate is the group index: the revert only
        // runs while the turn's group is still the current one —
        // if the user (or a later turn) recorded anything since,
        // the current group moved on and the revert refuses
        // instead of undoing someone else's work. The dry run
        // reports canRevert so the app can show the plan before
        // asking. A successful revert clears the stored turn, so
        // the same turn cannot be reverted twice. Prefab edits
        // are NOT undone here — they are file transactions, and
        // the app restores their snapshots separately.
        public static BridgeResult RevertTurn(string json, Dictionary<string, object> args)
        {
            string turnId = JStr(args, "turnId", "");
            bool dryRun = JBool(args, "dryRun", false);
            if (string.IsNullOrEmpty(turnId)) return BridgeResult.Error("revert_turn needs a \"turnId\".");
            string storedTurn = SessionState.GetString(TurnIdKey, "");
            if (storedTurn != turnId)
                return BridgeResult.Error("No scene undo group for turn '" + turnId + "' — that turn made no scene changes, or it was already reverted.");
            int group = SessionState.GetInt(GroupKey, -1);
            int current = Undo.GetCurrentGroup();
            var data = new Dictionary<string, object>();
            data["turnId"] = turnId;
            data["turnGroup"] = group;
            data["currentGroup"] = current;
            data["groupName"] = SessionState.GetString(GroupNameKey, "");
            if (current != group)
            {
                data["canRevert"] = false;
                data["reason"] = "The undo stack moved on since that turn (the turn's group is " + group + ", the current group is " + current + ") — use Ctrl+Z in Unity to undo step by step.";
                return BridgeResult.Ok("That turn cannot be undone as one step — the undo stack moved on.", null, JsonWrite(data));
            }
            data["canRevert"] = true;
            if (dryRun)
                return BridgeResult.Ok("Turn " + turnId + " can be undone as one step (" + SessionState.GetString(GroupNameKey, "") + ").", null, JsonWrite(data));
            Undo.RevertAllInCurrentGroup();
            SessionState.SetString(TurnIdKey, "");
            SessionState.SetInt(GroupKey, -1);
            SessionState.SetString(GroupNameKey, "");
            return BridgeResult.Ok("Undid the turn's scene changes as one step.", null, JsonWrite(data));
        }
    }

    // ── Prefab transactions ──────────────────────────────────
    // Prefab edits are file transactions, not undo operations:
    // LoadPrefabContents loads into an isolated in-memory scene
    // and nothing in the docs says Undo covers edits to those
    // contents — once UnloadPrefabContents runs, the objects are
    // destroyed and any undo entry pointing at them is dead. So
    // a prefab edit is (1) snapshot the asset file (and .meta)
    // under .bridge/snapshots/<turnId>/, (2) load, (3) edit,
    // (4) save, (5) unload in a finally. Undo = copy the
    // snapshot back and reimport. A dry run loads, stages, and
    // unloads without snapshotting or saving. The app keeps the
    // per-turn ledger — which snapshots belong to which turn —
    // and asks for a restore by snapshot path; the bridge only
    // ever copies files inside .bridge/snapshots/ back to the
    // asset they came from. The bridge stays dependency-free —
    // the hand-rolled JsonMini / JsonWrite path the rest of the
    // bridge uses, no JSON package.
    private static class PrefabTransactions
    {
        private const string SnapshotsDirName = "snapshots";
        private const string ActiveEditKey = "CodeFox.PrefabEdit.Active";

        public class EditOutcome
        {
            public string Error;
            public string Message;
            public Dictionary<string, object> Data;
        }

        // The file name a snapshot gets: the asset path with
        // every separator flattened, so no asset path can ever
        // escape the snapshot folder. Deterministic — the same
        // asset in the same turn always maps to the same
        // snapshot file.
        public static string SnapshotFileName(string assetPath)
        {
            return assetPath.Replace('/', '_').Replace('\\', '_');
        }

        public static string SnapshotRelPath(string turnId, string assetPath)
        {
            return ".bridge/" + SnapshotsDirName + "/" + turnId + "/" + SnapshotFileName(assetPath);
        }

        private static string ProjectFullPath(string projectRelPath)
        {
            return Path.Combine(Path.GetDirectoryName(Application.dataPath), projectRelPath);
        }

        // SHA-256 hex of the file, or null when it cannot be
        // read. The hash is the staleness guard: the preview's
        // hash rides back on the real call, and the ledger's
        // post-edit hash guards a later restore.
        public static string ComputeAssetHash(string projectRelPath)
        {
            try
            {
                using (var sha = System.Security.Cryptography.SHA256.Create())
                using (var stream = File.OpenRead(ProjectFullPath(projectRelPath)))
                {
                    byte[] hash = sha.ComputeHash(stream);
                    var sb = new System.Text.StringBuilder(hash.Length * 2);
                    foreach (byte b in hash) sb.Append(b.ToString("x2"));
                    return sb.ToString();
                }
            }
            catch { return null; }
        }

        // A snapshot path the app hands back must be exactly the
        // shape the bridge writes: .bridge/snapshots/<turnId>/
        // <file> with no ".." segment and no absolute path —
        // anything else is refused, never copied.
        public static bool IsSnapshotRelPath(string rel)
        {
            if (string.IsNullOrEmpty(rel)) return false;
            string n = rel.Replace('\\', '/');
            if (!n.StartsWith(".bridge/" + SnapshotsDirName + "/", StringComparison.Ordinal)) return false;
            if (n.IndexOf("..", StringComparison.Ordinal) >= 0) return false;
            if (n.StartsWith("/", StringComparison.Ordinal)) return false;
            return true;
        }

        // Copy the asset file (and its .meta, when one exists)
        // into the turn's snapshot folder. Returns the relative
        // snapshot path, or null with an error.
        public static string SnapshotAsset(string assetPath, string turnId, out string error)
        {
            error = null;
            string full = ProjectFullPath(assetPath);
            if (!File.Exists(full)) { error = "Prefab file not found: '" + assetPath + "'."; return null; }
            string rel = SnapshotRelPath(turnId, assetPath);
            string dest = ProjectFullPath(rel);
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                File.Copy(full, dest, true);
                string meta = full + ".meta";
                if (File.Exists(meta)) File.Copy(meta, dest + ".meta", true);
                return rel;
            }
            catch (Exception e) { error = "Could not snapshot '" + assetPath + "': " + e.Message; return null; }
        }

        // Copy a snapshot back over its asset and reimport. The
        // expectedHash guard (the ledger's post-edit hash) refuses
        // when the file changed since the turn — restoring stale
        // bytes over a newer edit would be worse than refusing.
        public static BridgeResult RestoreSnapshotAction(string json, Dictionary<string, object> args)
        {
            string snapshot = JStr(args, "snapshot", "");
            string asset = JStr(args, "asset", "");
            if (string.IsNullOrEmpty(snapshot) || string.IsNullOrEmpty(asset))
                return BridgeResult.Error("restore_prefab needs a \"snapshot\" (.bridge/snapshots/…) and an \"asset\" (Assets/…).");
            if (!IsSnapshotRelPath(snapshot))
                return BridgeResult.Error("Refused snapshot path '" + snapshot + "' — snapshots live under .bridge/snapshots/.");
            if (!asset.StartsWith("Assets/", StringComparison.Ordinal))
                return BridgeResult.Error("restore_prefab asset must start with Assets/ — got '" + asset + "'.");
            string expectedHash = JStr(args, "expectedHash", "");
            if (!string.IsNullOrEmpty(expectedHash))
            {
                string current = ComputeAssetHash(asset);
                if (current != null && !string.Equals(current, expectedHash, StringComparison.OrdinalIgnoreCase))
                    return BridgeResult.Error("'" + asset + "' changed since the turn — the snapshot is stale. Restore it by hand from " + snapshot + ".");
            }
            string src = ProjectFullPath(snapshot);
            if (!File.Exists(src)) return BridgeResult.Error("Snapshot not found: '" + snapshot + "'.");
            try
            {
                string dest = ProjectFullPath(asset);
                File.Copy(src, dest, true);
                string srcMeta = src + ".meta";
                if (File.Exists(srcMeta)) File.Copy(srcMeta, dest + ".meta", true);
            }
            catch (Exception e) { return BridgeResult.Error("Could not restore '" + asset + "': " + e.Message); }
            AssetDatabase.ImportAsset(asset, ImportAssetOptions.ForceUpdate);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return BridgeResult.Ok("Restored '" + asset + "' from its snapshot.", asset);
        }

        // Is this prefab open in Prefab Mode right now? Agent
        // edits never run against a prefab the user has open —
        // the user is looking at it, and the transaction would
        // fight their edits.
        public static bool IsPrefabStageOpen(string assetPath)
        {
            try
            {
                var stage = PrefabStageUtility.GetCurrentPrefabStage();
                return stage != null && string.Equals(stage.assetPath, assetPath, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        // The one transaction every prefab edit runs through.
        // Validates, snapshots (real calls only), loads the
        // contents, runs the edit callback, saves (real calls
        // only), and always unloads in a finally. The callback
        // returns its own message and extra result data; the
        // transaction adds the asset path, the dry-run flag, the
        // snapshot path (real calls), and the file hash (before
        // the edit for a dry run — the staleness guard the real
        // call carries back; after the save for a real call —
        // the hash the ledger records for a later restore).
        public static BridgeResult Transact(string assetPath, Dictionary<string, object> args, Func<GameObject, List<string>, EditOutcome> edit)
        {
            if (string.IsNullOrEmpty(assetPath)) return BridgeResult.Error("A prefab path (Assets/…) is required.");
            if (!assetPath.StartsWith("Assets/", StringComparison.Ordinal)) return BridgeResult.Error("Prefab path must start with Assets/ — got '" + assetPath + "'.");
            if (!assetPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)) return BridgeResult.Error("'" + assetPath + "' is not a .prefab file.");
            bool dryRun = JBool(args, "dryRun", false);
            string turnId = JStr(args, "turnId", "");
            string playError = MutationScope.PlayModeError(args, dryRun);
            if (playError != null) return BridgeResult.Error(playError);
            if (IsPrefabStageOpen(assetPath))
                return BridgeResult.Error("'" + assetPath + "' is open in Prefab Mode — close it first, or the agent's edit would fight yours.");
            if (!dryRun)
            {
                try { if (!AssetDatabase.IsOpenForEdit(assetPath)) return BridgeResult.Error("'" + assetPath + "' is not writable (read-only or under version control without a checkout)."); }
                catch { }
                if (string.IsNullOrEmpty(turnId) || !BridgeTransport.IsSafeRequestId(turnId))
                    return BridgeResult.Error("A prefab edit needs a safe turn id — the app always sends one.");
            }
            if (AssetDatabase.LoadAssetAtPath<GameObject>(assetPath) == null)
                return BridgeResult.Error("Prefab not found: '" + assetPath + "' — the file is not in this project.");
            string expectedHash = JStr(args, "expectedHash", "");
            string hashBefore = ComputeAssetHash(assetPath);
            if (!string.IsNullOrEmpty(expectedHash) && hashBefore != null && !string.Equals(hashBefore, expectedHash, StringComparison.OrdinalIgnoreCase))
                return BridgeResult.Error("'" + assetPath + "' changed since the preview — run the preview again.");
            string snapshotRel = null;
            if (!dryRun)
            {
                string snapError;
                snapshotRel = SnapshotAsset(assetPath, turnId, out snapError);
                if (snapshotRel == null) return BridgeResult.Error(snapError);
            }
            GameObject contents = PrefabUtility.LoadPrefabContents(assetPath);
            if (contents == null) return BridgeResult.Error("Could not load the prefab at " + assetPath + ".");
            // The active-edit flag is how a domain reload mid-edit
            // is found on startup: the flag survives the reload,
            // the contents do not, and the startup check unloads
            // the leaked scene.
            SessionState.SetString(ActiveEditKey, assetPath);
            try
            {
                var summary = new List<string>();
                EditOutcome outcome = edit(contents, summary);
                if (outcome == null) return BridgeResult.Error("The prefab edit produced no result.");
                if (!string.IsNullOrEmpty(outcome.Error)) return BridgeResult.Error(outcome.Error);
                if (!dryRun)
                {
                    GameObject saved = PrefabUtility.SaveAsPrefabAsset(contents, assetPath);
                    if (saved == null) return BridgeResult.Error("Unity could not save the prefab at " + assetPath + ".");
                    AssetDatabase.SaveAssets();
                    AssetDatabase.Refresh();
                }
                var data = new Dictionary<string, object>();
                if (outcome.Data != null)
                    foreach (var kv in outcome.Data) data[kv.Key] = kv.Value;
                data["prefab"] = assetPath;
                data["dryRun"] = dryRun;
                if (snapshotRel != null) data["snapshot"] = snapshotRel;
                data["assetHash"] = dryRun ? hashBefore : ComputeAssetHash(assetPath);
                if (summary.Count > 0) data["summary"] = summary;
                string message = !string.IsNullOrEmpty(outcome.Message) ? outcome.Message : "Prefab updated.";
                return BridgeResult.Ok(message, null, JsonWrite(data));
            }
            finally
            {
                PrefabUtility.UnloadPrefabContents(contents);
                SessionState.SetString(ActiveEditKey, "");
            }
        }

        // Startup: a domain reload mid-edit leaves the
        // active-edit flag set and the loaded contents orphaned
        // in an isolated scene. Find that scene's root by the
        // prefab-contents marker and unload it, so the leak does
        // not pile up across reloads. Best-effort — a failure
        // here must never break bridge startup.
        public static void ClearStaleEdit()
        {
            try
            {
                string asset = SessionState.GetString(ActiveEditKey, "");
                if (string.IsNullOrEmpty(asset)) return;
                SessionState.SetString(ActiveEditKey, "");
                GameObject leakedRoot = null;
                foreach (GameObject go in Resources.FindObjectsOfTypeAll<GameObject>())
                {
                    if (go.transform.parent != null) continue;
                    if (!PrefabUtility.IsPartOfPrefabContents(go)) continue;
                    leakedRoot = go;
                    break;
                }
                if (leakedRoot != null)
                {
                    PrefabUtility.UnloadPrefabContents(leakedRoot);
                    Debug.LogWarning("[CodeFox] Unloaded a prefab edit left behind by a domain reload (" + asset + ").");
                }
                else
                {
                    Debug.LogWarning("[CodeFox] A prefab edit of " + asset + " was interrupted by a domain reload; nothing was saved.");
                }
            }
            catch (Exception e) { Debug.LogWarning("[CodeFox] Could not check for an interrupted prefab edit: " + e.Message); }
        }
    }

    // ── Component type resolution ────────────────────────────
    // TypeCache is the fast, public editor API for "what
    // components exist". A script the model just wrote is not in
    // it until the project compiles, so a miss points back at
    // recompile_and_report_errors instead of guessing. Editor-only
    // types are filtered out — the model cannot add an editor
    // component to a game object.
    private static class ComponentTypeResolver
    {
        private static readonly string[] Primitives = { "Cube", "Sphere", "Capsule", "Cylinder", "Plane", "Quad" };

        public static bool TryResolve(string name, out Type type, out string error)
        {
            type = null; error = null;
            if (string.IsNullOrEmpty(name))
            {
                error = "'type' is required.";
                return false;
            }
            string n = name.Trim();
            var fullMatches = new List<Type>();
            var shortMatches = new List<Type>();
            foreach (Type t in TypeCache.GetTypesDerivedFrom<Component>())
            {
                if (!IsAddableComponent(t)) continue;
                if (string.Equals(t.FullName, n, StringComparison.OrdinalIgnoreCase)) fullMatches.Add(t);
                else if (string.Equals(t.Name, n, StringComparison.OrdinalIgnoreCase)) shortMatches.Add(t);
            }
            // Full name first — unambiguous when the model gives it.
            if (fullMatches.Count == 1) { type = fullMatches[0]; return true; }
            if (fullMatches.Count > 1)
            {
                var fullNames = new List<string>();
                foreach (Type t in fullMatches) fullNames.Add(t.FullName);
                error = "Ambiguous component type '" + name + "' — use the full name. Matches: " + string.Join(", ", fullNames.ToArray()) + ".";
                return false;
            }
            if (shortMatches.Count == 0)
            {
                var similar = SuggestTypeNames(n);
                error = "Unknown component type '" + name + "'."
                    + (similar.Count > 0 ? " Similar: " + string.Join(", ", similar.ToArray()) + "." : "")
                    + " If you just wrote this script, run recompile_and_report_errors first, and make sure the class name matches its file name.";
                return false;
            }
            // Prefer an exact-case short-name match when several
            // namespaces share a name.
            foreach (Type t in shortMatches)
                if (string.Equals(t.Name, n, StringComparison.Ordinal)) { type = t; return true; }
            if (shortMatches.Count == 1) { type = shortMatches[0]; return true; }
            var names = new List<string>();
            foreach (Type t in shortMatches) names.Add(t.FullName);
            error = "Ambiguous component type '" + name + "' — use the full name. Matches: " + string.Join(", ", names.ToArray()) + ".";
            return false;
        }

        private static bool IsAddableComponent(Type t)
        {
            if (t == null || !t.IsClass || t.IsAbstract || t.IsGenericTypeDefinition) return false;
            if (!typeof(Component).IsAssignableFrom(t)) return false;
            if (t.Namespace != null && (t.Namespace == "UnityEditor" || t.Namespace.StartsWith("UnityEditor.", StringComparison.Ordinal))) return false;
            if (t.Assembly == typeof(UnityEditor.Editor).Assembly) return false;
            return true;
        }

        public static List<string> SuggestTypeNames(string wanted)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Type t in TypeCache.GetTypesDerivedFrom<Component>())
                if (IsAddableComponent(t)) names.Add(t.Name);
            var scored = new List<KeyValuePair<string, int>>();
            foreach (string name in names)
            {
                int d;
                if (name.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0) d = 0;
                else d = Levenshtein(wanted.ToLowerInvariant(), name.ToLowerInvariant());
                if (d <= 2) scored.Add(new KeyValuePair<string, int>(name, d));
            }
            scored.Sort((a, b) => a.Value != b.Value ? a.Value.CompareTo(b.Value) : string.Compare(a.Key, b.Key, StringComparison.Ordinal));
            var result = new List<string>();
            foreach (var kv in scored) { if (result.Count >= 8) break; result.Add(kv.Key); }
            return result;
        }

        private static int Levenshtein(string a, string b)
        {
            if (string.IsNullOrEmpty(a)) return string.IsNullOrEmpty(b) ? 0 : b.Length;
            if (string.IsNullOrEmpty(b)) return a.Length;
            int[] prev = new int[b.Length + 1];
            int[] cur = new int[b.Length + 1];
            for (int j = 0; j <= b.Length; j++) prev[j] = j;
            for (int i = 1; i <= a.Length; i++)
            {
                cur[0] = i;
                for (int j = 1; j <= b.Length; j++)
                {
                    int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                    cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                }
                int[] tmp = prev; prev = cur; cur = tmp;
            }
            return prev[b.Length];
        }

        public static bool IsPrimitive(string name, out PrimitiveType primitive)
        {
            primitive = PrimitiveType.Cube;
            if (string.IsNullOrEmpty(name)) return false;
            try { primitive = (PrimitiveType)Enum.Parse(typeof(PrimitiveType), name.Trim(), true); return true; }
            catch { return false; }
        }

        public static string PrimitiveOptions()
        {
            return string.Join(", ", Primitives);
        }
    }

    // ── Shared scene helpers ─────────────────────────────────
    // Small helpers the scene actions share: component name
    // lists, the DisallowMultipleComponent check,
    // RequireComponent dependents, unique sibling names, subtree
    // walks, and short value descriptions for messages.
    private static class SceneHelpers
    {
        public static List<string> ComponentNames(GameObject go)
        {
            var names = new List<string>();
            foreach (Component c in go.GetComponents<Component>())
                if (c != null) names.Add(c.GetType().Name);
            return names;
        }

        public static List<string> ComponentNames(List<Type> types)
        {
            var names = new List<string>();
            foreach (Type t in types) names.Add(t.Name);
            return names;
        }

        public static bool HasDisallowMultiple(Type t)
        {
            return t.IsDefined(typeof(DisallowMultipleComponent), true);
        }

        // The [RequireComponent] dependents of a type, one level —
        // what Undo.AddComponent would add on its own.
        public static List<string> RequiredComponentNames(List<Type> types)
        {
            var names = new List<string>();
            foreach (Type t in types)
            {
                foreach (RequireComponent attr in t.GetCustomAttributes(typeof(RequireComponent), true))
                {
                    foreach (Type req in new[] { attr.m_Type0, attr.m_Type1, attr.m_Type2 })
                    {
                        if (req == null) continue;
                        if (names.Contains(req.Name)) continue;
                        names.Add(req.Name);
                    }
                }
            }
            return names;
        }

        public static string UniqueSiblingName(Transform parent, string name)
        {
            try { return GameObjectUtility.GetUniqueNameForSibling(parent, name); }
            catch
            {
                // GetUniqueNameForSibling is believed to accept a
                // null parent for scene roots — if it does not,
                // number by hand the same way.
                var taken = new HashSet<string>();
                if (parent == null)
                {
                    foreach (GameObject root in ComponentLocator.EnumerateRoots()) taken.Add(root.name);
                }
                else
                {
                    foreach (Transform child in parent) taken.Add(child.name);
                }
                if (!taken.Contains(name)) return name;
                int i = 1;
                while (taken.Contains(name + " (" + i + ")")) i++;
                return name + " (" + i + ")";
            }
        }

        public static string DefinedLayers()
        {
            var names = new List<string>();
            for (int i = 0; i < 32; i++)
            {
                string n = LayerMask.LayerToName(i);
                if (!string.IsNullOrEmpty(n)) names.Add(n);
            }
            return string.Join(", ", names.ToArray());
        }

        // The object and every descendant, breadth-first.
        public static List<GameObject> CollectSubtree(GameObject root)
        {
            var collected = new List<GameObject>();
            var queue = new Queue<Transform>();
            queue.Enqueue(root.transform);
            while (queue.Count > 0)
            {
                Transform t = queue.Dequeue();
                collected.Add(t.gameObject);
                foreach (Transform child in t) queue.Enqueue(child);
            }
            return collected;
        }

        // Instance ids of the objects and their components — a
        // serialized field points at the component, not the
        // GameObject, so both belong in the deleted set.
        public static HashSet<int> DeletedInstanceIds(List<GameObject> subtree)
        {
            var ids = new HashSet<int>();
            foreach (GameObject go in subtree)
            {
                ids.Add(go.GetInstanceID());
                foreach (Component c in go.GetComponents<Component>())
                    if (c != null) ids.Add(c.GetInstanceID());
            }
            return ids;
        }

        // A short description of a JSON value for messages.
        public static string DescribeValue(object v)
        {
            if (v == null) return "null";
            return TruncateString(JsonWrite(v) ?? "null", 60);
        }
    }

    // ── set_property ─────────────────────────────────────────
    // Set Inspector values on a scene object, in a batch that is
    // all-or-nothing: every change is staged on an in-memory
    // SerializedObject first, and nothing touches the real
    // component until ApplyModifiedProperties(). One typo in five
    // changes is a clear error and a clean project, never a
    // half-modified one. SerializedObject — not reflection — so
    // the apply records Undo and handles prefab-instance
    // overrides correctly, and one Ctrl+Z per agent turn covers
    // the whole turn (see MutationScope). The app never trusts a
    // flag from the model: it calls dryRun, shows the diff, and
    // only then repeats the identical call with dryRun:false —
    // the bridge just does what it is told. dryRun reports REAL
    // before/after values after normalization, because the
    // changes are staged in memory first. expectedBefore rejects
    // the apply when a property changed since the preview (the
    // user editing in the Inspector while the approval card is
    // open). component "GameObject" targets the GameObject
    // itself (m_Name, m_IsActive, m_TagString, m_Layer) — a
    // rename emits pathChanges, so the app can rewrite later
    // calls to the new path.
    private static class SetPropertyHandler
    {
        private const int MaxChanges = 20;
        private static readonly string[] InternalProperties = { "m_Script", "m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset", "m_GameObject", "m_EditorHideFlags", "m_EditorClassIdentifier" };

        private class StagedChange { public string property; public object before; public object value; }

        public static BridgeResult Handle(string json, Dictionary<string, object> args)
        {
            string path = JStr(args, "path", "");
            if (string.IsNullOrEmpty(path)) return BridgeResult.Error("'path' is required.");
            bool dryRun = JBool(args, "dryRun", false);
            string playError = MutationScope.PlayModeError(args, dryRun);
            if (playError != null) return BridgeResult.Error(playError);
            // Prefab scope (v0.20.0): "prefab" names the asset and
            // "path" is relative to its root. The edit runs as a
            // snapshot-backed transaction — never through the
            // scene's undo group, which cannot cover prefab
            // contents.
            string prefab = JStr(args, "prefab", "");
            if (!string.IsNullOrEmpty(prefab)) return HandlePrefab(args, prefab, path, dryRun);
            List<GameObject> matches = ComponentLocator.FindGameObjects(path);
            if (matches.Count != 1)
                return BridgeResult.Error(matches.Count == 0
                    ? "No GameObject at '" + path + "'. Start with the scene root name."
                    : matches.Count + " objects match '" + path + "'. Use a more specific path.");
            GameObject target = matches[0];
            if (EditorUtility.IsPersistent(target))
                return BridgeResult.Error("'" + path + "' is an asset, not a scene object — set_property only works on scene objects. Use modifyPrefab for prefab assets, or set_property with \"prefab\": \"Assets/…prefab\" for one object inside a prefab.");
            string componentName = JStr(args, "component", "");
            if (string.IsNullOrEmpty(componentName)) return BridgeResult.Error("'component' is required.");
            UnityEngine.Object serializedTarget;
            string resolvedComponent;
            if (string.Equals(componentName, "GameObject", StringComparison.OrdinalIgnoreCase))
            {
                serializedTarget = target;
                resolvedComponent = "GameObject";
            }
            else
            {
                if (!ComponentLocator.TryResolve(args, out Component component, out string locateError))
                    return BridgeResult.Error(locateError);
                serializedTarget = component;
                resolvedComponent = component.GetType().Name;
            }
            List<object> rawChanges = JArr(args, "changes");
            if (rawChanges == null || rawChanges.Count == 0)
                return BridgeResult.Error("'changes' is required — a list of {\"property\": ..., \"value\": ...}.");
            if (rawChanges.Count > MaxChanges)
                return BridgeResult.Error("At most " + MaxChanges + " changes per call — split the batch.");
            var so = new SerializedObject(serializedTarget);
            so.Update();
            List<StagedChange> staged;
            List<string> problems;
            StageChanges(so, rawChanges, resolvedComponent, false, out staged, out problems);
            if (problems.Count > 0)
                return BridgeResult.Error("Nothing was changed — " + problems.Count + " problem(s): " + string.Join(" ", problems.ToArray()));
            string oldPath = ComponentLocator.GetPath(target.transform);
            if (dryRun)
            {
                var data = new Dictionary<string, object>();
                data["path"] = oldPath;
                data["component"] = resolvedComponent;
                data["changes"] = DescribeStaged(so, staged);
                data["dryRun"] = true;
                return BridgeResult.Ok("Preview: " + DescribeChanges(oldPath, resolvedComponent, (List<object>)data["changes"]) + " (nothing changed yet).", null, JsonWrite(data));
            }
            Scene scene = target.scene;
            int undoGroup = MutationScope.BeginUndoGroup(args, "set " + resolvedComponent + " on " + target.name);
            so.ApplyModifiedProperties();
            so.Update();
            // Read-back: confirm what actually landed, and catch a
            // silently rejected reference.
            var afterOut = DescribeStaged(so, staged);
            var readbackProblems = ReadbackProblems(so, staged);
            MutationScope.Commit(undoGroup, scene);
            var resultData = new Dictionary<string, object>();
            resultData["path"] = ComponentLocator.GetPath(target.transform);
            resultData["component"] = resolvedComponent;
            resultData["changes"] = afterOut;
            if (EditorApplication.isPlaying) resultData["playModeWarning"] = MutationScope.PlayModeWarning;
            var pathChanges = new List<object>();
            string newPath = ComponentLocator.GetPath(target.transform);
            if (newPath != oldPath)
            {
                var pc = new Dictionary<string, object>();
                pc["from"] = oldPath;
                pc["to"] = newPath;
                pathChanges.Add(pc);
            }
            resultData["pathChanges"] = pathChanges;
            string message = DescribeChanges(newPath, resolvedComponent, afterOut);
            if (readbackProblems.Count > 0)
                message += " — " + string.Join(" ", readbackProblems.ToArray());
            return BridgeResult.Ok(message, null, JsonWrite(resultData));
        }

        // Prefab scope (v0.20.0): the same stage/validate/apply
        // as the scene flow, but the target lives inside loaded
        // prefab contents, the apply records nothing in Undo
        // (Undo cannot cover prefab contents — the transaction's
        // snapshot is the undo), and a rename emits a path change
        // relative to the prefab root, so the app can rewrite
        // later calls. A prefab cannot hold a scene reference,
        // so one is refused instead of resolving to nothing.
        private static BridgeResult HandlePrefab(Dictionary<string, object> args, string prefab, string path, bool dryRun)
        {
            return PrefabTransactions.Transact(prefab, args, (contents, summary) =>
            {
                GameObject target = FindChild(contents, path);
                if (target == null) return new PrefabTransactions.EditOutcome { Error = "No object '" + path + "' in the prefab." };
                string componentName = JStr(args, "component", "");
                if (string.IsNullOrEmpty(componentName)) return new PrefabTransactions.EditOutcome { Error = "'component' is required." };
                UnityEngine.Object serializedTarget;
                string resolvedComponent;
                if (string.Equals(componentName, "GameObject", StringComparison.OrdinalIgnoreCase))
                {
                    serializedTarget = target;
                    resolvedComponent = "GameObject";
                }
                else
                {
                    if (!ComponentLocator.TryResolveOn(target, componentName, (int)JNum(args, "componentIndex", 0), out Component component, out string locateError))
                        return new PrefabTransactions.EditOutcome { Error = locateError };
                    serializedTarget = component;
                    resolvedComponent = component.GetType().Name;
                }
                List<object> rawChanges = JArr(args, "changes");
                if (rawChanges == null || rawChanges.Count == 0)
                    return new PrefabTransactions.EditOutcome { Error = "'changes' is required — a list of {\"property\": ..., \"value\": ...}." };
                if (rawChanges.Count > MaxChanges)
                    return new PrefabTransactions.EditOutcome { Error = "At most " + MaxChanges + " changes per call — split the batch." };
                var so = new SerializedObject(serializedTarget);
                so.Update();
                List<StagedChange> staged;
                List<string> problems;
                StageChanges(so, rawChanges, resolvedComponent, true, out staged, out problems);
                if (problems.Count > 0)
                    return new PrefabTransactions.EditOutcome { Error = "Nothing was changed — " + problems.Count + " problem(s): " + string.Join(" ", problems.ToArray()) };
                string oldPath = ComponentLocator.GetPath(target.transform);
                var data = new Dictionary<string, object>();
                data["prefab"] = prefab;
                data["path"] = oldPath;
                data["component"] = resolvedComponent;
                data["changes"] = DescribeStaged(so, staged);
                if (dryRun)
                {
                    data["dryRun"] = true;
                    return new PrefabTransactions.EditOutcome
                    {
                        Message = "Preview: " + DescribeChanges(oldPath, resolvedComponent, (List<object>)data["changes"]) + " (nothing changed yet).",
                        Data = data,
                    };
                }
                // ApplyModifiedPropertiesWithoutUndo: Undo cannot
                // cover objects inside prefab contents, and the
                // transaction's snapshot is the undo — recording
                // Undo here would leave dead entries behind.
                so.ApplyModifiedPropertiesWithoutUndo();
                so.Update();
                var afterOut = DescribeStaged(so, staged);
                var readbackProblems = ReadbackProblems(so, staged);
                data["changes"] = afterOut;
                string newPath = ComponentLocator.GetPath(target.transform);
                data["path"] = newPath;
                if (EditorApplication.isPlaying) data["playModeWarning"] = MutationScope.PlayModeWarning;
                var pathChanges = new List<object>();
                if (newPath != oldPath)
                {
                    var pc = new Dictionary<string, object>();
                    pc["from"] = oldPath;
                    pc["to"] = newPath;
                    pathChanges.Add(pc);
                }
                data["pathChanges"] = pathChanges;
                string message = DescribeChanges(newPath, resolvedComponent, afterOut);
                if (readbackProblems.Count > 0)
                    message += " — " + string.Join(" ", readbackProblems.ToArray());
                summary.Add(message);
                return new PrefabTransactions.EditOutcome { Message = message, Data = data };
            });
        }

        // Stage everything in memory first. Nothing is applied
        // until every change validates — one typo fails the whole
        // call. Shared by the scene flow and the prefab flow;
        // prefabScope refuses scene-object references (a prefab
        // cannot hold one) instead of resolving them.
        private static void StageChanges(SerializedObject so, List<object> rawChanges, string resolvedComponent, bool prefabScope, out List<StagedChange> staged, out List<string> problems)
        {
            staged = new List<StagedChange>();
            problems = new List<string>();
            foreach (object raw in rawChanges)
            {
                var change = raw as Dictionary<string, object>;
                if (change == null) { problems.Add("Each change must be an object {\"property\": ..., \"value\": ...}."); continue; }
                string property = JStr(change, "property", "");
                if (string.IsNullOrEmpty(property)) { problems.Add("Each change needs a \"property\" name."); continue; }
                SerializedProperty p = so.FindProperty(property);
                if (p == null)
                {
                    problems.Add("Unknown property '" + property + "' on " + resolvedComponent + "." + SimilarPropertiesText(so, property));
                    continue;
                }
                if (p.name == "m_Script") { problems.Add("'m_Script' cannot be set — it is the script reference itself."); continue; }
                if (IsInternalProperty(p.name)) { problems.Add("'" + property + "' is an internal property and cannot be set."); continue; }
                object before = ReadComponentValuesHandler.ReadProperty(p, 0);
                object expected = null;
                bool hasExpected = change.TryGetValue("expectedBefore", out expected) && expected != null;
                if (hasExpected && !ExpectedMatches(p, before, expected, prefabScope))
                {
                    problems.Add("'" + property + "' changed since the preview (expected " + SceneHelpers.DescribeValue(expected) + ", now " + SceneHelpers.DescribeValue(before) + ") — run the preview again.");
                    continue;
                }
                object value = change.ContainsKey("value") ? change["value"] : null;
                string assignError;
                if (!TryAssignProperty(p, value, out assignError, prefabScope))
                {
                    problems.Add(assignError);
                    continue;
                }
                staged.Add(new StagedChange { property = property, before = before, value = value });
            }
        }

        // Read-back after the apply: confirm what actually
        // landed, and catch a silently rejected reference.
        private static List<string> ReadbackProblems(SerializedObject so, List<StagedChange> staged)
        {
            var readbackProblems = new List<string>();
            foreach (StagedChange s in staged)
            {
                SerializedProperty p = so.FindProperty(s.property);
                if (p != null && p.propertyType == SerializedPropertyType.ObjectReference && s.value != null)
                {
                    object after = ReadComponentValuesHandler.ReadProperty(p, 0);
                    if (after == null)
                        readbackProblems.Add("'" + s.property + "': Unity rejected the reference — the assigned object is not compatible with this property.");
                }
            }
            return readbackProblems;
        }

        private static List<object> DescribeStaged(SerializedObject so, List<StagedChange> staged)
        {
            var out_ = new List<object>();
            foreach (StagedChange s in staged)
            {
                SerializedProperty p = so.FindProperty(s.property);
                var d = new Dictionary<string, object>();
                d["property"] = s.property;
                d["before"] = s.before;
                d["after"] = p != null ? ReadComponentValuesHandler.ReadProperty(p, 0) : null;
                out_.Add(d);
            }
            return out_;
        }

        private static string DescribeChanges(string path, string component, List<object> changes)
        {
            var parts = new List<string>();
            foreach (object raw in changes)
            {
                var d = raw as Dictionary<string, object>;
                if (d == null) continue;
                parts.Add(JStr(d, "property", "?") + " " + SceneHelpers.DescribeValue(d["before"]) + " → " + SceneHelpers.DescribeValue(d["after"]));
            }
            return path + " / " + component + ": " + string.Join(", ", parts.ToArray());
        }

        private static bool IsInternalProperty(string name)
        {
            foreach (string n in InternalProperties) if (n == name) return true;
            return false;
        }

        private static string SimilarPropertiesText(SerializedObject so, string wanted)
        {
            var names = new List<string>();
            SerializedProperty it = so.GetIterator();
            if (it.NextVisible(true))
            {
                do { if (!IsInternalProperty(it.name)) names.Add(it.name); }
                while (it.NextVisible(false));
            }
            var scored = new List<KeyValuePair<string, int>>();
            foreach (string name in names)
            {
                int d;
                if (name.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0) d = 0;
                else d = LevenshteinDistance(name.ToLowerInvariant(), wanted.ToLowerInvariant());
                if (d <= 2) scored.Add(new KeyValuePair<string, int>(name, d));
            }
            scored.Sort((a, b) => a.Value != b.Value ? a.Value.CompareTo(b.Value) : string.Compare(a.Key, b.Key, StringComparison.Ordinal));
            var result = new List<string>();
            foreach (var kv in scored) { if (result.Count >= 8) break; result.Add(kv.Key); }
            return result.Count > 0 ? " Similar: " + string.Join(", ", result.ToArray()) + "." : "";
        }

        private static int LevenshteinDistance(string a, string b)
        {
            if (string.IsNullOrEmpty(a)) return string.IsNullOrEmpty(b) ? 0 : b.Length;
            if (string.IsNullOrEmpty(b)) return a.Length;
            int[] prev = new int[b.Length + 1];
            int[] cur = new int[b.Length + 1];
            for (int j = 0; j <= b.Length; j++) prev[j] = j;
            for (int i = 1; i <= a.Length; i++)
            {
                cur[0] = i;
                for (int j = 1; j <= b.Length; j++)
                {
                    int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                    cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                }
                int[] tmp = prev; prev = cur; cur = tmp;
            }
            return prev[b.Length];
        }

        // One JSON value as N numbers (a JSON array of numbers).
        // Internal so create_gameobject and create_material share it.
        internal static bool TryReadNumbers(object v, int count, out float[] nums)
        {
            nums = null;
            var list = v as List<object>;
            if (list == null || list.Count != count) return false;
            var result = new float[count];
            for (int i = 0; i < count; i++)
            {
                if (list[i] is double) result[i] = (float)(double)list[i];
                else if (list[i] is string)
                {
                    float f;
                    if (!float.TryParse((string)list[i], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out f)) return false;
                    result[i] = f;
                }
                else return false;
            }
            nums = result;
            return true;
        }

        // A colour as "#RRGGBB" (or "#RRGGBBAA") or [r, g, b] /
        // [r, g, b, a]. Internal so create_material shares it.
        internal static bool TryParseColor(object value, out Color color)
        {
            color = Color.white;
            if (value is string)
            {
                string s = ((string)value).Trim();
                if (s.StartsWith("#")) s = s.Substring(1);
                if (s.Length == 6 || s.Length == 8)
                {
                    int r, g, b, a = 255;
                    if (int.TryParse(s.Substring(0, 2), System.Globalization.NumberStyles.HexNumber, null, out r)
                        && int.TryParse(s.Substring(2, 2), System.Globalization.NumberStyles.HexNumber, null, out g)
                        && int.TryParse(s.Substring(4, 2), System.Globalization.NumberStyles.HexNumber, null, out b)
                        && (s.Length == 6 || int.TryParse(s.Substring(6, 2), System.Globalization.NumberStyles.HexNumber, null, out a)))
                    {
                        color = new Color(r / 255f, g / 255f, b / 255f, a / 255f);
                        return true;
                    }
                }
                return false;
            }
            float[] nums;
            if (TryReadNumbers(value, 3, out nums)) { color = new Color(nums[0], nums[1], nums[2], 1f); return true; }
            if (TryReadNumbers(value, 4, out nums)) { color = new Color(nums[0], nums[1], nums[2], nums[3]); return true; }
            return false;
        }

        internal static bool TryAsDouble(object v, out double d)
        {
            d = 0;
            if (v is double) { d = (double)v; return true; }
            if (v is long) { d = (long)v; return true; }
            if (v is int) { d = (int)v; return true; }
            if (v is string)
            {
                double f;
                if (double.TryParse((string)v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out f)) { d = f; return true; }
            }
            return false;
        }

        // Resolve an object reference value: an asset path
        // ("Assets/…", sub-assets included) or a scene object path.
        // Null when nothing is found there. A prefab cannot hold
        // a scene reference, so allowScene:false resolves asset
        // paths only — a scene path in prefab scope is null, and
        // the caller refuses it plainly instead of guessing.
        internal static UnityEngine.Object ResolveObjectReference(object value)
        {
            return ResolveObjectReference(value, true);
        }

        internal static UnityEngine.Object ResolveObjectReference(object value, bool allowScene)
        {
            if (!(value is string)) return null;
            string s = (string)value;
            if (string.IsNullOrEmpty(s)) return null;
            if (s.StartsWith("Assets/", StringComparison.Ordinal))
            {
                UnityEngine.Object asset = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(s);
                if (asset != null) return asset;
                UnityEngine.Object[] all = AssetDatabase.LoadAllAssetsAtPath(s);
                if (all != null)
                {
                    foreach (UnityEngine.Object o in all)
                        if (o != null) return o;
                }
                return null;
            }
            if (!allowScene) return null;
            List<GameObject> matches = ComponentLocator.FindGameObjects(s);
            if (matches.Count == 1) return matches[0];
            return null;
        }

        // Does the current value still match what the preview saw?
        // Numbers compare with a small tolerance; enums by name or
        // index; vectors and colours element-wise; object
        // references by resolving the expected path and comparing
        // objects. An expected value that cannot be resolved (an
        // object reference whose path no longer exists) cannot be
        // checked — it does not block the apply. In prefab scope
        // a scene path never resolves (a prefab cannot hold one),
        // so it cannot be checked either.
        private static bool ExpectedMatches(SerializedProperty p, object before, object expected, bool prefabScope)
        {
            if (before == null || expected == null) return before == null && expected == null;
            if (before is double || before is long || before is int)
            {
                double b, e;
                if (!TryAsDouble(before, out b) || !TryAsDouble(expected, out e)) return false;
                return Math.Abs(b - e) < 0.0001;
            }
            if (before is bool) return expected is bool && (bool)before == (bool)expected;
            if (before is string)
            {
                if (p.propertyType == SerializedPropertyType.Enum)
                {
                    string name = NormalizeEnumName(p, expected);
                    if (name == null) return false;
                    return string.Equals((string)before, name, StringComparison.Ordinal);
                }
                if (p.propertyType == SerializedPropertyType.ObjectReference || p.propertyType == SerializedPropertyType.ExposedReference)
                {
                    UnityEngine.Object wanted = ResolveObjectReference(expected, !prefabScope);
                    if (wanted == null) return true;
                    return p.objectReferenceValue == wanted;
                }
                return expected is string && string.Equals((string)before, (string)expected, StringComparison.Ordinal);
            }
            if (before is List<object>)
            {
                var bl = (List<object>)before;
                var el = expected as List<object>;
                if (el == null || el.Count != bl.Count) return false;
                for (int i = 0; i < bl.Count; i++)
                {
                    double b, e;
                    if (!TryAsDouble(bl[i], out b) || !TryAsDouble(el[i], out e)) return false;
                    if (Math.Abs(b - e) >= 0.0001) return false;
                }
                return true;
            }
            // Bounds / generic shapes: compare the JSON forms.
            return JsonWrite(before) == JsonWrite(expected);
        }

        private static string NormalizeEnumName(SerializedProperty p, object expected)
        {
            string[] names = p.enumNames;
            if (names == null) return null;
            if (expected is string)
            {
                string wanted = (string)expected;
                for (int i = 0; i < names.Length; i++)
                    if (string.Equals(names[i], wanted, StringComparison.OrdinalIgnoreCase)) return names[i];
                return null;
            }
            double d;
            if (TryAsDouble(expected, out d) && Math.Abs(d - Math.Round(d)) < 0.0001)
            {
                int idx = (int)Math.Round(d);
                if (idx >= 0 && idx < names.Length) return names[idx];
            }
            return null;
        }

        // Is the property's enum a [Flags] enum? The serialized
        // field name maps to a field on the target type (or, for
        // built-ins, an internal field) — walk the hierarchy.
        private static bool IsFlagsEnum(SerializedProperty p)
        {
            UnityEngine.Object target = p.serializedObject.targetObject;
            if (target == null) return false;
            Type t = target.GetType();
            string fieldName = p.propertyPath;
            int dot = fieldName.IndexOf('.');
            if (dot >= 0) fieldName = fieldName.Substring(0, dot);
            for (Type cur = t; cur != null && cur != typeof(object); cur = cur.BaseType)
            {
                FieldInfo f = cur.GetField(fieldName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly);
                if (f != null)
                {
                    Type ft = f.FieldType;
                    if (ft.IsEnum) return ft.IsDefined(typeof(FlagsAttribute), false);
                    return false;
                }
            }
            return false;
        }

        private static bool TryAssignProperty(SerializedProperty p, object value, out string error, bool prefabScope)
        {
            error = null;
            switch (p.propertyType)
            {
                case SerializedPropertyType.Integer:
                    {
                        double d;
                        if (!TryAsDouble(value, out d) || Math.Abs(d - Math.Round(d)) > 0.0001) { error = "'" + p.propertyPath + "' needs a whole number — got " + SceneHelpers.DescribeValue(value) + "."; return false; }
                        p.longValue = (long)Math.Round(d);
                        return true;
                    }
                case SerializedPropertyType.Boolean:
                    {
                        if (!(value is bool)) { error = "'" + p.propertyPath + "' needs true or false — got " + SceneHelpers.DescribeValue(value) + "."; return false; }
                        p.boolValue = (bool)value;
                        return true;
                    }
                case SerializedPropertyType.Float:
                    {
                        double d;
                        if (!TryAsDouble(value, out d)) { error = "'" + p.propertyPath + "' needs a number — got " + SceneHelpers.DescribeValue(value) + "."; return false; }
                        p.doubleValue = d;
                        return true;
                    }
                case SerializedPropertyType.String:
                    {
                        p.stringValue = value == null ? "" : value.ToString();
                        return true;
                    }
                case SerializedPropertyType.Enum:
                    {
                        string[] names = p.enumNames;
                        if (IsFlagsEnum(p))
                        {
                            error = "'" + p.propertyPath + "' is a flags enum — it cannot be set by name or index. Set the underlying integer through a script instead.";
                            return false;
                        }
                        if (value is string)
                        {
                            string wanted = (string)value;
                            for (int i = 0; i < names.Length; i++)
                                if (string.Equals(names[i], wanted, StringComparison.OrdinalIgnoreCase)) { p.enumValueIndex = i; return true; }
                            error = "'" + p.propertyPath + "' has no option '" + wanted + "' — valid options: " + string.Join(", ", names) + ".";
                            return false;
                        }
                        double d;
                        if (TryAsDouble(value, out d) && Math.Abs(d - Math.Round(d)) < 0.0001)
                        {
                            int idx = (int)Math.Round(d);
                            if (idx < 0 || idx >= names.Length) { error = "'" + p.propertyPath + "' has no option at index " + idx + " — valid indexes are 0–" + (names.Length - 1) + " (" + string.Join(", ", names) + ")."; return false; }
                            p.enumValueIndex = idx;
                            return true;
                        }
                        error = "'" + p.propertyPath + "' needs an enum name or index — got " + SceneHelpers.DescribeValue(value) + ". Valid options: " + string.Join(", ", names) + ".";
                        return false;
                    }
                case SerializedPropertyType.Vector2:
                case SerializedPropertyType.Vector3:
                case SerializedPropertyType.Vector4:
                    {
                        int n = p.propertyType == SerializedPropertyType.Vector2 ? 2 : p.propertyType == SerializedPropertyType.Vector3 ? 3 : 4;
                        float[] nums;
                        if (!TryReadNumbers(value, n, out nums)) { error = "'" + p.propertyPath + "' needs an array of " + n + " numbers — got " + SceneHelpers.DescribeValue(value) + "."; return false; }
                        if (n == 2) p.vector2Value = new Vector2(nums[0], nums[1]);
                        else if (n == 3) p.vector3Value = new Vector3(nums[0], nums[1], nums[2]);
                        else p.vector4Value = new Vector4(nums[0], nums[1], nums[2], nums[3]);
                        return true;
                    }
                case SerializedPropertyType.Vector2Int:
                case SerializedPropertyType.Vector3Int:
                    {
                        int n = p.propertyType == SerializedPropertyType.Vector2Int ? 2 : 3;
                        float[] nums;
                        if (!TryReadNumbers(value, n, out nums)) { error = "'" + p.propertyPath + "' needs an array of " + n + " whole numbers — got " + SceneHelpers.DescribeValue(value) + "."; return false; }
                        if (n == 2) p.vector2IntValue = new Vector2Int((int)nums[0], (int)nums[1]);
                        else p.vector3IntValue = new Vector3Int((int)nums[0], (int)nums[1], (int)nums[2]);
                        return true;
                    }
                case SerializedPropertyType.Rect:
                    {
                        float[] nums;
                        if (!TryReadNumbers(value, 4, out nums)) { error = "'" + p.propertyPath + "' needs an array of 4 numbers [x, y, width, height] — got " + SceneHelpers.DescribeValue(value) + "."; return false; }
                        p.rectValue = new Rect(nums[0], nums[1], nums[2], nums[3]);
                        return true;
                    }
                case SerializedPropertyType.Quaternion:
                    {
                        float[] nums;
                        if (!TryReadNumbers(value, 3, out nums)) { error = "'" + p.propertyPath + "' needs euler angles as [x, y, z] in degrees — got " + SceneHelpers.DescribeValue(value) + "."; return false; }
                        p.quaternionValue = Quaternion.Euler(nums[0], nums[1], nums[2]);
                        return true;
                    }
                case SerializedPropertyType.Color:
                    {
                        Color c;
                        if (!TryParseColor(value, out c)) { error = "'" + p.propertyPath + "' needs a color as \"#RRGGBB\" (or \"#RRGGBBAA\") or [r, g, b] / [r, g, b, a] — got " + SceneHelpers.DescribeValue(value) + "."; return false; }
                        p.colorValue = c;
                        return true;
                    }
                case SerializedPropertyType.ObjectReference:
                case SerializedPropertyType.ExposedReference:
                    {
                        if (value == null) { p.objectReferenceValue = null; return true; }
                        if (!(value is string)) { error = "'" + p.propertyPath + "' needs an asset path (\"Assets/…\") or a scene object path — got " + SceneHelpers.DescribeValue(value) + "."; return false; }
                        string s = (string)value;
                        if (prefabScope && !s.StartsWith("Assets/", StringComparison.Ordinal))
                        {
                            error = "'" + p.propertyPath + "': a prefab cannot reference a scene object — use an asset path (\"Assets/…\").";
                            return false;
                        }
                        UnityEngine.Object obj = ResolveObjectReference(s);
                        if (obj == null) { error = "'" + p.propertyPath + "': nothing found at '" + s + "' — asset paths start with Assets/, scene paths start with the scene root name."; return false; }
                        p.objectReferenceValue = obj;
                        return true;
                    }
                case SerializedPropertyType.LayerMask:
                    {
                        double d;
                        if (!TryAsDouble(value, out d)) { error = "'" + p.propertyPath + "' needs a layer mask number — got " + SceneHelpers.DescribeValue(value) + "."; return false; }
                        p.intValue = (int)Math.Round(d);
                        return true;
                    }
                case SerializedPropertyType.Character:
                    {
                        double d;
                        if (!TryAsDouble(value, out d)) { error = "'" + p.propertyPath + "' needs a number — got " + SceneHelpers.DescribeValue(value) + "."; return false; }
                        p.intValue = (int)Math.Round(d);
                        return true;
                    }
                default:
                    error = "'" + p.propertyPath + "' is a " + p.propertyType + " property — CodeFox cannot set that type yet.";
                    return false;
            }
        }
    }

    // ── create_gameobject ────────────────────────────────────
    // Create a scene object. Everything is validated first —
    // parent, primitive, component types, tag, layer, vectors —
    // and creation starts only once all of it is valid, so a
    // typo means "Nothing was created", never a half-built
    // object. Names are unique among siblings (Unity's
    // GetUniqueNameForSibling, with a hand-numbered fallback) and
    // the result reports the final path, so the model never
    // guesses where the object ended up. Components go on with
    // Undo.AddComponent, which records Undo AND auto-adds
    // [RequireComponent] dependencies — reported as alsoAdded, so
    // the model learns why it got two components for one request.
    // Create takes NO property values: set_property stays the
    // only place for property validation and dry-run, so a bad
    // value cannot leave a half-configured object behind.
    private static class CreateGameObjectHandler
    {
        private const int MaxComponents = 10;

        public static BridgeResult Handle(string json, Dictionary<string, object> args)
        {
            string name = JStr(args, "name", "").Trim();
            if (string.IsNullOrEmpty(name)) return BridgeResult.Error("'name' is required.");
            if (name.IndexOf('/') >= 0) return BridgeResult.Error("A name cannot contain '/' — it would corrupt the hierarchy path.");
            bool dryRun = JBool(args, "dryRun", false);
            string playError = MutationScope.PlayModeError(args, dryRun);
            if (playError != null) return BridgeResult.Error(playError);
            string parentPath = JStr(args, "parent", "");
            GameObject parentGO = null;
            Transform parentT = null;
            if (!string.IsNullOrEmpty(parentPath))
            {
                List<GameObject> pm = ComponentLocator.FindGameObjects(parentPath);
                if (pm.Count != 1)
                    return BridgeResult.Error(pm.Count == 0
                        ? "No GameObject at '" + parentPath + "' — the parent must exist."
                        : pm.Count + " objects match '" + parentPath + "'. Use a more specific path.");
                parentGO = pm[0];
                if (EditorUtility.IsPersistent(parentGO))
                    return BridgeResult.Error("'" + parentPath + "' is an asset, not a scene object — a new object needs a scene parent.");
                parentT = parentGO.transform;
            }
            string primitiveName = JStr(args, "primitive", "");
            PrimitiveType primitive = PrimitiveType.Cube;
            bool hasPrimitive = false;
            if (!string.IsNullOrEmpty(primitiveName))
            {
                if (!ComponentTypeResolver.IsPrimitive(primitiveName, out primitive))
                    return BridgeResult.Error("Unknown primitive '" + primitiveName + "' — options: " + ComponentTypeResolver.PrimitiveOptions() + ".");
                hasPrimitive = true;
            }
            float[] position = null, rotation = null, scale = null;
            object posRaw;
            if (args.TryGetValue("position", out posRaw) && posRaw != null && !SetPropertyHandler.TryReadNumbers(posRaw, 3, out position))
                return BridgeResult.Error("'position' must be [x, y, z] — got " + SceneHelpers.DescribeValue(posRaw) + ".");
            object rotRaw;
            if (args.TryGetValue("rotation", out rotRaw) && rotRaw != null && !SetPropertyHandler.TryReadNumbers(rotRaw, 3, out rotation))
                return BridgeResult.Error("'rotation' must be [x, y, z] euler degrees — got " + SceneHelpers.DescribeValue(rotRaw) + ".");
            object scaleRaw;
            if (args.TryGetValue("scale", out scaleRaw) && scaleRaw != null && !SetPropertyHandler.TryReadNumbers(scaleRaw, 3, out scale))
                return BridgeResult.Error("'scale' must be [x, y, z] — got " + SceneHelpers.DescribeValue(scaleRaw) + ".");
            string tag = JStr(args, "tag", "");
            if (!string.IsNullOrEmpty(tag))
            {
                bool known = false;
                foreach (string t in InternalEditorUtility.tags) if (t == tag) { known = true; break; }
                if (!known) return BridgeResult.Error("Unknown tag '" + tag + "' — use a tag defined in Project Settings → Tags and Layers.");
            }
            string layerName = JStr(args, "layer", "");
            int layer = -1;
            if (!string.IsNullOrEmpty(layerName))
            {
                layer = LayerMask.NameToLayer(layerName);
                if (layer < 0) return BridgeResult.Error("Unknown layer '" + layerName + "' — use a layer defined in Project Settings → Tags and Layers (" + SceneHelpers.DefinedLayers() + ").");
            }
            bool active = JBool(args, "active", true);
            List<object> rawComponents = JArr(args, "components");
            var componentTypes = new List<Type>();
            if (rawComponents != null)
            {
                if (rawComponents.Count > MaxComponents) return BridgeResult.Error("At most " + MaxComponents + " components per call.");
                foreach (object raw in rawComponents)
                {
                    string typeName = raw != null ? raw.ToString() : "";
                    if (string.IsNullOrEmpty(typeName)) return BridgeResult.Error("Each component must be a type name.");
                    if (string.Equals(typeName, "Transform", StringComparison.OrdinalIgnoreCase))
                        return BridgeResult.Error("'Transform' cannot be added — every GameObject already has one.");
                    Type t;
                    string resolveError;
                    if (!ComponentTypeResolver.TryResolve(typeName, out t, out resolveError))
                        return BridgeResult.Error(resolveError);
                    componentTypes.Add(t);
                }
                // DisallowMultipleComponent duplicates — against
                // the requested list and against what the primitive
                // already brings (MeshFilter, MeshRenderer, a
                // collider).
                var existing = new List<Type>();
                existing.Add(typeof(Transform));
                if (hasPrimitive)
                {
                    existing.Add(typeof(MeshFilter));
                    existing.Add(typeof(MeshRenderer));
                    if (primitive == PrimitiveType.Cube) existing.Add(typeof(BoxCollider));
                    else if (primitive == PrimitiveType.Sphere) existing.Add(typeof(SphereCollider));
                    else if (primitive == PrimitiveType.Capsule || primitive == PrimitiveType.Cylinder) existing.Add(typeof(CapsuleCollider));
                    else if (primitive == PrimitiveType.Plane || primitive == PrimitiveType.Quad) existing.Add(typeof(MeshCollider));
                }
                foreach (Type t in componentTypes)
                {
                    if (!SceneHelpers.HasDisallowMultiple(t)) continue;
                    int count = 0;
                    foreach (Type e in existing) if (e == t) count++;
                    foreach (Type c in componentTypes) if (c == t) count++;
                    if (count > 1) return BridgeResult.Error("'" + t.Name + "' cannot be added twice (DisallowMultipleComponent) — it is already on the new object or listed twice.");
                }
            }
            string finalName = SceneHelpers.UniqueSiblingName(parentT, name);
            bool renamed = finalName != name;
            string finalPath = parentT == null ? finalName : ComponentLocator.GetPath(parentT) + "/" + finalName;
            if (dryRun)
            {
                var data = new Dictionary<string, object>();
                data["path"] = finalPath;
                data["renamed"] = renamed;
                data["components"] = SceneHelpers.ComponentNames(componentTypes);
                data["alsoAdded"] = SceneHelpers.RequiredComponentNames(componentTypes);
                data["dryRun"] = true;
                return BridgeResult.Ok("Preview: create '" + finalPath + "'" + (renamed ? " (renamed — '" + name + "' was taken)" : "") + " with " + componentTypes.Count + " component(s) (nothing created yet).", null, JsonWrite(data));
            }
            Scene scene = parentT != null ? parentT.gameObject.scene : SceneManager.GetActiveScene();
            int undoGroup = MutationScope.BeginUndoGroup(args, "create " + finalName);
            GameObject go = hasPrimitive ? GameObject.CreatePrimitive(primitive) : new GameObject();
            go.name = finalName;
            Undo.RegisterCreatedObjectUndo(go, "Agent: create " + finalName);
            go.transform.SetParent(parentT, false);
            if (position != null) go.transform.localPosition = new Vector3(position[0], position[1], position[2]);
            if (rotation != null) go.transform.localEulerAngles = new Vector3(rotation[0], rotation[1], rotation[2]);
            if (scale != null) go.transform.localScale = new Vector3(scale[0], scale[1], scale[2]);
            if (!string.IsNullOrEmpty(tag)) go.tag = tag;
            if (layer >= 0) go.layer = layer;
            var addedNames = new List<string>();
            var alsoAdded = new List<string>();
            foreach (Type t in componentTypes)
            {
                var beforeNames = SceneHelpers.ComponentNames(go);
                Component added = Undo.AddComponent(go, t);
                if (added == null)
                {
                    Undo.DestroyObjectImmediate(go);
                    return BridgeResult.Error("Could not add '" + t.Name + "' — for example a 2D collider conflicts with a 3D one. Nothing was created.");
                }
                addedNames.Add(t.Name);
                foreach (string n in SceneHelpers.ComponentNames(go))
                    if (n != t.Name && !beforeNames.Contains(n) && !alsoAdded.Contains(n)) alsoAdded.Add(n);
            }
            go.SetActive(active);
            MutationScope.Commit(undoGroup, scene);
            var resultData = new Dictionary<string, object>();
            resultData["path"] = ComponentLocator.GetPath(go.transform);
            resultData["renamed"] = renamed;
            resultData["components"] = addedNames;
            resultData["alsoAdded"] = alsoAdded;
            if (EditorApplication.isPlaying) resultData["playModeWarning"] = MutationScope.PlayModeWarning;
            return BridgeResult.Ok("Created '" + ComponentLocator.GetPath(go.transform) + "'" + (renamed ? " (renamed — '" + name + "' was taken)" : "") + " with " + addedNames.Count + " component(s)" + (alsoAdded.Count > 0 ? " (also added: " + string.Join(", ", alsoAdded.ToArray()) + ")" : "") + ".", null, JsonWrite(resultData));
        }
    }

    // ── add_component ────────────────────────────────────────
    // Add one component to a scene object. Undo.AddComponent
    // records Undo AND auto-adds [RequireComponent] dependencies,
    // reported as alsoAdded. A script the model just wrote is not
    // resolvable until the project compiles — the type error says
    // so instead of guessing.
    private static class AddComponentHandler
    {
        public static BridgeResult Handle(string json, Dictionary<string, object> args)
        {
            string path = JStr(args, "path", "");
            if (string.IsNullOrEmpty(path)) return BridgeResult.Error("'path' is required.");
            bool dryRun = JBool(args, "dryRun", false);
            string playError = MutationScope.PlayModeError(args, dryRun);
            if (playError != null) return BridgeResult.Error(playError);
            List<GameObject> matches = ComponentLocator.FindGameObjects(path);
            if (matches.Count != 1)
                return BridgeResult.Error(matches.Count == 0
                    ? "No GameObject at '" + path + "'. Start with the scene root name."
                    : matches.Count + " objects match '" + path + "'. Use a more specific path.");
            GameObject target = matches[0];
            if (EditorUtility.IsPersistent(target))
                return BridgeResult.Error("'" + path + "' is an asset, not a scene object — add_component only works on scene objects.");
            string typeName = JStr(args, "type", "");
            if (string.IsNullOrEmpty(typeName)) return BridgeResult.Error("'type' is required.");
            if (string.Equals(typeName, "Transform", StringComparison.OrdinalIgnoreCase))
                return BridgeResult.Error("'Transform' cannot be added — every GameObject already has one.");
            Type type;
            string resolveError;
            if (!ComponentTypeResolver.TryResolve(typeName, out type, out resolveError))
                return BridgeResult.Error(resolveError);
            if (SceneHelpers.HasDisallowMultiple(type))
            {
                foreach (Component c in target.GetComponents<Component>())
                    if (c != null && c.GetType() == type)
                        return BridgeResult.Error("'" + type.Name + "' is already on '" + path + "' and cannot be added twice (DisallowMultipleComponent).");
            }
            if (dryRun)
            {
                var data = new Dictionary<string, object>();
                data["path"] = ComponentLocator.GetPath(target.transform);
                data["type"] = type.FullName;
                data["alsoAdded"] = SceneHelpers.RequiredComponentNames(new List<Type> { type });
                data["dryRun"] = true;
                return BridgeResult.Ok("Preview: add '" + type.Name + "' to '" + path + "' (nothing added yet).", null, JsonWrite(data));
            }
            Scene scene = target.scene;
            int undoGroup = MutationScope.BeginUndoGroup(args, "add " + type.Name + " to " + target.name);
            var beforeNames = SceneHelpers.ComponentNames(target);
            Component added = Undo.AddComponent(target, type);
            if (added == null)
                return BridgeResult.Error("Could not add '" + type.Name + "' to '" + path + "' — for example a 2D collider conflicts with a 3D one. Nothing was added.");
            var alsoAdded = new List<string>();
            foreach (string n in SceneHelpers.ComponentNames(target))
                if (n != type.Name && !beforeNames.Contains(n) && !alsoAdded.Contains(n)) alsoAdded.Add(n);
            MutationScope.Commit(undoGroup, scene);
            var resultData = new Dictionary<string, object>();
            resultData["path"] = ComponentLocator.GetPath(target.transform);
            resultData["component"] = type.Name;
            resultData["alsoAdded"] = alsoAdded;
            resultData["components"] = SceneHelpers.ComponentNames(target);
            if (EditorApplication.isPlaying) resultData["playModeWarning"] = MutationScope.PlayModeWarning;
            return BridgeResult.Ok("Added '" + type.Name + "' to '" + path + "'" + (alsoAdded.Count > 0 ? " (also added: " + string.Join(", ", alsoAdded.ToArray()) + ")" : "") + ". Use read_component_values and set_property to configure it.", null, JsonWrite(resultData));
        }
    }

    // ── delete_gameobject ────────────────────────────────────
    // Delete a scene object and its subtree. The preview shows
    // what is ACTUALLY lost — the object count and component
    // types, plus the inbound references (other scene components
    // pointing at anything being deleted, serialized fields and
    // UnityEvent targets alike — after the delete those show as
    // "Missing"). The inbound scan walks every component in every
    // loaded scene under a 1.5s budget and says so when it runs
    // out of time, so the count is an honest lower bound.
    // expectedLostObjects is a staleness guard: the app copies
    // lostObjects from the preview into the real call, and Unity
    // refuses when the subtree changed in between. Unity blocks
    // deleting a non-root child of a prefab instance (except one
    // the user added) — the error says what to do instead.
    private static class DeleteGameObjectHandler
    {
        private const double ReferenceScanBudgetSeconds = 1.5;

        public static BridgeResult Handle(string json, Dictionary<string, object> args)
        {
            string path = JStr(args, "path", "");
            if (string.IsNullOrEmpty(path)) return BridgeResult.Error("'path' is required.");
            bool dryRun = JBool(args, "dryRun", false);
            string playError = MutationScope.PlayModeError(args, dryRun);
            if (playError != null) return BridgeResult.Error(playError);
            List<GameObject> matches = ComponentLocator.FindGameObjects(path);
            if (matches.Count != 1)
                return BridgeResult.Error(matches.Count == 0
                    ? "No GameObject at '" + path + "'. Start with the scene root name."
                    : matches.Count + " objects match '" + path + "'. Use a more specific path.");
            GameObject target = matches[0];
            if (PrefabUtility.IsPartOfPrefabInstance(target) && !PrefabUtility.IsOutermostPrefabInstanceRoot(target) && !PrefabUtility.IsAddedGameObjectOverride(target))
                return BridgeResult.Error("'" + path + "' is a child of a prefab instance — Unity does not allow deleting it. Delete the whole instance, edit the prefab asset, or disable the object instead.");
            var subtree = SceneHelpers.CollectSubtree(target);
            var lostObjects = new List<object>();
            foreach (GameObject go in subtree)
            {
                var d = new Dictionary<string, object>();
                d["path"] = ComponentLocator.GetPath(go.transform);
                d["components"] = SceneHelpers.ComponentNames(go);
                lostObjects.Add(d);
            }
            if (dryRun)
            {
                var deletedIds = SceneHelpers.DeletedInstanceIds(subtree);
                bool scanComplete;
                var inbound = ScanInboundReferences(deletedIds, out scanComplete);
                var data = new Dictionary<string, object>();
                data["path"] = path;
                data["lostCount"] = subtree.Count;
                data["lostObjects"] = lostObjects;
                data["inboundReferences"] = inbound;
                data["scanComplete"] = scanComplete;
                data["isPrefabInstance"] = PrefabUtility.IsPartOfPrefabInstance(target);
                data["dryRun"] = true;
                string message = "Preview: deleting '" + path + "' removes " + subtree.Count + " object(s)"
                    + (inbound.Count > 0 ? " and breaks " + inbound.Count + " reference(s) (they will show as Missing)" : " with no inbound references")
                    + (scanComplete ? "" : " — the reference scan ran out of time, so the count is a lower bound")
                    + " (nothing deleted yet).";
                return BridgeResult.Ok(message, null, JsonWrite(data));
            }
            List<object> expectedRaw = JArr(args, "expectedLostObjects");
            if (expectedRaw != null)
            {
                var expected = new HashSet<string>();
                foreach (object v in expectedRaw) if (v != null) expected.Add(v.ToString());
                var actual = new HashSet<string>();
                foreach (GameObject go in subtree) actual.Add(ComponentLocator.GetPath(go.transform));
                if (!expected.SetEquals(actual))
                    return BridgeResult.Error("The subtree changed since the preview — run the preview again. Expected " + expected.Count + " object(s), found " + actual.Count + ".");
            }
            Scene scene = target.scene;
            int undoGroup = MutationScope.BeginUndoGroup(args, "delete " + target.name);
            string oldPath = ComponentLocator.GetPath(target.transform);
            Undo.DestroyObjectImmediate(target);
            MutationScope.Commit(undoGroup, scene);
            var resultData = new Dictionary<string, object>();
            resultData["path"] = oldPath;
            resultData["deletedCount"] = subtree.Count;
            var pathChanges = new List<object>();
            var pc = new Dictionary<string, object>();
            pc["from"] = oldPath;
            pc["to"] = null;
            pathChanges.Add(pc);
            resultData["pathChanges"] = pathChanges;
            if (EditorApplication.isPlaying) resultData["playModeWarning"] = MutationScope.PlayModeWarning;
            return BridgeResult.Ok("Deleted '" + oldPath + "' (" + subtree.Count + " object(s)).", null, JsonWrite(resultData));
        }

        private static List<Dictionary<string, object>> ScanInboundReferences(HashSet<int> deletedIds, out bool scanComplete)
        {
            scanComplete = true;
            var refs = new List<Dictionary<string, object>>();
            double start = EditorApplication.timeSinceStartup;
            foreach (GameObject root in ComponentLocator.EnumerateRoots())
            {
                var stack = new Stack<Transform>();
                stack.Push(root.transform);
                while (stack.Count > 0)
                {
                    Transform t = stack.Pop();
                    GameObject go = t.gameObject;
                    foreach (Transform child in t) stack.Push(child);
                    if (deletedIds.Contains(go.GetInstanceID())) continue;
                    foreach (Component c in go.GetComponents<Component>())
                    {
                        if (c == null) continue;
                        var so = new SerializedObject(c);
                        SerializedProperty p = so.GetIterator();
                        int seen = 0;
                        while (p.NextVisible(true))
                        {
                            if ((++seen & 63) == 0 && EditorApplication.timeSinceStartup - start > ReferenceScanBudgetSeconds)
                            {
                                scanComplete = false;
                                return refs;
                            }
                            if (p.propertyType != SerializedPropertyType.ObjectReference && p.propertyType != SerializedPropertyType.ExposedReference) continue;
                            UnityEngine.Object target = p.objectReferenceValue;
                            if (target == null) continue;
                            if (!deletedIds.Contains(target.GetInstanceID())) continue;
                            var d = new Dictionary<string, object>();
                            d["from"] = ComponentLocator.GetPath(go.transform) + " / " + c.GetType().Name;
                            d["property"] = p.propertyPath;
                            d["target"] = target.name + " (" + target.GetType().Name + ")";
                            refs.Add(d);
                        }
                    }
                }
            }
            return refs;
        }
    }

    // ── set_parent ───────────────────────────────────────────
    // Move a scene object under a new parent (or the scene root).
    // Three traps: cycles (the new parent cannot be the object
    // itself or one of its children), name collisions at the
    // destination (refused unless renameOnConflict is true —
    // renaming silently changes the object's address, so it is an
    // explicit choice), and the fact that EVERY path under the
    // moved object changes — the result reports pathChanges for
    // the whole subtree, and the app rewrites later calls to the
    // new paths. A non-root child of a prefab instance cannot be
    // moved out of its instance. keepWorldPosition:false keeps
    // the local values instead of the world pose.
    private static class SetParentHandler
    {
        public static BridgeResult Handle(string json, Dictionary<string, object> args)
        {
            string path = JStr(args, "path", "");
            if (string.IsNullOrEmpty(path)) return BridgeResult.Error("'path' is required.");
            bool dryRun = JBool(args, "dryRun", false);
            string playError = MutationScope.PlayModeError(args, dryRun);
            if (playError != null) return BridgeResult.Error(playError);
            List<GameObject> matches = ComponentLocator.FindGameObjects(path);
            if (matches.Count != 1)
                return BridgeResult.Error(matches.Count == 0
                    ? "No GameObject at '" + path + "'. Start with the scene root name."
                    : matches.Count + " objects match '" + path + "'. Use a more specific path.");
            GameObject target = matches[0];
            string newParentPath = JStr(args, "newParent", "");
            GameObject newParentGO = null;
            Transform newParentT = null;
            if (!string.IsNullOrEmpty(newParentPath))
            {
                List<GameObject> pm = ComponentLocator.FindGameObjects(newParentPath);
                if (pm.Count != 1)
                    return BridgeResult.Error(pm.Count == 0
                        ? "No GameObject at '" + newParentPath + "' — the new parent must exist."
                        : pm.Count + " objects match '" + newParentPath + "'. Use a more specific path.");
                newParentGO = pm[0];
                if (EditorUtility.IsPersistent(newParentGO))
                    return BridgeResult.Error("'" + newParentPath + "' is an asset, not a scene object — a new parent must be a scene object.");
                newParentT = newParentGO.transform;
            }
            if (PrefabUtility.IsPartOfPrefabInstance(target) && !PrefabUtility.IsOutermostPrefabInstanceRoot(target) && !PrefabUtility.IsAddedGameObjectOverride(target))
            {
                // Moving within the same instance root is fine;
                // moving out (or to the scene root) is not.
                GameObject instanceRoot = PrefabUtility.GetOutermostPrefabInstanceRoot(target);
                bool staysInside = newParentT != null && instanceRoot != null && (newParentT.gameObject == instanceRoot || newParentT.IsChildOf(instanceRoot.transform));
                if (!staysInside)
                    return BridgeResult.Error("'" + path + "' is a child of a prefab instance — Unity does not allow moving it out. Move the whole instance, edit the prefab asset, or disable the object instead.");
            }
            if (newParentT != null && newParentT.IsChildOf(target.transform))
                return BridgeResult.Error("Cannot move '" + path + "' under its own child '" + newParentPath + "' — that would make a cycle.");
            if (newParentT == target.transform)
                return BridgeResult.Error("'" + path + "' is already parented to itself.");
            bool keepWorldPosition = JBool(args, "keepWorldPosition", true);
            bool renameOnConflict = JBool(args, "renameOnConflict", false);
            string finalName = target.name;
            bool renamed = false;
            var siblings = new List<Transform>();
            if (newParentT == null)
            {
                foreach (GameObject root in ComponentLocator.EnumerateRoots()) siblings.Add(root.transform);
            }
            else
            {
                foreach (Transform child in newParentT) siblings.Add(child);
            }
            foreach (Transform s in siblings)
            {
                if (s == target.transform) continue;
                if (s.name != target.name) continue;
                if (!renameOnConflict)
                    return BridgeResult.Error("A sibling named '" + target.name + "' already exists under '" + (string.IsNullOrEmpty(newParentPath) ? "the scene root" : newParentPath) + "' — pass renameOnConflict: true to rename it instead.");
                finalName = SceneHelpers.UniqueSiblingName(newParentT, target.name);
                renamed = finalName != target.name;
                break;
            }
            string oldPath = ComponentLocator.GetPath(target.transform);
            string newPath = newParentT == null ? finalName : ComponentLocator.GetPath(newParentT) + "/" + finalName;
            var subtree = SceneHelpers.CollectSubtree(target);
            var pathChanges = BuildPathChanges(oldPath, newPath, subtree);
            Vector3 localPos = target.transform.localPosition;
            string warning = null;
            if (newParentT != null)
            {
                Vector3 ls = newParentT.lossyScale;
                if (Math.Abs(ls.x - ls.y) > 0.001 || Math.Abs(ls.y - ls.z) > 0.001)
                    warning = "The new parent has non-uniform scale — the child may appear skewed.";
            }
            if (dryRun)
            {
                var data = new Dictionary<string, object>();
                data["path"] = oldPath;
                data["newPath"] = newPath;
                data["renamed"] = renamed;
                data["descendantCount"] = subtree.Count - 1;
                data["localPosition"] = new List<object> { Math.Round((double)localPos.x, 3), Math.Round((double)localPos.y, 3), Math.Round((double)localPos.z, 3) };
                data["pathChanges"] = pathChanges;
                if (warning != null) data["warning"] = warning;
                data["dryRun"] = true;
                return BridgeResult.Ok("Preview: move '" + oldPath + "' → '" + newPath + "' (" + (subtree.Count - 1) + " descendant(s))" + (warning != null ? " — " + warning : "") + " (nothing moved yet).", null, JsonWrite(data));
            }
            Scene scene = target.scene;
            int undoGroup = MutationScope.BeginUndoGroup(args, "move " + target.name);
            if (renamed)
            {
                Undo.RecordObject(target, "Agent: rename " + target.name);
                target.name = finalName;
            }
            Undo.SetTransformParent(target.transform, newParentT, keepWorldPosition);
            MutationScope.Commit(undoGroup, scene);
            var resultData = new Dictionary<string, object>();
            resultData["path"] = ComponentLocator.GetPath(target.transform);
            resultData["newPath"] = ComponentLocator.GetPath(target.transform);
            resultData["renamed"] = renamed;
            resultData["descendantCount"] = subtree.Count - 1;
            Vector3 lp = target.transform.localPosition;
            resultData["localPosition"] = new List<object> { Math.Round((double)lp.x, 3), Math.Round((double)lp.y, 3), Math.Round((double)lp.z, 3) };
            resultData["pathChanges"] = pathChanges;
            if (warning != null) resultData["warning"] = warning;
            if (EditorApplication.isPlaying) resultData["playModeWarning"] = MutationScope.PlayModeWarning;
            return BridgeResult.Ok("Moved '" + oldPath + "' → '" + ComponentLocator.GetPath(target.transform) + "' (" + (subtree.Count - 1) + " descendant(s)).", null, JsonWrite(resultData));
        }

        private static List<object> BuildPathChanges(string oldPath, string newPath, List<GameObject> subtree)
        {
            var changes = new List<object>();
            foreach (GameObject go in subtree)
            {
                string from = ComponentLocator.GetPath(go.transform);
                string to = from == oldPath ? newPath : newPath + from.Substring(oldPath.Length);
                var d = new Dictionary<string, object>();
                d["from"] = from;
                d["to"] = to;
                changes.Add(d);
            }
            return changes;
        }
    }

    // ── list_hierarchy ───────────────────────────────────────
    // Print the scene tree as text, not JSON — about a third of
    // the tokens. Breadth-first budget: the top of the scene is
    // complete before deep branches eat the budget, and hidden
    // counts say how much was cut. Same-named siblings collapse
    // (Enemy ×10 with the first expanded — the biggest saving);
    // identical sibling names are flagged !dup, because the other
    // tools reject ambiguous paths. Tag, layer and positions are
    // deliberately left out — they belong to
    // read_component_values. A filter (nameContains /
    // hasComponent) returns a flat list of matching paths instead
    // of the tree — the fix for guessing paths.
    private static class ListHierarchyHandler
    {
        private const int DefaultDepth = 2;
        private const int MaxDepth = 6;
        private const int DefaultMaxNodes = 60;
        private const int MaxMaxNodes = 200;
        private const int MaxFindResults = 30;
        private const int MaxComponentsPerNode = 4;
        private const int CollapseThreshold = 4;

        private class NodeEntry { public Transform t; public int depth; }

        public static BridgeResult Handle(string json, Dictionary<string, object> args)
        {
            string rootPath = JStr(args, "root", "");
            string nameContains = JStr(args, "nameContains", "");
            string hasComponent = JStr(args, "hasComponent", "");
            bool fullPaths = JBool(args, "fullPaths", false);
            int depth = (int)JNum(args, "depth", DefaultDepth);
            if (depth < 1) depth = 1;
            if (depth > MaxDepth) depth = MaxDepth;
            int maxNodes = (int)JNum(args, "maxNodes", DefaultMaxNodes);
            if (maxNodes < 1) maxNodes = 1;
            if (maxNodes > MaxMaxNodes) maxNodes = MaxMaxNodes;
            var roots = new List<GameObject>();
            if (!string.IsNullOrEmpty(rootPath))
            {
                List<GameObject> matches = ComponentLocator.FindGameObjects(rootPath);
                if (matches.Count != 1)
                    return BridgeResult.Error(matches.Count == 0
                        ? "No GameObject at '" + rootPath + "'. Start with the scene root name."
                        : matches.Count + " objects match '" + rootPath + "'. Use a more specific path.");
                roots.Add(matches[0]);
            }
            else
            {
                roots.AddRange(ComponentLocator.EnumerateRoots());
            }
            // Find mode: a flat list of matching paths.
            if (!string.IsNullOrEmpty(nameContains) || !string.IsNullOrEmpty(hasComponent))
            {
                var found = new List<string>();
                int totalMatches = 0;
                var queue = new Queue<Transform>();
                foreach (GameObject r in roots) queue.Enqueue(r.transform);
                while (queue.Count > 0)
                {
                    Transform t = queue.Dequeue();
                    foreach (Transform child in t) queue.Enqueue(child);
                    bool match = false;
                    if (!string.IsNullOrEmpty(nameContains) && t.name.IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0) match = true;
                    if (!string.IsNullOrEmpty(hasComponent))
                    {
                        foreach (Component c in t.gameObject.GetComponents<Component>())
                            if (c != null && string.Equals(c.GetType().Name, hasComponent, StringComparison.OrdinalIgnoreCase)) { match = true; break; }
                    }
                    if (!match) continue;
                    totalMatches++;
                    if (found.Count < MaxFindResults)
                        found.Add(fullPaths ? ComponentLocator.GetPath(t) : t.name);
                }
                var data = new Dictionary<string, object>();
                data["matches"] = found;
                data["totalMatches"] = totalMatches;
                data["truncated"] = totalMatches > found.Count;
                string message = totalMatches == 0
                    ? "No objects match" + (!string.IsNullOrEmpty(nameContains) ? " '" + nameContains + "'" : "") + (!string.IsNullOrEmpty(hasComponent) ? " with component '" + hasComponent + "'" : "") + "."
                    : totalMatches + " match(es): " + string.Join(", ", found.ToArray()) + (totalMatches > found.Count ? " (showing first " + found.Count + ")" : "");
                return BridgeResult.Ok(message, null, JsonWrite(data));
            }
            // Tree mode. Count once (one full walk), then select
            // breadth-first up to the budget, then print depth-first
            // so a collapsed line lands after the sibling it
            // belongs to.
            int totalObjects = 0;
            foreach (GameObject r in roots) totalObjects += CountSubtree(r.transform);
            var shownSet = new HashSet<int>();
            var bfs = new Queue<NodeEntry>();
            foreach (GameObject r in roots) bfs.Enqueue(new NodeEntry { t = r.transform, depth = 0 });
            while (bfs.Count > 0 && shownSet.Count < maxNodes)
            {
                NodeEntry entry = bfs.Dequeue();
                shownSet.Add(entry.t.gameObject.GetInstanceID());
                if (entry.depth >= depth) continue;
                var children = ChildrenOf(entry.t);
                foreach (var group in GroupByBaseName(children))
                {
                    if (group.Count >= CollapseThreshold)
                    {
                        // First sibling expanded, the rest as one
                        // collapsed group — their subtrees are not
                        // walked, so they never eat the budget.
                        bfs.Enqueue(new NodeEntry { t = group[0], depth = entry.depth + 1 });
                    }
                    else
                    {
                        foreach (Transform child in group) bfs.Enqueue(new NodeEntry { t = child, depth = entry.depth + 1 });
                    }
                }
            }
            var lines = new List<string>();
            foreach (GameObject r in roots) PrintSubtree(r.transform, 0, depth, fullPaths, shownSet, lines);
            int shown = shownSet.Count;
            bool truncated = shown < totalObjects;
            string tree = string.Join("\n", lines.ToArray());
            var treeData = new Dictionary<string, object>();
            treeData["tree"] = tree;
            treeData["shown"] = shown;
            treeData["total"] = totalObjects;
            treeData["hidden"] = totalObjects - shown;
            treeData["truncated"] = truncated;
            string treeMessage = "Scene hierarchy — " + shown + " of " + totalObjects + " object(s)" + (truncated ? " (increase maxNodes to see more)" : "") + ":\n" + tree;
            return BridgeResult.Ok(treeMessage, null, JsonWrite(treeData));
        }

        private static int CountSubtree(Transform root)
        {
            int count = 0;
            var stack = new Stack<Transform>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                Transform t = stack.Pop();
                count++;
                foreach (Transform child in t) stack.Push(child);
            }
            return count;
        }

        private static List<Transform> ChildrenOf(Transform t)
        {
            var children = new List<Transform>();
            foreach (Transform child in t) children.Add(child);
            return children;
        }

        // Group siblings by base name, keeping first-appearance
        // order. "Enemy", "Enemy (1)", "Enemy (2)" share the base
        // "Enemy"; "Foo (bar)" is not a numbered variant.
        private static List<List<Transform>> GroupByBaseName(List<Transform> children)
        {
            var order = new List<string>();
            var groups = new Dictionary<string, List<Transform>>();
            foreach (Transform child in children)
            {
                string baseName = BaseName(child.name);
                List<Transform> group;
                if (!groups.TryGetValue(baseName, out group))
                {
                    group = new List<Transform>();
                    groups[baseName] = group;
                    order.Add(baseName);
                }
                group.Add(child);
            }
            var result = new List<List<Transform>>();
            foreach (string baseName in order) result.Add(groups[baseName]);
            return result;
        }

        private static string BaseName(string name)
        {
            if (string.IsNullOrEmpty(name) || !name.EndsWith(")", StringComparison.Ordinal)) return name;
            int open = name.LastIndexOf(" (", StringComparison.Ordinal);
            if (open < 0) return name;
            string num = name.Substring(open + 2, name.Length - open - 3);
            int n;
            if (int.TryParse(num, out n)) return name.Substring(0, open);
            return name;
        }

        private static void PrintSubtree(Transform t, int depth, int maxDepth, bool fullPaths, HashSet<int> shownSet, List<string> lines)
        {
            if (!shownSet.Contains(t.gameObject.GetInstanceID())) return;
            var children = ChildrenOf(t);
            var groups = depth < maxDepth ? GroupByBaseName(children) : new List<List<Transform>>();
            // How many children are hidden — by the depth cap or
            // by the node budget. Collapsed siblings get their own
            // ×N line, so they are not counted here.
            int hiddenChildren = 0;
            if (depth >= maxDepth) hiddenChildren = children.Count;
            else
            {
                foreach (var group in groups)
                {
                    if (group.Count >= CollapseThreshold) continue;
                    foreach (Transform child in group)
                        if (!shownSet.Contains(child.gameObject.GetInstanceID())) hiddenChildren++;
                }
            }
            bool isDup = false;
            if (t.parent != null)
            {
                int same = 0;
                foreach (Transform s in t.parent) if (s.name == t.name) same++;
                isDup = same > 1;
            }
            lines.Add(PrintNode(t, depth, fullPaths, hiddenChildren, isDup));
            if (depth >= maxDepth) return;
            foreach (var group in groups)
            {
                if (group.Count >= CollapseThreshold)
                {
                    PrintSubtree(group[0], depth + 1, maxDepth, fullPaths, shownSet, lines);
                    // The collapsed line lands right after the
                    // first expanded sibling it belongs to. If the
                    // budget ran out before the first sibling was
                    // shown, the count covers the whole group.
                    int collapsedCount = group.Count - (shownSet.Contains(group[0].gameObject.GetInstanceID()) ? 1 : 0);
                    if (collapsedCount > 0)
                        lines.Add(Indent(depth + 1) + BaseName(group[0].name) + " ×" + collapsedCount);
                }
                else
                {
                    foreach (Transform child in group)
                        PrintSubtree(child, depth + 1, maxDepth, fullPaths, shownSet, lines);
                }
            }
        }

        private static string PrintNode(Transform t, int depth, bool fullPaths, int hiddenChildren, bool isDup)
        {
            string name = fullPaths ? ComponentLocator.GetPath(t) : t.name;
            string line = Indent(depth) + name;
            if (isDup) line += " !dup";
            if (!t.gameObject.activeSelf) line += " (off)";
            var comps = new List<string>();
            foreach (Component c in t.gameObject.GetComponents<Component>())
            {
                if (c == null || c is Transform) continue;
                comps.Add(c.GetType().Name);
            }
            if (comps.Count > 0)
            {
                var shownComps = comps.Count > MaxComponentsPerNode ? comps.GetRange(0, MaxComponentsPerNode) : comps;
                line += " [" + string.Join(", ", shownComps.ToArray()) + (comps.Count > MaxComponentsPerNode ? " +" + (comps.Count - MaxComponentsPerNode) : "") + "]";
            }
            if (hiddenChildren > 0) line += " (+" + hiddenChildren + " children)";
            return line;
        }

        private static string Indent(int depth)
        {
            return new string(' ', depth * 2);
        }
    }

    // ── create_material ──────────────────────────────────────
    // Create a .mat asset. Shader, colour, main texture and the
    // metallic / smoothness floats when the shader has them — a
    // property the shader does not have is skipped, not an error.
    // The folder is created when it does not exist yet, and the
    // asset path is made unique so an existing material is never
    // overwritten.
    private static class CreateMaterialHandler
    {
        public static BridgeResult Handle(string json, Dictionary<string, object> args)
        {
            string name = JStr(args, "name", "").Trim();
            if (string.IsNullOrEmpty(name)) return BridgeResult.Error("'name' is required.");
            if (name.IndexOf('/') >= 0) return BridgeResult.Error("A name cannot contain '/' — pass the folder in \"folder\" instead.");
            string folder = JStr(args, "folder", "Assets/Materials");
            if (string.IsNullOrEmpty(folder)) folder = "Assets/Materials";
            if (!folder.StartsWith("Assets/", StringComparison.Ordinal) && folder != "Assets")
                return BridgeResult.Error("'folder' must start with Assets/ — got '" + folder + "'.");
            string shaderName = JStr(args, "shader", "Standard");
            if (string.IsNullOrEmpty(shaderName)) shaderName = "Standard";
            Shader shader = Shader.Find(shaderName);
            if (shader == null)
                return BridgeResult.Error("Unknown shader '" + shaderName + "' — try Standard, Unlit/Texture, URP/Lit, or HDRP/Lit.");
            Color color = Color.white;
            bool hasColor = false;
            object colorRaw;
            if (args.TryGetValue("color", out colorRaw) && colorRaw != null)
            {
                if (!SetPropertyHandler.TryParseColor(colorRaw, out color))
                    return BridgeResult.Error("'color' must be \"#RRGGBB\" (or \"#RRGGBBAA\") or [r, g, b] / [r, g, b, a].");
                hasColor = true;
            }
            string texturePath = JStr(args, "texture", "");
            Texture2D texture = null;
            if (!string.IsNullOrEmpty(texturePath))
            {
                if (!texturePath.StartsWith("Assets/", StringComparison.Ordinal))
                    return BridgeResult.Error("'texture' must be an asset path starting with Assets/ — got '" + texturePath + "'.");
                texture = AssetDatabase.LoadAssetAtPath<Texture2D>(texturePath);
                if (texture == null)
                    return BridgeResult.Error("No texture at '" + texturePath + "'.");
            }
            double metallic = JNum(args, "metallic", double.NaN);
            double smoothness = JNum(args, "smoothness", double.NaN);
            if (!AssetDatabase.IsValidFolder(folder))
            {
                try
                {
                    Directory.CreateDirectory(folder);
                    AssetDatabase.Refresh();
                }
                catch (Exception e) { return BridgeResult.Error("Could not create folder '" + folder + "': " + e.Message); }
                if (!AssetDatabase.IsValidFolder(folder))
                    return BridgeResult.Error("Folder '" + folder + "' does not exist and could not be created.");
            }
            var mat = new Material(shader);
            if (hasColor && mat.HasProperty("_Color")) mat.color = color;
            if (texture != null && mat.HasProperty("_MainTex")) mat.mainTexture = texture;
            if (!double.IsNaN(metallic) && mat.HasProperty("_Metallic")) mat.SetFloat("_Metallic", (float)metallic);
            if (!double.IsNaN(smoothness) && mat.HasProperty("_Glossiness")) mat.SetFloat("_Glossiness", (float)smoothness);
            string assetPath = AssetDatabase.GenerateUniqueAssetPath(folder.TrimEnd('/') + "/" + name + ".mat");
            Undo.RegisterCreatedObjectUndo(mat, "Agent: create material " + name);
            AssetDatabase.CreateAsset(mat, assetPath);
            AssetDatabase.SaveAssets();
            var data = new Dictionary<string, object>();
            data["path"] = assetPath;
            data["shader"] = shaderName;
            return BridgeResult.Ok("Created material '" + assetPath + "' with shader '" + shaderName + "'" + (hasColor ? " and the given color" : "") + ".", assetPath, JsonWrite(data));
        }
    }

    // ── apply_import_profile ─────────────────────────────────
    // Apply one of CodeFox's import profiles to an image already
    // inside the project (a generated image CodeFox just copied
    // into Assets/Generated/). Profiles are data on the app side
    // (IMPORT_PROFILES in comfyui-workflows.js); this handler is
    // the Unity half — it sets the TextureImporter fields and
    // reimports. The app passes the profile id; an unknown id
    // fails plainly and lists the valid ones, so a renamed profile
    // fails loudly instead of silently never applying.
    //
    // The file must already be in Assets/Generated/ (CodeFox's
    // output folder — nothing outside it is ever touched here).
    // AssetDatabase.ImportAsset runs first, so the importer exists
    // even when Unity has not noticed the new file yet.
    private static class ApplyImportProfileHandler
    {
        private static readonly string[] ValidProfiles = new[] { "sprite", "pixel-sprite", "texture", "normal-map", "ui" };

        public static BridgeResult Handle(string json, Dictionary<string, object> args)
        {
            string assetPath = JStr(args, "path", "").Trim().Replace('\\', '/');
            if (string.IsNullOrEmpty(assetPath)) return BridgeResult.Error("'path' is required — the project-relative path of the image, e.g. Assets/Generated/hero/hero-1.png.");
            if (!assetPath.StartsWith("Assets/Generated/", StringComparison.Ordinal))
                return BridgeResult.Error("'path' must be inside Assets/Generated/ — got '" + assetPath + "'.");
            if (assetPath.IndexOf("..", StringComparison.Ordinal) >= 0)
                return BridgeResult.Error("'path' must not contain '..' — got '" + assetPath + "'.");
            string profile = JStr(args, "profile", "").Trim().ToLowerInvariant();
            if (string.IsNullOrEmpty(profile))
                return BridgeResult.Error("'profile' is required. Valid profiles: " + string.Join(", ", ValidProfiles) + ".");
            bool known = false;
            foreach (var p in ValidProfiles) if (p == profile) { known = true; break; }
            if (!known)
                return BridgeResult.Error("Unknown import profile '" + profile + "'. Valid profiles: " + string.Join(", ", ValidProfiles) + ".");
            string ext = Path.GetExtension(assetPath).ToLowerInvariant();
            if (ext != ".png" && ext != ".jpg" && ext != ".jpeg")
                return BridgeResult.Error("'" + assetPath + "' is not an image CodeFox can set import settings on (only .png and .jpg).");
            AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceUpdate);
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null)
                return BridgeResult.Error("No texture importer for '" + assetPath + "' — is the file really an image in the project?");
            string applied;
            switch (profile)
            {
                case "sprite":
                    importer.textureType = TextureImporterType.Sprite;
                    importer.spritePixelsPerUnit = 100;
                    importer.mipmapEnabled = false;
                    importer.filterMode = FilterMode.Bilinear;
                    importer.wrapMode = TextureWrapMode.Repeat;
                    importer.sRGBTexture = true;
                    applied = "Sprite, 100 px/unit, bilinear, no mipmaps, repeat wrap";
                    break;
                case "pixel-sprite":
                    importer.textureType = TextureImporterType.Sprite;
                    importer.spritePixelsPerUnit = 16;
                    importer.mipmapEnabled = false;
                    importer.filterMode = FilterMode.Point;
                    importer.wrapMode = TextureWrapMode.Clamp;
                    importer.textureCompression = TextureImporterCompression.Uncompressed;
                    importer.sRGBTexture = true;
                    applied = "Pixel sprite, 16 px/unit, point filtering, no mipmaps, no compression";
                    break;
                case "texture":
                    importer.textureType = TextureImporterType.Default;
                    importer.mipmapEnabled = true;
                    importer.filterMode = FilterMode.Bilinear;
                    importer.wrapMode = TextureWrapMode.Repeat;
                    importer.sRGBTexture = true;
                    applied = "Texture, mipmaps on, bilinear, repeat wrap";
                    break;
                case "normal-map":
                    importer.textureType = TextureImporterType.NormalMap;
                    importer.mipmapEnabled = true;
                    importer.filterMode = FilterMode.Bilinear;
                    importer.wrapMode = TextureWrapMode.Repeat;
                    importer.sRGBTexture = false;
                    applied = "Normal map, linear, mipmaps on";
                    break;
                case "ui":
                    importer.textureType = TextureImporterType.Sprite;
                    importer.spritePixelsPerUnit = 100;
                    importer.mipmapEnabled = false;
                    importer.filterMode = FilterMode.Bilinear;
                    importer.wrapMode = TextureWrapMode.Clamp;
                    importer.sRGBTexture = true;
                    applied = "UI sprite, 100 px/unit, bilinear, no mipmaps, clamp wrap";
                    break;
                default:
                    return BridgeResult.Error("Unknown import profile '" + profile + "'. Valid profiles: " + string.Join(", ", ValidProfiles) + ".");
            }
            importer.SaveAndReimport();
            var data = new Dictionary<string, object>();
            data["path"] = assetPath;
            data["profile"] = profile;
            data["applied"] = applied;
            return BridgeResult.Ok("Applied the '" + profile + "' import profile to '" + assetPath + "' (" + applied + ").", assetPath, JsonWrite(data));
        }
    }

    // ── list_assets ──────────────────────────────────────────
    // List asset files under Assets/ by type. "prefab" means a
    // .prefab file; an unknown type name is tried as a Unity type
    // directly ("t:<name>") and fails plainly with the known list
    // when nothing matches.
    private static class ListAssetsHandler
    {
        private const int DefaultMaxResults = 100;
        private const int MaxMaxResults = 200;
        private static readonly Dictionary<string, string> TypeFilters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "texture", "t:Texture2D" },
            { "material", "t:Material" },
            { "prefab", "t:GameObject" },
            { "scene", "t:SceneAsset" },
            { "audio", "t:AudioClip" },
            { "script", "t:MonoScript" },
            { "sprite", "t:Sprite" },
            { "animation", "t:AnimationClip" },
            { "font", "t:Font" },
            { "shader", "t:Shader" },
        };

        public static BridgeResult Handle(string json, Dictionary<string, object> args)
        {
            string type = JStr(args, "type", "").Trim();
            string folder = JStr(args, "folder", "Assets");
            if (string.IsNullOrEmpty(folder)) folder = "Assets";
            if (!folder.StartsWith("Assets/", StringComparison.Ordinal) && folder != "Assets")
                return BridgeResult.Error("'folder' must start with Assets/ — got '" + folder + "'.");
            int maxResults = (int)JNum(args, "maxResults", DefaultMaxResults);
            if (maxResults < 1) maxResults = 1;
            if (maxResults > MaxMaxResults) maxResults = MaxMaxResults;
            string filter = "";
            if (!string.IsNullOrEmpty(type))
            {
                if (!TypeFilters.TryGetValue(type, out filter))
                    filter = "t:" + type;
            }
            string[] guids = AssetDatabase.FindAssets(filter, new[] { folder });
            var assets = new List<object>();
            int total = 0;
            foreach (string guid in guids)
            {
                string assetPath = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(assetPath)) continue;
                if (string.Equals(type, "prefab", StringComparison.OrdinalIgnoreCase) && !assetPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)) continue;
                total++;
                if (assets.Count >= maxResults) continue;
                Type mainType = AssetDatabase.GetMainAssetTypeAtPath(assetPath);
                var d = new Dictionary<string, object>();
                d["path"] = assetPath;
                d["type"] = mainType != null ? mainType.Name : "";
                assets.Add(d);
            }
            if (!string.IsNullOrEmpty(type) && total == 0 && !TypeFilters.ContainsKey(type))
                return BridgeResult.Error("No assets of type '" + type + "' under '" + folder + "'. Known types: " + string.Join(", ", new List<string>(TypeFilters.Keys).ToArray()) + ".");
            var data = new Dictionary<string, object>();
            data["assets"] = assets;
            data["total"] = total;
            data["truncated"] = total > assets.Count;
            data["folder"] = folder;
            data["type"] = type;
            return BridgeResult.Ok(total + " asset(s) under '" + folder + "'" + (!string.IsNullOrEmpty(type) ? " of type '" + type + "'" : "") + (total > assets.Count ? " (showing first " + assets.Count + ")" : "") + ".", null, JsonWrite(data));
        }
    }

    // Click a UI element while the game runs: execute the
    // pointer-click handler on the object, the same path a real
    // click takes through the EventSystem. It only does what the
    // button itself does — nothing is invented.
    private static BridgeResult ClickUI(string json, Dictionary<string, object> args)
    {
        string path = JStr(args, "path", "");
        if (string.IsNullOrEmpty(path)) return BridgeResult.Error("'path' is required.");
        if (!EditorApplication.isPlaying) return BridgeResult.Error("Enter Play Mode first — UI clicks only do anything while the game is running.");
        List<GameObject> matches = ComponentLocator.FindGameObjects(path);
        if (matches.Count != 1)
            return BridgeResult.Error(matches.Count == 0
                ? "No GameObject at '" + path + "'. Start with the scene root name."
                : matches.Count + " objects match '" + path + "'. Use a more specific path.");
        if (EventSystem.current == null) return BridgeResult.Error("No EventSystem in the scene — UI clicks need one (add one with GameObject → UI → Event System).");
        var eventData = new PointerEventData(EventSystem.current);
        bool handled = ExecuteEvents.Execute(matches[0], eventData, ExecuteEvents.pointerClickHandler);
        if (!handled) return BridgeResult.Error("Nothing on '" + path + "' handles a pointer click — it needs a Button or another IPointerClickHandler.");
        return BridgeResult.Ok("Clicked '" + path + "'.");
    }
}
#endif
