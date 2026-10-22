// agent-core.mjs — the shared job core of agent-dispatch: background jobs of coding-agent harnesses (claude -p,
// opencode, pi, dsh) run headless through adapters (docs/superpowers/specs/2026-10-20-universal-dispatchers-design.md,
// §3.1–§3.10).
//
// It started as a copy of the harness-agnostic part of zcode-dispatch.mjs — job store, workspace reservation,
// boot-id reaper, runCli, the environment allowlist, status / result / cancel / release-stale — and evolves on its
// own: zcode-dispatch.mjs does not import it and is not changed. New here: a descendant snapshot (ps) with per-adapter
// signal ladders, redactor(values[]), the key handoff to the runner, the adapter contract and the extended error
// classes.
//
// Pure Node ESM, no dependencies, no shell: every child process is spawned with an argv array. A library only: the
// CLI (bin/lib/agent-dispatch.mjs; tests/fixtures/core-harness.mjs in the tests) owns argument parsing, config.json,
// key resolution and the pass-through to zcode-dispatch / codex-dispatch.
//
// ---- API overview: what the CLI calls ----
// task (foreground):
//   const { id } = await startJob({ adapter, profileName, profile, role, write, cwd, promptFile, resumeTaskId,
//                                   resolveSecret, cliPath });  then print startLine(profileName, id).
//   startJob validates the prompt, resume, profile.env against the adapter's mandatory names, maxParallel across all
//   workspaces and the write reservation — and only then, and only when the adapter asks for a key, calls
//   resolveSecret(), so a refused task never runs keyCmd (spec §3.3, §3.5). It allocates <prefix>-NNNN and hands the key
//   to the detached runner over a private anonymous pipe (fd 3). The resolved value is never added to a job file,
//   argv or the runner environment; the caller's existing environment remains inherited as before.
//   A refusal throws UsageError (exit 2) and leaves no job behind. `profile` is the resolved profile object (defaults
//   such as `home` already applied by the CLI). `resolveSecret` is `async () => string | null` over the profile's key
//   source (key / keyEnv / keyCmd), or null for a profile without one; a UsageError it throws is the refusal as it
//   stands (`<P>: key unavailable (<reason>) errorClass=auth`), any other error is wrapped into one. The core trims
//   the value and refuses an empty one, one with inner whitespace, and a profile that holds the key in a field.
// runner (the CLI's internal verb RUN_VERB):
//   return await runJob({ id, jobsDir, token, adapters })   with adapters = { <harness id>: adapter }.
//   discover → prepareHome → invocation → the harness (runCli) → scrub → reduce → finalize → the terminal record.
//   The runner owns every stop of its harness: it watches the record and runs the adapter's ladder once the job is
//   cancelled.
//   One runner per job: it claims <id>.json.runner exclusively before anything else. That file is the job's
//   append-only ownership log: the runner's and its harness's identity, and every other process group the job may
//   own (an auxiliary command's, a descendant a snapshot found) by its leader's identity, each written before it could
//   outlive what links it to the job (also after a terminal claim, when the record no longer changes).
//   <id>.json.cleaned marks that nothing the log names is left; until then the write reservation stays held, a
//   repeated cancel and the reaper resume the cleanup, by verified identities only, and the verdict stays as it was
//   claimed.
// other verbs, for core ids (route zt- / task- ids to the wrappers before calling these):
//   statusCommand({ cwd, id, json, all }), resultCommand({ cwd, id }), await cancelCommand({ cwd, id }),
//   releaseStaleCommand({ cwd }) — each returns the exit code and writes to an { stdout, stderr } sink.
//   For the merged `status` list: listJobSummaries(cwd) + summaryLine(); maxParallel: runningJobsOfProfile(name).
// doctor (spec §5.4): envConflicts(profile.env, await mandatorySettings(adapter, profile, ctx)) for the env check,
//   await discoverHarness(adapter, ctx) for the binary, its version and the required flags (through `wrap`);
//   --probe: await runProbe({ adapter, profileName, profile, resolveSecret }) → { status, errorClass, response, … }.
// errors: print `${CLI_NAME}: ${error.message}` and exit with exitCodeOf(error): 2 for UsageError (refusal without
//   launch), 1 otherwise. Also exported: redactor(values), filterEnv / buildEnv / passthroughNames, readSecretLine
//   and checkKeyText (key set), writePrivateFile, writeAdapterFiles, dataPaths(), makeCtx(), terminateTree(),
//   processIdentity(), boundedExec() (a short command under a hard deadline, with no controlling terminal),
//   recordGroups() (the ownership log), ERROR_CLASSES.
// Process identity: every stored pid (runner, reservation holder, the leader of a process group) is kept with its
//   start time (processStart: /proc ticks since boot on Linux, `ps -o lstart` on macOS — neither moves with the wall
//   clock) and compared before the pid decides anything — liveness, a descendant snapshot, a signal. A pid alive with
//   another start time is a stranger (`foreign`); one whose start time cannot be read, or was never recorded, is
//   `unknown`, which never authorizes a signal and never counts as gone. harnessGroupState() and processIdentity()
//   therefore return four states: a caller that signals on anything but "ours" is wrong. A group of the ownership log
//   is the job's only while its leader is (a group id outlives its leader, and a stranger can lead a group under it
//   later); only the harness group, whose leader the runner watched, also counts while members outlive the leader
//   (on Linux while they are in the harness's own session: inAnotherSession).
//   A process that ended but was never reaped (a zombie, for good under a Linux container's pid 1 that does not reap)
//   is gone for all of this: isAlive() and groupAlive() do not count it (a group only once a second /proc scan
//   confirms the first, zombieOnlyGroups). A zombie is a process whose threads have all ended: one whose main thread
//   alone ended reads Z too, and lives (hasEnded). Its start time still counts as identity: a zombie holding the
//   harness group's leader pid makes that group foreign when its start time differs, unknown when it cannot be
//   compared (harnessGroupState).
// The adapter contract (spec §3.2) — adapters return data, the core owns processes, files, signals and keys:
//   { id, idPrefix, manifest: { sessionId: "preassign" | "first-event", sessionIdFormat?: "uuid" | "job-id",
//     cancel: { ladder: [[signal, waitMs], …] }, helpArgv?, requiredFlags?, homeEnv? },
//     discover?(ctx) → { bin, version },  prepareHome?(profile, ctx) → { env, dirs, files },
//     invocation(req, ctx) → { argv, env, mandatoryEnv, secretEnv: [names], stdinPath, cwd, dirs, files,
//                              inheritEnv?, meta? },
//     probe?(req, ctx) → the same shape, for one "Reply with exactly: PONG" turn (default: invocation),
//     beforeLaunch?(req, ctx) → void (or throw to refuse), after materialize; ctx.execHarness(args, {timeoutMs,
//       graceMs, includeSecrets=false}) runs the discovered binary behind wrap in the job cwd; the default env
//       omits its key, includeSecrets opts that same trusted binary into the exact harness env for config evaluation,
//     reduce(io) → { ok, response, sessionId, usage, reportedModel, errorClass, errorText, meta? },
//     finalize?(job, ctx) → null | partial reduce result,  resumeCheck?(prev, profile, req, ctx) → null | reason,
//     scrub?(job, ctx) → [{ path, mode, content }] (the harness's own files rewritten with ctx.redact; keyed jobs only),
//     patterns: { <error class> | "transient": [string | RegExp] } }.
//   `env` holds the adapter's defaults (§3.6 Б), `mandatoryEnv` and prepareHome's `env` the mandatory settings
//   (§3.6 А); a null value removes a name. `dirs` (absolute; created 0700) and `files` ({ path, mode, content }) must
//   lie under the data root. `meta` is a small JSON object the record keeps, redacted (resumeCheck reads prev.meta,
//   e.g. the config or profile directory a session lives in). scrub and finalize, which run after the harness, also get
//   job.planMeta: the meta this job's invocation returned, before the harness ran; record.meta may have been rewritten
//   by the harness (the record lies under state/, which a sandboxed job may write), so either hook takes the paths it
//   reads or rewrites from planMeta, not from job.record. invocation and prepareHome must be pure: startJob calls
//   them once at task time, and runProbe before discovery (req.harness is null then both times), to refuse a
//   profile.env that touches a mandatory name and to learn whether a key is needed; probe() always gets the harness. Only
//   reduce() decides success; the exit code is informational. discover / prepareHome / finalize / resumeCheck reach
//   processes and files only through ctx.exec and ctx.fs. ctx.exec(cmd, args, { timeoutMs, graceMs, cwd, env, input })
//   is synchronous and returns { status, signal, stdout, stderr, error, timedOut, stopped } (error as spawnSync's); the
//   command runs in a session and process group of its own (no controlling terminal; what it leaves in that group is
//   killed when it is done) under a hard deadline (SIGTERM at timeoutMs, default 10 s, 0 or null for none; SIGKILL
//   after graceMs) and, in a runner, is stopped the same way once the job is cancelled or the runner is gone, its group
//   recorded in the job's ownership log before it starts (boundedExec). discover's ctx.exec runs through the profile's
//   `wrap` (ctx.execHost does not); finalize gets job.env (the harness environment without the key), job.wrap and
//   ctx.execHarness(args), which runs `<wrap> <bin> args` in that environment.
//
// Exit codes: 0 success · 1 runtime failure · 2 usage error or guard refusal (no job started).

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";

export const CLI_NAME = "agent-dispatch";
export const RUN_VERB = "__run";
export const STATE_DIR_VAR = "AGENT_DISPATCH_STATE_DIR";
export const TEST_BOOT_ID_VAR = "AGENT_TEST_BOOT_ID";
// Tests only: "unavailable" makes every process start time unreadable (an unprivileged or broken ps, no /proc).
export const TEST_PS_START_VAR = "AGENT_TEST_PS_START";
// Tests only: a file a runner waits for between the reads its claim decision rests on and the exclusive runner claim
// (runBarrier), so two runners that both read the job unclaimed commit their claims at the same moment.
export const TEST_RUN_BARRIER_VAR = "AGENT_TEST_RUN_BARRIER";
// Tests only: milliseconds an auxiliary command's supervisor waits before its first step (boundedExec), so its caller
// can die before it initialized.
export const TEST_EXEC_DELAY_VAR = "AGENT_TEST_EXEC_DELAY_MS";
export const DEFAULT_TIMEOUT_MIN = 60;
export const DEFAULT_MAX_PARALLEL = 2;
export const DEFAULT_LADDER = [["SIGTERM", 5000], ["SIGKILL", 0]];
// The seven classes of zcode-dispatch plus the five of spec §3.8.
export const ERROR_CLASSES = [
  "timeout", "crash", "launch", "malformed", "auth", "quota", "model-not-selected",
  "rate-limit", "server", "context", "blocked", "resume-lost",
];
// Adapter pattern lists, matched in this order against a failure reduce() left unclassified: [pattern key, class].
// `transient` is the adapter-side name for a retryable server-side failure.
export const PATTERN_ORDER = [
  ["resume-lost", "resume-lost"], ["model-not-selected", "model-not-selected"], ["auth", "auth"], ["quota", "quota"],
  ["context", "context"], ["blocked", "blocked"], ["rate-limit", "rate-limit"], ["server", "server"],
  ["transient", "server"], ["launch", "launch"],
];
// A resumed job runs on the current profile (config.json), never on the record's snapshot: a job under a sandbox may
// write the data dir's state/, and an env, bin or wrap it rewrote there must never reach the next run of its session.
// The snapshot only decides refusal: these fields of it must still match the current profile (spec §3.6 А12) — what
// the session lives with (harness, model, endpoint, home), what runs it (bin, wrap, sandbox) and who pays for it
// (auth: the key source or the login; keyVar / authHeader: the variable the key reaches the harness in). A rotated
// value behind the same key source is no drift.
export const RESUME_BOUND_FIELDS = ["harness", "model", "endpoint", "home", "bin", "wrap", "sandbox", "auth", "keyVar", "authHeader"];
export const REDACTED = "<redacted>";
export const TERMINAL = new Set(["completed", "failed", "cancelled"]);
export const PROFILE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

// ---- Environment of a harness: an allowlist (zcode-dispatch's, without its ZCODE_* entries; spec §3.6 А10) ----
// A harness's Bash tool inherits the harness's whole environment, so this is also what the model's shell commands
// see. Names listed in AGENT_ENV_PASSTHROUGH opt in even when secret-like; adapter and profile settings are applied
// afterwards (buildEnv), so inherited values never override them.
export const ENV_PASSTHROUGH_VAR = "AGENT_ENV_PASSTHROUGH";
export const ENV_ALLOW = [
  // process basics; HOME is where a harness with "home": "user" keeps its settings and login
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "TZ", "LANG",
  // the Node runtime of the Node-based harnesses
  "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA",
  // network for the harness and its tools
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO",
  // toolchain locations
  "JAVA_HOME", "GOPATH", "GOROOT", "GOBIN", "CARGO_HOME", "RUSTUP_HOME", "PYENV_ROOT", "VIRTUAL_ENV",
  "CONDA_PREFIX", "NVM_DIR", "VOLTA_HOME", "PNPM_HOME", "BUN_INSTALL", "DENO_DIR", "GEM_HOME", "GEM_PATH",
  "RBENV_ROOT", "ASDF_DIR", "ASDF_DATA_DIR", "HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY",
  "DEVELOPER_DIR", "ANDROID_HOME", "ANDROID_SDK_ROOT",
];
// XDG_* matters for OpenCode with "home": "user" (spec §3.10).
export const ENV_ALLOW_PREFIXES = ["LC_", "XDG_"];
export const ENV_DENY = [/_(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS)$/i, /^(AWS|GITHUB|GH|ANTHROPIC|OPENAI|CLAUDE)_/i];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// --------------------------------------------------------------------------------------------------------------

const CLOSE_WAIT_MS = 5_000;
const STARTUP_GRACE_MS = 60_000;
const POLL_MS = 100;
const STOP_POLL_MS = 250; // how often a runner checks its record for a terminal claim (cancel)
const SWEEP_ROUNDS = 10;
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout fires at once above this
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_GRACE_MS = 1_000; // SIGTERM → SIGKILL for an auxiliary command (boundedExec)
const EXEC_MARGIN_MS = 5_000; // the supervisor's own backstop beyond the command's deadline and grace
const SETTLE_MS = 2_000; // how long a runner at its end waits for SIGKILLed groups to be reaped before it calls them survivors
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const PS_TIMEOUT_MS = 5_000; // ps and sysctl: killed (SIGKILL) and read as "unreadable" beyond this
// stdout held in memory for reduce(): the head and the tail of the stream (the log keeps all of it), so a long event
// stream never grows one string toward V8's limit of about 2^29 characters.
const STDOUT_HEAD_CHARS = 1 << 20;
const STDOUT_TAIL_CHARS = 32 << 20;
const META_MAX_CHARS = 16_384;
// Fields the runner sets while its job runs; a terminal claim that raced one of them carries it over (finalizeRecord).
const RUNTIME_FIELDS = ["runnerPid", "runnerStartedAt", "childPid", "childStartedAt", "harnessVersion", "meta"];
export const PROBE_PROMPT = "Reply with exactly: PONG\n";
const PROBE_TIMEOUT_MS = 120_000;
// The signals that end a probe early (runProbe): a Ctrl-C, a kill, a closed terminal.
const PROBE_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const REBOOT_NOTE = "system rebooted since the job started";
const UNKNOWN_BOOT_NOTE = "not signalled: the boot it was started in cannot be confirmed (the boot id was unreadable)";
// <prefix>-NNNN; zt- belongs to zcode-dispatch, task- to the Codex companion.
const ID_RE = /^([a-z]{2})-(\d{4,})$/;
const RECORD_NAME_RE = /^([a-z]{2})-(\d{4,})\.json$/;
const FOREIGN_PREFIXES = new Set(["zt"]);

export class UsageError extends Error {}

export const exitCodeOf = (error) => (error instanceof UsageError ? 2 : 1);
export const startLine = (profileName, id) => `${CLI_NAME}: ${profileName} task started in the background as ${id}`;
export const isCoreJobId = (id) => typeof id === "string" && ID_RE.test(id) && !FOREIGN_PREFIXES.has(id.slice(0, 2));

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const defaultOut = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };

// ---------- paths and workspaces ----------

// The data root (spec §3.4): config.json, keys/, homes/, agents-empty/, cache/ and state/<ws>/jobs/. Always
// absolute: the runner gets the jobs dir as an argument and runs in the workspace root, not in the caller's cwd.
export function stateRoot(env = process.env) {
  return path.resolve(env[STATE_DIR_VAR] || path.join(os.homedir(), ".claude", "plugins", "data", "superpowers-strigov-ver-agents"));
}

export function dataPaths(env = process.env) {
  const root = stateRoot(env);
  return {
    root,
    config: path.join(root, "config.json"),
    keys: path.join(root, "keys"),
    homes: path.join(root, "homes"),
    agentsEmpty: path.join(root, "agents-empty"),
    cache: path.join(root, "cache"),
    state: path.join(root, "state"),
  };
}

export function resolveWorkspace(cwd, env = process.env) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const root = r.stdout.trim();
  if (!root) return null;
  const slug = `${path.basename(root)}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`;
  return { root, jobsDir: path.join(stateRoot(env), "state", slug, "jobs") };
}

