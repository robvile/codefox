# FishNet

Free, open-source networking for Unity, built prediction-first. FishNet's pitch is control: the transport is swappable, the tick is explicit, and the prediction and reconciliation model is designed for fast games where the client predicts its own movement and the server corrects it. Use it when the game is realtime and latency-sensitive and the team wants to own the whole stack without a hosted service.

## What it is

- A `NetworkManager` (FishNet's own) owns the session, with a `ServerManager` and a `ClientManager` under it. The default transport is Tugboat (UDP), swappable for others.
- `NetworkObject` marks a GameObject as networked. `NetworkBehaviour` is the script base class. `[ServerRpc]`, `[ObserversRpc]`, and `[TargetRpc]` are the calls between sides. `[SyncVar]` syncs a field; `SyncList` and `SyncDictionary` sync collections.
- A `TimeManager` runs the tick: server-authoritative logic subscribes to its tick event instead of running in `Update`.
- Player spawning is usually handled by the `PlayerSpawner` component that ships with FishNet, or by hand from the server connection callback.

## Packages

- FishNet from the Asset Store (free; namespaces `FishNet.Object`, `FishNet.Managing`, `FishNet.Transporting.Tugboat`). It is also on GitHub, where the source lives.
- ParrelSync (free, from GitHub or the Asset Store) for testing with several editor instances — the usual way to test FishNet locally.

## Docs

- Official docs: https://fish-networking.gitbook.io/docs/
- GitHub: https://github.com/FirstGearGames/FishNet

Always check the API against the installed FishNet version — the RPC attributes and the spawning flow have changed between major versions. The version is in the FishNet assembly and the Asset Store listing.

## Files

| File | Contents |
| ---- | -------- |
| `README.md` | This file. |
| `SETUP.md` | NetworkManager, Tugboat, player spawner. |
| `EXAMPLES.md` | Minimal, self-contained examples: connect, a SyncVar, RPCs, a tick. |
| `DEBUGGING.md` | FishNet-specific common problems and fixes. |
| `BEST_PRACTICES.md` | FishNet-specific best practices. |
