---
name: unity-multiplayer-networking
description: Use when adding multiplayer to a Unity project or working on networked gameplay — picking a networking stack, syncing players and state across host and clients, or debugging a multiplayer problem. Covers Unity Netcode for GameObjects, Photon PUN and Fusion, FishNet, Nakama, and Metaplay.
---

# Unity Multiplayer Networking

Add multiplayer to a Unity project, or fix multiplayer that is already there. This skill is a procedure, not a solver: it tells you which stack is in the project, makes you confirm it with the user, points you at the right setup and examples for that stack, and makes you check the project configuration before you trust the code. Networking APIs change between versions, and a model writing them from memory gets them wrong — so the examples in `references/` are the ground truth, and the official docs for the installed version are the final word.

## File index

| File | Contents |
| ---- | -------- |
| `SKILL.md` | This file: the flow, the stack index, and the rules. |
| `DEBUGGING.md` | Stack-agnostic debugging: how to tell a networking bug from a configuration bug. |
| `BEST_PRACTICES.md` | Stack-agnostic multiplayer best practices. |
| `references/netcode/README.md` | What Netcode for GameObjects is, when to use it, file table. |
| `references/netcode/SETUP.md` | Netcode setup: packages, NetworkManager, transport, player prefab. |
| `references/netcode/EXAMPLES.md` | Minimal, self-contained Netcode examples. |
| `references/netcode/DEBUGGING.md` | Netcode-specific common problems and fixes. |
| `references/netcode/BEST_PRACTICES.md` | Netcode-specific best practices. |
| `references/photon/README.md` | What Photon is (PUN and Fusion), when to use each, file table. |
| `references/photon/SETUP.md` | Photon setup: AppId, server settings, runner. |
| `references/photon/EXAMPLES_PUN.md` | Minimal, self-contained PUN examples. |
| `references/photon/EXAMPLES_FUSION.md` | Minimal, self-contained Fusion examples. |
| `references/photon/DEBUGGING.md` | Photon-specific common problems and fixes. |
| `references/photon/BEST_PRACTICES.md` | Photon-specific best practices. |
| `references/fishnet/README.md` | What FishNet is, when to use it, file table. |
| `references/fishnet/SETUP.md` | FishNet setup: NetworkManager, Tugboat, player spawner. |
| `references/fishnet/EXAMPLES.md` | Minimal, self-contained FishNet examples. |
| `references/fishnet/DEBUGGING.md` | FishNet-specific common problems and fixes. |
| `references/fishnet/BEST_PRACTICES.md` | FishNet-specific best practices. |
| `references/nakama/README.md` | What Nakama is, when to use it, file table. |
| `references/nakama/SETUP.md` | Nakama setup: run the server, install the SDK, client and socket, authenticate. |
| `references/nakama/EXAMPLES.md` | Minimal, self-contained Nakama client examples. |
| `references/nakama/DEBUGGING.md` | Nakama-specific common problems and fixes. |
| `references/nakama/BEST_PRACTICES.md` | Nakama-specific best practices. |
| `references/metaplay/README.md` | What Metaplay is, its persistent model/action architecture, file table. |
| `references/metaplay/SETUP.md` | Metaplay setup: project shape, environments, session lifecycle. |
| `references/metaplay/EXAMPLES.md` | Metaplay patterns: client, shared code, server-authoritative actions. |
| `references/metaplay/DEBUGGING.md` | Metaplay-specific session, model, action, and config diagnostics. |
| `references/metaplay/BEST_PRACTICES.md` | Metaplay-specific determinism, authority, and lifecycle guidance. |

## Stack index

| Stack | Folder | Notes |
| ----- | ------ | ----- |
| Unity Netcode for GameObjects (NGO) | `references/netcode/` | First-party, server-authoritative. The default when nothing else is chosen. |
| Photon (PUN + Fusion) | `references/photon/` | Hosted cloud relay. PUN is simple and in maintenance; Fusion is the high-performance successor. |
| FishNet | `references/fishnet/` | Free, open-source, prediction-first. |
| Nakama (Heroic Labs) | `references/nakama/` | Open-source game server and backend: relayed and server-authoritative matches, matchmaker, social. Needs a running server. |
| Metaplay | `references/metaplay/` | Persistent player-state backend: deterministic shared models and actions, server-validated, driven by game configs. |

Load the relevant `references/<stack>/` files before writing stack-specific code. Do not guess the API surface from memory.

## Flow

