// mcp-presets.js — Curated MCP server presets (v0.5.3).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// this file directly with `node`. The renderer uses the same list
// through preload.js (`rb.mcpPresets`), so there is one source of
// truth for the presets.
//
// Six presets only, each genuinely useful for making a Unity game.
// This is NOT a marketplace and NOT a long list: nothing is here
// just because it exists. Every preset still needs its own app,
// token, addon, or plugin installed separately — the "Add" button
// in Settings → MCPs only adds the MCP *configuration* in one click
// (command, arguments, environment), it does not install Blender,
// Figma, Unity, or anything else. Each preset says what it needs
// in its `needs` list, and the UI shows that list on the card.
//
// The assistant does not call MCP tools yet — these settings are
// stored so that wiring can be added without reconfiguring.

const MCP_PRESETS = [
  {
    id: 'blender',
    name: 'Blender',
    tagline: 'Build and edit 3D models, scenes and materials in Blender.',
    description: 'Lets the assistant work with your Blender scenes — models, materials, and layout — instead of you describing a mesh in words. (The PyPI package was renamed mcp-for-blender, but `uvx blender-mcp` still works.)',
    command: 'uvx',
    args: ['blender-mcp'],
    env: {},
    needs: [
      'Blender 3.0+ installed',
      '`uv` installed (uvx on PATH)',
      'Blender MCP addon installed and enabled in Blender',
    ],
    setupSteps: [
      'Install uv, then run: uvx blender-mcp install-addon',
      'In Blender: Edit → Preferences → Add-ons → enable "Interface: MCP for Blender"',
      'In the 3D viewport (N panel → MCP for Blender) click Start MCP Server',
      'Add this preset in CodeFox — it connects to the server Blender is running',
    ],
    note: 'Needs Blender open with the MCP server started — CodeFox cannot start Blender for you.',
    requiresToken: null,
    requiresFolder: false,
  },
  {
    id: 'figma',
    name: 'Figma',
    tagline: 'Read Figma designs, export images, extract styles and tokens for UI.',
    description: 'Lets the assistant read your Figma files and pull out the layout, colours, and text it needs to build matching UI in Unity, instead of you retyping a design by hand.',
    command: 'npx',
    args: ['-y', 'figma-developer-mcp'],
    env: { FIGMA_API_KEY: '<token>' },
    needs: [
      'A Figma personal access token (starts figd_)',
      'Node.js installed (npx on PATH)',
    ],
    setupSteps: [
      'In Figma: Settings → Security → Personal access tokens → create one',
      'Paste the token into this preset — it is stored locally, never sent anywhere but Figma',
      'Add this preset in CodeFox',
    ],
    note: null,
    requiresToken: { envKey: 'FIGMA_API_KEY', label: 'Figma personal access token', placeholder: 'figd_…' },
    requiresFolder: false,
  },
  {
    id: 'unity',
    name: 'Unity (Coplay)',
    tagline: 'Control the Unity Editor directly — scenes, GameObjects, play mode.',
    description: 'Talks to the Unity Editor itself: inspect and change scenes, GameObjects, and play mode from the assistant. Maintained by Coplay — not official Unity software, and not affiliated with Unity Technologies.',
    command: 'uvx',
    args: ['--from', 'mcpforunityserver', 'mcp-for-unity', '--transport', 'stdio'],
    env: {},
    needs: [
      '`uv` installed (uvx on PATH)',
      'The Coplay Unity MCP plugin installed in your Unity project',
      'Unity open on that project',
    ],
    setupSteps: [
      'Install the Coplay Unity MCP plugin in your Unity project',
      'Open the project in Unity',
      'Add this preset in CodeFox',
    ],
    note: 'Overlaps with CodeFox\'s own bridge — this one talks to the Editor directly. The bridge stays the safer default for file changes; this is for live Editor control.',
    requiresToken: null,
    requiresFolder: false,
  },
  {
    id: 'github',
    name: 'GitHub',
    tagline: 'Read repos, issues and pull requests; the assistant can look up your code on GitHub.',
    description: 'Lets the assistant look at your repositories, issues, and pull requests on GitHub — useful when a fix depends on code or a discussion that lives there, not in the local project.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<token>' },
    needs: [
      'A GitHub personal access token with repo read access',
      'Node.js installed (npx on PATH)',
    ],
    setupSteps: [
      'On GitHub: Settings → Developer settings → Personal access tokens → create one with repo read access',
      'Paste the token into this preset — it is stored locally',
      'Add this preset in CodeFox',
    ],
    note: null,
    requiresToken: { envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token', placeholder: 'ghp_…' },
    requiresFolder: false,
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    tagline: 'Give the assistant read access to a folder outside the project (e.g. a shared assets folder).',
    description: 'Points the assistant at one extra folder outside the project — a shared assets library, a reference project, a folder of textures — so it can read files there without you copying them into the project.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '<folder>'],
    env: {},
    needs: [
      'A folder to share (defaults to the active project folder)',
      'Node.js installed (npx on PATH)',
    ],
    setupSteps: [
      'Pick the folder to share — the assistant can read files in it',
      'Add this preset in CodeFox',
    ],
    note: null,
    requiresToken: null,
    requiresFolder: true,
  },
  {
    id: 'git',
    name: 'Git',
    tagline: 'Read git history, branches and diffs for the project.',
    description: 'Lets the assistant read the project\'s git history — what changed, when, and on which branch — so it can answer "what broke this?" and "what did I change?" from the log instead of guessing.',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '<folder>'],
    env: {},
    needs: [
      '`uv` installed (uvx on PATH)',
      'The project is a git repository',
    ],
    setupSteps: [
      'Confirm the project folder is the git repository (it defaults to the active project)',
      'Add this preset in CodeFox',
    ],
    note: null,
    requiresToken: null,
    requiresFolder: true,
  },
];

function getPreset(id) {
  return MCP_PRESETS.find(p => p.id === id) || null;
}

// Build a server entry (the shape stored in the `mcp_servers`
// setting) from a preset plus the values the preset needs.
// `opts` is { token, folder }. Returns { ok, error, entry }.
// Refuses — never guesses — when a required token or folder is
// missing, so the UI can keep Install disabled until it is given.
// `args` is stored as the joined string the manual form uses.
function buildServerEntry(preset, opts) {
  const o = opts || {};
  if (!preset) return { ok: false, error: 'Unknown preset', entry: null };
  if (preset.requiresToken && !(o.token || '').trim()) {
    return { ok: false, error: preset.requiresToken.label + ' is required', entry: null };
  }
  if (preset.requiresFolder && !(o.folder || '').trim()) {
    return { ok: false, error: 'A folder is required', entry: null };
  }
  const env = {};
  for (const [k, v] of Object.entries(preset.env || {})) {
    env[k] = v === '<token>' ? (o.token || '').trim() : v;
  }
  const args = (preset.args || []).map(a => (a === '<folder>' ? (o.folder || '').trim() : a)).join(' ');
  return {
    ok: true,
    error: null,
    entry: {
      id: 'preset_' + preset.id,
      presetId: preset.id,
      name: preset.name,
      command: preset.command,
      args,
      env,
      enabled: true,
    },
  };
}

module.exports = { MCP_PRESETS, getPreset, buildServerEntry };
