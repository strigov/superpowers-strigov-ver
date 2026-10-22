// agent-dispatch.mjs — the CLI of the universal dispatchers (docs/superpowers/specs/2026-10-20-universal-dispatchers-design.md
// §3.3–§3.5, §3.8, §3.9, §4, §5): profiles and roles from bin/lib/agents-defaults.json plus the user's config.json,
// role routing, the key store, doctor, and background tasks — on the shared job core (agent-core.mjs) for the
// harnesses claude / opencode / pi / dsh, and as pass-through calls of the existing wrappers for the profiles of the
// zcode harness (bin/zcode-dispatch) and the codex harness (bin/codex-dispatch).
//
// Without a config.json everything behaves as the owner's built-in scheme: `route --all` prints `routes: default`,
// and every task of a built-in role reaches the same wrapper with the same argv as the orchestrator sends today.
//
// Usage (exit codes: 0 success · 1 runtime failure · 2 refusal or usage error, nothing started):
//   task --profile P [--role R] --background [--write] [--cwd W] [--resume-task ID | --fresh] --prompt-file F
//   status [ID] [--cwd W] [--json] [--all]      result ID [--cwd W]      cancel ID [--cwd W]      release-stale [--cwd W]
//   route ROLE [--skip p[:class],…] [--json]    route --all [--json]     channels [--json]
//   doctor [--profile P] [--probe]
//   tree-state [--cwd W] [--since TREE]
//   key set NAME | key list | key rm NAME
//   profile list [--json] | profile show P | profile add NAME --from PRESET [--model M] [--key K] [--set k=v]… |
//   profile env P [-- COMMAND [ARGS…]]
//   preset list [--json]
//   __run <id> <jobs-dir> <token|->            (internal: the detached runner of a core job)
//
// Adapters. The pass-through adapters (adapters/zcode.mjs, adapters/codex.mjs) are imported here; they return the
// wrapper argv and parse the wrappers' `status --json`, and this CLI runs the wrapper with stdio inherited, so its
// stdout, stderr and exit code pass through unchanged. A core adapter (spec §3.2) is the file
// adapters/<harness>.mjs for harness ∈ {claude, opencode, pi, dsh}, whose default export has id === <harness>; all
// four ship (increments 2–5), each loaded on demand — a runner loads only its job's. A harness without its file is
// refused (`harness <h> is not available in this version`). $AGENT_DISPATCH_ADAPTER_DIR names a directory searched
// first (tests put a stand-in adapter there), like $AGENT_DISPATCH_ZCODE / $AGENT_DISPATCH_CODEX name the wrappers.
// An adapter that fails to load stops only what needs it: doctor reports it as a FAIL row of each profile on that
// harness, and a runner loads only its job's adapter.
// Besides the hooks of the core contract the CLI reads two optional ones of its own: loginEnv(profile, ctx) → the
// variables `profile env` gives an isolated home (without it, the env of prepareHome: the home the jobs use), and
// doctorChecks(profile, ctx) → doctor rows; doctor's ctx also carries cwd and writeFiles(spec), the core's writer of
// adapter files under the data root (dsh's --dump-config template).
//
// Pure Node ESM, no dependencies, no shell: every child process gets an argv array.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as core from "./agent-core.mjs";
import zcodeAdapter from "./adapters/zcode.mjs";
import codexAdapter from "./adapters/codex.mjs";

const { UsageError, CLI_NAME } = core;

const SELF = fileURLToPath(import.meta.url);
const LIB_DIR = path.dirname(SELF);
const BIN_DIR = path.dirname(LIB_DIR);
const ADAPTERS_DIR = path.join(LIB_DIR, "adapters");

// The owner's scheme: built-in profiles (§4.1), roles (§5.1), presets (§4.2).
export const DEFAULTS = JSON.parse(fs.readFileSync(path.join(LIB_DIR, "agents-defaults.json"), "utf8"));

export const ADAPTER_DIR_VAR = "AGENT_DISPATCH_ADAPTER_DIR";
export const HARNESSES = ["zcode", "codex", "claude", "opencode", "pi", "dsh", "inproc"];
export const CORE_HARNESSES = ["claude", "opencode", "pi", "dsh"];
const PASS_THROUGH = { zcode: zcodeAdapter, codex: codexAdapter };
export const RESERVED_NAMES = ["claude", "inproc", "default"];
// Core job id prefix → harness (spec §3.2), for the merged status list.
const PREFIX_HARNESS = { ct: "claude", oc: "opencode", pi: "pi", dt: "dsh" };
// How a role on the harness is held to reading (route's readOnly=): Codex and dsh sandboxes, claude and pi tool
// sets, OpenCode permission rules; ZCode has no read-only mode. Inproc roles print "-": the session decides.
const READ_ONLY = { zcode: "none", codex: "os", claude: "tools", opencode: "rules", pi: "tools", dsh: "os" };

const NAME_RE = core.PROFILE_NAME_RE;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHARES_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PLACEHOLDER_RE = /<[^<>\s]+>/g;
const KEY_CMD_TIMEOUT_MS = 10_000;
const STORE_TIMEOUT_MS = 60_000;

// Profile fields per harness (spec §3.4); a field of another harness is refused by name, like an unknown one.
const COMMON_FIELDS = ["harness", "auth", "model", "effort", "shares", "maxParallel"];
const CORE_FIELDS = [...COMMON_FIELDS, "bin", "env", "options", "home", "sandbox", "wrap", "timeoutMin"];
const FIELDS = {
  inproc: ["harness", "model", "effort"],
  zcode: COMMON_FIELDS,
  codex: COMMON_FIELDS,
  claude: [...CORE_FIELDS, "endpoint", "authHeader"],
  opencode: [...CORE_FIELDS, "keyVar"],
  pi: [...CORE_FIELDS, "keyVar"],
  dsh: [...CORE_FIELDS, "endpoint"],
};
const ALL_FIELDS = new Set(Object.values(FIELDS).flat());
// auth modes per harness: "key" stands for {key}, {keyEnv} and {keyCmd}.
const AUTH_MODES = {
  zcode: ["native"],
  codex: ["login"],
  claude: ["login", "none", "key"],
  opencode: ["login", "key"],
  pi: ["login", "key"],
  dsh: ["native", "key"],
};
const DEFAULT_AUTH = { zcode: "native", codex: "login", claude: "login", opencode: "login", pi: "login", dsh: "native" };
// `options` per harness (spec §3.4, §3.6 Б) and the type of each value.
const OPTIONS = {
  claude: { tools: "string", settings: "object", maxTurns: "count" },
  opencode: { permission: "object", plugins: "boolean" },
  pi: { extensions: "strings" },
  dsh: { sessionLog: "boolean", agentsHome: ["user", "empty"], patch: "object" },
};
// How the user logs in to a harness (spec §4.3), for the `next:` line of profile add and doctor hints.
const LOGIN_STEP = { claude: "claude, then /login", opencode: "opencode auth login", pi: "pi, then /login", codex: "codex login" };
// --skip classes: the error classes of §3.8 plus the channel states of the `channels` marker.
const SKIP_CLASSES = new Set([...core.ERROR_CLASSES, "down", "off", "kill-switch"]);
// Classes that take every linked profile out with the failing one (spec §3.5 "Общий ключ или вход").
const LINKING_CLASSES = new Set(["auth", "quota"]);

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const out = (text) => process.stdout.write(text);
const errOut = (text) => process.stderr.write(text);
const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

// ---------- config (spec §3.4) ----------

class ConfigProblem extends Error {}
const problem = (message) => {
  throw new ConfigProblem(message);
};

// "login" | "native" | "none" | "key" (the three key sources) | null for an invalid value.
function authMode(auth) {
  if (auth === "login" || auth === "native" || auth === "none") return auth;
  if (isObject(auth) && Object.keys(auth).length === 1 && ["key", "keyEnv", "keyCmd"].includes(Object.keys(auth)[0])) return "key";
  return null;
}

function authText(profile) {
  if (profile.harness === "inproc") return "session";
  const auth = profile.auth;
  if (!isObject(auth)) return String(auth);
  if ("key" in auth) return `key:${auth.key}`;
  if ("keyEnv" in auth) return `keyEnv:${auth.keyEnv}`;
  return `keyCmd:${Array.isArray(auth.keyCmd) ? auth.keyCmd[0] : "?"}`;
}

const placeholdersIn = (text) => (typeof text === "string" ? (text.match(PLACEHOLDER_RE) ?? []) : []);

// `secret`: the field names where a key lives (auth.key, auth.keyEnv, keyVar), so a value that does not fit is most
// likely the key itself, pasted in the wrong place. It is never echoed: config problems reach stderr and, through the
// orchestrator, the chat (spec §3.5, §3.6 А11). `secret` is the hint that replaces the value.
function checkString(at, field, value, { pattern = null, what = null, secret = null } = {}) {
  if (typeof value !== "string" || value === "") problem(`${at}: ${field} must be a non-empty string`);
  if (pattern && !pattern.test(value)) {
    if (secret) problem(`${at}: ${field} is not ${what} (expected ${pattern}; the value is not echoed — ${secret})`);
    problem(`${at}: ${field} ${JSON.stringify(value)} is not ${what ?? `a match of ${pattern}`}`);
  }
}

function checkAuth(at, harness, auth) {
  const mode = authMode(auth);
  if (!mode) problem(`${at}: auth must be "login", "native", "none", {"key": NAME}, {"keyEnv": VAR} or {"keyCmd": [argv]}`);
  if (isObject(auth)) {
    if ("key" in auth && placeholdersIn(auth.key).length === 0) {
      checkString(at, "auth.key", auth.key, { pattern: NAME_RE, what: "a key name", secret: `auth.key names a key in the store; the key itself goes there with: ${CLI_NAME} key set <name>` });
    }
    if ("keyEnv" in auth) checkString(at, "auth.keyEnv", auth.keyEnv, { pattern: ENV_NAME_RE, what: "a variable name", secret: "auth.keyEnv names the variable that holds the key, not the key" });
    if ("keyCmd" in auth && (!Array.isArray(auth.keyCmd) || auth.keyCmd.length === 0 || auth.keyCmd.some((arg) => typeof arg !== "string" || arg === ""))) {
      problem(`${at}: auth.keyCmd must be a non-empty array of non-empty strings (an argv, never a shell line)`);
    }
  }
  if (!AUTH_MODES[harness].includes(mode)) {
    const valid = AUTH_MODES[harness].map((m) => (m === "key" ? '{"key"}, {"keyEnv"}, {"keyCmd"}' : `"${m}"`)).join(", ");
    problem(`${at}: auth ${isObject(auth) ? JSON.stringify(Object.keys(auth)[0]) : JSON.stringify(auth)} does not apply to harness ${harness} (valid: ${valid})`);
  }
}

