# Photon Debugging

Read the common `DEBUGGING.md` first — configuration is the usual culprit.

## PUN

### "Connect failed" / authentication error

The AppId is wrong, missing, or belongs to the other product (a PUN AppId does not work for Fusion and vice versa). Check `PhotonServerSettings` (Window → Photon Unity Networking → Highlight Server Settings). A free plan also has a concurrent-user limit — a room that refuses new players may simply be full for the plan.

### `PhotonNetwork.Instantiate` fails or nothing appears

- The prefab is not in a Resources folder. PUN finds spawnable prefabs by name in Resources — anywhere else, and the call fails.
- The call happened before `OnJoinedRoom`. Instantiate only works inside a room.
- The prefab has no `PhotonView`. PUN instantiates it, but nothing about it is networked.

### An RPC never runs

- The method name is a string and does not match the `[PunRPC]` method exactly — case included. A typo compiles fine and silently does nothing. Prefer `nameof(Method)` over a string literal.
- The method is not marked `[PunRPC]`.
- The `PhotonView` the RPC is called on is not the same view on the receiving side (for example, the RPC was sent on a view that only exists on the sender).

### Everything runs on every client

The `photonView.IsMine` check is missing, so every client runs the local-player code for every player. Guard input and local-only behaviour with `IsMine`. The same applies to the camera: only the owning client should enable the player's camera and audio listener.

### State does not sync

- The script is not in the PhotonView's `Observed Components` list, so `OnPhotonSerializeView` never runs.
- The value is written on a client that is not the owner. PUN replicates from the owner; other clients' writes are ignored.
- The value only changes in an RPC. RPCs are events, not state — a late joiner never sees them. Put the value in `OnPhotonSerializeView` instead.

## Fusion

### `StartGame` fails or returns not OK

- The AppId is wrong or belongs to PUN. Check the Fusion configuration.
- The session name is already in use in a way the mode does not allow, or the scene index does not exist. Check `result.ShutdownReason` — Fusion reports the reason; read it instead of guessing.
- `StartGame` was not awaited. It is async; the runner is not ready until the task completes.

### A `[Networked]` property never changes on clients

- The writer does not have state authority. In Host Mode the host has state authority; a client setting a Networked property is silently ignored. Change it on the state authority side, or send input and let the simulation change it.
- The property has no getter and setter, or it is a field. `[Networked]` only works on properties with `{ get; set; }`.
- The object was spawned but `Spawned()` has not run yet. Set initial values in `Spawned()`, gated on `HasStateAuthority`.

### Input never arrives

- The behaviour does not implement `INetworkRunnerCallbacks`, or `OnInput` is on a different object than the runner's callbacks list. The runner only asks its registered callbacks for input.
- `GetInput` is called outside `FixedUpdateNetwork`. Input is a per-tick concept; reading it in `Update` misses ticks.
- The input struct is too large or contains a type Fusion cannot serialize. Keep it to a few primitives.

### The runner spawns nothing for a joining player

- `OnPlayerJoined` is not implemented, or it spawns only when `runner.IsServer` and the game is in Shared Mode (where there is no server player). In Shared Mode, spawning is done differently — check the mode before writing the spawn code.
- The prefab reference is empty, or the prefab has no `NetworkObject` component.

### The scene never loads for clients

- There is no `NetworkSceneManagerDefault` on the runner's GameObject. Without it, scene loads are local only.
- The scene is not in the build settings. A scene that is not in Build Settings cannot load on any side.
