# Changelog

## 0.2.0 — 2026-11-24

- **LM Studio is now the default backend.** OpenAI-compatible local API (`/v1/models`, `/v1/chat/completions` with SSE streaming). Ollama keeps working as the alternative backend for existing users.
- **New Settings menu.** Pick the provider (LM Studio / Ollama), verify the LM Studio connection with a real status line, and select a model from the live list returned by the server instead of typing a name. Also: optional API key, temperature, max tokens, and the Unity Editor exe path used by Run tests. Settings save without losing the current thread (no reload).
- **Ask / Plan / Agent modes.** Ask answers only, Plan drafts steps and file lists without writing code, Agent works step by step and outputs complete code, one file per fenced block.
- **Project scan.** Scans the Unity project (version from `ProjectVersion.txt`, packages from `Packages/manifest.json`, scenes and prefabs with GameObject names, script list) and includes a truncated summary in every prompt.
- **Tools row.** Scan project, Diagnose error, Generate tests, Animator, UI, Run tests, Build check.
- **Test loop.** Generate NUnit EditMode tests, run them in Unity batch mode (10-minute timeout, XML results parsed for pass/fail/skip), and a `dotnet build` check. Both report honestly when they cannot run — they never fake a pass.
- **Error diagnosis** from a pasted Unity console error or log.
- **Animator and UI generation** prompts, plus a Unity bridge that executes `createAnimatorController` and `createUICanvas` commands from `Assets/.codefox-command.json` and reports back in `Assets/.codefox-result.json`.
- **Diff preview.** A Review diff button in the apply bar shows a line-based diff (added / removed / unchanged) per file before applying.
- **Safer apply/revert.** `fs:writeFile` creates parent directories; new files are recorded in the snapshot with a sentinel so revert deletes them (and their `.meta`); `fs:moveFile` moves a file together with its `.meta` sibling, preserving Unity GUIDs.
- **New IPC surface.** `llm:status`, `llm:listModels`, `llm:verify` (connection + model list, plus a tiny chat probe only when a model is selected), unified `llm:chat` (legacy `ollama:stream-chunk` / `ollama:stream-done` events still emitted), `project:scan`, `unity:runTests`, `unity:buildCheck`, `fs:pickExe`.
- README rewritten for LM Studio first, with honest model-size / VRAM guidance and a "What local models can't do as well as cloud models" section.

## 1.0.0 — 2026-05-31

- Initial public release (v1.0.1): local AI coding assistant on Ollama + Electron + SQLite, with chat, rulesets, plans, pages, file tree, apply/revert with snapshots, and Unity integration.