function checkOptions(at, harness, options) {
  if (!isObject(options)) problem(`${at}: options must be an object`);
  const known = OPTIONS[harness];
  for (const [name, value] of Object.entries(options)) {
    const type = known[name];
    if (!type) problem(`${at}: unknown option "${name}" for harness ${harness} (options: ${Object.keys(known).join(", ")})`);
    const bad =
      (type === "string" && (typeof value !== "string" || value === "")) ||
      (type === "object" && !isObject(value)) ||
      (type === "boolean" && typeof value !== "boolean") ||
      (type === "count" && !(Number.isInteger(value) && value > 0)) ||
      (type === "strings" && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === ""))) ||
      (Array.isArray(type) && !type.includes(value));
    if (bad) {
      const want = Array.isArray(type) ? type.map((v) => JSON.stringify(v)).join(" or ") : { string: "a string", object: "an object", boolean: "true or false", count: "a positive integer", strings: "an array of strings" }[type];
      problem(`${at}: option ${name} must be ${want}`);
    }
  }
}

// Validates one profile as written (built-in or user); throws ConfigProblem naming the first problem.
export function checkProfile(name, raw) {
  const at = `profile ${name}`;
  if (!isObject(raw)) problem(`${at}: must be an object`);
  const harness = raw.harness;
  if (harness === undefined) problem(`${at}: harness is required (one of ${HARNESSES.join(", ")})`);
  if (!HARNESSES.includes(harness)) problem(`${at}: unknown harness ${JSON.stringify(harness)} (one of ${HARNESSES.join(", ")})`);
  for (const field of Object.keys(raw)) {
    if (!ALL_FIELDS.has(field)) problem(`${at}: unknown field "${field}"`);
    if (!FIELDS[harness].includes(field)) problem(`${at}: field "${field}" does not apply to harness ${harness}`);
  }
  for (const field of ["harness", "model", "effort", "endpoint", "keyVar", "shares", "bin", "authHeader", "home", "sandbox"]) {
    if (raw[field] !== undefined && typeof raw[field] === "string") {
      const holes = placeholdersIn(raw[field]);
      if (holes.length > 0) problem(`${at}: ${field} has an unfilled placeholder ${holes.join(" ")}`);
    }
  }
  if (isObject(raw.auth) && "key" in raw.auth && placeholdersIn(raw.auth.key).length > 0) problem(`${at}: auth.key has an unfilled placeholder ${placeholdersIn(raw.auth.key).join(" ")}`);
  if (raw.auth !== undefined) checkAuth(at, harness, raw.auth);
  for (const field of ["model", "effort", "bin"]) if (raw[field] !== undefined) checkString(at, field, raw[field]);
  if (raw.endpoint !== undefined) checkString(at, "endpoint", raw.endpoint, { pattern: /^https?:\/\/\S+$/, what: "an http(s) URL" });
  if (raw.authHeader !== undefined && !["bearer", "x-api-key"].includes(raw.authHeader)) problem(`${at}: authHeader must be "bearer" or "x-api-key"`);
  // endpoint and authHeader belong to claude API profiles (spec §3.4): with a login (the default auth of claude) the
  // claude.ai token would meet a third-party endpoint, the case §3.6 A1 exists to rule out.
  if (harness === "claude" && authMode(raw.auth ?? DEFAULT_AUTH.claude) === "login") {
    for (const field of ["endpoint", "authHeader"]) {
      if (raw[field] !== undefined) {
        problem(`${at}: ${field} applies to claude API profiles only: with it, auth must be {"key": NAME}, {"keyEnv": VAR}, {"keyCmd": [argv]} or "none" (the claude.ai login never goes to another endpoint, spec §3.6 A1)`);
      }
    }
  }
  if (raw.keyVar !== undefined) checkString(at, "keyVar", raw.keyVar, { pattern: ENV_NAME_RE, what: "a variable name", secret: "keyVar names the variable the harness reads the key from, not the key" });
  if (raw.shares !== undefined) checkString(at, "shares", raw.shares, { pattern: SHARES_RE, what: `a label (${SHARES_RE})` });
  if (raw.env !== undefined) {
    if (!isObject(raw.env)) problem(`${at}: env must be an object of variable names to strings`);
    for (const [name, value] of Object.entries(raw.env)) {
      if (!ENV_NAME_RE.test(name)) problem(`${at}: env has an invalid variable name ${JSON.stringify(name)}`);
      if (value !== null && typeof value !== "string") problem(`${at}: env.${name} must be a string (or null to remove a default)`);
    }
  }
  if (raw.options !== undefined) checkOptions(at, harness, raw.options);
  if (raw.home !== undefined && !["user", "isolated"].includes(raw.home)) problem(`${at}: home must be "user" or "isolated"`);
  if (harness === "claude" && raw.home === "user" && authMode(raw.auth ?? DEFAULT_AUTH.claude) !== "login") {
    problem(`${at}: a claude API profile always uses its isolated home (spec §3.6 A1); remove "home": "user"`);
  }
  if (raw.sandbox !== undefined && !["off", "native"].includes(raw.sandbox)) problem(`${at}: sandbox must be "off" or "native"`);
  if (raw.wrap !== undefined && (!Array.isArray(raw.wrap) || raw.wrap.length === 0 || raw.wrap.some((arg) => typeof arg !== "string" || arg === ""))) {
    problem(`${at}: wrap must be a non-empty array of non-empty strings (an argv prefix)`);
  }
  if (raw.timeoutMin !== undefined && !(typeof raw.timeoutMin === "number" && Number.isFinite(raw.timeoutMin) && raw.timeoutMin > 0)) problem(`${at}: timeoutMin must be a positive number`);
  if (raw.maxParallel !== undefined && !(Number.isInteger(raw.maxParallel) && raw.maxParallel > 0)) problem(`${at}: maxParallel must be a positive integer`);
  if (harness === "inproc" && (raw.model === undefined || raw.effort === undefined)) problem(`${at}: an inproc profile needs model and effort (the Agent tool's model and effort)`);
  if (harness === "codex" && (raw.model === undefined || raw.effort === undefined)) problem(`${at}: a codex profile needs model and effort (they go to codex-dispatch as --model and --effort)`);
  if ((harness === "opencode" || harness === "pi") && authMode(raw.auth) === "key" && raw.keyVar === undefined) {
    problem(`${at}: a ${harness} profile with a key needs keyVar (the variable the harness reads the key from)`);
  }
}

// Validates a parsed config.json (spec §3.4). Built-in names cannot be overridden; reserved names are refused; roles
// must be known and name existing profiles.
export function validateConfig(data) {
  if (!isObject(data)) problem("must be a JSON object");
  for (const key of Object.keys(data)) if (!["version", "profiles", "roles"].includes(key)) problem(`unknown field "${key}" (fields: version, profiles, roles)`);
  if (data.version === undefined) problem('"version": 1 is required');
  if (data.version !== 1) problem(`unsupported version ${JSON.stringify(data.version)} (expected 1)`);
  const profiles = data.profiles ?? {};
  if (!isObject(profiles)) problem("profiles must be an object");
  for (const [name, raw] of Object.entries(profiles)) {
    if (Object.hasOwn(DEFAULTS.profiles, name)) problem(`profile ${name} is built in and cannot be overridden; copy it under a new name`);
    if (RESERVED_NAMES.includes(name)) problem(`profile name ${name} is reserved (${RESERVED_NAMES.join(", ")})`);
    if (!NAME_RE.test(name)) problem(`invalid profile name ${JSON.stringify(name)} (expected ${NAME_RE})`);
    checkProfile(name, raw);
  }
  const roles = data.roles ?? {};
  if (!isObject(roles)) problem("roles must be an object");
  for (const [role, chain] of Object.entries(roles)) {
    if (!Object.hasOwn(DEFAULTS.roles, role)) problem(`roles: unknown role "${role}" (roles: ${Object.keys(DEFAULTS.roles).join(", ")})`);
    if (!Array.isArray(chain) || chain.length === 0) problem(`roles.${role} must be a non-empty array of profile names`);
    const seen = new Set();
    for (const name of chain) {
      if (typeof name !== "string") problem(`roles.${role} must list profile names (strings)`);
      if (!Object.hasOwn(DEFAULTS.profiles, name) && !Object.hasOwn(profiles, name)) problem(`roles.${role}: unknown profile "${name}"`);
      if (seen.has(name)) problem(`roles.${role}: profile ${name} is listed twice`);
      seen.add(name);
    }
  }
}

function defaultHome(profile) {
  const keyed = authMode(profile.auth) === "key";
  if (profile.harness === "claude") return profile.auth === "login" ? "user" : "isolated";
  if (profile.harness === "opencode" || profile.harness === "pi") return keyed ? "isolated" : "user";
  return "user";
}

// A profile with the defaults of §3.4 applied: auth by harness, home by auth and harness, sandbox off, timeoutMin 60,
// maxParallel 2. Inproc profiles stay as written.
export function resolveProfile(raw) {
  const profile = structuredClone(raw);
  if (profile.harness === "inproc") return profile;
  profile.auth ??= DEFAULT_AUTH[profile.harness];
  if (CORE_HARNESSES.includes(profile.harness)) {
    profile.home ??= defaultHome(profile);
    profile.sandbox ??= "off";
    profile.timeoutMin ??= core.DEFAULT_TIMEOUT_MIN;
  }
  profile.maxParallel ??= core.DEFAULT_MAX_PARALLEL;
  return profile;
}

// V8 quotes a stretch of the text in some JSON errors (`Unexpected token 's', ..." { "key": sk-…"... is not valid
// JSON`); a key pasted unquoted into config.json would reach stderr that way. Only the error and its position are
// kept.
function jsonErrorText(error) {
  const message = String(error?.message ?? error);
  const where = message.match(/\(line \d+ column \d+\)/)?.[0] ?? message.match(/at position \d+/)?.[0] ?? "";
  const what = message.replace(/, .*is not valid JSON$/s, "").replace(/ \(line \d+ column \d+\)$/, "").replace(/ at position \d+$/, "").replace(/ in JSON$/, "");
  return `${what}${where ? ` ${where}` : ""}`;
}

function readConfig(env = process.env) {
  const file = core.dataPaths(env).config;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { file, exists: false, data: null, error: null };
    return { file, exists: true, data: null, error: `cannot read it (${error.code ?? error.message})` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { file, exists: true, data: null, error: `invalid JSON: ${jsonErrorText(error)}` };
  }
  try {
    validateConfig(data);
  } catch (error) {
    if (error instanceof ConfigProblem) return { file, exists: true, data, error: error.message };
    throw error;
  }
  return { file, exists: true, data, error: null };
}

// Built-in profiles and roles merged with a valid config.json (a user role replaces the built-in chain). With a
// broken config only the built-ins, and `error` says why. Never throws for a config problem.
export function loadState(env = process.env) {
  const config = readConfig(env);
  const user = config.error ? null : config.data;
  const profiles = new Map();
  const add = (name, raw, source) => profiles.set(name, { name, source, raw, p: resolveProfile(raw) });
  for (const [name, raw] of Object.entries(DEFAULTS.profiles)) add(name, raw, "built-in");
  for (const [name, raw] of Object.entries(user?.profiles ?? {})) add(name, raw, "config");
  const roles = { ...structuredClone(DEFAULTS.roles), ...structuredClone(user?.roles ?? {}) };
  return { ...config, profiles, roles, userRoles: new Set(Object.keys(user?.roles ?? {})) };
}

