// mcp-presets.js — Curated MCP server presets (v0.6.0).
//
// Plain Node, no Electron dependency, so the smoke test can exercise
// this file directly with `node`. The renderer uses the same list
// through preload.js (`rb.mcpPresets`), so there is one source of
// truth for the presets.
//
// Ten presets only, each genuinely useful for making a Unity game.
// This is NOT a marketplace and NOT a long list: nothing is here
// just because it exists. Every preset still needs its own app,
// token, addon, or plugin installed separately — the "Add" button
// in Settings → MCPs opens a guided setup prompt (see the modal in
// app.js) instead of silently adding a server it cannot reach, and
// the inline token/folder inputs on the card stay as the quick path.
// Adding a preset only adds the MCP *configuration* (command,
// arguments, environment), it does not install Blender, Figma,
// Unity, or anything else. Each preset says what it needs in its
// `needs` list, and the UI shows that list on the card.
//
// `checkKind` names the real check the guided prompt runs for the
// preset: 'figma' / 'github' / 'notion' / 'atlassian' / 'trello'
// verify a token against the service's own API; 'blender' / 'uvx'
// check the prerequisite is installed on PATH; 'none' means there
// is no automatic check for that preset and the prompt says so.
// A failed check never blocks adding — the prompt also offers an
// "I have done the steps — add it anyway" checkbox — but a pass is
// never faked: the check result is what the service or the machine
// actually said.
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
      'Install Blender 3.0+ from blender.org, and install uv so `uvx` is on PATH',
      'Install the Blender MCP addon: run `uvx blender-mcp install-addon`',
      'In Blender: Edit → Preferences → Add-ons → enable "Interface: MCP for Blender"',
      'In the 3D viewport (N panel → MCP for Blender) click Start MCP Server',
      'Add this preset in CodeFox — it connects to the server Blender is running',
    ],
    helpUrl: 'https://www.blender.org/download/',
    note: 'Needs Blender open with the MCP server started — CodeFox cannot start Blender for you.',
    requiresToken: null,
    requiresFolder: false,
    checkKind: 'blender',
    checkLabel: 'Checks Blender and uvx are on PATH.',
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
    helpUrl: 'https://www.figma.com/settings',
    note: null,
    requiresToken: { envKey: 'FIGMA_API_KEY', label: 'Figma personal access token', placeholder: 'figd_…' },
    requiresFolder: false,
    checkKind: 'figma',
    checkLabel: 'Checks the token against the Figma API (GET /v1/me).',
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
    helpUrl: 'https://github.com/CoplayDev/unity-mcp',
    note: 'Overlaps with CodeFox\'s own bridge — this one talks to the Editor directly. The bridge stays the safer default for file changes; this is for live Editor control.',
    requiresToken: null,
    requiresFolder: false,
    checkKind: 'uvx',
    checkLabel: 'Checks uvx is on PATH. The Coplay plugin itself cannot be checked automatically.',
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
    helpUrl: 'https://github.com/settings/tokens',
    note: null,
    requiresToken: { envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub personal access token', placeholder: 'ghp_…' },
    requiresFolder: false,
    checkKind: 'github',
    checkLabel: 'Checks the token against the GitHub API (GET /user).',
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
    helpUrl: null,
    note: null,
    requiresToken: null,
    requiresFolder: true,
    checkKind: 'none',
    checkLabel: 'No automatic check for this one — follow the steps, then tick the box.',
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
    helpUrl: null,
    note: null,
    requiresToken: null,
    requiresFolder: true,
    checkKind: 'uvx',
    checkLabel: 'Checks uvx is on PATH. Whether the folder is a git repository is not checked automatically.',
  },
  {
    id: 'atlassian',
    name: 'Atlassian (Jira + Confluence)',
    tagline: 'Read Jira issues and Confluence pages; the assistant can work from your tickets.',
    description: 'Lets the assistant read your Jira issues (and Confluence pages, when you add the optional Confluence fields) — useful when a fix starts from a ticket, not a chat message.',
    command: 'uvx',
    args: ['mcp-atlassian'],
    env: { JIRA_URL: '<site>', JIRA_USERNAME: '<email>', JIRA_API_TOKEN: '<token>' },
    needs: [
      'A Jira Cloud site URL (e.g. https://your-team.atlassian.net)',
      'Your Atlassian account email',
      'An Atlassian API token',
      '`uv` installed (uvx on PATH)',
    ],
    setupSteps: [
      'Create an API token at id.atlassian.com → Security → API tokens',
      'Enter your Jira site URL, your Atlassian account email, and the token',
      'Optional: add the same three values for Confluence (CONFLUENCE_URL, CONFLUENCE_USERNAME, CONFLUENCE_API_TOKEN) after adding the server, if you also want Confluence pages',
      'Add this preset in CodeFox',
    ],
    helpUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    note: 'Uses the maintained mcp-atlassian server package. Confluence is optional — Jira works on its own.',
    requiresToken: null,
    requiresFolder: false,
    requiresFields: [
      { key: 'site', label: 'Jira site URL', placeholder: 'https://your-team.atlassian.net' },
      { key: 'email', label: 'Atlassian account email', placeholder: 'you@example.com' },
      { key: 'token', label: 'Atlassian API token', placeholder: 'ATATT…', password: true },
    ],
    checkKind: 'atlassian',
    checkLabel: 'Checks the site, email and token against the Jira API (GET /rest/api/3/myself).',
  },
  {
    id: 'notion',
    name: 'Notion',
    tagline: 'Read Notion pages and databases the assistant needs for docs and plans.',
    description: 'Lets the assistant read the Notion pages you give it access to — design docs, specs, and notes — instead of you copying them into chat.',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: { NOTION_TOKEN: '<token>' },
    needs: [
      'A Notion Personal Access Token (starts ntn_)',
      'Node.js installed (npx on PATH)',
    ],
    setupSteps: [
      'In Notion: create a Personal Access Token (an integration token starting ntn_)',
      'Give that integration access to the pages you want CodeFox to read — in Notion, open a page → ⋯ → Add connections → pick the integration. A token alone sees nothing until a page is shared with it',
      'Paste the token into this preset — it is stored locally',
      'Add this preset in CodeFox',
    ],
    helpUrl: 'https://www.notion.so/my-account/integrations',
    note: 'The integration must be given access to each page — a token alone cannot see your workspace.',
    requiresToken: { envKey: 'NOTION_TOKEN', label: 'Notion integration token', placeholder: 'ntn_…' },
    requiresFolder: false,
    checkKind: 'notion',
    checkLabel: 'Checks the token against the Notion API (GET /v1/users/me).',
  },
  {
    id: 'trello',
    name: 'Trello',
    tagline: 'Read Trello boards, lists and cards; the assistant can work from your board.',
    description: 'Lets the assistant read your Trello boards, lists, and cards — useful when a task starts as a card, not a chat message.',
    command: 'npx',
    args: ['-y', '@delorenj/mcp-server-trello'],
    env: { TRELLO_API_KEY: '<apiKey>', TRELLO_TOKEN: '<token>' },
    needs: [
      'A Trello API key and a Trello token (two credentials, both from the same page)',
      'Node.js installed (npx on PATH)',
    ],
    setupSteps: [
      'Open trello.com/app-key — copy your API key, then generate a token from the same page',
      'Paste both into this preset — they are stored locally',
      'Add this preset in CodeFox',
    ],
    helpUrl: 'https://trello.com/app-key',
    note: 'Two credentials are needed: the API key and the token. Both come from the same page.',
    requiresToken: null,
    requiresFolder: false,
    requiresFields: [
      { key: 'apiKey', label: 'Trello API key', placeholder: 'Paste the API key from trello.com/app-key' },
      { key: 'token', label: 'Trello token', placeholder: 'Paste the token generated on the same page', password: true },
    ],
    checkKind: 'trello',
    checkLabel: 'Checks the API key and token against the Trello API (GET /1/members/me).',
  },
  {
    id: 'perforce',
    name: 'Perforce (P4)',
    tagline: 'Read a Perforce depot — files, changelists and history — read-only by default.',
    description: 'Lets the assistant read files, changelists, and history from a Perforce depot. Read-only by default, so it can look but never submit a change.',
    command: 'uvx',
    args: ['p4mcp-server', '--readonly'],
    env: {},
    needs: [
      'A Perforce server you can reach, with a valid P4 login',
      '`uv` installed (uvx on PATH)',
      'P4 connection details in your .p4config file, or P4PORT / P4USER set in your environment',
    ],
    setupSteps: [
      'Make sure you can connect to your P4 server from this machine (e.g. `p4 info` works, and you are logged in)',
      'Check your .p4config file (or P4PORT / P4USER) points at the right server and user',
      'Add this preset in CodeFox — it runs read-only, so it cannot submit anything',
    ],
    helpUrl: 'https://www.perforce.com/downloads/helix-core-p4-command-line-client',
    note: 'Read-only by default (--readonly). The P4 connection comes from your own .p4config / environment, not from CodeFox.',
    requiresToken: null,
    requiresFolder: false,
    checkKind: 'none',
    checkLabel: 'No automatic check for this one — follow the steps, then tick the box.',
  },
];