export function requireWorkspace(cwdOption, env = process.env) {
  const cwd = path.resolve(cwdOption ?? process.cwd());
  const ws = resolveWorkspace(cwd, env);
  if (!ws) throw new UsageError(`not inside a git work tree: ${cwd}`);
  return ws;
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

let tmpSeq = 0;
const tmpFile = (file) => `${file}.tmp-${process.pid}-${++tmpSeq}`;

// Atomic write with a fixed mode (umask cannot widen it); the parent directory is made private. A failed write
// removes its temp copy, which may hold a secret.
export function writePrivateFile(file, content, mode = 0o600) {
  ensurePrivateDir(path.dirname(file));
  const tmp = tmpFile(file);
  try {
    fs.writeFileSync(tmp, content, { mode, flag: "wx" });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------- environment ----------

// Variable names listed in AGENT_ENV_PASSTHROUGH ("A,B" or "A B"): explicit user opt-ins, passed even when ENV_DENY
// matches them.
export function passthroughNames(source = process.env) {
  const names = (source[ENV_PASSTHROUGH_VAR] ?? "").split(/[\s,]+/).filter(Boolean);
  const invalid = names.filter((name) => !ENV_NAME_RE.test(name));
  if (invalid.length > 0) throw new UsageError(`${ENV_PASSTHROUGH_VAR} holds invalid variable names: ${invalid.join(" ")}`);
  return [...new Set(names)];
}

export const isDenied = (name) => ENV_DENY.some((pattern) => pattern.test(name));

// The caller's variables a harness may see. `inherit` re-admits names despite ENV_DENY: an adapter's native home
// variable (CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR, DSH_HOME) for "home": "user", when it is set.
export function filterEnv(source = process.env, { inherit = [] } = {}) {
  const passthrough = new Set(passthroughNames(source));
  const allow = new Set(ENV_ALLOW);
  const readmit = new Set(inherit);
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const prefixed = ENV_ALLOW_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (passthrough.has(name) || allow.has(name) || readmit.has(name) || (prefixed && !isDenied(name))) env[name] = value;
  }
  return env;
}

function applyLayer(env, layer, label) {
  for (const [name, value] of Object.entries(layer ?? {})) {
    if (!ENV_NAME_RE.test(name)) throw new UsageError(`${label}: invalid variable name ${JSON.stringify(name)}`);
    if (value === null || value === undefined) delete env[name];
    else env[name] = String(value);
  }
}

// The harness environment, later layers winning (spec §3.2): the filtered caller env → the adapter's defaults
// (§3.6 Б) → profile.env → the mandatory settings (§3.6 А) → the key under each secretEnv name. A null value
// removes the name. Throws when secretEnv names a variable but no key was handed over: a keyed profile never runs
// without its key (its harness could fall back to another login, spec §3.5).
export function buildEnv({ source = process.env, inherit = [], defaults = {}, profileEnv = {}, mandatory = {}, secretEnv = [], secret = null } = {}) {
  const env = filterEnv(source, { inherit });
  applyLayer(env, defaults, "adapter env");
  applyLayer(env, profileEnv, "profile env");
  applyLayer(env, mandatory, "mandatory env");
  if (secretEnv.length > 0) {
    if (typeof secret !== "string" || secret === "") throw new Error(`no key was handed over for ${secretEnv.join(", ")}`);
    for (const name of secretEnv) {
      if (!ENV_NAME_RE.test(name)) throw new UsageError(`secretEnv: invalid variable name ${JSON.stringify(name)}`);
      env[name] = secret;
    }
  }
  return env;
}

// profile.env names that a mandatory setting or the key owns (spec §3.4 `env`: doctor FAIL, task exit 2). `owned` is
// a plan or mandatorySettings(): { mandatory: { name: value | null }, secretEnv: [names] }. A value identical to the
// mandatory one changes nothing and passes (a copied provider recipe may list ANTHROPIC_API_KEY=""); a key variable
// never does.
export function envConflicts(profileEnv, { mandatory = {}, secretEnv = [] } = {}) {
  const keyNames = new Set(secretEnv);
  const same = (a, b) => ((a ?? null) === null ? (b ?? null) === null : (b ?? null) !== null && String(a) === String(b));
  return Object.entries(profileEnv ?? {})
    .filter(([name, value]) => keyNames.has(name) || (Object.hasOwn(mandatory, name) && !same(value, mandatory[name])))
    .map(([name]) => name)
    .sort();
}

// Names only, never values: what the job log records about the harness environment.
export function describeEnv(env, source = process.env, secretEnv = []) {
  const passthrough = passthroughNames(source).filter((name) => name in env);
  const secretLike = passthrough.filter(isDenied);
  return [
    `env names: ${Object.keys(env).sort().join(" ")}`,
    ...(passthrough.length > 0 ? [`via ${ENV_PASSTHROUGH_VAR}: ${passthrough.join(" ")}`] : []),
    ...(secretLike.length > 0 ? [`secret-like by name, passed on request: ${secretLike.join(" ")}`] : []),
    ...(secretEnv.length > 0 ? [`key in: ${secretEnv.join(" ")}`] : []),
  ].join("; ");
}

// ---------- redaction ----------

// Replaces every registered value (the resolved key, …) by REDACTED, longest first. Each value is registered raw
// and in its JSON-escaped form, so a key inside a JSON event is caught too. redact.add(value) registers more;
// redact.maxLength() bounds how much of a long line runCli must hold back.
export function redactor(values = []) {
  const secrets = new Set();
  const add = (value) => {
    if (typeof value !== "string" || value === "") return;
    secrets.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) secrets.add(escaped);
  };
  for (const value of values) add(value);
  const redact = (text) => {
    if (text === null || text === undefined) return text;
    let out = String(text);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join(REDACTED);
    return out;
  };
  redact.add = add;
  redact.maxLength = () => Math.max(0, ...[...secrets].map((secret) => secret.length));
  return redact;
}

// An Error whose message passed through `redact` (the foreground knows the key; its errors must not print it).
function redactError(error, redact) {
  const message = redact(error?.message ?? String(error));
  if (message === error?.message) return error;
  const copy = error instanceof UsageError ? new UsageError(message) : new Error(message);
  if (error?.errorClass) copy.errorClass = error.errorClass;
  return copy;
}

// ---------- the key handoff (spec §3.5) ----------
// task resolves the key in the foreground and sends a length-prefixed UTF-8 value over the runner's private fd 3.
// The descriptor is closed before discovery and never inherited by a harness. A bounded reader rejects missing,
// truncated or oversized handoffs; a keyed job never falls back to a file or another credential source.
const SECRET_HANDOFF_FD = 3;
const MAX_SECRET_HANDOFF_BYTES = 64 * 1024;
const SECRET_HANDOFF_TIMEOUT_MS = 10_000;

export const jobDir = (jobsDir, id) => path.join(jobsDir, id);

// Only for cleanup of jobs created by older versions. New jobs never create this file.
export function dropSecret(jobsDir, id) {
  try {
    fs.rmSync(path.join(jobDir(jobsDir, id), "secret"), { force: true });
  } catch {
    // best effort; a later terminal transition retries
  }
}

function handoffPayload(secret) {
  const size = Buffer.byteLength(secret);
  if (size > MAX_SECRET_HANDOFF_BYTES) throw new UsageError("resolved key exceeds the private handoff limit (65536 bytes) errorClass=auth");
  const payload = Buffer.allocUnsafe(size + 4);
  payload.writeUInt32BE(size, 0);
  payload.write(secret, 4, "utf8");
  return payload;
}

function sendSecret(pipe, payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pipe.destroy();
      payload.fill(0);
      if (error) reject(new Error("private key handoff failed; the harness was not started"));
      else resolve();
    };
    const timer = setTimeout(() => done(new Error("timeout")), SECRET_HANDOFF_TIMEOUT_MS);
    // Keep the listener for late EPIPE after finish; no OS diagnostic can carry the key.
    pipe.on("error", done);
    pipe.end(payload, () => done());
  });
}

function openSecretPipe() {
  try {
    // Node's extra stdio pipes are sockets on the supported POSIX hosts. Never read a regular file that happens
    // to occupy fd 3 when somebody invokes the internal runner by hand.
    if (!fs.fstatSync(SECRET_HANDOFF_FD).isSocket()) return null;
    return new Socket({ fd: SECRET_HANDOFF_FD, readable: true, writable: false });
  } catch {
    return null;
  }
}

function receiveSecret(pipe, shouldStop) {
  if (!pipe) return Promise.reject(new Error("private key handoff is missing; the harness was not started"));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      pipe.destroy();
      for (const chunk of chunks) chunk.fill(0);
      if (error) reject(error);
      else resolve(value);
    };
    const invalid = () => done(new Error("private key handoff is missing, incomplete or invalid; the harness was not started"));
    const timer = setTimeout(invalid, SECRET_HANDOFF_TIMEOUT_MS);
    const poller = setInterval(() => { if (shouldStop()) invalid(); }, STOP_POLL_MS);
    pipe.on("error", invalid);
    pipe.on("close", () => { if (!settled) invalid(); });
    pipe.on("data", (chunk) => {
      size += chunk.length;
      chunks.push(chunk);
      if (size > MAX_SECRET_HANDOFF_BYTES + 4) invalid();
    });
    pipe.on("end", () => {
      const payload = Buffer.concat(chunks);
      try {
        const count = payload.length >= 4 ? payload.readUInt32BE(0) : 0;
        if (count === 0 || count > MAX_SECRET_HANDOFF_BYTES || count !== payload.length - 4) return invalid();
        const secret = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(4));
        if (secret.trim() !== secret || /\s/.test(secret)) return invalid();
        return done(null, secret);
      } catch {
        return invalid();
      } finally {
        payload.fill(0);
      }
    });
  });
}

// ---------- key input (for `key set`) ----------