// The verbs other than doctor / profile / key refuse a broken config.json (spec §3.4).
function requireState(env = process.env) {
  const state = loadState(env);
  if (state.error) throw new UsageError(`config: ${state.file}: ${state.error}`);
  return state;
}

function requireProfile(state, name) {
  if (typeof name !== "string" || !name) throw new UsageError("requires --profile <name>");
  const entry = state.profiles.get(name);
  if (!entry) throw new UsageError(`unknown profile ${JSON.stringify(name)} (profiles: ${[...state.profiles.keys()].join(", ")})`);
  return entry;
}

function requireRole(role) {
  if (!Object.hasOwn(DEFAULTS.roles, role)) throw new UsageError(`unknown role ${JSON.stringify(role)} (roles: ${Object.keys(DEFAULTS.roles).join(", ")})`);
  return role;
}

// ---------- linked profiles (spec §3.5 "Общий ключ или вход") ----------

// The harnesses whose `login` holds one login per provider (`opencode auth login`, pi's /login: Copilot, ChatGPT,
// OpenCode Go, … side by side); the provider is the model's prefix before "/". A claude or codex login is one account
// for every model.
const PER_PROVIDER_LOGIN = new Set(["opencode", "pi"]);
const loginProvider = (profile) => (typeof profile.model === "string" && profile.model.indexOf("/") > 0 ? profile.model.split("/")[0] : "-");

// The scope of a login or native setup: "isolated" (the profile's own home), "provider" (an opencode or pi login in
// the user's home: one login per provider), "harness" (one for the whole harness), or null for a key or "none".
function loginScope(profile) {
  if (profile.harness === "inproc" || !(profile.auth === "login" || profile.auth === "native")) return null;
  if (profile.home === "isolated") return "isolated";
  if (profile.auth === "login" && PER_PROVIDER_LOGIN.has(profile.harness)) return "provider";
  return "harness";
}

// What a profile pays with: the same stored key / variable / command, the same login of the same harness (a login
// in an isolated home is the profile's own; an opencode or pi login is one per provider), the same `native` setup of
// a harness, or the same `shares` label.
function linkTokens(name, profile) {
  if (profile.harness === "inproc") return [];
  const tokens = [];
  const auth = profile.auth;
  const scope = loginScope(profile);
  if (isObject(auth)) {
    const [kind, value] = Object.entries(auth)[0];
    tokens.push(`${kind}:${JSON.stringify(value)}`);
  } else if (scope === "isolated") {
    tokens.push(`${auth}:${profile.harness}:${name}`);
  } else if (scope === "provider") {
    tokens.push(`login:${profile.harness}:provider:${loginProvider(profile)}`);
  } else if (scope === "harness") {
    tokens.push(`${auth}:${profile.harness}`);
  }
  if (profile.shares) tokens.push(`shares:${profile.shares}`);
  return tokens;
}

// channels' `auth`: the key source as authText prints it; a login or native setup with the scope it is linked by —
// `login:isolated` for the profile's own home, `login:<provider>` for an opencode or pi login.
function paysWith(profile) {
  const scope = loginScope(profile);
  if (scope === "isolated") return `${profile.auth}:isolated`;
  if (scope === "provider") return `login:${loginProvider(profile)}`;
  return authText(profile);
}

// name → the other profiles linked to it, transitively (union-find over the shared tokens).
export function linkedProfiles(state) {
  const parent = new Map([...state.profiles.keys()].map((name) => [name, name]));
  const find = (name) => {
    while (parent.get(name) !== name) name = parent.get(name);
    return name;
  };
  const owner = new Map();
  for (const [name, entry] of state.profiles) {
    for (const token of linkTokens(name, entry.p)) {
      if (owner.has(token)) parent.set(find(name), find(owner.get(token)));
      else owner.set(token, name);
    }
  }
  const groups = new Map();
  for (const name of state.profiles.keys()) {
    const root = find(name);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(name);
  }
  const linked = new Map();
  for (const members of groups.values()) for (const name of members) linked.set(name, members.filter((other) => other !== name).sort());
  return linked;
}

// ---------- routing (spec §3.3 route, §5.1, §5.3) ----------

// The kind of a role (agents-defaults.json roleKinds, spec §5.1): "write" edits files, "run" runs the project's
// commands and edits nothing (gate, phase reviews, integration check), "read" only reads. write and run take --write.
// Every chain runs as configured, in-session roles included (increment 6): an inproc profile is an Agent call, any
// other runs on its harness (agent-invocation "In-session roles on an external profile").
const roleKind = (role) => DEFAULTS.roleKinds[role];
const kindWrites = (kind) => kind !== "read";

function roleWriteWarning(role, write) {
  const kind = roleKind(role);
  if (write === kindWrites(kind)) return null;
  return write
    ? `task --role ${role}: ${role} is a read-only role; --write gives it write access`
    : `task --role ${role}: ${role} ${kind === "run" ? "runs the project's commands" : "writes files"} and needs --write; without it the harness runs read-only`;
}

function parseSkips(values) {
  const skips = [];
  for (const item of (values ?? []).flatMap((value) => value.split(","))) {
    const text = item.trim();
    if (!text) continue;
    const [profile, cls, ...rest] = text.split(":");
    if (rest.length > 0 || !NAME_RE.test(profile)) throw new UsageError(`--skip: invalid entry ${JSON.stringify(text)} (expected <profile>[:<class>])`);
    if (cls !== undefined && !SKIP_CLASSES.has(cls)) throw new UsageError(`--skip ${text}: unknown class ${JSON.stringify(cls)} (classes: ${[...SKIP_CLASSES].join(", ")})`);
    skips.push({ profile, cls: cls ?? "down" });
  }
  return skips;
}

function shownModel(profile) {
  const pass = PASS_THROUGH[profile.harness];
  return { model: pass?.pinned?.model ?? profile.model ?? "-", effort: pass?.pinned?.effort ?? profile.effort ?? "-" };
}

export function routeRole(state, role, skips = [], links = linkedProfiles(state)) {
  const chain = state.roles[role];
  const kind = roleKind(role);
  // A profile named in --skip is out with its class; with auth or quota its linked profiles go too, "via" it. A
  // direct entry wins over a linked one.
  const excluded = new Map(); // profile → { cls, via }
  for (const { profile, cls } of skips) if (!excluded.has(profile)) excluded.set(profile, { cls, via: null });
  for (const { profile, cls } of skips) {
    if (!LINKING_CLASSES.has(cls)) continue;
    for (const other of links.get(profile) ?? []) if (!excluded.has(other)) excluded.set(other, { cls, via: profile });
  }
  const remaining = chain.filter((name) => !excluded.has(name));
  const skipped = chain.filter((name) => excluded.has(name)).map((name) => ({ profile: name, class: excluded.get(name).cls, via: excluded.get(name).via }));
  const result = { role, kind, write: kindWrites(kind), profile: null, harness: null, model: null, effort: null, readOnly: null, maxParallel: null, inSession: false, chain: remaining, skipped, custom: state.userRoles.has(role), warnings: [] };
  const name = remaining[0];
  if (!name) return result;
  const profile = state.profiles.get(name).p;
  const inproc = profile.harness === "inproc";
  const shown = shownModel(profile);
  Object.assign(result, {
    profile: name,
    harness: profile.harness,
    model: shown.model,
    effort: shown.effort,
    readOnly: inproc ? "-" : READ_ONLY[profile.harness],
    maxParallel: inproc ? null : profile.maxParallel,
    inSession: inproc,
  });
  if (profile.harness === "zcode" && kind === "read") {
    result.warnings.push(`${name} has no read-only mode: the ${role} runs with write access (--mode yolo) and takes the ZCode reservation`);
  }
  return result;
}

const skippedText = (skipped) => skipped.map((s) => `${s.profile}=${s.class}${s.via ? `(via ${s.via})` : ""}`).join(", ");

export function routeLine(r) {
  if (!r.profile) return `route ${r.role}: no profile left (skipped: ${skippedText(r.skipped) || "-"})`;
  const tail = `chain: ${r.chain.join(", ")}${r.skipped.length > 0 ? `; skipped: ${skippedText(r.skipped)}` : ""}`;
  return `route ${r.role}: ${r.profile} harness=${r.harness} model=${r.model} effort=${r.effort} readOnly=${r.readOnly} maxParallel=${r.maxParallel ?? "-"} (${tail})`;
}

function routeAside(r) {
  for (const warning of r.warnings) errOut(`${CLI_NAME}: WARN route ${r.role}: ${warning}\n`);
}

// Roles whose chain differs from the built-in scheme (route --all, doctor).
function differingRoles(state) {
  return Object.keys(DEFAULTS.roles).filter((role) => !sameList(state.roles[role], DEFAULTS.roles[role]));
}

function cmdRoute(args) {
  const { values, positionals } = parse(args, { skip: { type: "string", multiple: true }, json: { type: "boolean" }, all: { type: "boolean" } }, 1);
  const state = requireState();
  if (values.all) {
    if (positionals.length > 0 || values.skip) throw new UsageError("route --all takes no role and no --skip");
    const links = linkedProfiles(state);
    const routes = differingRoles(state).map((role) => routeRole(state, role, [], links));
    if (values.json) out(`${JSON.stringify({ default: routes.length === 0, routes }, null, 2)}\n`);
    else if (routes.length === 0) out("routes: default\n");
    else for (const r of routes) out(`${routeLine(r)}\n`);
    return 0;
  }
  if (positionals.length !== 1) throw new UsageError("usage: agent-dispatch route ROLE [--skip p[:class],…] [--json] | route --all [--json]");
  const role = requireRole(positionals[0]);
  const r = routeRole(state, role, parseSkips(values.skip));
  routeAside(r);
  if (values.json) out(`${JSON.stringify(r.profile ? r : { ...r, error: "no profile left" }, null, 2)}\n`);
  else out(`${routeLine(r)}\n`);
  return r.profile ? 0 : 2;
}

function cmdChannels(args) {
  const { values } = parse(args, { json: { type: "boolean" } }, 0);
  const state = requireState();
  const links = linkedProfiles(state);
  const rows = [...state.profiles.values()].map(({ name, source, p }) => ({
    name,
    harness: p.harness,
    ...shownModel(p),
    auth: paysWith(p),
    shares: p.shares ?? null,
    linked: links.get(name) ?? [],
    source,
  }));
  if (values.json) out(`${JSON.stringify({ profiles: rows }, null, 2)}\n`);
  else {
    for (const row of rows) {
      out(`${row.name} harness=${row.harness} model=${row.model} effort=${row.effort} auth=${row.auth} linked=${row.linked.join(",") || "-"} source=${row.source}\n`);
    }
  }
  return 0;
}

// ---------- adapters ----------

const coreAdapters = new Map();

