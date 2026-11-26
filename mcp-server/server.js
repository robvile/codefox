// mcp-server/server.js — the CodeFox MCP server (v0.21.0).
//
// A standalone stdio MCP server (JSON-RPC 2.0, newline-delimited)
// that exposes CodeFox's read tools to external MCP clients —
// another agent, an editor, or a script — without running the app.
//
//   node mcp-server/server.js --project <path> [--data-dir <dir>]
//
// The project path is where file / git / Unity tools run; the data
// dir is CodeFox's user-data folder (where the Unity docs index
// lives). Both are shown by the app in Settings → MCPs, so the user
// copies the exact command.
//
// Approval model (the parent decision for this build): mutating and
// destructive tools are DENIED BY DEFAULT. They are listed so a
// client can see they exist, but calling one returns a plain error
// saying approval is required in the CodeFox app. Read-only tools
// run for real. The blocking approval queue — the server waiting
// while the app shows an approval card — is a documented follow-up,
// NOT this build.
//
// This process is plain Node. It never touches Electron, and nothing
// it prints on stdout is a log line: stdout is the protocol. Logs
// go to stderr only.

'use strict';

var fs = require('fs');
var path = require('path');
var readline = require('readline');
var childProcess = require('child_process');

var DocsEngine = require('../docs-engine');
var fileTools = require('../file-tools');
var gitBackup = require('../git-backup');
var unityCommand = require('../unity-command');

var SERVER_INFO = {
  name: 'codefox',
  version: '0.21.0',
  protocolVersion: '2024-11-05',
};

var APPROVAL_REQUIRED =
  'Denied: this tool changes files, runs a Unity write, or starts a generation, and the CodeFox MCP server ' +
  'denies mutating tools by default. Run the action in the CodeFox app, where it goes through the approval flow. ' +
  'A blocking approval queue (the server waiting while the app shows an approval card) is a planned follow-up, not yet built.';

// Unity bridge actions that only read. Everything else the bridge
// offers is a write and is denied through this server.
var READ_UNITY_ACTIONS = {
  listComponentTypes: true,
  describeComponent: true,
  readConsole: true,
  read_component_values: true,
  list_hierarchy: true,
  list_assets: true,
};

function classifyUnityAction(action) {
  if (READ_UNITY_ACTIONS[action]) return 'read';
  return 'mutating';
}

var TOOLS = [
  {
    name: 'docs_search',
    kind: 'read',
    description: 'Search the local Unity ScriptReference index (downloaded offline docs). Returns matching API pages with a snippet. If no index is downloaded yet, the error says so — the download happens in the CodeFox app, Settings → Model → Unity docs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up, e.g. "Transform.TransformPoint" or "rigidbody velocity".' },
        maxResults: { type: 'integer', description: 'How many results (1-20, default 5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'file_view',
    kind: 'read',
    description: 'Read a file in the project, optionally a line range. Paths are relative to the project folder and cannot escape it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        start: { type: 'integer', description: 'First line (1-based, default 1).' },
        end: { type: 'integer', description: 'Last line (default: the end of the view window).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_grep',
    kind: 'read',
    description: 'Search a plain-text substring across the project (case-insensitive, not a regex).',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text to search for.' },
        path: { type: 'string', description: 'Optional project-relative file or folder to search inside.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'git_status',
    kind: 'read',
    description: 'git status of the project (porcelain): branch, HEAD, staged / modified / untracked / deleted / renamed files, and whether the tree is clean.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    kind: 'read',
    description: 'git diff of the project working tree (truncated). Pass ref to diff against a commit instead.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Optional commit or ref to diff against.' },
        nameStatus: { type: 'boolean', description: 'If true, return file names and statuses instead of the patch.' },
      },
    },
  },
  {
    name: 'git_log',
    kind: 'read',
    description: 'Recent commits in the project (up to 50).',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'How many commits (default 10).' },
      },
    },
  },
  {
    name: 'unity_command',
    kind: 'gated',
    description: 'Run one Unity bridge command in the project. READ actions (listComponentTypes, describeComponent, readConsole, read_component_values, list_hierarchy, list_assets) run; every write action is denied by default — it needs approval in the CodeFox app.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'The bridge action, e.g. list_hierarchy.' },
        args: { type: 'object', description: 'Action arguments (the same shape the app sends).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'file_str_replace',
    kind: 'mutating',
    description: 'Surgically replace one exact chunk of text in a project file. DENIED through this server — file edits need approval in the CodeFox app.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        oldText: { type: 'string', description: 'The exact text to replace (must match exactly once).' },
        newText: { type: 'string', description: 'The replacement text.' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'comfyui_generate',
    kind: 'mutating',
    description: 'Start a ComfyUI generation. DENIED through this server — generations need approval in the CodeFox app.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name.' },
        prompt: { type: 'string', description: 'Generation prompt.' },
      },
      required: ['workflow', 'prompt'],
    },
  },
];

