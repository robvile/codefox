# Nakama (Heroic Labs)

Open-source game server and backend. Nakama is not a Unity networking library — it is a server you run (usually in Docker) that gives the game accounts, sessions, realtime matches, a matchmaker, leaderboards, chat, and storage, with a Unity SDK that talks to it. Use it when the game needs a backend as well as multiplayer: accounts that persist, matchmaking, ranked play, or server-authoritative matches without building a server from scratch.

## What it is

- The **server** runs matches and stores data. Clients never talk to each other directly — they talk to the server, and the server relays or authoritatively runs the match.
- The **client** (`Nakama.Client`) authenticates a session and makes API calls (accounts, storage, leaderboards).
- The **socket** (`Nakama.ISocket`) is the realtime connection: matches, match state, matchmaker, chat, and presence all travel over it.
- A **match** is a realtime session on the server. Two kinds: relayed (the server forwards messages between clients, no server logic) and authoritative (server code runs the match — written in Go, Lua, or TypeScript on the server, not in Unity).
- The **matchmaker** pairs players by query (skill, region, mode) and returns a match to join.

## Packages

- Nakama Unity SDK (`com.heroiclabs.nakama-unity`) — via the Unity Package Manager with the Git URL from the Nakama docs, or from the Asset Store. Namespaces: `Nakama`, `Nakama.TinyJson` for the small JSON helper.
- The server itself: the official Docker image (`heroiclabs/nakama`) or a binary release. The user runs it — never start a server programmatically from the game.

## Docs

- Official docs: https://heroiclabs.com/docs/
- Unity client guide: https://heroiclabs.com/docs/nakama/client-libraries/unity/
- Server Docker setup: https://heroiclabs.com/docs/nakama/getting-started/docker/

Always check the API against the installed SDK version — the client and socket APIs have changed between major versions. The version is in `Packages/manifest.json` and `Packages/packages-lock.json`.

## Files

| File | Contents |
| ---- | -------- |
| `README.md` | This file. |
| `SETUP.md` | Run the server, install the SDK, client and socket, authenticate. |
| `EXAMPLES.md` | Minimal, self-contained client examples: auth, socket, match, matchmaker. |
| `DEBUGGING.md` | Nakama-specific common problems and fixes. |
| `BEST_PRACTICES.md` | Nakama-specific best practices. |
