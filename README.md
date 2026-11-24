# CodeFox

A free, local AI coding assistant that runs entirely on your machine. No cloud. No credits. No data leaving your computer.

Built on Electron + SQLite, with [LM Studio](https://lmstudio.ai) as the default local model backend and [Ollama](https://ollama.com) as an alternative backend.

![CodeFox](https://img.shields.io/badge/version-0.3.2-blue) ![License](https://img.shields.io/badge/license-MIT-green)

---

![CodeFox Screenshot](assets/screenshot.png)

---

## What it does

- **Home** — the default view when CodeFox opens: a banner for the active project, connection cards (Unity / local folders), a Discover Skills grid, recent references, and a "What do you want to build?" panel that starts a new conversation
- **Multiple projects** — keep several local projects in CodeFox, each with its own conversations, rulesets, plans, and references. Switch from the project selector at the top of the sidebar, or create a new one with **New Project**. No accounts, no teams, no sync — everything stays on this machine
- **Chat** with a local LLM about your codebase across persistent conversations
- **Ask / Plan / Agent modes** — Ask answers and explains only, Plan drafts steps and file lists without writing code, Agent works step by step and outputs complete code in fenced blocks with file paths
- **Project scan** — reads your Unity project (version, packages, scenes, prefabs, scripts) and includes a summary in every prompt, so the model knows what actually exists instead of guessing
- **Rulesets** — define project rules, architecture contracts, naming conventions. Auto-injected into every prompt.
- **Plans** — describe what you want done. The AI proposes steps and lists files before touching anything. You approve, then execute.
- **References** — pages and plans in one list: AI-authored architecture docs (pages) and step-by-step plans, kept per project so they grow into a living knowledge base
- **Skills** — one-click actions from Home: draft a Game Design Document, plan a feature prototype, migrate UGUI to UI Toolkit, or audit the project structure. Figma and Jira skills need a connection first (see Connections) and say so honestly instead of faking it
- **Connections** — a single view for LM Studio, Ollama, the Unity bridge, Figma, Jira, and GitHub, each with a real status and an action that either does the thing or says what is still needed. The Unity bridge really installs `CodeFoxBridge.cs` into `Assets/Editor/`; Figma/Jira tokens are stored locally and used only for those imports
- **File tree** — browse your project, view files, add them to chat with one click. Search across all files instantly.
- **Apply changes** — LLM responses containing code blocks get a one-click "Apply changes" button that writes files to disk. A **Review diff** button shows a line-by-line diff before you apply.
- **Snapshots + Revert** — before writing anything, CodeFox backs up every file it touches, and records new files so revert can delete them. One click to revert if something breaks.
- **Test loop** — generate EditMode tests for a script, run them in Unity batch mode, and paste the failures back to the model to fix, one at a time. A `dotnet build` check is available too.
- **Error diagnosis** — paste a Unity console error or log and get a plain-language explanation, the likely file and line, and the smallest fix to try first.
- **Animator + UI generation** — ask the model to generate Editor scripts that build an Animator Controller or a UI Canvas in Unity.
- **Asset moves that preserve GUIDs** — moving a file through CodeFox moves its `.meta` file with it.
- **Unity integration** — includes an Editor companion script that auto-refreshes Unity's AssetDatabase when files change, and can execute commands (refresh, create an Animator Controller, create a UI Canvas) written to `Assets/.codefox-command.json`.

---

## Requirements

- [Node.js](https://nodejs.org) 18+
- A local model backend — **LM Studio** (default) or Ollama (alternative)
- A coding model loaded in that backend (see "Choosing a model" below)
- Unity, if you want the Unity features (project scan, tests, bridge)

---

## Setup

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/codefox.git
cd codefox

# 2. Install dependencies
npm install

# 3. Run
npm start
```

### 1. Start LM Studio

1. Install [LM Studio](https://lmstudio.ai) and download a coding model (see below).
2. Load the model in LM Studio and start its local server — by default on `http://localhost:1234`.
3. In CodeFox, click ⚙ **Settings** → Provider: **LM Studio** → **Verify connection**. You should see how many models the server found.
4. Pick a model from the **Model** dropdown (populated from the live server list, not typed by hand) and click **Save**.

No API key is needed for a default LM Studio server; there is an optional API key field in Settings if your server requires one.

### Using Ollama instead

1. Install [Ollama](https://ollama.com) and pull a model, e.g. `ollama pull qwen2.5-coder:7b-instruct`.
2. In CodeFox Settings, set Provider to **Ollama**, enter the Ollama URL and model name, and save. CodeFox can auto-launch Ollama on startup if it finds `ollama.exe`.

### Choosing a model

Local models are a trade-off between speed, memory, and capability. Honest guidance:

| Model size | VRAM (rough) | Notes |
|---|---|---|
| 7B | ~4–8 GB | Fast, good for single-file edits and questions. Weak at multi-file refactors. |
| 14B | ~10–12 GB | A good middle ground for most machines. |
| 32B | ~20 GB+ | Strongest local option, but slow on consumer GPUs and needs a lot of VRAM. |

Smaller models are faster but weaker at multi-file refactors. Keep prompts and plans small — one step at a time, one file at a time — and use Plan mode to break work down before Agent mode writes code.

---

## How to use

### Home

CodeFox opens on **Home**: the project banner, connection cards, skills, and recent references for the active project. The right-hand panel asks "What do you want to build?" — pick a starter pill (**Debug an issue**, **Build a tool**, **Write a script**) or type your own prompt, and it starts a new conversation in chat mode. The `@` button mentions the file open in the viewer; the **Agent** dropdown switches Ask / Plan / Agent, and the model name opens Settings.

### Projects

The project selector at the top of the sidebar shows the active project. Click it to switch projects, open **Project Settings** (rename, change the project folder), or create a **New Project** (name + folder). Each project keeps its own conversations, rulesets, plans, and references; switching refreshes the sidebar, file tree, and Home view. Deleting a project deletes its conversations and references with it, and the last project cannot be deleted.

### Conversations

Click a conversation in the sidebar to open it, or **＋ New conversation** to start one. The first item in the list is always the new-conversation entry.

### Modes

Use the **Ask / Plan / Agent** buttons above the chat input:

- **Ask** — the model answers and explains only. It will not propose file writes.
- **Plan** — the model outputs a plan: `FILE:` lines for every file to touch, then numbered steps. No code yet.
- **Agent** — the model works step by step and outputs complete code, one file per fenced block, each preceded by `**File Path:** \`path\``.

### Tools

The tools row above the chat input:

| Button | What it does |
|---|---|
| Scan project | Scans the project folder (Unity version, packages, scenes, prefabs, scripts) and caches the summary for future prompts |
| Diagnose error | Inserts a prompt for pasting a Unity console error/log and getting a diagnosis |
| Generate tests | Inserts a prompt to write NUnit EditMode tests for the file open in the viewer |
| Animator | Inserts a prompt to generate an Editor script that builds an Animator Controller |
| UI | Inserts a prompt to generate an Editor script that builds a UI Canvas |
| Run tests | Runs EditMode tests in Unity batch mode (needs the Unity Editor path in Settings) and reports pass/fail |
| Build check | Runs `dotnet build` on the solution in the project, if one exists, and reports the result |

### Rulesets
Click **+ New ruleset** in the left panel. Write your project's rules, architecture contracts, hard constraints. Every chat message automatically includes these — the model always knows your standards.

### Plans
Click **+ New plan**. Write what you want done in plain English, listing files to touch:
```
FILE: src/engine/MatchEngine.cs
FILE: src/handlers/DestroyCardHandler.cs

1. Refactor DestroyCardHandler to auto-enqueue RepackLaneRequest
2. Remove direct VFX calls from MatchEngine
3. Wire CardDestroyedEvent to EngineVFXListener
```
Click **▶ Execute plan** — CodeFox creates a dedicated thread, sends the plan to the LLM, and streams the response. When it finishes, if any code blocks are detected, an **Apply changes** bar appears.

### Apply + Revert
- **Apply** — writes files to disk (creating parent folders as needed), triggers Unity refresh (if configured), saves a snapshot
- **Review diff** — shows added/removed/unchanged lines per file before you apply
- **Revert** — restores all modified files from the snapshot, and deletes files that were newly created by the apply. Triggers Unity refresh
- **Snapshot history** — last 5 snapshots shown in the left panel, each with a ↩ revert button

### References
Click **References** in the sidebar to see the project's pages and plans in one list — plans are labelled "Plan", pages are labelled "Reference". After a plan executes, create a Reference documenting what was done. The AI can draft it. References become permanent architecture docs you can discuss in chat.

### Skills
From Home, **Discover Skills** offers six actions:

| Skill | What it does |
|---|---|
| /document-project | Creates a "Game Design Document" reference and asks the model to draft it from the project scan; the finished draft is saved into the reference |
| /prototype-this | Creates a plan from a starter template and opens the plan editor |
| /convert-to-ui-toolkit | Asks the model (Agent mode) for a UGUI → UI Toolkit migration plan and code, starting with the file open in the viewer |
| /audit-project-structure | Scans the project, asks the model for a cleanup audit, and saves the report as a reference |
| /work-with-figma | Needs a Figma connection — Configure opens the Connections view |
| /work-with-jira | Needs a Jira connection — Configure opens the Connections view |

Installed skills stay installed (tracked in the local database). **Manage Skills →** lists all six with Install/Uninstall toggles.

### Connections
Click **Connections** at the bottom of the sidebar for LM Studio, Ollama, the Unity bridge, Figma, Jira, and GitHub, each with a live status:

- **LM Studio / Ollama** — status from the running backend; Configure opens Settings.
- **Unity Bridge** — "Installed" when `Assets/Editor/CodeFoxBridge.cs` exists in the project; otherwise **Install bridge** really copies the bundled companion script there.
- **Figma / Jira** — "Not connected" until you save a token (and a site URL for Jira) in the Configure dialog. Tokens are stored locally and used only for those imports; there is no Figma or Jira import yet, and the UI says so.
- **GitHub** — managed in Muse, not in CodeFox; there is no action to take here.

The **Your Connections** cards on Home are the quick version: the Unity card shows "1 Connected" when the project folder has an `Assets` folder (clicking it scans the project), and Local Folders tracks extra folders you add. CodeFox is Unity-focused — Unreal projects are not supported yet, so there is no Unreal card.

### Test loop
1. Use **Generate tests** to create an EditMode test file for a script.
2. Apply it, then click **Run tests**. CodeFox runs Unity in batch mode (up to 10 minutes) and reports passed / failed / skipped.
3. If tests fail, ask the model to fix the failures one at a time, re-apply, and run the tests again.
4. **Build check** runs `dotnet build` on the project's solution as a second opinion.

If no Unity Editor path is set, Run tests tells you exactly that and how to set it in Settings — it never fakes a pass.

---

## Unity integration (optional)

Copy the companion script into your Unity project:

```
unity-companion/CodeFoxBridge.cs  →  Assets/Editor/CodeFoxBridge.cs
```

Unity compiles it automatically. It watches for file changes from CodeFox and calls `AssetDatabase.Refresh()` so Unity recompiles without you switching to it manually.

It also watches `Assets/.codefox-command.json`. When a command file appears, the bridge executes it, writes the result to `Assets/.codefox-result.json`, and deletes the command file. Supported actions: `refresh`, `createAnimatorController`, and `createUICanvas` (see the comments at the top of `CodeFoxBridge.cs` for the JSON format).

Menu items added in Unity: **CodeFox > Refresh**, **CodeFox > Run EditMode Tests** (opens the Test Runner), **CodeFox > Open Project Folder**.

---

## Settings

| Setting | Description |
|---|---|
| LLM provider | LM Studio (default) or Ollama |
| LM Studio server URL | Default: `http://localhost:1234/v1` |
| Model | Pick from the live list returned by the LM Studio server (Verify connection / Refresh models) |
| API key | Optional — LM Studio needs none by default |
| Temperature | 0 = focused, 1 = creative. Default: `0.2` |
| Max tokens | Max tokens per reply. Default: `4096` |
| Ollama URL | Default: `http://localhost:11434` (only when provider is Ollama) |
| Ollama model name | Any model you've pulled via Ollama |
| Ollama executable path | Leave blank to auto-detect, or Browse to locate `ollama.exe` |
| Project path | Root folder of your project |
| Project context | One-line description injected into every system prompt (e.g. "a Unity 6 card game") |
| Unity Editor executable path | Needed for Run tests, e.g. the Unity.exe under your Unity Hub install |

The titlebar status dot shows the active provider and selected model (e.g. "LM Studio · qwen2.5-coder-14b"), "LM Studio offline", or "No model selected".

---

## Working together (planned)

Simultaneous multi-user editing is **not in this release**. CodeFox is a local, single-user app: one project database on one machine, no accounts, no sync, no invites.

The data model is already per-project (a `projects` table, and a `project_id` on conversations, rulesets, plans, and references), so a sync layer can be added later without restructuring. That layer would need: a shared project store all collaborators can reach, presence (who is looking at what), and conflict handling for apply/revert (two people writing the same file, snapshots taken on different machines). None of that exists yet — do not expect two copies of CodeFox to stay in sync by sharing a folder.

## Architecture

```
main.js       Electron main process — DB, IPC, file system, LLM providers
              (llm:status / llm:listModels / llm:verify / llm:chat, project:scan,
              project:list / project:create / project:switch / project:update /
              project:delete, skills:list / skills:set, unity:runTests /
              unity:buildCheck / unity:installBridge, fs:moveFile), Ollama process management
preload.js    Context bridge — exposes safe API to renderer (rb.llm, rb.project, rb.unity, rb.skills)
app.js        All UI logic — Home, projects, state, chat, modes, tools, plans, file tree, apply/revert, diff
index.html    Layout — top bar, sidebar, Home / chat / editor / connections / references, right build panel + file tree
```

LLM backends:
- **LM Studio** — OpenAI-compatible local API at `{base}/v1/models` and `{base}/v1/chat/completions` (streaming SSE). The base URL is normalised (trailing slash and a pasted `/chat/completions` suffix are stripped).
- **Ollama** — the original `/api/chat` streaming API, kept working for existing users.

Data is stored in SQLite via sql.js at:
- **Windows:** `%APPDATA%\codefox\codefox.db`
- **Mac/Linux:** `~/.config/codefox/codefox.db`

---

## What local models can't do as well as cloud models

Be honest about this — it shapes how you should use the tool:

- **Large refactors** across many files at once. Local context windows are smaller; break work into small plans and execute one step at a time.
- **Vision / image-to-UI** — local models in this setup have no vision input, so describing a screenshot or a Figma design and expecting a pixel-faithful UI will disappoint. Describe the layout in words, one screen at a time.
- **Long context** — a whole large codebase does not fit. The project scan gives the model names and structure, not full file contents; attach the specific files you are working on to the chat.
- **Speed on big models** — a 32B model on a consumer GPU is slow. A 7B/14B model answers faster and is often the better trade-off for quick edits.
- **Hallucinated APIs** — local models invent Unity APIs and asset paths more often. The project scan and rulesets help; always review the diff before applying, and let the test loop catch mistakes.

CodeFox is not trying to match a cloud assistant feature for feature. It is a free, local tool that does the most useful parts of the job — context, plans, step-by-step execution, tests, and safe apply/revert — on your own machine, with your code never leaving it.

---

## Roadmap / Contributing

This is early software. Contributions welcome.

- [x] LM Studio support (default backend)
- [x] Diff view before applying changes (show what changed line by line)
- [x] Multi-file context injection (project scan + add files to chat)
- [ ] Syntax-highlighted code blocks in chat
- [ ] Support for non-Ollama backends (llama.cpp)
- [ ] macOS / Linux Ollama path detection
- [ ] Plugin system for language-specific tooling
- [ ] Git integration (auto-commit after successful apply)
- [x] Multiple project support
- [ ] Simultaneous multi-user editing (see "Working together (planned)")

---

## License

MIT — do whatever you want with it.

---

## Building a distributable

```bash
# Install dev dependencies
npm install

# Build for your current platform
npm run build

# Or target specific platforms
npm run build:win    # Windows .exe installer
npm run build:mac    # macOS .dmg
npm run build:linux  # Linux AppImage + .deb
```

Output goes to the `dist/` folder. There is only ever one installer, and every build overwrites it: `dist/CodeFox-Setup.exe` on Windows (the build cleans `dist/` first, and the filename has no version number in it). If you still have old versioned installers in `dist/` from earlier builds, delete them once — new builds will never create another one.

**Before building:** add icon files to `assets/` — see `assets/ICONS_NEEDED.md` for details. Without icons the build still works but uses electron-builder's default icon.

### GitHub Actions (CI builds)

Add `.github/workflows/build.yml` to auto-build releases on every tag push. Example:

```yaml
name: Build
on:
  push:
    tags: ['v*']
jobs:
  build:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: codefox-${{ matrix.os }}
          path: dist/
```
