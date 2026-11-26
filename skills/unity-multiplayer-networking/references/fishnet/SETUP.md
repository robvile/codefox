# FishNet Setup

## 1. Install FishNet

Install FishNet from the Asset Store (free). It is also available from its GitHub repository. The user installs it — never install a package programmatically. After import, FishNet's own menu (FishNet → ...) offers a setup helper; the steps below are what it does.

## 2. Add a NetworkManager

1. Create an empty GameObject in the first scene and name it `NetworkManager`.
2. Add the `NetworkManager` component (FishNet's — namespace `FishNet.Managing`). It creates `ServerManager` and `ClientManager` references.
3. Confirm the transport: `TransportManager` on the same object should have `Tugboat` set as the transport. Tugboat is FishNet's default UDP transport. A different transport can be swapped in later; do not swap it during first setup.
4. Set the tick rate on the `TimeManager` (default 30 ticks per second is common; fast games often use 60). The tick is the clock server-authoritative logic runs on.

## 3. Set up the player spawner

1. Make a player prefab: a GameObject with a `NetworkObject` component and a `NetworkBehaviour` script (see EXAMPLES.md).
2. Add FishNet's `PlayerSpawner` component (in the FishNet package, under `FishNet.Component.Spawning`) to a GameObject in the scene. Set its player prefab to the prefab from step 1.
3. The spawner listens for client connections and spawns one player object per connection automatically. If the game spawns players by hand instead, hook `ServerManager.OnServerConnectionState` and spawn there — see EXAMPLES.md.

## 4. Scene objects

A GameObject already in the scene that must be networked needs a `NetworkObject` component. FishNet handles scene objects through its scene manager: a networked scene object must be present in the scene on every side when the scene loads. A scene object with no `NetworkObject` is local-only.

## 5. A minimal connection UI

Give the user a way to start: buttons calling `NetworkManager.Singleton.ServerManager.StartConnection()` (server) and `ClientManager.StartConnection()` (client), plus a status label fed by `ServerManager.OnServerConnectionState` and `ClientManager.OnClientConnectionState`. A host is a server plus a client started together — FishNet has no single "StartHost" call; start the server, then start the client on the same instance.

## 6. Check the project configuration

Before writing gameplay code, confirm:

- **Physics simulation mode** (Project Settings → Physics / Physics 2D): `Fixed Update` unless the project deliberately drives simulation by hand.
- **Fixed timestep** (Project Settings → Time): note the value — the FishNet tick and the physics step are different clocks.
- **Input System backend** (Project Settings → Player → Active Input Handler): the input code must use the backend the project has enabled.
- **Layers and the collision matrix**: the layers the gameplay relies on must be set to collide.
- **Transport**: Tugboat's settings (port, maximum clients, MTU) live on the transport component. Leave them alone unless a symptom points at them.