1. **Frame the goal.** Restate what the game should do in plain terms — for example, "two players move cubes around and see each other move". Then explore the project first: read the project scan, grep for existing network code, list the packages. Never assume a stack is installed.
2. **Detect the installed stack.** Check the package manifest and lock file, search for existing networked prefabs, scripts, and config (NetworkManager, PhotonView, FishNet NetworkManager, Nakama client, Metaplay client). If a stack is already present, tell the user exactly what you found and ask whether to build on it. Then STOP and wait. Never silently adopt a stack, and never guess one.
3. **If no stack is installed (or the user wants alternatives), choose one together.**
   - Ask the user's goals: player count, authority model (server-authoritative or relay/peer-to-peer), hosting (self-hosted or hosted cloud), target platforms, budget, realtime or turn-based. Do not proceed without this.
   - Research the current options and cross-check them against the stack index above.
   - Suggest 2–4 candidates with concrete trade-offs for the user's stated goals, and let the user pick. Then STOP and wait.
   - Tell the user how to install the chosen stack: a Unity Package Manager package (registry or Git URL), an Asset Store asset, or an official SDK download from the vendor's site. Give the exact path for that stack. Installing is a manual user step — never install a package programmatically. Then STOP.
   - Metaplay is the exception: its integration creates a client and backend project shape through the vendor's official onboarding flow. Treat that as a manual user step; do not infer a package-only route or automate it. Then stop.
4. **Read the stack references.** Load `references/<stack>/README.md` and `SETUP.md`. Follow the setup steps for the GameObjects, components, configs, and assets the stack needs.
5. **Build the setup AND verify the project configuration matches the approach.** Use the file tools for C# scripts and ```unity-command blocks for scene, prefab, and component work. Mirror the stack's SETUP.md and confirm the scene essentials (light, camera, material) so players are visible. Then verify — both before and after writing code — that the project's configuration actually supports the code: physics simulation mode and auto-sync transforms, fixed timestep, Input System backend, render pipeline, layers and the collision matrix, transport settings, and any other project setting the approach depends on. Code that assumes defaults the project does not have fails silently — triggers never fire when the physics simulation mode is Script, for example. Reconcile every mismatch — fix the config or adapt the code — before moving on.
6. **Apply best practices.** Load `BEST_PRACTICES.md` (common) and `references/<stack>/BEST_PRACTICES.md`.
7. **Check the examples as ground truth before coding.** Treat `references/<stack>/EXAMPLES*.md` as the authoritative form of the stack's API and patterns. Read them and match their structure before writing any networked code. They are required pre-coding reference, not samples to show the user.
8. **Make it testable in the Editor.** Wire an in-game HUD (or the stack's equivalent) for host, client, and server. Recommend Unity's Multiplayer Play Mode (Netcode), ParrelSync (FishNet), or a second build or instance. For Metaplay, test deterministic model and action logic offline first, then test sessions and persistence against a local or hosted server with distinct player accounts.
9. **Debug — docs FIRST, then fix.** The moment the user reports a bug or asks for a fix, BEFORE writing or changing any code you must (a) read `DEBUGGING.md` (common) and `references/<stack>/DEBUGGING.md` for the symptom, (b) re-check the relevant `SETUP.md`, `README.md`, and `EXAMPLES*.md` sections for the feature, and (c) check the latest official docs (linked in each README) for the installed package version. Only after that may you form a hypothesis and edit. When a networking-shaped symptom appears ("bullets pass through", "won't move", "trigger never fires", "works on host not client"), run the project-configuration check (step 5) as the FIRST hypothesis, not the last — these are usually physics or configuration bugs wearing a networking costume. Never freelance a fix from memory before reading the debugging docs.
10. **The user is a pro — never create docs.** Do not generate guides, READMEs, tutorials, or summary pages. The user writes their own documentation.

## Rules

- Any multiplayer or networking request routes through this skill — follow its flow, never freelance.
- **Debugging is docs-first, always.** When the user asks to fix an issue or reports a bug, load and read the relevant `DEBUGGING.md` files AND re-consult the skill's docs (`SETUP.md`, `README.md`, `EXAMPLES*.md`) for the affected feature BEFORE attempting any fix. Do not write or change code from memory until you have read them.
- **Always verify against the latest official docs.** Before generating or fixing stack-specific code, confirm the current API for the installed package version against the official docs (linked in each stack's README). Networking APIs change between versions; never rely on memory alone. CodeFox cannot browse the web — check the installed package version in the manifest, and ask the user to confirm the docs when the version is unclear.
- Always reconcile config with code — different networking approaches need different project setup, and a mismatch fails silently.
- This skill gives directions and instructions — it is not a solver. Always route to the right reference file.
- Never guess the networking stack — detect it and confirm with the user, or ask the user their goals, research options, and let them pick. Then stop.
- Never attempt to install packages or import assets programmatically — instruct the user (Package Manager, Asset Store, or official download) and stop.
- Use the file tools for C# scripts and ```unity-command blocks for scene, prefab, and component edits.
- Follow the project's existing folder structure and code style for new scripts.
- Mark every project-changing action as approval-required.
- Recompile and read the console after edits to catch errors before finishing.
- Treat the stack's `EXAMPLES*.md` as required pre-coding knowledge, and always check the latest official docs (linked in each README).
- The user is a pro — never create docs, guides, or summary pages; the user writes their own.
