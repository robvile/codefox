# Photon Setup

## 0. The AppId (both products)

Every Photon game needs an AppId, one per product (PUN and Fusion have separate AppIds).

1. The user creates an application at https://dashboard.photonengine.com and copies its AppId. CodeFox never sees the dashboard password and never stores the AppId anywhere except the project's own Photon settings.
2. In Unity: Window → Photon Unity Networking → PUN Wizard (PUN) or the Fusion setup (Fusion → Setup). Paste the AppId into the wizard. This writes it to `PhotonServerSettings` (PUN) or the Fusion configuration — both live in the project.
3. Pick a region (`Fixed Region`) when the game has a known player base; leave it blank to let Photon pick the best region per player.

## 1. PUN setup

1. Install `PUN 2 - FREE` from the Asset Store. It creates the `Photon` folders and the `PhotonServerSettings` asset.
2. Run the PUN Wizard (Window → Photon Unity Networking → PUN Wizard) and paste the AppId.
3. Any prefab that must be networked needs a `PhotonView` component. Prefabs spawned with `PhotonNetwork.Instantiate` **must live in a Resources folder** — that is how PUN finds them at runtime.
4. Connection flow: `PhotonNetwork.ConnectUsingSettings()` → `OnConnectedToMaster` → `PhotonNetwork.JoinRandomOrCreateRoom()` → `OnJoinedRoom`. Do not call `JoinRandomOrCreateRoom` before the master connection callback fires.
5. A minimal connection UI: one button that calls `ConnectUsingSettings`, and a status label showing the callbacks as they fire. See EXAMPLES_PUN.md.

## 2. Fusion setup

1. Install `Fusion` from the Asset Store. Fusion 2 is current; check the installed version in the Package Manager.
2. Run the Fusion setup (Fusion → Setup) and paste the Fusion AppId.
3. Add a `NetworkRunner` to a GameObject in the first scene — either a scene object with the component, or created in code with `gameObject.AddComponent<NetworkRunner>()`. The runner is the session: starting it with `StartGame` begins the simulation.
4. Set the simulation mode in `StartGameArgs.GameMode`: `Host` (one player is the server), `Server` (dedicated server), `Client`, or `Shared` (Photon simulates in the cloud). Host Mode and Shared Mode have different authority rules — read the Fusion README section again before choosing.
5. Add a `NetworkSceneManagerDefault` to the same GameObject as the runner when scenes must load for all players.
6. Any prefab the runner spawns needs a `NetworkObject` component (Fusion's own). Register spawnable prefabs in the runner's configuration or spawn them by reference from a scene object.
7. A minimal connection UI: buttons for Host / Join (Shared Mode: join a named session), and a status label. See EXAMPLES_FUSION.md.

## 3. Check the project configuration

Before writing gameplay code, confirm:

- **Physics simulation mode** (Project Settings → Physics / Physics 2D): `Fixed Update` unless the project deliberately drives simulation by hand.
- **Fixed timestep** (Project Settings → Time): note the value — Fusion's tick rate is a separate setting (`Runner.Config.Simulation.TickRate`, default 60); the two clocks must be understood, not assumed equal.
- **Input System backend** (Project Settings → Player → Active Input Handler): the input code must use the backend the project has enabled.
- **Layers and the collision matrix**: the layers the gameplay relies on must be set to collide.
- **Photon region and AppId**: a wrong AppId fails at connect time with an authentication error — check the settings asset before suspecting code.
