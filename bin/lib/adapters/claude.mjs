// adapters/claude.mjs — the core adapter of the `claude` harness: Claude Code in print mode (`claude -p
// --output-format json`) on the user's claude.ai login, on an API key against an Anthropic-compatible endpoint, or
// keyless on a local server (docs/superpowers/specs/2026-10-20-universal-dispatchers-design.md §3.2, §3.4–§3.8). The
// harness facts come from docs/research/universal-dispatchers/01-claude-code-headless.md, cited [01 §n] and [01 E<n>]
// for its experiments.
//
// Auth modes (spec §3.4, §3.6 A1–A2):
//   login — the user's config dir ($CLAUDE_CONFIG_DIR as inherited, else ~/.claude; "home": "isolated" uses
//           homes/<p>/claude instead, where the user logs in through `agent-dispatch profile env <p> -- claude`),
//           `--setting-sources user`, every inherited ANTHROPIC_* removed; a settings.json in that dir, or the profile's
//           options.settings, that would take the run off the login (a key, an apiKeyHelper, an endpoint, a cloud
//           provider, a CLAUDE_CODE_OAUTH_TOKEN) refuses the profile (loginOverrides);
//   key   — homes/<p>/claude, never a claude.ai login, `--setting-sources ""`, exactly one key variable: ANTHROPIC_AUTH_TOKEN
//           (Bearer) or, with "authHeader": "x-api-key", ANTHROPIC_API_KEY; the other one is "" [01 §6, gotcha 2].
//           ANTHROPIC_BASE_URL is the profile's endpoint (none: the Anthropic API itself);
//   none  — like key without a key: ANTHROPIC_API_KEY=local-dummy for a local server [08 §5]; needs an endpoint.
// In every mode CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 keeps the key out of the model's Bash [01 E13], and
// CLAUDE_CODE_ENTRYPOINT / CLAUDECODE are removed [01 E23].
//
// Per job the adapter writes <job>/settings.json, the --settings overlay (the §3.6 Б settings, then options.settings,
// then group A again — for a reviewer also deny rules for the git options that write or run programs, the allow rules
// past its four git commands, dropped from the overlay or, from a login profile's user settings, denied, and no
// sandbox auto-allow), and <job>/system.md, the headless preamble
// plus the project's CLAUDE.md, passed with one --append-system-prompt-file (§3.6 A6). The overlay lives in the job
// dir, not in homes/<p>/settings.json as §3.6 A1 sketches: its content depends on the role, the sandbox and the
// profile snapshot, and parallel jobs of one profile would race on a shared file. The prompt goes on stdin; its 10 MB
// cap is claude's own (§3.6 A3: no pre-check here).

import os from "node:os";
import path from "node:path";
import { buildEnv, UsageError } from "../agent-core.mjs";

