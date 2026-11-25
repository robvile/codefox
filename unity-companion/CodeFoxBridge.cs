// CodeFoxBridge.cs
// CodeFoxBridge version: 0.5.2
// Place this file in: Assets/Editor/CodeFoxBridge.cs
// Watches for file changes from the CodeFox app and auto-refreshes Unity's AssetDatabase.
// Also watches Assets/.codefox-command.json: when CodeFox writes a command there,
// this bridge executes it and writes the result to Assets/.codefox-result.json.
//
// Command format (JSON):
//   { "action": "refresh" }
//   { "action": "createAnimatorController", "name": "Player",
//     "parameters": [{ "name": "Speed", "type": "Float" }],
//     "states": [{ "name": "Idle", "motion": "Assets/Anims/Idle.anim", "speed": 1 }],
//     "transitions": [{ "from": "Idle", "to": "Run", "parameter": "Speed", "condition": "Greater" }] }
//   { "action": "createUICanvas", "name": "MainMenu",
//     "elements": [{ "type": "Text", "name": "Title", "text": "Hello", "rect": "0,100,400,60" },
//                  { "type": "Button", "name": "PlayButton", "text": "Play", "rect": "0,0,200,60" }] }
// rect is "x,y,width,height" in canvas space (anchored position + size).

#if UNITY_EDITOR
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using UnityEngine.UI;
using System;
using System.IO;

[InitializeOnLoad]
public static class CodeFoxBridge
{
    // Version of this bridge file. CodeFox reads this marker to tell
    // whether the bridge installed in a project is older than the one
    // bundled with the app, so it can update it automatically.
    public const string BridgeVersion = "0.5.2";
    private const string TriggerFileName = ".codefox-refresh-trigger";
    private const string CommandFileName = ".codefox-command.json";
    private const string ResultFileName = ".codefox-result.json";
    private static string _triggerPath;
    private static string _commandPath;
    private static string _resultPath;
    private static string _lastTriggerContent = "";
    private static double _nextCheckTime = 0;
    private const double CheckIntervalSeconds = 1.0;

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
    [Serializable]
    private class CFResult { public bool ok; public string message; public string path; }

    static CodeFoxBridge()
    {
        _triggerPath = Path.Combine(Application.dataPath, TriggerFileName);
        _commandPath = Path.Combine(Application.dataPath, CommandFileName);
        _resultPath = Path.Combine(Application.dataPath, ResultFileName);
        EditorApplication.update += OnEditorUpdate;
        Debug.Log("[CodeFox] Bridge active. Watching for file changes and commands.");
    }

    private static void OnEditorUpdate()
    {
        if (EditorApplication.timeSinceStartup < _nextCheckTime) return;
        _nextCheckTime = EditorApplication.timeSinceStartup + CheckIntervalSeconds;

        if (File.Exists(_triggerPath))
        {
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

        if (File.Exists(_commandPath))
        {
            string json = null;
            try { json = File.ReadAllText(_commandPath); } catch (IOException) { }
            if (json != null)
            {
                try
                {
                    CFResult result = ExecuteCommand(json);
                    WriteResult(result);
                }
                catch (Exception e)
                {
                    WriteResult(new CFResult { ok = false, message = "Command failed: " + e.Message });
                }
                finally
                {
                    try { File.Delete(_commandPath); } catch (IOException) { }
                }
            }
        }
    }

    private static void WriteResult(CFResult result)
    {
        try
        {
            // Hand-rolled JSON so a failure inside JsonUtility cannot hide the error.
            string json = "{\"ok\":" + (result.ok ? "true" : "false")
                + ",\"message\":\"" + EscapeJson(result.message ?? "")
                + "\",\"path\":\"" + EscapeJson(result.path ?? "") + "\"}";
            File.WriteAllText(_resultPath, json);
        }
        catch (Exception e) { Debug.LogWarning("[CodeFox] Could not write result file: " + e.Message); }
    }

    private static string EscapeJson(string s)
    {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
    }

    private static CFResult ExecuteCommand(string json)
    {
        CFCommand cmd;
        try { cmd = JsonUtility.FromJson<CFCommand>(json); }
        catch (Exception e) { return new CFResult { ok = false, message = "Could not parse command JSON: " + e.Message }; }
        if (cmd == null || string.IsNullOrEmpty(cmd.action))
            return new CFResult { ok = false, message = "Command JSON has no action." };

        switch (cmd.action)
        {
            case "refresh":
                AssetDatabase.Refresh();
                return new CFResult { ok = true, message = "AssetDatabase refreshed." };
            case "createAnimatorController":
                return CreateAnimatorController(cmd);
            case "createUICanvas":
                return CreateUICanvas(cmd);
            default:
                return new CFResult { ok = false, message = "Unknown action: " + cmd.action };
        }
    }

    private static CFResult CreateAnimatorController(CFCommand cmd)
    {
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
            return new CFResult { ok = false, message = "Could not create Animator Controller at " + assetPath };

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
        return new CFResult { ok = true, message = "Animator Controller created.", path = assetPath };
    }

    private static AnimatorState FindState(AnimatorStateMachine sm, string name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        foreach (var child in sm.states)
            if (child.state != null && child.state.name == name) return child.state;
        return null;
    }

    private static CFResult CreateUICanvas(CFCommand cmd)
    {
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
        return new CFResult { ok = true, message = "UI Canvas created: " + name, path = name };
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
