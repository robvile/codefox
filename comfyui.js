// comfyui.js — Native ComfyUI provider helpers (v0.6.0, split in v0.17.0).
//
// Facade: the implementation lives in three files now —
//   comfyui-client.js — the thin HTTP client (/system_stats,
//     /object_info, /prompt, /queue, /history, /view,
//     /upload/image, /interrupt, /free)
//   comfyui-workflows.js — workflow graphs: parsing, the UI→API
//     converter, the simple form, capabilities, variation
//     planning, import profiles
//   comfyui-scan.js — finding ComfyUI Desktop on disk and
//     importing workflow files
// main.js and the smoke test keep requiring this file; everything
// is re-exported here so nothing else changes.
//
// This is a NATIVE provider, not an MCP server: CodeFox talks to a
// locally running ComfyUI instance over its own HTTP API.
// ComfyUI handles generation; CodeFox handles intelligence,
// orchestration, and getting the results into the project.
// Monitoring is by POLLING /queue + /history — there is no
// WebSocket client here, by design.
//
// No workflow is hardcoded into CodeFox. Workflows are the user's
// own JSON files (API-format graphs, or the UI-format graphs
// ComfyUI Desktop saves — converted to API format at import and
// submit time, see convertUiGraphToApi), imported from a folder the
// user picks, plus ComfyUI Desktop's built-in templates, which the
// scan finds on disk and imports labelled as built-ins. The
// catalogue stores the parsed definition (name, purpose, inputs,
// outputs, missing dependencies, approval) — never a sample
// workflow shipped as if it were the user's.

module.exports = {
  ...require('./comfyui-client'),
  ...require('./comfyui-workflows'),
  ...require('./comfyui-scan'),
};
