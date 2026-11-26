# Nakama Setup

## 1. Run the server

The user runs the server — locally for development, hosted for production. The standard development path is Docker:

```
docker run -p 7350:7350 -p 7351:7351 heroiclabs/nakama
```

- Port **7350** is the HTTP API (authentication, storage, leaderboards). Port **7351** is the gRPC API. The Unity SDK talks to 7350 by default.
- The default server key is `defaultkey`. Change it before anything leaves the local machine — the key is a shared secret between the game and the server, and the default is public knowledge.
- Confirm the server is up before writing client code: open `http://127.0.0.1:7350/` in a browser. A connection-refused error means the server is not running, and no amount of client code will fix that.

## 2. Install the SDK

Install the Nakama Unity SDK (`com.heroiclabs.nakama-unity`) via the Package Manager with the Git URL from the official docs, or from the Asset Store. The user installs it — never install a package programmatically. Check the installed version in `Packages/packages-lock.json` before writing code against it.

## 3. Client, session, socket

The shape of every Nakama client, in order:

1. **Client**: `new Client("http", host, port, serverKey)` — scheme, host, port, server key. Development: `"http", "127.0.0.1", 7350, "defaultkey"`.
2. **Session**: authenticate once, keep the session. Device auth is the development default (`AuthenticateDeviceAsync` with a device id); email, social, and custom auth exist for production. A session expires — the client must re-authenticate when it does.
3. **Socket**: `Socket.From(client)`, then `ConnectAsync(session, true)` — the `true` asks the server to report the socket as online (presence). Matches, match state, and the matchmaker all need the socket connected first.

See EXAMPLES.md for the exact calls.

## 4. Matches: relayed or authoritative

- **Relayed** (the default for a first game): the server forwards match state between clients and runs no game logic. Clients send each other position and events; the server just delivers them. Simple, and the whole game lives in Unity.
- **Authoritative**: match logic runs on the server in Go, Lua, or TypeScript. Clients send inputs; the server validates and broadcasts state. Harder to build, and the right choice when cheating matters — a relayed match trusts the clients.
- Decide this before writing match code. It changes where the game's rules live.

## 5. A minimal connection UI

Give the user a way to start: a button that authenticates and connects the socket, a button that creates or joins a match, and a status label showing session, socket, and match state as they change. Log the match id when a match starts — every later call needs it.

## 6. Check the project configuration

Before writing gameplay code, confirm:

- **The server is reachable from the game.** On the same machine, `127.0.0.1:7350` works. From another machine or a build, the server's address must be reachable from there — localhost is not.
- **Ports are open.** 7350 (and 7351 for gRPC) must not be blocked by a firewall on the server's machine.
- **Input System backend** (Project Settings → Player → Active Input Handler): the input code must use the backend the project has enabled.
- **Physics simulation mode** (Project Settings → Physics / Physics 2D): `Fixed Update` unless the project deliberately drives simulation by hand — triggers that never fire are a config bug, not a Nakama bug.