// The core adapter of a harness, or null when this version has none (spec §3.2: adapters/<harness>.mjs). A file that
// fails to import or exports the wrong id throws "<file>: <why>" (not cached: each caller sees the failure).
export async function loadCoreAdapter(harness, env = process.env) {
  if (!CORE_HARNESSES.includes(harness)) return null;
  if (coreAdapters.has(harness)) return coreAdapters.get(harness);
  let adapter = null;
  for (const dir of [env[ADAPTER_DIR_VAR], ADAPTERS_DIR].filter(Boolean)) {
    const file = path.join(path.resolve(dir), `${harness}.mjs`);
    if (!fs.existsSync(file)) continue;
    let loaded;
    try {
      loaded = (await import(pathToFileURL(file).href)).default;
    } catch (error) {
      throw new Error(`${file}: ${oneLine(error?.message ?? error, 300)}`, { cause: error });
    }
    if (!isObject(loaded) || loaded.id !== harness) throw new Error(`${file}: its id is ${JSON.stringify(loaded?.id)}, not ${JSON.stringify(harness)}`);
    adapter = loaded;
    break;
  }
  coreAdapters.set(harness, adapter);
  return adapter;
}

// The adapter a runner needs: only its job's harness, read from the record, so a broken adapter file of another
// harness never stops this job. An adapter that fails to load is left out: runJob then fails the job (launch, "no
// adapter for harness …") instead of leaving it running. An unreadable record gets every adapter; runJob decides.
async function runnerAdapters(id, jobsDir) {
  const record = core.isCoreJobId(id ?? "") && jobsDir ? core.readRecord(core.jobPaths(jobsDir, id).record) : null;
  const harnesses = CORE_HARNESSES.includes(record?.harness) ? [record.harness] : CORE_HARNESSES;
  const adapters = {};
  for (const harness of harnesses) {
    try {
      const adapter = await loadCoreAdapter(harness);
      if (adapter) adapters[harness] = adapter;
    } catch (error) {
      process.stderr.write(`${CLI_NAME}: adapter ${harness} failed to load: ${error?.message ?? error}\n`);
    }
  }
  return adapters;
}

async function requireCoreAdapter(name, harness) {
  let adapter;
  try {
    adapter = await loadCoreAdapter(harness);
  } catch (error) {
    throw new Error(`profile ${name}: adapter ${harness} failed to load: ${error?.message ?? error}`);
  }
  if (!adapter) throw new UsageError(`profile ${name}: harness ${harness} is not available in this version`);
  return adapter;
}

const wrapperPath = (pass, env = process.env) => env[pass.wrapper.envVar] || path.join(BIN_DIR, pass.wrapper.name);

// Runs a wrapper with stdio inherited: its stdout, stderr and exit code are the caller's (spec §3.3).
function runWrapper(pass, argv) {
  const file = wrapperPath(pass);
  const r = spawnSync(file, argv, { stdio: "inherit", env: process.env });
  if (r.error) throw new Error(`cannot run ${pass.wrapper.name} (${file}): ${r.error.code ?? r.error.message}`);
  if (r.status !== null) return r.status;
  return 128 + (os.constants.signals[r.signal] ?? 0);
}

// One wrapper store through `<wrapper> status --json`: { jobs } or { error }. The companion filters its snapshot by
// $CODEX_COMPANION_SESSION_ID. Merged status keeps the variable, so it lists what `<wrapper> status` lists; the write
// check (allSessions) leaves it out, so a live writer of another session still blocks.
function queryStore(pass, state, { cwd, all = false, allSessions = false } = {}) {
  const file = wrapperPath(pass);
  const argv = ["status", "--json", ...(cwd !== undefined ? ["--cwd", cwd] : []), ...(all ? ["--all"] : [])];
  const { CODEX_COMPANION_SESSION_ID: _session, ...unscoped } = process.env;
  const env = allSessions ? unscoped : process.env;
  const r = spawnSync(file, argv, { encoding: "utf8", env, timeout: STORE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { error: `cannot run ${file}: ${r.error.code ?? r.error.message}` };
  if (r.status !== 0) {
    const first = (r.stderr ?? "").trim().split("\n")[0];
    return { error: `${pass.wrapper.name} status --json exited ${r.status ?? r.signal}${first ? `: ${first}` : ""}` };
  }
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return { error: `${pass.wrapper.name} status --json printed no JSON` };
  }
  const zcodeName = [...state.profiles.values()].find((entry) => entry.p.harness === "zcode")?.name ?? "glm";
  const profiles = [...state.profiles.values()].filter((entry) => entry.p.harness === "codex").map((entry) => ({ name: entry.name, model: entry.p.model, effort: entry.p.effort }));
  return { jobs: pass.statusJobs(data, { profileName: zcodeName, profiles }) };
}

// spec §3.9: before a write task, the stores other than the task's own must hold no running write job in the same
// tree. A companion job blocks only while its worker pid lives (the companion never reaps a dead worker); a store
// that cannot be read is reported and does not block. Each store is asked about this tree only: the core by its
// workspace, the wrappers with `status --json --cwd <the tree's root>`, for every session.
function refuseForeignWriteJobs(state, { cwd, own }) {
  const ws = core.resolveWorkspace(path.resolve(cwd ?? process.cwd()));
  if (!ws) return; // not a git work tree: the task itself refuses
  const busy = (job) => new UsageError(`job ${job.id} (${job.profile}) is still running in this workspace; one write task per working tree`);
  if (own !== "core") {
    const job = core.listJobSummaries(ws.root).find((summary) => summary.status === "running" && summary.write);
    if (job) throw busy(job);
  }
  for (const pass of Object.values(PASS_THROUGH)) {
    if (pass.id === own) continue;
    const store = queryStore(pass, state, { cwd: ws.root, allSessions: true });
    if (store.error) {
      errOut(`${CLI_NAME}: WARN write check: ${store.error}; its jobs were not checked\n`);
      continue;
    }
    for (const job of store.jobs) {
      if (job.status !== "running" || !job.write) continue;
      if (pass.id !== "codex" || (Number.isInteger(job.pid) && core.isAlive(job.pid))) throw busy(job);
      errOut(`${CLI_NAME}: WARN write check: ${job.id} is recorded as a running write task, but its worker pid ${job.pid ?? "-"} is not alive; not blocking (a stale companion record: see the stale-lock note in codex-invocation)\n`);
    }
  }
}

// ---------- keys (spec §3.5) ----------

const keyFile = (name, env = process.env) => path.join(core.dataPaths(env).keys, name);

function readStoredKey(name, env = process.env) {
  try {
    return fs.readFileSync(keyFile(name, env), "utf8");
  } catch {
    return null;
  }
}

function runKeyCmd(argv, env = process.env) {
  const r = spawnSync(argv[0], argv.slice(1), { env, encoding: "utf8", timeout: KEY_CMD_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 });
  if (r.error?.code === "ETIMEDOUT") throw new Error(`keyCmd ${argv[0]} timed out after ${KEY_CMD_TIMEOUT_MS / 1000} s`);
  if (r.error) throw new Error(`keyCmd: cannot run ${argv[0]} (${r.error.code ?? r.error.message})`);
  if (r.signal) throw new Error(`keyCmd ${argv[0]} was killed by ${r.signal}`);
  if (r.status !== 0) throw new Error(`keyCmd ${argv[0]} exited ${r.status}`);
  return r.stdout; // never logged
}

// The core's resolveSecret for a profile: read lazily, only once the task passed every other check. Null for a
// profile without a key source (login / native / none).
export function resolveSecretFor(profile, env = process.env) {
  const auth = profile.auth;
  if (!isObject(auth)) return null;
  if ("key" in auth) {
    return async () => {
      const value = readStoredKey(auth.key, env);
      if (value === null) throw new Error(`no key ${auth.key} is stored; the user stores it: ${CLI_NAME} key set ${auth.key}`);
      return value;
    };
  }
  if ("keyEnv" in auth) {
    return async () => {
      const value = env[auth.keyEnv];
      if (value === undefined || value === "") throw new Error(`$${auth.keyEnv} is not set in the environment Claude Code runs in`);
      return value;
    };
  }
  return async () => runKeyCmd(auth.keyCmd, env);
}

async function cmdKey(args) {
  // Arguments past the name are never echoed: a key typed as an argument must not reach stderr.
  const [action, ...rest] = args;
  const paths = core.dataPaths();
  if (action === "set") {
    if (rest.length === 0) throw new UsageError(`usage: ${CLI_NAME} key set NAME (the key comes on stdin or at the hidden prompt)`);
    if (rest.length > 1) {
      throw new UsageError(`key set takes the key on stdin or at the hidden prompt, never as an argument (e.g. pbpaste | ${CLI_NAME} key set <name>, or xclip -o -selection clipboard | … on Linux); nothing stored`);
    }
    const name = rest[0];
    if (!NAME_RE.test(name)) throw new UsageError(`invalid key name (expected ${NAME_RE}; the argument is not echoed); nothing stored`);
    const key = core.checkKeyText(await core.readSecretLine(`Key ${name} (input hidden): `));
    core.ensurePrivateDir(paths.root);
    core.ensurePrivateDir(paths.keys);
    core.writePrivateFile(keyFile(name), key, 0o600);
    out(`key ${name}: stored in ${keyFile(name)} (mode 0600)\n`);
    return 0;
  }
  if (action === "list") {
    if (rest.length > 0) throw new UsageError(`usage: ${CLI_NAME} key list`);
    let names = [];
    try {
      names = fs.readdirSync(paths.keys).filter((name) => NAME_RE.test(name) && fs.statSync(path.join(paths.keys, name)).isFile());
    } catch {
      names = [];
    }
    for (const name of names.sort()) out(`${name}\n`);
    return 0;
  }
  if (action === "rm") {
    if (rest.length !== 1 || !NAME_RE.test(rest[0])) throw new UsageError(`usage: ${CLI_NAME} key rm NAME`);
    const file = keyFile(rest[0]);
    if (!fs.existsSync(file)) throw new UsageError(`no key ${rest[0]} in ${paths.keys}`);
    fs.rmSync(file, { force: true });
    out(`key ${rest[0]}: removed\n`);
    return 0;
  }
  throw new UsageError(`usage: ${CLI_NAME} key <set NAME|list|rm NAME> (set reads the key on stdin or at a hidden prompt)`);
}

// ---------- task / status / result / cancel / release-stale ----------

function parse(args, options, maxPositionals, minPositionals = 0) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const count = parsed.positionals.length;
  if (count > maxPositionals || count < minPositionals) {
    // Not echoed: a stray argument may be a key typed in the wrong place (profile add NAME <key> …).
    const want = minPositionals === maxPositionals ? `${maxPositionals}` : `${minPositionals}–${maxPositionals}`;
    throw new UsageError(`unexpected arguments: ${want} positional argument(s) expected, ${count} given (not echoed)`);
  }
  return parsed;
}

// The wrapper that owns a job id (zt- → zcode-dispatch, task- → codex-dispatch), or null for a core id.
function wrapperOfId(args) {
  let positionals;
  try {
    ({ positionals } = parseArgs({ args, options: { cwd: { type: "string" } }, allowPositionals: true, strict: false }));
  } catch {
    return null;
  }
  const id = positionals[0] ?? "";
  return Object.values(PASS_THROUGH).find((pass) => id.startsWith(pass.idPrefix)) ?? null;
}

