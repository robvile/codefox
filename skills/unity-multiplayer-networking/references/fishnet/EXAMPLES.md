# FishNet Examples

Minimal, self-contained examples. Match their structure before writing networked code. FishNet's RPC attributes are `[ServerRpc]`, `[ObserversRpc]`, and `[TargetRpc]`; a `[SyncVar]` field syncs from its writer to everyone else.

## Connect (server and client)

FishNet has no single StartHost call. A host starts the server, then starts the client on the same instance.

```csharp
using FishNet.Managing;
using FishNet.Transporting;
using UnityEngine;

public class FishNetConnector : MonoBehaviour
{
    void Start()
    {
        NetworkManager.Singleton.ServerManager.OnServerConnectionState += (args) =>
        {
            Debug.Log("Server state: " + args.ConnectionState);
        };
        NetworkManager.Singleton.ClientManager.OnClientConnectionState += (args) =>
        {
            Debug.Log("Client state: " + args.ConnectionState);
        };
    }

    public void StartAsHost()
    {
        NetworkManager.Singleton.ServerManager.StartConnection();
        NetworkManager.Singleton.ClientManager.StartConnection();
    }

    public void StartAsServer()
    {
        NetworkManager.Singleton.ServerManager.StartConnection();
    }

    public void StartAsClient()
    {
        NetworkManager.Singleton.ClientManager.StartConnection();
    }
}
```

## A synced value (SyncVar)

A `[SyncVar]` is written by its owner (by default the server) and read by everyone. The `OnChange` callback runs on every side when the value changes.

```csharp
using FishNet.Object;
using FishNet.Object.Synchronizing;
using UnityEngine;

public class FishHealth : NetworkBehaviour
{
    [SyncVar(OnChange = nameof(OnHealthChanged))]
    public int Health = 100;

    public void TakeDamage(int amount)
    {
        // Only the server writes a SyncVar.
        if (!IsServer) return;
        Health -= amount;
    }

    void OnHealthChanged(int previous, int next, bool asServer)
    {
        Debug.Log("Health changed: " + previous + " -> " + next);
    }
}
```

## RPCs: client asks, server tells

`[ServerRpc]` runs on the server when a client calls it. By default only the owning client may call it — pass `RequireOwnership = false` to allow any client, and validate the sender yourself. `[ObserversRpc]` runs on every client that can see the object; `[TargetRpc]` runs on one named connection.

```csharp
using FishNet.Connection;
using FishNet.Object;
using UnityEngine;

public class FishShooter : NetworkBehaviour
{
    void Update()
    {
        if (!IsOwner) return;
        if (Input.GetKeyDown(KeyCode.Space))
        {
            FireServerRpc();
        }
    }

    [ServerRpc]
    void FireServerRpc()
    {
        // Runs on the server. Validate here, then tell everyone.
        ShowShotObserversRpc();
    }

    [ObserversRpc]
    void ShowShotObserversRpc()
    {
        // Runs on every observing client.
        Debug.Log("Shot fired");
    }

    [TargetRpc]
    void ShowPrivateMessageTargetRpc(NetworkConnection conn, string text)
    {
        // Runs only on the one connection passed in.
        Debug.Log("Private: " + text);
    }
}
```

## Spawning by hand and the server tick

When the game spawns players itself instead of using the PlayerSpawner, the server connection callback is the hook. Server-authoritative logic runs on the TimeManager tick, not in `Update`.

```csharp
using FishNet.Managing;
using FishNet.Object;
using UnityEngine;

public class FishSpawner : MonoBehaviour
{
    public GameObject playerPrefab;

    void Start()
    {
        NetworkManager.Singleton.ServerManager.OnServerConnectionState += (args) =>
        {
            if (args.ConnectionState == FishNet.Transporting.LocalConnectionState.Started)
            {
                // A client connected: spawn their player, owned by them.
                NetworkObject player = Instantiate(playerPrefab).GetComponent<NetworkObject>();
                NetworkManager.Singleton.ServerManager.Spawn(player, args.Connection);
            }
        };

        // Server-authoritative tick: 30 times a second by default.
        NetworkManager.Singleton.TimeManager.OnTick += () =>
        {
            // Move server-owned objects here, not in Update.
        };
    }
}
```

Notes: `ServerManager.Spawn(obj, connection)` gives that connection ownership of the object. Despawn with `ServerManager.Despawn(obj)` on the server — never `Destroy` a networked object directly.
