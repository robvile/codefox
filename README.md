# CodeFox

A local AI coding assistant that runs entirely on your machine. No cloud. No credits. No data leaving your computer.

Built on [Ollama](https://ollama.com) + Electron + SQLite.

![CodeFox](https://img.shields.io/badge/version-1.0.0-blue) ![License](https://img.shields.io/badge/license-MIT-green)

---

## What it does

- **Chat** with a local LLM about your codebase across persistent threads
- **Rulesets** — define project rules, architecture contracts, naming conventions. Auto-injected into every prompt.
- **Plans** — describe what you want done. The AI proposes steps and lists files before touching anything. You approve, then execute.
- **Pages** — AI-authored architecture docs written after each plan executes. Grows into a living knowledge base of your project.
- **File tree** — browse your project, view files, add them to chat with one click. Search across all files instantly.
- **Apply changes** — LLM responses containing code blocks get a one-click "Apply changes" button that writes files to disk.
- **Snapshots + Revert** — before writing anything, CodeFox backs up every file it touches. One click to revert if something breaks.
- **Unity integration** — includes an Editor companion script that auto-refreshes Unity's AssetDatabase when files change.
- **Ollama auto-launch** — opens Ollama automatically on startup if it isn't already running.

---

## Requirements

- [Node.js](https://nodejs.org) 18+
- [Ollama](https://ollama.com) installed on your machine
- A pulled model — recommended: `qwen2.5-coder:32b-instruct` (needs ~20GB VRAM) or `qwen2.5-coder:7b-instruct` for smaller GPUs

---

## Setup

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/codefox.git
cd codefox

# 2. Install dependencies
npm install

# 3. Pull a model (if you haven't already)
ollama pull qwen2.5-coder:32b-instruct

# 4. Run
npm start
```

First launch: click ⚙ Settings and set your project folder path and model name.

---

## Unity integration (optional)

Copy the companion script into your Unity project:

```
unity-companion/CodeFoxBridge.cs  →  Assets/Editor/CodeFoxBridge.cs
```

Unity compiles it automatically. It watches for file changes from CodeFox and calls `AssetDatabase.Refresh()` so Unity recompiles without you switching to it manually.

---

## How to use

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
- **Apply** — writes files to disk, triggers Unity refresh (if configured), saves a snapshot
- **Revert** — restores all modified files from the snapshot, triggers Unity refresh
- **Snapshot history** — last 5 snapshots shown in the left panel, each with a ↩ revert button

### Pages
After a plan executes, create a Page documenting what was done. The AI can draft it. Pages become permanent architecture docs you can reference in future chats.

---

## Settings

| Setting | Description |
|---|---|
| Ollama URL | Default: `http://localhost:11434` |
| Model name | Any model you've pulled via Ollama |
| Ollama executable path | Leave blank to auto-detect, or Browse to locate `ollama.exe` |
| Project path | Root folder of your project |
| Project context | One-line description injected into every system prompt (e.g. "a Unity 6 card game") |

---

## Architecture

```
main.js       Electron main process — DB, IPC, file system, Ollama process management
preload.js    Context bridge — exposes safe API to renderer
app.js        All UI logic — state, chat, plans, file tree, apply/revert
index.html    Three-column layout — left nav, center chat/editor, right file tree
```

Data is stored in SQLite via sql.js at:
- **Windows:** `%APPDATA%\codefox\codefox.db`
- **Mac/Linux:** `~/.config/codefox/codefox.db`

---

## Roadmap / Contributing

This is early software. Contributions welcome.

Ideas for the community to build on:
- [ ] Syntax-highlighted code blocks in chat
- [ ] Diff view before applying changes (show what changed line by line)
- [ ] Multi-file context injection (drag files into chat)
- [ ] Support for non-Ollama backends (LM Studio, llama.cpp)
- [ ] macOS / Linux Ollama path detection
- [ ] Plugin system for language-specific tooling
- [ ] Git integration (auto-commit after successful apply)
- [ ] Multiple project support

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

Output goes to the `dist/` folder.

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
