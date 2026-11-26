// BrokenSyntax — seeded compile error for the fix-syntax eval task.
// One missing semicolon (CS1002). The reference solution adds it.
using UnityEngine;

public class BrokenSyntax : MonoBehaviour
{
    public float speed = 3f;

    void Update()
    {
        transform.Translate(Vector3.forward * speed * Time.deltaTime)
    }
}
