# Changelog

## 0.3.1 — 2026-11-24

- **One installer, always the same name.** The Windows installer is now always `dist/CodeFox-Setup.exe` — no version number in the filename, so rebuilding overwrites the previous one instead of piling up `CodeFox Setup 0.2.0.exe`, `CodeFox Setup 0.3.0.exe`, and so on. Every build script (`build`, `build:win`, `build:mac`, `build:linux`) cleans `dist/` first via `scripts/clean-dist.js`. Delete any old versioned installers in `dist/` once; new builds will never create another one.

## 0.3.0 — 2026-11-24

- **Home view.** CodeFox now opens on Home instead of jumping straight into a chat: a project banner (CSS-only pattern, "Local" badge, Edit button), Your Connections cards, a Discover Skills grid, Recent References, and a "What do you want to build?" panel with starter pills (Debug an issue / Build a tool / Write a script), a composer, the Ask/Plan/Agent dropdown, the active model name, and a status dot. The top bar has a centred title, a sidebar toggle, and new-conversation / focus / panel buttons; the LM Studio status dot lives there.
- **Multiple projects.** New `projects` table plus a `project_id` on conversations, rulesets, plans, and references (migrated on startup from the old `project_path` setting; existing rows are assigned to the migrated project). Project selector dropdown with switching, Project Settings (rename / change folder), and New Project. Deleting a project deletes its conversations and references with it; the last project cannot be deleted. New IPC: `project:list`, `project:create`, `project:switch`, `project:update`, `project:delete`. No accounts, no invites, no team plan.
- **Conversations and References.** "Threads" is now "Conversations" and "Pages" is now "References" throughout the UI. The References list shows pages and plans together, labelled "Reference" and "Plan".
- **Connections.** New Connections view with honest statuses and actions: LM Studio / Ollama (Configure opens Settings), Unity Bridge (Install really copies `unity-companion/CodeFoxBridge.cs` into `Assets/Editor/` via new `unity:installBridge` IPC), Figma / Jira (token + site URL stored locally, labelled as stored locally and used only for those imports; no import exists yet and the UI says so), GitHub ("Managed in Muse, not in CodeFox", no action). Home connection cards: Unity shows "1 Connected" when the project has an `Assets` folder (click scans), Unreal connects a folder with a `.uproject` file, Local Folders tracks added folders.
- **Skills.** Six skills on Home with real actions and persisted install state (new `skills` table): `/document-project` (creates a Game Design Document reference and drafts it from the project scan, saving the result into the reference), `/prototype-this` (plan from a starter template, opened in the editor), `/convert-to-ui-toolkit` (Agent-mode migration plan + code), `/audit-project-structure` (scan + audit prompt, report saved as a reference), `/work-with-figma` and `/work-with-jira` (require a connection; Configure opens Connections). Manage Skills lists all six with Install/Uninstall toggles.
- **Working together (planned, not in this release).** Simultaneous multi-user editing is not included. The per-project data model is the foundation; a future sync layer would need a shared project store, presence, and conflict handling for apply/revert.
- **Version.** package.json is now 0.3.0; the sidebar footer reads "CodeFox 0.3.0 — Local · No account needed".

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
