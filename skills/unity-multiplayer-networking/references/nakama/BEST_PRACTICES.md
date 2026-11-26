# Nakama Best Practices

These add to the common `BEST_PRACTICES.md`. They never contradict it.

## Sessions and sockets

- **Authenticate once, keep the session.** Do not re-authenticate per call. Store the session, check whether it expired, and re-authenticate only then.
- **One socket per client.** The socket is the realtime connection for everything — matches, matchmaker, chat, presence. Do not open a second one.
- **Handle disconnects.** Sockets drop. Reconnect, re-authenticate if the session expired, and re-join the match — do not assume the connection lives for the whole session.

## Matches

- **Decide relayed vs authoritative before writing match code.** Relayed is simpler and trusts the clients; authoritative validates on the server and is the right choice when cheating matters. The decision changes where the game's rules live, so it cannot be made halfway through.
- **Define op codes in one place.** One file, one table: op code, meaning, payload shape. Two systems inventing op codes independently will collide.
- **Send state, not the world.** A position update is small and frequent; a full inventory is large and rare. Do not put the rare thing in the frequent message.
- **Keep match state small.** Match state is a byte array per message. JSON is fine for development; a binary format is worth it when the message rate grows.

## Matchmaker

- **Cancel tickets.** A player who leaves the queue without cancelling keeps matching in the background. Cancel on every exit path.
- **Keep the query honest.** A query that matches nobody is a queue that never fills. Test the query with the players who will actually be in it.

## Security and cost

- **Change the default server key before anything leaves the local machine.** The default key is public knowledge.
- **Do not put the server key in the client build if the server is authoritative.** The key is a shared secret between the game and the server. For production, the game authenticates users (email, social, custom) and the server trusts the session, not the key alone.
- **Know what the hosted server costs.** A server you run yourself costs the machine it runs on; a hosted Nakama costs per the provider's plan. Decide early, because the address and the key change with the choice.
