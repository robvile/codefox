// CodeFoxBridge.cs
// CodeFoxBridge version: 0.9.1
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
//
// Prefabs (v0.9.0) — Unity writes prefab files itself; CodeFox never
// hand-writes .prefab YAML (that is how invented script guids and
// "Unknown type 'Image'" happened). The four actions below build and
// change prefabs through Unity's own API, and can ask Unity what
// actually exists in this install before touching anything:
//   { "action": "createPrefab", "name": "ImageContainer", "path": "Assets/Prefabs/ImageContainer.prefab",
//     "root": { "name": "ImageContainer",
//       "components": [{ "type": "RectTransform", "props": { "sizeDelta": [100, 100] } },
//                      { "type": "Image", "props": { "color": [1, 1, 1, 1] } }],
//       "children": [{ "name": "Title", "components": [{ "type": "TextMeshProUGUI", "props": { "text": "Hello" } }] }] } }
//   { "action": "modifyPrefab", "path": "Assets/Prefabs/ImageContainer.prefab",
//     "add": [{ "object": "", "components": [{ "type": "ScrollRect", "props": { "viewport": "Viewport", "content": "Viewport/Content" } }] }],
//     "remove": [{ "object": "Title", "component": "TextMeshProUGUI" }],
//     "set": [{ "object": "", "component": "Image", "props": { "color": [1, 0, 0, 1] } }] }
//     ("object" is a '/'-separated child path inside the prefab;
//     "" or "." means the root. Component references such as a
//     ScrollRect's viewport/content are child names, not guids.)
//   { "action": "listComponentTypes", "filter": "Scroll" }
//   { "action": "describeComponent", "type": "Image" }
// Props take strings, numbers, bools, [x,y(,z)] vectors, [r,g,b(,a)]
// colours (or "#rrggbb"), enum names, and asset paths (Assets/…) for
// Sprite / Material / Texture2D / Font / AudioClip. An unknown type,
// an unknown property, or a missing asset fails the whole command
// with a plain message — nothing is guessed.

