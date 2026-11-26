// NullRef — seeded NullReferenceException for the fix-nullref eval
// task. target is never assigned, so Start() throws the moment the
// game enters Play Mode. The fix is a null check (or assigning it).
using UnityEngine;

public class NullRef : MonoBehaviour
{
    public Transform target;

    void Start()
    {
        Debug.Log("Target is at " + target.position);
    }
}
