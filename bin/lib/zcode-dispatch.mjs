// zcode-dispatch.mjs — background-job wrapper around Z.ai's official ZCode CLI
// (the Agent CLI embedded in the ZCode desktop app: /Applications/ZCode.app on macOS,
// /opt/ZCode on Linux), shaped like the vendored Codex companion: task / status / result / cancel / doctor.
//
// Pure Node ESM, no dependencies, no shell: every child process is spawned with
// an argv array. Never reads or writes the user's ~/.zcode (shared with the desktop
// app): every CLI run gets the cli-home environment — ZCODE_DATA_BASE_DIR=<state root>/cli-home
// for the CLI's credentials, plus ZCODE_STORAGE_DIR, ZCODE_SESSION_DB_PATH and ZCODE_LOG_DIR
// under it for its plugins/rollouts, sessions and logs. The CLI's user config
// ~/.zcode/cli/config.json has no override and stays the CLI's own shared file. Never reads
// those credentials and never calls the Z.ai API itself — the ZCode CLI is the only channel.
// The model pin travels in the wrapper's own personal provider config under the state
// root (ZCODE_PERSONAL_PROVIDER_CONFIG_FILE). The CLI authenticates only with the user's Coding Plan
// API key: `zcode-dispatch api-key set` stores it in that personal config as a provider of ZCode's own
// "Z.ai Coding Plan" template, which needs no token exchange and does not expire. The CLI's OAuth login
// is not used: it keeps no refresh token and expires after about an hour (docs/zcode-cli-findings.md,
// "CLI login lifetime").
//
// Usage: zcode-dispatch <task|status|result|cancel|release-stale|doctor|api-key> [args...]
// Exit codes: 0 success · 1 runtime failure · 2 usage error or guard refusal.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// ---- Values copied from docs/zcode-cli-findings.md "## Inputs for later phases" ----
export const PINNED_MODEL = "GLM-5.3-Flash$max";
export const VERIFIED_APP_VERSION = "3.15.1";
export const VERIFIED_NODE_MAJOR = 26;
export const PROMPT_TRANSPORT = "argv"; // "argv" | "stdin"
// The argv transport passes the whole prompt as one argument. Linux caps a single argument at 32 pages
// (MAX_ARG_STRLEN: 131072 bytes with its NUL; a 131072-byte argument fails with E2BIG), macOS only the total.
export const MAX_PROMPT_BYTES = process.platform === "linux" ? 120 * 1024 : 200 * 1024;
export const APP_VERSION_PLIST_KEY = "CFBundleShortVersionString";
export const SUPPORTED_PLATFORMS = ["darwin", "linux"];
export const MODEL_ARGS = []; // MODEL_MECHANISM flag:<--name> → ["<--name>", PINNED_MODEL]
export const MODEL_ENV = {}; // MODEL_MECHANISM env:<NAME> → { "<NAME>": PINNED_MODEL }
// MODEL_MECHANISM personal-config: the selection at SELECTION_PATH of the wrapper-owned personal provider
// config, written by `api-key set` and checked (never rewritten) by every run; PERSONAL_CONFIG_BASE seeds a
// missing file.
export const SELECTION_PATH = "config.defaultModelSelection";
export const PERSONAL_CONFIG_BASE = {"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}};
// The only auth ("CLI login lifetime"): a personal provider rule from ZCode's built-in template "zai-api"
// ("Z.ai Coding Plan": access zhipu-coding-plan-api-key, https://api.z.ai/api/anthropic, GLM-5.3 and
// GLM-5.3-Flash), with the provider id ZCode itself derives from that template; PINNED_SELECTION selects it.
export const PINNED_SELECTION = {"providerId":"zai-api","modelId":"GLM-5.3-Flash","options":{"reasoningLevel":"max"}};
// The models a task may pin with --model (0.14.0). Both come from the same zai-api template (builtinModelIds GLM-5.3
// and GLM-5.3-Flash) and take the reasoning levels low|high|max from its model rule `.*glm-5\.3(?:-flash)?…`
// (docs/zcode-cli-findings.md, "CLI login lifetime"). The CLI has no model flag (U1): each model gets a personal
// provider config of its own, holding the same key rule and its own selection, so jobs on different models run side
// by side and no run ever rewrites a file. The default keeps the file name of 0.13.x and earlier.
export const DEFAULT_MODEL = PINNED_SELECTION.modelId;
export const MODELS = {
  "GLM-5.3-Flash": { selection: PINNED_SELECTION, file: "personal-provider-config.json" },
  "GLM-5.3": { selection: {"providerId":"zai-api","modelId":"GLM-5.3","options":{"reasoningLevel":"max"}}, file: "personal-provider-config.glm-5.3.json" },
};
export const MODEL_IDS = Object.keys(MODELS);
// "<modelId>$<reasoningLevel>", as PINNED_MODEL spells the default.
export const pinOf = (model) => `${model}$${MODELS[model].selection.options.reasoningLevel}`;
// A --model value: an id of MODELS, case-insensitive; anything else is refused.
export function resolveModel(value) {
  if (value === undefined) return DEFAULT_MODEL;
  const model = MODEL_IDS.find((id) => id.toLowerCase() === String(value).toLowerCase());
  if (!model) throw new UsageError(`unknown --model ${JSON.stringify(value)} (models: ${MODEL_IDS.join(", ")})`);
  return model;
}
// The model id of a job record ("GLM-5.3$max" → "GLM-5.3"); records before 0.14.0 hold PINNED_MODEL.
const modelOfRecord = (record) => {
  const id = typeof record?.model === "string" ? record.model.split("$")[0] : DEFAULT_MODEL;
  return MODELS[id] ? id : DEFAULT_MODEL;
};
export const API_KEY_TEMPLATE_ID = "zai-api";
export const API_KEY_PROVIDER_ID = "zai-api";
export const API_KEY_ACCESS_TYPE = "zhipu-coding-plan-api-key";
export const API_KEY_MANAGEMENT_URL = "https://z.ai/manage-apikey/apikey-list";
export const DISALLOWED_TOOLS = [];
export const REPORTED_MODEL_PATH = null;
export const USAGE_FIELDS = {"input":"inputTokens","cached":"cacheReadTokens","output":"outputTokens"};
export const PATTERNS = {
  "model-not-selected": ["Select a model before continuing","Model creation failed"],
  auth: ["401","unauthorized","not logged in","login","token expired","credential","authentication failed","project_token_"],
  quota: ["429","quota","rate limit","usage limit","insufficient","balance","usage_limit_exceeded","spend_limit_exceeded","coding_plan_required"],
  launch: ["ZCODE_BUILTIN_PROVIDER","provider config","Cannot find module","Cannot find package","Failed to load environment file","ZCode app factory is unavailable","Provider Registry runtime is unavailable"],
};
// --------------------------------------------------------------------------------------

// ---- Environment of the ZCode CLI: an allowlist (docs/zcode-cli-findings.md "## Environment") ----
// The CLI's Bash tool inherits the CLI's whole environment, so this is also what GLM's shell
// commands see. Explicitly passed names opt in even when secret-like; wrapper-owned ZCODE_*
// settings are applied afterwards. ZCODE_SESSION_DB is always excluded because the CLI treats
// it as an alias with higher precedence than ZCODE_SESSION_DB_PATH.
export const ENV_PASSTHROUGH_VAR = "ZCODE_ENV_PASSTHROUGH";
export const ENV_ALLOW = [
  // process basics; HOME is needed for the CLI's credential key
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "TZ", "LANG",
  // the Node runtime that runs zcode.cjs
  "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA",
  // network for the CLI's tools (the CLI itself uses ZCODE_HTTP_PROXY)
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO",
  // the CLI's own settings: its only proxy, its CA, its credential key, and selected state defaults
  "ZCODE_HTTP_PROXY", "ZCODE_NO_PROXY", "ZCODE_AGENT_CA_CERT", "ZCODE_CREDENTIAL_SECRET",
  "ZCODE_DATA_BASE_DIR", "ZCODE_STORAGE_DIR", "ZCODE_BETA", "ZCODE_ENV",
  // toolchain locations
  "JAVA_HOME", "GOPATH", "GOROOT", "GOBIN", "CARGO_HOME", "RUSTUP_HOME", "PYENV_ROOT", "VIRTUAL_ENV",
  "CONDA_PREFIX", "NVM_DIR", "VOLTA_HOME", "PNPM_HOME", "BUN_INSTALL", "DENO_DIR", "GEM_HOME", "GEM_PATH",
  "RBENV_ROOT", "ASDF_DIR", "ASDF_DATA_DIR", "HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY",
  "DEVELOPER_DIR", "ANDROID_HOME", "ANDROID_SDK_ROOT",
];
export const ENV_ALLOW_PREFIXES = ["LC_", "XDG_"];
// ZCODE_CREDENTIAL_SECRET is the one ENV_ALLOW entry that matches the secret suffix rule: the CLI
// cannot decrypt its own credentials without it when it is set.
export const ENV_DENY = [/_(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS)$/i, /^(AWS|GITHUB|GH|ANTHROPIC|OPENAI|CLAUDE)_/i];
// --------------------------------------------------------------------------------------

const PROBE_PROMPT = "Reply with exactly one word: PONG";
const PROBE_TIMEOUT_MS = 120_000;
const TIMEOUT_KILL_GRACE_MS = 10_000;
const CANCEL_GRACE_MS = 5_000;
const CLOSE_WAIT_MS = 5_000;
const STARTUP_GRACE_MS = 60_000;
const REBOOT_NOTE = "system rebooted since the job started";
const DEFAULT_TIMEOUT_MIN = 60;
const ID_RE = /^zt-\d{4,}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const SELF = fileURLToPath(import.meta.url);

class UsageError extends Error {}

// ---------- environment and paths ----------

// The app's install layout. ZCode is an Electron app, and electron-builder puts the CLI (glm/zcode.cjs), the
// built-in provider config and app.asar into the same resources directory on every platform: Contents/Resources
// in the macOS bundle, resources/ beside the executable elsewhere (/opt/ZCode is the Linux deb/rpm default). The
// app version comes from Info.plist on macOS and from app.asar's package.json elsewhere (electron-builder writes
// the same version into both).
const DEFAULT_APP = { darwin: "/Applications/ZCode.app", linux: "/opt/ZCode" };

function zcodePaths(env = process.env) {
  const darwin = process.platform === "darwin";
  const app = env.ZCODE_APP || DEFAULT_APP[process.platform] || DEFAULT_APP.linux;
  const resources = darwin ? path.join(app, "Contents", "Resources") : path.join(app, "resources");
  return {
    app,
    version: darwin
      ? { kind: "plist", file: path.join(app, "Contents", "Info.plist"), label: `${APP_VERSION_PLIST_KEY} from ${path.join(app, "Contents", "Info.plist")}` }
      : { kind: "asar", file: path.join(resources, "app.asar"), label: `the version in package.json of ${path.join(resources, "app.asar")}` },
    bin: env.ZCODE_BIN || path.join(resources, "glm", "zcode.cjs"),
    providerConfig: path.join(resources, "config", "provider", "zcode-builtin.json"),
    node: env.ZCODE_NODE || "node",
  };
}

function stateRoot(env = process.env) {
  return env.ZCODE_STATE_DIR || path.join(os.homedir(), ".claude", "plugins", "data", "superpowers-strigov-ver-zcode");
}

const personalConfigFile = (model = DEFAULT_MODEL, env = process.env) => path.join(stateRoot(env), MODELS[model].file);

// The CLI's own home for its credentials and state, apart from the user's ~/.zcode, whose credential
// key the desktop app rewrites with a different token kind (docs/zcode-cli-findings.md, "CLI data home").
// The CLI resolves each location separately, so cliHomeEnv sets one override per resolver that has one;
// its user config ~/.zcode/cli/config.json has none (only HOME, which the wrapper never overrides).
// The wrapper creates the directory (mode 0700) and never reads what the CLI keeps there.
const cliHome = (env = process.env) => path.join(stateRoot(env), "cli-home");

function cliHomeEnv() {
  const home = cliHome();
  const storage = path.join(home, ".zcode");
  return {
    ZCODE_DATA_BASE_DIR: home, // credentials: <cli-home>/.zcode/v2/credentials.json
    ZCODE_STORAGE_DIR: storage, // storage root: plugins, rollouts, memories under <cli-home>/.zcode/cli/
    ZCODE_SESSION_DB_PATH: path.join(storage, "cli", "db", "db.sqlite"), // not derived from the storage root
    ZCODE_LOG_DIR: path.join(storage, "cli", "log"),
  };
}

function ensureCliHome() {
  const dir = cliHome();
  fs.mkdirSync(stateRoot(), { recursive: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function readAppVersion(source) {
  if (source.kind === "asar") return readAsarVersion(source.file);
  const r = spawnSync("plutil", ["-extract", APP_VERSION_PLIST_KEY, "raw", "-o", "-", source.file], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const version = r.stdout.trim();
  return version.length > 0 ? version : null;
}

// The "version" of package.json inside an Electron app.asar, or null. The archive starts with two Chromium
// pickles: [4][header pickle size] and then the header pickle [payload size][JSON length][JSON]; a file's
// offset counts from the end of the header pickle. An unpacked package.json sits in app.asar.unpacked/.
const ASAR_HEADER_MAX = 64 * 1024 * 1024;

export function readAsarVersion(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const read = (length, position) => {
      const buffer = Buffer.alloc(length);
      if (fs.readSync(fd, buffer, 0, length, position) !== length) throw new Error("short read");
      return buffer;
    };
    const head = read(16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLength = head.readUInt32LE(12);
    if (head.readUInt32LE(0) !== 4 || jsonLength > ASAR_HEADER_MAX || jsonLength + 8 > headerSize) return null;
    const entry = JSON.parse(read(jsonLength, 16).toString("utf8"))?.files?.["package.json"];
    if (!isObject(entry) || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > 1024 * 1024) return null;
    let text;
    if (entry.unpacked === true) {
      const unpacked = path.join(`${file}.unpacked`, "package.json");
      if (fs.statSync(unpacked).size > 1024 * 1024) return null;
      text = fs.readFileSync(unpacked, "utf8");
    } else {
      const offset = Number(entry.offset);
      if (!Number.isSafeInteger(offset) || offset < 0) return null;
      text = read(entry.size, 8 + headerSize + offset).toString("utf8");
    }
    const version = JSON.parse(text)?.version;
    return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function resolveWorkspace(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const root = r.stdout.trim();
  if (!root) return null;
  const slug = `${path.basename(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`;
  return { root, jobsDir: path.join(stateRoot(), "state", slug, "jobs") };
}

function requireWorkspace(cwdOption) {
  const cwd = path.resolve(cwdOption ?? process.cwd());
  const ws = resolveWorkspace(cwd);
  if (!ws) throw new UsageError(`not inside a git work tree: ${cwd}`);
  return ws;
}

function readTimeoutMin(env = process.env) {
  const raw = env.ZCODE_TASK_TIMEOUT_MIN;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MIN;
  const value = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw.trim()) || !(value > 0)) {
    throw new UsageError(`ZCODE_TASK_TIMEOUT_MIN must be a positive number of minutes, got "${raw}"`);
  }
  return value;
}

// Variable names listed in ZCODE_ENV_PASSTHROUGH ("A,B" or "A B"). These are explicit
// user opt-ins and therefore pass even when ENV_DENY matches them, except for the CLI's
// ZCODE_SESSION_DB alias, which must never reach the CLI.
export function passthroughNames(source = process.env) {
  const names = (source[ENV_PASSTHROUGH_VAR] ?? "").split(/[\s,]+/).filter(Boolean);
  const invalid = names.filter((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (invalid.length > 0) throw new UsageError(`${ENV_PASSTHROUGH_VAR} holds invalid variable names: ${invalid.join(" ")}`);
  return [...new Set(names.filter((name) => name !== "ZCODE_SESSION_DB"))];
}

const isDenied = (name) => ENV_DENY.some((pattern) => pattern.test(name));

// The caller's variables the CLI may see. CLI-home and other wrapper-owned settings are added
// after this filter in buildCliEnv so inherited and explicitly passed spoofed values lose.
export function filterCliEnv(source = process.env) {
  const passthrough = new Set(passthroughNames(source));
  const allow = new Set(ENV_ALLOW);
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || name === "ZCODE_SESSION_DB") continue;
    const prefixed = ENV_ALLOW_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (passthrough.has(name) || allow.has(name) || (prefixed && !isDenied(name))) env[name] = value;
  }
  return env;
}

// Names only, never values: what the job log records about the CLI's environment.
function describeCliEnv(env) {
  const passthrough = passthroughNames().filter((name) => name in env);
  const secretLike = passthrough.filter(isDenied);
  return [
    `env names: ${Object.keys(env).sort().join(" ")}`,
    ...(passthrough.length > 0 ? [`via ${ENV_PASSTHROUGH_VAR}: ${passthrough.join(" ")}`] : []),
    ...(secretLike.length > 0 ? [`secret-like by name, passed on request: ${secretLike.join(" ")}`] : []),
  ].join("; ");
}

// ---------- job records ----------

const jobFile = (jobsDir, id) => path.join(jobsDir, `${id}.json`);
const logFile = (jobsDir, id) => path.join(jobsDir, `${id}.log`);
const formatId = (n) => `zt-${String(n).padStart(4, "0")}`;
const idNumber = (id) => Number(id.slice(3));

// The terminal record is claimed once, in a sibling file created atomically and
// exclusively (link(2) fails with EEXIST when it already exists): the first
// finalizer wins, and every reader prefers that file over the main record, so a
// writer holding a stale `running` copy can never undo a terminal status.
const terminalFile = (file) => `${file}.terminal`;
let tmpSeq = 0;
const tmpFile = (file) => `${file}.tmp-${process.pid}-${++tmpSeq}`;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readRecord(file) {
  return readJson(terminalFile(file)) ?? readJson(file);
}

function writeRecord(file, record) {
  const tmp = tmpFile(file);
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Terminal statuses are sticky: a completed / failed / cancelled record is never rewritten,
// also when two finalizers (cancel and the runner) race — exactly one claim succeeds.
export function finalizeRecord(file, patch) {
  const current = readRecord(file);
  if (!current || TERMINAL.has(current.status)) return current;
  const next = { ...current, ...patch, finishedAt: new Date().toISOString() };
  const tmp = tmpFile(file);
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  try {
    fs.linkSync(tmp, terminalFile(file));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return readRecord(file); // another finalizer won: its terminal record stands
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  writeRecord(file, next); // mirror into the main record (readers already see the claim)
  return next;
}

// Returns null when the job is (or meanwhile became) terminal: a terminal claim that
// landed after our read wins even if our stale rename replaced the main record.
function updateRunning(file, patch) {
  const current = readRecord(file);
  if (!current || current.status !== "running") return null;
  const next = { ...current, ...patch };
  writeRecord(file, next);
  return fs.existsSync(terminalFile(file)) ? null : next;
}

// The wrapper-owned personal provider config (ZCODE_PERSONAL_PROVIDER_CONFIG_FILE): the user's Coding Plan
// API key as a rule of ZCode's template "zai-api" and the default selection PINNED_SELECTION. Only
// `api-key set` / `clear` write it (atomic rename, mode 0600, state root 0700); runs and doctor only read it
// (and restore its modes). A kernel lock beside it (configLock) keeps the key from changing while any CLI —
// or a process it left behind — can read it. It lives under the state root, never under ~/.zcode; nothing
// here prints the key.
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const REDACTED_KEY = "<redacted: Coding Plan API key>";
// A Coding Plan key consists of these characters only (Z.ai issues <hex>.<alphanumerics>): no quote,
// backslash or space, so JSON escaping at any depth leaves it unchanged and its raw form is all the redactor
// needs. A rule whose key does not match is not a key.
const API_KEY_MAX = 512;
export const API_KEY_PATTERN = /^[A-Za-z0-9._-]{8,512}$/;

// Only a missing file starts from PERSONAL_CONFIG_BASE: an unreadable or unparseable one may hold the
// API key, so it is reported (without its content) instead of being overwritten.
function readPersonalConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(PERSONAL_CONFIG_BASE);
    throw new Error(`cannot read ${file}: ${error.code ?? error.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON; fix or delete it (it may hold the Coding Plan API key)`);
  }
  if (!isObject(value)) throw new Error(`${file} does not hold a JSON object; fix or delete it`);
  return value;
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

// Modes only, no content write (safe beside a concurrent api-key command): restores 0700 / 0600 after a
// wrapper copy older than 0.10.0 rewrote the file with the default mode.
function securePersonalConfig(file) {
  ensurePrivateDir(path.dirname(file));
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Replaces the API key in CLI output before the wrapper logs, records or prints it (GLM's shell can read the
// personal config). The key cannot change during a run (the config lock); as defense in depth each call
// re-checks the file (by inode, size and mtime) and keeps every key it has seen, replacing the longest first.
export function keyRedactor(file, initialConfig = null) {
  const keys = new Set();
  let seenId = null;
  const add = (config) => {
    const key = apiKeyRuleOf(config)?.config.access.apiKey;
    if (key) keys.add(key);
  };
  const refresh = () => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    const id = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (id === seenId) return;
    seenId = id;
    try {
      add(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      // unreadable or unparseable: keep the keys already known
    }
  };
  if (initialConfig) add(initialConfig);
  refresh();
  return (text) => {
    refresh();
    let out = String(text);
    for (const key of [...keys].sort((a, b) => b.length - a.length)) out = out.split(key).join(REDACTED_KEY);
    return out;
  };
}

function providerRulesOf(config) {
  const rules = config.config?.providerConfigRules?.providerRules;
  return Array.isArray(rules) ? rules : [];
}

// The API-key rule, only when it carries a well-formed key of ZCode's Coding Plan key type.
function apiKeyRuleOf(config) {
  const rule = providerRulesOf(config).find((r) => isObject(r) && r.providerId === API_KEY_PROVIDER_ID);
  const access = rule?.config?.access;
  return rule?.templateId === API_KEY_TEMPLATE_ID && access?.type === API_KEY_ACCESS_TYPE && typeof access.apiKey === "string" && API_KEY_PATTERN.test(access.apiKey) ? rule : null;
}

export const hasApiKey = (config) => Boolean(apiKeyRuleOf(config));
// Structural, independent of key order (a reformatted file still pins the same selection).
const canonical = (value) =>
  Array.isArray(value) ? value.map(canonical) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const isPinned = (config, model = DEFAULT_MODEL) => JSON.stringify(canonical(pick(config, SELECTION_PATH))) === JSON.stringify(canonical(MODELS[model].selection));

// A failed write removes its temp copy (it may hold the key); after a successful rename the name is gone.
function writePrivateJson(file, value) {
  ensurePrivateDir(path.dirname(file));
  const tmp = tmpFile(file);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file); // atomic; the file keeps the temp file's mode
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Temp copies left by a crash between write and rename may hold a key: api-key set / clear remove them.
function sweepTempCopies(file) {
  const prefix = `${path.basename(file)}.tmp-`;
  let names = [];
  try {
    names = fs.readdirSync(path.dirname(file));
  } catch {
    return;
  }
  for (const name of names) if (name.startsWith(prefix)) fs.rmSync(path.join(path.dirname(file), name), { force: true });
}

// The config lock: a flock(2) lock on <personal config>.lock, held by the open file description and dropped by
// the kernel when its last descriptor closes — also when a process dies, so it never goes stale. A run (task
// runner, probe) takes it SHARED before it reads the config and hands the descriptor to the CLI as fd 3, so the
// CLI keeps it held also during a cancel's grace period and after the runner itself was killed; the runner keeps
// its own copy until the CLI's streams are closed. api-key set / clear take it EXCLUSIVE and refuse while a
// holder lives; every writer of the config is serialized. So the key is frozen for as long as anything can still
// reach the wrapper's log or record. No pid is involved. ZCode's tool processes do not inherit fd 3: the CLI
// spawns them with three stdio descriptors, and libuv passes on nothing else (checked on macOS and Linux); their
// output reaches the wrapper only through the CLI.
// How the lock is taken, per platform (Node has no flock call):
//   macOS — atomically by open(2) with the BSD flags O_SHLOCK / O_EXLOCK (Node passes them through).
//   Linux — open(2) first, then flock(1) from util-linux locks that descriptor, passed to it as its fd 3: the
//           lock belongs to the open file description it shares with this process, so it stays after flock(1)
//           exits.
const LOCK_SHARED = "shared";
const LOCK_EXCLUSIVE = "exclusive";
const O_SHLOCK = 0x10; // macOS only: these open(2) flags mean something else, or nothing, elsewhere
const O_EXLOCK = 0x20;
const configLockFile = () => `${personalConfigFile()}.lock`;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Why the config lock cannot be taken on this machine, or null.
function configLockProblem() {
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) return `${process.platform}: zcode-dispatch supports ${SUPPORTED_PLATFORMS.join(" and ")} only`;
  if (process.platform !== "linux") return null;
  const r = spawnSync("flock", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return "linux: flock(1) from util-linux is not on PATH; the config lock needs it (e.g. apt install util-linux)";
  return null;
}

// One non-blocking attempt: true when taken, false when another holder conflicts.
function tryLockFd(fd, kind) {
  const r = spawnSync("flock", [kind === LOCK_SHARED ? "-s" : "-x", "-n", "3"], { stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8" });
  if (r.error) throw new UsageError(`cannot run flock(1) for ${configLockFile()}: ${r.error.code ?? r.error.message}`);
  if (r.status === 0) return true;
  if (r.status === 1) return false; // util-linux and busybox: the lock is held elsewhere
  throw new Error(`flock(1) failed on ${configLockFile()} (exit ${r.status ?? r.signal}): ${r.stderr.trim()}`);
}

// Returns the descriptor, or null when the lock stays taken for waitMs.
function openConfigLock(kind, waitMs) {
  const problem = configLockProblem();
  if (problem) throw new UsageError(problem);
  ensurePrivateDir(stateRoot());
  const deadline = Date.now() + waitMs;
  const baseFlags = fs.constants.O_RDWR | fs.constants.O_CREAT;
  if (process.platform === "darwin") {
    const flags = baseFlags | fs.constants.O_NONBLOCK | (kind === LOCK_SHARED ? O_SHLOCK : O_EXLOCK);
    for (;;) {
      try {
        return fs.openSync(configLockFile(), flags, 0o600);
      } catch (error) {
        if (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") throw error;
        if (Date.now() >= deadline) return null;
        sleepSync(50);
      }
    }
  }
  const fd = fs.openSync(configLockFile(), baseFlags, 0o600);
  try {
    for (;;) {
      if (tryLockFd(fd, kind)) return fd;
      if (Date.now() >= deadline) break;
      sleepSync(50);
    }
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  fs.closeSync(fd);
  return null;
}

// Replaces (apiKey given) or removes (null) the API-key rule in the personal config of every model of MODELS, keeps
// every other rule, pins each file's own selection. With apiKey undefined (`api-key sync`) it copies the key stored
// for the default model into the others. Under the exclusive config lock (one lock for all the files), so it is
// refused while a run holds the shared one. The rule is written in the CLI's canonical shape (providers.toJSON
// order), so the CLI keeps the file as is. Returns the default model's config.
export function setApiKeyRule(apiKey) {
  const lockFd = openConfigLock(LOCK_EXCLUSIVE, 2_000);
  if (lockFd === null) {
    throw new UsageError(`a GLM run (task or probe — its runner or CLI) still holds ${configLockFile()} (see: lsof ${configLockFile()}); store or clear the key after it ends, or cancel the task; nothing changed`);
  }
  try {
    let key = apiKey;
    if (key === undefined) {
      const rule = apiKeyRuleOf(readPersonalConfig(personalConfigFile()));
      if (!rule) throw new UsageError(`no Coding Plan API key in ${personalConfigFile()} to copy; the user stores one: zcode-dispatch api-key set (keys: ${API_KEY_MANAGEMENT_URL}); nothing changed`);
      key = rule.config.access.apiKey;
    }
    // Read every file first: one that cannot be read (it may hold a key) stops the command before any write.
    for (const model of MODEL_IDS) readPersonalConfig(personalConfigFile(model));
    let first = null;
    for (const model of MODEL_IDS) {
      const config = writeApiKeyRule(personalConfigFile(model), key, MODELS[model].selection);
      first ??= config;
    }
    return first;
  } finally {
    fs.closeSync(lockFd);
  }
}

function writeApiKeyRule(file, apiKey, selection) {
  const config = readPersonalConfig(file);
  if (!isObject(config.config)) config.config = {};
  if (!isObject(config.config.providerConfigRules)) config.config.providerConfigRules = {};
  const rules = providerRulesOf(config).filter((r) => !(isObject(r) && r.providerId === API_KEY_PROVIDER_ID));
  if (apiKey !== null) {
    rules.push({ providerId: API_KEY_PROVIDER_ID, templateId: API_KEY_TEMPLATE_ID, config: { group: "standard-personal", access: { type: API_KEY_ACCESS_TYPE, apiKey } } });
  }
  config.config.providerConfigRules.providerRules = rules;
  const keys = SELECTION_PATH.split(".");
  let node = config;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys.at(-1)] = structuredClone(selection);
  sweepTempCopies(file);
  writePrivateJson(file, config);
  return config;
}

// The app's built-in config must still declare the template with the Coding Plan key type and an
// anthropic-messages API; reads the app's zcode-builtin.json (no credentials there). Returns an error string or null.
function apiKeyTemplateProblem(providerConfigFile) {
  const builtin = readJson(providerConfigFile);
  const templates = builtin?.config?.providerConfigRules?.templateRules;
  const template = Array.isArray(templates) ? templates.find((t) => t?.templateId === API_KEY_TEMPLATE_ID) : undefined;
  const where = `ZCode provider config ${providerConfigFile}`;
  if (!template) return `${where} declares no provider template "${API_KEY_TEMPLATE_ID}"`;
  if (template.config?.access?.type !== API_KEY_ACCESS_TYPE) return `${where}: template "${API_KEY_TEMPLATE_ID}" has access type ${template.config?.access?.type ?? "none"}, not ${API_KEY_ACCESS_TYPE}`;
  if (template.config?.api?.type !== "anthropic-messages") return `${where}: template "${API_KEY_TEMPLATE_ID}" has API type ${template.config?.api?.type ?? "none"}, not anthropic-messages`;
  const models = template.config?.builtinModelIds;
  if (!Array.isArray(models) || !models.includes(PINNED_SELECTION.modelId)) return `${where}: template "${API_KEY_TEMPLATE_ID}" does not list ${PINNED_SELECTION.modelId}`;
  return null;
}

function listRecords(jobsDir) {
  let names = [];
  try {
    names = fs.readdirSync(jobsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^zt-\d+\.json$/.test(name))
    .map((name) => readRecord(path.join(jobsDir, name)))
    .filter(Boolean)
    .sort((a, b) => idNumber(b.id) - idNumber(a.id));
}

function nextJobId(jobsDir) {
  fs.mkdirSync(jobsDir, { recursive: true });
  const used = fs
    .readdirSync(jobsDir)
    .map((name) => /^zt-(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  let n = 1 + Math.max(0, ...used);
  return formatId(n);
}

function allocateRecord(jobsDir, id, fields) {
  fs.writeFileSync(jobFile(jobsDir, id), `${JSON.stringify({ id, ...fields }, null, 2)}\n`, { flag: "wx" });
  return id;
}

function requireJob(jobsDir, ref) {
  if (!ID_RE.test(ref)) throw new UsageError(`${ref} is not a zcode-dispatch job id (zt-NNNN); Codex task- ids belong to codex-dispatch`);
  const record = readRecord(jobFile(jobsDir, ref));
  if (!record) throw new UsageError(`unknown job ${ref} in this workspace (pass the same --cwd as the original task)`);
  return record;
}

function appendLog(file, line) {
  try {
    fs.appendFileSync(file, `[zcode-dispatch] ${new Date().toISOString()} ${line}\n`);
  } catch {
    // the log is best effort
  }
}

function tailLines(file, n) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-n).map((line) => `${line}\n`).join("");
  } catch {
    return "";
  }
}

// ---------- processes ----------

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// pid 1 is never a CLI process group, and kill(-1) would signal every process of the user.
function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function killGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- boot identity: pids recorded in an earlier boot belong to nobody of ours ----------
// After a reboot the runnerPid / childPid / holderPid in the state files may name unrelated
// processes (EPERM for another user's process reads as alive). Job records and reservations store the
// boot id they were written in (kern.bootsessionuuid on macOS, /proc/sys/kernel/random/boot_id on
// Linux). Three cases, immune to wall-clock steps (no timestamp is ever evidence):
//   current — the stored id equals the readable current id: the usual pid checks and signals apply;
//   earlier — the stored id differs from the readable current id: dead without any pid check, never
//             signalled;
//   unknown — no stored id (state written before 0.10.2, or the id was unreadable then) or the current id
//             is unreadable now: the pid checks decide liveness as before, but nothing is signalled by a
//             stored pid (the reaper and cancel report instead), because that pid may be a stranger's.
// Tests only: ZCODE_TEST_BOOT_ID (a boot id, or "unknown").
let currentBootId;

function readBootId() {
  if (process.platform === "darwin") {
    const r = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" });
    const id = r.stdout?.trim();
    if (!r.error && r.status === 0 && id) return id;
  } else if (process.platform === "linux") {
    try {
      const id = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (id) return id;
    } catch {
      // no boot id: every stamp reads as unknown
    }
  }
  return null;
}

function bootId() {
  if (currentBootId !== undefined) return currentBootId;
  const override = process.env.ZCODE_TEST_BOOT_ID;
  if (override === undefined || override === "") currentBootId = readBootId();
  else currentBootId = override === "unknown" ? null : override;
  return currentBootId;
}

// "current" | "earlier" | "unknown" for state stamped with boot id `storedId`.
function bootOf(storedId) {
  const current = bootId();
  if (typeof storedId !== "string" || storedId === "" || current === null) return "unknown";
  return storedId === current ? "current" : "earlier";
}

const UNKNOWN_BOOT_NOTE = "not signalled: the boot it was started in cannot be confirmed (state from before 0.10.2, or the boot id is unreadable)";

const reservationBase = (jobsDir) => path.join(path.dirname(jobsDir), "active.lock");
const reservationFile = (jobsDir, generation) => `${reservationBase(jobsDir)}.${generation}`;

function reservationGenerations(jobsDir) {
  const directory = path.dirname(reservationBase(jobsDir));
  const prefix = `${path.basename(reservationBase(jobsDir))}.`;
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.flatMap((name) => {
    if (!name.startsWith(prefix)) return [];
    const value = name.slice(prefix.length);
    if (!/^(0|[1-9]\d*)$/.test(value)) return [];
    const generation = Number(value);
    if (!Number.isSafeInteger(generation)) throw new Error(`invalid workspace reservation generation: ${value}`);
    return [generation];
  }).sort((a, b) => a - b);
}

function currentReservation(jobsDir) {
  const generations = reservationGenerations(jobsDir);
  if (generations.length === 0) return null;
  const generation = generations[generations.length - 1];
  const file = reservationFile(jobsDir, generation);
  return { file, generation, record: readJson(file) };
}

function reservationFileForToken(jobsDir, token) {
  const generations = reservationGenerations(jobsDir);
  for (let index = generations.length - 1; index >= 0; index -= 1) {
    const file = reservationFile(jobsDir, generations[index]);
    if (readJson(file)?.token === token) return file;
  }
  return null;
}

function reservationGuard(record) {
  const id = typeof record?.jobId === "string" ? `job ${record.jobId}` : "a job";
  throw new UsageError(`${id} is still running in this workspace; one write task per working tree`);
}

function refuseUnavailableReservation(jobsDir, workspaceRoot) {
  const current = currentReservation(jobsDir);
  if (!current) return;
  const { file, generation, record } = current;
  if (!record || !Number.isInteger(record.holderPid) || record.holderPid <= 0 || typeof record.token !== "string") {
    reservationGuard(record);
  }
  if (readJson(`${file}.released`)?.token === record.token) return;
  const rebooted = bootOf(record.bootId) === "earlier";
  if (!rebooted && isAlive(record.holderPid)) reservationGuard(record);
  const reason = rebooted ? "the system rebooted since it was taken" : `runner pid ${record.holderPid} is not alive`;
  throw new UsageError(
    `workspace reservation generation ${generation} is stale (${reason}); run zcode-dispatch release-stale --cwd ${JSON.stringify(workspaceRoot)}`,
  );
}

function createReservation(file, reservation) {
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(reservation)}\n`, { flag: "wx", mode: 0o600, flush: true });
    fs.linkSync(temp, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// Hands the reservation to the runner. The task process is the only writer of its generation
// file, so a temp file renamed over it replaces it atomically: a process crash or ENOSPC never
// leaves the highest generation empty or half-written, and the temp file is flushed before the
// rename (as in createReservation) against an empty file after a power loss.
function updateReservation(file, token, holderPid) {
  const current = readJson(file);
  if (current?.token !== token) return false;
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ ...current, holderPid })}\n`, { flag: "wx", mode: 0o600, flush: true });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  const updated = readJson(file);
  return updated?.token === token && updated.holderPid === holderPid;
}

function releaseReservation(file, token) {
  const current = readJson(file);
  if (current?.token !== token || current.holderPid !== process.pid) return false;
  return createReservation(`${file}.released`, { holderPid: process.pid, token });
}

function acquireReservation(jobsDir, jobId, workspaceRoot) {
  fs.mkdirSync(path.dirname(reservationBase(jobsDir)), { recursive: true });
  for (;;) {
    const current = currentReservation(jobsDir);
    const generation = current ? current.generation + 1 : 0;
    if (current) refuseUnavailableReservation(jobsDir, workspaceRoot);

    const file = reservationFile(jobsDir, generation);
    const reservation = { holderPid: process.pid, jobId, token: randomUUID(), generation, createdAt: new Date().toISOString(), bootId: bootId() };
    if (createReservation(file, reservation)) return { file, token: reservation.token };
    // Another task created this generation. Re-read the highest generation before deciding.
  }
}

function cmdReleaseStale(args) {
  const { values } = parse(args, { cwd: { type: "string" } }, 0);
  const ws = requireWorkspace(values.cwd);
  const current = currentReservation(ws.jobsDir);
  if (!current) throw new UsageError("no workspace reservation to release");

  const { file, generation, record } = current;
  if (!record || !Number.isInteger(record.holderPid) || record.holderPid <= 0 || typeof record.token !== "string") {
    throw new UsageError(`workspace reservation generation ${generation} has no valid holder`);
  }
  if (readJson(`${file}.released`)?.token === record.token) {
    throw new UsageError(`workspace reservation generation ${generation} is already released`);
  }
  // Taken in an earlier boot: its holder and the job's CLI are gone whatever their pids show now.
  const rebooted = bootOf(record.bootId) === "earlier";
  if (!rebooted && isAlive(record.holderPid)) {
    throw new UsageError(`workspace reservation generation ${generation} is held by live runner pid ${record.holderPid}`);
  }

  const job = ID_RE.test(record.jobId ?? "") ? readRecord(jobFile(ws.jobsDir, record.jobId)) : null;
  const jobRebooted = rebooted || (job !== null && bootOf(job.bootId) === "earlier");
  if (!jobRebooted && job?.childPid && groupAlive(job.childPid)) {
    throw new UsageError(`workspace reservation generation ${generation} still has live CLI process group ${job.childPid}`);
  }

  const latest = currentReservation(ws.jobsDir);
  if (latest?.generation !== generation || latest.record?.token !== record.token || latest.record?.holderPid !== record.holderPid) {
    throw new UsageError("workspace reservation changed while checking; retry release-stale");
  }
  if (readJson(`${latest.file}.released`)?.token === record.token) {
    throw new UsageError(`workspace reservation generation ${generation} is already released`);
  }

  if (job && !TERMINAL.has(job.status)) {
    finalizeRecord(jobFile(ws.jobsDir, record.jobId), {
      status: "failed",
      errorClass: "crash",
      note: jobRebooted ? REBOOT_NOTE : "stale reservation released",
    });
  }
  if (!createReservation(`${file}.released`, { holderPid: process.pid, token: record.token })) {
    throw new UsageError(`workspace reservation generation ${generation} is already released`);
  }
  process.stdout.write(`released ${ws.root} generation ${generation}\n`);
  return 0;
}

async function claimRunnerReservation(file, jobId, token) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = readJson(file);
    if (current?.token !== token || current.jobId !== jobId) return false;
    if (current.holderPid === process.pid) return true;
    if (!isAlive(current.holderPid)) return false;
    await sleep(10);
  }
  return false;
}

// Liveness check: no record is ever left `running` with a dead runner.
function reapDeadRunners(jobsDir) {
  for (const record of listRecords(jobsDir)) {
    if (record.status !== "running") continue;
    const file = jobFile(jobsDir, record.id);
    const boot = bootOf(record.bootId);
    if (boot === "earlier") {
      // Its runnerPid / childPid may now be unrelated processes: finalize without any signal.
      const after = finalizeRecord(file, { status: "failed", errorClass: "crash", note: REBOOT_NOTE });
      if (after?.note === REBOOT_NOTE) appendLog(logFile(jobsDir, record.id), `${REBOOT_NOTE}; liveness check marked the job failed/crash, no process signalled`);
      continue;
    }
    if (record.runnerPid == null) {
      if (Date.now() - Date.parse(record.startedAt) > STARTUP_GRACE_MS) {
        finalizeRecord(file, { status: "failed", errorClass: "crash", note: "runner never started" });
      }
      continue;
    }
    if (isAlive(record.runnerPid)) continue;
    if (boot === "current") killGroup(record.childPid, "SIGKILL");
    const after = finalizeRecord(file, { status: "failed", errorClass: "crash", note: "runner died" });
    if (after?.note === "runner died") {
      appendLog(logFile(jobsDir, record.id), boot === "current" ? "runner died; liveness check marked the job failed/crash" : `runner died; liveness check marked the job failed/crash; CLI process group ${record.childPid} ${UNKNOWN_BOOT_NOTE}`);
    }
  }
}

// ---------- the ZCode CLI invocation ----------

export function buildCliArgv({ bin, prompt, workspaceRoot, sessionId }) {
  const argv = [
    bin,
    "-p",
    PROMPT_TRANSPORT === "stdin" ? "-" : prompt,
    "--output-format",
    "json",
    "--mode",
    "yolo",
    "--surface",
    "terminal",
    "--workflow-mode",
    "disabled",
    "--cwd",
    workspaceRoot,
    ...MODEL_ARGS,
  ];
  if (DISALLOWED_TOOLS.length > 0) argv.push("--disallowedTools", DISALLOWED_TOOLS.join(","));
  if (sessionId) argv.push("--resume", sessionId);
  return argv;
}

function buildCliEnv(paths, appVersion, model) {
  const env = {
    ...filterCliEnv(process.env),
    ...MODEL_ENV,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: paths.providerConfig,
    ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: paths.providerConfig,
    ZCODE_APP_VERSION: appVersion,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalConfigFile(model),
    ...cliHomeEnv(),
  };
  // The CLI also reads ZCODE_SESSION_DB as an alias of ZCODE_SESSION_DB_PATH; an inherited one could win.
  delete env.ZCODE_SESSION_DB;
  return env;
}

function summarizeArgv(argv) {
  return argv
    .map((arg, i) => (i > 0 && argv[i - 1] === "-p" && arg !== "-" ? `<prompt ${Buffer.byteLength(arg)} bytes>` : JSON.stringify(arg)))
    .join(" ");
}

// Runs the CLI as its own process group; resolves once it has exited and its output is drained.
// `redact` (keyRedactor) is applied to everything the wrapper keeps: stderr is handled line by line,
// so a key split across chunks is still caught before it reaches the log or stderrTail.
function runCli({ node, argv, cwd, env, stdinText, timeoutMs, logPath, onSpawn, redact = (text) => text, extraFds = [] }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let pendingErr = "";
    const keepErr = (text) => {
      if (!text) return;
      stderr = (stderr + text).slice(-262144);
      if (logPath) {
        try {
          fs.appendFileSync(logPath, text);
        } catch {
          // the log is best effort
        }
      }
    };
    let timedOut = false;
    let spawnError = null;
    let exitCode = null;
    let signal = null;
    let settled = false;
    let timer = null;
    let killTimer = null;
    let closeTimer = null;
    let child = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      if (timedOut && child?.pid) killGroup(child.pid, "SIGKILL");
      keepErr(redact(pendingErr));
      pendingErr = "";
      // A descendant that keeps the pipes open after the CLI exited must not append to the log any more.
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({ timedOut, spawnError, exitCode, signal, stdout: redact(stdout), stderrTail: stderr.split("\n").slice(-200).join("\n") });
    };
    try {
      child = spawn(node, argv, { cwd, env, detached: true, stdio: [stdinText === null ? "ignore" : "pipe", "pipe", "pipe", ...extraFds] });
    } catch (error) {
      spawnError = error;
      finish();
      return;
    }
    child.on("error", (error) => {
      spawnError = error;
      finish();
    });
    if (child.pid) onSpawn?.(child.pid);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      pendingErr += chunk.toString();
      const cut = pendingErr.lastIndexOf("\n");
      if (cut >= 0) {
        keepErr(redact(pendingErr.slice(0, cut + 1)));
        pendingErr = pendingErr.slice(cut + 1);
      } else if (pendingErr.length > 65536) {
        // a very long line: flush all but a tail longer than any key, which stays for the next pass
        const red = redact(pendingErr);
        keepErr(red.slice(0, -(API_KEY_MAX + 1)));
        pendingErr = red.slice(-(API_KEY_MAX + 1));
      }
    });
    if (stdinText !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdinText);
    }
    timer = setTimeout(() => {
      timedOut = true;
      if (logPath) appendLog(logPath, `timeout after ${timeoutMs} ms: SIGTERM to process group ${child.pid}`);
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), TIMEOUT_KILL_GRACE_MS);
    }, timeoutMs);
    child.on("exit", (code, sig) => {
      exitCode = code;
      signal = sig;
      closeTimer = setTimeout(finish, CLOSE_WAIT_MS);
    });
    child.on("close", (code, sig) => {
      if (exitCode === null && signal === null) {
        exitCode = code;
        signal = sig;
      }
      finish();
    });
  });
}