const KEY_VARS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
// Local servers accept any key [08 §5]; this value is never a credential.
const LOCAL_DUMMY = "local-dummy";
// What doctor puts into the key variable for `claude auth status`: the real key is never resolved for a check.
const DOCTOR_PLACEHOLDER = "agent-dispatch-doctor-placeholder";
// Alias variables pinned to an API profile's model, so no claude-* id reaches the provider [01 §5; spec §3.6 Б].
const ALIASES = ["OPUS", "SONNET", "HAIKU", "FABLE"];
const WRITER_TOOLS = "Bash,Read,Edit,Write,Glob,Grep";
const REVIEWER_TOOLS = "Read,Glob,Grep,Bash";
// The only commands a reviewer runs (spec §3.6 A4).
const REVIEWER_GIT = ["git show", "git diff", "git log", "git status"];
const REVIEWER_ALLOWED = REVIEWER_GIT.map((command) => `Bash(${command}:*)`);
// The allow rules are prefixes: they also take the options of those commands that write files or run programs, so a
// reviewer's overlay denies them. A deny rule wins over an allow rule from any source, and `*` matches any text, also
// inside a rule (Claude Code permission docs; not an experiment in [01]). git takes these options only as written (no
// abbreviation; --output as `--output=<f>` or `--output <f>`; git 2.50), so each rule covers every spelling git
// accepts. A quoted or escaped one (`--out''put=f`) passes: the rules match the command's text.
const REVIEWER_DENY = [
  "Bash(git *--output*)", // writes the diff to a file (show, diff, log, diff-tree)
  "Bash(git *--ext-diff*)", // runs the external diff program of the git config
  "Bash(git *--textconv*)", // runs the textconv filters of the git config
  "Bash(git *--no-index*)", // diffs any two files of the machine, outside the repository
  "Bash(git difftool*)", // `git diff:*` read as a plain prefix would take it; --extcmd runs any command
];
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Environment names the adapter owns in every mode; options.settings.env cannot set them (group A).
const OWNED_ENV = ["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", ...KEY_VARS, "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"];
const SANDBOX_OWNED = ["enabled", "failIfUnavailable", "allowUnsandboxedCommands", "autoAllowBashIfSandboxed"];
// What takes a login profile's runs off the claude.ai login when its config dir's settings.json sets it (spec §3.6
// A2): claude puts a cloud provider, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, an apiKeyHelper and
// CLAUDE_CODE_OAUTH_TOKEN (a `claude setup-token` subscription token, perhaps of another account) before the /login
// subscription, and ANTHROPIC_BASE_URL sends the login's token to another endpoint [01 §6]. `--setting-sources user`
// applies that file's env and apiKeyHelper [01 §9, E18], past the removal of the inherited ANTHROPIC_* (planOf). The
// profile's own options.settings, carried by the --settings overlay, is checked the same way (ownLoginConflict).
const LOGIN_OVERRIDES = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_OAUTH_TOKEN"];
// The cloud provider variables are switches, on for 1, true, yes or on in any case: "0", "false" or "" keep the login
// (Claude Code's reading of boolean variables; not an experiment in [01]). Every other name counts when non-empty.
const CLOUD_SWITCHES = new Set(["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]);
const SWITCH_ON = ["1", "true", "yes", "on"];
// ANTHROPIC_CUSTOM_HEADERS adds "Name: value" lines to every request [01 §5]; an Authorization or x-api-key line is a
// credential as well.
const AUTH_HEADER_RE = /^\s*(authorization|x-api-key)\s*:/im;
// authMethod values of `claude auth status --json` for a key, not a claude.ai login: api_key (ANTHROPIC_API_KEY, spec
// §3.6 A1), api_key_helper [01 E20]. oauth_token is ANTHROPIC_AUTH_TOKEN [01 E20], perhaps also a CLAUDE_CODE_OAUTH_TOKEN
// of `claude setup-token` (a subscription token; not recorded in [01]): doctor warns on it.
const KEY_METHODS = ["api_key", "api_key_helper"];
// The project instructions claude itself loads only with the `project` setting source [01 §9, E17].
const PROJECT_FILES = ["CLAUDE.md", path.join(".claude", "CLAUDE.md")];
// A 429 is a quota only by the provider's words [01 §11]; otherwise it is a rate limit.
const QUOTA_TEXT = [/usage limit/i, /quota/i, /balance/i, /credit/i, /billing/i, /spend(ing)? limit/i, /\b(daily|weekly|monthly) limit\b/i];

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" && value !== "" ? value : null);

// ---------- profile → mode, config dir ----------

function authOf(profile) {
  const auth = profile?.auth ?? "login";
  if (auth === "login") return { mode: "login", keyVar: null };
  if (auth === "none") return { mode: "none", keyVar: "ANTHROPIC_API_KEY" };
  if (isObject(auth)) return { mode: "key", keyVar: profile.authHeader === "x-api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN" };
  throw new Error(`claude: auth ${JSON.stringify(auth)} is not supported ("login", "none" or a key)`);
}

const otherKeyVar = (keyVar) => KEY_VARS.find((name) => name !== keyVar);
// Only a login profile may use the user's own config dir; an API profile always gets its isolated one (§3.6 A1).
const usesUserDir = (profile) => authOf(profile).mode === "login" && profile?.home !== "isolated";

// The CLAUDE_CONFIG_DIR of a run. For the user's dir it is never set explicitly to ~/.claude: the macOS Keychain entry
// of the login is keyed to the dir as claude sees it [01 §6].
function configDirOf(profile, ctx, profileName = ctx.profileName) {
  if (usesUserDir(profile)) return path.resolve(text(ctx.env.CLAUDE_CONFIG_DIR) ?? path.join(text(ctx.env.HOME) ?? os.homedir(), ".claude"));
  if (!profileName) throw new Error("claude: a profile name is needed for the isolated config dir");
  return path.join(ctx.paths.homes, profileName, "claude");
}

function prepareHome(profile, ctx) {
  if (usesUserDir(profile)) return { env: { CLAUDE_CONFIG_DIR: text(ctx.env.CLAUDE_CONFIG_DIR) } };
  const dir = configDirOf(profile, ctx);
  return { env: { CLAUDE_CONFIG_DIR: dir }, dirs: [ctx.paths.homes, path.dirname(dir), dir] };
}

// ---------- allow rules that widen a reviewer ----------

// An allow rule pre-approves a call, so dontAsk lets it through: a rule for more than the four git commands widens a
// reviewer past read-only (§3.6 A4). Only Bash rules count: the reviewer's --tools has no Edit, Write or WebFetch,
// and --strict-mcp-config loads no MCP server. A rule within a git command (`Bash(git diff *)`, `Bash(git log
// --oneline:*)`) does not widen; one with shell operators is treated as widening.
function widensReviewer(rule) {
  if (typeof rule !== "string") return false;
  const match = /^Bash(?:\((.*)\))?$/s.exec(rule.trim());
  if (!match) return false;
  if (match[1] === undefined) return true;
  const body = match[1].trim();
  if (/[;&|`$<>\n]/.test(body)) return true;
  return !REVIEWER_GIT.some((command) => body === command || body.startsWith(`${command} `) || body.startsWith(`${command}:`));
}

// The user settings a login profile loads with `--setting-sources user` (permissions included [01 §9, E18]); an API
// profile loads no settings source, so {} there. One leading BOM (files saved by Windows editors) is dropped before
// parsing, so such a file is checked like any other. A file that exists but is no JSON reads as {} with `unparsed`
// set: what claude makes of it is unverified (it may still apply it), so doctor warns and the task is not refused.
function readUserSettings(profile, ctx, profileName = ctx.profileName) {
  if (authOf(profile).mode !== "login") return { file: null, settings: {}, unparsed: false };
  const file = path.join(configDirOf(profile, ctx, profileName), "settings.json");
  const raw = ctx.fs.readFile(file);
  // A missing file, or an empty one: nothing for claude to apply.
  if (typeof raw !== "string" || raw.trim() === "") return { file, settings: {}, unparsed: false };
  try {
    const settings = JSON.parse(raw.replace(/^﻿/, ""));
    return { file, settings: isObject(settings) ? settings : {}, unparsed: false };
  } catch {
    return { file, settings: {}, unparsed: true };
  }
}

const userSettingsOf = (profile, ctx, profileName = ctx.profileName) => readUserSettings(profile, ctx, profileName).settings;

const allowRulesOf = (settings) => {
  const allow = isObject(settings?.permissions) ? settings.permissions.allow : null;
  return Array.isArray(allow) ? allow.filter((rule) => typeof rule === "string") : [];
};

// The entries of a login profile's user settings (or options.settings) that would take its runs off the login. The
// profile is refused rather than the entries overridden: the user set them for their own claude, and a "login" profile
// running on such a key would be reported and linked as the login (spec §3.5) while the key's account pays.
function loginOverrides(settings) {
  const isSet = (value) => value !== undefined && value !== null && String(value) !== "";
  const counts = (name, value) => (CLOUD_SWITCHES.has(name) ? isSet(value) && SWITCH_ON.includes(String(value).trim().toLowerCase()) : isSet(value));
  const env = isObject(settings.env) ? settings.env : {};
  const keys = LOGIN_OVERRIDES.filter((name) => counts(name, env[name])).map((name) => `env.${name}`);
  if (typeof env.ANTHROPIC_CUSTOM_HEADERS === "string" && AUTH_HEADER_RE.test(env.ANTHROPIC_CUSTOM_HEADERS)) keys.push("env.ANTHROPIC_CUSTOM_HEADERS");
  if (isSet(settings.apiKeyHelper)) keys.push("apiKeyHelper");
  return keys;
}

// Why a login profile cannot run on its config dir (task exit 2, doctor FAIL); null for every other profile.
function loginConflict(profile, ctx, profileName = ctx.profileName, settings = userSettingsOf(profile, ctx, profileName)) {
  const keys = loginOverrides(settings);
  if (keys.length === 0) return null;
  const file = path.join(configDirOf(profile, ctx, profileName), "settings.json");
  return `${file} sets ${keys.join(", ")}: claude would use that key or endpoint instead of the claude.ai login (spec §3.6 A2); remove them there, or define an API profile for the key`;
}

// The same entries in a login profile's own options.settings: the overlay carries them, and --settings outranks the
// user settings [01 §9]. Refused as well, also the ANTHROPIC_* names that group A would strip: a login profile set up
// with a key or an endpoint is a mistake to report, not to run. null for every other profile.
function ownLoginConflict(profile) {
  if (authOf(profile).mode !== "login" || !isObject(profile.options?.settings)) return null;
  const keys = loginOverrides(profile.options.settings);
  if (keys.length === 0) return null;
  return `options.settings sets ${keys.join(", ")}: a login profile runs on the claude.ai login, not on a key, a key helper, another endpoint or a cloud provider (spec §3.6 A2); remove them from options.settings, or define an API profile for the key`;
}

// The same names in a login profile's profile.env, which reaches claude's environment. ANTHROPIC_AUTH_TOKEN,
// ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL are group A there (the core refuses them as mandatory conflicts), so this
// names the others: CLAUDE_CODE_OAUTH_TOKEN, a cloud switch that is on, an auth header. null for every other profile.
const GROUP_A_LOGIN = new Set(["env.ANTHROPIC_AUTH_TOKEN", "env.ANTHROPIC_API_KEY", "env.ANTHROPIC_BASE_URL"]);
function envLoginConflict(profile) {
  if (authOf(profile).mode !== "login" || !isObject(profile.env)) return null;
  const keys = loginOverrides({ env: profile.env }).filter((key) => !GROUP_A_LOGIN.has(key));
  if (keys.length === 0) return null;
  return `profile.env sets ${keys.map((key) => key.slice("env.".length)).join(", ")}: a login profile runs on the claude.ai login, not on another token or a cloud provider (spec §3.6 A2); remove them from profile.env, or define an API profile for the key`;
}

// profile.env CLAUDE_CODE_EFFORT_LEVEL wins over the effort field (§3.6 A7: a copied provider recipe).
function effortOf(profile) {
  const fromEnv = isObject(profile.env) ? text(profile.env.CLAUDE_CODE_EFFORT_LEVEL) : null;
  return fromEnv ?? text(profile.effort);
}

// ---------- the --settings overlay and system.md ----------

// Objects merge key by key; arrays and scalars replace; null removes the key.
function merge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete out[key];
    else if (isObject(value) && isObject(out[key])) out[key] = merge(out[key], value);
    else out[key] = structuredClone(value);
  }
  return out;
}

function overlayOf({ profile, mode, keyVar, writer, reviewer, native, effort, options, userWidening, userSandbox }) {
  const api = mode !== "login";
  // §3.6 Б: hooks off (also this plugin's own); on API profiles no web tools — WebSearch does not exist behind
  // non-Anthropic gateways and the WebFetch preflight calls api.anthropic.com [01 §9, gotcha 11].
  let settings = { disableAllHooks: true };
  if (api) settings = { ...settings, permissions: { deny: ["WebSearch", "WebFetch"] }, skipWebFetchPreflight: true };
  if (isObject(options.settings)) settings = merge(settings, options.settings);
  if (reviewer) {
    // §3.6 A4: the git options that write or run programs are denied (REVIEWER_DENY). Against allow rules:
    // options.settings ones that widen are dropped; the user settings' ones (a login profile) cannot be, so each gets
    // a deny rule — deny wins over allow from any source (Claude Code permission docs; not an experiment in [01]). A
    // broad user rule (`Bash`, `Bash(git:*)`) so also denies the git commands.
    const permissions = isObject(settings.permissions) ? { ...settings.permissions } : {};
    if (Array.isArray(permissions.allow)) permissions.allow = permissions.allow.filter((rule) => !widensReviewer(rule));
    if (permissions.allow?.length === 0) delete permissions.allow;
    const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
    permissions.deny = [...new Set([...deny, ...REVIEWER_DENY, ...userWidening])];
    settings.permissions = permissions;
    // A sandbox enabled by options.settings or the user settings auto-allows Bash by default (Claude Code sandbox
    // docs): off for a reviewer, like the native case below. --settings outranks the user settings [01 §9].
    if (!native && (isObject(settings.sandbox) || userSandbox)) {
      settings.sandbox = { ...(isObject(settings.sandbox) ? settings.sandbox : {}), autoAllowBashIfSandboxed: false };
    }
  }
  // Group A again, whatever options.settings said. --settings outranks the user's settings, so the effort and the
  // endpoint here beat an `env` in ~/.claude/settings.json and a repo's .claude/settings.json [01 §5 E10, §9 E9].
  const env = isObject(settings.env) ? { ...settings.env } : {};
  for (const name of OWNED_ENV) delete env[name];
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  if (effort) env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  if (api && profile.endpoint) env.ANTHROPIC_BASE_URL = profile.endpoint;
  settings.env = env;
  if (api) delete settings.apiKeyHelper; // a helper would be a second credential, sent in both headers [01 E3]
  if (native) {
    // §3.7. The sandbox covers Bash only [01 §8]. autoAllowBashIfSandboxed only for a writer: for a reviewer it would
    // approve any sandboxed Bash command, writes into the cwd included, past dontAsk (spec §3.7 sets it for writers).
    const user = isObject(settings.sandbox) ? settings.sandbox : {};
    const sandbox = { ...user, enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: writer };
    if (api) {
      const credentials = isObject(user.credentials) ? user.credentials : {};
      const envVars = (Array.isArray(credentials.envVars) ? credentials.envVars : []).filter((entry) => entry?.name !== keyVar);
      sandbox.credentials = { ...credentials, envVars: [...envVars, { name: keyVar, mode: "deny" }] };
    }
    settings.sandbox = sandbox;
  }
  return settings;
}

const PREAMBLE = `# Headless run

You run non-interactively for agent-dispatch: no one reads your messages while you work, and no one can answer a question. Never ask for confirmation or clarification; make a reasonable decision, carry on, and state your assumptions in the final message.
Your final message is returned verbatim as the result of this task: put the complete report there, in the format the prompt asks for.`;
const REVIEWER_LINE = "Your tools are read-only: Read, Glob, Grep, and Bash for `git show`, `git diff`, `git log` and `git status` only, without --output, --ext-diff, --textconv or --no-index; any other call is denied. Do not try to change files.";

// The preamble plus the project's CLAUDE.md files, which `--setting-sources ""` / `user` drop [01 §9, gotcha 9].
// @path imports and the CLAUDE.md files of subdirectories are not expanded: only these files, as written.
function systemPromptOf({ cwd, reviewer, ctx }) {
  const parts = [PREAMBLE];
  if (reviewer) parts.push(REVIEWER_LINE);
  for (const rel of PROJECT_FILES) {
    const content = cwd ? ctx.fs.readFile(path.join(cwd, rel)) : null;
    if (typeof content === "string" && content.trim()) parts.push(`# Project instructions (${rel})\n\n${content.trimEnd()}`);
  }
  return `${parts.join("\n\n")}\n`;
}

// ---------- invocation ----------

// invocation() and probe(): pure — the files are data the core writes, CLAUDE.md and the user settings are read
// through ctx.fs. `refuse: false` (doctor's auth check) plans a login profile whose user settings leave the login.
function planOf(req, ctx, { probe, refuse = true }) {
  const profile = req.profile ?? {};
  const { mode, keyVar } = authOf(profile);
  if (mode === "none" && !profile.endpoint) {
    throw new Error('auth "none" needs an endpoint (the local server\'s URL); without one claude would call api.anthropic.com');
  }
  // {} for an API profile: it loads no settings source.
  const user = userSettingsOf(profile, ctx, req.profileName);
  if (refuse && mode === "login") {
    const conflicts = [ownLoginConflict(profile), envLoginConflict(profile), loginConflict(profile, ctx, req.profileName, user)].filter(Boolean);
    if (conflicts.length > 0) throw new UsageError(`profile ${req.profileName ?? ctx.profileName}: ${conflicts.join("; ")}`);
  }
  const options = isObject(profile.options) ? profile.options : {};
  const writer = !probe && req.write === true;
  const reviewer = !probe && !writer;
  const native = profile.sandbox === "native";
  const effort = effortOf(profile);
  const settingsPath = path.join(req.job.dir, "settings.json");
  const systemPath = path.join(req.job.dir, "system.md");
  const userWidening = reviewer ? allowRulesOf(user).filter(widensReviewer) : [];
  const userSandbox = reviewer && isObject(user.sandbox);

  // §3.6 A4: a writer runs everything (acceptEdits inside the native sandbox, §3.7); a reviewer gets read tools and the
  // four git commands, and dontAsk denies the rest (allow rules that would widen it: overlayOf). Without a mode `-p`
  // denies silently and exits 0 [01 §7, E14].
  const tools = probe ? "" : writer ? (text(options.tools) ?? WRITER_TOOLS) : REVIEWER_TOOLS;
  const permissionMode = writer ? (native ? "acceptEdits" : "bypassPermissions") : "dontAsk";
  const argv = [req.harness?.bin ?? profile.bin ?? "claude", "-p", "--output-format", "json"];
  argv.push("--setting-sources", mode === "login" ? "user" : "", "--settings", settingsPath);
  if (profile.model) argv.push("--model", profile.model);
  if (effort) argv.push("--effort", effort);
  argv.push("--tools", tools);
  // A writer names its tools as allow rules too: with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB set (every mode, above) Claude
  // Code 2.1.310 forces the permission mode to default unless allowedTools is declared ("Permission mode forced to
  // default — … Declare allowedTools explicitly"), and `-p` then refuses every Bash, Write and Glob call it would ask
  // about: the job ends `completed` with permission_denials and a "blocked" answer (job ct-0001 of a kimi-code
  // profile, 2026-10-26). The rules grant nothing past --tools, which bypassPermissions already runs in full.
  if (writer) argv.push("--allowedTools", tools);
  if (reviewer) argv.push("--allowedTools", ...REVIEWER_ALLOWED);
  // One --append-system-prompt-file: whether the flag repeats is unverified [01]; spec §3.6 A6 passes one file.
  argv.push("--strict-mcp-config", "--disable-slash-commands", "--append-system-prompt-file", systemPath);
  // A resumed job continues the session in place under its id; a probe keeps nothing [01 §4, E7].
  if (probe) argv.push("--no-session-persistence");
  else if (req.resume?.sessionId) argv.push("--resume", req.resume.sessionId);
  else if (req.sessionId) argv.push("--session-id", req.sessionId);
  argv.push("--permission-mode", permissionMode);
  const maxTurns = probe ? 1 : options.maxTurns;
  if (maxTurns) argv.push("--max-turns", String(maxTurns));

  // §3.6 Б defaults; profile.env overrides them. Inherited ANTHROPIC_* (passed through by AGENT_ENV_PASSTHROUGH) go
  // first: only the profile sets those (§3.6 A2).
  const env = {};
  // Only valid names: the core refuses a layer with an invalid one, and filterEnv never passes such a name anyway.
  for (const name of Object.keys(ctx.env ?? {})) if (name.startsWith("ANTHROPIC_") && VAR_NAME_RE.test(name)) env[name] = null;
  Object.assign(env, {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    // The default 10 retries take about 3 minutes [01 §11, gotcha 5]; a probe answers at once (0 retries: 1 request, E8b).
    CLAUDE_CODE_MAX_RETRIES: probe ? "0" : "2",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  });
  if (mode !== "login" && profile.model) {
    for (const alias of ALIASES) env[`ANTHROPIC_DEFAULT_${alias}_MODEL`] = profile.model;
    env.CLAUDE_CODE_SUBAGENT_MODEL = profile.model;
  }
  // A default, not group A: the dummy is no secret, so a server's own recipe (Ollama: ANTHROPIC_AUTH_TOKEN=ollama,
  // ANTHROPIC_API_KEY="" [08]) may replace it through profile.env.
  if (mode === "none") Object.assign(env, { ANTHROPIC_API_KEY: LOCAL_DUMMY, ANTHROPIC_AUTH_TOKEN: null });

  // §3.6 A: profile.env may not touch these (task exit 2, doctor FAIL).
  const mandatoryEnv = { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", CLAUDE_CODE_ENTRYPOINT: null, CLAUDECODE: null };
  if (mode === "login") Object.assign(mandatoryEnv, { ANTHROPIC_BASE_URL: null, ANTHROPIC_AUTH_TOKEN: null, ANTHROPIC_API_KEY: null });
  else mandatoryEnv.ANTHROPIC_BASE_URL = profile.endpoint ?? null;
  if (mode === "key") mandatoryEnv[otherKeyVar(keyVar)] = "";

  return {
    argv,
    env,
    mandatoryEnv,
    secretEnv: mode === "key" ? [keyVar] : [],
    stdinPath: req.prompt?.path ?? null,
    cwd: req.job.cwd,
    files: [
      { path: settingsPath, mode: 0o600, content: `${JSON.stringify(overlayOf({ profile, mode, keyVar, writer, reviewer, native, effort, options, userWidening, userSandbox }), null, 2)}\n` },
      { path: systemPath, mode: 0o600, content: systemPromptOf({ cwd: req.job.cwd, reviewer, ctx }) },
    ],
    meta: { configDir: configDirOf(profile, ctx, req.profileName), authMode: mode },
  };
}

// ---------- reduce ----------

// The `--output-format json` object [01 §3]: one line, so the last parsed event; a pretty-printed one as a whole.
function resultOf(io) {
  const events = Array.isArray(io.events) ? io.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) if (isObject(events[i]) && events[i].type === "result") return events[i];
  const raw = String(io.stdout ?? "").trim();
  if (events.length === 0 && raw.startsWith("{")) {
    try {
      const whole = JSON.parse(raw);
      if (isObject(whole) && whole.type === "result") return whole;
    } catch {
      // not a result
    }
  }
  return null;
}

// The model that did the work: the modelUsage entry with the most tokens (a background haiku-tier call is smaller).
function mainModel(modelUsage) {
  if (!isObject(modelUsage)) return null;
  let best = null;
  let most = -1;
  for (const [model, usage] of Object.entries(modelUsage)) {
    const tokens = isObject(usage) ? ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0) : 0;
    if (tokens > most) [best, most] = [model, tokens];
  }
  return best;
}

const statusOf = (result) => {
  const value = result.api_error_status;
  if (Number.isInteger(value)) return value;
  return typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : null;
};

// spec §3.8: the class comes from api_error_status, not from the text — a 401 can read "Not logged in" [01 §11].
function classOf(result, message) {
  const status = statusOf(result);
  if (result.subtype === "error_max_turns") return "timeout";
  if (result.terminal_reason === "prompt_too_long") return "context";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 404) return "model-not-selected";
  if (status === 429) return QUOTA_TEXT.some((pattern) => pattern.test(message)) ? "quota" : "rate-limit";
  if (status === 529) return "rate-limit"; // overloaded (spec §3.8 table)
  if (status !== null && status >= 500) return "server";
  if (status === 400 && /prompt is too long/i.test(message)) return "context";
  if (/There's an issue with the selected model/i.test(message)) return "model-not-selected";
  // No status: no credential at all, or no connection [01 §11]. ENOTFOUND / ECONNRESET / ETIMEDOUT are the same kind of
  // text as the recorded ECONNREFUSED (not recorded themselves).
  if (status === null && /Not logged in|Failed to authenticate/i.test(message)) return "auth";
  if (status === null && /ECONNREFUSED|Connection refused|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(message)) return "server";
  return null;
}

function reduce(io) {
  const result = resultOf(io);
  if (!result) {
    // SIGINT ends claude with exit 0 and an empty stdout [01 E21]: no result is a failure whatever the exit code.
    const exit = io.exit ?? {};
    return { ok: false, response: null, sessionId: null, usage: null, reportedModel: null, errorClass: null, errorText: `claude printed no result (exit ${exit.code ?? "-"}${exit.signal ? `, signal ${exit.signal}` : ""})` };
  }
  const base = { sessionId: text(result.session_id), usage: isObject(result.usage) ? result.usage : null, reportedModel: mainModel(result.modelUsage) };
  const answer = typeof result.result === "string" ? result.result : null;
  const denials = Array.isArray(result.permission_denials) ? result.permission_denials : [];
  const tools = [...new Set(denials.map((entry) => text(entry?.tool_name) ?? "?"))];
  const meta = {
    numTurns: Number.isInteger(result.num_turns) ? result.num_turns : null,
    terminalReason: text(result.terminal_reason),
    ...(denials.length > 0 ? { permissionDenials: denials.length, deniedTools: tools } : {}),
  };
  // API errors come with is_error true and subtype "success"; max turns with subtype error_max_turns [01 §3].
  const failed = result.is_error === true || (result.subtype ?? "success") !== "success";
  if (!failed && answer?.trim()) {
    if (denials.length === 0) return { ...base, ok: true, response: answer, errorClass: null, errorText: null, meta };
    // §3.6 A4: denials go into the report as a remark; line 1 (the status token) stays line 1.
    const note = `permission_denials: the permission mode refused ${denials.length} tool call(s) (${tools.join(", ")})`;
    return { ...base, ok: true, response: `${answer}${answer.endsWith("\n") ? "" : "\n"}\n---\nagent-dispatch: ${note}\n`, errorClass: null, errorText: note, meta };
  }
  if (!failed) {
    if (denials.length > 0) return { ...base, ok: false, response: null, errorClass: "blocked", errorText: `no result after the permission mode refused ${denials.length} tool call(s) (${tools.join(", ")})`, meta };
    return { ...base, ok: false, response: null, errorClass: null, errorText: "claude returned an empty result", meta };
  }
  const head = answer?.trim() ? answer.trim() : result.subtype === "error_max_turns" ? "the run reached --max-turns" : "claude reported an error without text";
  const tags = `api_error_status ${statusOf(result) ?? "null"}, terminal_reason ${text(result.terminal_reason) ?? "-"}, subtype ${text(result.subtype) ?? "-"}`;
  return { ...base, ok: false, response: null, errorClass: classOf(result, answer ?? ""), errorText: `${head} [${tags}]`, meta };
}

// ---------- doctor ----------

// `claude auth status --json` [01 §6, E20] behind the profile's wrap, in an environment built like the run's. It runs
// in a directory of the data root: without --setting-sources claude would also load the `.claude/settings.json` (env,
// apiKeyHelper) of whatever repo doctor is called from [01 §9, E9].
function authStatus(profile, ctx, env, cwd) {
  const bin = profile.bin ?? "claude";
  const [cmd, ...args] = [...(Array.isArray(profile.wrap) ? profile.wrap : []), bin, "auth", "status", "--json"];
  // 30 s, not ctx.exec's 10: the status may refresh the login over the network.
  const r = ctx.exec(cmd, args, cwd ? { env, cwd, timeoutMs: 30_000 } : { env, timeoutMs: 30_000 });
  if (r.error) return { error: `cannot run ${bin} auth status --json: ${r.error.code ?? r.error.message}` };
  try {
    const status = JSON.parse(String(r.stdout ?? "").trim());
    if (isObject(status)) return { status };
  } catch {
    // reported below
  }
  return { error: `${bin} auth status --json printed no JSON (exit ${r.status ?? r.signal})` };
}

// spec §3.6 A1: an API profile's dir holds no login (without a key claude must report loggedIn false) and claude uses
// the key variable (with a placeholder in it: oauth_token or api_key). A login profile must be logged in, and claude
// must take that login, not a key (spec §3.6 A2).
function authChecks(profile, ctx) {
  const check = (level, hint) => ({ name: "auth-status", level, hint });
  const { mode, keyVar } = authOf(profile);
  const name = ctx.profileName;
  const dir = configDirOf(profile, ctx);
  const req = {
    profile,
    profileName: name,
    role: null,
    write: false,
    job: { id: null, dir: path.join(ctx.paths.state, "doctor"), cwd: path.join(ctx.paths.state, "doctor"), workspaceRoot: null },
    prompt: { path: null, bytes: 0 },
    sessionId: null,
    resume: null,
    harness: null,
  };
  const home = prepareHome(profile, ctx);
  // Not refused here: the user-settings row names what leaves the login, and auth status shows what claude takes.
  const inv = planOf(req, ctx, { probe: false, refuse: false });
  const isDir = (candidate) => Boolean(candidate && ctx.fs.stat?.(candidate)?.isDirectory?.());
  const cwd = [ctx.paths.root, dir].find(isDir) ?? null;
  const authStatusWith = (env) => authStatus(profile, ctx, env, cwd);
  const envWith = (overrides) =>
    buildEnv({
      source: ctx.env,
      inherit: usesUserDir(profile) ? ["CLAUDE_CONFIG_DIR"] : [],
      defaults: inv.env,
      profileEnv: profile.env,
      mandatory: { ...(home.env ?? {}), ...inv.mandatoryEnv, ...overrides },
    });
  if (mode === "login") {
    const { status, error } = authStatusWith(envWith({}));
    if (error) return check("WARN", `the login was not checked: ${error}`);
    const method = status.authMethod ?? "?";
    const taken = `authMethod ${method}, apiKeySource ${status.apiKeySource ?? "?"}`;
    if (status.loggedIn === true && KEY_METHODS.includes(method)) {
      return check("FAIL", `claude takes a key in ${dir}, not the claude.ai login (${taken}); a login profile runs on the login (spec §3.6 A2): remove the key or apiKeyHelper from the settings that set it, or define an API profile for it`);
    }
    if (status.loggedIn === true && method === "oauth_token") {
      return check("WARN", `claude takes a token variable in ${dir}, not the claude.ai login (${taken}): ANTHROPIC_AUTH_TOKEN would be a key; a CLAUDE_CODE_OAUTH_TOKEN of claude setup-token is a subscription token`);
    }
    if (status.loggedIn === true) return check("ok", `logged in (authMethod ${method}) in ${dir}`);
    const how = usesUserDir(profile) ? "claude, then /login" : `agent-dispatch profile env ${name} -- claude, then /login`;
    return check("FAIL", `claude is not logged in in ${dir} (authMethod ${method}); the user logs in: ${how}`);
  }
  const bare = authStatusWith(envWith({ ANTHROPIC_AUTH_TOKEN: null, ANTHROPIC_API_KEY: null }));
  if (bare.error) return check("WARN", `the profile dir was not checked: ${bare.error}`);
  if (bare.status.loggedIn === true) {
    return check("FAIL", `${dir} holds a credential of its own (authMethod ${bare.status.authMethod ?? "?"}); an API profile's dir must hold none (spec §3.6 A1): remove that login, the apiKeyHelper or the key in settings.json env, or the dir itself`);
  }
  const keyed = authStatusWith(envWith(mode === "key" ? { [keyVar]: DOCTOR_PLACEHOLDER } : {}));
  if (keyed.error) return check("WARN", `the key variable was not checked: ${keyed.error}`);
  const method = keyed.status.authMethod;
  // api_key is the spec's name for an ANTHROPIC_API_KEY credential (§3.6 A1); [01 E20] recorded only oauth_token.
  if (keyed.status.loggedIn === true && ["oauth_token", "api_key"].includes(method)) {
    return check("ok", `no login in ${dir}; claude takes the ${mode === "key" ? `key from ${keyVar}` : "local-dummy key"} (authMethod ${method})`);
  }
  return check("FAIL", `with ${mode === "key" ? `a placeholder in ${keyVar}` : "the local-dummy key"} claude reports loggedIn=${keyed.status.loggedIn} authMethod=${method ?? "?"} (expected oauth_token or api_key)`);
}

// options.settings entries that group A overrides: they are ignored, and the user should know. On a login profile the
// key and endpoint names among them refuse the profile instead (ownLoginConflict).
function ignoredSettings(profile) {
  const settings = isObject(profile.options?.settings) ? profile.options.settings : null;
  if (!settings) return [];
  const { mode } = authOf(profile);
  const env = isObject(settings.env) ? settings.env : {};
  const owned = mode === "login" ? OWNED_ENV.filter((name) => !LOGIN_OVERRIDES.includes(name)) : OWNED_ENV;
  const ignored = owned.filter((name) => Object.hasOwn(env, name)).map((name) => `env.${name}`);
  if (effortOf(profile) && Object.hasOwn(env, "CLAUDE_CODE_EFFORT_LEVEL")) ignored.push("env.CLAUDE_CODE_EFFORT_LEVEL");
  if (mode !== "login" && Object.hasOwn(settings, "apiKeyHelper")) ignored.push("apiKeyHelper");
  if (profile.sandbox === "native" && isObject(settings.sandbox)) {
    for (const key of SANDBOX_OWNED) if (Object.hasOwn(settings.sandbox, key)) ignored.push(`sandbox.${key}`);
  }
  return ignored;
}

// Allow rules that would widen a reviewer (§3.6 A4); the run neutralises them (overlayOf), the user should know.
function reviewerRulesCheck(profile, ctx) {
  const user = allowRulesOf(userSettingsOf(profile, ctx)).filter(widensReviewer);
  const own = allowRulesOf(profile.options?.settings).filter(widensReviewer);
  const parts = [];
  if (user.length > 0) {
    parts.push(`${path.join(configDirOf(profile, ctx), "settings.json")} allows ${user.join(", ")}: denied for reviewers (a broad rule such as Bash or Bash(git:*) then also denies git show/diff/log/status)`);
  }
  if (own.length > 0) parts.push(`options.settings permissions.allow ${own.join(", ")}: dropped for reviewers`);
  return parts.length > 0 ? { name: "permissions", level: "WARN", hint: `allow rules past a reviewer's read-only set (spec §3.6 A4): ${parts.join("; ")}` } : null;
}

// ---------- the adapter ----------

export default {
  id: "claude",
  idPrefix: "ct",
  manifest: {
    sessionId: "preassign",
    sessionIdFormat: "uuid",
    // SIGTERM ends `claude -p` with exit 143 and kills its Bash trees; SIGINT is never sent: claude then exits 0 with
    // an empty stdout [01 §10, E21] (spec §3.6 A8).
    cancel: { ladder: [["SIGTERM", 5000], ["SIGKILL", 0]] },
    helpArgv: ["--help"],
    requiredFlags: ["--output-format", "--setting-sources", "--session-id", "--tools"],
    homeEnv: ["CLAUDE_CONFIG_DIR"],
    verifiedVersions: ["2.1.302"],
  },

  discover(ctx) {
    const bin = ctx.profile?.bin ?? "claude";
    const r = ctx.exec(bin, ["--version"]);
    if (r.error || r.status !== 0) {
      throw Object.assign(new Error(`cannot run ${bin} --version (${r.error?.code ?? `exit ${r.status ?? r.signal}`}); install Claude Code (npm install -g @anthropic-ai/claude-code) or set the profile's bin`), { errorClass: "launch" });
    }
    return { bin, version: String(r.stdout ?? "").match(/\d+\.\d+\.\d+\S*/)?.[0] ?? null };
  },

  prepareHome,

  invocation(req, ctx) {
    return planOf(req, ctx, { probe: false });
  },

  // One "Reply with exactly: PONG" turn: no tools, one turn, no retries, nothing kept.
  probe(req, ctx) {
    return planOf(req, ctx, { probe: true });
  },

  reduce,

  // spec §3.6 A12: the same cwd and the same config dir; a session never moves between dirs [01 §4, E7].
  resumeCheck(prev, profile, req, ctx) {
    if (prev.cwd && prev.cwd !== req.job.cwd) return `claude keeps sessions per directory: ${prev.id} ran in ${prev.cwd}, this task runs in ${req.job.cwd}`;
    const before = text(prev.meta?.configDir);
    if (!before) return `${prev.id} recorded no claude config directory`;
    const now = configDirOf(profile, ctx, req.profileName);
    if (path.resolve(before) !== path.resolve(now)) return `its session lives in ${before}, but this run would use ${now} (claude resumes only from the config directory that holds the session)`;
    return null;
  },

  // Unclassified failures only (reduce() classifies a result by api_error_status); matched against reduce's errorText
  // and stderr [01 §3, §4, §11].
  patterns: {
    "resume-lost": ["No conversation found with session ID"],
    "model-not-selected": ["There's an issue with the selected model"],
    auth: ["Not logged in", "Failed to authenticate"],
    quota: [/credit balance/i, /insufficient balance/i, /usage limit/i],
    context: ["Prompt is too long", "prompt_too_long"],
    "rate-limit": ["rate_limit_error", "overloaded_error"],
    server: ["ECONNREFUSED", "Connection refused"],
    launch: ["unknown option", "requires --verbose"],
  },

  // `agent-dispatch profile env <p>` (a login profile with "home": "isolated") exports prepareHome's env: no loginEnv.

  doctorChecks(profile, ctx) {
    const checks = [];
    let mode = null;
    try {
      mode = authOf(profile).mode;
    } catch {
      mode = null;
    }
    if (mode === "login") {
      const own = ownLoginConflict(profile);
      if (own) checks.push({ name: "settings", level: "FAIL", hint: `${own}; every task is refused` });
      const fromEnv = envLoginConflict(profile);
      if (fromEnv) checks.push({ name: "profile-env", level: "FAIL", hint: `${fromEnv}; every task is refused` });
      try {
        const { file, settings, unparsed } = readUserSettings(profile, ctx);
        const conflict = loginConflict(profile, ctx, ctx.profileName, settings);
        if (conflict) checks.push({ name: "user-settings", level: "FAIL", hint: `${conflict}; every task is refused` });
        // Not the parser's message: it may quote the file, a key included.
        if (unparsed) {
          checks.push({ name: "user-settings", level: "WARN", hint: `cannot parse ${file} as JSON, so it was not checked for a key, an apiKeyHelper or an endpoint (spec §3.6 A2); claude may still apply it — check it` });
        }
      } catch (error) {
        checks.push({ name: "user-settings", level: "WARN", hint: `not checked: ${error?.message ?? error}` });
      }
    }
    try {
      checks.push(authChecks(profile, ctx));
    } catch (error) {
      checks.push({ name: "auth-status", level: "WARN", hint: `not checked: ${error?.message ?? error}` });
    }
    if (mode !== "login" && profile.endpoint && !profile.model) {
      checks.push({ name: "model", level: "WARN", hint: `no model: claude would send its own claude-* model ids to ${profile.endpoint}; set "model" (it also pins ANTHROPIC_DEFAULT_*_MODEL)` });
    }
    // Without an endpoint the key goes to the Anthropic API, which takes an API key in x-api-key (ANTHROPIC_API_KEY
    // [01 §6, E2]), not as a Bearer token (Anthropic API docs; not an experiment in [01]).
    if (mode === "key" && !profile.endpoint && profile.authHeader !== "x-api-key") {
      checks.push({ name: "auth-header", level: "WARN", hint: 'no endpoint: the key goes to the Anthropic API as Authorization: Bearer, but an Anthropic API key is sent as x-api-key; set "authHeader": "x-api-key"' });
    }
    try {
      const rules = reviewerRulesCheck(profile, ctx);
      if (rules) checks.push(rules);
    } catch (error) {
      checks.push({ name: "permissions", level: "WARN", hint: `not checked: ${error?.message ?? error}` });
    }
    if (profile.sandbox === "native" && Array.isArray(profile.wrap) && profile.wrap.length > 0) {
      checks.push({ name: "sandbox", level: "WARN", hint: "native sandbox inside wrap: a nested sandbox may not start (nested Seatbelt fails on macOS [09 §2.5]); failIfUnavailable then stops every run" });
    }
    const ignored = ignoredSettings(profile);
    if (ignored.length > 0) checks.push({ name: "settings", level: "WARN", hint: `options.settings ${ignored.join(", ")}: set by the adapter (spec §3.6 A), ignored` });
    return checks;
  },
};