// Reads one secret line: from a pipe until EOF, or from a terminal with echo off. Never echoes it.
export async function readSecretLine(promptText) {
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
        if (ch === "\u0003" || ch === "\u0004") return done(new UsageError("key set cancelled; nothing stored"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
      return undefined;
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

// spec §3.5: a key is one non-empty line without whitespace; the provider's format is never checked. Returns the
// key or throws with the shape of the input only, never its content.
export function checkKeyText(text) {
  const key = String(text ?? "").trim();
  if (!key) throw new UsageError("no key on stdin; nothing stored");
  if (/\s/.test(key)) {
    const lines = key.split(/\r?\n/).length;
    const spaces = (key.match(/\s/g) ?? []).length;
    throw new UsageError(
      `stdin is not one key: got ${key.length} characters on ${lines} line(s) with ${spaces} whitespace character(s); nothing stored. If the clipboard held a command rather than the key, run "${CLI_NAME} key set <name>" without a pipe and paste the key at the hidden prompt`,
    );
  }
  return key;
}

// ---------- job records ----------

const jobFile = (jobsDir, id) => path.join(jobsDir, `${id}.json`);
const logFile = (jobsDir, id) => path.join(jobsDir, `${id}.log`);
export const jobPaths = (jobsDir, id) => ({ record: jobFile(jobsDir, id), log: logFile(jobsDir, id), dir: jobDir(jobsDir, id) });
const formatId = (prefix, n) => `${prefix}-${String(n).padStart(4, "0")}`;
const idNumber = (id) => Number(ID_RE.exec(id)?.[2] ?? 0);

// The terminal record is claimed once, in a sibling file created atomically and exclusively (link(2) fails with
// EEXIST when it already exists): the first finalizer wins, and every reader prefers that file over the main record,
// so a writer holding a stale `running` copy can never undo a terminal status.
const terminalFile = (file) => `${file}.terminal`;

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

// Terminal statuses are sticky: a completed / failed / cancelled record is never rewritten by anyone but its claimer,
// also when two finalizers (cancel and the runner) race — exactly one claim succeeds. The claim and later calls also
// remove any legacy key handoff file from a job created by an older runtime.
export function finalizeRecord(file, patch) {
  const current = readRecord(file);
  if (!current || TERMINAL.has(current.status)) {
    if (typeof current?.id === "string") dropSecret(path.dirname(file), current.id);
    return current;
  }
  let next = { ...current, ...patch, finishedAt: new Date().toISOString() };
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
  // The runner may have recorded its harness between our read and the claim (its updateRunning saw no claim yet).
  // The claim is ours, so it is rewritten with those fields: the terminal record still names the process group.
  const main = readJson(file);
  const late = RUNTIME_FIELDS.filter((key) => next[key] == null && main?.[key] != null && !(key in patch));
  if (late.length > 0) {
    next = { ...next, ...Object.fromEntries(late.map((key) => [key, main[key]])) };
    writeRecord(terminalFile(file), next);
  }
  writeRecord(file, next); // mirror into the main record (readers already see the claim)
  if (typeof current.id === "string") dropSecret(path.dirname(file), current.id);
  return next;
}

// Returns null when the job is (or meanwhile became) terminal, or when `when(current)` rejects the record: a terminal
// claim that landed after our read wins even if our stale rename replaced the main record.
export function updateRunning(file, patch, when = null) {
  const current = readRecord(file);
  if (!current || current.status !== "running" || (when && !when(current))) return null;
  const next = { ...current, ...patch };
  writeRecord(file, next);
  return fs.existsSync(terminalFile(file)) ? null : next;
}

const isTerminalNow = (file) => fs.existsSync(terminalFile(file)) || TERMINAL.has(readRecord(file)?.status);

// ---------- the job's ownership log and the cleanup marker ----------
// <record>.runner is the job's ownership log: JSON lines, only ever appended to. Its first line is the claim
// { pid, startedAt, bootId, claimedAt } of the one runner a job ever gets, created atomically and exclusively
// (link(2)), so a second `__run`, now or later, can never claim the job again. The runner appends its own updates —
// { pid, childPid, childStartedAt } once its harness is spawned, { pid, startedAt } should its start time have been
// unreadable at the claim — and anyone appends { groups: [{ pgid, startedAt }] } for another process group the job
// may own, before that group could outlive what links it to the job: an auxiliary command's supervisor for its own
// group, before it starts the command (boundedExec); the runner, cancel and the reaper for each group a snapshot of
// the tree finds, before they signal it (a descendant that survives the signal loses its ppid link once its parent
// dies). A group is named by its leader (pid = pgid) and the leader's start time — null only when the leader lived
// but its start time could not be read — and counts as the job's only while that leader lives (survivingGroups): a
// group whose leader is gone has nothing left to confirm it by, since its id may name a stranger's group by then, so
// one found leaderless is not recorded at all. The log outlives a terminal claim that froze the record, which is what
// lets cancel and the reaper find, by verified identity, what the record never got to name. <record>.cleaned marks
// that nothing the log names may still be the job's (written by the runner when it ends, or by cancel / the reaper /
// release-stale once they verified it); a terminal job without it may still own a live process.
const runnerFile = (file) => `${file}.runner`;
const cleanedFile = (file) => `${file}.cleaned`;

function claimRunnerFile(file, claim) {
  const tmp = tmpFile(runnerFile(file));
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(claim)}\n`, { flag: "wx", mode: 0o600 });
    fs.linkSync(tmp, runnerFile(file));
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// One line appended to the ownership log of an existing claim; the log is never created here. Returns whether it
// was written.
function appendOwnership(file, entry) {
  let fd = null;
  try {
    fd = fs.openSync(runnerFile(file), fs.constants.O_WRONLY | fs.constants.O_APPEND);
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// A recorded group's key: its id and its leader's start time (an id comes back for another group once one is gone).
const groupKey = (pgid, startedAt) => `${pgid} ${startedAt ?? ""}`;

// The ownership log read back: the claim with its claimer's later lines merged in, plus `groups` — every recorded
// group as { pgid, startedAt }, once per key. Null without a claim. A line a crash cut short is skipped.
function readOwnership(file) {
  let text;
  try {
    text = fs.readFileSync(runnerFile(file), "utf8");
  } catch {
    return null;
  }
  let claim = null;
  const groups = new Map();
  for (const line of text.split("\n")) {
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry)) continue;
    if (claim === null) claim = entry;
    else if (Array.isArray(entry.groups)) {
      for (const group of entry.groups) {
        if (!Number.isInteger(group?.pgid) || group.pgid <= 1) continue;
        const startedAt = typeof group.startedAt === "string" && group.startedAt ? group.startedAt : null;
        groups.set(groupKey(group.pgid, startedAt), { pgid: group.pgid, startedAt });
      }
    } else if (entry.pid === claim.pid) claim = { ...claim, ...entry };
  }
  return claim && { ...claim, groups: [...groups.values()] };
}

// The claimer's own lines. A start time of its own that could not be read at the claim is added once it can, so the
// runner does not stay `unknown` for its whole life.
function updateRunnerFile(file, patch) {
  const current = readOwnership(file);
  if (current?.pid !== process.pid) return;
  appendOwnership(file, { pid: process.pid, ...(current.startedAt ? {} : { startedAt: ownStart() }), ...patch });
}

// Records process groups the job may own in the ownership log of the job record `file`, before the caller signals
// them or lets them outlive their parent: each by its leader's start time, unless the log already has that pair (the
// harness's included). A group without a live leader is skipped: nothing could confirm later that it is still the
// job's. Returns false when something could not be written (no claim, a failed write).
export function recordGroups(file, pgids, by) {
  const log = readOwnership(file);
  if (!log) return false;
  const known = new Set([groupKey(log.childPid, log.childStartedAt), ...log.groups.map((group) => groupKey(group.pgid, group.startedAt))]);
  const fresh = [];
  for (const pgid of new Set(pgids)) {
    if (!Number.isInteger(pgid) || pgid <= 1) continue;
    const startedAt = processStart(pgid);
    if (startedAt === null && !isAlive(pgid)) continue; // leaderless
    if (known.has(groupKey(pgid, startedAt))) continue;
    known.add(groupKey(pgid, startedAt));
    fresh.push({ pgid, startedAt });
  }
  return fresh.length === 0 || appendOwnership(file, { groups: fresh, by, at: new Date().toISOString() });
}

function markCleaned(file) {
  try {
    fs.writeFileSync(cleanedFile(file), `${new Date().toISOString()}\n`);
  } catch {
    // best effort: the next cancel or reaper pass verifies again
  }
}

// A terminal job whose process tree is not known to be stopped: it had (or may have had) a runner and no
// <record>.cleaned yet.
export function cleanupPending(jobsDir, record) {
  if (!record || !TERMINAL.has(record.status) || typeof record.id !== "string") return false;
  const file = jobFile(jobsDir, record.id);
  if (fs.existsSync(cleanedFile(file))) return false;
  return fs.existsSync(runnerFile(file)) || Number.isInteger(record.runnerPid) || Number.isInteger(record.childPid);
}

// The processes of a job with the start times recorded next to them: the runner and the harness from the ownership
// log when there is one (it outlives a terminal claim), else from the record — each pid paired with the start time
// of the same source — and the other groups the log records.
function jobProcesses(jobsDir, record) {
  const claim = readOwnership(jobFile(jobsDir, record.id));
  const pair = (pid, startedAt) => ({ pid: Number.isInteger(pid) && pid > 0 ? pid : null, startedAt: typeof startedAt === "string" ? startedAt : null });
  const runner = Number.isInteger(claim?.pid) ? pair(claim.pid, claim.startedAt) : pair(record.runnerPid, record.runnerStartedAt);
  const child = Number.isInteger(claim?.childPid) ? pair(claim.childPid, claim.childStartedAt) : pair(record.childPid, record.childStartedAt);
  return { runner, child, groups: claim?.groups ?? [] };
}

// The process groups the job may still own that are ours or unknown now, as { pgid, startedAt, state, harness }: the
// harness group by harnessGroupState(), every group of the ownership log by its leader's identity alone
// (processIdentity). Empty once nothing of the job is left.
function survivingGroups(jobsDir, record) {
  const { child, groups } = jobProcesses(jobsDir, record);
  const all = [
    ...(child.pid ? [{ pgid: child.pid, startedAt: child.startedAt, harness: true, state: harnessGroupState(child.pid, child.startedAt) }] : []),
    ...groups.map((group) => ({ ...group, state: processIdentity(group.pgid, group.startedAt) })),
  ];
  return all.filter((group) => possiblyOurs(group.state));
}

export function listRecords(jobsDir) {
  let names = [];
  try {
    names = fs.readdirSync(jobsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => RECORD_NAME_RE.test(name) && !FOREIGN_PREFIXES.has(name.slice(0, 2)))
    .map((name) => readRecord(path.join(jobsDir, name)))
    .filter((record) => record && typeof record.id === "string")
    .sort((a, b) => idNumber(b.id) - idNumber(a.id) || (a.id < b.id ? 1 : -1));
}

// Atomic id allocation: one number sequence per workspace, shared by every core prefix (ct-, oc-, pi-, dt-), and
// the record created exclusively ("wx"), so parallel read-only tasks never share an id. The record starts as
// `running` without a runner; startJob removes it again on a refusal (the id was never announced). A number stays
// taken while anything of its job is left — the record, its .terminal / .runner / .cleaned side files, the log, the
// job dir — not only the record: a record removed alone (by hand, or by a prune) must not hand its stale runner claim
// or cleanup marker to a new job under the same id.
const TRACE_NAME_RE = /^([a-z]{2})-(\d{4,})(?=$|\.)/;
export function allocateJob(jobsDir, prefix, fields) {
  if (!/^[a-z]{2}$/.test(prefix ?? "") || FOREIGN_PREFIXES.has(prefix)) throw new Error(`invalid job id prefix: ${prefix}`);
  fs.mkdirSync(jobsDir, { recursive: true });
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const used = fs
      .readdirSync(jobsDir)
      .map((name) => TRACE_NAME_RE.exec(name))
      .filter((match) => match && !FOREIGN_PREFIXES.has(match[1]))
      .map((match) => Number(match[2]));
    const id = formatId(prefix, 1 + Math.max(0, ...used));
    try {
      fs.writeFileSync(jobFile(jobsDir, id), `${JSON.stringify({ id, ...fields }, null, 2)}\n`, { flag: "wx" });
      return id;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`cannot allocate a job id in ${jobsDir}`);
}

// Removes every trace of a job that was refused before it was announced. The record goes last: its id stays taken
// (allocateJob) until nothing of the job is left that a new job under the same id could lose.
function discardJob(jobsDir, id) {
  fs.rmSync(logFile(jobsDir, id), { force: true });
  fs.rmSync(jobDir(jobsDir, id), { recursive: true, force: true });
  for (const side of [terminalFile, runnerFile, cleanedFile]) fs.rmSync(side(jobFile(jobsDir, id)), { force: true });
  fs.rmSync(jobFile(jobsDir, id), { force: true });
}

export function requireJob(jobsDir, ref) {
  if (!isCoreJobId(ref)) throw new UsageError(`${ref} is not an ${CLI_NAME} core job id (ct-, oc-, pi-, dt- + NNNN); zt- ids belong to zcode-dispatch, task- ids to codex-dispatch`);
  const record = readRecord(jobFile(jobsDir, ref));
  if (!record) throw new UsageError(`unknown job ${ref} in this workspace (pass the same --cwd as the original task)`);
  return record;
}

export function appendLog(file, line) {
  if (!file) return;
  try {
    fs.appendFileSync(file, `[${CLI_NAME}] ${new Date().toISOString()} ${line}\n`);
  } catch {
    // the log is best effort
  }
}

export function tailLines(file, n) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-n).map((line) => `${line}\n`).join("");
  } catch {
    return "";
  }
}

// ---------- processes ----------

const signalable = (target) => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// Zombies: a process that ended but was not reaped yet stays in the process table and in its group, and kill(…, 0)
// finds it. On Linux that can last for good: under a pid 1 that never reaps (a container whose pid 1 is node, npx or
// `sleep infinity`) every process the cleanup SIGKILLed would stay "alive". A zombie has ended: on Linux isAlive() and
// groupAlive() do not count it. The state in /proc/<pid>/stat is its leader thread's, though: a process whose main
// thread ended (pthread_exit) while other threads run reads Z as well ("Zl" in ps) and lives on. So a process has
// ended when its state is Z or X and its thread count (field 20 of the same stat line) is down to that leader: 1, or 0
// once it is being released (hasEnded). A group of threads down to a zombie leader never grows again: only a live
// thread starts one. macOS needs no check: launchd reaps every orphan at once, and every other parent in a job's tree
// is the job's own (stopped by the same cleanup) or a runner or supervisor, which reap — a zombie there is gone within
// the waits that follow a signal.
const ZOMBIE_STATES = new Set(["Z", "X"]);
const threadCount = (fields) => (/^\d+$/.test(fields?.[20 - 3] ?? "") ? Number(fields[20 - 3]) : null);
const hasEnded = (state, threads) => ZOMBIE_STATES.has(state) && Number.isInteger(threads) && threads <= 1;
const isZombie = (pid) => {
  if (process.platform !== "linux") return false;
  const fields = procStatFields(pid);
  return hasEnded(fields?.[0], threadCount(fields));
};

// One pass over /proc: every listed process as { pid, state, pgid, sid, threads, gone }, or null when /proc cannot be
// listed — fields 3, 5, 6 and 20 of its stat line (state, process group, session, thread count). state and pgid are
// null when its stat could not be read; `gone` then says why: true when the pid no longer exists (the process ended
// and was reaped after the listing — routine wherever processes come and go), false when something still holds it
// that /proc does not show (another user's process under hidepid, a pid reused at once).
function procScan() {
  let names;
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  const scan = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const fields = procStatFields(pid); // [state, ppid, pgrp, session, …]
    const pgid = Number(fields?.[2]);
    const sid = Number(fields?.[3]);
    if (typeof fields?.[0] === "string" && fields[0] !== "" && Number.isInteger(pgid)) {
      scan.push({ pid, state: fields[0], pgid, sid: Number.isInteger(sid) ? sid : null, threads: threadCount(fields), gone: false });
    } else scan.push({ pid, state: null, pgid: null, sid: null, threads: null, gone: !signalable(pid) });
  }
  return scan;
}

const readable = (entry) => typeof entry?.state === "string" && Number.isInteger(entry.pgid);
// A scan entry that has ended for good (hasEnded): a zombie whose other threads are gone too.
const ended = (entry) => hasEnded(entry.state, entry.threads);

// The members of the `wanted` groups in one scan (procScan's shape) as Map pgid → Map pid → whether it has ended
// (ended), or null when the scan cannot tell. A process whose stat could not be read may be a member of any group.
// One that is gone is skipped in a first scan (`first` null): whatever it forked after the listing is listed by the
// confirming scan. In a confirming scan it is skipped only when the first scan read that pid (then another group's
// process, or a zombie member reaped since, which changes the membership anyway); a new one may have been a member
// that forked after its listing, so the scan cannot tell. One that is still there leaves any scan unable to tell.
function scanMembers(scan, wanted, first = null) {
  if (!Array.isArray(scan)) return null;
  const known = first === null ? null : new Set(first.filter(readable).map((entry) => entry.pid));
  const members = new Map();
  for (const entry of scan) {
    if (!readable(entry)) {
      if (entry?.gone === true && (known === null || known.has(entry.pid))) continue;
      return null;
    }
    if (!wanted.has(entry.pgid)) continue;
    if (!members.has(entry.pgid)) members.set(entry.pgid, new Map());
    members.get(entry.pgid).set(entry.pid, ended(entry));
  }
  return members;
}

const allEnded = (members) => [...members.values()].every(Boolean);

// Of `pgids`, the groups one scan shows with members that have all ended (zombies down to their leader thread):
// candidates only (zombieOnlyGroups).
export function zombieCandidates(pgids, scan) {
  const members = scanMembers(scan, new Set(pgids));
  return new Set(members ? [...members].filter(([, group]) => allEnded(group)).map(([pgid]) => pgid) : []);
}

// Of `pgids`, the groups that two /proc scans, taken one after the other, show as zombie-only; null when the second
// scan cannot tell (scanMembers: take another). A scan lists the pids first and reads their stats after, so one scan
// can miss a member: one that a listed member forked after the listing and then ended, all before its stat was read,
// shows every listed member a zombie while the new one lives. A candidate of the first scan (zombieCandidates)
// therefore counts only when the second lists exactly the same members, every one still ended: a new member forked
// before the second listing shows there. Pure: the scans are procScan's results.
export function zombieOnlyGroups(pgids, first, second) {
  const candidates = zombieCandidates(pgids, first);
  if (candidates.size === 0) return new Set();
  const before = scanMembers(first, candidates);
  const after = scanMembers(second, candidates, first);
  if (!after) return null;
  return new Set(
    [...candidates].filter((pgid) => {
      const was = before.get(pgid);
      const now = after.get(pgid);
      return now !== undefined && now.size === was.size && [...now.keys()].every((pid) => was.has(pid)) && allEnded(now);
    }),
  );
}

// Of `pgids`, the groups that are zombie-only, from the scans `scan()` takes: a second scan only when the first finds a
// candidate, and up to CONFIRM_SCANS of them while they cannot tell; none that can confirms nothing (uncertainty keeps
// a group alive).
const CONFIRM_SCANS = 3;
export function zombieGroupsFrom(pgids, scan) {
  if (pgids.length === 0) return new Set();
  const first = scan();
  if (zombieCandidates(pgids, first).size === 0) return new Set();
  for (let attempt = 0; attempt < CONFIRM_SCANS; attempt += 1) {
    const confirmed = zombieOnlyGroups(pgids, first, scan());
    if (confirmed) return confirmed;
  }
  return new Set();
}

// Linux: the ids of `pgids` whose members are all zombies, as /proc shows them (zombieGroupsFrom).
function zombieGroups(pgids) {
  return process.platform === "linux" ? zombieGroupsFrom(pgids, procScan) : new Set();
}

export function isAlive(pid) {
  return Number.isInteger(pid) && pid > 0 && signalable(pid) && !isZombie(pid);
}

// The ids of `pgids` whose group still has a member that has not ended. pid 1 is never a harness process group, and
// kill(-1) would signal every process of the user.
function liveGroups(pgids) {
  const found = pgids.filter((pgid) => Number.isInteger(pgid) && pgid > 1 && signalable(-pgid));
  const zombies = zombieGroups(found);
  return found.filter((pgid) => !zombies.has(pgid));
}

export function groupAlive(pgid) {
  return liveGroups([pgid]).length > 0;
}

export function killGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    // group already gone
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One snapshot of every process: [{ pid, ppid, pgid }], or null when ps cannot run. `ps -A -o pid=,ppid=,pgid=` works
// on macOS (no /proc there) and Linux (spec §3.10).
export function processTable() {
  for (const ps of ["ps", "/bin/ps"]) {
    const r = spawnSync(ps, ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL" });
    if (r.error || r.status !== 0) continue;
    const rows = [];
    for (const line of r.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
    }
    return rows;
  }
  return null;
}

// The process groups of `roots` (group ids) and of all their descendants in one snapshot. Harnesses start their bash
// tools in groups of their own (OpenCode, pi, dsh), so the root group alone misses them. Seeds are the members of
// every known group (a group outlives its leader); descendants are found through ppid links, which hold only while
// the parents live — so a snapshot is taken before each signal of a ladder.
export function treeGroups(roots, table) {
  const groups = new Set(roots.filter((pgid) => Number.isInteger(pgid) && pgid > 1));
  if (!Array.isArray(table)) return groups;
  const children = new Map();
  for (const row of table) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const seen = new Set();
  for (let size = -1; size !== groups.size;) {
    size = groups.size;
    const queue = table.filter((row) => groups.has(row.pgid) || groups.has(row.pid)).map((row) => row.pid);
    while (queue.length > 0) {
      const pid = queue.pop();
      if (seen.has(pid) || pid <= 1) continue;
      seen.add(pid);
      for (const child of children.get(pid) ?? []) {
        if (child.pgid > 1) groups.add(child.pgid);
        queue.push(child.pid);
      }
    }
  }
  return groups;
}

const ownPgid = (table) => table?.find((row) => row.pid === process.pid)?.pgid ?? null;
const rootList = (roots) => (Array.isArray(roots) ? roots : [roots]).filter((pgid) => Number.isInteger(pgid) && pgid > 1);

// The start time of a process: an identity that stays the same for the whole life of the process, whoever reads it.
//   Linux: `ticks:<n>`, field 22 of /proc/<pid>/stat — the start in clock ticks since boot (10 ms), fixed when the
//     process is created. Not `ps -o lstart`: procps recomputes lstart on every call as /proc/stat btime + those
//     ticks, and btime moves with every step of the wall clock (NTP, a VM or WSL resync after sleep, `date -s`), after
//     which every live process would read as another one.
//   elsewhere (macOS): `ps -o lstart=` in the C locale and in UTC, so that every caller — a runner, a later cancel
//     from another shell or time zone — reads the same text. macOS keeps the start as a wall-clock time stored at
//     fork, so a clock step does not change it. Its resolution is one second: a pid reused within the second it was
//     freed passes as the same process.
// `like` is a stored start time this one is to be compared with: it is read in that one's format (a value recorded
// on another platform, or by an older core, is never compared with text of another kind). Null when it cannot be read.
const TICKS_PREFIX = "ticks:";

export function processStart(pid, { like = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.env[TEST_PS_START_VAR] === "unavailable") return null;
  const stored = typeof like === "string" && like !== "";
  if (stored ? like.startsWith(TICKS_PREFIX) : process.platform === "linux") {
    const ticks = procStartTicks(pid);
    if (ticks !== null) return `${TICKS_PREFIX}${ticks}`;
    if (stored) return null; // a recorded tick count is compared with nothing else
    // A Linux without a readable /proc: lstart, the next best (such a value is compared as lstart from then on).
  }
  return psStart(pid);
}

// The fields of a /proc/<pid>/stat line from field 3 (the state) on, or null. The command name (field 2) is in
// parentheses and may itself hold spaces and parentheses, so the fields are counted after its last ")".
function statFields(text) {
  const close = String(text ?? "").lastIndexOf(")");
  return close < 0 ? null : String(text).slice(close + 1).trim().split(/\s+/);
}

function procStatFields(pid) {
  try {
    return statFields(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

// Field 22 (starttime) of a /proc/<pid>/stat line, or null.
export function parseProcStat(text) {
  const value = statFields(text)?.[22 - 3];
  return /^\d+$/.test(value ?? "") ? value : null;
}

function procStartTicks(pid) {
  const value = procStatFields(pid)?.[22 - 3];
  return /^\d+$/.test(value ?? "") ? value : null;
}

function psStart(pid) {
  for (const ps of ["ps", "/bin/ps"]) {
    const r = spawnSync(ps, ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
      timeout: PS_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (r.error) continue;
    const text = (r.stdout ?? "").trim().replace(/\s+/g, " ");
    return r.status === 0 && text ? text : null;
  }
  return null;
}

let ownStartCache = null;
// This process's own start time, as others will read it (processStart); null while it cannot be read (asked again
// on the next call).
export function ownStart() {
  if (ownStartCache === null) ownStartCache = processStart(process.pid);
  return ownStartCache;
}

// What a stored { pid, startedAt } names now. Every decision on a stored pid goes through this first:
//   ours    — the pid lives with the start time recorded for it;
//   foreign — the pid lives with another start time: the recorded process ended and the pid was reused;
//   unknown — the pid lives, but its start time cannot be read now or was never recorded: it may be ours, so it is
//             neither signalled nor treated as gone;
//   gone    — no process has the pid.
export function processIdentity(pid, startedAt) {
  if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return "gone";
  if (typeof startedAt !== "string" || startedAt === "") return "unknown";
  const now = processStart(pid, { like: startedAt });
  if (now === null) return isAlive(pid) ? "unknown" : "gone";
  return now === startedAt ? "ours" : "foreign";
}

// Why a pid that is "unknown" was not signalled: its start time is unreadable now, or none was recorded.
const unconfirmedNote = (startedAt) =>
  typeof startedAt === "string" && startedAt !== ""
    ? "not signalled: it is alive, but its start time cannot be read to confirm it is the job's"
    : "not signalled: it is alive, but no start time was recorded for it to confirm it is the job's";

// A stored pid that may still be the process it was recorded for.
const possiblyOurs = (state) => state === "ours" || state === "unknown";

// Whether the harness process group, recorded as { pgid, startedAt }, is still the job's, before anything signals it
// by that stored id (spec §3.6 А8: the tree widens zcode-dispatch's group-only kill, so a stale id must not reach a
// stranger). The groups of the ownership log are not judged by this: they count only by their leader
// (survivingGroups).
//   ours    — the leader lives with the start time recorded at spawn, or the leader has ended (reaped, or a zombie with
//             that start time) but the group still has members (POSIX reuses no process group id while its group
//             exists): what a harness leaves behind in its group is the cleanup's main work, and the runner sweeps it
//             the moment it reaps the harness;
//   foreign — the leader's pid is held by a process with another start time — a live one, or one that ended but was
//             never reaped (a zombie keeps its pid and its start time): the group ended and the pid, and with it the
//             group id, now belongs to another process; on Linux also a group whose leader is reaped and whose members
//             are in another session than the harness's own (inAnotherSession);
//   unknown — the leader's pid is held, but the holder's start time cannot be read (or none was recorded) while the
//             leader lives, or while a zombie holds it and the group has members: never signalled, and never
//             released as gone (release-stale, the reaper's cleanup);
//   gone    — neither the leader nor any member is left.
export function harnessGroupState(pgid, startedAt) {
  if (!Number.isInteger(pgid) || pgid <= 1) return "gone";
  const leader = processIdentity(pgid, startedAt);
  if (leader !== "gone") return leader;
  // processIdentity counts a zombie as gone (it has ended), but its start time still tells whose the pid is: a stranger
  // that reused the pid and ended while members of its group live must not make that group ours, nor may a zombie
  // whose start time cannot be compared.
  if (signalable(pgid)) {
    const now = typeof startedAt === "string" && startedAt !== "" ? processStart(pgid, { like: startedAt }) : null;
    if (now !== null && now !== startedAt) return "foreign";
    if (now === null) return groupAlive(pgid) ? "unknown" : "gone";
    return groupAlive(pgid) ? "ours" : "gone";
  }
  if (!groupAlive(pgid)) return "gone";
  return inAnotherSession(pgid) ? "foreign" : "ours";
}

// Linux: whether /proc shows the members of process group `pgid` in a session other than session `pgid`. A group lies
// in one session for its whole life, and the harness is spawned detached (setsid): it leads session `pgid`, so every
// member of its group is in that session too, also once the harness is gone. A group with its leader reaped and its
// members elsewhere was made by a process that took the pid later — a shell's pipeline (`a | b`, led by `a`, which
// ended first) is in the shell's session. None of the group's members may read as in session `pgid`: one that leaves
// the group by setsid can be read between its two changes (new session, old group). False when /proc cannot tell
// (no member readable, not Linux): the group then counts as the harness's, as before.
function inAnotherSession(pgid) {
  if (process.platform !== "linux") return false;
  const sessions = new Set(
    (procScan() ?? []).filter((entry) => readable(entry) && entry.pgid === pgid && Number.isInteger(entry.sid)).map((entry) => entry.sid),
  );
  return sessions.size > 0 && !sessions.has(pgid);
}

export function normalizeLadder(ladder) {
  if (!Array.isArray(ladder) || ladder.length === 0) return DEFAULT_LADDER.map((step) => [...step]);
  return ladder.map((step) => {
    const [signal, waitMs] = Array.isArray(step) ? step : [];
    if (typeof signal !== "string" || !(signal in os.constants.signals)) throw new Error(`invalid cancel ladder signal: ${JSON.stringify(signal)}`);
    if (typeof waitMs !== "number" || !Number.isFinite(waitMs) || waitMs < 0) throw new Error(`invalid cancel ladder wait for ${signal}: ${JSON.stringify(waitMs)}`);
    return [signal, waitMs];
  });
}

const ladderText = (ladder) => ladder.map(([signal, waitMs]) => (waitMs > 0 ? `${signal}, ${waitMs} ms` : signal)).join(" → ");

// Stops a harness and everything it started (spec §3.6 А8): for each [signal, waitMs] step of the adapter's ladder,
// a fresh snapshot adds the groups of new descendants, the signal goes to every live known group, and the step waits
// up to waitMs for all of them to end. After the ladder, groups still alive get SIGKILL again (the re-sweep), so a
// descendant forked during the last step does not survive. `roots` is one process group id or several. Never
// signals pid ≤ 1, its own group or `exclude`. `onGroups(pgids)` hears of every group a snapshot adds, before any
// signal reaches it (the runner, cancel and the reaper record them in the job's ownership log). Returns
// { groups, sent, survivors }.
export async function terminateTree(roots, ladder = DEFAULT_LADDER, { exclude = [], log = () => {}, onGroups = null } = {}) {
  const steps = normalizeLadder(ladder);
  const seeds = rootList(roots);
  const known = new Set();
  const skip = new Set(exclude.filter((pgid) => Number.isInteger(pgid)));
  const refresh = () => {
    const table = processTable();
    const own = ownPgid(table);
    if (own) skip.add(own);
    const found = [...treeGroups([...seeds, ...known], table)].filter((pgid) => pgid > 1 && !skip.has(pgid) && !known.has(pgid));
    for (const pgid of found) known.add(pgid);
    if (found.length > 0) tell(onGroups, found);
  };
  const alive = () => liveGroups([...known]);
  const sent = [];
  for (const [signal, waitMs] of steps) {
    refresh();
    const targets = alive();
    if (targets.length === 0) break;
    for (const pgid of targets) killGroup(pgid, signal);
    sent.push(`${signal} to groups ${targets.join(",")}`);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && alive().length > 0) await sleep(POLL_MS);
  }
  let survivors = alive();
  for (let round = 0; round < SWEEP_ROUNDS && (round === 0 || survivors.length > 0); round += 1) {
    refresh();
    survivors = alive();
    if (survivors.length === 0) break;
    for (const pgid of survivors) killGroup(pgid, "SIGKILL");
    sent.push(`SIGKILL (re-sweep) to groups ${survivors.join(",")}`);
    await sleep(POLL_MS);
    survivors = alive();
  }
  for (const line of sent) log(line);
  if (survivors.length > 0) log(`still alive after the re-sweep: groups ${survivors.join(",")}`);
  return { groups: [...known], sent, survivors };
}

// One snapshot, one signal to the whole tree, no waiting: the reaper's tool for a job whose runner died. The caller
// checks harnessGroupState() first. `onGroups` as for terminateTree.
export function killTreeSync(roots, signal = "SIGKILL", { exclude = [], onGroups = null } = {}) {
  const table = processTable();
  const skip = new Set([...exclude, ownPgid(table)].filter((pgid) => Number.isInteger(pgid)));
  const groups = [...treeGroups(rootList(roots), table)].filter((pgid) => pgid > 1 && !skip.has(pgid));
  if (groups.length > 0) tell(onGroups, groups);
  for (const pgid of groups) killGroup(pgid, signal);
  return groups;
}

// Hands the groups of a snapshot to an onGroups callback. Recording them is best effort: a failure never keeps a
// signal from going out.
function tell(onGroups, groups) {
  try {
    onGroups?.(groups);
  } catch {
    // the stop goes on
  }
}

// The process groups of everything a live process started, except its own group: a runner's harness and the
// auxiliary commands of boundedExec (each leads a group of its own below the runner's supervisor). Callers verify
// the pid's identity first (processIdentity) — the snapshot follows ppid links of whoever holds the pid now.
function descendantGroupsOf(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return [];
  const table = processTable() ?? [];
  const own = table.find((row) => row.pid === pid)?.pgid ?? pid;
  const children = new Map();
  for (const row of table) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const groups = new Set();
  const seen = new Set();
  const queue = [pid];
  while (queue.length > 0) {
    const next = queue.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    for (const child of children.get(next) ?? []) {
      if (child.pgid > 1 && child.pgid !== own) groups.add(child.pgid);
      queue.push(child.pid);
    }
  }
  return [...groups];
}

// ---------- boot identity: pids recorded in an earlier boot belong to nobody of ours ----------
// After a reboot the runnerPid / childPid / holderPid in the state files may name unrelated processes. Records and
// reservations store the boot id they were written in (kern.bootsessionuuid on macOS,
// /proc/sys/kernel/random/boot_id on Linux):
//   current — the stored id equals the readable current id: the usual pid checks and signals apply;
//   earlier — the stored id differs from the readable current id: dead without any pid check, never signalled;
//   unknown — no stored id, or the current id is unreadable now: the pid checks decide liveness, but nothing is
//             signalled by a stored pid (the reaper and cancel report instead).
// Tests only: AGENT_TEST_BOOT_ID (a boot id, or "unknown").
let currentBootId;

function readBootId() {
  if (process.platform === "darwin") {
    const r = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL" });
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

export function bootId() {
  if (currentBootId !== undefined) return currentBootId;
  const override = process.env[TEST_BOOT_ID_VAR];
  if (override === undefined || override === "") currentBootId = readBootId();
  else currentBootId = override === "unknown" ? null : override;
  return currentBootId;
}

// "current" | "earlier" | "unknown" for state stamped with boot id `storedId`.
export function bootOf(storedId) {
  const current = bootId();
  if (typeof storedId !== "string" || storedId === "" || current === null) return "unknown";
  return storedId === current ? "current" : "earlier";
}

// ---------- the workspace reservation: one write job per working tree (spec §3.9) ----------

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
  const holder = rebooted ? "gone" : processIdentity(record.holderPid, record.holderStartedAt);
  if (possiblyOurs(holder)) reservationGuard(record);
  const reason = rebooted
    ? "the system rebooted since it was taken"
    : `runner pid ${record.holderPid} is not alive${holder === "foreign" ? " (the pid now belongs to another process)" : ""}`;
  throw new UsageError(
    `workspace reservation generation ${generation} is stale (${reason}); run ${CLI_NAME} release-stale --cwd ${JSON.stringify(workspaceRoot)}`,
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

// Hands the reservation to the runner, with the runner's start time (its identity for every later liveness check).
// The task process is the only writer of its generation file, so a temp file renamed over it replaces it
// atomically, flushed before the rename.
function updateReservation(file, token, holderPid, holderStartedAt = null) {
  const current = readJson(file);
  if (current?.token !== token) return false;
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ ...current, holderPid, holderStartedAt })}\n`, { flag: "wx", mode: 0o600, flush: true });
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
    const reservation = { holderPid: process.pid, holderStartedAt: ownStart(), jobId, token: randomUUID(), generation, createdAt: new Date().toISOString(), bootId: bootId() };
    if (createReservation(file, reservation)) return { file, token: reservation.token };
    // Another task created this generation. Re-read the highest generation before deciding.
  }
}