export function parseCliOutput(stdout) {
  try {
    const value = JSON.parse(stdout.trim());
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.response === "string") return value;
  } catch {
    // not JSON
  }
  return null;
}

// First match wins: timeout, launch (spawn error), then the pattern lists, then crash.
// ZCode ends every error with " (traceId: <uuid>)" (findings U4); strip it before matching,
// because a uuid can contain digit runs such as 401 or 429.
export function classifyFailure({ timedOut, spawnError, stdout, stderrTail }) {
  if (timedOut) return "timeout";
  if (spawnError) return "launch";
  const haystack = `${stderrTail}\n${stdout}`.replace(/\s*\(traceId:[^)]*\)/gi, "").toLowerCase();
  for (const errorClass of ["model-not-selected", "auth", "quota", "launch"]) {
    if (PATTERNS[errorClass].some((pattern) => haystack.includes(pattern.toLowerCase()))) return errorClass;
  }
  return "crash";
}

function evaluate(result) {
  if (!result.timedOut && !result.spawnError && result.exitCode === 0) {
    const json = parseCliOutput(result.stdout);
    return json ? { status: "completed", errorClass: null, json } : { status: "failed", errorClass: "malformed", json: null };
  }
  return { status: "failed", errorClass: classifyFailure(result), json: null };
}

