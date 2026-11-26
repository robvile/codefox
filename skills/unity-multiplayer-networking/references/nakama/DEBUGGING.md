# Nakama Debugging

Read the common `DEBUGGING.md` first — configuration is the usual culprit.

## Connection refused / "Unable to connect to the server"

- The server is not running. Open `http://127.0.0.1:7350/` in a browser — if it does not answer, start the server (Docker) before touching client code.
- The port is wrong. The HTTP API is 7350 by default; the gRPC API is 7351. The Unity SDK defaults to 7350.
- The game runs on another machine (or a build) and the server address is still `127.0.0.1`. Localhost means "this machine" — a build on another machine needs the server's real address.
- A firewall blocks the port on the server's machine.

## Authentication fails

- The server key is wrong. The default is `defaultkey`; a server started with a custom key rejects the default. Check the key the server was started with.
- The session expired. Sessions expire — re-authenticate and reconnect the socket instead of retrying the failed call.
- Device auth on WebGL: `SystemInfo.deviceUniqueIdentifier` is not stable there. Use email or guest auth for WebGL builds.

## The socket connects but match calls fail

- The socket is not connected yet. Match, matchmaker, and chat calls all need `ConnectAsync` to have completed — await it, then call them.
- The match id is wrong or the match ended. A match id from an earlier session is stale; create or join a fresh one.
- The matchmaker ticket was cancelled or expired. A ticket that never matches is usually a query that matches nobody — check the query against the players actually in the queue.

## Match state never arrives

- The op code does not match. The sender and the receiver must agree on what each op code means — check both sides use the same numbers. Reserve ranges per system so two systems never collide.
- The state is sent as a string where bytes were expected, or the JSON is malformed. `SendMatchStateAsync` takes a byte array; encode the JSON with `Encoding.UTF8.GetBytes` and decode it the same way.
- The receiver is not in the match. `ReceivedMatchState` only fires for users in that match — check the presence list first.
- The sender is not in the match either. A client that never joined cannot send to it.

## Presence is wrong (players shown as joined who left, or vice versa)

- The socket was created with `appearOnline` false, so presence is never reported. `ConnectAsync(session, true)` is the usual call.
- The client disconnected without leaving the match. The server times presence out; until then the player looks present. Handle the leave event as the source of truth, not a local list.

## The game works locally and not against the hosted server

- The hosted server has a different server key, a different address, or a different version than the local one. Check all three before suspecting code.
- The hosted server's ports are not open. Local Docker has no firewall in the way; a hosted server does.