function toolByName(name) {
  for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].name === name) return TOOLS[i];
  return null;
}

// ── Engine wiring (plain-Node runners, no Electron) ──────────────

function runProcess(cmd, args, opts, timeoutMs) {
  return new Promise(function (resolve) {
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      try { proc.kill(); } catch (e) {}
    }, timeoutMs || 30000);
    var proc = childProcess.execFile(cmd, args, opts || {}, function (err, stdout, stderr) {
      clearTimeout(timer);
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: timedOut,
      });
    });
  });
}

function whereProcess(cmd) {
  return new Promise(function (resolve) {
    childProcess.execFile(cmd, ['--version'], function (err) {
      resolve(err ? { found: false, path: null } : { found: true, path: cmd });
    });
  });
}

function createContext(opts) {
  var o = opts || {};
  return {
    project: o.project || '',
    dataDir: o.dataDir || DocsEngine.resolveUserDataDir(),
    fileEngine: fileTools.createFileEngine({ fs: fs, path: path }),
    gitEngine: gitBackup.createEngine({
      run: runProcess,
      where: whereProcess,
      fs: fs,
      path: path,
      getGitExePath: function () { return ''; },
    }),
  };
}

// ── Dispatch ─────────────────────────────────────────────────────
//
// Returns {content: [{type: 'text', text}], isError}. A denied
// mutating tool returns isError: true with the approval message —
// never a silent success, never a fake execution.

async function dispatch(toolName, args, ctx) {
  var tool = toolByName(toolName);
  var a = args || {};
  if (!tool) return { content: [{ type: 'text', text: 'Unknown tool: ' + toolName }], isError: true };
  if (tool.kind === 'mutating') {
    return { content: [{ type: 'text', text: APPROVAL_REQUIRED }], isError: true };
  }
  try {
    if (toolName === 'docs_search') {
      var res = DocsEngine.searchDocs(ctx.dataDir, a.query, a.maxResults);
      if (!res.ok) return { content: [{ type: 'text', text: res.error }], isError: true };
      if (!res.results.length) return { content: [{ type: 'text', text: 'No Unity docs pages matched "' + a.query + '" (index v' + res.version + ', ' + res.pageCount + ' pages).' }], isError: false };
      var lines = ['Unity docs (v' + res.version + ', ' + res.pageCount + ' pages):'];
      res.results.forEach(function (r, i) {
        lines.push((i + 1) + '. ' + r.title + ' — ' + r.snippet);
      });
      return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
    }
    if (!ctx.project) {
      return { content: [{ type: 'text', text: 'No project set — start the server with --project <path>.' }], isError: true };
    }
    if (toolName === 'file_view') {
      var v = ctx.fileEngine.view({ projectPath: ctx.project, path: a.path, start: a.start, end: a.end });
      if (!v.ok) return { content: [{ type: 'text', text: v.error }], isError: true };
      var text = v.lines.map(function (l) { return l.n + ': ' + l.text; }).join('\n');
      return { content: [{ type: 'text', text: v.path + ' (lines ' + v.start + '-' + v.end + ' of ' + v.totalLines + '):\n' + text }], isError: false };
    }
    if (toolName === 'file_grep') {
      var g = ctx.fileEngine.grep({ projectPath: ctx.project, pattern: a.pattern, path: a.path });
      if (!g.ok) return { content: [{ type: 'text', text: g.error }], isError: true };
      if (!g.matches.length) return { content: [{ type: 'text', text: 'No matches for "' + a.pattern + '" in ' + g.filesSearched + ' file(s).' }], isError: false };
      var out = g.matches.map(function (m) { return m.file + ':' + m.line + ': ' + m.text; }).join('\n');
      return { content: [{ type: 'text', text: out + (g.truncated ? '\n(truncated)' : '') }], isError: false };
    }
    if (toolName === 'git_status') {
      var st = await ctx.gitEngine.status(ctx.project);
      return { content: [{ type: 'text', text: JSON.stringify(st, null, 2) }], isError: !st.ok };
    }
    if (toolName === 'git_diff') {
      var d = await ctx.gitEngine.diff(ctx.project, { ref: a.ref || '', nameStatus: !!a.nameStatus });
      return { content: [{ type: 'text', text: JSON.stringify(d, null, 2) }], isError: !d.ok };
    }
    if (toolName === 'git_log') {
      var l = await ctx.gitEngine.log(ctx.project, a.count);
      return { content: [{ type: 'text', text: JSON.stringify(l, null, 2) }], isError: !l.ok };
    }
    if (toolName === 'unity_command') {
      var action = String(a.action || '');
      if (classifyUnityAction(action) !== 'read') {
        return { content: [{ type: 'text', text: APPROVAL_REQUIRED + ' (action "' + action + '" is a write.)' }], isError: true };
      }
      var cmd = Object.assign({}, a.args || {}, { action: action });
      var r = await unityCommand.runUnityCommand(ctx.project, cmd);
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: !r.ok };
    }
    return { content: [{ type: 'text', text: 'Tool not implemented: ' + toolName }], isError: true };
  } catch (e) {
    return { content: [{ type: 'text', text: 'Tool failed: ' + String(e && e.message || e) }], isError: true };
  }
}

