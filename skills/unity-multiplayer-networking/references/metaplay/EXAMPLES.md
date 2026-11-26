# Metaplay Examples

These are patterns, not copy-paste code. The shapes below — a model, an action, a config read, a client observing the model and dispatching an action — are how Metaplay works. The exact SDK type and method names depend on the SDK version in the project: check them against the official docs for that version before writing them into the game, and treat anything here that does not match the installed SDK as wrong. The architecture is the ground truth; the names are not.

## The shared model

The model is the whole game state, in classes shared between client and server. It holds data only — no Unity APIs, no rendering, no input, no randomness, no wall-clock time. Anything the model does must produce the same result on every side, every time.

```csharp
// Shared code. Shape only — adapt the base types and attributes
// to the SDK version in the project.

// The persistent state of one player, or of the shared world.
public class PlayerState
{
    public int Coins;
    public int Level;
    public List<string> OwnedItems;
}

// A read of a config value, not a hardcoded number: the server
// owns the value and can change it without a client release.
public static class GameBalance
{
    public static int CoinsPerQuest(GameConfig config) => config.CoinsPerQuest;
}
```

Rules the model must follow:

- Deterministic: no `Random` without a seeded source, no `DateTime.Now`, no dictionary iteration order, no floating-point operations whose order differs per side.
- No UnityEngine calls. The server runs this code without Unity.
- Every field that matters is in the model. State kept in a MonoBehaviour on the client is state the server cannot see and cannot persist.

## An action (server-authoritative)

An action is the only way a player changes the model. The client dispatches the intent; the server validates it against the model and the configs; the validated result is applied deterministically on every side.

```csharp
// Shared code. Shape only — adapt to the SDK version in the project.

// Intent: "I want to buy this item."
public class BuyItemAction
{
    public string ItemId;
}

// Validation, run on the server: is the item real, does the player
// have the coins, is the purchase legal right now? An action that
// fails validation changes nothing and reports why.
public static class BuyItemValidation
{
    public static bool CanBuy(PlayerState player, GameConfig config, string itemId, out string reason)
    {
        reason = null;
        if (!config.Items.ContainsKey(itemId)) { reason = "No such item."; return false; }
        if (player.Coins < config.Items[itemId].Price) { reason = "Not enough coins."; return false; }
        return true;
    }

    public static void Apply(PlayerState player, GameConfig config, string itemId)
    {
        player.Coins -= config.Items[itemId].Price;
        player.OwnedItems.Add(itemId);
    }
}
```

## The client: observe and dispatch

The client never writes the model. It renders what the model holds, collects input, dispatches actions, and reacts to model changes.

```csharp
// Client code (Unity side). Shape only — adapt the client,
// session, and listener APIs to the SDK version in the project.

public class GameClient : MonoBehaviour
{
    // After connecting and joining a session (see SETUP.md):
    //   - subscribe to model changes, and re-render when they fire;
    //   - on player input, dispatch an action — never mutate the
    //     model directly.

    void OnModelChanged()
    {
        // Read the model and update the UI. This is the only place
        // the UI learns about state: from the model, never from a
        // local copy the client maintains itself.
    }

    public void OnBuyButton(string itemId)
    {
        // Dispatch the action. The server validates it; the model
        // change comes back through OnModelChanged when it applies.
        // Do not apply it locally first — the client does not know
        // yet whether the server accepted it.
    }
}
```

## Testing the model offline

The model and the actions are pure C# — no server, no client, no Unity needed to test them. Write a test that builds a model, applies an action, and asserts the result. Test the validation paths too: an action that must fail is as important as one that must succeed. Only after the model is right offline does the session test against a server mean anything.