// The runner waits (briefly) until the task process has handed the reservation over to it. A previous holder that
// is gone, or whose pid now belongs to another process, will never hand it over.
async function claimRunnerReservation(file, jobId, token) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = readJson(file);
    if (current?.token !== token || current.jobId !== jobId) return false;
    if (current.holderPid === process.pid) return true;
    if (!possiblyOurs(processIdentity(current.holderPid, current.holderStartedAt))) return false;
    await sleep(10);
  }
  return false;
}

const FOREIGN_NOTE = "not signalled: its leader pid now belongs to another process";

// Liveness check: no record is ever left `running` with a dead runner, and a terminal job whose runner died before
// its processes were stopped (cleanupPending) gets them stopped here. A runner counts as dead only when its pid is
// gone or provably reused (processIdentity: foreign); one that may still be ours (unknown) keeps its job. The reaper's
// tool is one SIGKILL to the trees of the job's groups (reapOwnedSync), and only to groups that are provably the
// job's. `except` names a job whose pending cleanup the caller resumes itself (cancel, with the adapter's ladder).
// Returns what it did: [{ id, action, groups? }].
export function reapDeadRunners(jobsDir, { except = null } = {}) {
  const done = [];
  for (const record of listRecords(jobsDir)) {
    const file = jobFile(jobsDir, record.id);
    const log = logFile(jobsDir, record.id);
    const boot = bootOf(record.bootId);
    if (record.status !== "running") {
      if (record.id !== except && cleanupPending(jobsDir, record)) {
        const resumed = resumeCleanupSync(jobsDir, record, boot, log);
        if (resumed) done.push({ id: record.id, ...resumed });
      }
      continue;
    }
    if (boot === "earlier") {
      // Its runnerPid / childPid may now be unrelated processes: finalize without any signal.
      const after = finalizeRecord(file, { status: "failed", errorClass: "crash", note: REBOOT_NOTE });
      if (after?.note === REBOOT_NOTE) appendLog(log, `${REBOOT_NOTE}; liveness check marked the job failed/crash, no process signalled`);
      markCleaned(file); // nothing of a job outlives a reboot
      done.push({ id: record.id, action: "rebooted" });
      continue;
    }
    const procs = jobProcesses(jobsDir, record);
    if (procs.runner.pid === null) {
      if (Date.now() - Date.parse(record.startedAt) > STARTUP_GRACE_MS) {
        finalizeRecord(file, { status: "failed", errorClass: "crash", note: "runner never started" });
        done.push({ id: record.id, action: "never-started" });
      }
      continue;
    }
    const runner = processIdentity(procs.runner.pid, procs.runner.startedAt);
    if (possiblyOurs(runner)) continue;
    // What outlives a dead runner (its harness tree, an auxiliary command, a descendant its ladder recorded) is
    // signalled only where it is provably still the job's; nothing is signalled while the boot is unconfirmed.
    const group = boot === "current" && procs.child.pid ? harnessGroupState(procs.child.pid, procs.child.startedAt) : null;
    const killed = boot === "current" ? reapOwnedSync(jobsDir, record) : [];
    const after = finalizeRecord(file, { status: "failed", errorClass: "crash", note: "runner died" });
    if (after?.note === "runner died") {
      const marked = `runner died${runner === "foreign" ? ` (pid ${procs.runner.pid} now belongs to another process)` : ""}; liveness check marked the job failed/crash`;
      const notes = [
        boot !== "current" ? `harness process group ${procs.child.pid} ${UNKNOWN_BOOT_NOTE}` : null,
        group === "foreign" ? `harness process group ${procs.child.pid} ${FOREIGN_NOTE}` : null,
        group === "unknown" ? `harness process group ${procs.child.pid} ${unconfirmedNote(procs.child.startedAt)}` : null,
        killed.length > 0 ? `SIGKILL to process groups ${killed.join(",")}` : null,
      ];
      appendLog(log, [marked, ...notes.filter(Boolean)].join("; "));
    }
    done.push({ id: record.id, action: "runner-died", groups: killed });
  }
  return done;
}

// The reaper's part of a pending cleanup (a terminal job, its processes not known to be stopped): nothing while the
// runner may still live (it owns the stop) or while the boot cannot be confirmed; else reapOwnedSync. Returns
// { action, groups } when it signalled, else null.
function resumeCleanupSync(jobsDir, record, boot, log) {
  const file = jobFile(jobsDir, record.id);
  if (boot === "earlier") {
    markCleaned(file);
    return null;
  }
  if (boot !== "current") return null; // nothing is signalled by a stored pid
  const procs = jobProcesses(jobsDir, record);
  if (possiblyOurs(processIdentity(procs.runner.pid, procs.runner.startedAt))) return null;
  const harness = procs.child.pid !== null && harnessGroupState(procs.child.pid, procs.child.startedAt) === "ours";
  const killed = reapOwnedSync(jobsDir, record);
  if (killed.length === 0) return null;
  const what = harness ? `harness process group ${procs.child.pid} was alive` : "process groups it may own were alive";
  appendLog(log, `cleanup resumed: the job is ${record.status} but its runner pid ${procs.runner.pid} is gone and ${what}; SIGKILL to process groups ${killed.join(",")}`);
  return { action: "cleanup-resumed", groups: killed };
}

// One reaper pass over what a job whose runner is gone may still own (survivingGroups): SIGKILL to the trees of the
// groups that are provably the job's — the groups a snapshot adds recorded first — and nothing to one that is
// unknown. The marker is written by the pass that finds nothing left, so a group that was just killed is confirmed
// gone by the next one. Returns the groups signalled.
function reapOwnedSync(jobsDir, record) {
  const file = jobFile(jobsDir, record.id);
  const left = survivingGroups(jobsDir, record);
  const ours = left.filter((group) => group.state === "ours").map((group) => group.pgid);
  const killed = ours.length > 0 ? killTreeSync(ours, "SIGKILL", { onGroups: (groups) => recordGroups(file, groups, "reaper") }) : [];
  if (left.length === 0) markCleaned(file);
  return killed;
}

// Allocation order of pending jobs: start time, then jobs dir and number as tie-breaks.
const allocationKey = (startedAt, jobsDir, id) => [String(startedAt ?? ""), String(jobsDir), String(idNumber(id)).padStart(16, "0"), String(id)];
function allocatedBefore(record, jobsDir, self) {
  const a = allocationKey(record.startedAt, jobsDir, record.id);
  const b = allocationKey(self.startedAt, self.jobsDir, self.id);
  const index = a.findIndex((part, i) => part !== b[i]);
  return index >= 0 && a[index] < b[index];
}

// Running core jobs of a profile in every workspace under the state root (spec §3.9 maxParallel); dead runners are
// reaped first, so a crashed job never holds a slot. `self` is the caller's own pending job { jobsDir, id, startedAt }:
// it is skipped, and another pending job (allocated, no runner yet) counts only if it was allocated first, so of two
// tasks checking at the same moment the earlier one runs and the later one is refused — never both. (Two tasks
// allocated within one millisecond whose checks do not overlap can still both pass; the orchestrator is the only
// caller, spec §3.9.)
export function runningJobsOfProfile(profileName, { env = process.env, self = null } = {}) {
  const base = path.join(stateRoot(env), "state");
  let slugs = [];
  try {
    slugs = fs.readdirSync(base);
  } catch {
    return [];
  }
  const running = [];
  for (const slug of slugs.sort()) {
    const jobsDir = path.join(base, slug, "jobs");
    if (!fs.existsSync(jobsDir)) continue;
    reapDeadRunners(jobsDir);
    for (const record of listRecords(jobsDir)) {
      if (record.status !== "running" || record.profile !== profileName) continue;
      if (self && self.jobsDir === jobsDir && self.id === record.id) continue;
      if (self && record.runnerPid == null && !allocatedBefore(record, jobsDir, self)) continue;
      running.push({ id: record.id, workspaceRoot: record.workspaceRoot, write: record.write === true });
    }
  }
  return running;
}

// A workspace root in the maxParallel refusal (spec §3.9): JSON-quoted when it holds ", ", a double quote or a control
// character, so the list still splits at ", " and every root reads back as one argument.
const shownRoot = (root) => (typeof root !== "string" ? "-" : /[\x00-\x1f\x7f"]|, /.test(root) ? JSON.stringify(root) : root);

// ---------- running a harness ----------

// Feeds text to `write` in whole lines with `redact` applied, so a secret split across chunks is still caught. A very
// long line is flushed except for a tail longer than any registered secret, which waits for the next chunk.
function lineSink(write, redact) {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      const cut = pending.lastIndexOf("\n");
      if (cut >= 0) {
        write(redact(pending.slice(0, cut + 1)));
        pending = pending.slice(cut + 1);
      } else if (pending.length > 65536) {
        const red = redact(pending);
        let at = red.length - ((redact.maxLength?.() ?? 0) + 1);
        if (at > 0 && /[\uD800-\uDBFF]/.test(red[at - 1])) at -= 1; // never split a surrogate pair
        if (at > 0) {
          write(red.slice(0, at));
          pending = red.slice(at);
        }
      }
    },
    flush() {
      if (pending) write(redact(pending));
      pending = "";
    },
  };
}

// Keeps the first `headMax` and the last `tailMax` characters of a stream, both cut at line boundaries, and counts
// what was dropped between them: stdout for reduce(), which reads the session header and the final answer at the
// two ends of an event stream, without one string growing toward V8's limit.
export function boundedText(headMax, tailMax) {
  let head = "";
  let headOpen = true;
  const tail = [];
  let tailLength = 0;
  let dropped = 0;
  let droppedWholeLines = true; // the dropped text ended at a line boundary
  return {
    push(chunk) {
      let text = String(chunk);
      if (headOpen) {
        head += text;
        if (head.length <= headMax) return;
        headOpen = false;
        const cut = head.lastIndexOf("\n", headMax - 1) + 1; // whole lines only
        text = head.slice(cut);
        head = head.slice(0, cut);
      }
      if (!text) return;
      tail.push(text);
      tailLength += text.length;
      while (tail.length > 1 && tailLength - tail[0].length >= tailMax) {
        const gone = tail.shift();
        tailLength -= gone.length;
        dropped += gone.length;
        droppedWholeLines = gone.endsWith("\n");
      }
    },
    result() {
      let rest = tail.join("");
      if (dropped > 0 && !droppedWholeLines) {
        const nl = rest.indexOf("\n"); // the tail starts inside a line: drop that partial line too
        if (nl >= 0) {
          dropped += nl + 1;
          rest = rest.slice(nl + 1);
        }
      }
      return { text: head + rest, dropped };
    },
  };
}

