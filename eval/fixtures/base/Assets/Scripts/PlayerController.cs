// PlayerController — the fixture's player script (v0.18.0 eval fixture).
//
// Deliberately incomplete: it moves with WASD through the new Input
// System, but there is NO jump yet — the player-jump eval task is
// to add one. jumpForce exists so the model can use it.
using UnityEngine;
using UnityEngine.InputSystem;

public class PlayerController : MonoBehaviour
{
    public float moveSpeed = 5f;
    public float jumpForce = 8f;
    private Rigidbody rb;

    void Start()
    {
        rb = GetComponent<Rigidbody>();
    }

    void Update()
    {
        var kb = Keyboard.current;
        if (kb == null) return;
        float x = 0f, z = 0f;
        if (kb.aKey.isPressed) x -= 1f;
        if (kb.dKey.isPressed) x += 1f;
        if (kb.wKey.isPressed) z += 1f;
        if (kb.sKey.isPressed) z -= 1f;
        Vector3 move = new Vector3(x, 0f, z).normalized * moveSpeed * Time.deltaTime;
        transform.Translate(move, Space.World);
    }
}
