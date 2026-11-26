# Netcode Examples

Minimal, self-contained examples. Match their structure before writing networked code — the API calls here are the ones that work on NGO 1.x and 2.x. Check the installed version's docs when anything differs.

## Host / client buttons

Attach to a UI script in the first scene. `NetworkManager.Singleton` is the session — there is exactly one.

```csharp
using UnityEngine;
using Unity.Netcode;

public class ConnectionButtons : MonoBehaviour
{
    void OnGUI()
    {
        GUILayout.BeginArea(new Rect(10, 10, 300, 300));
        if (!NetworkManager.Singleton.IsClient && !NetworkManager.Singleton.IsServer)
        {
            if (GUILayout.Button("Host")) NetworkManager.Singleton.StartHost();
            if (GUILayout.Button("Client")) NetworkManager.Singleton.StartClient();
            if (GUILayout.Button("Server")) NetworkManager.Singleton.StartServer();
        }
        else
        {
            GUILayout.Label("Mode: " + (NetworkManager.Singleton.IsHost ? "Host" : NetworkManager.Singleton.IsServer ? "Server" : "Client"));
            GUILayout.Label("Client id: " + NetworkManager.Singleton.LocalClientId);
            if (GUILayout.Button("Disconnect")) NetworkManager.Singleton.Shutdown();
        }
        GUILayout.EndArea();
    }
}
```

## A synced value (NetworkVariable)

A `NetworkVariable` is owned by one writer and read by everyone. Here the server owns the score; clients only read it. `OnValueChanged` runs on every side when the value changes.

```csharp
using Unity.Netcode;
using UnityEngine;

public class Scoreboard : NetworkBehaviour
{
    // Everyone may read; only the server may write.
    private NetworkVariable<int> score = new NetworkVariable<int>(
        0,
        NetworkVariableReadPermission.Everyone,
        NetworkVariableWritePermission.Server);

    public override void OnNetworkSpawn()
    {
        score.OnValueChanged += (previous, next) =>
        {
            Debug.Log("Score changed: " + previous + " -> " + next);
        };
    }

    // Called on the server only. A client calling this does nothing.
    public void AddPoint()
    {
        if (!IsServer) return;
        score.Value += 1;
    }
}
```

## Client asks, server decides (ServerRpc)

The owning client sends a request; the server validates it and applies it. `RequireOwnership` defaults to true: only the client that owns the object may call its ServerRpcs.

```csharp
using Unity.Netcode;
using UnityEngine;

public class PlayerMover : NetworkBehaviour
{
    public float speed = 5f;

    void Update()
    {
        // Only the owning client reads its own input.
        if (!IsOwner) return;
        Vector3 move = new Vector3(Input.GetAxis("Horizontal"), 0, Input.GetAxis("Vertical"));
        if (move.sqrMagnitude > 0.01f)
        {
            // Ask the server to move us. The server is the authority.
            SubmitMoveServerRpc(move * speed * Time.deltaTime);
        }
    }

    [ServerRpc]
    void SubmitMoveServerRpc(Vector3 delta, ServerRpcParams rpcParams = default)
    {
        // Runs on the server. Validate here: clamp the step so a
        // tampered client cannot teleport.
        if (delta.magnitude > 0.5f) return;
        transform.position += delta;
    }
}
```

Notes: `NetworkTransform` (a component, not code) is the usual way to sync a moving object's position — it sends position, rotation, and scale on a timer with interpolation. The ServerRpc above moves the object on the server; the NetworkTransform then replicates it to clients. Do not move the object on the client and also sync it — the two will fight.

## Server tells clients (ClientRpc)

The server calls this and every client runs it. Use it for one-off events (a sound, a flash, a message), not for state — a client that joins later never sees it.

```csharp
using Unity.Netcode;
using UnityEngine;

public class GameAnnouncer : NetworkBehaviour
{
    // Runs on the server, for example when a round ends.
    public void AnnounceWinner(string playerName)
    {
        if (!IsServer) return;
        ShowWinnerClientRpc(playerName);
    }

    [ClientRpc]
    void ShowWinnerClientRpc(string playerName)
    {
        Debug.Log("Winner: " + playerName);
    }
}
```

## Spawning a networked object

Only the server spawns. The prefab must have a `NetworkObject`, and it must be registered: either set as the player prefab, or listed in the NetworkManager's `Network Prefabs` list.

```csharp
using Unity.Netcode;
using UnityEngine;

public class CrateSpawner : NetworkBehaviour
{
    public GameObject cratePrefab;

    public void SpawnCrate(Vector3 at)
    {
        if (!IsServer) return;
        GameObject crate = Instantiate(cratePrefab, at, Quaternion.identity);
        // Spawn() replicates the object to every connected client.
        crate.GetComponent<NetworkObject>().Spawn();
    }
}
```

To remove it, call `GetComponent<NetworkObject>().Despawn()` on the server — never `Destroy` a networked object directly; clients would keep their copies.