// Runs the harness as its own process group; resolves once it has exited and its output is drained. stdin comes from
// `stdinPath` (closed at EOF) or /dev/null. Streams are decoded as UTF-8 across chunk boundaries; stdout and stderr go
// line by line, redacted, to the job log (the event stream lives there, spec §3.3), and the result keeps a bounded
// head and tail of stdout (boundedText). One ladder at most runs over the process tree: on the whole-job timeout, on
// a label returned by onSpawn(pid, { startedAt }) (a stop requested before the harness ran), or on one returned by
// shouldStop(), polled every STOP_POLL_MS while the harness runs. After a normal exit, members of the harness's group
// and the descendants still linked to them are stopped with the same ladder ("cleanup"): a server or watcher the
// model backgrounded does not outlive the job (spec §3.6 А8, §3.9); descendants already orphaned to init are out of
// reach. `onGroups` goes to terminateTree. The result's `teardown` { survivors, error } is the outcome of that stop,
// apart from the verdict: groups still alive after the ladder and its re-sweep, or the error that broke it off.
export function runCli({ argv, cwd, env, stdinPath = null, timeoutMs, logPath = null, onSpawn, shouldStop = null, redact = (text) => text, ladder = DEFAULT_LADDER, exclude = [], onGroups = null }) {
  return new Promise((resolve) => {
    const stdout = boundedText(STDOUT_HEAD_CHARS, STDOUT_TAIL_CHARS);
    let stderr = "";
    const toLog = (text) => {
      if (!logPath || !text) return;
      try {
        fs.appendFileSync(logPath, text);
      } catch {
        // the log is best effort
      }
    };
    const outLines = lineSink(toLog, redact);
    const errLines = lineSink((text) => {
      stderr = (stderr + text).slice(-262144);
      toLog(text);
    }, redact);
    let timedOut = false;
    let spawnError = null;
    let exitCode = null;
    let signal = null;
    let settled = false;
    let timer = null;
    let closeTimer = null;
    let poller = null;
    let child = null;
    let childStart = null;
    let stopping = null; // the ladder's promise, once one runs
    let stoppedBy = null;
    let teardown = { survivors: [], error: null };
    const runLadder = (label, reason = label) => {
      if (stopping || !child?.pid) return;
      stoppedBy = label;
      clearInterval(poller);
      appendLog(logPath, `${reason}: ${ladderText(ladder)} to the process tree of ${child.pid}`);
      stopping = terminateTree(child.pid, ladder, { exclude, onGroups, log: (line) => appendLog(logPath, `${label}: ${line}`) });
    };
    const sweepLeftovers = () => {
      if (harnessGroupState(child.pid, childStart) !== "ours") return null; // nothing left, or the pid is no longer ours
      stoppedBy = "cleanup";
      appendLog(logPath, `cleanup: the harness exited and left processes in its group; ${ladderText(ladder)} to the process tree of ${child.pid}`);
      return terminateTree(child.pid, ladder, { exclude, onGroups, log: (line) => appendLog(logPath, `cleanup: ${line}`) });
    };
    const settleTeardown = async (stop) => {
      try {
        const stopped = await stop();
        if (stopped) teardown = { survivors: stopped.survivors, error: null };
      } catch (error) {
        teardown = { survivors: [], error: error?.message ?? String(error) };
        appendLog(logPath, `the stop of the process tree failed: ${redact(teardown.error)}`);
      }
    };
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      clearInterval(poller);
      if (stopping) await settleTeardown(() => stopping);
      else if (child?.pid && !spawnError) await settleTeardown(sweepLeftovers);
      outLines.flush();
      errLines.flush();
      // A descendant that keeps the pipes open after the harness exited must not append to the log any more.
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      const kept = stdout.result();
      if (kept.dropped > 0) appendLog(logPath, `stdout: ${kept.dropped} characters in the middle of the stream are kept only in this log`);
      resolve({
        timedOut,
        spawnError,
        exitCode,
        signal,
        stoppedBy,
        teardown,
        childStartedAt: childStart,
        stdout: redact(kept.text),
        stdoutDropped: kept.dropped,
        stderrTail: stderr.split("\n").slice(-200).join("\n"),
      });
    };
    let stdinFd = null;
    try {
      if (stdinPath) stdinFd = fs.openSync(stdinPath, "r");
      child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: [stdinFd ?? "ignore", "pipe", "pipe"] });
    } catch (error) {
      spawnError = error;
      finish();
      return;
    } finally {
      if (stdinFd !== null) fs.closeSync(stdinFd); // the child holds its own copy
    }
    child.on("error", (error) => {
      spawnError = error;
      finish();
    });
    if (child.pid) {
      childStart = processStart(child.pid);
      const label = onSpawn?.(child.pid, { startedAt: childStart });
      if (label) runLadder(label, `${label} before the harness started`);
      if (typeof shouldStop === "function") {
        poller = setInterval(() => {
          let requested = null;
          try {
            requested = shouldStop();
          } catch {
            requested = null; // a failed check never stops the harness
          }
          if (requested) runLadder(requested);
        }, STOP_POLL_MS);
      }
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      outLines.push(chunk);
    });
    child.stderr.on("data", (chunk) => errLines.push(chunk));
    timer = setTimeout(() => {
      timedOut = true;
      runLadder("timeout", `timeout after ${timeoutMs} ms`);
    }, Math.min(Math.max(1, timeoutMs), MAX_TIMER_MS));
    child.on("exit", (code, sig) => {
      exitCode = code;
      signal = sig;
      clearTimeout(timer); // the harness is done: only its output is still draining
      clearInterval(poller);
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

// Every stdout line that parses as JSON, in order: what event-stream adapters read in reduce().
export function parseEvents(stdout) {
  const events = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) continue;
    try {
      events.push(JSON.parse(text));
    } catch {
      // not an event
    }
  }
  return events;
}

const matches = (haystack, pattern) =>
  pattern instanceof RegExp ? pattern.test(haystack) : typeof pattern === "string" && pattern !== "" && haystack.toLowerCase().includes(pattern.toLowerCase());

// The job's verdict. First match wins: timeout, launch (spawn error), success by reduce() alone, the class reduce()
// gave, the adapter's patterns (PATTERN_ORDER), then malformed (exit 0 without a final answer) or crash (a non-zero
// exit or a signal without a recognised error). Patterns see reduce()'s errorText and the stderr tail, plus stdout
// only when it holds no JSON events: an event stream is reduce()'s to read, and its ids and model text would match
// short patterns such as "401" by accident.
export function classifyOutcome({ io, reduced, patterns = {} }) {
  if (io.timedOut) return { status: "failed", errorClass: "timeout" };
  if (io.spawnError) return { status: "failed", errorClass: "launch" };
  if (reduced?.ok === true && typeof reduced.response === "string") return { status: "completed", errorClass: null };
  if (typeof reduced?.errorClass === "string" && ERROR_CLASSES.includes(reduced.errorClass)) return { status: "failed", errorClass: reduced.errorClass };
  const rawStdout = (io.events ?? parseEvents(io.stdout)).length === 0 ? (io.stdout ?? "") : "";
  const haystack = [reduced?.errorText ?? "", io.stderrTail ?? "", rawStdout].join("\n");
  for (const [key, errorClass] of PATTERN_ORDER) {
    const list = patterns?.[key];
    if (Array.isArray(list) && list.some((pattern) => matches(haystack, pattern))) return { status: "failed", errorClass };
  }
  const clean = io.exit?.code === 0 && !io.exit?.signal;
  return { status: "failed", errorClass: clean ? "malformed" : "crash" };
}

// ---------- adapter plumbing ----------

function validateAdapter(adapter) {
  if (!isObject(adapter) || typeof adapter.id !== "string" || !adapter.id) throw new Error("adapter without an id");
  if (!/^[a-z]{2}$/.test(adapter.idPrefix ?? "") || FOREIGN_PREFIXES.has(adapter.idPrefix)) throw new Error(`adapter ${adapter.id}: invalid idPrefix ${JSON.stringify(adapter.idPrefix)}`);
  for (const name of ["invocation", "reduce"]) {
    if (typeof adapter[name] !== "function") throw new Error(`adapter ${adapter.id}: ${name}() is missing`);
  }
  normalizeLadder(adapter.manifest?.cancel?.ladder);
}

const readOnlyFs = {
  readFile(file, encoding = "utf8") {
    try {
      return fs.readFileSync(file, encoding);
    } catch {
      return null;
    }
  },
  exists: (file) => fs.existsSync(file),
  stat(file) {
    try {
      return fs.statSync(file);
    } catch {
      return null;
    }
  },
  readdir(dir) {
    try {
      return fs.readdirSync(dir);
    } catch {
      return null;
    }
  },
};

// The supervisor of one auxiliary command (boundedExec), run as `node -e`. boundedExec starts it as the leader of a
// session and process group of its own (spawnSync's `detached`: setsid), and the command runs in that group: a
// SIGKILL to the caller's group (a runner's) does not reach them. It never starts the command without leading that
// group, and the group lives exactly as long as it does: every way out of it is one SIGKILL to its own group, itself
// included — sent while it is alive, so the group id cannot name another group yet, and nobody signals that id once
// it is reaped. In order: for a runner (cfg.ownerLog, its job's ownership log) it appends its group with its own start
// time — so the group stays the job's should the runner die from here on — then checks that its parent is still the
// caller it was given (cfg.callerPid; once the caller dies it has another parent, never the caller's pid again), and
// only then starts the command, unless the deadline has passed already. The deadline counts from its own start, so it
// is done by start + timeoutMs + graceMs whatever its first steps cost, well inside boundedExec's backstop: only an
// outside SIGKILL to it alone can leave the command running without it. It sends SIGTERM to the group at the deadline
// — or once the stop file exists (a runner's terminal claim), its caller is gone, or it is signalled itself — and ends
// the group graceMs later; after a normal exit it ends it at once, with whatever the command left in it. It prints one
// JSON result before that SIGKILL (none when its caller is gone) and never waits on the command beyond deadline +
// grace, whatever the command does with its signals or its pipes. It loads nothing from disk: a plugin update that
// replaces the core's directory during a long job does not break a runner's later ctx.exec. Its config arrives on
// stdin (the command's environment must not show in argv); argv repeats the command for ps.
const EXEC_SUPERVISOR = String.raw`
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const startedAt = Date.now();
const cfg = JSON.parse(fs.readFileSync(0, "utf8"));
const deadline = cfg.timeoutMs > 0 ? startedAt + cfg.timeoutMs : Infinity;
// This process's start time exactly as processStart() of agent-core.mjs reads it (keep the two in step): field 22 of
// /proc/<pid>/stat on Linux, else ps's lstart in the C locale and UTC.
const ownStart = () => {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync("/proc/self/stat", "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[22 - 3];
      if (/^\d+$/.test(ticks || "")) return "ticks:" + ticks;
    } catch {}
  }
  for (const ps of ["ps", "/bin/ps"]) {
    const r = spawnSync(ps, ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" }, timeout: cfg.psTimeoutMs, killSignal: "SIGKILL" });
    if (r.error) continue;
    const text = (r.stdout || "").trim().replace(/\s+/g, " ");
    return r.status === 0 && text ? text : null;
  }
  return null;
};
// One line appended to the job's ownership log, which must exist already (it is never created here).
const recordOwnGroup = () => {
  let fd = null;
  try {
    fd = fs.openSync(cfg.ownerLog, fs.constants.O_WRONLY | fs.constants.O_APPEND);
    fs.writeSync(fd, JSON.stringify({ groups: [{ pgid: process.pid, startedAt: ownStart() }], by: "exec", at: new Date().toISOString() }) + "\n");
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
};
const chunks = { stdout: [], stderr: [] };
const sizes = { stdout: 0, stderr: 0 };
let child = null, status = null, signal = null, error = null;
let exited = false, timedOut = false, stopped = false, stopping = false, done = false, killTimer = null, closeTimer = null, poll = null;
const callerGone = () => process.ppid !== cfg.callerPid;
const failure = (e) => ({ code: typeof e.code === "string" ? e.code : null, errno: e.errno, detail: typeof e.code === "string" ? null : String(e.message) });
const end = () => { try { process.kill(-process.pid, "SIGKILL"); } catch {} process.exit(1); };
const finish = () => {
  if (done) return;
  done = true;
  clearInterval(poll); clearTimeout(killTimer); clearTimeout(closeTimer);
  if (callerGone()) return end();
  for (const s of [child && child.stdout, child && child.stderr]) if (s) s.destroy();
  if (child && child.pid && !exited) signal = "SIGKILL"; // still running: ended with the group
  const text = (k) => Buffer.concat(chunks[k]).toString("utf8");
  const result = JSON.stringify({ status, signal, stdout: text("stdout"), stderr: text("stderr"), error, timedOut, stopped });
  process.stdout.on("error", end);
  process.stdout.write(result, end);
};
const stop = (why) => {
  if (stopping || done || !child || !child.pid) return;
  stopping = true;
  if (why === "timeout") { timedOut = true; error = { code: "ETIMEDOUT" }; }
  else { stopped = true; error = { code: "ECANCELED", detail: "stopped: " + why }; }
  try { process.kill(-process.pid, "SIGTERM"); } catch {} // this process too: the handler below ignores it while stopping
  killTimer = setTimeout(finish, cfg.graceMs);
};
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => { if (s !== "SIGTERM" || !stopping) end(); });
const refuse = (detail) => { error = { code: "ESUPERVISOR", detail }; finish(); };
const run = async () => {
  if (cfg.testDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, cfg.testDelayMs));
  try { process.kill(-process.pid, 0); } catch { return refuse("it leads no process group of its own"); }
  if (cfg.ownerLog && !recordOwnGroup()) return refuse("its process group could not be recorded for the job");
  if (callerGone()) return end(); // the caller died before this supervisor got here: nothing is started
  if (Date.now() >= deadline) { timedOut = true; error = { code: "ETIMEDOUT", detail: "the deadline passed before the command started" }; return finish(); }
  const input = cfg.inputBase64 != null ? Buffer.from(cfg.inputBase64, "base64") : cfg.input;
  child = spawn(cfg.cmd, cfg.args, { cwd: cfg.cwd || undefined, env: cfg.env, stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", (e) => { error = failure(e); finish(); });
  for (const k of ["stdout", "stderr"]) {
    child[k].on("data", (chunk) => {
      sizes[k] += chunk.length;
      if (sizes[k] > cfg.maxBuffer) {
        if (!error) error = { code: "ENOBUFS" };
        try { child.kill("SIGKILL"); } catch {}
        return finish();
      }
      chunks[k].push(chunk);
    });
  }
  child.stdin.on("error", () => {});
  child.stdin.end(input == null ? "" : input);
  child.on("exit", (code, sig) => { exited = true; status = code; signal = sig; if (!closeTimer) closeTimer = setTimeout(finish, 200); });
  child.on("close", (code, sig) => { exited = true; if (status === null && signal === null) { status = code; signal = sig; } finish(); });
  poll = setInterval(() => {
    if (callerGone()) stop("its caller is gone");
    else if (Date.now() >= deadline) stop("timeout");
    else if (cfg.stopFile && fs.existsSync(cfg.stopFile)) stop("the job was cancelled");
  }, 50);
};
run().catch((e) => { error = failure(e); finish(); });
`;

// Node's error of a failed spawnSync (code, errno, syscall, path, spawnargs; message `spawnSync <cmd> <code>`), which
// ctx.exec has always returned.
function execError(code, cmd, args, { errno = null, detail = null } = {}) {
  const number = Number.isInteger(errno) ? errno : os.constants.errno[code] ? -os.constants.errno[code] : undefined;
  return Object.assign(new Error(`spawnSync ${cmd} ${code}${detail ? ` (${detail})` : ""}`), {
    ...(number !== undefined ? { errno: number } : {}),
    code,
    syscall: `spawnSync ${cmd}`,
    path: cmd,
    spawnargs: args,
  });
}

// Runs one short auxiliary command (`--version`, `--help`, `auth status`, an export) synchronously, never through a
// shell, under a hard deadline: the command runs in a session and process group of its own, led by its supervisor (so
// a cancel that finds a stuck runner reaches it among the runner's descendants, and a SIGKILL to the runner's group
// does not orphan it), gets SIGTERM at timeoutMs and SIGKILL graceMs later, and is stopped the same way once
// `stopFile` exists or the caller is gone; anything it leaves in its group is SIGKILLed when it is done — all by the
// supervisor (EXEC_SUPERVISOR), so this function signals nothing. `owner` (a runner's job record) gets the group
// recorded in its ownership log before the command starts. It has no controlling terminal, so it is not for a command
// that prompts on one. A plain spawnSync timeout only sends SIGTERM and then waits for as long as the command ignores
// it. timeoutMs counts from the supervisor's start (a command never starts past it). spawnSync's calling convention
// otherwise: `timeoutMs` 0 or null is no deadline (a stop file and the caller's
// death still end the command); `input` is a string, a Buffer or a typed array. Returns { status, signal, stdout,
// stderr, error, timedOut, stopped }; error is spawnSync's (code, errno, syscall, path, spawnargs) with code ETIMEDOUT
// after the deadline, ECANCELED after a stop, ENOBUFS beyond maxBuffer, the spawn error's (ENOENT, …) otherwise, or
// ESUPERVISOR when the supervisor itself failed.
export function boundedExec(cmd, args = [], { timeoutMs = EXEC_TIMEOUT_MS, graceMs = EXEC_GRACE_MS, cwd, env = process.env, input, stopFile = null, owner = null, maxBuffer = EXEC_MAX_BUFFER } = {}) {
  const argv = (Array.isArray(args) ? args : []).map(String);
  const ms = (value, fallback, min) => (typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(min, value), MAX_TIMER_MS) : fallback);
  const binary = ArrayBuffer.isView(input);
  const config = {
    cmd: String(cmd),
    args: argv,
    cwd: cwd ?? null,
    env,
    input: binary || input == null ? null : String(input),
    inputBase64: binary ? Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("base64") : null,
    timeoutMs: timeoutMs === null || timeoutMs === 0 ? 0 : ms(timeoutMs, EXEC_TIMEOUT_MS, 1),
    graceMs: ms(graceMs, EXEC_GRACE_MS, 0),
    stopFile,
    ownerLog: owner ? runnerFile(owner) : null,
    callerPid: process.pid,
    maxBuffer,
    psTimeoutMs: PS_TIMEOUT_MS,
    testDelayMs: Number(process.env[TEST_EXEC_DELAY_VAR]) || 0,
  };
  const r = spawnSync(process.execPath, ["-e", EXEC_SUPERVISOR, `${CLI_NAME}-exec`, config.cmd, ...argv], {
    input: JSON.stringify(config),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" }, // the supervisor itself needs nothing; NODE_OPTIONS must not reach it
    detached: true, // setsid: the supervisor leads the command's group (see EXEC_SUPERVISOR)
    timeout: config.timeoutMs > 0 ? config.timeoutMs + config.graceMs + EXEC_MARGIN_MS : undefined,
    killSignal: "SIGKILL",
    maxBuffer: 16 * maxBuffer,
  });
  // Nothing is signalled here: the supervisor has ended its group itself, and its pid — the group's id — is free for
  // reuse now that it is reaped. A supervisor SIGKILLed alone (by hand, by the OOM killer; the backstop above fires
  // only on one stuck for EXEC_MARGIN_MS beyond its own end) leaves its command without a leader that could confirm the
  // group is still this one: it is not signalled by its number, here or by a job's cleanup.
  let res = null;
  try {
    res = JSON.parse(r.stdout ?? "");
  } catch {
    res = null;
  }
  if (!isObject(res)) {
    const why = r.error?.code ?? (r.signal ? `signal ${r.signal}` : `exit ${r.status}`);
    return { status: null, signal: null, stdout: "", stderr: "", error: execError("ESUPERVISOR", config.cmd, argv, { detail: `its supervisor failed: ${why}` }), timedOut: false, stopped: false };
  }
  const code = typeof res.error?.code === "string" ? res.error.code : "ESUPERVISOR"; // a failure without a code of its own
  const error = isObject(res.error) ? execError(code, config.cmd, argv, { errno: res.error.errno, detail: res.error.detail ?? null }) : null;
  return { status: res.status ?? null, signal: res.signal ?? null, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error, timedOut: res.timedOut === true, stopped: res.stopped === true };
}

function defaultExec(env, { stopFile = null, owner = null } = {}) {
  return (cmd, args = [], { timeoutMs = EXEC_TIMEOUT_MS, graceMs = EXEC_GRACE_MS, cwd, env: childEnv, input } = {}) =>
    boundedExec(cmd, args, { timeoutMs, graceMs, cwd, env: childEnv ?? filterEnv(env), input, stopFile, owner });
}