async function cmdTask(args) {
  const { values } = parse(
    args,
    {
      profile: { type: "string" },
      role: { type: "string" },
      background: { type: "boolean" },
      write: { type: "boolean" },
      cwd: { type: "string" },
      "resume-task": { type: "string" },
      fresh: { type: "boolean" },
      "prompt-file": { type: "string" },
    },
    0,
  );
  if (!values.background) throw new UsageError("task requires --background (there is no foreground mode)");
  if (values["resume-task"] !== undefined && values.fresh) throw new UsageError("--resume-task and --fresh are mutually exclusive");
  if (values.profile === undefined) throw new UsageError("task requires --profile <name> (see: agent-dispatch route <role>)");
  const state = requireState();
  const { name, p } = requireProfile(state, values.profile);
  if (values.role !== undefined) requireRole(values.role);
  const write = values.write === true;

  if (p.harness === "inproc") {
    throw new UsageError(`profile ${name} runs in-session (harness inproc): dispatch it with the Agent tool (model=${p.model} effort=${p.effort ?? "-"}), not with task`);
  }
  const pass = PASS_THROUGH[p.harness];
  // --role records the role and checks --write against its kind: one WARN, never a refusal. zcode always writes;
  // its own WARN covers a missing --write.
  if (values.role !== undefined && !pass?.alwaysWrites) {
    const warning = roleWriteWarning(values.role, write);
    if (warning) errOut(`${CLI_NAME}: WARN ${warning}\n`);
  }

  if (pass) {
    const promptFile = values["prompt-file"];
    if (!promptFile) throw new UsageError("task requires --prompt-file <file>");
    const resumeTaskId = values["resume-task"];
    if (resumeTaskId !== undefined && !pass.resumeIdOk(resumeTaskId)) {
      throw new UsageError(`${resumeTaskId} cannot resume on profile ${name}: ids do not move between harnesses (${p.harness} resumes ${pass.idPrefix} ids only); dispatch --fresh`);
    }
    if (write || pass.alwaysWrites) refuseForeignWriteJobs(state, { cwd: values.cwd, own: pass.id });
    for (const warning of pass.taskWarnings({ profileName: name, write })) errOut(`${CLI_NAME}: WARN ${warning}\n`);
    return runWrapper(pass, pass.taskArgv({ profile: p, write, cwd: values.cwd, resumeTaskId, fresh: values.fresh === true, promptFile }));
  }

  const adapter = await requireCoreAdapter(name, p.harness);
  if (write) refuseForeignWriteJobs(state, { cwd: values.cwd, own: "core" });
  const { id } = await core.startJob({
    adapter,
    profileName: name,
    profile: p,
    role: values.role ?? null,
    write,
    cwd: values.cwd,
    promptFile: values["prompt-file"],
    resumeTaskId: values["resume-task"] ?? null,
    resolveSecret: resolveSecretFor(p),
    cliPath: SELF,
  });
  out(`${core.startLine(name, id)}\n`);
  return 0;
}

function cmdStatus(args) {
  const state = requireState();
  const pass = wrapperOfId(args);
  if (pass) return runWrapper(pass, ["status", ...args]);
  const { values, positionals } = parse(args, { cwd: { type: "string" }, json: { type: "boolean" }, all: { type: "boolean" } }, 1);
  if (positionals.length === 1) return core.statusCommand({ cwd: values.cwd, id: positionals[0], json: values.json === true, all: values.all === true });
  // Without an id: the jobs of this tree in all three stores (spec §3.3, C19). A store whose wrapper fails is one
  // stderr line, not a failure.
  const jobs = core.listJobSummaries(values.cwd, { all: values.all === true }).map((summary) => ({
    id: summary.id,
    profile: summary.profile,
    role: summary.role,
    harness: PREFIX_HARNESS[summary.id.slice(0, 2)] ?? null,
    status: summary.status,
    errorClass: summary.errorClass,
    write: summary.write,
    cwd: summary.cwd,
  }));
  for (const wrapper of Object.values(PASS_THROUGH)) {
    const store = queryStore(wrapper, state, { cwd: values.cwd, all: values.all === true });
    if (store.error) {
      errOut(`${CLI_NAME}: status: ${wrapper.wrapper.name} store skipped (${store.error})\n`);
      continue;
    }
    for (const { pid: _pid, ...job } of store.jobs) jobs.push(job);
  }
  const ordered = [...jobs.filter((job) => job.status === "running"), ...jobs.filter((job) => job.status !== "running")];
  if (values.json) out(`${JSON.stringify({ jobs: ordered }, null, 2)}\n`);
  else for (const job of ordered) out(`${core.summaryLine(job)}\n`);
  return 0;
}

async function cmdJobVerb(verb, args) {
  requireState();
  const pass = wrapperOfId(args);
  if (pass) return runWrapper(pass, [verb, ...args]);
  const { values, positionals } = parse(args, { cwd: { type: "string" } }, 1, 1);
  if (verb === "result") return core.resultCommand({ cwd: values.cwd, id: positionals[0] });
  return await core.cancelCommand({ cwd: values.cwd, id: positionals[0] });
}

// ---------- tree-state (agent-invocation "In-session roles on an external profile", item 4) ----------

