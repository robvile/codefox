// skill-files.js — file-based skills (v0.13.0).
//
// A skill is a folder of markdown files: a SKILL.md (the procedure
// + rules) plus reference files it points to. The app only ever
// carries each skill's name and one-line description in the system
// prompt; the full SKILL.md is read by the model with the file
// tools (view) when a task matches, and referenced files after
// that. Nothing here loads a skill's content into a prompt by
// itself — the /skill override in app.js is the one exception, and
// it only runs when the user types it.
//
// Skills are opt-in, per project, like plugins:
//   - built-in skills ship in the repo under skills/<name>/
//   - user skills live in the app's user-data folder under skills/
//   - a skill only does anything in a project once it is installed
//     there (copied to <project>/.codefox/skills/<name>/) AND
//     enabled for that project (project_skills table in main.js).
// Enabling/disabling never deletes files; a disabled skill is
// simply not listed in the prompt. The user can open SKILL.md and
// read exactly what a skill tells the model before enabling it.
//
// Plain Node, no Electron dependency, so the smoke test can
// exercise this file directly with `node` (like file-tools.js and
// log-triage.js). The renderer carries inline mirrors of
// parseSkillCommand and buildSkillsPromptSection (it cannot require
// this file — the same reason unity-assets.js, file-tools.js and
// log-triage.js have inline mirrors); the smoke test pins the two
// copies to agree.

// Skills live in the project under this folder (project-relative).
// It sits outside Assets, so Unity never imports the markdown.
const SKILLS_PROJECT_DIR = '.codefox/skills';

// Warn when more than this many skills are enabled at once:
// routing gets worse with more candidates, and every enabled
// skill costs prompt tokens on every turn.
const SKILLS_MANY_ENABLED_WARN_AT = 5;

// Rough token estimate for a prompt: ~4 characters per token.
const CHARS_PER_TOKEN = 4;

// A skill name is a folder name: lowercase letters, digits and
// dashes, starting with a letter or digit. Anything else is
// refused — a name is used to build file paths, so it must never
// contain a separator, a dot, or whitespace.
function isSafeSkillName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name);
}

function normalizeSkillName(name) {
  return String(name || '').trim().toLowerCase();
}

// Project-relative path of a skill's SKILL.md — the path the model
// is told to read with view.
function skillProjectRelPath(name) {
  return SKILLS_PROJECT_DIR + '/' + name + '/SKILL.md';
}

// Parse the frontmatter at the top of a SKILL.md:
//   ---
//   name: unity-multiplayer-networking
//   description: Use when ...
//   ---
// Returns { name, description } with nulls for missing keys, or
// null when there is no frontmatter block at all. Only `name:` and
// `description:` are read; anything else in the block is ignored.
function parseSkillFrontmatter(content) {
  const text = String(content || '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const out = { name: null, description: null };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*(name|description)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    let value = kv[2];
    // Strip one layer of matching quotes, if present.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[kv[1]] = value;
  }
  return out;
}

// Describe one skill folder from its SKILL.md content. Frontmatter
// wins; without it, the name comes from the folder and the
// description from the first non-heading paragraph. Returns null
// when there is no usable description — a skill with no
// description cannot be routed on, so it is not discoverable.
function describeSkillFile(content, folderName) {
  const text = String(content || '');
  const fm = parseSkillFrontmatter(text);
  let name = fm && fm.name ? fm.name : null;
  let description = fm && fm.description ? fm.description : null;
  if (!name) name = normalizeSkillName(folderName);
  if (!description) {
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      description = trimmed;
      break;
    }
  }
  if (!name || !isSafeSkillName(name) || !description) return null;
  return { name, description };
}

