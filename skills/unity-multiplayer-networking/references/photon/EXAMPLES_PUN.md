# Photon PUN Examples

Minimal, self-contained PUN examples. Match their structure before writing networked code. PUN's API is string-based in places (RPC names, prefab names) — a typo compiles fine and fails at runtime, so copy names exactly.

## Connect and join a room

`MonoBehaviourPunCallbacks` is the callback base class. Do not call `JoinRandomOrCreateRoom` until `OnConnectedToMaster` fires.

```csharp
using UnityEngine;
using Photon.Pun;
using Photon.Realtime;

public class PunConnector : MonoBehaviourPunCallbacks
{
    void Start()
    {
        // Reads the AppId from PhotonServerSettings.
        PhotonNetwork.ConnectUsingSettings();
    }

    public override void OnConnectedToMaster()
    {
        Debug.Log("Connected to master, joining a room...");
        PhotonNetwork.JoinRandomOrCreateRoom();
    }

    public override void OnJoinedRoom()
    {
        Debug.Log("Joined room: " + PhotonNetwork.CurrentRoom.Name
            + " (" + PhotonNetwork.CurrentRoom.PlayerCount + " players)");
        // Spawn the local player. The prefab must be in a Resources folder.
        PhotonNetwork.Instantiate("Player", Vector3.zero, Quaternion.identity);
    }

    public override void OnJoinRandomFailed(short returnCode, string message)
    {
        Debug.Log("Join failed: " + message + " — creating a room instead.");
        PhotonNetwork.CreateRoom(null, new RoomOptions { MaxPlayers = 4 });
    }

    public override void OnPlayerEnteredRoom(Player newPlayer)
    {
        Debug.Log("Player joined: " + newPlayer.NickName);
    }
}
```

## A remote procedure call (RPC)

`PhotonView` marks the object as networked. `IsMine` is true only on the client that owns it — every other client has a remote copy. RPC method names are strings: the method must be marked `[PunRPC]` and the name must match exactly.

```csharp
using UnityEngine;
using Photon.Pun;

public class PunShooter : MonoBehaviourPun
{
    void Update()
    {
        // Only the owning client reads its own input and fires.
        if (!photonView.IsMine) return;
        if (Input.GetKeyDown(KeyCode.Space))
        {
            photonView.RPC(nameof(Fire), RpcTarget.All);
        }
    }

    [PunRPC]
    void Fire()
    {
        // Runs on every client, including the sender.
        Debug.Log("Shot fired by " + photonView.Owner.NickName);
    }
}
```

## A synced value (the PUN way)

PUN has no NetworkVariable. The usual shapes are: (a) an RPC that tells everyone the new value when it changes; (b) `PhotonView` observed fields via `IPunObservable.OnPhotonSerializeView`, which PUN calls on a timer for the owner to write and everyone else to read.

```csharp
using UnityEngine;
using Photon.Pun;

public class PunHealth : MonoBehaviourPun, IPunObservable
{
    private int health = 100;

    public void TakeDamage(int amount)
    {
        // Only the owner applies damage locally; the sync below
        // replicates it. For real games, validate on the master
        // client instead — any client can call this as written.
        if (!photonView.IsMine) return;
        health -= amount;
    }

    public void OnPhotonSerializeView(PhotonStream stream, PhotonMessageInfo info)
    {
        if (stream.IsWriting)
        {
            stream.SendNext(health);
        }
        else
        {
            health = (int)stream.ReceiveNext();
        }
    }
}
```

Notes: `OnPhotonSerializeView` only runs for objects with a PhotonView whose `Observed Components` list includes this script (set it in the inspector). The master client (`PhotonNetwork.IsMasterClient`) is the closest thing PUN has to a server — put validation there when the game has no dedicated server.
