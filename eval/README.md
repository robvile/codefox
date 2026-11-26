# Eval harness (v0.18.0)

CodeFox grades itself. The harness runs the real agent loop against
a tiny fixture Unity project and grades the result with
programmatic checks — never with another model judging.

## Running it

```powershell
npm run eval        # canary subset: 10 tasks, ~15-30 min on a real machine
npm run eval:full   # all 12 tasks
npm run eval:mock   # canned replies, no Unity, no LM Studio — proves the pipeline, not the model
```

Options (via the runner directly):

```powershell
node scripts/eval-runner.js --suite full --runs 3
node scripts/eval-runner.js --task fix-syntax --mock
node scripts/eval-runner.js --suite canary --no-sanity   # skip baseline + reference runs (quicker, weaker)
node scripts/eval-runner.js --suite canary --timeout 90  # minutes before the runner gives up
```

A **live** run needs Unity open on the fixture project (the runner
creates it under `eval-work/<run-id>/project/` and the bridge
installs itself on connect, as usual) and the LM Studio model
loaded. A **mock** run needs neither: it feeds the model the task's
canned replies, so it proves the harness pipeline end to end —
fixture reset, thread, loop, grading, aggregation, results file —
but its task passes prove nothing about the model. Mock results
say so in the file and in the summary.

## What a run does, per task, per repetition

1. **Reset the fixture** — the project folder is wiped (except
   Library/Temp/Logs, which Unity regenerates) and re-seeded from
   `eval/fixtures/base/` plus the task's overlay.
2. **Baseline grade** — the checks run against the untouched
   fixture. They must FAIL there (unless the task sets
   `baselineMustFail: false`, like the read-only task). A baseline
   that already passes means the grader is broken, and the task
   fails loudly instead of passing for free.
3. **Run the model** — a fresh thread, the task's prompt sent
   through the real `sendChat` → agent loop, with the scripted
   approval policy (`auto` approves every bar; `deny` declines
   every bar, for the denied-approval task).
4. **Grade** — the world the model left behind is read back
   (bridge reads, file contents, file hashes) and the checks are
   evaluated. Pass = every check passes or is skipped, and at
   least one check actually passed. All-skipped proves nothing.
5. **Reference run** — reset again, apply the task's reference
   solution (files + bridge commands), grade. A reference that
   does not pass means the grader or the reference is broken —
   recorded, never silently ignored. `reference: null` skips it.

Results land in `eval/results/<run-id>/results.json` with a JSONL
transcript per run (`<task>-run<n>.jsonl`) and a `progress.json`
while the run is going. The runner keeps the latest run per suite
as `eval/results/latest-<suite>.json` and compares against it.

## Reading the results

- **Pass rate per task** with a Wilson 95% interval — a 5-point
  change on a small suite is noise, and the interval says so.
- **Consistent** — all repetitions agreed. An inconsistent task
  is flaky, not passing.
- **Flips vs the previous run** — regressions matter more than the
  headline rate; the runner lists them explicitly.
- **By tag** — slices like `scene`, `fix`, `playtest`.
- **Result key** — model profile (model + loaded context length),
  app version, ruleset hash, skill hash, prompt hash. A changed
  quant is a different model; a changed prompt is a different
  harness. Two runs only compare when the key matches.

## The tasks

| Task | Canary | What it grades |
| --- | --- | --- |
| add-rigidbody | yes | Add a Rigidbody, set mass 2.5 |
| create-object | yes | Create a Cube under Level with a Rigidbody |
| fix-syntax | yes | Fix a seeded missing semicolon (CS1002) |
| fix-type-error | yes | Fix a string passed where a float is expected (CS1503) |
| rotating-object | yes | Write a Rotator script, attach it, verify rotation in a timed run |
| player-jump | yes | Add a Space jump (new Input System), verified by the probe |
| fix-nullref | yes | Fix a seeded NullReferenceException, console clean 5s |
| reparent-edit | yes | Move Enemy1 to Level, then edit it by its new path |
| delete-one | yes | Delete exactly Enemy2, nothing else |
| read-only | yes | Answer a question without changing anything |
| find-edit-500 | no | Find Enemy_042 in a 500-object scene, set health 7 |
| denied-approval | no | Model asks to delete, user denies, nothing changes |

## Check types

- `state` — a serialized value on a scene object, read through
  `read_component_values` (`path`, `component`, `property`,
  `equals` / `gt` / `lt` / `gte` / `lte`, `exists`, `changed`).
- `compiles` — the project compiles (Unity's own compiler via
  `recompile_and_report_errors`).
- `console_clean` — a timed Play Mode run with zero errors
  (`seconds`).
- `probe` — `[EVAL] key=value` lines from a scripted Play Mode
  run (`expect`, `seconds`, `inject` steps). The fixture's
  `EvalProbe` component logs a 1s heartbeat (`playerY`,
  `playerRotY`) plus `jumped=true` / `rotated=true` when it
  observes them.
- `file` — a file's contents (`contains`, `regex`, `absent`).
- `no_collateral` — nothing changed outside the `allowlist`, and
  nothing in `protect` changed. The probe script
  (`Assets/EvalProbe.cs`) is always protected: the model must
  never touch it, so it cannot fake a passing probe.
- `nothing_changed` — no file changed at all.
- `approval_denied` — the model attempted the named action, an
  approval was declined, and nothing changed.

## The fixture

`eval/fixtures/base/` is a minimal Unity 6.3 project: a Player
(WASD via the new Input System, `moveSpeed` / `jumpForce`, no
jump yet), a Floor, `Level > Enemies > Enemy1/2/3` (health 100),
and the harness-owned `EvalProbe`. The scenes are hand-written
Unity YAML with fixed fileIDs and script GUIDs. Overlays in
`eval/fixtures/overlays/` seed a specific failure on top of the
base:

- `broken-syntax/` — a script missing a semicolon.
- `type-error/` — a string passed to a float parameter.
- `nullref/` — a script that dereferences an unassigned
  `target` in `Start`, plus a `gen-scene.js` that adds it to
  the scene.
- `large-scene/` — a `gen-scene.js` that writes a full scene
  with 500 enemies (`Enemy_000` … `Enemy_499`).

## Adding a task

1. Add `eval/tasks/<id>.yaml` — see an existing task for the
   shape. Give it `checks`, a `reference` (files and/or bridge
   commands — the reference must pass its own checks), and
   `mockReplies` (canned assistant replies, ending in a plain
   summary with no actions).
2. Add it to the table above.
3. Run it in mock mode first (`--task <id> --mock`), then live.
4. Set `canary: true` only if it belongs in the every-change
   subset: fast, stable, and covering a core behaviour.

## Flakiness

- Temperature is pinned by the app default (0.2); every task
  runs k times (1–5) and reports consistency.
- The probe fixes the timestep and seeds `Random`, so a run is
  frame-count based, not wall-clock based.
- Every run starts from a hard fixture reset.
- Grading waits for a quiet heartbeat before reading state.
- The result key records the model profile, app version,
  ruleset, skill, and prompt hashes, so config drift shows up
  as a different key instead of a mysterious pass-rate change.

## What the harness does not do

- It does not judge with a model. Ever.
- It does not test ComfyUI image generation (slow,
  non-repeatable) or web search. The core tasks use neither.
- It does not run on this machine's CI — there is no Unity
  here. Mock mode runs anywhere; live runs need a machine
  with Unity and LM Studio.
