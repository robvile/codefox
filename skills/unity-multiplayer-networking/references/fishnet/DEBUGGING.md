# FishNet Debugging

Read the common `DEBUGGING.md` first — configuration is the usual culprit.

## The client connects but nothing spawns

- The PlayerSpawner is missing, or its player prefab is empty. Check the component in the scene.
- The hand-spawn hook is on the wrong event: spawn in `ServerManager.OnServerConnectionState` when the state becomes `Started`, not in `Start`.
- The prefab has no `NetworkObject` component. FishNet cannot spawn it without one.

## A ServerRpc never runs

- The caller does not own the object and the RPC requires ownership (the default). Call it from the owner, or set `[ServerRpc(RequireOwnership = false)]` and validate the sender.
- The object is not spawned. RPCs only work on spawned objects — check `IsSpawned` before calling.
- The method is not on a `NetworkBehaviour`, or the attribute is on a method with an unsupported signature (RPCs take serializable arguments only).

## A SyncVar never changes on clients

- The writer is not the side allowed to write it. By default the server writes a SyncVar; a client writing one is silently ignored.
- The `OnChange` callback name is misspelled. `[SyncVar(OnChange = nameof(OnHealthChanged))]` is checked at compile time by `nameof`; a string literal is not.
- The value is set before the object spawns. Set initial values in `OnStartServer` / `OnStartClient` or after spawn, not in the field initializer alone — the initializer runs on every side independently.

## ObserversRpc reaches nobody (or everybody)

- `[ObserversRpc]` goes to clients that observe the object. An object nobody observes reaches nobody. Check the object's observer set — scene objects and spawned objects have different observer rules.
- For a message to one player, use `[TargetRpc]` with that player's `NetworkConnection`, not an ObserversRpc with a manual check inside.

## Movement stutters or rubber-bands

- Server logic runs in `Update` instead of on the TimeManager tick. Move it to `TimeManager.OnTick`.
- The client predicts movement the server does not confirm. FishNet's prediction model needs the client and server to run the same movement code on the same tick — a difference between the two is a correction every tick.
- The tick rate and the physics step disagree. Note both values; they are different clocks.

## Connection fails immediately

- The transport is not set, or the port is wrong. Check `TransportManager` on the NetworkManager — Tugboat must be the transport, and the client must connect to the port the server listens on.
- A firewall or a second instance already holds the port. One server per port.
- The client and server run different versions of the game. Mismatched builds desync or fail to connect.

## Errors after a scene change

- Networked scene objects must exist in the scene on every side when it loads. An object added to the scene on the server only is local-only until it is spawned.
- The NetworkManager was duplicated across scenes. There must be exactly one — keep it in a bootstrap scene that is never unloaded, or destroy duplicates on load.
