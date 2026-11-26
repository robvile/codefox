// EvalProbe — HARNESS-OWNED (v0.18.0 eval fixture).
//
// The model must never edit this file: the harness protects it in
// every no_collateral check, and a changed probe fails the task.
// It watches the Player during Play Mode and logs [EVAL] key=value
// lines the grader parses: jumped (player rose 0.5m), rotated
// (player turned more than 5 degrees), plus a 1-second heartbeat
// of the player's position and rotation.
using UnityEngine;

public class EvalProbe : MonoBehaviour
{
    public string playerName = "Player";
    private Transform player;
    private float startY;
    private bool jumped;
    private bool rotated;
    private float nextLog;

    void Start()
    {
        var go = GameObject.Find(playerName);
        player = go ? go.transform : null;
        startY = player ? player.position.y : 0f;
    }

    void Update()
    {
        if (!player) return;
        float y = player.position.y;
        float rotY = player.eulerAngles.y;
        if (!jumped && y > startY + 0.5f)
        {
            jumped = true;
            Debug.Log("[EVAL] jumped=true maxY=" + y.ToString("F2"));
        }
        if (!rotated && rotY > 5f && rotY < 355f)
        {
            rotated = true;
            Debug.Log("[EVAL] rotated=true rotY=" + rotY.ToString("F1"));
        }
        if (Time.time >= nextLog)
        {
            nextLog = Time.time + 1f;
            Debug.Log("[EVAL] playerY=" + y.ToString("F2") + " playerRotY=" + rotY.ToString("F1"));
        }
    }
}
