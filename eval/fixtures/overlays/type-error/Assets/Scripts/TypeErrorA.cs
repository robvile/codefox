// TypeErrorA — seeded cross-file type error for the fix-type-error
// eval task. SetHealth takes a float; this passes a string (CS1503).
using UnityEngine;

public class TypeErrorA : MonoBehaviour
{
    public TypeErrorB target;

    void Start()
    {
        target.SetHealth("100");
    }
}
