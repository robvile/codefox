# Unity Netcode for GameObjects (NGO)

First-party networking for Unity, server-authoritative by design. This is the default stack when the user has not chosen one: it is made by Unity, it is free, and it needs no external service for a direct connection. Use it for small to medium realtime games — co-op, versus, a shared world — where the host is one of the players or a dedicated server you run yourself.

## What it is

- A `NetworkManager` owns the session: it starts a host, a server, or a client, and spawns player objects.
- `NetworkObject` marks a GameObject as networked. `NetworkBehaviour` is the script base class for networked logic. `NetworkVariable<T>` syncs a value from its writer to everyone else. `ServerRpc` sends a call from a client to the server; `ClientRpc` sends one from the server to clients.
- The default transport is Unity Transport (`com.unity.transport`). Relay (Unity Gaming Services) is an optional add-on for players behind NAT.

## Packages

- `com.unity.netcode.gameobjects` — Netcode itself.
- `com.unity.transport` — the transport it runs on (usually pulled in automatically).
- `com.unity.multiplayer.playmode` — Multiplayer Play Mode, for running several virtual players in the editor while testing.

## Docs

- Official docs: https://docs.unity.com/ugs/en-us/manual/netcode/manual/index.html
- API reference: https://docs.unity3d.com/Packages/com.unity.netcode.gameobjects@latest

Always check the API against the installed package version — NGO 1.x and 2.x differ in places (ClientRpc targeting, for example). The version is in `Packages/manifest.json` and `Packages/packages-lock.json`.

## Files

| File | Contents |
| ---- | -------- |
| `README.md` | This file. |
| `SETUP.md` | Packages, NetworkManager, transport, player prefab. |
| `EXAMPLES.md` | Minimal self-contained examples: host/client buttons, a synced value, a ServerRpc, a ClientRpc. |
| `DEBUGGING.md` | Netcode-specific common problems and fixes. |
| `BEST_PRACTICES.md` | Netcode-specific best practices. |
