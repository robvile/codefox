# Metaplay Best Practices

These add to the common `BEST_PRACTICES.md`. They never contradict it.

## Determinism

- **The model is pure.** No randomness without a seeded source, no wall-clock time, no dictionary iteration order, no floating-point operations whose order differs per side. A model that is not deterministic is a game that desyncs.
- **No UnityEngine in shared code.** Shared code runs on the server without Unity. A Unity call in shared code is a server crash or a silent divergence.
- **Test the model offline.** The model and the actions are pure C#. A test that builds a model, applies an action, and asserts the result needs no server and no client — write it first, and run it on every change.

## Authority

- **The server validates every action.** The client dispatches intent; the server decides. An action the client applies locally before the server answers is an action the player can fake.
- **Validation is explicit.** Every rule an action must satisfy is a check in the validation code, with a reason when it fails. A rule that lives only in the client's head is not a rule.
- **Configs drive numbers, code drives rules.** Balance and content values live in configs. What is legal lives in code. Do not hardcode a number the config should own, and do not put a rule in a config that code should enforce.

## Lifecycle

- **One session per player, resumed on reconnect.** A reconnect resumes the session; it does not create a second one.
- **Observe, don't poll.** Subscribe to model changes and re-render when they fire. Polling the model every frame is wasted work and a stale read waiting to happen.
- **Marshal to the main thread.** Model changes arrive off the Unity main thread. Touch Unity objects only on the main thread.
- **Keep environments separate.** Development, staging, and production have separate data and configs. A test that passes in development proves nothing about production until it runs there.