const pick = (object, dotPath) => dotPath.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), object);

function reportedModelOf(json) {
  if (!REPORTED_MODEL_PATH) return null;
  const value = pick(json, REPORTED_MODEL_PATH);
  return typeof value === "string" ? value : null;
}

function reportedMatchesPin(reported, model) {
  const [pinnedId, pinnedLevel] = pinOf(model).split("$");
  const [id, level] = reported.slice(reported.lastIndexOf("/") + 1).split("$");
  return id === pinnedId && (level === undefined || level === pinnedLevel);
}

// ---------- verbs ----------

function parse(args, options, maxPositionals, minPositionals = 0) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const count = parsed.positionals.length;
  if (count > maxPositionals || count < minPositionals) throw new UsageError(`unexpected arguments: ${args.join(" ")}`);
  return parsed;
}

function checkPromptFile(value) {
  if (!value) throw new UsageError("task requires --prompt-file <file>");
  const file = path.resolve(value);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new UsageError(`prompt file not found or unreadable: ${file}`);
  }
  if (text.trim().length === 0) throw new UsageError(`prompt file is empty: ${file}`);
  const bytes = Buffer.byteLength(text);
  if (PROMPT_TRANSPORT === "argv" && bytes > MAX_PROMPT_BYTES) {
    throw new UsageError(`prompt file is ${bytes} bytes, above MAX_PROMPT_BYTES=${MAX_PROMPT_BYTES} for the argv transport`);
  }
  return file;
}

