# CodeFox

A free, local AI coding assistant that runs entirely on your machine. No cloud. No credits. No data leaving your computer.

Built on Electron + SQLite, with [LM Studio](https://lmstudio.ai) as the default local model backend and [Ollama](https://ollama.com) as an alternative backend.

![CodeFox](https://img.shields.io/badge/version-0.7.0-blue) ![License](https://img.shields.io/badge/license-MIT-green)

---

![CodeFox Screenshot](assets/screenshot.png)

---

## What it does

- **Home** — the default view when CodeFox opens: a banner for the active project, connection cards (Unity / local folders), a Discover Skills grid, recent references, and a "What do you want to build?" panel that starts a new conversation. The app icon is the same kitsune nine-tails mark shown on Home
- **Multiple projects** — keep several local projects in CodeFox, each with its own conversations, rulesets, plans, and references. Switch from the project selector at the top of the sidebar, or create a new one with **New Project**. No accounts, no teams, no sync — everything stays on this machine
- **Chat** with a local LLM about your codebase across persistent conversations
- **Ask / Plan / Agent modes** — Ask answers and explains only, Plan drafts steps and file lists without writing code, Agent works step by step and outputs complete code in fenced blocks with file paths
- **Agent mode (the loop)** — in Agent mode the assistant runs its own commands, reads the output, and tries again on its own (build, see the error, fix it, rebuild), up to a max number of tool rounds, with a Stop button and approval bars for anything risky
- **Unity Package Manager** — the assistant can install and remove Unity packages by editing `Packages/manifest.json` (backed up first, Unity refreshes after). Package installs always ask first, and a missing version is never guessed — you type it in the approval bar
- **Project scan** — reads your Unity project (version, packages, scenes, prefabs, scripts) and includes a summary in every prompt, so the model knows what actually exists instead of guessing
- **Rulesets** — define project rules, architecture contracts, naming conventions. Auto-injected into every prompt.
- **Plans** — describe what you want done. The AI proposes steps and lists files before touching anything. You approve, then execute.
- **References** — pages and plans in one list: AI-authored architecture docs (pages) and step-by-step plans, kept per project so they grow into a living knowledge base
- **Skills** — one-click actions from Home: draft a Game Design Document, plan a feature prototype, migrate UGUI to UI Toolkit, or audit the project structure. Figma and Jira skills need a connection first (see Connections) and say so honestly instead of faking it
- **Connections** — a single view for LM Studio, Ollama, the Unity bridge, Figma, Jira, and GitHub, each with a real status and an action that either does the thing or says what is still needed. The Unity bridge really installs `CodeFoxBridge.cs` into `Assets/Editor/` (and can be removed again from Settings → Connections, which deletes the file); it installs automatically whenever a Unity project is connected, and opening Settings → Connections on a project without a bridge installs it then. Figma/Jira tokens are stored locally and used only for those imports
- **MCPs** — configure local MCP servers (command, arguments, environment) in Settings → MCPs, with ten recommended presets and a guided setup prompt that walks through the steps and checks each token or app for real. Servers run on this machine; the assistant does not call MCP tools yet, and the UI says so — the settings are stored so that wiring can be added without reconfiguring
- **ComfyUI** — a native integration with a locally running ComfyUI (default `http://127.0.0.1:8188`): **Scan for ComfyUI** finds the install, workflows and models in the usual places; import your own workflow JSON files, see which nodes and models each one needs, generate images from a simple prompt-first form in the ComfyUI panel (or from the Agent loop), and import the results into the project under `Assets/Generated/<workflow>/`. Only workflows you approve run from the Agent loop without asking
- **Shell tool** — with the shell off by default, the assistant's PowerShell blocks never run on their own. Turn it on in Settings → Advanced to run commands, auto-approve safe prefixes, or auto-accept project changes (still snapshotted first, always revertible)
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

### Updating CodeFox

```bash
git pull
npm ci
npm run build:win
```

`git pull` should now just work, with no restore step. The reason it kept blocking before: every build rewrote `unity-bridge-source.js`, a file that was tracked in git, so the working tree was dirty after every build and the next pull refused to overwrite it (the same class of problem as `package-lock.json`, which `npm install` rewrites). That file is now generated and ignored, like the app icons — it is regenerated at install/start/build time — so no build step modifies a tracked file any more.

Use `npm ci` instead of `npm install` when dependencies change: `npm ci` installs exactly what the lockfile says and never rewrites it, while `npm install` can. If a pull ever still complains about a local change, `git restore <file>` remains the escape hatch, and it is safe for generated files.

One-time note: if you ran the old `npm install-scripts approve electron` step, it wrote an `allowScripts` entry into your local `package.json` — a local change that will show up once. Restoring `package.json` once removes it. Whether the approval is even needed is uncertain: Node 26 ships npm 11, which warns about install scripts but still runs them — only npm 12 blocks them by default — so the approval may have been a red herring all along.

If buttons ever stop responding, the app now says so on screen: on startup it checks it can reach the main process, and if it cannot, a red or amber banner appears at the top of the window naming the failure ("bridge missing" or "bridge timeout"). Report that exact message — it is the diagnosis.

If buttons stop responding or a connection check does nothing, open **Settings → Advanced → Developer tools** and look at the red errors in the Console tab — that is the fastest way to find out what broke.

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
- **Agent** — the model works step by step and outputs complete code, one file per fenced block, each preceded by `**File Path:** \`path\``. In Agent mode CodeFox also runs the loop: after each reply it runs the model's safe commands, applies its file changes, and installs the packages it asked for, then sends the results back to the model so it can fix errors and retry — without you prompting again. See "Agent mode (the loop)" below.

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

Settings → **Rules** controls how much of them the model sees: each ruleset has an enabled toggle and a priority (higher is sent first), and a **prompt budget** (default 4000 characters, 1000–12000) caps how many characters of rules go with each message — whole rulesets only, never cut off mid-way. The section shows what was included in the last message and what was left out. **Condense rules** asks the model to squeeze the enabled rulesets under 500 characters while keeping every hard constraint; with **Use condensed rules when over budget** on, that condensed version is sent instead of dropping rules. If the model can't be reached, condensing fails honestly and changes nothing.

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
- **Auto-apply for new Unity assets** — when the assistant creates a NEW Unity-native file (a prefab, scene, material, animation, controller, or similar — a file that contains no code), CodeFox writes it straight away after taking a snapshot, without asking you to click Apply. A simple "make me a prefab" request finishes in one turn. Code files (.cs, .shader, .js, .ts) and edits to files that already exist still show the Apply bar first, unless auto-accept is on. If the change set is mixed — any code file, or any edit to an existing file — the whole set asks first; auto-apply never writes half a set. Turn it off in Settings → Advanced → "Auto-apply new Unity asset files" (`auto_apply_unity_assets`, default on).
- **Review diff** — shows added/removed/unchanged lines per file before you apply
- **Revert** — restores all modified files from the snapshot, and deletes files that were newly created by the apply. Triggers Unity refresh. The revert bar appears after EVERY apply — manual Apply, auto-accept, or auto-apply — and stays there until you click Revert or Keep. It never auto-dismisses, and a new chat message does not replace it.
- **Keep changes** — an explicit click that discards the snapshot, so the change can no longer be reverted. Nothing discards a snapshot automatically: not closing the app, not starting a new conversation. Only a Keep click does.
- **Snapshot history** — last 5 snapshots shown in the left panel, each with a ↩ revert button, so you can undo even after the revert bar is gone

### Agent mode (the loop)

In **Agent** mode only (Ask and Plan never loop), CodeFox runs a loop after each assistant reply:

1. It parses the reply for actions, in order: file changes (the usual `**File Path:**` + fenced block), ```powershell / ```pwsh / ```shell blocks, and ```upm-install / ```upm-remove blocks.
2. Safe actions run on their own: shell commands that match your auto-approved list when the shell is on and Auto Mode is on, and file changes when auto-accept is on.
3. Anything risky pauses the loop on its approval bar instead of running: dangerous shell commands, any package install or removal, and file changes when auto-accept is off. Click Run / Apply / Install and the loop resumes from that point; click Dismiss and the loop resumes with a "User declined" note so the model can try a different approach.
4. Every executed action's result is appended to the conversation as a tool-result message (`Tool result — <command> (exit 0): …`) and sent to the model with the next turn, so it can see the build error and fix it, then rebuild — without you prompting again.
5. The loop ends when a reply contains no actions (the final reply is the answer), when you click **Stop** under the reply, or when the max rounds are reached.

**Max rounds** — Settings → Advanced → "Max tool rounds per reply", default 5, range 1–10. When the max is hit the loop stops and says "Stopped after N tool rounds — the task may need more steps. Ask me to continue if you want." The max is a hard cap even if the model keeps producing actions. While looping, a status line under the reply shows what it is doing ("Working… round 2/5 — ran `dotnet build`").

**Approval rules** (also in Settings → Advanced, under "What runs automatically, what always asks"):
- Safe auto-approved commands run automatically in Auto Mode.
- Dangerous commands always ask: `rm`, `del`, `Remove-Item`, `format`, `rm -rf`, `rmdir /s`, `rd /s`, `Remove-Item -Recurse` — even in Auto Mode, even if they match an auto-approved prefix.
- Package installs and removals always ask — even in Auto Mode, even with auto-accept on. There is no way to auto-approve them.
- New Unity asset files (prefabs, scenes, materials…) are written automatically after a snapshot — revert is always available afterwards.
- File changes ask unless auto-accept is on (and are snapshotted first either way).
- Nothing runs while the shell is off, and no package is installed while no project folder is set.

The model can only trigger actions by writing the fenced blocks — if it answers in plain prose with no blocks, the loop ends and that answer is shown as-is.

**The model MUST output the file, not just describe the fix.** The apply pipeline already works end-to-end — it created TestTMP.prefab from a plain request — so this change is about making the model USE it every time it is told to fix something, not about building a new pipeline. In Agent mode the system prompt orders the model, in plain words: it MUST edit the project's files when asked to fix, change, create, or edit code, and describing the fix, explaining it, or saying it cannot modify files is a FAILURE. And the app enforces it, it does not just ask: if a reply contains a refusal ("cannot modify files" and similar), CodeFox automatically sends one correction turn telling the model it CAN modify files here; and if the user asked for a change but the reply produced no file actions at all — the model just described the fix and stopped — that turn is treated as incomplete and CodeFox automatically sends one follow-up demanding the file. One retry each at most; if the model still does not output the change, the loop stops and says so plainly instead of pretending the description was an answer. A local model can still fail to comply — this is prompt engineering plus enforcement, not a guarantee — but a description without a file is no longer accepted as a finished answer.

### Unity Package Manager

CodeFox manages Unity packages by editing the project's `Packages/manifest.json` — it does not talk to Unity's Package Manager API directly. Unity itself resolves the packages when it refreshes (CodeFox writes the same refresh trigger the bridge watches). Every edit is backed up first to `Packages/manifest.json.codefox-bak`.

The assistant requests packages with fenced blocks in its reply. Three formats:

```
```upm-install
com.unity.textmeshpro@3.0.6
```
```upm-install
com.unity.textmeshpro
```
```upm-install
https://github.com/user/repo.git#1.0.0
```
```

- `name@version` — installs that exact version (`3.0.6`, a git URL, or a tarball / file path are all accepted as the version).
- `name` with no version — CodeFox does **not** guess a version. The approval bar shows an editable version field (empty) and Install stays disabled until you type a version.
- A git URL on its own — the package name is not in the URL, so the approval bar asks you to type the package name too, and the URL becomes the version.
- Removals use a ```upm-remove block with one package name per line, and the same approval bar with a Remove button.

Package installs and removals **always** need approval (see above). The project scan includes the installed packages (with requested and locked versions), so the model knows what is already installed and does not re-install it. Settings → Connections (and the Connections view) lists the installed packages under the Unity row, each with a Remove button that needs a confirm click.

### ComfyUI

CodeFox connects directly to a locally running ComfyUI instance — a **native** provider, not an MCP server. ComfyUI handles generation; CodeFox handles the workflow: importing your workflows, checking them, running them, and getting the results into the project.

**Connection** — open **ComfyUI** in the sidebar (under Connections) or Settings → Connections → ComfyUI. The default URL is `http://127.0.0.1:8188` (configurable). **Verify** checks the real server: it tries `GET /system_stats` and falls back to `GET /object_info` on ComfyUI versions that do not serve it, and shows the ComfyUI version when the server reports one. When ComfyUI is not running the panel says "Not running" with the real error — nothing is faked, and the integration stays inert until a connection succeeds. **Open ComfyUI ↗** opens the URL in your browser.

**Discovered capabilities** — read live from `GET /object_info` and shown as chips: image generation (KSampler + CheckpointLoader, or the Flux / SD3-style split — a sampler + UNet loader + CLIP loader + VAE loader), video, upscaling, ControlNet, inpainting, image-to-image, LoRA, IP-Adapter. A capability is only listed when this install actually has the nodes for it. Below the chips, **All nodes in /object_info** lists every node class the server reported, so an install with none of the familiar families still shows exactly what it has; if `/object_info` comes back empty the panel says so plainly instead of guessing.

**Find ComfyUI (scan)** — **Scan for ComfyUI** checks the standard Windows locations in order — ComfyUI Desktop user data (`%APPDATA%\ComfyUI`), `Documents\ComfyUI`, the home folder, portable `C:\ComfyUI` / `D:\ComfyUI`, and the program folder — plus the server URL, and reports what it found at each place: workflows folder and file count, model counts per category, custom_nodes presence. When a workflows folder is found it is set as the workflows folder automatically and its workflows imported (including subfolders). The scan is bounded to those roots — no whole-drive walk. The manual Browse picker remains as the fallback.

**Workflow Library** — pick the folder containing your ComfyUI workflow JSON files (CodeFox looks for the usual ComfyUI Desktop workflows folder first, otherwise you pick one, or press **Scan for ComfyUI** and let it find one). **Rescan** reads every `*.json` in that folder as an API-format workflow graph and catalogues it: name (from the filename), a purpose label you can edit, the configurable inputs it detected (positive/negative prompt from the CLIPTextEncode nodes wired into the sampler, seed / steps / cfg / sampler / scheduler, checkpoint name, input image, filename prefix, and any other string/number input), the output nodes (SaveImage / PreviewImage / SaveVideo), and missing dependencies — node types not present in `/object_info`, and checkpoint names not in the model lists ComfyUI reports. A workflow with missing dependencies is marked **Unavailable** with the reason shown; nothing is auto-installed. Workflows are stored as your own files plus this catalogue (`comfyui_workflows` setting) — CodeFox never hardcodes a workflow graph and never ships a sample workflow as if it were yours.

**Generate** — select a workflow and the panel shows a **simple form** first: a big Prompt box and a Negative prompt box (labelled from the workflow's wiring; if the wiring cannot tell them apart they are labelled Prompt 1 / Prompt 2 and the panel says so), Seed with a Random button, Steps, CFG and Denoise for KSampler nodes, and size presets (Square 1024, Portrait 832×1216, Landscape 1216×832, plus custom width/height) when the workflow has a latent-size node. Only controls the workflow actually supports are shown — a workflow with no text-prompt input says so and shows no prompt boxes. Below it, **Advanced — all inputs** lists every input the workflow exposes. **Run** submits the workflow and polls `/queue` + `/history` every 2 seconds (polling, not a WebSocket — by design) until it completes, with a Cancel button and a 10-minute cap. On completion the output images appear as thumbnails, each with **Import to project** (and an **Import all** button). Import copies the file into the active project under `Assets/Generated/<workflow-name>/`, snapshotted first so revert can delete it, and adds a Reference entry noting the workflow and the settings used. ComfyUI's web UI is never embedded — no iframe, no node editor; the form is CodeFox's own UI over the workflow's inputs.

**History** — the last 20 generations from `GET /history`, with prompt id, status, and a **View outputs** action.

**Agent mode** — in Agent mode only, the model can invoke ComfyUI with a fenced block:

```
```comfyui
{"workflow": "card art", "inputs": {"positive": "a knight holding a sword, painterly", "seed": 42}}
```
```

The workflow must exist in the catalogue and be Available (missing dependencies → a tool result saying so, and the loop continues). **Approved for autonomous execution** is a per-workflow toggle (default off): approved workflows submit immediately and the loop polls to completion, then auto-imports the outputs to `Assets/Generated/<workflow>/` and continues with a tool result listing the filenames and the project path. Unapproved workflows pause the loop on a Run/Review bar ("Generate with `<workflow>`? `<inputs>`") — Run submits and resumes, Dismiss resumes with a decline note. Generation never runs in Ask/Plan mode: there the block is shown as text only.

**API endpoints used** — `GET /system_stats` (status, with `/object_info` fallback), `GET /object_info` (nodes, models, capabilities; cached 5 minutes), `POST /prompt` (submit), `GET /queue` + `GET /history` (polling), `GET /view` (download outputs to disk), `POST /upload/image` (upload an input image). No new npm dependencies: the client uses Node's global `fetch` + `FormData`.

**Known limits** — polling, not a WebSocket, so progress updates arrive every 2 seconds; generation is local and can take minutes; a workflow's missing nodes/models are reported, not auto-installed; a workflow whose checkpoint is missing cannot run until you install it in ComfyUI.

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

The **Your Connections** cards on Home are the quick version: the Unity card shows "1 Connected" when the project folder has an `Assets` folder (clicking it scans the project), and "Connected · Bridge installed" when the bridge file is present; Local Folders tracks extra folders you add. CodeFox is Unity-focused — Unreal projects are not supported yet, so there is no Unreal card. Full connection management lives in Settings → **Connections**: the Unity row shows the active project's name and path with a live Connected/Not connected status, an **Update plugin** button that re-installs the bridge, an enable toggle (off removes the bridge file from the project), and a ⋯ menu with **Disconnect**; local folders each have a Remove button.

### Test loop
1. Use **Generate tests** to create an EditMode test file for a script.
2. Apply it, then click **Run tests**. CodeFox runs Unity in batch mode (up to 10 minutes) and reports passed / failed / skipped.
3. If tests fail, ask the model to fix the failures one at a time, re-apply, and run the tests again.
4. **Build check** runs `dotnet build` on the project's solution as a second opinion.

If no Unity Editor path is set, Run tests tells you exactly that and how to set it in Settings — it never fakes a pass.

---

## Unity integration (optional)

CodeFox installs the companion script automatically whenever a Unity project is connected (creating it, switching to it, changing its folder, opening Settings → Connections, or starting the app with a project already set). The bridge file lives at `Assets/Editor/CodeFoxBridge.cs` in your project, and the Connections view shows "Connected" once it is there. If the install fails for a real reason (for example the folder is not writable), Settings → Connections shows that error instead of hiding it.

The bridge is versioned: the file carries a `// CodeFoxBridge version: X.Y.Z` marker, and CodeFox compares the installed version with the bundled one. When a newer CodeFox is installed, the bridge in your project is overwritten automatically on the next launch (or when you open Settings → Connections) — so a fixed bridge reaches a project that already has an older one, with no clicks. The toggle turns the bridge off per project (off removes the file and stays off — no auto-install will put it back until you turn it on again). **Update plugin** is greyed out while the installed bridge is up to date, and becomes clickable only when a newer bundled bridge is available; clicking it overwrites the bridge and it disables itself again.

You can also install or remove the bridge from Settings → Connections (Update plugin re-installs it, the toggle removes it). The bridge source also ships in the repo at `unity-companion/CodeFoxBridge.cs` for reference.

The installed app always carries the bridge two ways: the `unity-companion/` folder is packaged with the app, and the bridge source is also embedded in the app (regenerated from the `.cs` file before every build by `scripts/embed-bridge.js`), so installing it never fails for a missing source file.

Unity compiles it automatically. It watches for file changes from CodeFox and calls `AssetDatabase.Refresh()` so Unity recompiles without you switching to it manually.

It also watches `Assets/.codefox-command.json`. When a command file appears, the bridge executes it, writes the result to `Assets/.codefox-result.json`, and deletes the command file. Supported actions: `refresh`, `createAnimatorController`, and `createUICanvas` (see the comments at the top of `CodeFoxBridge.cs` for the JSON format).

Menu items added in Unity: **CodeFox > Refresh**, **CodeFox > Run EditMode Tests** (opens the Test Runner), **CodeFox > Open Project Folder**.

---

## Settings

Click ⚙ **Settings** in the sidebar or the top bar. Settings is a full window in the centre column (not a popup), with its own sub-nav: **Model**, **Connections**, **MCPs**, **Rules**, **Advanced**.

### Model

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

### Connections

**Your Connections** — local integrations for this project. Nothing here phones home. Filter by Unity / Folders, add a Unity project or a local folder, and manage the Unity bridge: **Update plugin** is disabled (greyed out, "Bridge is up to date") while the installed bridge is current and becomes clickable only when a newer bundled bridge is available, the toggle enables/disables it (off removes the file and stays off — auto-install respects it), and the ⋯ menu has **Disconnect**. Status is checked live from whether the bridge file exists, and the installed bridge version is shown next to it. A **Packages** list under the Unity row shows the installed packages from `Packages/manifest.json`, each with a Remove button (confirm click). A **Manage MCP connections →** button jumps to the MCPs section. A **ComfyUI** card shows the local ComfyUI status (Verify + **Open ComfyUI panel →**), mirroring the LM Studio card — ComfyUI settings (URL, workflows folder) live here, not in Model, because it is not a language model.

### MCPs

Configure local MCP servers — name, command, arguments, and `KEY=value` environment lines — each with an enabled toggle. Servers run on this machine; CodeFox never sends your code to them or anywhere else. Honest scope: MCP servers are configured here for now. The assistant does not call MCP tools yet — that wiring is the next step, and these settings are stored so it can be added without reconfiguring. There is no cloud MCP marketplace.

**Recommended presets** — ten servers, each genuinely useful for making a Unity game. **Add** opens a guided setup prompt: it shows what the preset does, numbered steps you can actually follow (with a link that opens in your browser), the exact input(s) needed (token as a password field, folder with Browse), and a **Check** button that verifies the token against the service's own API (Figma `GET /v1/me`, GitHub `GET /user`, Notion `GET /v1/users/me`, Jira `GET /rest/api/3/myself`, Trello `GET /1/members/me`) or checks the app is on PATH (Blender, `uvx`) — and reports exactly what was found. **Add server** stays disabled until the check passes or you tick "I have done the steps above — add it anyway", so a failed check never blocks you and a pass is never faked. Presets with no automatic check (Perforce, Filesystem) say so in the prompt and the checkbox is the only path. The inline token/folder inputs on each card stay as the quick path (**Quick add**). Adding a preset only adds the configuration — the app, token, addon, or plugin each one needs is separate, and each card says what it needs:

- **Blender** (`uvx blender-mcp`) — work with 3D models, scenes, and materials in Blender. Needs Blender 3.0+, `uv`, and the Blender MCP addon installed and enabled, with the MCP server started from Blender's 3D viewport.
- **Figma** (`npx -y figma-developer-mcp`) — read Figma designs, export images, extract styles and tokens for UI. Needs a Figma personal access token (`figd_…`), entered in the preset card; Install stays disabled without one.
- **Unity (Coplay)** (`uvx --from mcpforunityserver mcp-for-unity --transport stdio`) — control the Unity Editor directly: scenes, GameObjects, play mode. Needs `uv` and the Coplay Unity MCP plugin in your project. Maintained by Coplay, not affiliated with Unity Technologies. It overlaps with CodeFox's own bridge, which stays the safer default for file changes.
- **GitHub** (`npx -y @modelcontextprotocol/server-github`) — read repos, issues, and pull requests. Needs a GitHub personal access token with repo read access.
- **Filesystem** (`npx -y @modelcontextprotocol/server-filesystem <folder>`) — give the assistant read access to a folder outside the project, e.g. a shared assets folder. Pick the folder in the preset card.
- **Git** (`uvx mcp-server-git --repository <folder>`) — read git history, branches, and diffs for the project. Defaults to the active project folder.
- **Atlassian (Jira + Confluence)** (`uvx mcp-atlassian`) — read Jira issues (and Confluence pages, with the optional Confluence fields). Needs your Jira site URL, Atlassian account email, and an API token from id.atlassian.com → Security → API tokens. Checked against the Jira API.
- **Notion** (`npx -y @notionhq/notion-mcp-server`) — read Notion pages and databases. Needs a Notion Personal Access Token (`ntn_…`); the integration must also be given access to the pages (open a page → ⋯ → Add connections), or the token sees nothing. Checked against the Notion API.
- **Trello** (`npx -y @delorenj/mcp-server-trello`) — read Trello boards, lists, and cards. Needs two credentials from trello.com/app-key: the API key and a token generated on the same page. Checked against the Trello API.
- **Perforce (P4)** (`uvx p4mcp-server --readonly`) — read a Perforce depot (files, changelists, history), read-only by default. Needs a reachable P4 server with a valid login; the connection comes from your `.p4config` / `P4PORT` / `P4USER`. No automatic check — follow the steps, then tick the box.

There is deliberately no Miro preset: the official Miro MCP server is a remote HTTP server with OAuth only (no local stdio command that fits CodeFox's config model), and the community binary has no Windows one-click install path.

Adding a preset never adds a duplicate — if it is already configured, the card shows "Added ✓". A preset server appears in the configured-servers list below with Edit / Remove / toggle working exactly like a manually added server.

### Rules

Per-ruleset enabled toggles and priorities (higher = sent first), a **prompt budget** (default 4000 characters, 1000–12000) that caps how many characters of rules go with each message — whole rulesets only, never cut off mid-way — and a readout of what was included in the last message and what was left out. **Condense rules** asks the model for a sub-500-character version that keeps every hard constraint; with **Use condensed rules when over budget** on, that version is sent instead of dropping rules. If the model can't be reached, condensing fails honestly and changes nothing.

### Advanced

- **Shell Tool** — off by default. When off, no command can run from the app at all and the rest of the section is greyed out. When on, CodeFox runs PowerShell commands (PowerShell on Windows, the system shell elsewhere) in the project folder, with a 60-second timeout.
- **Auto Mode** — when on, commands that match your auto-approved list run automatically. Everything else asks first, via a Run / Dismiss bar under the assistant's reply.
- **Approvals** — **Auto-accept project changes** keeps project changes automatically when the assistant finishes a response. Changes are still snapshotted first, and the revert bar is always shown so you can undo. **Auto-apply new Unity asset files** (`auto_apply_unity_assets`, default on) writes new Unity-native files (prefabs, scenes, materials…) straight away after a snapshot, without an Apply click; code files and edits to existing files still ask first.
- **Auto-approved commands** — editable list of command prefixes (defaults: `git status`, `git diff`, `npm test`, `npm run test`, `dotnet build`, `dotnet test`).
- **Excluded File Types** — file types hidden from project scans and file search (defaults include `meta`, `mat`, `anim`, `controller`, `png`, `jpg`, `asset`, `package-lock.json`, and more), with Add and Restore default.
- **Run a command** — a manual input + Run button + output area to test the shell tool directly.
- **Agent loop** — "Max tool rounds per reply" (`agent_max_rounds`, default 5, 1–10) caps how many tool rounds Agent mode runs before stopping. See "Agent mode (the loop)" above.
- **What runs automatically, what always asks** — a plain-language summary: safe auto-approved commands run automatically in Auto Mode; dangerous commands always ask; package installs/removals always ask; new Unity asset files are written automatically after a snapshot (revert always available); file changes ask unless auto-accept is on; nothing runs while the shell is off, and no package is installed while no project folder is set.
- Dangerous commands are never run automatically: `rm`, `del`, `Remove-Item`, `format`, `rm -rf`, `Remove-Item -Recurse`, `Remove-Item -Force -Recurse`, `rmdir /s`, and `rd /s` always ask first, even if they match an auto-approved prefix.
- **Editor Integration** — the Unity bridge is CodeFox's editor integration; there is nothing else to configure here.

CodeFox has no workspace settings — it is a single-user local app with no accounts, no teams, and no sync, so there is nothing workspace-wide to configure.

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
              unity:buildCheck / unity:installBridge / unity:removeBridge /
              unity:ensureBridge, unity:listPackages / unity:addPackage /
              unity:removePackage, fs:moveFile, shell:openExternal,
              mcp:checkToken / mcp:checkApp, comfyui:status / comfyui:objectInfo /
              comfyui:queue / comfyui:history / comfyui:submit / comfyui:view /
              comfyui:uploadImage / comfyui:listWorkflows), Ollama process management
upm-manifest.js Unity Package Manager manifest helpers — read / back up /
              edit Packages/manifest.json (plain Node, no Electron)
unity-bridge.js Unity bridge install helpers — bundled file first,
              embedded copy as fallback; auto-install on connect
unity-bridge-source.js Generated embedded bridge source (scripts/embed-bridge.js)
mcp-presets.js  Curated MCP presets — the ten recommended servers (plain Node, no Electron)
comfyui.js      Native ComfyUI provider — HTTP client + workflow parsing (plain Node, no Electron)
preload.js    Context bridge — exposes safe API to renderer (rb.llm, rb.project, rb.unity, rb.skills, rb.mcpPresets, rb.shell.openExternal, rb.mcp, rb.comfyui)
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
- [x] Agent loop (Agent mode) + Unity Package Manager (manifest-based, always asks first)
- [x] Unity bridge auto-install on connect, with an embedded fallback so the install cannot fail for a missing source file
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

**App icon:** the build uses the kitsune mark — the icon files are stored in the repo as base64 text (`build/icon.png.b64`, `build/icon.ico.b64`) and `scripts/prepare-icons.js` regenerates the real files automatically before every build, so there is nothing to add by hand.

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
