# Debugging Multiplayer — Stack-Agnostic

Read this first when a multiplayer feature breaks, before changing any code. Most "networking bugs" are not networking bugs: they are physics settings, project settings, or authority mistakes wearing a networking costume. Work through this file in order, then read the stack-specific `references/<stack>/DEBUGGING.md`.

## The config-first rule

Before blaming the network code, check the project configuration the code depends on. A mismatch here fails silently — nothing throws, the feature just never happens.

1. **Physics simulation mode.** Open Project Settings → Physics (or Physics 2D). If `Simulation Mode` is `Script`, the physics engine only steps when something calls `Physics.Simulate` / `Physics2D.Simulate`. Triggers and collisions never fire on their own, so a trigger-based pickup, hit, or zone silently does nothing — on every client, including the host. Either set the mode back to `Fixed Update`, or make sure the project really does drive simulation by hand. The same applies to `autoSyncTransforms`: when it is off, moving a Transform by code does not update the physics world until the next physics step, so a fast-moving object can pass through a trigger between steps.
2. **Fixed timestep.** Project Settings → Time → Fixed Timestep. The physics step rate and the network tick rate are different clocks. If the timestep is 0.02 (50 Hz) and the network sends at 60 Hz, the two drift apart and movement looks fine locally but stutters or lags remotely. Decide one tick rate for the game and make both sides use it.
3. **Input System backend.** Project Settings → Player → Active Input Handler. A project on the old Input Manager (`Input.GetAxis`, `Input.GetKey`) and a project on the Input System package (`PlayerInput`, `InputAction`) do not mix. If input works in the editor and not in a build, or works for one player and not another, check which backend the code actually uses and which one the project has enabled.
4. **Layers and the collision matrix.** Project Settings → Physics → Layer Collision Matrix (and the 2D equivalent). A trigger never fires when the two layers are not set to collide — even if both objects have colliders, even if one is a trigger. Check the layers on both objects first, then the matrix. The same matrix decides whether a raycast or overlap query sees anything.
5. **Render pipeline.** URP, HDRP, and the built-in pipeline use different materials and shaders. A player that is invisible is often a material problem, not a spawn problem: check the scene has a light, a camera, and a material the pipeline understands before assuming the player never spawned.
6. **Transport settings.** Timeouts, maximum packet size, heartbeat intervals, and relay configuration live in the transport (Unity Transport, Tugboat, Photon Cloud). A connection that drops after a few seconds, or a large state update that never arrives, is usually a transport limit, not game code.

## Symptom table

| Symptom | Check first | Usually |
| ------- | ----------- | ------- |
| Bullets pass through players | Layers, collision matrix, trigger vs collider, simulation mode | Config, not networking |
| Player won't move (remote) | Who owns the object; who is allowed to write its state | Authority / ownership |
| Player won't move (local) | Input backend; whether the input code runs on the owning client only | Input or ownership |
| Trigger never fires | Physics simulation mode, autoSyncTransforms, layer matrix | Config |
| Works on host, not on client | Code that only runs on the host (server-only branch, `IsServer` guard, missing client RPC) | Host-only code path |
| Works on client, not on host | The same, mirrored: a client-only path the host never takes | Host-only code path |
| State doesn't sync | Who may write the variable (write permission / state authority); whether the object was spawned | Authority or spawn |
| Late joiner sees nothing | Whether state lives in a synced variable or only in a one-off RPC the joiner missed | State vs event |
| Rubber-banding / stutter | Tick rate vs send rate; interpolation settings; client prediction absent | Timing |
| Connects, then drops in seconds | Transport timeout / heartbeat; relay config; NAT | Transport |
| Everything works in the editor, nothing in a build | Layers/materials in the build; the player prefab actually in the build; the transport's build settings | Build-only difference |

## Method

1. Reproduce it with two instances and say which side misbehaves — host or client, sender or receiver. "Multiplayer is broken" is not a diagnosis.
2. Check the configuration list above before reading the network code.
3. Read the stack's DEBUGGING.md for the symptom, then the stack's SETUP.md and EXAMPLES for the feature.
4. Add one log line per side at the point the data should cross the network (sent / received), with the client id. Guess from one side only and you will chase the wrong half.
5. Fix one thing at a time. Change the config or the code, never both, and re-test with the same two instances.
6. When the console shows an error, fix the FIRST error first. Later errors are often caused by it — in networking especially, one failed spawn cascades into a dozen null references.

## What not to do

- Do not add a second networking stack to work around a bug in the first.
- Do not "fix" a sync problem by sending more often. Find out why the update never arrives first.
- Do not test with one instance. A single player cannot show an authority bug.
- Do not guess from a native stack trace that has only addresses. Say the cause cannot be confirmed and ask for a managed stack or a log with symbols.