// The ctx handed to adapter hooks. Tests inject `exec` and `fs`. `stopFile`: a file whose appearance stops the
// default exec's command (a runner passes its job's terminal claim); `owner`: the job record whose ownership log
// records the default exec's process groups (a runner passes its own).
export function makeCtx({ env = process.env, profile = {}, profileName = null, exec, fs: fsApi, stopFile = null, owner = null, ...rest } = {}) {
  return { env, profile, profileName, platform: process.platform, paths: dataPaths(env), exec: exec ?? defaultExec(env, { stopFile, owner }), fs: fsApi ?? readOnlyFs, ...rest };
}

function launchError(message) {
  return Object.assign(new Error(message), { errorClass: "launch" });
}

// `cmd args` behind the profile's wrap prefix: how discover and the help check reach a binary that may exist only
// inside the wrap (a container, spec §3.7), the same way the harness itself is run.
function wrappedExec(exec, wrap) {
  if (!Array.isArray(wrap) || wrap.length === 0) return exec;
  return (cmd, args = [], options) => exec(wrap[0], [...wrap.slice(1), cmd, ...args], options);
}

// `<bin> <helpArgv>` once per (wrap, bin, version), cached under <data root>/cache (spec §3.2). Only a help text from
// a clean exit is cached; a non-zero exit that still printed something is used for this check alone. Returns
// { text, cached }.
function cachedHelp({ bin, version }, helpArgv, wrap, ctx, { fresh = false } = {}) {
  const key = createHash("sha1").update([...wrap, "", bin, version ?? "", ...helpArgv].join("\0")).digest("hex").slice(0, 16);
  const file = path.join(ctx.paths.cache, `help-${key}.txt`);
  if (version && !fresh) {
    const cached = readOnlyFs.readFile(file);
    if (cached !== null) return { text: cached, cached: true };
  }
  const r = ctx.exec(bin, helpArgv);
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error || (r.status !== 0 && !text.trim())) throw launchError(`cannot run ${bin} ${helpArgv.join(" ")}: ${r.error?.code ?? `exit ${r.status}`}`);
  if (version && r.status === 0) {
    try {
      writePrivateFile(file, text);
    } catch {
      // the cache is best effort
    }
  }
  return { text, cached: false };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const missingFlags = (required, help) =>
  required.filter((flag) => !new RegExp(`(^|[\\s,\\[|])${escapeRegExp(flag)}(?=[\\s,=\\]|]|$)`, "m").test(help));

// discover() plus the required-flag check, both through the profile's `wrap`. launch only for: no binary, the wrong
// binary, a required flag missing from the help text (spec §3.2); a cached help text that lacks a flag is re-read
// once before that verdict. Returns { bin, version } or null for an adapter without discover().
export async function discoverHarness(adapter, ctx) {
  if (typeof adapter.discover !== "function") return null;
  const wrap = Array.isArray(ctx.profile?.wrap) ? ctx.profile.wrap : [];
  const wrapped = { ...ctx, exec: wrappedExec(ctx.exec, wrap), execHost: ctx.exec };
  const found = await adapter.discover(wrapped);
  if (!isObject(found) || typeof found.bin !== "string" || !found.bin) throw launchError(`adapter ${adapter.id}: discover() found no binary`);
  const required = adapter.manifest?.requiredFlags ?? [];
  const helpArgv = adapter.manifest?.helpArgv;
  if (required.length > 0 && Array.isArray(helpArgv)) {
    let help = cachedHelp(found, helpArgv, wrap, wrapped);
    let missing = missingFlags(required, help.text);
    if (missing.length > 0 && help.cached) {
      help = cachedHelp(found, helpArgv, wrap, wrapped, { fresh: true });
      missing = missingFlags(required, help.text);
    }
    if (missing.length > 0) throw launchError(`${found.bin} ${found.version ?? "(unknown version)"}: \`${helpArgv.join(" ")}\` does not list the required flag(s) ${missing.join(" ")}`);
  }
  return { bin: found.bin, version: typeof found.version === "string" ? found.version : null };
}

// A req (spec §3.2) without a job, for doctor and probes: `dir` stands in for the job dir.
function jobLessRequest({ profile, profileName, dir, cwd, promptPath = null, promptBytes = 0, harness = null, sessionId = null }) {
  return {
    profile,
    profileName,
    role: null,
    write: false,
    job: { id: null, dir, cwd, workspaceRoot: null },
    prompt: { path: promptPath, bytes: promptBytes },
    sessionId,
    resume: null,
    harness,
  };
}

// The req of spec §3.2, built from a job record.
function requestOf(record, profile, harness, jobsDir) {
  const prev = record.resumeOf ? readRecord(jobFile(jobsDir, record.resumeOf)) : null;
  return {
    profile,
    profileName: record.profile,
    role: record.role ?? null,
    write: record.write === true,
    job: { id: record.id, dir: jobDir(jobsDir, record.id), cwd: record.cwd, workspaceRoot: record.workspaceRoot },
    prompt: { path: record.promptPath, bytes: record.promptBytes },
    sessionId: record.sessionId ?? null,
    resume: record.resumeOf ? { sessionId: record.sessionId, prev } : null,
    harness,
  };
}

// prepareHome + invocation (or the adapter's probe() with `probe`), checked for shape. Pure by contract, so task
// and doctor can call it to validate.
export async function planInvocation(adapter, req, ctx, { probe = false } = {}) {
  const home = typeof adapter.prepareHome === "function" ? ((await adapter.prepareHome(req.profile, ctx)) ?? {}) : {};
  const hook = probe && typeof adapter.probe === "function" ? "probe" : "invocation";
  const inv = await adapter[hook](req, ctx);
  if (!isObject(inv) || !Array.isArray(inv.argv) || inv.argv.length === 0 || inv.argv.some((arg) => typeof arg !== "string")) {
    throw new Error(`adapter ${adapter.id}: ${hook}() returned no argv`);
  }
  for (const [label, value] of [["env", inv.env], ["mandatoryEnv", inv.mandatoryEnv], ["prepareHome env", home.env], ["meta", inv.meta]]) {
    if (value !== undefined && value !== null && !isObject(value)) throw new Error(`adapter ${adapter.id}: ${label} must be an object`);
  }
  for (const [label, value] of [["dirs", inv.dirs], ["files", inv.files], ["prepareHome dirs", home.dirs], ["prepareHome files", home.files]]) {
    if (value !== undefined && value !== null && !Array.isArray(value)) throw new Error(`adapter ${adapter.id}: ${label} must be an array`);
  }
  const secretEnv = [...new Set(inv.secretEnv ?? [])];
  if (secretEnv.some((name) => typeof name !== "string" || !ENV_NAME_RE.test(name))) throw new Error(`adapter ${adapter.id}: invalid secretEnv ${JSON.stringify(inv.secretEnv)}`);
  const mandatory = { ...(home.env ?? {}), ...(inv.mandatoryEnv ?? {}) };
  const homeMode = req.profile?.home ?? "user";
  return {
    argv: inv.argv,
    cwd: inv.cwd ?? req.job.cwd,
    stdinPath: inv.stdinPath ?? null,
    defaults: inv.env ?? {},
    mandatory,
    secretEnv,
    inherit: Array.isArray(inv.inheritEnv) ? inv.inheritEnv : homeMode === "user" ? (adapter.manifest?.homeEnv ?? []) : [],
    dirs: [...(home.dirs ?? []), ...(inv.dirs ?? [])],
    files: [...(home.files ?? []), ...(inv.files ?? [])],
    meta: inv.meta ?? null,
    mandatoryNames: [...new Set([...Object.keys(mandatory), ...secretEnv])],
  };
}

// The directories and files an adapter asked for (an empty agents home, a session dir; settings, patch files, system
// prompts): only under the data root, directories 0700 and files 0600 unless the entry names a mode. Directories are
// created first.
export function writeAdapterFiles({ dirs = [], files = [] } = {}, env = process.env) {
  const root = stateRoot(env);
  const inside = (value, label) => {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`invalid adapter ${label} path: ${JSON.stringify(value)}`);
    const resolved = path.resolve(value);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`adapter ${label} outside the data root: ${value}`);
    return resolved;
  };
  for (const dir of dirs) ensurePrivateDir(inside(dir, "dir"));
  for (const entry of files) {
    if (!isObject(entry) || typeof entry.content !== "string") throw new Error(`invalid adapter file entry: ${JSON.stringify(entry?.path)}`);
    writePrivateFile(inside(entry.path, "file"), entry.content, Number.isInteger(entry.mode) ? entry.mode : 0o600);
  }
}

// What doctor checks profile.env against (spec §5.4): the adapter's mandatory settings and key variables for this
// profile, from a job-less plan — pure hooks only, nothing is written or run. Pass the result to envConflicts().
export async function mandatorySettings(adapter, profile, ctx) {
  validateAdapter(adapter);
  const dir = path.join(ctx.paths.state, "doctor");
  const plan = await planInvocation(adapter, jobLessRequest({ profile, profileName: ctx.profileName, dir, cwd: dir }), ctx);
  return { names: plan.mandatoryNames, mandatory: plan.mandatory, secretEnv: plan.secretEnv };
}

// Whether any string inside a value (a profile snapshot, argv) contains a value `redact` knows.
function holdsSecret(value, redact) {
  if (typeof value === "string") return redact(value) !== value;
  if (Array.isArray(value)) return value.some((item) => holdsSecret(item, redact));
  if (isObject(value)) return Object.values(value).some((item) => holdsSecret(item, redact));
  return false;
}

// The harness command of a plan: the env-conflict and key guards, the adapter's dirs and files, the environment.
// Throws when profile.env touches a mandatory name, when a key is asked for but missing (errorClass auth), or when
// the adapter put the key into argv or into a file — spec §3.5: the key lives only in the harness environment.
function materialize(plan, { profile, secret, redact, env }) {
  const conflicts = envConflicts(profile.env, plan);
  if (conflicts.length > 0) throw new Error(`profile env ${conflicts.join(", ")} conflicts with a mandatory setting`);
  if (plan.secretEnv.length > 0 && !secret) {
    throw Object.assign(new Error(`no key for ${plan.secretEnv.join(", ")}; the harness was not started`), { errorClass: "auth" });
  }
  const argv = [...(profile.wrap ?? []), ...plan.argv];
  if (secret && holdsSecret(argv, redact)) throw new Error("the adapter put the key into argv; refusing to start");
  if (secret && plan.files.some((entry) => holdsSecret(entry?.content, redact))) {
    throw new Error("the adapter put the key into a file it asked for; refusing to start");
  }
  writeAdapterFiles(plan, env);
  const childEnv = buildEnv({
    source: env,
    inherit: plan.inherit,
    defaults: plan.defaults,
    profileEnv: profile.env,
    mandatory: plan.mandatory,
    secretEnv: plan.secretEnv,
    secret,
  });
  return { argv, env: childEnv };
}

// The adapter can inspect the harness's effective configuration after its generated files exist, before an agent
// ever runs. Preflight defaults to a key-free environment; includeSecrets explicitly selects the exact harness
// environment when configuration depends on credential variables. Neither mode allows an arbitrary cwd/env.
async function beforeLaunch(adapter, req, ctx, plan, run, redact) {
  if (typeof adapter.beforeLaunch !== "function") return;
  const harnessEnv = Object.fromEntries(Object.entries(run.env).filter(([name, value]) => !plan.secretEnv.includes(name) && !holdsSecret(value, redact)));
  const bin = [...(req.profile.wrap ?? []), plan.argv[0]];
  const execHarness = (args = [], { timeoutMs = EXEC_TIMEOUT_MS, graceMs = EXEC_GRACE_MS, includeSecrets = false } = {}) =>
    ctx.exec(bin[0], [...bin.slice(1), ...args], { timeoutMs, graceMs, cwd: plan.cwd, env: includeSecrets === true ? run.env : harnessEnv });
  await adapter.beforeLaunch(req, { ...ctx, env: harnessEnv, execHarness });
}

// An adapter's meta object as the record keeps it: JSON only, redacted, at most META_MAX_CHARS; null when empty.
function cleanMeta(value, redact) {
  if (!isObject(value) || Object.keys(value).length === 0) return null;
  try {
    const text = redact(JSON.stringify(value));
    return text.length > META_MAX_CHARS ? { truncated: true, chars: text.length } : JSON.parse(text);
  } catch {
    return null;
  }
}

// The io of spec §3.2 from a runCli result.
const harnessIo = (result) => ({
  stdout: result.stdout,
  stdoutDropped: result.stdoutDropped,
  events: parseEvents(result.stdout),
  stderrTail: result.stderrTail,
  exit: { code: result.exitCode, signal: result.signal },
  timedOut: result.timedOut,
  spawnError: result.spawnError,
});

// The key behind a profile's key source, for a plan that asks for one (spec §3.5): resolved only now, after every
// refusal that needs no key. Trimmed (a keyCmd prints a trailing newline); empty, whitespace inside, or nothing
// resolved is the auth refusal.
async function resolveKey(resolveSecret, profileName, names) {
  const unavailable = (reason) => new UsageError(`${profileName}: key unavailable (${reason}) errorClass=auth`);
  if (typeof resolveSecret !== "function") throw unavailable(`nothing resolved for ${names.join(", ")}`);
  let value;
  try {
    value = await resolveSecret();
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw unavailable(error?.message ?? String(error));
  }
  if (value === null || value === undefined) throw unavailable(`nothing resolved for ${names.join(", ")}`);
  if (typeof value !== "string") throw unavailable("the key source returned no text");
  const key = value.trim();
  if (key === "") throw unavailable("resolved to an empty value");
  if (/\s/.test(key)) throw unavailable("the resolved value contains whitespace");
  return key;
}

