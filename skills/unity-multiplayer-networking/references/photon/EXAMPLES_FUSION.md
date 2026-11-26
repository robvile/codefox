# Photon Fusion Examples

Minimal, self-contained Fusion 2 examples. Match their structure before writing networked code. Fusion's API is tick-based: the simulation runs at a fixed tick rate, clients send input, and `[Networked]` properties carry state. Check the installed Fusion version — Fusion 1 differs in places.

## Start a session (Host Mode)

`NetworkRunner.StartGame` is async — await it. `GameMode.Host` makes this player the server; `GameMode.Client` joins an existing session by name.

```csharp
using System.Threading.Tasks;
using Fusion;
using UnityEngine;

public class FusionConnector : MonoBehaviour
{
    private NetworkRunner runner;

    async void Start()
    {
        runner = gameObject.AddComponent<NetworkRunner>();
        // Loads scenes for all players when the session starts.
        gameObject.AddComponent<NetworkSceneManagerDefault>();

        var result = await runner.StartGame(new StartGameArgs
        {
            GameMode = GameMode.Host,
            SessionName = "MyGameSession",
            Scene = SceneRef.FromIndex(1),
            PlayerCount = 4,
        });

        if (!result.Ok)
        {
            Debug.LogError("StartGame failed: " + result.ShutdownReason);
            return;
        }
        Debug.Log("Session running as host.");
    }
}
```

## A networked value

`[Networked]` properties are the state. Only the side with state authority may set them; everyone else reads. `OnChangedRender` runs on clients when the value changes, so the render side can react.

```csharp
using Fusion;
using UnityEngine;

public class FusionPlayer : NetworkBehaviour
{
    [Networked, OnChangedRender(nameof(OnHealthChanged))]
    public int Health { get; set; }

    public override void Spawned()
    {
        if (HasStateAuthority)
        {
            Health = 100;
        }
    }

    public void TakeDamage(int amount)
    {
        // Only the state authority may change a Networked property.
        if (!HasStateAuthority) return;
        Health -= amount;
    }

    void OnHealthChanged()
    {
        Debug.Log("Health is now " + Health);
    }
}
```

## Input and movement

Clients send input once per tick; the behaviour reads it on the state-authority side. The input struct is the contract — keep it small.

```csharp
using Fusion;
using UnityEngine;

public struct PlayerInputData : INetworkInput
{
    public Vector2 move;
}

public class FusionMover : NetworkBehaviour, INetworkRunnerCallbacks
{
    public float speed = 5f;

    public override void FixedUpdateNetwork()
    {
        // Runs once per simulation tick, on the state authority.
        if (GetInput(out PlayerInputData input))
        {
            Vector3 delta = new Vector3(input.move.x, 0, input.move.y) * speed * Runner.DeltaTime;
            transform.position += delta;
        }
    }

    // The runner asks each player for input once per tick.
    public void OnInput(NetworkRunner runner, NetworkInput input)
    {
        var data = new PlayerInputData
        {
            move = new Vector2(Input.GetAxis("Horizontal"), Input.GetAxis("Vertical")),
        };
        input.Set(data);
    }

    // Remaining INetworkRunnerCallbacks members: implement the ones
    // the game needs (OnPlayerJoined, OnPlayerLeft,
    // OnConnectedToServer, OnShutdown) and leave the rest empty.
    public void OnPlayerJoined(NetworkRunner runner, PlayerRef player)
    {
        if (runner.IsServer)
        {
            // Spawn a player object for the joiner, owned by them.
            runner.Spawn(PlayerPrefab, Vector3.zero, Quaternion.identity, player);
        }
    }
    public void OnPlayerLeft(NetworkRunner runner, PlayerRef player) { }
    public void OnInputMissing(NetworkRunner runner, PlayerRef player, NetworkInput input) { }
    public void OnShutdown(NetworkRunner runner, ShutdownReason reason) { }
    public void OnConnectedToServer(NetworkRunner runner) { }
    public void OnDisconnectedFromServer(NetworkRunner runner, NetDisconnectReason reason) { }
    public void OnConnectRequest(NetworkRunner runner, NetworkRunnerCallbackArgs.ConnectRequest request, byte[] token) { }
    public void OnConnectFailed(NetworkRunner runner, NetAddress address, NetConnectFailedReason reason) { }
    public void OnUserSimulationMessage(NetworkRunner runner, SimulationMessagePtr message) { }
    public void OnSessionListUpdated(NetworkRunner runner, List<SessionInfo> sessionList) { }
    public void OnCustomAuthenticationResponse(NetworkRunner runner, Dictionary<string, object> data) { }
    public void OnHostMigration(NetworkRunner runner, HostMigrationToken token) { }
    public void OnReliableDataReceived(NetworkRunner runner, PlayerRef player, ReliableKey key, ArraySegment<byte> data) { }
    public void OnReliableDataProgress(NetworkRunner runner, PlayerRef player, ReliableKey key, float progress) { }
    public void OnSceneLoadDone(NetworkRunner runner) { }
    public void OnSceneLoadStart(NetworkRunner runner) { }

    // Set in the inspector: the player prefab (with a NetworkObject).
    public NetworkPrefabRef PlayerPrefab;
}
```

Notes: `Runner.Spawn` takes the player as the last argument — that player gets input authority over the object. `HasStateAuthority` (who may change Networked state) and `HasInputAuthority` (whose input drives the object) are different things; a client usually has input authority over its own player and the host has state authority. Do not confuse them.
