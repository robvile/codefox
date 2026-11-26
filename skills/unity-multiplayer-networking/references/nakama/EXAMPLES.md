# Nakama Examples

Minimal, self-contained examples. Match their structure before writing networked code. All Nakama calls are async — await them, and handle the failure case instead of assuming the server answered.

## Authenticate and connect the socket

```csharp
using System.Threading.Tasks;
using Nakama;
using UnityEngine;

public class NakamaConnector : MonoBehaviour
{
    private IClient client;
    private ISession session;
    private ISocket socket;

    async void Start()
    {
        // Development server: http, localhost, port 7350, default key.
        client = new Client("http", "127.0.0.1", 7350, "defaultkey");

        // Device auth is the development default. Production games
        // use email, social, or custom auth instead.
        session = await client.AuthenticateDeviceAsync(SystemInfo.deviceUniqueIdentifier);
        Debug.Log("Authenticated as " + session.UserId);

        socket = Socket.From(client);
        await socket.ConnectAsync(session, true);
        Debug.Log("Socket connected.");
    }
}
```

## Create and join a match (relayed)

One client creates the match; the others join it by id. Match state is a byte array with an op code — the game defines what each op code means. Reserve op code ranges per system (0–99 movement, 100–199 combat, and so on) so two systems never collide.

```csharp
using System.Text;
using System.Threading.Tasks;
using Nakama;
using UnityEngine;

public class NakamaMatch : MonoBehaviour
{
    private ISocket socket;
    private IMatch match;

    // Call after the socket is connected. Wire `socket` in first.
    public void UseSocket(ISocket connectedSocket)
    {
        socket = connectedSocket;
        socket.ReceivedMatchState += OnMatchState;
        socket.ReceivedMatchPresence += OnMatchPresence;
    }

    public async Task<IMatch> CreateMatch()
    {
        match = await socket.CreateMatchAsync();
        Debug.Log("Match created: " + match.Id);
        return match;
    }

    public async Task<IMatch> JoinMatch(string matchId)
    {
        match = await socket.JoinMatchAsync(matchId);
        Debug.Log("Joined match: " + match.Id);
        return match;
    }

    // Send this player's position to everyone in the match.
    public async void SendPosition(Vector3 position)
    {
        if (match == null) return;
        string json = "{\"x\":" + position.x + ",\"y\":" + position.y + ",\"z\":" + position.z + "}";
        // Op code 1 = position. The game defines the op codes.
        await socket.SendMatchStateAsync(match.Id, 1, Encoding.UTF8.GetBytes(json));
    }

    void OnMatchState(IMatchState state)
    {
        string json = Encoding.UTF8.GetString(state.State);
        Debug.Log("Match state from " + state.UserPresence.UserId + " op " + state.OpCode + ": " + json);
    }

    void OnMatchPresence(IMatchPresenceEvent presence)
    {
        foreach (var user in presence.Joins) Debug.Log("Joined: " + user.UserId);
        foreach (var user in presence.Leaves) Debug.Log("Left: " + user.UserId);
    }
}
```

## Matchmaker

The matchmaker pairs players and hands them a match to join. The query is a filter on player properties (skill, region, mode); `minCount` and `maxCount` bound the match size.

```csharp
using System.Threading.Tasks;
using Nakama;
using UnityEngine;

public class NakamaMatchmaker : MonoBehaviour
{
    private ISocket socket;

    public void UseSocket(ISocket connectedSocket)
    {
        socket = connectedSocket;
        socket.ReceivedMatchmakerMatched += OnMatched;
    }

    public async Task FindMatch()
    {
        // Any player, 2 to 4 per match. The query language is the
        // server's: properties are matched against player metadata.
        var ticket = await socket.AddMatchmakerAsync("*", 2, 4);
        Debug.Log("Matchmaking, ticket: " + ticket.Ticket);
    }

    async void OnMatched(IMatchmakerMatched matched)
    {
        Debug.Log("Matched — joining " + matched.Match.Id);
        await socket.JoinMatchAsync(matched.Match.Id);
    }
}
```

Notes: the matchmaker ticket is cancelled with `RemoveMatchmakerAsync(ticket.Ticket)` — cancel it when the player leaves the queue, or the server keeps matching them. The matched event fires on every player in the match; each one joins by the same match id.