function positiveNumber(value, fallback, label, { integer = false } = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new UsageError(`${label} must be a positive ${integer ? "integer" : "number"}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function readPromptFile(value) {
  if (!value) throw new UsageError("task requires --prompt-file <file>");
  const file = path.resolve(value);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    throw new UsageError(`prompt file not found or unreadable: ${file}`);
  }
  if (bytes.toString("utf8").trim().length === 0) throw new UsageError(`prompt file is empty: ${file}`);
  return { file, bytes };
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Resume preconditions for core jobs (spec §3.6 А12): the job is completed, has a session, ran on this profile, and
// the bound fields of its profile snapshot still match. resumeCheck runs later, with the full request.
function resolveResume(jobsDir, ref, profileName, profile) {
  if (!isCoreJobId(ref)) throw new UsageError(`${ref} is not an ${CLI_NAME} core job id; zt- and task- ids resume through their own wrappers; dispatch --fresh`);
  const prev = readRecord(jobFile(jobsDir, ref));
  if (!prev) throw new UsageError(`unknown job ${ref} in this workspace (pass the same --cwd as the original task)`);
  if (prev.status === "running") throw new UsageError(`job ${ref} is still running; wait for it to finish`);
  if (prev.status !== "completed" || !prev.sessionId) throw new UsageError(`job ${ref} is ${prev.status} / has no session; dispatch --fresh`);
  if (prev.profile !== profileName) throw new UsageError(`job ${ref} ran on profile ${prev.profile}, not ${profileName}; ids do not move between profiles; dispatch --fresh`);
  const drift = RESUME_BOUND_FIELDS.filter((field) => !sameValue(prev.profileConfig?.[field], profile[field]));
  if (drift.length > 0) throw new UsageError(`job ${ref} ran with another ${drift.join(" / ")} of profile ${profileName} than config.json has now; its session cannot continue; dispatch --fresh`);
  return prev;
}

function newSessionId(adapter, id) {
  if (adapter.manifest?.sessionId !== "preassign") return null;
  return adapter.manifest.sessionIdFormat === "job-id" ? id : randomUUID();
}

// ---------- task (foreground) ----------

export async function startJob({
  adapter,
  profileName,
  profile = {},
  role = null,
  write = false,
  cwd,
  promptFile,
  resumeTaskId = null,
  resolveSecret = null,
  cliPath,
  env = process.env,
  ctx: ctxOverrides = {},
}) {
  validateAdapter(adapter);
  if (typeof cliPath !== "string" || !cliPath) throw new Error("startJob needs the CLI path that runs the runner");
  if (resolveSecret !== null && typeof resolveSecret !== "function") throw new Error("startJob: resolveSecret must be a function or null");
  if (!PROFILE_NAME_RE.test(profileName ?? "")) throw new UsageError(`invalid profile name ${JSON.stringify(profileName)} (expected ${PROFILE_NAME_RE})`);
  if (!isObject(profile)) throw new UsageError(`profile ${profileName} is not an object`);
  // Errors from here on pass through the redactor, which learns the key once it is resolved.
  const redact = redactor();
  try {
    return await startJobUnredacted({ adapter, profileName, profile, role, write: write === true, cwd, promptFile, resumeTaskId, resolveSecret, redact, cliPath, env, ctxOverrides });
  } catch (error) {
    throw redactError(error, redact);
  }
}

async function startJobUnredacted({ adapter, profileName, profile, role, write, cwd, promptFile, resumeTaskId, resolveSecret, redact, cliPath, env, ctxOverrides }) {
  passthroughNames(env); // refuse invalid names before any job or reservation state is written
  if (profile.env !== undefined && !isObject(profile.env)) throw new UsageError(`profile ${profileName}: env must be an object`);
  if (profile.wrap !== undefined && (!Array.isArray(profile.wrap) || profile.wrap.some((arg) => typeof arg !== "string"))) {
    throw new UsageError(`profile ${profileName}: wrap must be an array of strings`);
  }
  const ws = requireWorkspace(cwd, env);
  const prompt = readPromptFile(promptFile);
  ensurePrivateDir(stateRoot(env)); // the data root is 0700 (spec §3.4): job logs and records stay the user's
  const timeoutMin = positiveNumber(profile.timeoutMin, DEFAULT_TIMEOUT_MIN, `profile ${profileName}: timeoutMin`);
  const maxParallel = positiveNumber(profile.maxParallel, DEFAULT_MAX_PARALLEL, `profile ${profileName}: maxParallel`, { integer: true });
  if (write) refuseUnavailableReservation(ws.jobsDir, ws.root); // fail fast, before any job state exists
  reapDeadRunners(ws.jobsDir);
  const prev = resumeTaskId ? resolveResume(ws.jobsDir, resumeTaskId, profileName, profile) : null;
  // A resumed job runs on the current profile too; the snapshot only decided the refusal above (spec §3.6 А12).
  const runProfile = structuredClone(profile);
  const ladder = normalizeLadder(adapter.manifest?.cancel?.ladder);

  const id = allocateJob(ws.jobsDir, adapter.idPrefix, {
    status: "running",
    errorClass: null,
    profile: profileName,
    harness: adapter.id,
    role,
    write,
    sessionId: null,
    resumeOf: prev ? prev.id : null,
    workspaceRoot: ws.root,
    cwd: ws.root,
    promptFile: prompt.file,
    promptPath: null, // set below, once the id names the job dir
    promptBytes: prompt.bytes.length,
    model: runProfile.model ?? null,
    effort: runProfile.effort ?? null,
    reportedModel: null,
    harnessVersion: null,
    runnerPid: null,
    childPid: null,
    startedAt: new Date().toISOString(),
    bootId: bootId(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    timeoutMin,
    cancelLadder: ladder,
    hasSecret: false, // set once the key is resolved and handed over
    childStartedAt: null,
    response: null,
    usage: null,
    errorText: null,
    note: null,
    meta: null,
    profileConfig: runProfile,
  });
  const file = jobFile(ws.jobsDir, id);
  const dir = jobDir(ws.jobsDir, id);
  const log = logFile(ws.jobsDir, id);
  let reservation = null;
  let handedOff = false;
  let announced = false; // a runner may exist: from here on the job is finalized, never discarded
  let spawned = false; // a runner process was started
  let payload = null;
  let secretPipe = null;
  try {
    const record = updateRunning(file, {
      sessionId: prev ? prev.sessionId : newSessionId(adapter, id),
      promptPath: path.join(dir, "prompt.md"),
    });
    if (!record) throw new Error(`job ${id} became terminal before it started`);
    const ctx = makeCtx({ env, profile: runProfile, profileName, ...ctxOverrides });
    const req = requestOf(record, runProfile, null, ws.jobsDir);
    if (prev && typeof adapter.resumeCheck === "function") {
      const reason = await adapter.resumeCheck(prev, runProfile, req, ctx);
      if (reason) throw new UsageError(`cannot resume ${prev.id} on ${profileName}: ${reason}; dispatch --fresh`);
    }
    let plan;
    try {
      plan = await planInvocation(adapter, req, ctx);
    } catch (error) {
      if (error instanceof UsageError) throw error; // the adapter refuses this profile
      throw new UsageError(`profile ${profileName}: ${error.message}`);
    }
    const conflicts = envConflicts(runProfile.env, plan);
    if (conflicts.length > 0) {
      throw new UsageError(`profile ${profileName}: env ${conflicts.join(", ")} conflicts with a mandatory setting of the ${adapter.id} adapter (spec §3.6 A); remove it from the profile`);
    }
    const others = runningJobsOfProfile(profileName, { env, self: { jobsDir: ws.jobsDir, id, startedAt: record.startedAt } });
    if (others.length >= maxParallel) {
      // Ids are numbered per workspace: each names its workspace root, which `status <id> --cwd <root>` needs.
      const running = others.map((job) => `${job.id} cwd=${shownRoot(job.workspaceRoot)}`).join(", ");
      throw new UsageError(`profile ${profileName} is at maxParallel=${maxParallel} (running: ${running})`);
    }
    if (write) reservation = acquireReservation(ws.jobsDir, id, ws.root);
    // The key last (spec §3.3): a task refused above never ran keyCmd, which may ask the password manager to confirm.
    let secret = null;
    if (plan.secretEnv.length > 0) {
      secret = await resolveKey(resolveSecret, profileName, plan.secretEnv);
      redact.add(secret);
      if (holdsSecret(runProfile, redact)) {
        throw new UsageError(`profile ${profileName}: a profile field holds the key itself; a key belongs only in auth (key set, keyEnv, keyCmd)`);
      }
    }

    ensurePrivateDir(dir);
    writePrivateFile(path.join(dir, "prompt.md"), prompt.bytes);
    if (secret !== null) {
      payload = handoffPayload(secret);
      if (!updateRunning(file, { hasSecret: true })) throw new Error(`job ${id} became terminal before it started`);
    }
    appendLog(log, `task ${id}: profile ${profileName} harness ${adapter.id} write=${write ? "yes" : "no"}${prev ? ` resumeOf=${prev.id}` : ""}`);
    const logFd = fs.openSync(log, "a");
    let runner = null;
    try {
      announced = true;
      // The runner works in the workspace root: a relative state dir is handed over resolved, so its data root
      // (cache, homes, the adapter-file guard) is the caller's.
      runner = spawn(process.execPath, [cliPath, RUN_VERB, id, ws.jobsDir, reservation?.token ?? "-"], {
        cwd: ws.root,
        detached: true,
        stdio: ["ignore", logFd, logFd, payload ? "pipe" : "ignore"],
        env: env[STATE_DIR_VAR] ? { ...env, [STATE_DIR_VAR]: stateRoot(env) } : env,
      });
    } finally {
      fs.closeSync(logFd);
    }
    if (!runner.pid) throw new Error(`failed to start the runner for ${id}`);
    spawned = true;
    secretPipe = runner.stdio[SECRET_HANDOFF_FD];
    if (reservation && !updateReservation(reservation.file, reservation.token, runner.pid, processStart(runner.pid))) {
      throw new Error(`workspace reservation was lost before the runner started for ${id}`);
    }
    // A slow-loading runner can read the buffered handoff later; only flushing to the private pipe is awaited.
    // Nothing is kept on disk while it initializes. An early cancel closes the other end and fails closed.
    if (payload) await sendSecret(secretPipe, payload);
    runner.unref();
    handedOff = true;
    return { id, jobsDir: ws.jobsDir, workspaceRoot: ws.root };
  } catch (error) {
    if (!handedOff) {
      if (!announced && error instanceof UsageError) discardJob(ws.jobsDir, id); // refused: no trace, no job
      else {
        // The note is stored: it passes the redactor like the error itself (the key may be known by now).
        finalizeRecord(file, { status: "failed", errorClass: "launch", note: redact(error?.message ?? String(error)) });
        if (!spawned) markCleaned(file); // no runner, no harness: nothing to stop (a spawned runner marks it itself)
      }
      if (!spawned) dropSecret(ws.jobsDir, id);
    }
    throw error;
  } finally {
    secretPipe?.destroy();
    payload?.fill(0);
    if (!handedOff && reservation) releaseReservation(reservation.file, reservation.token);
  }
}

// ---------- the runner (the CLI's RUN_VERB) ----------

// Tests only (TEST_RUN_BARRIER_VAR): park after the reads the claim decision rests on and before the claim. The
// runner writes what it read (`observed`) to `<barrier>.ready-<pid>` and waits for the barrier file, which may hold an
// instant (ms since the epoch) to resume at — so that two parked runners commit their claims at the same moment.
async function runBarrier(env, observed) {
  const barrier = env[TEST_RUN_BARRIER_VAR];
  if (!barrier) return;
  fs.writeFileSync(`${barrier}.ready-${process.pid}`, JSON.stringify(observed));
  for (const deadline = Date.now() + 30_000; !fs.existsSync(barrier) && Date.now() < deadline;) await sleep(10);
  const until = Math.min(Number(readOnlyFs.readFile(barrier)) || 0, Date.now() + 5_000);
  while (Date.now() < until); // a busy wait: a timer would resume the two up to a scheduler tick apart
}

export async function runJob({ id, jobsDir, token, adapters = {}, env = process.env, ctx: ctxOverrides = {} }) {
  if (!isCoreJobId(id ?? "") || !jobsDir || !token) throw new UsageError(`usage: ${CLI_NAME} ${RUN_VERB} <id> <jobs-dir> <reservation-token|-> (internal)`);
  const file = jobFile(jobsDir, id);
  const log = logFile(jobsDir, id);
  const refuse = (owner) => {
    appendLog(log, `${RUN_VERB} refused for ${id} in pid ${process.pid}: runner pid ${owner ?? "?"} owns the job`);
    return 1;
  };
  // One runner per job: the claim file is created exclusively (claimRunnerFile), so of two `__run` (by hand, or
  // duplicated) racing for one job exactly one wins, also when both read the job unclaimed; the other never starts a
  // harness and never touches the job's record, key or reservation. A record that already names another runner is
  // refused without a try.
  const before = readRecord(file);
  if (!before) return 0; // no such job (startJob discards a job only before it spawns a runner)
  if (before.status === "running" && before.runnerPid != null && before.runnerPid !== process.pid) return refuse(before.runnerPid);
  await runBarrier(env, { runnerPid: before.runnerPid ?? null, claimed: fs.existsSync(runnerFile(file)) });
  if (!claimRunnerFile(file, { pid: process.pid, startedAt: ownStart(), bootId: bootId(), claimedAt: new Date().toISOString() })) {
    return refuse(readOwnership(file)?.pid); // the job has (or had) its runner, which also finishes it
  }
  // The job is this runner's from here on, whatever its record says: every way out removes the key and — once
  // nothing the job may own is left — releases the reservation handed to it (only its holder can, so nobody else's)
  // and marks the cleanup done.
  const lock = token === "-" ? null : reservationFileForToken(jobsDir, token);
  let reserved = null;
  const holdReservation = async () => {
    if (reserved === null) reserved = Boolean(lock) && (await claimRunnerReservation(lock, id, token));
    return reserved;
  };
  let redact = redactor();
  let teardown = null; // runCli's, once the harness ran
  const secretPipe = before.hasSecret ? openSecretPipe() : null;
  const fail = (errorClass, note) => {
    const text = redact(note);
    const after = finalizeRecord(file, { status: "failed", errorClass, note: text });
    appendLog(log, `finish ${id}: ${after?.status}${after?.errorClass ? `/${after.errorClass}` : ""} (${text})`);
    return 1;
  };
  const failClass = (error) => (ERROR_CLASSES.includes(error?.errorClass) ? error.errorClass : "launch");
  try {
    const current = readRecord(file);
    const record = current?.status === "running" ? updateRunning(file, { runnerPid: process.pid, runnerStartedAt: ownStart() }) : null;
    if (!record) {
      // Cancelled (or otherwise finished) before this runner started: nothing to run, but the reservation it was
      // handed is still released below.
      appendLog(log, `runner pid ${process.pid}: job ${id} is ${readRecord(file)?.status} already; nothing started`);
      return 0;
    }
    if (token !== "-" && (!lock || !(await holdReservation()))) return fail("launch", "workspace reservation was lost before the runner started");
    const adapter = adapters[record.harness];
    if (!adapter) return fail("launch", `no adapter for harness ${record.harness}`);
    let secret = null;
    if (record.hasSecret) {
      try {
        secret = await receiveSecret(secretPipe, () => isTerminalNow(file));
      } catch (error) {
        return fail("auth", error.message);
      }
      redact = redactor([secret]);
    }
    const profile = isObject(record.profileConfig) ? record.profileConfig : {};
    // ctx.exec's commands (discover, the help check, finalize's export) stop once the job is claimed terminal, and
    // their groups are the job's (its ownership log).
    const ctx = makeCtx({ env, profile, profileName: record.profile, stopFile: terminalFile(file), owner: file, ...ctxOverrides });
    let harness;
    try {
      harness = await discoverHarness(adapter, ctx);
    } catch (error) {
      return fail(failClass(error), error?.message ?? String(error));
    }
    if (harness) updateRunning(file, { harnessVersion: typeof harness.version === "string" ? redact(harness.version) : null });
    const req = requestOf(record, profile, harness, jobsDir);
    let plan;
    let run;
    try {
      plan = await planInvocation(adapter, req, ctx);
      run = materialize(plan, { profile, secret, redact, env });
      await beforeLaunch(adapter, req, ctx, plan, run, redact);
    } catch (error) {
      return fail(failClass(error), `adapter ${adapter.id}: ${error?.message ?? error}`);
    }
    const startMeta = cleanMeta(plan.meta, redact);
    if (startMeta) updateRunning(file, { meta: startMeta });
    if (isTerminalNow(file)) return 0; // cancelled while preparing
    const ladder = normalizeLadder(record.cancelLadder);
    appendLog(log, `start ${id}: ${redact(run.argv.map((arg) => JSON.stringify(arg)).join(" "))}`);
    appendLog(log, describeEnv(run.env, env, plan.secretEnv));
    const claim = terminalFile(file);
    const stopLabel = () => (readRecord(file)?.status === "cancelled" ? "cancel" : "stop");
    const result = await runCli({
      argv: run.argv,
      cwd: plan.cwd,
      env: run.env,
      stdinPath: plan.stdinPath,
      timeoutMs: record.timeoutMin * 60_000,
      logPath: log,
      redact,
      ladder,
      exclude: [process.pid],
      onGroups: (groups) => recordGroups(file, groups, "runner"),
      onSpawn: (pid, { startedAt }) => {
        // First the claim file, which a terminal claim does not freeze: if this runner dies from here on, cancel and
        // the reaper still find the harness by its verified identity.
        updateRunnerFile(file, { childPid: pid, childStartedAt: startedAt });
        if (updateRunning(file, { childPid: pid, childStartedAt: startedAt })) return null;
        return stopLabel(); // claimed terminal (cancelled) before the harness started
      },
      // The runner owns the stop (spec §3.6 А8): a terminal claim while the harness runs starts the ladder here, also
      // when the claimer never saw childPid (a cancel racing onSpawn) or died part-way.
      shouldStop: () => (fs.existsSync(claim) ? stopLabel() : null),
    });
    teardown = result.teardown;
    const io = { ...harnessIo(result), cancelled: readRecord(file)?.status === "cancelled" };
    // spec §3.5: a harness can keep what it saw in files of its own (pi's session transcript), beyond the stream
    // redaction. On every path — completed, failed, timed out, cancelled — the adapter's scrub() returns those files
    // with the job's redactor applied, and the core writes them back before the record turns terminal (a cancelled one
    // already is): under the data root, atomically, each with the mode the adapter gives. Where those files are comes
    // from the plan (job.planMeta), not from the record the harness could rewrite meanwhile.
    if (typeof adapter.scrub === "function" && secret !== null) {
      try {
        const files = await adapter.scrub({ ...req.job, record: readRecord(file), io, planMeta: plan.meta }, { ...ctx, redact });
        writeAdapterFiles({ files: Array.isArray(files) ? files : [] }, env);
      } catch (error) {
        appendLog(log, `scrub() failed: ${redact(error?.message ?? error)}`);
      }
    }
    let reduced = null;
    if (!io.spawnError) {
      try {
        reduced = await adapter.reduce(io);
      } catch (error) {
        appendLog(log, `reduce() failed: ${redact(error?.message ?? error)}`);
      }
      if (typeof adapter.finalize === "function" && !io.cancelled && !io.timedOut) {
        // A second harness process (opencode export <sid>, spec §3.6 А9) sees what the harness saw — its environment
        // without the key, behind the same wrap — not the caller's.
        const harnessEnv = Object.fromEntries(Object.entries(run.env).filter(([name]) => !plan.secretEnv.includes(name)));
        const wrap = [...(profile.wrap ?? [])];
        const bin = [...wrap, plan.argv[0]];
        const execHarness = (args = [], options = {}) => ctx.exec(bin[0], [...bin.slice(1), ...args], { cwd: plan.cwd, env: harnessEnv, ...options });
        try {
          const extra = await adapter.finalize({ ...req.job, record: readRecord(file), io, reduced, env: harnessEnv, wrap, harness, planMeta: plan.meta }, { ...ctx, execHarness });
          if (isObject(extra)) {
            const meta = { ...(isObject(reduced?.meta) ? reduced.meta : {}), ...(isObject(extra.meta) ? extra.meta : {}) };
            reduced = { ...(reduced ?? {}), ...extra, meta };
          }
        } catch (error) {
          appendLog(log, `finalize() failed: ${redact(error?.message ?? error)}`);
        }
      }
    }
    const verdict = classifyOutcome({ io, reduced, patterns: adapter.patterns });
    const patch = { status: verdict.status, errorClass: verdict.errorClass, exitCode: result.exitCode, signal: result.signal };
    const meta = cleanMeta({ ...(plan.meta ?? {}), ...(isObject(reduced?.meta) ? reduced.meta : {}) }, redact);
    if (meta) patch.meta = meta;
    if (reduced) {
      if (typeof reduced.sessionId === "string" && reduced.sessionId) patch.sessionId = reduced.sessionId;
      patch.usage = isObject(reduced.usage) ? JSON.parse(redact(JSON.stringify(reduced.usage))) : null;
      patch.reportedModel = typeof reduced.reportedModel === "string" ? redact(reduced.reportedModel) : null;
      if (verdict.status === "completed") patch.response = redact(reduced.response);
      if (reduced.errorText) patch.errorText = redact(String(reduced.errorText)).slice(0, 4000);
    }
    if (verdict.status === "failed") {
      const reason = result.spawnError ? `spawn error ${result.spawnError.code ?? result.spawnError.message}` : `exit=${result.exitCode} signal=${result.signal} timedOut=${result.timedOut}`;
      appendLog(log, `classified failed/${verdict.errorClass} (${redact(reason)})${patch.errorText ? `: ${patch.errorText}` : ""}`);
    }
    const final = finalizeRecord(file, patch);
    appendLog(log, `finish ${id}: ${final?.status}${final?.errorClass ? `/${final.errorClass}` : ""}`);
    return 0;
  } catch (error) {
    // Unexpected: the record must not stay running, and the message must not carry the key.
    return fail("crash", `runner error: ${error?.message ?? error}`);
  } finally {
    secretPipe?.destroy();
    dropSecret(jobsDir, id);
    // The cleanup is done only when the harness's teardown reported neither a survivor nor an error and nothing the
    // ownership log names is left (a group just SIGKILLed gets a moment to be reaped). Then the reservation goes and
    // the marker is written; otherwise both stay, whatever the verdict, and the reaper (once this runner is gone), a
    // repeated cancel or release-stale finish the cleanup by verified identities.
    const failed = teardown && (teardown.error || teardown.survivors.length > 0);
    const left = failed ? [] : await settledSurvivors(jobsDir, id);
    if (!failed && left.length === 0) {
      if (lock && (await holdReservation())) releaseReservation(lock, token);
      markCleaned(file);
    } else {
      const why = !failed
        ? `process groups ${left.map((group) => group.pgid).join(",")} may still be the job's`
        : teardown.error
          ? `the stop of the harness tree failed (${redact(teardown.error)})`
          : `process groups ${teardown.survivors.join(",")} survived the teardown`;
      appendLog(log, `cleanup pending: ${why}${lock ? "; the workspace reservation stays held" : ""}`);
    }
  }
}

// What survivingGroups() still finds of a job once it has had up to SETTLE_MS to clear: a group whose members were
// just SIGKILLed is alive until they are reaped.
async function settledSurvivors(jobsDir, id) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const record = readRecord(jobFile(jobsDir, id));
    const left = record ? survivingGroups(jobsDir, record) : [];
    if (left.length === 0 || Date.now() >= deadline) return left;
    await sleep(POLL_MS);
  }
}

// ---------- the probe (doctor --probe) ----------