// Discover skills in a list of roots: [{ source, dir }] where
// source is 'builtin', 'user' or 'project'. Each root is scanned
// for subfolders containing a SKILL.md. The first root wins on a
// name clash (scan builtin first, then user, then project — a
// project copy is the same skill installed, so it replaces the
// builtin entry rather than duplicating it; see mergeScans).
// `fs` and `path` are injected so the smoke test can stub them;
// pass the real ones in main.js. Returns
// { skills: [{ name, description, source, dir, skillPath }],
//   skipped: [{ name, source, reason }] }.
function discoverSkills(fs, path, roots) {
  const skills = [];
  const skipped = [];
  const seen = new Set();
  for (const root of (roots || [])) {
    let entries = [];
    try { entries = fs.readdirSync(root.dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folderName = entry.name;
      const skillDir = path.join(root.dir, folderName);
      const skillPath = path.join(skillDir, 'SKILL.md');
      let content = null;
      try { content = fs.readFileSync(skillPath, 'utf8'); } catch { content = null; }
      if (content == null) { skipped.push({ name: folderName, source: root.source, reason: 'no SKILL.md' }); continue; }
      const described = describeSkillFile(content, folderName);
      if (!described) { skipped.push({ name: folderName, source: root.source, reason: 'no usable name/description' }); continue; }
      if (seen.has(described.name)) { skipped.push({ name: described.name, source: root.source, reason: 'duplicate name — first root wins' }); continue; }
      seen.add(described.name);
      skills.push({ name: described.name, description: described.description, source: root.source, dir: skillDir, skillPath });
    }
  }
  return { skills, skipped };
}

// Rough token cost of carrying a list of enabled skill
// descriptions in every prompt. Only the one-line descriptions
// count here — the full SKILL.md is never in the prompt until the
// model (or /skill) loads it.
function estimateSkillPromptTokens(skills) {
  const chars = (skills || []).reduce((n, s) => n + String(s.name || '').length + 3 + String(s.description || '').length + 1, 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// The ## Skills section of the system prompt, for the enabled
// skills of the active project. Empty string when none are
// enabled — an empty section would just cost tokens. Each line
// gives the model the description to route on and the exact path
// to read when a task matches. The precedence paragraph is the
// point of the whole section: Project Rules are universal
// conventions and always win; a skill is a specialized workflow
// that never overrides a rule.
function buildSkillsPromptSection(skills) {
  const enabled = (skills || []).filter(s => s && s.name && s.description);
  if (!enabled.length) return '';
  let section = '## Skills\n';
  section += 'Skills are instruction files the user opted into for this project — specialized workflows, loaded on demand. Only the skills below are enabled; do not load any other skill, and do not go looking for skills outside this list.\n';
  for (const s of enabled) {
    section += '- ' + s.name + ' — ' + s.description + ' (read ' + (s.relPath || skillProjectRelPath(s.name)) + ' with view when a task matches)\n';
  }
  section += 'Project Rules always win: if a skill\'s instruction conflicts with a Project Rule, follow the rule and say so. A skill never overrides a rule.\n';
  section += 'When the user\'s task matches a skill\'s description, read that skill\'s SKILL.md first with the file tools (view), then read the reference files it points to as needed. Do not read a skill\'s full content when the task does not match it — the list above is all you carry until then.\n';
  return section;
}

// Parse a /skill chat command. The command must be the first
// non-blank line: "/skill <name>" optionally followed by the task
// on the following lines. Returns { name, rest } (rest is the
// message with the command line removed, trimmed — empty when the
// command was the whole message), or null when the message does
// not start with /skill. The name is normalized to lowercase; a
// bare "/skill" with no name returns { name: '', rest } so the
// caller can show the list instead of calling the model.
function parseSkillCommand(text) {
  const lines = String(text || '').split(/\r?\n/);
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) { firstIdx = i; break; }
  }
  if (firstIdx === -1) return null;
  const m = lines[firstIdx].trim().match(/^\/skill(?:\s+([A-Za-z0-9][A-Za-z0-9-]*))?\s*$/);
  if (!m) return null;
  const rest = lines.slice(firstIdx + 1).join('\n').trim();
  return { name: m[1] ? m[1].toLowerCase() : '', rest };
}

module.exports = {
  SKILLS_PROJECT_DIR,
  SKILLS_MANY_ENABLED_WARN_AT,
  CHARS_PER_TOKEN,
  isSafeSkillName,
  normalizeSkillName,
  skillProjectRelPath,
  parseSkillFrontmatter,
  describeSkillFile,
  discoverSkills,
  estimateSkillPromptTokens,
  buildSkillsPromptSection,
  parseSkillCommand,
};