function resolveResume(jobsDir, ref, requestedModel) {
  if (!ID_RE.test(ref)) throw new UsageError(`${ref} is not a zcode-dispatch job id (zt-NNNN); Codex task- ids belong to codex-dispatch`);
  const record = readRecord(jobFile(jobsDir, ref));
  if (!record) throw new UsageError(`unknown job ${ref} in this workspace (pass the same --cwd as the original task)`);
  if (record.status === "running") throw new UsageError(`job ${ref} is still running; wait for it to finish`);
  if (record.status !== "completed" || !record.sessionId) throw new UsageError(`job ${ref} is ${record.status} / has no session; dispatch --fresh`);
  // A resumed session keeps the provider it started on; one from before 0.10.0 ran on the OAuth account provider.
  if (record.provider !== PINNED_SELECTION.providerId) throw new UsageError(`job ${ref} ran on ${record.provider ?? "the OAuth account provider"}, not ${PINNED_SELECTION.providerId}; its session cannot move to the API key; dispatch --fresh`);
  // A session keeps the model it started on (U1): a resume runs on that model; an explicit other --model is refused.
  const model = modelOfRecord(record);
  if (requestedModel !== undefined && requestedModel !== model) throw new UsageError(`job ${ref} ran on ${model}, not ${requestedModel}; a session keeps its model; dispatch --fresh`);
  return { resumeOf: ref, sessionId: record.sessionId, model };
}