function getPreset(id) {
  return MCP_PRESETS.find(p => p.id === id) || null;
}

// Build a server entry (the shape stored in the `mcp_servers`
// setting) from a preset plus the values the preset needs.
// `opts` is { token, folder, fields: { site, email, apiKey, ... } }.
// Returns { ok, error, entry }.
// Refuses — never guesses — when a required token, field, or folder
// is missing, so the UI can keep Install disabled until it is given.
// `args` is stored as the joined string the manual form uses.
// Env placeholders are substituted from the matching value:
// '<token>' from opts.token (or fields.token), '<site>' from
// fields.site, '<email>' from fields.email, '<apiKey>' from
// fields.apiKey.
function buildServerEntry(preset, opts) {
  const o = opts || {};
  const fields = o.fields || {};
  if (!preset) return { ok: false, error: 'Unknown preset', entry: null };
  if (preset.requiresToken && !(o.token || fields.token || '').trim()) {
    return { ok: false, error: preset.requiresToken.label + ' is required', entry: null };
  }
  for (const f of (preset.requiresFields || [])) {
    const v = f.key === 'token' ? (o.token || fields.token || '') : (fields[f.key] || '');
    if (!String(v).trim()) return { ok: false, error: f.label + ' is required', entry: null };
  }
  if (preset.requiresFolder && !(o.folder || '').trim()) {
    return { ok: false, error: 'A folder is required', entry: null };
  }
  const valueFor = (placeholder) => {
    if (placeholder === '<token>') return (o.token || fields.token || '').trim();
    if (placeholder === '<site>') return (fields.site || '').trim();
    if (placeholder === '<email>') return (fields.email || '').trim();
    if (placeholder === '<apiKey>') return (fields.apiKey || '').trim();
    return placeholder;
  };
  const env = {};
  for (const [k, v] of Object.entries(preset.env || {})) {
    env[k] = valueFor(v);
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
