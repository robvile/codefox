# Photon (PUN + Fusion)

Hosted cloud relay for Unity multiplayer. Photon runs the servers: clients connect to Photon's cloud, join rooms, and the relay moves the messages. You do not run a server yourself. There are two products under the name, and they are not interchangeable — pick by the game, not by habit.

## PUN (Photon Unity Networking)

The simple one. Rooms, players, and remote procedure calls, with very little code. A player joins a room; every player in the room sees the same objects; `PhotonView` marks what is networked. Best for small games, prototypes, and turn-based or slow realtime play. **PUN is in maintenance** — Photon no longer actively develops it, and new projects should look at Fusion first. PUN stays here because existing projects still run it.

## Fusion

The high-performance one. A tick-based simulation with state authority: the host (or a dedicated server) runs the simulation, clients send input, and the server sends back the resulting state. Best for fast realtime games — shooters, racing, anything where prediction and lag compensation matter. Fusion has two modes: Host Mode (one player is the server) and Shared Mode (Photon runs the simulation in the cloud and every client is equal). The API differs between them; check which mode the project uses before writing code.

## Packages

- PUN: `PUN 2 - FREE` from the Asset Store (package `PUN 2`, namespaces `Photon.Pun` and `Photon.Realtime`).
- Fusion: `Fusion` from the Asset Store (`com.exitgames.fusion`, namespace `Fusion`). Fusion 2 is the current version; Fusion 1 projects exist and differ in places — check the installed version first.

## Docs

- Photon docs: https://doc.photonengine.com/
- PUN: https://doc.photonengine.com/pun/current/getting-started/pun-intro
- Fusion: https://doc.photonengine.com/fusion/current/getting-started/fusion-intro

Always check the API against the installed package version. The AppId and the dashboard live at https://dashboard.photonengine.com — the user owns that account, not CodeFox.

## Files

| File | Contents |
| ---- | -------- |
| `README.md` | This file. |
| `SETUP.md` | AppId, server settings, and the runner (PUN and Fusion). |
| `EXAMPLES_PUN.md` | Minimal, self-contained PUN examples. |
| `EXAMPLES_FUSION.md` | Minimal, self-contained Fusion examples. |
| `DEBUGGING.md` | Photon-specific common problems and fixes (PUN + Fusion). |
| `BEST_PRACTICES.md` | Photon-specific best practices. |
