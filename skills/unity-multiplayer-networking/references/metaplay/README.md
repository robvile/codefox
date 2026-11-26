# Metaplay

Persistent player-state backend for Unity games. Metaplay is not a match library — it is a backend that owns the game's persistent state: players, their progress, their inventories, and the shared game world they act in. Use it when the game needs state that survives sessions — a live-ops game, a persistent world, a game with progression, configs, and events — rather than a single match that ends and is forgotten.

## What it is

- A **shared game model**: the full game state lives in C# model classes shared between the client and the server. Every client simulates the same model, deterministically.
- **Actions**: players do not change the model directly. They dispatch actions (intent: "buy this", "move here", "start this quest"), the server validates each action against the model, and the validated result is applied — deterministically, on every side.
- **Game configs**: balance and content values live in configs the server owns and can update without a client release. The model reads configs; it does not hardcode numbers.
- **Sessions and persistence**: a player has a persistent session and account. State survives the player closing the game, and the server is the source of truth for what they own.
- **Environments**: development, staging, and production are separate environments with separate data. A client points at one environment at a time.

## A note on API names

Metaplay's SDK is versioned and its exact type names change between releases. This skill describes the architecture and the shapes — model, action, config, session, listener — and the EXAMPLES.md file shows those shapes as patterns, clearly marked where a name must be checked against the SDK version in the project. Do not copy an SDK call from memory: check it against the official docs for the installed SDK version first. The README links below are the source of truth.

## Packages

- Metaplay SDK — installed through Metaplay's official onboarding flow, which creates the client project and the backend project shape together. There is no package-only route to infer: the user follows the onboarding, and the project ends up with a shared-code project (model, actions, configs) plus the Unity client.

## Docs

- Official docs: https://docs.metaplay.io/
- Metaplay site: https://metaplay.io/

Always check the API against the installed SDK version. The onboarding flow is the source of truth for project shape.

## Files

| File | Contents |
| ---- | -------- |
| `README.md` | This file. |
| `SETUP.md` | Project shape, environments, session lifecycle. |
| `EXAMPLES.md` | Patterns: client, shared code, server-authoritative actions. Schematic — verify names against the SDK. |
| `DEBUGGING.md` | Metaplay-specific session, model, action, and config diagnostics. |
| `BEST_PRACTICES.md` | Metaplay-specific determinism, authority, and lifecycle guidance. |
