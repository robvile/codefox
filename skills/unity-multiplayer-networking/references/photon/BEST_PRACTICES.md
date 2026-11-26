# Photon Best Practices

These add to the common `BEST_PRACTICES.md`. They never contradict it.

## PUN

- **Use the master client as the referee.** PUN has no server. `PhotonNetwork.IsMasterClient` is the closest thing: put validation, spawning, and round control there. When the master leaves, a new one is elected — write the handover so the game survives it.
- **Prefer `nameof()` for RPC names.** A string literal typo compiles and fails silently at runtime.
- **Keep observed data small.** `OnPhotonSerializeView` runs on a timer for every observed object. Sending a whole inventory every tick is the fastest way to saturate a room.
- **Do not put secrets in the client.** The AppId is public by design; anything else (dashboard credentials, webhooks) stays out of the build.

## Fusion

- **Design around the tick.** `FixedUpdateNetwork` is the simulation; `Update` is rendering. Gameplay logic lives in the tick; `Update` only reads `Networked` state and renders it. Logic in `Update` desyncs, because the tick and the frame are different clocks.
- **Keep `[Networked]` state minimal.** Every Networked property is replicated. State that only one player needs (their own camera, their own UI) is not Networked.
- **Use `OnChangedRender` for reactions.** A Networked value changing is a render event: play the sound, flash the UI, spawn the effect there — not in the simulation.
- **Know the mode's authority rules.** Host Mode: the host has state authority. Shared Mode: Photon simulates and no player has state authority. Code that assumes one mode breaks in the other — check `GameMode` before writing authority assumptions into gameplay.
- **Test with the tick rate the game will ship with.** The default is 60. A game tuned at 60 and shipped at 30 feels different; decide the rate early and test at it.