// The content of a work tree — tracked and untracked files; ignored files and .superpowers/ (the orchestrator's
// workspace: prompts, reports, packages; files git tracks there too) left out — as one git tree id. A submodule or a
// nested repository counts by its HEAD and by its own content (this id, recursively), so an edit inside it changes the
// id as a moved HEAD does. It is written through a temporary index, so the real index, HEAD, refs and the
// files stay as they are; git only gains loose objects, as with `git stash create`. The orchestrator takes it right
// before and right after a job that must not edit files. A tree git cannot index (a nested repository without a
// commit, an unreadable file) is an error carrying git's whole message, the paths it names included.
function gitOut(cwd, argv, env = process.env, input = undefined, options = []) {
  const r = spawnSync("git", [...options, ...argv], { cwd, env, input, encoding: "utf8", timeout: STORE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    const said = String(r.error?.message || r.stderr || `exit ${r.status}`).split("\n").filter((line) => line.trim() && !line.startsWith("hint:"));
    throw new Error(`git ${argv[0]} failed: ${said.join("\n").trim()}`);
  }
  return r.stdout;
}

export function treeState(root) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dispatch-tree-"));
  try {
    // core.ignorestat can reintroduce assume-unchanged even in a new index; fsmonitor can declare paths unchanged.
    // Override both for these commands only, leaving the repository's config and the real index unchanged.
    const git = (argv, env, input) => gitOut(root, argv, env, input, ["-c", "core.ignorestat=false", "-c", "core.fsmonitor=false"]);
    const index = path.join(tmp, "index");
    // Rebuild from the staged entries, not a byte copy: assume-unchanged, fsmonitor-valid and cached stat data can
    // otherwise make git add trust an old blob despite changed bytes. ls-files expands a sparse index in memory;
    // optional locks are disabled so that neither this nor a split-index refresh can rewrite the user's index.
    const readEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const entries = git(["ls-files", "--stage", "-z"], readEnv);
    const absentSparse = git(["ls-files", "-t", "-z"], readEnv).split("\0")
      .filter((entry) => {
        if (!entry.startsWith("S ")) return false;
        try {
          return !fs.lstatSync(path.join(root, entry.slice(2)), { throwIfNoEntry: false });
        } catch (error) {
          // A file replacing an ancestor directory is a real edit, not an unpopulated sparse path.
          if (error.code === "ENOTDIR") return false;
          throw error;
        }
      })
      .map((entry) => `${entry.slice(2)}\0`).join("");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(["update-index", "-z", "--index-info"], env, entries);
    // An absent skip-worktree path has no working bytes (a normal sparse checkout); retain its staged blob. Present
    // paths, including dangling symlinks, keep no skip flag and are always read by git add below.
    if (absentSparse) git(["update-index", "--skip-worktree", "-z", "--stdin"], env, absentSparse);
    // As bin/review-package: exclude .superpowers unless the repo already ignores it (git add then refuses the named
    // ignored path, and skips the directory anyway). A sparse checkout needs --sparse (git 2.34+), or git add refuses a
    // path outside its cone and keeps the old content of a file written back there.
    const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", ".superpowers"], { cwd: root }).status === 0;
    const sparse = spawnSync("git", ["config", "--bool", "core.sparseCheckout"], { cwd: root, encoding: "utf8" }).stdout?.trim() === "true";
    git(["add", "-A", ...(sparse ? ["--sparse"] : []), "--", ".", ...(ignored ? [] : [":(exclude).superpowers"])], env);
    const workspace = [];
    for (const entry of git(["ls-files", "-s", "-z"], env).split("\0")) {
      const [, mode, name] = /^(\d+) [0-9a-f]+ \d\t(.+)$/s.exec(entry) ?? [];
      // What git already tracks under .superpowers/ leaves the temporary index too.
      if (name === ".superpowers" || name?.startsWith(".superpowers/")) workspace.push(name);
      // git add records a submodule or a nested repository by its HEAD alone (a gitlink); a checked-out one gets an id
      // of its HEAD and its content instead. One that is not checked out has nothing to edit.
      else if (mode === "160000" && fs.existsSync(path.join(root, name, ".git"))) {
        const dir = path.join(root, name);
        const id = git(["hash-object", "--stdin"], process.env, `${gitOut(dir, ["rev-parse", "HEAD"]).trim()} ${treeState(dir)}\n`).trim();
        git(["update-index", "--cacheinfo", `160000,${id},${name}`], env);
      }
    }
    if (workspace.length > 0) git(["update-index", "--force-remove", "-z", "--stdin"], env, workspace.map((name) => `${name}\0`).join(""));
    return git(["write-tree"], env).trim();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// A changed path as one item of the one-line list: quoted when a control character, ", " or a leading quote would
// split the line or blur the list.
const shownPath = (name) => (/[\x00-\x1f\x7f]|, |^"/.test(name) ? JSON.stringify(name) : name);

// The changed paths between two tree ids, nested repositories first: a path whose mode is 160000 on either side (a
// submodule or a nested repository, a gitlink) as "<path> (nested repository)". The parent's revert patch carries only
// a gitlink line for one, which `git apply` skips, so the orchestrator names them apart; listed first, the 10-path cap
// of the line never hides one.
function changedPaths(root, since, tree) {
  const raw = gitOut(root, ["diff-tree", "-r", "--no-renames", "--ignore-submodules=none", "--raw", "-z", since, tree]).split("\0");
  const nested = [];
  const plain = [];
  // -z --raw: ":<mode> <mode> <id> <id> <status>" and the path, as two fields (one path each without renames).
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [srcMode, dstMode] = raw[i].slice(1).split(" ");
    if (srcMode === "160000" || dstMode === "160000") nested.push(`${shownPath(raw[i + 1])} (nested repository)`);
    else plain.push(shownPath(raw[i + 1]));
  }
  return [...nested, ...plain];
}

function cmdTreeState(args) {
  const { values } = parse(args, { cwd: { type: "string" }, since: { type: "string" } }, 0);
  const since = values.since;
  const sinceUsage = "--since takes the tree id an earlier tree-state printed";
  if (since !== undefined && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(since)) throw new UsageError(sinceUsage);
  const { root } = core.requireWorkspace(values.cwd);
  const tree = treeState(root);
  if (since === undefined) out(`tree ${tree}\n`);
  else if (since === tree) out(`tree ${tree}: unchanged\n`);
  else {
    // Only a whole tree id of this repository: a commit id, or an abbreviation (40 hex digits in a sha256 repo), names
    // the same content under another spelling and would read as changed with no path to name.
    const type = spawnSync("git", ["cat-file", "-t", since], { cwd: root, encoding: "utf8", timeout: STORE_TIMEOUT_MS });
    if (since.length !== tree.length || type.status !== 0 || type.stdout.trim() !== "tree") throw new UsageError(sinceUsage);
    const changed = changedPaths(root, since, tree);
    const shown = changed.slice(0, 10).join(", ") + (changed.length > 10 ? ` (+${changed.length - 10} more)` : "");
    out(`tree ${tree}: changed since ${since.slice(0, 7)}: ${shown}\n`);
  }
  return 0;
}

function cmdReleaseStale(args) {
  requireState();
  const { values } = parse(args, { cwd: { type: "string" } }, 0);
  return core.releaseStaleCommand({ cwd: values.cwd });
}

// ---------- profile / preset ----------

function lenientState() {
  const state = loadState();
  if (state.error) errOut(`${CLI_NAME}: config: ${state.file}: ${state.error} (built-in profiles only until it is fixed)\n`);
  return state;
}

const NUMBER_SETTINGS = new Set(["timeoutMin", "maxParallel", "options.maxTurns"]);
const BOOLEAN_SETTINGS = new Set(["options.plugins", "options.sessionLog"]);
const JSON_SETTINGS = new Set(["auth", "auth.keyCmd", "wrap", "options.settings", "options.permission", "options.patch", "options.extensions"]);

// One --set k=v of profile add: a field, or auth.<source>, env.<NAME>, options.<name>. An empty value removes the
// field or the option (`--set maxParallel=` drops the preset's maxParallel); env values stay strings, empty included
// (`--set env.ANTHROPIC_API_KEY=` is the empty variable some recipes need); `auth.<source>=` leaves an empty source
// that validation refuses.
function applySetting(raw, assignment) {
  const eq = assignment.indexOf("=");
  // The text after "=" may be a key typed in the wrong place: only the part before it is ever echoed.
  if (eq <= 0) throw new UsageError(`--set expects key=value${eq < 0 ? "" : " (the key part is empty)"}`);
  const key = assignment.slice(0, eq);
  const text = assignment.slice(eq + 1);
  const parts = key.split(".");
  if (!ALL_FIELDS.has(parts[0])) throw new UsageError(`--set ${key}: unknown field "${parts[0]}"`);
  if (parts.length > 2 || (parts.length === 2 && !["auth", "env", "options"].includes(parts[0])) || (parts.length === 1 && ["env", "options"].includes(parts[0]))) {
    throw new UsageError(`--set ${key}: use a field, auth.<key|keyEnv|keyCmd>, env.<NAME> or options.<name>`);
  }
  if (text === "" && parts.length === 1) {
    delete raw[key];
    return;
  }
  if (text === "" && parts[0] === "options") {
    if (isObject(raw.options)) {
      const { [parts[1]]: _dropped, ...rest } = raw.options;
      if (Object.keys(rest).length > 0) raw.options = rest;
      else delete raw.options;
    }
    return;
  }
  let value = text;
  if (parts[0] !== "env") {
    if (NUMBER_SETTINGS.has(key)) {
      value = Number(text);
      if (text === "" || !Number.isFinite(value)) throw new UsageError(`--set ${key}: expected a number`);
    } else if (BOOLEAN_SETTINGS.has(key)) {
      if (text !== "true" && text !== "false") throw new UsageError(`--set ${key}: expected true or false`);
      value = text === "true";
    } else if (JSON_SETTINGS.has(key) && /^[[{]/.test(text)) {
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new UsageError(`--set ${key}: invalid JSON (${jsonErrorText(error)})`);
      }
    }
  }
  if (parts.length === 1) {
    raw[key] = value;
  } else if (parts[0] === "auth") {
    raw.auth = { [parts[1]]: value };
  } else {
    raw[parts[0]] = { ...(isObject(raw[parts[0]]) ? raw[parts[0]] : {}), [parts[1]]: value };
  }
}

function placeholdersDeep(value, found = new Set()) {
  if (typeof value === "string") for (const hole of placeholdersIn(value)) found.add(hole);
  else if (Array.isArray(value)) for (const item of value) placeholdersDeep(item, found);
  else if (isObject(value)) for (const item of Object.values(value)) placeholdersDeep(item, found);
  return found;
}

function writeConfigFile(file, data) {
  core.ensurePrivateDir(path.dirname(file));
  core.writePrivateFile(file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
}

function profileAdd(rest) {
  const { values, positionals } = parse(
    rest,
    { from: { type: "string" }, model: { type: "string" }, key: { type: "string" }, set: { type: "string", multiple: true } },
    1,
    1,
  );
  const name = positionals[0];
  if (!values.from) throw new UsageError(`usage: ${CLI_NAME} profile add NAME --from PRESET [--model M] [--key K] [--set k=v]…`);
  if (Object.hasOwn(DEFAULTS.profiles, name)) throw new UsageError(`profile ${name} is built in and cannot be overridden; choose a new name`);
  if (RESERVED_NAMES.includes(name)) throw new UsageError(`profile name ${name} is reserved (${RESERVED_NAMES.join(", ")})`);
  if (!NAME_RE.test(name)) throw new UsageError(`invalid profile name ${JSON.stringify(name)} (expected ${NAME_RE})`);
  const preset = DEFAULTS.presets[values.from];
  if (!preset) throw new UsageError(`unknown preset ${JSON.stringify(values.from)} (presets: ${Object.keys(DEFAULTS.presets).join(", ")})`);
  const state = loadState();
  if (state.error) throw new UsageError(`config: ${state.file}: ${state.error}; fix it before adding a profile; nothing written`);
  if (state.profiles.has(name)) throw new UsageError(`profile ${name} already exists in ${state.file}; nothing written`);

  const raw = structuredClone(preset);
  if (values.model !== undefined) raw.model = values.model;
  if (values.key !== undefined) {
    if (!(isObject(preset.auth) && "key" in preset.auth)) throw new UsageError(`--key applies to presets with a stored key; ${values.from} uses auth ${authText(preset)}`);
    raw.auth = { key: values.key };
  }
  for (const assignment of values.set ?? []) applySetting(raw, assignment);
  const holes = [...placeholdersDeep(raw)];
  if (holes.length > 0) {
    throw new UsageError(`profile ${name}: fill the placeholder(s) ${holes.join(" ")} (--model M, --key K, --set field=value); nothing written`);
  }
  const data = state.exists ? structuredClone(state.data) : { version: 1, profiles: {}, roles: {} };
  data.profiles = { ...(data.profiles ?? {}), [name]: raw };
  try {
    validateConfig(data);
  } catch (error) {
    if (error instanceof ConfigProblem) throw new UsageError(`${error.message}; nothing written`);
    throw error;
  }
  writeConfigFile(state.file, data);
  const p = resolveProfile(raw);
  out(`profile ${name}: added to ${state.file} (preset ${values.from}, harness ${p.harness})\n`);
  const first = firstStep(name, p);
  out(`next: ${first ? `${first}, then ` : ""}${CLI_NAME} doctor --profile ${name} --probe\n`);
  return 0;
}

// The one-time action of spec §4.3 before a profile works: store its key, or log in (in its isolated home through
// `profile env P -- <login command>`), or give dsh its key file. Null when there is none (keyEnv, keyCmd, none).
function firstStep(name, p) {
  if (isObject(p.auth)) return "key" in p.auth ? `${CLI_NAME} key set ${p.auth.key}` : null;
  const isolated = p.home === "isolated";
  if (p.auth === "login") return `log in: ${isolated ? `${CLI_NAME} profile env ${name} -- ` : ""}${LOGIN_STEP[p.harness] ?? p.harness}`;
  if (p.auth === "native" && p.harness === "dsh") {
    if (isolated) return `put DEEPSEEK_API_KEY=… into .env (mode 0600) of the DSH_HOME that ${CLI_NAME} profile env ${name} prints`;
    return "put DEEPSEEK_API_KEY=… into $DSH_HOME/.env (default ~/.dsh/.env, mode 0600)";
  }
  return null;
}

const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;

// `profile env P -- COMMAND`: COMMAND runs with stdio inherited and the profile's variables over the caller's
// environment, and its exit code is ours (128 + the signal's number when a signal ended it; 127 when it cannot be
// found and 126 when it cannot start, as env(1) does). Only its name is ever echoed: an argument may be a secret.
function runWithEnv(argv, vars) {
  const r = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", env: { ...process.env, ...vars } });
  if (r.error) {
    errOut(`${CLI_NAME}: cannot run ${argv[0]}: ${r.error.code ?? r.error.message}\n`);
    return r.error.code === "ENOENT" ? 127 : 126;
  }
  if (r.status !== null) return r.status;
  return 128 + (os.constants.signals[r.signal] ?? 0);
}

// spec §3.3, §4.3: the variables that point the harness at a profile's isolated home, so the user logs in there.
// `profile env P -- opencode auth login` runs the login with them: no eval, nothing stays in the user's shell, and a
// refusal runs nothing (an eval of the empty output of a refused `profile env P` would log in to the default home).
// `profile env P` alone prints them as `export` lines. The variables are the adapter's loginEnv when it has one, else
// the env of its prepareHome — the home the jobs use; the directories are created 0700. A claude API profile has
// nothing to log into: its home must hold no login (spec §3.6 A1), so nothing is exported for it and no command runs.
// A keyed opencode or pi profile is told that a login stored in its home would win over its key.
async function profileEnv(rest) {
  const sep = rest.indexOf("--");
  const command = sep < 0 ? null : rest.slice(sep + 1);
  const { positionals } = parse(sep < 0 ? rest : rest.slice(0, sep), {}, 1, 1);
  if (command?.length === 0) throw new UsageError(`usage: ${CLI_NAME} profile env P [-- COMMAND [ARGS…]] (no command after --)`);
  const state = lenientState();
  const { name, p } = requireProfile(state, positionals[0]);
  if (!CORE_HARNESSES.includes(p.harness)) throw new UsageError(`profile env applies to claude, opencode, pi and dsh profiles; ${name} is harness ${p.harness}`);
  const nothing =
    p.home !== "isolated"
      ? `profile ${name} uses the harness's own home ("home": "user"); nothing to export`
      : p.harness === "claude" && p.auth !== "login"
        ? `profile ${name} is a claude API profile: its isolated home must hold no claude.ai login (spec §3.6 A1); nothing to export`
        : null;
  if (nothing && command) throw new UsageError(`${nothing}; ${command[0]} not run`);
  if (nothing) {
    out(`# ${nothing}\n`);
    return 0;
  }
  const adapter = await requireCoreAdapter(name, p.harness);
  const ctx = core.makeCtx({ profile: p, profileName: name });
  // The home as a task prepares it (its dirs and files, e.g. opencode's git config that points git back at the
  // user's), so the login finds the same home as the jobs.
  const home = typeof adapter.prepareHome === "function" ? ((await adapter.prepareHome(p, ctx)) ?? {}) : {};
  const source = typeof adapter.loginEnv === "function" ? "loginEnv()" : "prepareHome() env";
  const env = typeof adapter.loginEnv === "function" ? await adapter.loginEnv(p, ctx) : home.env;
  const entries = (isObject(env) ? Object.entries(env) : []).filter(([, value]) => value !== null && value !== undefined);
  if (entries.length === 0) throw new UsageError(`profile ${name}: the ${p.harness} adapter names no home variables (${source}); nothing to export`);
  const bad = entries.find(([variable, value]) => !ENV_NAME_RE.test(variable) || typeof value !== "string" || value === "");
  if (bad) throw new Error(`the ${p.harness} adapter's ${source} returned an invalid entry ${JSON.stringify(bad[0])}`);
  const paths = core.dataPaths();
  const dir = path.join(paths.homes, name);
  core.ensurePrivateDir(paths.root);
  core.ensurePrivateDir(paths.homes);
  core.ensurePrivateDir(dir);
  core.writeAdapterFiles({ dirs: home.dirs ?? [], files: home.files ?? [] });
  for (const [, value] of entries) if (value.startsWith(`${dir}${path.sep}`)) core.ensurePrivateDir(value);
  // A keyed profile's home is isolated so that no stored login outranks the key (spec §3.4).
  const keyed = (p.harness === "opencode" || p.harness === "pi") && authMode(p.auth) === "key";
  const keyedNote = keyed ? `keyed profile: nothing to log into here; a login stored in this home would win over ${p.keyVar}` : null;
  if (command) {
    if (keyedNote) errOut(`${CLI_NAME}: WARN profile ${name}: ${keyedNote}\n`);
    return runWithEnv(command, Object.fromEntries(entries));
  }
  if (keyedNote) out(`# ${keyedNote}\n`);
  for (const [variable, value] of entries) out(`export ${variable}=${shellQuote(value)}\n`);
  return 0;
}

async function cmdProfile(args) {
  const [action, ...rest] = args;
  if (action === "list") {
    const { values } = parse(rest, { json: { type: "boolean" } }, 0);
    const state = lenientState();
    const rows = [...state.profiles.values()].map(({ name, source, p }) => ({ name, harness: p.harness, ...shownModel(p), source }));
    if (values.json) out(`${JSON.stringify({ profiles: rows }, null, 2)}\n`);
    else for (const row of rows) out(`${row.name} harness=${row.harness} model=${row.model} effort=${row.effort} source=${row.source}\n`);
    return 0;
  }
  if (action === "show") {
    const { positionals } = parse(rest, {}, 1, 1);
    const state = lenientState();
    const { name, source, p } = requireProfile(state, positionals[0]);
    out(`${JSON.stringify({ name, source, linked: linkedProfiles(state).get(name) ?? [], profile: p }, null, 2)}\n`);
    return 0;
  }
  if (action === "add") return profileAdd(rest);
  if (action === "env") return await profileEnv(rest);
  throw new UsageError(`usage: ${CLI_NAME} profile <list|show P|add NAME --from PRESET …|env P [-- COMMAND [ARGS…]]>`);
}

function cmdPreset(args) {
  const [action, ...rest] = args;
  if (action !== "list") throw new UsageError(`usage: ${CLI_NAME} preset list [--json]`);
  const { values } = parse(rest, { json: { type: "boolean" } }, 0);
  if (values.json) {
    out(`${JSON.stringify({ presets: DEFAULTS.presets }, null, 2)}\n`);
    return 0;
  }
  for (const [name, preset] of Object.entries(DEFAULTS.presets)) {
    const holes = [...placeholdersDeep(preset)];
    const parts = [
      name,
      `harness=${preset.harness}`,
      `auth=${authText(preset)}`,
      `model=${preset.model ?? "-"}`,
      ...(preset.effort ? [`effort=${preset.effort}`] : []),
      ...(preset.endpoint ? [`endpoint=${preset.endpoint}`] : []),
      ...(preset.keyVar ? [`keyVar=${preset.keyVar}`] : []),
      ...(preset.shares ? [`shares=${preset.shares}`] : []),
    ];
    out(`${parts.join(" ")}${holes.length > 0 ? ` (fill: ${holes.join(" ")})` : ""}\n`);
  }
  return 0;
}

// ---------- doctor (spec §5.4): no model call unless --probe ----------

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function onPath(command) {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).some((dir) => isExecutable(path.join(dir, command)));
}

function checkKey(name, p, report) {
  const auth = p.auth;
  if (!isObject(auth)) {
    const scope = loginScope(p);
    const enter = auth === "login" ? `log in there: ${CLI_NAME} profile env ${name} -- ${LOGIN_STEP[p.harness] ?? p.harness}` : `${CLI_NAME} profile env ${name} prints it`;
    const where = scope === "isolated" ? ` in its isolated home (${enter})` : scope === "provider" ? ` of provider ${loginProvider(p)}` : "";
    const what = { login: `the ${p.harness} login${where}`, native: `${p.harness}'s own configuration${scope === "isolated" ? where : ""}`, none: "no key (a local model)" }[auth];
    report("ok", `auth ${name}`, `${auth}: ${what}`);
    return;
  }
  if ("key" in auth) {
    const file = keyFile(auth.key);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) return report("FAIL", `key ${name}`, `no key ${auth.key} is stored; the user stores it: ${CLI_NAME} key set ${auth.key}`);
    if (!(readStoredKey(auth.key) ?? "").trim()) return report("FAIL", `key ${name}`, `${file} is empty; store the key again: ${CLI_NAME} key set ${auth.key}`);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) return report("WARN", `key ${name}`, `${file} has mode ${mode.toString(8)}, expected 600`);
    return report("ok", `key ${name}`, `${auth.key} in ${file} (mode 0600)`);
  }
  if ("keyEnv" in auth) {
    if (process.env[auth.keyEnv]) return report("ok", `key ${name}`, `$${auth.keyEnv} is set`);
    return report("FAIL", `key ${name}`, `$${auth.keyEnv} is not set in the environment Claude Code runs in`);
  }
  try {
    const value = runKeyCmd(auth.keyCmd).trim();
    if (!value) return report("FAIL", `key ${name}`, `keyCmd ${auth.keyCmd[0]} printed nothing`);
    if (/\s/.test(value)) return report("FAIL", `key ${name}`, `keyCmd ${auth.keyCmd[0]} printed more than one token`);
    return report("ok", `key ${name}`, `keyCmd ${auth.keyCmd[0]} exited 0 with a value`);
  } catch (error) {
    return report("FAIL", `key ${name}`, error.message);
  }
}

function checkSandbox(name, p, report) {
  if (p.sandbox !== "native") return;
  if (p.harness === "opencode" || p.harness === "pi") {
    report("WARN", `sandbox ${name}`, `${p.harness} has no sandbox of its own; "sandbox": "native" does nothing — use "wrap" (spec §3.7)`);
    return;
  }
  if (process.platform === "darwin") {
    if (isExecutable("/usr/bin/sandbox-exec")) report("ok", `sandbox ${name}`, "native: /usr/bin/sandbox-exec (Seatbelt)");
    else report("FAIL", `sandbox ${name}`, "native: /usr/bin/sandbox-exec not found");
    return;
  }
  const needed = p.harness === "claude" ? ["bwrap", "socat"] : ["bwrap"];
  const missing = needed.filter((command) => !onPath(command));
  if (missing.length === 0) report("ok", `sandbox ${name}`, `native: ${needed.join(", ")} found`);
  else if (p.harness === "dsh") report("WARN", `sandbox ${name}`, `native: bwrap not found; dsh then needs Landlock (not checked)`);
  else report("FAIL", `sandbox ${name}`, `native: ${missing.join(", ")} not found on PATH`);
}

const oneLine = (text, limit = 160) => {
  const line = String(text ?? "").trim().split("\n")[0].trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

// Whether an adapter's FAIL check rows name all of a refusal's text (without its "profile P: "): each part of it is
// a row's hint, or a hint up to one of its "; " (claude adds "; every task is refused"), so a refusal that joins two
// causes is named by the two rows that report them. A WARN row does not count, nor does a row that cannot be read.
function namedByFailRows(rows, refusal) {
  try {
    const hints = (Array.isArray(rows) ? rows : []).filter((row) => row?.level === "FAIL" && typeof row.hint === "string").map((row) => row.hint);
    const stems = hints.flatMap((hint) => [hint, ...[...hint.matchAll(/; /g)].map((match) => hint.slice(0, match.index))]).filter(Boolean);
    let rest = refusal;
    for (const stem of stems.sort((a, b) => b.length - a.length)) rest = rest.split(stem).join("\0");
    return rest.includes("\0") && /^[\0;\s]*$/.test(rest);
  } catch {
    return false;
  }
}

// `codex-dispatch setup --json`, once per doctor run: the companion runs `codex --version` and asks its app-server
// for the login (no model call; its review-gate flags are never passed, so it changes nothing). { report } or
// { error }.
function codexSetup(checks) {
  if (checks.codexSetup) return checks.codexSetup;
  const pass = PASS_THROUGH.codex;
  const file = wrapperPath(pass);
  const r = spawnSync(file, ["setup", "--json"], { encoding: "utf8", env: process.env, timeout: STORE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  let result;
  if (r.error) result = { error: `cannot run ${pass.wrapper.name} setup --json: ${r.error.code ?? r.error.message}` };
  else if (r.status !== 0) result = { error: `${pass.wrapper.name} setup --json exited ${r.status ?? r.signal}${r.stderr?.trim() ? `: ${oneLine(r.stderr)}` : ""}` };
  else {
    try {
      const report = JSON.parse(r.stdout);
      result = isObject(report) ? { report } : { error: `${pass.wrapper.name} setup --json printed no report` };
    } catch {
      result = { error: `${pass.wrapper.name} setup --json printed no JSON` };
    }
  }
  checks.codexSetup = result;
  return result;
}

// spec §4.3, §5.4 for a codex profile: the binary is found and `codex login` holds. A problem is FAIL for a profile
// a role uses (or the one --profile names) and WARN for an unused built-in profile — a user without OpenAI who routed
// every role elsewhere still gets `doctor: ok`.
function checkCodex(name, report, checks) {
  const level = checks.single || checks.used.has(name) ? "FAIL" : "WARN";
  const unused = level === "WARN" ? " (no role uses this profile)" : "";
  const setup = codexSetup(checks);
  if (setup.error) {
    report("WARN", `auth ${name}`, `codex and its login were not checked: ${setup.error}`);
    return;
  }
  const { codex, auth } = setup.report;
  if (codex?.available !== true) {
    report(level, `harness ${name}`, `codex is not available (${oneLine(codex?.detail) || "no detail"}); install it: npm install -g @openai/codex${unused}`);
    return;
  }
  report("ok", `harness ${name}`, `codex ${oneLine(String(codex.detail ?? "").split(";")[0]) || "(version unknown)"}`);
  // auth.detail is not printed when logged in: for a ChatGPT login it names the account's e-mail.
  if (auth?.loggedIn !== true) report(level, `auth ${name}`, `codex is not logged in (${oneLine(auth?.detail) || "no detail"}); the user logs in: codex login${unused}`);
  else report("ok", `auth ${name}`, `codex login (${auth.authMethod ?? (auth.requiresOpenaiAuth === false ? "no OpenAI login needed" : "logged in")})`);
}

async function doctorProfile(state, name, report, checks) {
  const { single } = checks;
  const entry = state.profiles.get(name);
  if (!entry) {
    report("FAIL", `profile ${name}`, `unknown profile (profiles: ${[...state.profiles.keys()].join(", ")})`);
    return;
  }
  const p = entry.p;
  if (p.harness === "inproc") {
    report("ok", `profile ${name}`, `in-session via the Agent tool: model=${p.model} effort=${p.effort ?? "-"}`);
    return;
  }
  const pass = PASS_THROUGH[p.harness];
  if (pass) {
    const file = wrapperPath(pass);
    if (!isExecutable(file)) report("FAIL", `profile ${name}`, `${pass.wrapper.name} not found or not executable: ${file}`);
    else if (p.harness === "zcode") {
      report("ok", `profile ${name}`, `pass-through to ${file} (${pass.pinned.model} ${pass.pinned.effort}, pinned by the wrapper)${single ? `; check the GLM channel itself with: ${pass.wrapper.name} doctor --probe` : ""}`);
    } else {
      report("ok", `profile ${name}`, `pass-through to ${file} (--model ${p.model} --effort ${p.effort}; the model is not checked)`);
      checkCodex(name, report, checks);
    }
    return;
  }
  let adapter;
  try {
    adapter = await loadCoreAdapter(p.harness);
  } catch (error) {
    // A broken adapter file (a throw at import, a syntax error, a wrong id) is a FAIL of this profile only; its key
    // or login is still checked, and so are the other profiles.
    report("FAIL", `profile ${name}`, `adapter ${p.harness} failed to load: ${oneLine(error?.message ?? error, 400)}`);
    checkKey(name, p, report);
    return;
  }
  if (!adapter) report("FAIL", `profile ${name}`, `harness ${p.harness} is not available in this version`);
  else report("ok", `profile ${name}`, `harness ${p.harness}, model ${p.model ?? "-"}, effort ${p.effort ?? "-"}, home ${p.home}, sandbox ${p.sandbox}`);
  checkKey(name, p, report);
  if (!adapter) return;
  // cwd: the tree doctor runs in (dsh checks its .env and worktree); writeFiles: the core's writer of adapter files,
  // only under the data root (dsh writes its patch template for --dump-config there).
  const ctx = core.makeCtx({ profile: p, profileName: name, cwd: process.cwd(), writeFiles: (spec) => core.writeAdapterFiles(spec) });
  try {
    const found = await core.discoverHarness(adapter, ctx);
    if (found) {
      report("ok", `harness ${name}`, `${found.bin} ${found.version ?? "(version unknown)"}${p.wrap ? ` via wrap ${p.wrap.join(" ")}` : ""}`);
      const verified = adapter.manifest?.verifiedVersions ?? [];
      if (verified.length > 0 && found.version && !verified.includes(found.version)) {
        report("WARN", `version ${name}`, `${p.harness} ${found.version} was not checked; checked: ${verified.join(", ")}`);
      }
    }
  } catch (error) {
    report("FAIL", `harness ${name}`, error.message);
  }
  // The env check plans a run, so it also meets the adapter refusing the profile (a UsageError of invocation():
  // claude's login settings, opencode's stored login). When the adapter's own FAIL rows name that refusal, they are
  // its one report and there is no env row; any other refusal or error is the env row's FAIL.
  let envRow;
  let refusal = null;
  try {
    const owned = await core.mandatorySettings(adapter, p, ctx);
    const conflicts = core.envConflicts(p.env, owned);
    if (conflicts.length > 0) envRow = ["FAIL", `env ${name}`, `profile env ${conflicts.join(", ")} conflicts with a mandatory setting of the ${p.harness} adapter (spec §3.6 A)`];
    else envRow = ["ok", `env ${name}`, `no conflict with the mandatory settings (${owned.names.length} names)`];
  } catch (error) {
    envRow = ["FAIL", `env ${name}`, error.message];
    const prefix = `profile ${name}: `;
    if (error instanceof UsageError) refusal = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  }
  let rows = [];
  let failed = null;
  if (typeof adapter.doctorChecks === "function") {
    try {
      rows = await adapter.doctorChecks(p, ctx);
    } catch (error) {
      failed = { error };
    }
  }
  if (!(refusal && namedByFailRows(rows, refusal))) report(...envRow);
  checkSandbox(name, p, report);
  if (failed) {
    report("FAIL", `checks ${name}`, `the ${p.harness} adapter's checks failed: ${oneLine(failed.error?.message ?? failed.error, 300)}`);
    return;
  }
  for (const check of Array.isArray(rows) ? rows : []) {
    const level = ["ok", "WARN", "FAIL"].includes(check?.level) ? check.level : "WARN";
    report(level, `${check?.name ?? "check"} ${name}`, check?.hint ?? "");
  }
}

async function doctorProbe(state, name) {
  const { p } = state.profiles.get(name);
  if (p.harness === "inproc") {
    out(`WARN probe ${name}: an inproc profile runs in-session; there is nothing to probe\n`);
    return 0;
  }
  const pass = PASS_THROUGH[p.harness];
  if (pass) {
    const how = p.harness === "zcode" ? `run: ${pass.wrapper.name} doctor --probe` : "the codex login is checked above; a quota problem shows on its first task";
    out(`WARN probe ${name}: ${CLI_NAME} does not probe pass-through profiles; ${how}\n`);
    return 0;
  }
  const adapter = await requireCoreAdapter(name, p.harness);
  const started = Date.now();
  const r = await core.runProbe({ adapter, profileName: name, profile: p, resolveSecret: resolveSecretFor(p) });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status === "completed") {
    const answer = String(r.response ?? "").trim();
    if (/^PONG\b/i.test(answer)) {
      out(`ok probe ${name}: PONG in ${secs} s${r.reportedModel ? ` (model ${r.reportedModel})` : ""}\n`);
    } else {
      out(`WARN probe ${name}: answered ${JSON.stringify(answer.slice(0, 80))} instead of PONG\n`);
    }
    return 0;
  }
  out(`FAIL probe ${name}: ${r.status}/${r.errorClass}${r.errorText ? `: ${r.errorText.split("\n")[0]}` : ""}\n`);
  return 1;
}

async function cmdDoctor(args) {
  const { values } = parse(args, { profile: { type: "string" }, probe: { type: "boolean" } }, 0);
  if (values.probe && !values.profile) throw new UsageError("doctor --probe needs --profile <name>: a probe is one paid request on that profile's key or subscription");
  const state = loadState();
  const lines = [];
  let failed = false;
  const report = (level, check, detail) => {
    lines.push(`${level} ${check}: ${detail}`);
    if (level === "FAIL") failed = true;
  };

  if (state.error) report("FAIL", "config", `${state.file}: ${state.error}; only the built-in profiles and roles are checked`);
  else if (!state.exists) report("ok", "config", `no ${state.file}: the built-in profiles and roles`);
  else report("ok", "config", `${state.file}: ${Object.keys(state.data.profiles ?? {}).length} profile(s), ${Object.keys(state.data.roles ?? {}).length} role(s)`);
  if (!state.error) {
    const differing = differingRoles(state);
    report("ok", "routes", differing.length === 0 ? "default" : `${differing.length} role(s) differ from the built-in scheme: ${differing.join(", ")}`);
  }
  const root = core.stateRoot();
  try {
    if (fs.existsSync(root)) {
      fs.accessSync(root, fs.constants.W_OK);
      const mode = fs.statSync(root).mode & 0o777;
      if (mode & 0o077) report("WARN", "state-dir", `${root} has mode ${mode.toString(8)}; expected 700`);
      else report("ok", "state-dir", root);
    } else {
      report("ok", "state-dir", `${root} (created on first use, mode 0700)`);
    }
  } catch (error) {
    report("FAIL", "state-dir", `${root} is not writable: ${error.message}`);
  }
  try {
    const names = core.passthroughNames();
    report("ok", "env", `${Object.keys(core.filterEnv()).length} caller variables pass the allowlist${names.length > 0 ? `; ${core.ENV_PASSTHROUGH_VAR}: ${names.join(" ")}` : ""}`);
  } catch (error) {
    report("FAIL", "env", error.message);
  }
  const names = values.profile ? [values.profile] : [...state.profiles.keys()];
  const used = new Set(Object.keys(DEFAULTS.roles).flatMap((role) => state.roles[role]));
  const checks = { single: Boolean(values.profile), used, codexSetup: null };
  for (const name of names) {
    // Whatever escapes one profile's checks is that profile's FAIL row: the report and its verdict always print.
    try {
      await doctorProfile(state, name, report, checks);
    } catch (error) {
      report("FAIL", `profile ${name}`, `its checks stopped: ${oneLine(error?.message ?? error, 300)}`);
    }
  }

  out(`${lines.join("\n")}\ndoctor: ${failed ? "FAIL" : "ok"}\n`);
  if (failed) return 1;
  if (!values.probe) return 0;
  return await doctorProbe(state, values.profile);
}

// ---------- main ----------

const USAGE = `usage: ${CLI_NAME} <task|status|result|cancel|release-stale|tree-state|route|channels|doctor|key|profile|preset> [args...]`;

export async function main(argv) {
  const [verb, ...rest] = argv;
  try {
    switch (verb) {
      case "task":
        return await cmdTask(rest);
      case "status":
        return cmdStatus(rest);
      case "result":
      case "cancel":
        return await cmdJobVerb(verb, rest);
      case "release-stale":
        return cmdReleaseStale(rest);
      case "tree-state":
        return cmdTreeState(rest);
      case "route":
        return cmdRoute(rest);
      case "channels":
        return cmdChannels(rest);
      case "doctor":
        return await cmdDoctor(rest);
      case "key":
        return await cmdKey(rest);
      case "profile":
        return await cmdProfile(rest);
      case "preset":
        return cmdPreset(rest);
      case core.RUN_VERB:
        return await core.runJob({ id: rest[0], jobsDir: rest[1], token: rest[2], adapters: await runnerAdapters(rest[0], rest[1]) });
      default:
        throw new UsageError(`${USAGE}${verb ? ` (unknown verb: ${verb})` : ""}`);
    }
  } catch (error) {
    process.stderr.write(`${CLI_NAME}: ${error?.message ?? error}\n`);
    return core.exitCodeOf(error);
  }
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