async function cmdTask(args) {
  const { values } = parse(
    args,
    {
      background: { type: "boolean" },
      cwd: { type: "string" },
      "resume-task": { type: "string" },
      fresh: { type: "boolean" },
      "prompt-file": { type: "string" },
      model: { type: "string" },
    },
    0,
  );
  if (!values.background) throw new UsageError("task requires --background (there is no foreground mode)");
  const requestedModel = values.model !== undefined ? resolveModel(values.model) : undefined;
  if (values["resume-task"] !== undefined && values.fresh) throw new UsageError("--resume-task and --fresh are mutually exclusive");
  if (process.env.SP_IMPLEMENTER === "luna") throw new UsageError("SP_IMPLEMENTER=luna is set: the GLM channel is switched off (kill switch)");
  passthroughNames(); // refuse invalid names before any job or reservation state is written
  const lockProblem = configLockProblem(); // refuse here, not later as a failed/launch job in the runner
  if (lockProblem) throw new UsageError(lockProblem);
  const ws = requireWorkspace(values.cwd);
  refuseUnavailableReservation(ws.jobsDir, ws.root);
  const promptFile = checkPromptFile(values["prompt-file"]);
  const paths = zcodePaths();
  const appVersion = readAppVersion(paths.version);
  if (!appVersion) throw new UsageError(`cannot read ${paths.version.label}; refusing to run with an unknown client version`);
  if (!fs.existsSync(paths.bin)) throw new UsageError(`ZCode CLI not found: ${paths.bin}`);
  if (!fs.existsSync(paths.providerConfig)) throw new UsageError(`ZCode provider config not found: ${paths.providerConfig}`);
  const resume = values["resume-task"] !== undefined ? resolveResume(ws.jobsDir, values["resume-task"], requestedModel) : { resumeOf: null, sessionId: null, model: requestedModel ?? DEFAULT_MODEL };
  const model = resume.model;
  const pcfg = personalConfigFile(model);
  let configured;
  try {
    configured = readPersonalConfig(pcfg);
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (!hasApiKey(configured)) throw new UsageError(`no Coding Plan API key is configured in ${pcfg}; the user stores one: zcode-dispatch api-key set (keys: ${API_KEY_MANAGEMENT_URL})${model !== DEFAULT_MODEL ? `, or copies the stored one to ${model}: zcode-dispatch api-key sync` : ""}`);
  if (!isPinned(configured, model)) throw new UsageError(`${pcfg} does not pin ${pinOf(model)} via ${PINNED_SELECTION.providerId}; the user re-pins it: zcode-dispatch api-key ${model !== DEFAULT_MODEL ? "sync" : "set"}`);
  const templateProblem = apiKeyTemplateProblem(paths.providerConfig);
  if (templateProblem) throw new UsageError(`a Coding Plan API key is configured, but ${templateProblem}`);
  const timeoutMin = readTimeoutMin();
  const id = nextJobId(ws.jobsDir);
  const reservation = acquireReservation(ws.jobsDir, id, ws.root);
  let handedOff = false;
  try {
    reapDeadRunners(ws.jobsDir);
    const running = listRecords(ws.jobsDir).find((record) => record.status === "running");
    if (running) throw new UsageError(`job ${running.id} is still running in this workspace; one write task per working tree`);
    allocateRecord(ws.jobsDir, id, {
      status: "running",
      errorClass: null,
      sessionId: resume.sessionId,
      resumeOf: resume.resumeOf,
      workspaceRoot: ws.root,
      promptFile,
      model: pinOf(model),
      provider: PINNED_SELECTION.providerId,
      reportedModel: null,
      appVersion,
      runnerPid: null,
      childPid: null,
      startedAt: new Date().toISOString(),
      bootId: bootId(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      timeoutMin,
      response: null,
      usage: null,
      note: null,
    });
    const logFd = fs.openSync(logFile(ws.jobsDir, id), "a");
    let runner;
    try {
      runner = spawn(process.execPath, [SELF, "__run", id, ws.jobsDir, reservation.token], {
        cwd: ws.root,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      });
    } finally {
      fs.closeSync(logFd);
    }
    if (!runner.pid) {
      finalizeRecord(jobFile(ws.jobsDir, id), { status: "failed", errorClass: "launch", note: "runner failed to start" });
      throw new Error(`failed to start the runner for ${id}`);
    }
    if (!updateReservation(reservation.file, reservation.token, runner.pid)) {
      finalizeRecord(jobFile(ws.jobsDir, id), { status: "failed", errorClass: "launch", note: "workspace reservation was lost before the runner started" });
      throw new Error(`workspace reservation was lost before the runner started for ${id}`);
    }
    runner.unref();
    handedOff = true;
    process.stdout.write(`ZCode Task started in the background as ${id}\n`);
    return 0;
  } finally {
    if (!handedOff) releaseReservation(reservation.file, reservation.token);
  }
}

async function runJob(id, jobsDir, token) {
  if (!ID_RE.test(id ?? "") || !jobsDir || !token) throw new UsageError("usage: zcode-dispatch __run <zt-id> <jobs-dir> <reservation-token> (internal)");
  const file = jobFile(jobsDir, id);
  const log = logFile(jobsDir, id);
  const lock = reservationFileForToken(jobsDir, token);
  let configLockFd = null;
  try {
    const record = updateRunning(file, { runnerPid: process.pid });
    if (!record) return 0; // cancelled (or otherwise terminal) before the runner started
    if (!lock || !(await claimRunnerReservation(lock, id, token))) {
      finalizeRecord(file, { status: "failed", errorClass: "launch", note: "workspace reservation was lost before the runner started" });
      return 1;
    }
    let prompt;
    try {
      prompt = fs.readFileSync(record.promptFile, "utf8");
    } catch (error) {
      finalizeRecord(file, { status: "failed", errorClass: "launch", note: `cannot read prompt file: ${error.message}` });
      return 1;
    }
    const model = modelOfRecord(record);
    const pcfg = personalConfigFile(model);
    let pinned;
    try {
      configLockFd = openConfigLock(LOCK_SHARED, 10_000);
      if (configLockFd === null) throw new Error("an api-key command holds the config lock; retry");
      securePersonalConfig(pcfg);
      pinned = readPersonalConfig(pcfg);
    } catch (error) {
      finalizeRecord(file, { status: "failed", errorClass: "launch", note: `cannot read the personal provider config: ${error.message}` });
      return 1;
    }
    // Without the key rule or the pin the CLI would fall back to another model and provider: never spawn it.
    if (!hasApiKey(pinned)) {
      finalizeRecord(file, { status: "failed", errorClass: "auth", note: "no Coding Plan API key in the personal provider config (cleared after the task was queued?); the user stores one: zcode-dispatch api-key set" });
      return 1;
    }
    if (!isPinned(pinned, model)) {
      finalizeRecord(file, { status: "failed", errorClass: "model-not-selected", note: `the personal provider config ${pcfg} does not pin ${pinOf(model)} via ${PINNED_SELECTION.providerId}; the user re-pins it: zcode-dispatch api-key ${model !== DEFAULT_MODEL ? "sync" : "set"}` });
      return 1;
    }
    try {
      ensureCliHome();
    } catch (error) {
      finalizeRecord(file, { status: "failed", errorClass: "launch", note: `cannot create the CLI home: ${error.message}` });
      return 1;
    }
    const paths = zcodePaths();
    let env;
    try {
      env = buildCliEnv(paths, record.appVersion, model);
    } catch (error) {
      finalizeRecord(file, { status: "failed", errorClass: "launch", note: error.message });
      return 1;
    }
    const argv = buildCliArgv({ bin: paths.bin, prompt, workspaceRoot: record.workspaceRoot, sessionId: record.resumeOf ? record.sessionId : null });
    appendLog(log, `start ${id}: ${JSON.stringify(paths.node)} ${summarizeArgv(argv)}`);
    appendLog(log, describeCliEnv(env));
    const redact = keyRedactor(pcfg, pinned);
    const result = await runCli({
      node: paths.node,
      argv,
      cwd: record.workspaceRoot,
      env,
      redact,
      stdinText: PROMPT_TRANSPORT === "stdin" ? prompt : null,
      timeoutMs: record.timeoutMin * 60_000,
      logPath: log,
      extraFds: [configLockFd], // fd 3: the CLI keeps the shared config lock, also if this runner dies
      onSpawn: (pid) => {
        if (!updateRunning(file, { childPid: pid })) killGroup(pid, "SIGTERM"); // cancelled meanwhile
      },
    });
    const verdict = evaluate(result);
    const patch = { status: verdict.status, errorClass: verdict.errorClass, exitCode: result.exitCode, signal: result.signal };
    if (verdict.json) {
      patch.response = redact(verdict.json.response); // stdout was redacted already; the parsed text once more
      patch.usage = verdict.json.usage && typeof verdict.json.usage === "object" ? verdict.json.usage : null;
      patch.reportedModel = reportedModelOf(verdict.json);
      if (typeof verdict.json.sessionId === "string") patch.sessionId = verdict.json.sessionId;
    } else {
      const reason = result.spawnError ? `spawn error ${result.spawnError.code ?? result.spawnError.message}` : `exit=${result.exitCode} signal=${result.signal} timedOut=${result.timedOut}`;
      appendLog(log, `classified failed/${verdict.errorClass} (${reason})`);
      if (result.stdout.trim()) appendLog(log, `raw stdout:\n${result.stdout}`);
    }
    const final = finalizeRecord(file, patch);
    appendLog(log, `finish ${id}: ${final?.status}${final?.errorClass ? `/${final.errorClass}` : ""}`);
    return 0;
  } finally {
    if (configLockFd !== null) fs.closeSync(configLockFd);
    if (lock) releaseReservation(lock, token);
  }
}

function statusLine(record) {
  const end = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();
  const secs = Math.max(0, Math.round((end - Date.parse(record.startedAt)) / 1000));
  const state = record.status === "failed" ? `failed/${record.errorClass}` : record.status;
  const elapsed = `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
  return [record.id, state, elapsed, record.model, record.sessionId ?? "-", ...(record.resumeOf ? [`resumeOf=${record.resumeOf}`] : [])].join(" ");
}

function cmdStatus(args) {
  const { values, positionals } = parse(args, { cwd: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } }, 1);
  const ws = requireWorkspace(values.cwd);
  reapDeadRunners(ws.jobsDir);
  if (positionals.length === 1) {
    const record = requireJob(ws.jobsDir, positionals[0]);
    process.stdout.write(values.json ? `${JSON.stringify({ job: record }, null, 2)}\n` : `${statusLine(record)}\n`);
    return 0;
  }
  const records = listRecords(ws.jobsDir);
  const running = records.filter((record) => record.status === "running");
  const terminal = records.filter((record) => record.status !== "running");
  const recent = values.all ? terminal : terminal.slice(0, 10);
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ workspaceRoot: ws.root, running, recent }, null, 2)}\n`);
  } else {
    for (const record of [...running, ...recent]) process.stdout.write(`${statusLine(record)}\n`);
  }
  return 0;
}