// ── JSON-RPC over stdio ───────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// A client that closes the pipe mid-response is a normal
// disconnect, not a crash — exit quietly instead of throwing an
// unhandled EPIPE.
process.stdout.on('error', function (e) {
  if (e && e.code === 'EPIPE') process.exit(0);
  throw e;
});

function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object') return Promise.resolve();
  // Notifications (no id) get no reply.
  var isRequest = msg.id !== undefined && msg.id !== null;
  if (msg.method === 'initialize') {
    if (isRequest) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: SERVER_INFO.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
        },
      });
    }
    return Promise.resolve();
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled' || msg.method === 'notifications/exit') {
    if (msg.method === 'notifications/exit') process.exit(0);
    return Promise.resolve();
  }
  if (msg.method === 'ping') {
    if (isRequest) send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return Promise.resolve();
  }
  if (msg.method === 'tools/list') {
    if (isRequest) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: TOOLS.map(function (t) {
            return { name: t.name, description: t.description, inputSchema: t.inputSchema };
          }),
        },
      });
    }
    return Promise.resolve();
  }
  if (msg.method === 'tools/call') {
    if (!isRequest) return Promise.resolve();
    var params = msg.params || {};
    return dispatch(params.name, params.arguments || {}, ctx).then(function (res) {
      send({ jsonrpc: '2.0', id: msg.id, result: res });
    });
  }
  if (isRequest) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
  }
  return Promise.resolve();
}

function parseArgs(argv) {
  var out = { project: '', dataDir: '' };
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === '--project' && argv[i + 1]) out.project = argv[++i];
    else if (argv[i] === '--data-dir' && argv[i + 1]) out.dataDir = argv[++i];
  }
  return out;
}

function main() {
  var args = parseArgs(process.argv);
  var ctx = createContext({ project: args.project, dataDir: args.dataDir || DocsEngine.resolveUserDataDir() });
  var rl = readline.createInterface({ input: process.stdin, terminal: false });
  var queue = Promise.resolve();
  rl.on('line', function (line) {
    if (!line.trim()) return;
    var msg;
    try { msg = JSON.parse(line); } catch (e) {
      process.stderr.write('codefox-mcp: bad JSON on stdin: ' + String(e && e.message || e) + '\n');
      return;
    }
    queue = queue.then(function () { return handleMessage(msg, ctx); }).catch(function (e) {
      process.stderr.write('codefox-mcp: ' + String(e && e.message || e) + '\n');
    });
  });
  rl.on('close', function () { process.exit(0); });
}

if (require.main === module) main();

module.exports = {
  SERVER_INFO: SERVER_INFO,
  TOOLS: TOOLS,
  APPROVAL_REQUIRED: APPROVAL_REQUIRED,
  READ_UNITY_ACTIONS: READ_UNITY_ACTIONS,
  classifyUnityAction: classifyUnityAction,
  createContext: createContext,
  dispatch: dispatch,
  handleMessage: handleMessage,
  parseArgs: parseArgs,
};