// One foreground probe (spec §3.3, §4.3): discover, the adapter's probe() (or invocation()) for a read-only
// PROBE_PROMPT turn, the key, one harness run under the profile's timeout and ladder, reduce() and the verdict — the
// same plumbing as a job, without a record, a reservation or a log file. The prompt and the adapter's files live in a
// private scratch dir under <data root>/probe, removed afterwards; the harness runs there unless `cwd` is given.
// Returns the redacted outcome { status, errorClass, response, sessionId, reportedModel, usage, errorText, harness,
// exitCode, signal, stderrTail }; the CLI judges the answer (PONG) and prints the doctor lines.
// The harness leads a session of its own (runCli), so a Ctrl-C or a closed terminal never reaches it, and no record
// or ownership log names it: while the probe runs, SIGINT / SIGTERM / SIGHUP to this process kill the harness tree
// (once its start time confirms it is still ours), remove the scratch dir and exit with 128 + the signal number.
export async function runProbe({
  adapter,
  profileName,
  profile = {},
  resolveSecret = null,
  cwd = null,
  env = process.env,
  timeoutMs = PROBE_TIMEOUT_MS,
  prompt = PROBE_PROMPT,
  ctx: ctxOverrides = {},
}) {
  validateAdapter(adapter);
  if (!PROFILE_NAME_RE.test(profileName ?? "")) throw new UsageError(`invalid profile name ${JSON.stringify(profileName)} (expected ${PROFILE_NAME_RE})`);
  if (!isObject(profile)) throw new UsageError(`profile ${profileName} is not an object`);
  const redact = redactor();
  const base = path.join(stateRoot(env), "probe");
  ensurePrivateDir(base);
  const dir = fs.mkdtempSync(path.join(base, `${profileName}-`));
  let harnessPid = null;
  let harnessStart = null;
  const onSignal = (signal) => {
    try {
      if (harnessPid && harnessGroupState(harnessPid, harnessStart) === "ours") killTreeSync(harnessPid, "SIGKILL");
    } catch {
      // the exit goes on
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  };
  for (const signal of PROBE_SIGNALS) process.on(signal, onSignal);
  try {
    const ctx = makeCtx({ env, profile, profileName, ...ctxOverrides });
    const promptPath = path.join(dir, "prompt.md");
    writePrivateFile(promptPath, prompt);
    const base = jobLessRequest({
      profile,
      profileName,
      dir,
      cwd: cwd ? path.resolve(cwd) : dir,
      promptPath,
      promptBytes: Buffer.byteLength(prompt),
      harness: null,
      sessionId: adapter.manifest?.sessionId === "preassign" ? randomUUID() : null,
    });
    // The key before discovery, as a job's runner has it (spec §3.5): discover() and the help check run commands
    // whose diagnostics end up in errors, and the redactor must know the key by then. A job-less plan says whether the
    // adapter asks for one: invocation() with req.harness null, exactly as startJob calls it (the contract), not
    // probe(), which has only ever been called with the harness known. A plan the adapter rejects ends the probe here,
    // as it refuses a task (exit 2): without it there is no key to redact discovery's diagnostics with. A profile.env
    // clash is refused before the key source is read.
    let draft;
    try {
      draft = await planInvocation(adapter, base, ctx);
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(`profile ${profileName}: ${error?.message ?? error}`);
    }
    const clash = envConflicts(profile.env, draft);
    if (clash.length > 0) throw new Error(`profile env ${clash.join(", ")} conflicts with a mandatory setting`);
    let secret = null;
    const ensureKey = async (names) => {
      if (secret !== null || names.length === 0) return;
      secret = await resolveKey(resolveSecret, profileName, names);
      redact.add(secret);
    };
    await ensureKey(draft.secretEnv);
    const harness = await discoverHarness(adapter, ctx);
    const req = { ...base, harness };
    const plan = await planInvocation(adapter, req, ctx, { probe: true });
    await ensureKey(plan.secretEnv);
    const run = materialize(plan, { profile, secret, redact, env });
    await beforeLaunch(adapter, req, ctx, plan, run, redact);
    const timeoutMin = positiveNumber(profile.timeoutMin, DEFAULT_TIMEOUT_MIN, `profile ${profileName}: timeoutMin`);
    const result = await runCli({
      argv: run.argv,
      cwd: plan.cwd,
      env: run.env,
      stdinPath: plan.stdinPath,
      timeoutMs: Math.min(timeoutMs, timeoutMin * 60_000),
      redact,
      ladder: normalizeLadder(adapter.manifest?.cancel?.ladder),
      onSpawn: (pid, { startedAt }) => {
        harnessPid = pid;
        harnessStart = startedAt;
        return null; // a label would start the ladder at once
      },
    });
    const io = { ...harnessIo(result), cancelled: false };
    let reduced = null;
    if (!io.spawnError) {
      try {
        reduced = await adapter.reduce(io);
      } catch {
        reduced = null; // classified below as malformed or crash
      }
    }
    const verdict = classifyOutcome({ io, reduced, patterns: adapter.patterns });
    const text = (value) => (typeof value === "string" ? redact(value) : null);
    return {
      status: verdict.status,
      errorClass: verdict.errorClass,
      response: verdict.status === "completed" ? text(reduced.response) : null,
      sessionId: text(reduced?.sessionId),
      reportedModel: text(reduced?.reportedModel),
      usage: isObject(reduced?.usage) ? JSON.parse(redact(JSON.stringify(reduced.usage))) : null,
      errorText: reduced?.errorText ? redact(String(reduced.errorText)).slice(0, 4000) : null,
      harness: harness ? { bin: redact(harness.bin), version: text(harness.version) } : null,
      exitCode: result.exitCode,
      signal: result.signal,
      stderrTail: result.stderrTail,
    };
  } catch (error) {
    throw redactError(error, redact);
  } finally {
    for (const signal of PROBE_SIGNALS) process.off(signal, onSignal);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- status / result / cancel / release-stale (core jobs) ----------

export function statusLine(record) {
  const end = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();
  const secs = Math.max(0, Math.round((end - Date.parse(record.startedAt)) / 1000));
  const state = record.status === "failed" ? `failed/${record.errorClass}` : record.status;
  const elapsed = `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
  return [record.id, record.profile ?? "-", state, elapsed, record.model ?? "-", record.sessionId ?? "-", ...(record.resumeOf ? [`resumeOf=${record.resumeOf}`] : [])].join(" ");
}

// One entry of the `status` list (spec §3.3); summaryLine formats it — also for zt- / task- entries the CLI adds.
export const jobSummary = (record) => ({
  id: record.id,
  profile: record.profile ?? null,
  role: record.role ?? null,
  status: record.status,
  errorClass: record.errorClass ?? null,
  write: record.write === true,
  cwd: record.workspaceRoot ?? null,
});
export const summaryLine = (summary) => `${summary.id} ${summary.profile ?? "-"} ${summary.status} write=${summary.write ? "yes" : "no"} cwd=${summary.cwd ?? "-"}`;

// Running jobs plus the 10 newest terminal ones (all with `all`), newest first.
export function listJobSummaries(cwd, { all = false, env = process.env } = {}) {
  const ws = requireWorkspace(cwd, env);
  reapDeadRunners(ws.jobsDir);
  const records = listRecords(ws.jobsDir);
  const running = records.filter((record) => record.status === "running");
  const terminal = records.filter((record) => record.status !== "running");
  return [...running, ...(all ? terminal : terminal.slice(0, 10))].map(jobSummary);
}

export function statusCommand({ cwd, id = null, json = false, all = false, env = process.env } = {}, out = defaultOut) {
  if (id) {
    const ws = requireWorkspace(cwd, env);
    reapDeadRunners(ws.jobsDir);
    const record = requireJob(ws.jobsDir, id);
    out.stdout(json ? `${JSON.stringify({ job: record }, null, 2)}\n` : `${statusLine(record)}\n`);
    return 0;
  }
  const jobs = listJobSummaries(cwd, { all, env });
  if (json) out.stdout(`${JSON.stringify({ jobs }, null, 2)}\n`);
  else for (const summary of jobs) out.stdout(`${summaryLine(summary)}\n`);
  return 0;
}

export function resultCommand({ cwd, id, env = process.env } = {}, out = defaultOut) {
  const ws = requireWorkspace(cwd, env);
  reapDeadRunners(ws.jobsDir);
  const record = requireJob(ws.jobsDir, id);
  if (record.status === "completed") {
    const text = record.response ?? "";
    out.stdout(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  }
  out.stderr(`job ${record.id} is ${record.status} errorClass=${record.errorClass}\n${tailLines(logFile(ws.jobsDir, record.id), 20)}`);
  return 1;
}

export async function cancelCommand({ cwd, id, env = process.env } = {}, out = defaultOut) {
  const ws = requireWorkspace(cwd, env);
  // Finalizes a job from an earlier boot, so its pids are never signalled below. A pending cleanup of the job being
  // cancelled is left to this command, which stops it with the adapter's ladder rather than the reaper's SIGKILL.
  reapDeadRunners(ws.jobsDir, { except: isCoreJobId(id) ? id : null });
  const record = requireJob(ws.jobsDir, id);
  const file = jobFile(ws.jobsDir, record.id);
  const log = logFile(ws.jobsDir, record.id);
  // The cancelled record is written first, so the runner finishing meanwhile cannot overwrite it: the job is
  // cancelled by the dispatcher's own record, whatever the harness exits with (spec §3.6 А8).
  const after = record.status === "running" ? finalizeRecord(file, { status: "cancelled", errorClass: null, note: `cancelled by ${CLI_NAME} cancel` }) : record;
  const fresh = record.status === "running" && after?.status === "cancelled";
  // A job that was already terminal keeps its verdict; only a cleanup its claimer left unfinished (the claiming
  // cancel and the runner both interrupted) is resumed.
  if (!fresh && !cleanupPending(ws.jobsDir, after)) {
    out.stdout(`${record.id} is ${after.status}\n`);
    return 0;
  }
  const procs = jobProcesses(ws.jobsDir, after);
  if (bootOf(after.bootId) !== "current") {
    const group = procs.child.pid ?? "-";
    appendLog(log, `cancel: ${fresh ? "record set to cancelled" : `the job is ${after.status}, cleanup pending`}; harness process group ${group} ${UNKNOWN_BOOT_NOTE}`);
    out.stdout(
      fresh
        ? `cancelled ${record.id} (harness process group ${group} ${UNKNOWN_BOOT_NOTE}; check it with: ps -g ${procs.child.pid ?? "<pgid>"})\n`
        : `${record.id} is ${after.status} (cleanup pending: harness process group ${group} ${UNKNOWN_BOOT_NOTE})\n`,
    );
    return 0;
  }
  // The runner owns the stop: it sees the claim within STOP_POLL_MS, runs the adapter's ladder over the harness tree,
  // releases a write reservation and exits. cancel waits for that (bounded), so the tree is dead and free for the next
  // write task when cancel returns; only a runner that is gone or stuck leaves the stop to cancel itself. A resumed
  // cleanup waits only for what is left of that time since the claim: a runner that had it is stuck or gone.
  const ladder = normalizeLadder(after.cancelLadder);
  appendLog(log, fresh ? `cancel: record set to cancelled; the runner stops the process tree (${ladderText(ladder)})` : `cancel: the job is ${after.status}, but its process tree is not known to be stopped; cleanup resumed`);
  const holders = jobHolders(ws.jobsDir, after);
  const waitMs = stopWaitMs(ladder);
  const claimedAt = fresh ? Date.now() : Date.parse(after.finishedAt);
  const deadline = (Number.isFinite(claimedAt) ? claimedAt : Date.now()) + waitMs;
  while (Date.now() < deadline && holders.some((holder) => possiblyOurs(processIdentity(holder.pid, holder.startedAt)))) await sleep(POLL_MS);
  const { notes, stopped } = await stopJobTree(ws.jobsDir, readRecord(file) ?? after, ladder, log, waitMs);
  const detail = notes.join("; ");
  if (fresh) out.stdout(`cancelled ${record.id}${detail ? ` (${detail})` : ""}\n`);
  else if (stopped || detail) out.stdout(`${record.id} is ${after.status} (cleanup resumed${detail ? `: ${detail}` : ""})\n`);
  else out.stdout(`${record.id} is ${after.status}\n`); // its runner was just finishing: nothing was left to stop
  return 0;
}

// What is left of a job once its runner had its time to stop it: every group of the job (survivingGroups: the
// harness group, the groups of its ownership log) that is provably the job's, and — while the runner itself lives
// (stuck) and is provably the job's — the groups of everything below it (a harness the record does not name yet, an
// auxiliary command), all stopped with the adapter's ladder, the groups a snapshot adds recorded before they are
// signalled. A pid that is foreign or unknown is never signalled, nor searched for descendants. The cleanup is marked
// done once neither the runner, the reservation holder nor any group of the job may be alive — and only for a job that
// has a runner on record: one whose runner has not claimed it yet (parked before runJob, or never to start) gets the
// marker from that runner, which finds the job terminal and starts nothing. Returns { notes, stopped } for cancel's
// line (stopped: a ladder ran).
async function stopJobTree(jobsDir, record, ladder, log, waitMs) {
  const file = jobFile(jobsDir, record.id);
  const procs = jobProcesses(jobsDir, record);
  const runner = processIdentity(procs.runner.pid, procs.runner.startedAt);
  const harness = harnessGroupState(procs.child.pid, procs.child.startedAt);
  const left = survivingGroups(jobsDir, record);
  // The reservation names the runner before the runner's claim does (and the task process before that).
  const waiting = jobHolders(jobsDir, record).filter((holder) => holder.pid !== procs.runner.pid && possiblyOurs(processIdentity(holder.pid, holder.startedAt)));
  const recorded = fs.existsSync(runnerFile(file)) || procs.runner.pid !== null || procs.child.pid !== null;
  const notes = [];
  if (waiting.length > 0) appendLog(log, `cancel: pid ${waiting.map((holder) => holder.pid).join(",")} holds the job's reservation without having claimed the job; a runner that claims it now finds it ${record.status} and starts nothing`);
  if (runner === "foreign") appendLog(log, `cancel: runner pid ${procs.runner.pid} not signalled: the pid now belongs to another process`);
  if (runner === "unknown") notes.push(`runner pid ${procs.runner.pid} ${unconfirmedNote(procs.runner.startedAt)}`);
  if (harness === "foreign") appendLog(log, `cancel: harness process group ${procs.child.pid} ${FOREIGN_NOTE}`);
  if (harness === "unknown") notes.push(`harness process group ${procs.child.pid} ${unconfirmedNote(procs.child.startedAt)}`);
  for (const group of left) if (!group.harness && group.state === "unknown") notes.push(`process group ${group.pgid} ${unconfirmedNote(group.startedAt)}`);
  const ours = left.filter((group) => group.state === "ours").map((group) => group.pgid);
  const roots = [...ours, ...(runner === "ours" ? descendantGroupsOf(procs.runner.pid) : [])];
  let survivors = [];
  if (roots.length > 0) {
    appendLog(log, runner === "ours" ? `cancel: runner pid ${procs.runner.pid} did not finish within ${waitMs} ms; cancel stops the tree itself` : "cancel: the runner is gone; cancel stops the tree itself");
    const stopped = await terminateTree(roots, ladder, {
      exclude: [procs.runner.pid].filter(Number.isInteger),
      log: (line) => appendLog(log, `cancel: ${line}`),
      onGroups: (groups) => recordGroups(file, groups, "cancel"),
    });
    survivors = stopped.survivors;
    if (survivors.length > 0) notes.push(`process groups still alive: ${survivors.join(",")}`);
  }
  for (const note of notes) appendLog(log, `cancel: ${note}`);
  const done = recorded && waiting.length === 0 && !possiblyOurs(runner) && survivors.length === 0 && survivingGroups(jobsDir, record).length === 0;
  if (done) markCleaned(file);
  return { notes, stopped: roots.length > 0 };
}

// The processes cancel waits for, as { pid, startedAt }: the job's runner and, for a write job, the holder of its
// unreleased reservation (the runner itself once it started; the reservation names it before the record does).
function jobHolders(jobsDir, record) {
  const holders = [];
  const { runner } = jobProcesses(jobsDir, record);
  if (runner.pid !== null) holders.push(runner);
  if (record.write === true) {
    const current = currentReservation(jobsDir);
    const held = current?.record;
    if (held?.jobId === record.id && Number.isInteger(held.holderPid) && readJson(`${current.file}.released`)?.token !== held.token) {
      holders.push({ pid: held.holderPid, startedAt: typeof held.holderStartedAt === "string" ? held.holderStartedAt : null });
    }
  }
  return holders;
}

// How long cancel waits for the runner to stop the tree and exit: the poll, the ladder, the re-sweep, the pipe
// drain and a margin.
const stopWaitMs = (ladder) => STOP_POLL_MS + ladder.reduce((sum, [, waitMs]) => sum + waitMs, 0) + SWEEP_ROUNDS * POLL_MS + CLOSE_WAIT_MS + 2_000;

export function releaseStaleCommand({ cwd, env = process.env } = {}, out = defaultOut) {
  const ws = requireWorkspace(cwd, env);
  const current = currentReservation(ws.jobsDir);
  if (!current) throw new UsageError("no workspace reservation to release");

  const { file, generation, record } = current;
  if (!record || !Number.isInteger(record.holderPid) || record.holderPid <= 0 || typeof record.token !== "string") {
    throw new UsageError(`workspace reservation generation ${generation} has no valid holder`);
  }
  if (readJson(`${file}.released`)?.token === record.token) {
    throw new UsageError(`workspace reservation generation ${generation} is already released`);
  }
  // Taken in an earlier boot: its holder and the job's processes are gone whatever their pids show now. Otherwise
  // the reservation stays while any process of the job may still be alive: a holder, runner or process group (the
  // harness's, or one of the job's ownership log) that is provably the job's, or whose identity cannot be read
  // (unknown) — only gone or provably reused pids release it. A job with its cleanup marker has none left: what holds
  // its old pids now is not its.
  const rebooted = bootOf(record.bootId) === "earlier";
  const holder = rebooted ? "gone" : processIdentity(record.holderPid, record.holderStartedAt);
  if (possiblyOurs(holder)) {
    const why = typeof record.holderStartedAt === "string" && record.holderStartedAt ? "its start time cannot be read" : "no start time was recorded for it";
    const unconfirmed = holder === "unknown" ? ` (${why} to confirm whether it is still the job's runner)` : "";
    throw new UsageError(`workspace reservation generation ${generation} is held by live runner pid ${record.holderPid}${unconfirmed}`);
  }

  const job = isCoreJobId(record.jobId) ? readRecord(jobFile(ws.jobsDir, record.jobId)) : null;
  const jobRebooted = rebooted || (job !== null && bootOf(job.bootId) === "earlier");
  if (!jobRebooted && job && !fs.existsSync(cleanedFile(jobFile(ws.jobsDir, job.id)))) {
    const procs = jobProcesses(ws.jobsDir, job);
    const runner = procs.runner.pid !== null && procs.runner.pid !== record.holderPid ? processIdentity(procs.runner.pid, procs.runner.startedAt) : "gone";
    if (possiblyOurs(runner)) {
      throw new UsageError(`workspace reservation generation ${generation}: job ${job.id} still has live runner pid ${procs.runner.pid}`);
    }
    const left = survivingGroups(ws.jobsDir, job);
    const group = left.find((candidate) => candidate.state === "ours") ?? left[0];
    if (group) {
      const what = group.harness ? `harness process group ${group.pgid}` : `process group ${group.pgid} of job ${job.id}`;
      if (group.state === "ours") throw new UsageError(`workspace reservation generation ${generation} still has live ${what}`);
      const why = group.startedAt ? "its start time cannot be read" : "no start time was recorded for it";
      throw new UsageError(`workspace reservation generation ${generation} still has ${what} alive, unconfirmed (${why}); not released`);
    }
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
  if (job) markCleaned(jobFile(ws.jobsDir, record.jobId)); // nothing of the job may be alive (checked above)
  if (!createReservation(`${file}.released`, { holderPid: process.pid, token: record.token })) {
    throw new UsageError(`workspace reservation generation ${generation} is already released`);
  }
  out.stdout(`released ${ws.root} generation ${generation}\n`);
  return 0;
}