function cmdResult(args) {
  const { values, positionals } = parse(args, { cwd: { type: "string" } }, 1, 1);
  const ws = requireWorkspace(values.cwd);
  reapDeadRunners(ws.jobsDir);
  const record = requireJob(ws.jobsDir, positionals[0]);
  if (record.status === "completed") {
    const text = record.response ?? "";
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  }
  process.stderr.write(`job ${record.id} is ${record.status} errorClass=${record.errorClass}\n${tailLines(logFile(ws.jobsDir, record.id), 20)}`);
  return 1;
}

async function cmdCancel(args) {
  const { values, positionals } = parse(args, { cwd: { type: "string" } }, 1, 1);
  const ws = requireWorkspace(values.cwd);
  reapDeadRunners(ws.jobsDir); // finalizes a job from an earlier boot, so its pids are never signalled below
  const record = requireJob(ws.jobsDir, positionals[0]);
  const file = jobFile(ws.jobsDir, record.id);
  // The cancelled record is written first, so a runner finishing meanwhile cannot overwrite it.
  const after = record.status === "running" ? finalizeRecord(file, { status: "cancelled", errorClass: null, note: "cancelled by zcode-dispatch cancel" }) : record;
  if (after.status !== "cancelled" || record.status !== "running") {
    process.stdout.write(`${record.id} is ${after.status}\n`);
    return 0;
  }
  if (bootOf(record.bootId) !== "current") {
    appendLog(logFile(ws.jobsDir, record.id), `cancel: record set to cancelled; CLI process group ${after.childPid} ${UNKNOWN_BOOT_NOTE}`);
    process.stdout.write(`cancelled ${record.id} (CLI process group ${after.childPid ?? "-"} ${UNKNOWN_BOOT_NOTE}; check it with: ps -g ${after.childPid ?? "<pgid>"})\n`);
    return 0;
  }
  appendLog(logFile(ws.jobsDir, record.id), "cancel: record set to cancelled; SIGTERM to the CLI process group");
  killGroup(after.childPid, "SIGTERM");
  const deadline = Date.now() + CANCEL_GRACE_MS;
  while (groupAlive(after.childPid) && Date.now() < deadline) await sleep(200);
  if (groupAlive(after.childPid)) killGroup(after.childPid, "SIGKILL");
  process.stdout.write(`cancelled ${record.id}\n`);
  return 0;
}

