# Netcode Setup

## 1. Install the packages

In Unity: Window → Package Manager → Unity Registry, and add `Netcode for GameObjects` (`com.unity.netcode.gameobjects`). Unity Transport comes with it. For editor testing with several players, also add `Multiplayer Play Mode` (`com.unity.multiplayer.playmode`). Do not install these programmatically — the user installs them in the Package Manager.

## 2. Add a NetworkManager

1. Create an empty GameObject in the first scene and name it `NetworkManager`.
2. Add the `NetworkManager` component.
3. Under it, confirm there is a `UnityTransport` component — Netcode adds one by default. This is the transport: direct connections, no relay, no cloud service.
4. If the game will run over the internet for players behind NAT, the transport needs Relay (Unity Gaming Services). That is a separate setup: the user enables Relay in the Unity Dashboard and the code calls `UnityTransport.SetRelayServerData`. Do not wire Relay unless the user asked for internet play.

## 3. Set the player prefab

1. Make a player prefab: a GameObject with a `NetworkObject` component and a `NetworkBehaviour` script (see EXAMPLES.md). The prefab must have a `NetworkObject` — without it, spawning fails.
2. In the `NetworkManager` inspector, set `Player Prefab` to that prefab. Netcode spawns one for each connecting client automatically.
3. Player prefabs must be in the project (not in a Resources folder — Netcode references them directly).

## 4. Scene objects

A GameObject already in the scene that must be networked needs a `NetworkObject` component too, and the scene must be loaded through Netcode's scene management (`NetworkManager.SceneManager.LoadScene`) for clients to see it. A scene object with no `NetworkObject` is local-only: every client has its own copy and they never sync.

## 5. A minimal connection UI

Give the user a way to start: three buttons calling `NetworkManager.Singleton.StartHost()`, `StartServer()`, and `StartClient()`. Add a text field for the address when the game connects to a remote host (the default is localhost). An in-game HUD that shows "Host / Client / Server" and the local client id is worth adding on day one — see step 8 of SKILL.md.

## 6. Check the project configuration

Before writing gameplay code, confirm:

- **Physics simulation mode** (Project Settings → Physics / Physics 2D): `Fixed Update` unless the project deliberately drives simulation by hand. `Script` mode silently kills triggers.
- **Fixed timestep** (Project Settings → Time): note the value — the network tick and the physics step are different clocks.
- **Input System backend** (Project Settings → Player → Active Input Handler): the input code must use the backend the project has enabled.
- **Layers and the collision matrix**: the layers the gameplay relies on must be set to collide.
- **Transport**: the default Unity Transport settings (timeouts, maximum packet size) are in the `UnityTransport` component. Leave them alone unless a symptom points at them.
