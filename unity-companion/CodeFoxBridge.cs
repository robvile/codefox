// CodeFoxBridge.cs
// Place this file in: Assets/Editor/CodeFoxBridge.cs
// Watches for file changes from the CodeFox app and auto-refreshes Unity's AssetDatabase.

#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using System.IO;

[InitializeOnLoad]
public static class CodeFoxBridge
{
    private const string TriggerFileName = ".codefox-refresh-trigger";
    private static string _triggerPath;
    private static string _lastTriggerContent = "";
    private static double _nextCheckTime = 0;
    private const double CheckIntervalSeconds = 1.0;

    static CodeFoxBridge()
    {
        _triggerPath = Path.Combine(Application.dataPath, TriggerFileName);
        EditorApplication.update += OnEditorUpdate;
        Debug.Log("[CodeFox] Bridge active. Watching for file changes.");
    }

    private static void OnEditorUpdate()
    {
        if (EditorApplication.timeSinceStartup < _nextCheckTime) return;
        _nextCheckTime = EditorApplication.timeSinceStartup + CheckIntervalSeconds;

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
}
#endif