async function cmdDoctor(args) {
  const { values } = parse(args, { cwd: { type: "string" }, probe: { type: "boolean" }, model: { type: "string" } }, 0);
  const probeModel = resolveModel(values.model);
  const cwd = path.resolve(values.cwd ?? process.cwd());
  const paths = zcodePaths();
  const lines = [];
  let failed = false;
  const report = (level, check, detail) => {
    lines.push(`${level} ${check}: ${detail}`);
    if (level === "FAIL") failed = true;
  };

  const platformProblem = configLockProblem();
  if (platformProblem) report("FAIL", "platform", platformProblem);
  else report("ok", "platform", process.platform === "linux" ? "linux (config lock: flock(1))" : process.platform);
  const appVersion = readAppVersion(paths.version);
  if (appVersion) report("ok", "app", `${paths.app} ${appVersion}`);
  else report("FAIL", "app", `cannot read ${paths.version.label}`);
  if (fs.existsSync(paths.bin)) report("ok", "cli", paths.bin);
  else report("FAIL", "cli", `not found: ${paths.bin}`);
  if (fs.existsSync(paths.providerConfig)) report("ok", "provider-config", paths.providerConfig);
  else report("FAIL", "provider-config", `not found: ${paths.providerConfig}`);
  const nodeRun = spawnSync(paths.node, ["--version"], { encoding: "utf8" });
  if (nodeRun.error || nodeRun.status !== 0) {
    report("FAIL", "node", `cannot run ${paths.node} --version`);
  } else {
    const version = nodeRun.stdout.trim();
    const major = Number(/^v(\d+)/.exec(version)?.[1] ?? 0);
    if (major >= VERIFIED_NODE_MAJOR) report("ok", "node", version);
    else report("WARN", "node", `${version} is below the verified major ${VERIFIED_NODE_MAJOR}`);
  }
  if (!appVersion) report("WARN", "app-version", "unknown (app check failed)");
  else if (appVersion !== VERIFIED_APP_VERSION) report("WARN", "app-version", `installed ${appVersion} differs from verified ${VERIFIED_APP_VERSION}; re-run the live acceptance`);
  else report("ok", "app-version", appVersion);
  const ws = resolveWorkspace(cwd);
  if (ws) report("ok", "git", ws.root);
  else report("FAIL", "git", `not inside a git work tree: ${cwd}`);
  try {
    fs.mkdirSync(stateRoot(), { recursive: true });
    fs.accessSync(stateRoot(), fs.constants.W_OK);
    report("ok", "state-dir", stateRoot());
  } catch (error) {
    report("FAIL", "state-dir", `${stateRoot()} is not writable: ${error.message}`);
  }
  try {
    report("ok", "cli-home", ensureCliHome());
  } catch (error) {
    report("FAIL", "cli-home", `cannot create ${cliHome()}: ${error.message}`);
  }
  let keyed = null;
  try {
    securePersonalConfig(personalConfigFile());
    const current = readPersonalConfig(personalConfigFile());
    keyed = hasApiKey(current);
    if (isPinned(current)) report("ok", "personal-config", `${personalConfigFile()} pins ${PINNED_MODEL} via ${PINNED_SELECTION.providerId}`);
    else report("FAIL", "personal-config", `${personalConfigFile()} does not pin ${PINNED_MODEL} via ${PINNED_SELECTION.providerId}; the user re-pins it: zcode-dispatch api-key set`);
  } catch (error) {
    report("FAIL", "personal-config", `cannot read ${personalConfigFile()}: ${error.message}`);
  }
  // Every other model: WARN while it is not set up (the default model still runs), FAIL when --model names it.
  for (const model of MODEL_IDS.filter((id) => id !== DEFAULT_MODEL)) {
    const file = personalConfigFile(model);
    const level = model === probeModel ? "FAIL" : "WARN";
    const check = `personal-config ${model}`;
    try {
      securePersonalConfig(file);
      const current = fs.existsSync(file) ? readPersonalConfig(file) : null;
      if (!current) report(level, check, `${file} does not exist: --model ${model} is not set up; the user copies the stored key to it: zcode-dispatch api-key sync`);
      else if (!hasApiKey(current)) report(level, check, `no Coding Plan API key in ${file}; the user copies the stored one: zcode-dispatch api-key sync`);
      else if (!isPinned(current, model)) report(level, check, `${file} does not pin ${pinOf(model)} via ${PINNED_SELECTION.providerId}; the user re-pins it: zcode-dispatch api-key sync`);
      else report("ok", check, `${file} pins ${pinOf(model)} via ${PINNED_SELECTION.providerId}`);
    } catch (error) {
      report(level, check, `cannot read ${file}: ${error.message}`);
    }
  }
  if (keyed === true) {
    const problem = apiKeyTemplateProblem(paths.providerConfig);
    if (problem) report("FAIL", "auth", `ZCode template incompatible: a Coding Plan API key is stored, but ${problem}; a new key does not help — the wrapper needs an update for this ZCode`);
    else report("ok", "auth", `Coding Plan API key (personal provider ${API_KEY_PROVIDER_ID} from ZCode's template ${API_KEY_TEMPLATE_ID}): no token exchange, no expiry`);
  } else if (keyed === false) {
    report("FAIL", "auth", `no Coding Plan API key in ${personalConfigFile()}; the user stores one: zcode-dispatch api-key set (keys: ${API_KEY_MANAGEMENT_URL})`);
  }
  if (process.env.SP_IMPLEMENTER === "luna") report("WARN", "kill-switch", "SP_IMPLEMENTER=luna is set; task will refuse");
  else report("ok", "kill-switch", "SP_IMPLEMENTER is not luna");

  try {
    const env = filterCliEnv(process.env);
    const passthrough = passthroughNames();
    const detail = `${Object.keys(env).length} caller variables pass the allowlist${passthrough.length > 0 ? `; ${ENV_PASSTHROUGH_VAR}: ${passthrough.join(" ")}` : ""}`;
    const proxied = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((name) => env[name]);
    if (proxied && !env.ZCODE_HTTP_PROXY) report("WARN", "env", `${detail}; HTTP(S)_PROXY is set but ZCODE_HTTP_PROXY is not, and the ZCode CLI's own requests use only ZCODE_HTTP_PROXY`);
    else report("ok", "env", detail);
  } catch (error) {
    report("FAIL", "env", error.message);
  }

  process.stdout.write(`${lines.join("\n")}\ndoctor: ${failed ? "FAIL" : "ok"}\n`);
  if (failed) return 1;
  if (!values.probe) return 0;
  return await runProbe(paths, appVersion, ws.root, probeModel);
}

