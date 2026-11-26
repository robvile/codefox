# Metaplay Debugging

Read the common `DEBUGGING.md` first — configuration is the usual culprit.

## The model diverges between client and server

- **Non-deterministic code in shared code.** `Random` without a seeded source, `DateTime.Now`, dictionary iteration order, floating-point operations in a different order per side. The model must produce the same result on every side, every time. Find the non-deterministic call and remove it — usually a `Random` or a time read that leaked into the model.
- **A UnityEngine call in shared code.** The server runs shared code without Unity. A `Debug.Log` is harmless; a `Random.Range`, a `Time.deltaTime`, or a `GameObject` reference is not. Shared code must compile and run on the server.
- **State kept outside the model.** A value held in a MonoBehaviour on the client is invisible to the server and unpersisted. If the server and the client disagree about a value, check whether the value lives in the model at all.

## An action is rejected (or silently does nothing)

- **Validation failed.** Read the rejection reason — the server reports why. The common causes are a missing config entry, an insufficient balance, or an action that is not legal in the current state.
- **The action was dispatched against the wrong session or environment.** Check the environment, the session, and the player id before suspecting the action.
- **The client applied the action locally first.** The client must not mutate the model. If the UI shows the result before the server answers, the UI is reading a local copy, not the model — and when the server rejects the action, the two disagree.
- **The action's shape changed.** A field added to an action on one side and not the other is a version mismatch between the shared code the client built with and the shared code the server built with. Both sides must build from the same shared code.

## The client never sees a model change

- **No listener is registered.** The client must subscribe to model changes; without a subscription nothing re-renders, and the game looks frozen even though the model is updating.
- **The listener is on the wrong thread.** Model changes arrive on the session's thread, not the Unity main thread. A listener that touches Unity objects directly will throw or silently fail — marshal the change to the main thread first.
- **The session is not the one the change belongs to.** Check the session id and the environment. Development data is not production data.

## Configs are wrong (values the game does not expect)

- **The client and the server read different configs.** Check which environment each side points at, and which config version is active in it.
- **A config value was changed without a model change.** Configs are data; the model reads them. A config that the model does not read is a config that does nothing — check the model reads the key the config sets.
- **A hardcoded number shadows the config.** Search the model for the literal value. The model must read configs, not hardcode numbers.

## Sessions and persistence

- **State is lost between sessions.** The state was never persisted — it lived in the client, not in the session. Check what the server stored for the player.
- **Two sessions for one player.** The client connected twice, or reconnected without resuming. Check the session lifecycle: one session per player, resumed on reconnect.
- **The wrong environment.** Everything works in development and nothing works in production — or the reverse. Check the environment first, every time.