#if UNITY_EDITOR
using UnityEditor;
using UnityEditor.Animations;
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
    public const string BridgeVersion = "0.9.1";
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
    private class CFResult { public bool ok; public string message; public string path; public string data; }

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
            // `data` is raw JSON the handler already built (list/describe
            // results) — it is spliced in verbatim, never re-escaped.
            // Results without data are byte-identical to before.
            string json = "{\"ok\":" + (result.ok ? "true" : "false")
                + ",\"message\":\"" + EscapeJson(result.message ?? "")
                + "\",\"path\":\"" + EscapeJson(result.path ?? "") + "\"";
            if (!string.IsNullOrEmpty(result.data)) json += ",\"data\":" + result.data;
            json += "}";
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
            case "createPrefab":
                return CreatePrefab(json);
            case "modifyPrefab":
                return ModifyPrefab(json);
            case "listComponentTypes":
                return ListComponentTypes(json);
            case "describeComponent":
                return DescribeComponent(json);
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

    // Add the components in `specs` (list of {type, props}) to `go`.
    // Returns null on success, or a plain error message.
    private static string AddComponents(GameObject go, List<object> specs, GameObject root)
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
            var props = JObj(spec, "props");
            if (props != null)
            {
                foreach (var kv in props)
                {
                    string err;
                    if (!SetMember(comp, kv.Key, kv.Value, root, out err)) return err;
                }
            }
            // An Image (or any Graphic) draws through a
            // CanvasRenderer — the editor adds one automatically, but
            // AddComponent does not. Its absence was one of the
            // hand-written prefab's bugs.
            if (comp is Graphic && go.GetComponent<CanvasRenderer>() == null)
                go.AddComponent<CanvasRenderer>();
        }
        return null;
    }

    // Build a GameObject subtree from a spec:
    // { name, components: [{type, props}], children: [spec, ...] }.
    // `treeRoot` is the prefab root — component references resolve
    // against it, not against the GameObject being built.
    // Returns null on success, or a plain error message.
    private static string BuildTree(GameObject go, Dictionary<string, object> spec, GameObject treeRoot)
    {
        string err = AddComponents(go, JArr(spec, "components"), treeRoot);
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
            err = BuildTree(childGO, childSpec, treeRoot);
            if (err != null) return err;
        }
        return null;
    }

    private static CFResult CreatePrefab(string json)
    {
        object parsed;
        try { parsed = JsonMini.Parse(json); }
        catch (Exception e) { return new CFResult { ok = false, message = "Could not parse command JSON: " + e.Message }; }
        var cmd = parsed as Dictionary<string, object>;
        if (cmd == null) return new CFResult { ok = false, message = "Command JSON must be an object." };
        string name = JStr(cmd, "name", "");
        if (string.IsNullOrEmpty(name)) return new CFResult { ok = false, message = "createPrefab needs a \"name\"." };
        string assetPath = JStr(cmd, "path", "");
        if (string.IsNullOrEmpty(assetPath))
        {
            string file = name.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) ? name : name + ".prefab";
            assetPath = "Assets/Prefabs/" + file;
        }
        if (!assetPath.StartsWith("Assets/") || !assetPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
            return new CFResult { ok = false, message = "Prefab path must start with Assets/ and end with .prefab — got '" + assetPath + "'." };
        var rootSpec = JObj(cmd, "root");
        if (rootSpec == null) return new CFResult { ok = false, message = "createPrefab needs a \"root\" object with a name and components." };
        string rootName = JStr(rootSpec, "name", name);
        // Build the tree in the scene first, then save — if anything
        // fails, the scene copy is destroyed and no prefab file is
        // left half-written.
        GameObject rootGO = new GameObject(string.IsNullOrEmpty(rootName) ? name : rootName);
        try
        {
            string err = BuildTree(rootGO, rootSpec, rootGO);
            if (err != null) return new CFResult { ok = false, message = err };
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
            if (prefab == null) return new CFResult { ok = false, message = "Unity could not save the prefab at " + assetPath + "." };
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return new CFResult { ok = true, message = "Prefab created.", path = assetPath };
        }
        finally
        {
            // The scene copy is only scaffolding — the prefab asset
            // is the deliverable. Destroy it even on success.
            if (rootGO != null) { try { UnityEngine.Object.DestroyImmediate(rootGO); } catch { } }
        }
    }

    private static CFResult ModifyPrefab(string json)
    {
        object parsed;
        try { parsed = JsonMini.Parse(json); }
        catch (Exception e) { return new CFResult { ok = false, message = "Could not parse command JSON: " + e.Message }; }
        var cmd = parsed as Dictionary<string, object>;
        if (cmd == null) return new CFResult { ok = false, message = "Command JSON must be an object." };
        string assetPath = JStr(cmd, "path", "");
        if (string.IsNullOrEmpty(assetPath)) return new CFResult { ok = false, message = "modifyPrefab needs a \"path\" to the prefab." };
        if (AssetDatabase.LoadAssetAtPath<GameObject>(assetPath) == null)
            return new CFResult { ok = false, message = "Prefab not found: '" + assetPath + "' — the file is not in this project." };
        GameObject contents = PrefabUtility.LoadPrefabContents(assetPath);
        if (contents == null) return new CFResult { ok = false, message = "Could not load the prefab at " + assetPath + "." };
        try
        {
            string err = ApplyPrefabEdits(contents, cmd);
            if (err != null) return new CFResult { ok = false, message = err };
            GameObject saved = PrefabUtility.SaveAsPrefabAsset(contents, assetPath);
            if (saved == null) return new CFResult { ok = false, message = "Unity could not save the prefab at " + assetPath + "." };
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return new CFResult { ok = true, message = "Prefab updated.", path = assetPath };
        }
        finally
        {
            // Unload without saving on the failure path, so a failed
            // edit never leaves the prefab file half-changed.
            PrefabUtility.UnloadPrefabContents(contents);
        }
    }

    // add / remove / set, in that order: components are added before
    // anything is set on them. Returns null on success, or a plain
    // error naming the missing prefab object, type, or property.
    private static string ApplyPrefabEdits(GameObject root, Dictionary<string, object> cmd)
    {
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
                if (entry == null) return "Each \"remove\" entry must be an object like {\"object\": \"\", \"component\": \"Image\"}.";
                string objectPath = JStr(entry, "object", "");
                GameObject target = FindChild(root, objectPath);
                if (target == null) return "No object '" + objectPath + "' in the prefab.";
                string typeName = JStr(entry, "component", "");
                Type type = ResolveComponentType(typeName);
                if (type == null) return UnknownTypeMessage(typeName);
                Component comp = target.GetComponent(type);
                if (comp == null) return "Object '" + (string.IsNullOrEmpty(objectPath) ? target.name : objectPath) + "' has no " + type.Name + " component.";
                if (comp is Transform) return "The Transform cannot be removed.";
                UnityEngine.Object.DestroyImmediate(comp);
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

    private static CFResult ListComponentTypes(string json)
    {
        object parsed;
        try { parsed = JsonMini.Parse(json); }
        catch (Exception e) { return new CFResult { ok = false, message = "Could not parse command JSON: " + e.Message }; }
        var cmd = parsed as Dictionary<string, object>;
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
        var result = new CFResult
        {
            ok = true,
            message = total + " component types" + (string.IsNullOrEmpty(filter) ? "" : " matching '" + filter + "'") + (total > shown ? " — showing the first " + shown + ", narrow the filter to see more." : "."),
            data = sb.ToString()
        };
        return result;
    }

    private static CFResult DescribeComponent(string json)
    {
        object parsed;
        try { parsed = JsonMini.Parse(json); }
        catch (Exception e) { return new CFResult { ok = false, message = "Could not parse command JSON: " + e.Message }; }
        var cmd = parsed as Dictionary<string, object>;
        string typeName = cmd != null ? JStr(cmd, "type", "") : "";
        Type type = ResolveComponentType(typeName);
        if (type == null) return new CFResult { ok = false, message = UnknownTypeMessage(typeName) };
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
        return new CFResult { ok = true, message = type.Name + " (" + type.FullName + ")", data = sb.ToString() };
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
