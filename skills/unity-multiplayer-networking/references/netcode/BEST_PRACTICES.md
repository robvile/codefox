# Netcode Best Practices

These add to the common `BEST_PRACTICES.md`. They never contradict it.

## Ownership and authority

- **Move on the server, or on the owner with server validation.** The common shapes are: (a) the owner sends input with a ServerRpc and the server moves the object; (b) the owner moves its own object and a `NetworkTransform` replicates it, with the server checking the result. Pick one per object and do not mix them.
- **Use `NetworkTransform` for moving objects.** It exists for exactly this: position, rotation, and scale on a timer, with interpolation. Hand-rolling position sync with a NetworkVariable is slower to write and worse to run.
- **Keep ServerRpcs small and validated.** A ServerRpc carries a request, not a result. Validate the sender (`rpcParams.Receive.SenderClientId`), the range, and the timing on the server before applying anything.

## Variables and messages

- **Prefer `NetworkVariable` for state, `ClientRpc` for events.** State is what a late joiner needs; an event is what happened once. A round-start announcement is an event. The score is state.
- **Set write permissions explicitly.** The default is not always what the design wants — say who may write when the variable is created, so the next reader does not have to guess.
- **Do not sync what the client already knows.** The owning client's own input, its camera, its UI — none of that crosses the network.

## Scenes and spawning

- **Load scenes through the NetworkSceneManager.** Direct scene loads split the clients across different scenes with no error.
- **Register every spawnable prefab.** Player prefab, or the NetworkManager's `Network Prefabs` list. An unregistered prefab fails at spawn time, not at build time.
- **Despawn, don't Destroy.** `NetworkObject.Despawn()` on the server removes the object everywhere. `Destroy` on one side leaves ghosts on the others.

## Testing

- **Use Multiplayer Play Mode early.** One editor, several virtual players, no builds. It finds authority and ownership bugs in minutes that two builds find in an hour.
- **Test a late joiner.** Start a game, then connect a second client halfway through. Whatever that client cannot see is state that lives in events instead of variables.
- **Test a disconnect.** Kill a client mid-game and watch the host: the player object must despawn cleanly, and the game must continue.
