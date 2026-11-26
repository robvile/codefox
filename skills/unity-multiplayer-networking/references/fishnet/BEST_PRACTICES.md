# FishNet Best Practices

These add to the common `BEST_PRACTICES.md`. They never contradict it.

## Ticks and prediction

- **Run server logic on the tick.** `TimeManager.OnTick` is the server's clock. `Update` is the frame clock. Gameplay that affects more than one player lives on the tick.
- **Keep prediction code identical on both sides.** The client predicts with the same movement code the server runs. A difference between the two is a correction every tick — which is what rubber-banding looks like.
- **Do not fight the reconciler.** When the server corrects a predicted position, accept it. Smoothing the correction is fine; ignoring it desyncs the game.

## Variables and messages

- **Prefer `[SyncVar]` for state, `[ObserversRpc]` for events.** State is what a late joiner needs; an event is what happened once.
- **Use `[TargetRpc]` for one player.** A message for one connection sent to all observers is wasted bandwidth and a leak of information the others should not have.
- **Validate in the ServerRpc.** A ServerRpc with `RequireOwnership = false` accepts calls from any client — check the sender, the range, and the timing before applying anything.

## Spawning

- **Spawn on the server, with ownership.** `ServerManager.Spawn(obj, connection)` gives that connection ownership. An object spawned without a connection is server-owned.
- **Despawn, don't Destroy.** `ServerManager.Despawn(obj)` on the server removes the object everywhere.

## Testing

- **Use ParrelSync early.** Several editor instances, no builds. It finds authority and ownership bugs in minutes.
- **Test a late joiner.** Start a game, then connect a second client halfway through. Whatever that client cannot see is state that lives in events instead of SyncVars.
- **Test a disconnect.** Kill a client mid-game: the player object must despawn cleanly and the game must continue.
