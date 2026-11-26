# Multiplayer Best Practices — Stack-Agnostic

These apply to every stack. The stack-specific files add to them; they never contradict them.

## Authority

- **The server is the authority for gameplay.** The client asks; the server decides. Movement, damage, pickups, scoring, and spawning are validated on the server. A client that can award itself points by sending a message will do exactly that, the moment anyone looks.
- **Never trust client input.** Validate everything the server receives: is the position reachable, is the action legal right now, does the player own the object they are acting on, is the value in range. Reject the impossible instead of clamping it silently — a rejected action is evidence, a clamped one is a hidden bug.
- **One owner per object.** Exactly one side may write an object's synced state. Everyone else reads. When two sides write, the result is a fight the network loses.
- **Separate state from events.** State is what a late joiner needs to see (health, position, score) — it lives in a synced variable. Events are what happened once (a shot fired, a sound played) — they travel in a one-off message a joiner will never see. Putting an event where state belongs means a player who joins late sees a world that never happened; putting state where an event belongs means every joiner replays history.

## Bandwidth

- **Sync only what others need to see.** Position, rotation, health, and the animation state other players can observe. Not the camera, not the UI, not anything local.
- **Send less, less often.** A position at 10–20 Hz with interpolation looks smooth; 60 Hz of everything does not look three times better and costs three times the bandwidth. Send on change where the stack allows it.
- **Mind the size of a single update.** A full inventory, a long string, or a big array in one synced field is a spike. Split it, or send it once on demand.
- **Cap what the model asks for.** A local model will happily sync the world. Keep the synced surface small and explicit.

## Structure

- **Keep network code in one place.** One folder for networked behaviours, one for the connection and session lifecycle, one for messages. Network code scattered through gameplay scripts is the first thing that rots.
- **Never put network calls in `Update` without a guard.** Send on a timer, on a value change, or on an input event — never every frame by default.
- **Log with the client id.** Every network log line carries who sent it and who it was for. Without that, two instances produce one indistinguishable stream.
- **Version the protocol.** When the shape of a message or a synced field changes, every client must update. Keep a version number on the session, and refuse mismatched clients plainly instead of letting them connect and desync.

## Testing

- **Test with two instances from day one.** One player cannot show an authority bug, an ownership bug, or a late-joiner bug. Host and client, then client and client, then a late joiner.
- **Test the unhappy paths.** A client that disconnects mid-game, a host that quits, a packet that never arrives, a player who joins after the game started. These are not edge cases; they are Tuesday.
- **Test on the target platforms early.** A relay that works on desktop may not work on the console or mobile network the game ships on. Transport behaviour, NAT, and permissions differ per platform.

## Security and cost

- **Do not ship the server key, AppId secret, or admin token in the client.** Anything in the build is public. Keep secrets server-side and hand the client only what it needs to connect.
- **Know what the hosted parts cost.** Relay traffic, rooms, and matchmaking are metered on most hosted services. A design that relays everything through the cloud costs more than one that connects peers directly where it can.
