// CodeFoxBridge.cs
// CodeFoxBridge version: 0.12.0
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
// Props take strings, numbers, bools, [x,y(,z)] vectors, [r,g,b(,a)]
// colours (or "#rrggbb"), enum names, and asset paths (Assets/…) for
// Sprite / Material / Texture2D / Font / AudioClip. An unknown type,
// an unknown property, or a missing asset fails the whole command
// with a plain message — nothing is guessed.

#if UNITY_EDITOR
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.Compilation;
using UnityEngine;
using UnityEngine.UI;
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

[InitializeOnLoad]
public static class CodeFoxBridge
{
    // Version of this bridge file. CodeFox reads this marker to tell
    // whether the bridge installed in a project is older than the one
    // bundled with the app, so it can update it automatically.
    // 0.12.0 is the first bridge that speaks the .bridge/ transport
    // (protocol 1); the app never sends inbox commands to anything
    // older — it updates the bridge first.
    public const string BridgeVersion = "0.12.0";
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
        // Unsubscribe first: with Enter Play Mode Options set to
        // skip the domain reload, the static constructor runs again
        // in the same domain, and a second subscription would poll
        // (and run commands) twice.
        EditorApplication.update -= OnEditorUpdate;
        EditorApplication.update += OnEditorUpdate;
        EditorApplication.delayCall -= BridgeTransport.RecoverInterruptedRequests;
        EditorApplication.delayCall += BridgeTransport.RecoverInterruptedRequests;
        ConsoleBuffer.Initialize();
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

            // A compile report that finished — on either path
            // (reload after success, or errors with no reload) — is
            // finalized by the poll tick, not by reload recovery.
            BridgeResult finalResult;
            string finalId;
            if (CompileReport.TryFinalize(out finalResult, out finalId))
            {
                WriteOutbox(finalId, finalResult);
                DeleteProcessing(finalId);
                MarkActive();
            }

            ProcessInbox();
            CleanupOutbox(now);
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
                + ",\"isPlaying\":" + (EditorApplication.isPlaying ? "true" : "false") + "}";
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
                { "deleteAsset", (json, args) => DeleteAsset(json, args) },
                { "listComponentTypes", (json, args) => ListComponentTypes(json, args) },
                { "describeComponent", (json, args) => DescribeComponent(json, args) },
                { "readConsole", (json, args) => ConsoleBuffer.Read(json, args) },
                { "recompile_and_report_errors", (json, args) => CompileReport.Begin(json, args) },
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

    private static BridgeResult ModifyPrefab(string json, Dictionary<string, object> args)
    {
        var cmd = args;
        if (cmd == null) return BridgeResult.Error("Command JSON must be an object.");
        string assetPath = JStr(cmd, "path", "");
        if (string.IsNullOrEmpty(assetPath)) return BridgeResult.Error("modifyPrefab needs a \"path\" to the prefab.");
        if (AssetDatabase.LoadAssetAtPath<GameObject>(assetPath) == null)
            return BridgeResult.Error("Prefab not found: '" + assetPath + "' — the file is not in this project.");
        GameObject contents = PrefabUtility.LoadPrefabContents(assetPath);
        if (contents == null) return BridgeResult.Error("Could not load the prefab at " + assetPath + ".");
        try
        {
            string err = ApplyPrefabEdits(contents, cmd);
            if (err != null) return BridgeResult.Error(err);
            GameObject saved = PrefabUtility.SaveAsPrefabAsset(contents, assetPath);
            if (saved == null) return BridgeResult.Error("Unity could not save the prefab at " + assetPath + ".");
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return BridgeResult.Ok("Prefab updated.", assetPath);
        }
        finally
        {
            // Unload without saving on the failure path, so a failed
            // edit never leaves the prefab file half-changed.
            PrefabUtility.UnloadPrefabContents(contents);
        }
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
    // type, or property.
    private static string ApplyPrefabEdits(GameObject root, Dictionary<string, object> cmd)
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
}
#endif
