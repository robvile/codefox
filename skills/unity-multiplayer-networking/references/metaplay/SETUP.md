# Metaplay Setup

## 1. Onboarding (manual — the user does this)

Metaplay integration starts with the vendor's official onboarding flow, not with a package install. The user follows it, and it creates:

- A **backend project** (the server side: model validation, configs, environments, player data).
- A **shared-code project** (C# classes shared between client and server: the game model, the actions, the configs).
- A **Unity client project** (or the existing game, wired to the above).

Do not infer a package-only route, and do not automate the onboarding. If the user has not done it, stop and tell them to — there is nothing to build against until the projects exist.

## 2. Project shape

After onboarding, the code is split three ways. Keep it that way:

- **Shared code**: the model (state), the actions (validated intents), and the configs (tunable values). This is the only code both sides run. It must be deterministic — see BEST_PRACTICES.md.
- **Client**: the Unity game. It renders the model, collects player input, dispatches actions, and observes model changes. It never changes the model directly.
- **Backend**: the server. It validates actions, applies them to the model, owns the configs, and persists player state.

A class in the wrong project is a bug: game rules in the client are rules the player can ignore; rendering in shared code is rendering the server cannot run.

## 3. Environments

Development, staging, and production are separate environments with separate data and separate configs. The client points at one environment at a time — check which one before testing anything. A feature that "works" in development and not in production is usually a config or data difference between environments, not code.

## 4. Session lifecycle

1. The client connects and authenticates a player account.
2. The client joins (or creates) a session. The session carries the player's persistent state.
3. The client observes the shared model and renders it.
4. The player acts: the client dispatches an action; the server validates it against the model and the configs; the result is applied and broadcast.
5. The client disconnects: the session and the state persist on the server. Reconnecting resumes where the player left off.

## 5. A minimal connection UI

Give the user a way to start: a button that connects and authenticates, a label showing the environment, the session state, and the player id, and a log line for every action dispatched and every model change observed. When something goes wrong, the first question is always "which environment, which session, which action".

## 6. Check the project configuration

Before writing gameplay code, confirm:

- **Which environment the client points at.** Development data is not production data.
- **The shared-code project builds on both sides.** A model class that compiles in Unity but not on the server (or vice versa) is a shared-code violation — usually a Unity-only API leaking into shared code.
- **Input System backend** (Project Settings → Player → Active Input Handler): the input code must use the backend the project has enabled.
- **Physics simulation mode** (Project Settings → Physics / Physics 2D): `Fixed Update` unless the project deliberately drives simulation by hand.
