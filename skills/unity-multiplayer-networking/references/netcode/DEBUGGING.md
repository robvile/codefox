# Netcode Debugging

Read the common `DEBUGGING.md` first — configuration is the usual culprit. These are the Netcode-specific failures, in the order to check them.

## "Spawning object without a NetworkObject"

The prefab has no `NetworkObject` component, or the object was instantiated with plain `Instantiate` instead of `Spawn()`. Fix: add `NetworkObject` to the prefab, and spawn from the server with `GetComponent<NetworkObject>().Spawn()`. A networked object must also be registered: player prefab, or the NetworkManager's `Network Prefabs` list.

## "Not spawned" / "Object is not spawned" when calling an RPC

The `NetworkBehaviour` is not spawned yet. RPCs only work on spawned objects. Common cause: calling an RPC from `Start` or `Awake` before `OnNetworkSpawn` ran. Wait for `OnNetworkSpawn`, or check `IsSpawned` first.

## A ServerRpc never runs

- The caller does not own the object and the RPC requires ownership (the default). Either call it from the owner, or set `[ServerRpc(RequireOwnership = false)]` and validate the sender with `rpcParams.Receive.SenderClientId`.
- The object is not spawned (see above).
- The method is not on a `NetworkBehaviour`. RPCs only exist on networked behaviours.

## A NetworkVariable never changes on clients

- The writer is not the side allowed to write it. A variable with `NetworkVariableWritePermission.Server` written by a client is silently ignored. Check the permissions set when the variable was created.
- The variable was created after spawn with a different initial value per side. Create it in the field declaration so every side starts from the same value.
- Nobody is observing it. A `NetworkVariable` with no `OnValueChanged` handler and no UI reading it looks unchanged even when it syncs — log the value on change to confirm.

## The client connects but sees no other players

- The player prefab is not set in the NetworkManager, so nothing spawns for the new client.
- The players spawned but are invisible: no light, no camera, or a material the render pipeline does not understand. Check the scene essentials before assuming the spawn failed.
- The scene was loaded directly (`SceneManager.LoadScene`) instead of through `NetworkManager.SceneManager.LoadScene`, so clients are in a different scene.

## Movement stutters or rubber-bands

- The object is moved on the client and also synced by `NetworkTransform` — the two fight. Move on the server (or on the owner, with the server validating), and let the transform replicate.
- `NetworkTransform` interpolation is off, or the send rate is too low for the speed. Check the component's interpolation and send settings.
- The fixed timestep and the network tick disagree. Note both values; they are different clocks.

## Connection fails immediately

- The address is wrong, or nothing is listening: start a host or server first, then connect the client to that machine's address. Localhost only works when both run on the same machine.
- The transport is misconfigured: check the `UnityTransport` component on the NetworkManager. For internet play behind NAT, a direct connection usually fails — Relay is needed, and that is a separate setup the user must enable.
- The client and host run different versions of the game. Netcode does not guarantee compatibility across versions — mismatched clients desync or fail to connect.

## Errors after a scene change

- Scene objects that were networked in the old scene are gone; objects spawned at runtime are despawned unless they are marked `DontDestroyWithOwner` or re-spawned. Load scenes through the NetworkSceneManager and re-spawn what the new scene needs.
- Two NetworkManagers exist (one per scene, both marked DontDestroyOnLoad). There must be exactly one: keep it in a bootstrap scene that is never unloaded, or destroy duplicates on load.