// One synchronous PONG request: the only diagnostic that spends quota.
async function runProbe(paths, appVersion, root, model) {
  const configLockFd = openConfigLock(LOCK_SHARED, 10_000);
  if (configLockFd === null) throw new Error("an api-key command holds the config lock; retry doctor --probe");
  try {
    return await probeWithLock(paths, appVersion, root, configLockFd, model);
  } finally {
    fs.closeSync(configLockFd);
  }
}

async function probeWithLock(paths, appVersion, root, configLockFd, model) {
  const pcfg = personalConfigFile(model);
  securePersonalConfig(pcfg);
  const pinned = readPersonalConfig(pcfg);
  // Under the shared lock the file cannot change before the CLI reads it, but an api-key clear may have run
  // since the offline checks: without the key or the pin the CLI would fall back to another model.
  const missing = !hasApiKey(pinned) ? "auth" : !isPinned(pinned, model) ? "model-not-selected" : null;
  if (missing) {
    process.stdout.write(`model-selected: FAIL(${missing})\nanswers: FAIL\nreported-model: unreported\nusage: input=- cached=- output=-\nprobe: FAIL\n`);
    process.stderr.write(`hint: ${missing === "auth" ? "no Coding Plan API key is stored" : `the personal provider config does not pin ${pinOf(model)}`}; the user runs: zcode-dispatch api-key ${model !== DEFAULT_MODEL ? "sync" : `set (keys: ${API_KEY_MANAGEMENT_URL})`}\n`);
    return 1;
  }
  ensureCliHome();
  const argv = buildCliArgv({ bin: paths.bin, prompt: PROBE_PROMPT, workspaceRoot: root, sessionId: null });
  const result = await runCli({
    node: paths.node,
    argv,
    cwd: root,
    env: buildCliEnv(paths, appVersion, model),
    stdinText: PROMPT_TRANSPORT === "stdin" ? PROBE_PROMPT : null,
    timeoutMs: PROBE_TIMEOUT_MS,
    logPath: null,
    redact: keyRedactor(pcfg, pinned),
    extraFds: [configLockFd],
  });
  const verdict = evaluate(result);
  const json = verdict.json;
  const modelSelected = verdict.status === "completed";
  const answers = modelSelected && json.response.includes("PONG");
  const reported = json ? reportedModelOf(json) : null;
  const modelMatches = reported === null || reportedMatchesPin(reported, model);
  const usage = json?.usage ?? {};
  const count = (field) => {
    const value = field ? pick(usage, field) : undefined;
    return typeof value === "number" ? String(value) : "-";
  };
  const ok = modelSelected && answers && modelMatches;
  process.stdout.write(
    [
      `model-selected: ${modelSelected ? `ok (${pinOf(model)})` : `FAIL(${verdict.errorClass})`}`,
      `answers: ${answers ? "ok" : "FAIL"}`,
      `reported-model: ${reported ?? "unreported"}`,
      `usage: input=${count(USAGE_FIELDS.input)} cached=${count(USAGE_FIELDS.cached)} output=${count(USAGE_FIELDS.output)}`,
      `probe: ${ok ? "ok" : "FAIL"}`,
    ].join("\n") + "\n",
  );
  if (!modelSelected && result.stderrTail.trim()) process.stderr.write(`${result.stderrTail.split("\n").slice(-20).join("\n")}\n`);
  if (verdict.errorClass === "auth" || verdict.errorClass === "model-not-selected") {
    process.stderr.write(
      `hint: the ZCode CLI could not use the Coding Plan API key in ${pcfg} (revoked, mistyped, its plan has no GLM access, or this ZCode version treats the zai-api template differently); store a valid one: zcode-dispatch api-key set (keys: ${API_KEY_MANAGEMENT_URL})\n`,
    );
  }
  return ok ? 0 : 1;
}

// Reads one secret line: from a pipe until EOF, or from a terminal with echo off. Never echoes it.
async function readSecretLine(promptText) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = "";
    stdin.setEncoding("utf8");
    for await (const chunk of stdin) text += chunk;
    return text;
  }
  process.stderr.write(promptText);
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  return await new Promise((resolve, reject) => {
    let value = "";
    const done = (error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk.replace(/\x1b\[20[01]~/g, "")) { // bracketed-paste markers
        if (ch === "\r" || ch === "\n") return done(); // only Enter accepts
        if (ch === "\u0003" || ch === "\u0004") return done(new UsageError("api-key set cancelled; nothing stored"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
      return undefined;
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

// `api-key set` — the user's Coding Plan API key (created at API_KEY_MANAGEMENT_URL), read from stdin only:
// never an argument (visible in ps and shell history) or a variable (the CLI's tools inherit the CLI's
// whole environment). Stored only in the wrapper's personal provider config (mode 0600) as a provider of
// ZCode's own template API_KEY_TEMPLATE_ID; the CLI then sends it itself — no OAuth exchange, no expiry.
// `api-key clear` removes it, which switches the GLM channel off (task refuses, doctor fails `auth`) until
// a key is stored again. Both are refused while a run holds the config lock. Neither verb runs the CLI or
// prints the key.
async function cmdApiKey(args) {
  // Arguments are never echoed: a key typed as an argument must not reach stderr (parse() would print it).
  const [action, ...rest] = args;
  if (action === "set" && rest.length > 0) throw new UsageError("api-key set takes the key on stdin, never as an argument (e.g. pbpaste | zcode-dispatch api-key set, or xclip -o -selection clipboard | … on Linux); nothing stored");
  const files = MODEL_IDS.map((model) => personalConfigFile(model)).join(", ");
  if (action === "clear") {
    if (rest.length > 0) throw new UsageError("usage: zcode-dispatch api-key clear (no arguments)");
    setApiKeyRule(null);
    process.stdout.write(`api-key: cleared from ${files}; the GLM channel is off until a key is stored again (zcode-dispatch api-key set)\n`);
    return 0;
  }
  if (action === "sync") {
    if (rest.length > 0) throw new UsageError("usage: zcode-dispatch api-key sync (no arguments; copies the stored key to every model)");
    const problem = apiKeyTemplateProblem(zcodePaths().providerConfig);
    if (problem) throw new UsageError(`cannot use a Coding Plan API key with this ZCode: ${problem}`);
    setApiKeyRule(undefined);
    process.stdout.write(`api-key: the stored key now also serves ${MODEL_IDS.filter((id) => id !== DEFAULT_MODEL).join(", ")}; files ${files} (mode 0600), each pinned to its model (${MODEL_IDS.map(pinOf).join(", ")}); check one with: zcode-dispatch doctor --probe --model <id>\n`);
    return 0;
  }
  if (action !== "set") throw new UsageError("usage: zcode-dispatch api-key <set|sync|clear> (set reads the key on stdin)");
  const paths = zcodePaths();
  const problem = apiKeyTemplateProblem(paths.providerConfig);
  if (problem) throw new UsageError(`cannot use a Coding Plan API key with this ZCode: ${problem}`);
  const key = (await readSecretLine(`Z.ai Coding Plan API key (${API_KEY_MANAGEMENT_URL}; input hidden): `)).trim();
  if (!key) throw new UsageError("no API key on stdin; nothing stored");
  if (!API_KEY_PATTERN.test(key)) {
    // The shape only, never the content: enough to see a copied command or a pasted label.
    const lines = key.split(/\r?\n/).length;
    const spaces = (key.match(/[ \t]/g) ?? []).length;
    const other = (key.match(/[^A-Za-z0-9._\- \t\r\n]/g) ?? []).length;
    throw new UsageError(
      `stdin is not one API key: got ${key.length} characters on ${lines} line(s), ${spaces} space(s), ${other} other character(s) outside A–Z a–z 0–9 . _ - (expected 8–${API_KEY_MAX} of those on one line); nothing stored. If the clipboard held this command rather than the key, run "zcode-dispatch api-key set" without a pipe and paste the key at the hidden prompt`,
    );
  }
  setApiKeyRule(key);
  process.stdout.write(
    `api-key: stored in ${personalConfigFile()} (mode 0600) as provider ${API_KEY_PROVIDER_ID} from ZCode's template ${API_KEY_TEMPLATE_ID}; pinned to ${PINNED_MODEL}; also in ${MODEL_IDS.filter((id) => id !== DEFAULT_MODEL).map((id) => `${personalConfigFile(id)} (${pinOf(id)})`).join(", ")}; check it with: zcode-dispatch doctor --probe\n`,
  );
  return 0;
}

export async function main(argv) {
  const [verb, ...rest] = argv;
  try {
    switch (verb) {
      case "task":
        return await cmdTask(rest);
      case "status":
        return cmdStatus(rest);
      case "result":
        return cmdResult(rest);
      case "cancel":
        return await cmdCancel(rest);
      case "release-stale":
        return cmdReleaseStale(rest);
      case "doctor":
        return await cmdDoctor(rest);
      case "api-key":
        return await cmdApiKey(rest);
      case "__run":
        return await runJob(rest[0], rest[1], rest[2]);
      default:
        throw new UsageError(`usage: zcode-dispatch <task|status|result|cancel|release-stale|doctor|api-key> [args...]${verb ? ` (unknown verb: ${verb})` : ""}`);
    }
  } catch (error) {
    process.stderr.write(`zcode-dispatch: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
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
