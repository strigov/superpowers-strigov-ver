// adapters/dsh.mjs — the core adapter of the `dsh` harness (DeepSeek Harness, npm @deepseek-ai/dsh 0.2.x) on
// agent-dispatch's job core (agent-core.mjs, spec §3.2): one headless run per job, NDJSON events on stdout
// (docs/superpowers/specs/2026-10-20-universal-dispatchers-design.md §2, §3.4–§3.8; the facts:
// docs/research/universal-dispatchers/04b-deepseek-harness.md, cited below as [04b §n]).
//
// The command (spec §2):
//   dsh --profile headless --patch <job>/dsh.patch.yml --json [--session-id <id>] - < prompt
// - Launcher flags (--profile, --patch) come first; the first token the launcher does not know starts the app args
//   (--json, --session-id, then "-": the task on stdin, never argv) [04b §2].
// - Model, effort and endpoint have no flags: they go into the patch file, built whole, because a patch row replaces
//   the row's whole config [04b §2, §15 item 8]. Pinned rows (spec §3.6 A5): agent-default-model {provider, model,
//   reasoningEffort} and llm-deepseek {apiKeyEnv: DEEPSEEK_API_KEY, baseURL, reasoningEffort} — baseURL always set
//   explicitly (endpoint, else DeepSeek's), so a repo .env with DEEPSEEK_BASE_URL cannot take the key elsewhere
//   [04b §6 risk 1]. Defaults (spec §3.6 Б): session-log upload and plugin inventory off, no title LLM call.
//   options.patch merges into those rows; it cannot move apiKeyEnv or baseURL, nor disable a pinned row, nor touch the
//   rows that carry the permission mode (A4) or switch off the project instructions (A6).
// - Permissions (spec §3.6 A4): writer DSH_PERMISSION_MODE=danger-full-access, with "sandbox": "native"
//   workspace-write; a reviewer always read-only (headless has no approval answerer: an ask is a denial [04b §7]).
//   beforeLaunch verifies the effective offline dump before every bounded run, including resumes and probes: a home
//   patch can override the bundle's environment-driven rows. A failed or ambiguous check never starts a model turn.
// - Key: auth key / keyEnv / keyCmd → DEEPSEEK_API_KEY in the environment only. auth "native" sets nothing: dsh reads
//   the inherited env, then <cwd>/.env, then $DSH_HOME/.env [04b §6].
// - Home: "user" (the default) is $DSH_HOME or ~/.dsh, the caller's DSH_HOME passes through; "isolated" is
//   <data>/homes/<profile>/dsh. DSH_AGENTS_HOME points at the empty agents-empty/ unless options.agentsHome is "user"
//   (~/.agents is shared with other tools [04b §9]); DSH_TELEMETRY_DISABLED=1 (Б, overridable in profile.env).
// - The session id comes only from the first `session` event; resume needs the same cwd and the same DSH_HOME
//   [04b §4]. The exit code is informational: 0 also on SIGTERM, 1 for every failed turn [04b §3, §10].
// - A lost session (spec §3.6 А12) is read from structure, not wording: a resumed run that exits 1 before its session
//   event with no known code and no boot-failure report. The core's io does not say whether the job is a resume, so
//   finalize() re-reads a failed resumed job with that bit from its record.
// - Cancel: SIGINT, at least 7 s (dsh bounds its graceful disposal at 5 s), SIGKILL; the core's descendant sweep
//   follows [04b §10]. SIGTERM is never sent: dsh would exit 0 with an aborted turn.
// - Homebrew's `dsh` is Dancer's shell: discover() refuses it (launch) before anything runs [04b §1, §15 item 16].
//
// Pure data, as the contract asks: processes and files only through ctx.exec / ctx.fs; doctorChecks() writes its
// patch template only through ctx.writeFiles when the CLI provides it.

import os from "node:os";
import path from "node:path";
import { buildEnv, parseEvents } from "../agent-core.mjs";

// The version the facts were read from (dsh itself was not run, [04b] fact-check log); doctor names any other one.
export const VERIFIED_VERSIONS = ["0.2.1-rc.2"];
export const INSTALL_HINT = "npm i -g @deepseek-ai/dsh@0.2.1-rc.2 (Node ^22.19 or >=24; not Homebrew's dsh)";
export const KEY_VAR = "DEEPSEEK_API_KEY";
export const PROVIDER = "deepseek-official";
export const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";
// dsh's own defaults [04b §5]; written into the patch explicitly, so dsh's base rows never decide.
export const DEFAULT_MODEL = "deepseek-flash";
export const DEFAULT_EFFORT = "high";
export const EFFORTS = ["off", "low", "high", "max"];
export const PATCH_FILE = "dsh.patch.yml";
export const PINNED_ROWS = ["agent-default-model", "llm-deepseek"];
// The ladder of [04b §10]: SIGINT, ≥ 7 s, SIGKILL.
export const CANCEL_LADDER = [["SIGINT", 7000], ["SIGKILL", 0]];
// dsh session ids are opaque (`session-<uuid>` by default [04b §4]); this keeps one from passing for a flag.
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ROW_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const PATCH_HEADER = "# Written by agent-dispatch (bin/lib/adapters/dsh.mjs). Each row replaces that row's whole config; apiKeyEnv and baseURL are pinned.";

// dsh codes → error classes (spec §3.8, [04b §11]).
export const CODE_CLASS = {
  AUTH: "auth", MISSING_CREDENTIAL: "auth", INVALID_CREDENTIAL: "auth", ACCOUNT_SIGN_IN_REQUIRED: "auth", ACCOUNT_TOKEN_INVALID: "auth",
  QUOTA: "quota", ACCOUNT_QUOTA: "quota",
  RATE_LIMIT: "rate-limit",
  TRANSPORT: "server", SERVER: "server", TIMEOUT: "server", EMPTY_RESPONSE: "server", MALFORMED_RESPONSE: "server", STREAM_CLOSED: "server",
  INVALID_REQUEST: "model-not-selected", MODEL_UNSUPPORTED: "model-not-selected", UNSUPPORTED_REASONING_EFFORT: "model-not-selected",
  UNKNOWN_MODEL: "model-not-selected", CLIENT_UPGRADE_REQUIRED: "model-not-selected",
  CONTEXT_WINDOW_EXCEEDED: "context",
  SANDBOX_UNAVAILABLE: "launch",
};
// The stderr line of a failure: `dsh: <CODE>: <message>` [04b §3]; reduce() also gets "<CODE>: <message>" back.
const CODE_LINE_RE = /^dsh: ([A-Z][A-Z0-9_]*): ?(.*)$/;
// A required plugin that failed to activate: a report, then this line, exit 1 before any session event [04b §3, §11].
const BOOT_FAILURE_RE = /^Full diagnostics: /m;
// Unverified wording of the refusal of proxy variables from a project .env [04b §6 risk 1, §15 item 4].
const PROXY_REFUSAL_RE = /\bproxy\b[^\n]*\.env\b|\.env\b[^\n]*\bproxy\b/i;
// Unverified: the text dsh prints for an unknown or foreign --session-id ([04b §4] says only that it is an error). Only
// a secondary hint, for a resumed run that did print its session event; matched against the JSON error message and
// the `dsh: <CODE>:` message, never the whole stderr (plugin names such as session-log-deepseek would match).
export const LOST_SESSION_RE = /\b(?:cannot|could not|unable to|failed to) (?:resume|adopt|load|find) (?:the )?session\b|\b(?:unknown|no such) session\b|\bsession\b[^\n]{0,80}\b(?:not found|does not exist)\b/i;
// Row ids whose rows carry the permission mode (`sandbox/mode`, `approval/policy`, `sandbox-policy.workspaceRoot`
// [04b §2, §7, §8]): options.patch must not touch them (spec §3.6 A4). The exact row ids are unverified — matched by
// name, here and in doctor, which grades those rows of its --dump-config (permissionRows).
const PERMISSION_ROW_RE = /sandbox|approval|permission/;
// A mode or approval-policy literal in such a row [04b §7]; `ask` goes with every mode but danger-full-access, so it
// says nothing. Not part of a path or a longer word.
const MODE_LITERAL_RE = /(?<![\w./-])(read-only|workspace-write|danger-full-access|never)(?![\w./-])/g;
// What doctor grades: the `mode` / `policy` key of a sandbox or approval row (`sandbox-policy.mode`,
// `approval-policy.policy` [04b §7]). A literal anywhere else — a permission-presets row [04b §7], another key — is a
// shape the dump was not seen in (its format is unverified), so it is reported as not verified, never graded.
const GRADED_ROW_RE = /sandbox|approval/;
const GRADED_LITERAL_RE = /(?<![\w-])["']?(?:mode|policy)["']?\s*:\s*["']?(read-only|workspace-write|danger-full-access|never)(?![\w./-])/g;
// The layers of $DSH_HOME that outrank the bundle's rows, in dsh's order (the home layer outranks the profile's) [04b §2].
const HOME_LAYERS = [["profiles", "headless", "cordis.patch.yml"], ["cordis.patch.yml"]];
// The row that loads AGENTS.md / CLAUDE.md [04b §9]: it must not be disabled (spec §3.6 A6).
const INSTRUCTIONS_ROW = "agent-instructions";

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keyed = (profile) => isObject(profile?.auth) && ["key", "keyEnv", "keyCmd"].some((source) => source in profile.auth);
const isolated = (profile) => profile?.home === "isolated";
const binOf = (req) => req.harness?.bin ?? req.profile?.bin ?? "dsh";
const firstLine = (text) => String(text ?? "").trim().split("\n")[0].trim();
const launchError = (message) => Object.assign(new Error(message), { errorClass: "launch" });
const codeLine = (codes) => new RegExp(`^(?:dsh: )?(?:${codes.join("|")}):`, "m");
const codesOf = (cls) => Object.keys(CODE_CLASS).filter((code) => CODE_CLASS[code] === cls);

export const permissionMode = (profile, write) => (write ? (profile?.sandbox === "native" ? "workspace-write" : "danger-full-access") : "read-only");

// Where dsh keeps this profile's sessions, profiles and .env: the isolated home, else the DSH_HOME the harness gets
// (profile.env, then the caller's), else ~/.dsh [04b §9].
export function dshHomeOf(profile, ctx) {
  if (isolated(profile)) return path.join(ctx.paths.homes, ctx.profileName ?? "-", "dsh");
  const env = isObject(profile?.env) ? profile.env : {};
  if (typeof env.DSH_HOME === "string" && env.DSH_HOME) return env.DSH_HOME;
  if (env.DSH_HOME === undefined && ctx.env?.DSH_HOME) return ctx.env.DSH_HOME;
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : (ctx.env?.HOME ?? os.homedir());
  return path.join(home, ".dsh");
}

export const baseUrlOf = (profile) => profile?.endpoint ?? DEFAULT_BASE_URL;

// options.patch (spec §3.4, §3.6 Б with the limits of A4–A6): { "<row id>": { config?: {…}, disabled?: boolean } }.
// Throws a plain Error naming the problem: startJob turns it into exit 2, doctor into a FAIL.
function checkedPatch(patch, baseURL) {
  if (patch === undefined || patch === null) return {};
  if (!isObject(patch)) throw new Error("options.patch must be an object of patch rows by row id");
  for (const [id, row] of Object.entries(patch)) {
    if (!ROW_ID_RE.test(id)) throw new Error(`options.patch: invalid row id ${JSON.stringify(id)} (expected ${ROW_ID_RE})`);
    const at = `options.patch.${id}`;
    if (!isObject(row) || Object.keys(row).length === 0) throw new Error(`${at}: a row is { "config": {…} } and/or { "disabled": true|false }`);
    const extra = Object.keys(row).filter((key) => key !== "config" && key !== "disabled");
    if (extra.length > 0) throw new Error(`${at}: a row is { "config": {…} } and/or { "disabled": true|false }, not ${extra.map((key) => JSON.stringify(key)).join(", ")}`);
    if ("config" in row && !isObject(row.config)) throw new Error(`${at}.config must be an object`);
    if ("disabled" in row && typeof row.disabled !== "boolean") throw new Error(`${at}.disabled must be true or false`);
    if (PINNED_ROWS.includes(id) && "disabled" in row) throw new Error(`${at}: "disabled" is not allowed on the pinned row ${id}`);
    if (PERMISSION_ROW_RE.test(id)) {
      throw new Error(`${at}: rows of the sandbox / approval / permission mode are the adapter's (writer danger-full-access or, with "sandbox": "native", workspace-write; reviewer read-only); use "sandbox" instead`);
    }
    if (id === INSTRUCTIONS_ROW && row.disabled === true) throw new Error(`${at}: the project's AGENTS.md / CLAUDE.md must reach the model; ${id} cannot be disabled`);
  }
  const llm = patch["llm-deepseek"]?.config ?? {};
  if ("apiKeyEnv" in llm && llm.apiKeyEnv !== KEY_VAR) {
    throw new Error(`options.patch.llm-deepseek.config.apiKeyEnv is pinned to ${KEY_VAR}: the key reaches dsh only there`);
  }
  if ("baseURL" in llm && llm.baseURL !== baseURL) {
    throw new Error(`options.patch.llm-deepseek.config.baseURL is pinned to ${baseURL}; set the profile's "endpoint" instead`);
  }
  return patch;
}

// The rows of the patch file for a profile, in file order: the pinned rows, the defaults, then options.patch's other
// rows. Effort goes into both pinned rows: which one wins in headless is unverified [04b open question 3], so doctor
// checks the value of each against dsh's vocabulary (dsh-effort); --dump-config only shows that dsh accepts the file.
export function patchRows(profile) {
  const baseURL = baseUrlOf(profile);
  const effort = profile?.effort ?? DEFAULT_EFFORT;
  const rows = [
    { id: "agent-default-model", config: { provider: PROVIDER, model: profile?.model ?? DEFAULT_MODEL, reasoningEffort: effort } },
    { id: "llm-deepseek", config: { apiKeyEnv: KEY_VAR, baseURL, reasoningEffort: effort } },
    ...(profile?.options?.sessionLog === true ? [] : [{ id: "session-log-deepseek", config: { enabled: false } }]),
    { id: "plugin-package-inventory-deepseek", config: { enabled: false } },
    { id: "session-title-llm", disabled: true },
  ];
  for (const [id, row] of Object.entries(checkedPatch(profile?.options?.patch, baseURL))) {
    let target = rows.find((entry) => entry.id === id);
    if (!target) {
      target = { id };
      rows.push(target);
    }
    if (row.config) target.config = { ...(target.config ?? {}), ...structuredClone(row.config) };
    if ("disabled" in row) target.disabled = row.disabled;
  }
  // The pinned fields last, whatever the merge did.
  Object.assign(rows[1].config, { apiKeyEnv: KEY_VAR, baseURL });
  return rows;
}

// A JSON value as a YAML flow node: JSON is valid YAML, written with ": " and ", " like the examples of [04b §5].
function flow(value) {
  if (Array.isArray(value)) return `[${value.map(flow).join(", ")}]`;
  if (isObject(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${flow(item)}`).join(", ")}}`;
  return JSON.stringify(value ?? null);
}

export function renderPatch(rows) {
  const lines = [PATCH_HEADER];
  for (const row of rows) {
    lines.push(`- id: ${JSON.stringify(row.id)}`);
    if (row.config) lines.push(`  config: ${flow(row.config)}`);
    if ("disabled" in row) lines.push(`  disabled: ${row.disabled === true}`);
  }
  return `${lines.join("\n")}\n`;
}

// Whether a `--version` text is DeepSeek Harness. Its exact format is unverified ([04b] never ran dsh): any text with a
// semver passes, except Dancer's shell — by name, or by its own 0.25.x line without "deepseek" in the text (Homebrew's
// dsh is 0.25.10 [04b §1]). Any other version is no refusal: an unverified one is only doctor's WARN (spec §3.2).
export function identify(text) {
  const all = String(text ?? "");
  if (/dancer|distributed shell/i.test(all)) return { ok: false, version: null, reason: "this is Dancer's shell (Homebrew's dsh)" };
  const version = SEMVER_RE.exec(all)?.[0] ?? null;
  if (!version) return { ok: false, version: null, reason: `\`--version\` printed no version (${firstLine(all) || "nothing"})` };
  if (/^0\.25\.\d+$/.test(version) && !/deepseek/i.test(all)) {
    return { ok: false, version, reason: `version ${version} is Dancer's shell's line (Homebrew's dsh 0.25.x)` };
  }
  return { ok: true, version, reason: null };
}

export function classOfCode(code) {
  if (typeof code !== "string") return null;
  if (Object.hasOwn(CODE_CLASS, code)) return CODE_CLASS[code];
  const status = /^HTTP_(\d{3})$/.exec(code)?.[1];
  if (!status) return null;
  if (status === "429") return "rate-limit";
  if (status === "401" || status === "403") return "auth";
  if (status === "402") return "quota";
  if (status === "404") return "model-not-selected";
  return status.startsWith("5") ? "server" : null;
}

// The last `dsh: <CODE>: <message>` line of a stderr text, or null.
function lastCodeLine(text) {
  let found = null;
  for (const line of String(text ?? "").split("\n")) {
    const m = CODE_LINE_RE.exec(line.trim());
    if (m) found = { code: m[1], message: m[2] };
  }
  return found;
}

const tailText = (text, n = 4) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join("\n");

const USAGE_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];

// The verdict of a run from its events [04b §3]: success only for a completed turn with a non-empty final text.
// io.resumed (true for a --session-id run) is not part of the core's io (spec §3.2): finalize() supplies it.
export function reduce(io) {
  const events = Array.isArray(io?.events) ? io.events : parseEvents(io?.stdout);
  let sessionId = null;
  let final = null;
  let turnEnd = null;
  let errorEvent = null;
  const sums = {};
  let steps = 0;
  let incomplete = false;
  for (const event of events) {
    if (!isObject(event)) continue;
    if (event.type === "session") {
      if (sessionId === null && typeof event.sessionId === "string" && event.sessionId) sessionId = event.sessionId;
    } else if (event.type === "status" && event.phase === "step_end") {
      steps += 1;
      if (!isObject(event.usage)) incomplete = true; // dsh omits usage when a retried attempt lacked a sample
      for (const field of USAGE_FIELDS) {
        const value = event.usage?.[field];
        if (Number.isFinite(value)) sums[field] = (sums[field] ?? 0) + value;
      }
    } else if (event.type === "status" && event.phase === "turn_end") {
      turnEnd = event;
    } else if (event.type === "final") {
      if (typeof event.text === "string") final = event.text;
    } else if (event.type === "error") {
      errorEvent = event;
    }
  }
  const usage = steps === 0 ? null : { ...Object.fromEntries(USAGE_FIELDS.filter((field) => field in sums).map((field) => [field, sums[field]])), steps, ...(incomplete ? { incomplete: true } : {}) };
  const kind = isObject(turnEnd?.reason) ? turnEnd.reason.kind : null;
  const base = { sessionId, usage, reportedModel: null };
  if (kind === "completed" && typeof final === "string" && final.trim() !== "") {
    return { ok: true, response: final, ...base, errorClass: null, errorText: null };
  }
  const failed = (errorClass, errorText) => ({ ok: false, response: null, ...base, errorClass, errorText: errorText || null });

  // A code from the turn, else from stderr (a boot failure has no turn).
  const turnError = isObject(turnEnd?.reason?.error) ? turnEnd.reason.error : null;
  const stderrCode = lastCodeLine(io?.stderrTail);
  const coded = typeof turnError?.code === "string" && turnError.code ? { code: turnError.code, message: turnError.message ?? "" } : stderrCode;
  const codeText = coded ? `${coded.code}: ${coded.message ?? ""}`.trim() : null;
  const codeClass = coded ? classOfCode(coded.code) : null;
  if (codeClass) return failed(codeClass, codeText);

  const message = typeof errorEvent?.message === "string" ? errorEvent.message : null;
  const turnMessage = typeof turnError?.message === "string" && turnError.message.trim() ? turnError.message.trim() : null;
  const stderr = String(io?.stderrTail ?? "");
  const text = codeText ?? (turnMessage ? `${kind}: ${turnMessage}` : null) ?? message ?? (kind ? `turn ended: ${kind}` : tailText(stderr));
  if (kind === "completed") return failed("malformed", "the turn completed without a final answer");
  if (kind === "max-tokens") return failed("context", text);
  // What ends a turn `blocked` is not in [04b §3] (a denied ask is `unavailable` at the tool [04b §7]): the kind decides.
  if (kind === "blocked") return failed("blocked", text);
  if (kind === "aborted" || kind === "interrupted") return failed(io?.cancelled ? null : "crash", text);

  // No turn ended and dsh exited 1 on its own: the run failed before its turn [04b §3, §11].
  const exit = io?.exit ?? {};
  const early = !turnEnd && !io?.cancelled && !io?.timedOut && !exit.signal && Number.isInteger(exit.code) && exit.code !== 0 && exit.code !== 130;
  if (!early) return failed(null, text);
  const said = message ?? codeText ?? tailText(stderr);
  // The documented boot failures first, resumed or not: a required plugin's report, a refused proxy in the repo .env.
  if (BOOT_FAILURE_RE.test(stderr) || PROXY_REFUSAL_RE.test(stderr)) return failed("launch", said);
  // A resume that fails before its session event, without a known code, lost its session (spec §3.6 А12): the wording
  // of that refusal is unverified [04b §4], so the structure decides; after a session event only the wording can.
  if (io?.resumed === true && (sessionId === null || LOST_SESSION_RE.test(`${message ?? ""}\n${coded?.message ?? ""}`))) {
    return failed("resume-lost", said || "dsh exited 1 before it adopted the session");
  }
  // A fresh run that exits 1 before its session event (a usage error, any other refusal) is launch [04b §3, §11].
  if (sessionId === null) return failed("launch", said);
  return failed(null, text);
}

// The core runs this after reduce() for a job that was not cancelled and did not time out (spec §3.2). Its io does not
// say whether the job is a resume; the record does (resumeOf). A failed resumed job is read again with that bit, so a
// lost session is told from a launch failure by structure (reduce). null otherwise: the verdict stands.
export function finalize(job) {
  if (!job?.record?.resumeOf || !isObject(job.io) || job.io.resumed === true || job.reduced?.ok === true) return null;
  const again = reduce({ ...job.io, resumed: true });
  return again.errorClass === "resume-lost" ? again : null;
}

// The harness env doctor runs dsh with: the job's, without the key (--dump-config and --version are offline).
function doctorEnv(home, inv, profile, ctx) {
  return buildEnv({
    source: ctx.env ?? process.env,
    inherit: inv.inheritEnv,
    defaults: inv.env,
    profileEnv: profile.env,
    mandatory: { ...(home.env ?? {}), ...(inv.mandatoryEnv ?? {}) },
  });
}

// The rows the dump shows for one id: the lines from `id: <id>` to the next row.
function dumpSection(dump, id) {
  const lines = String(dump ?? "").split("\n");
  const name = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((line) => new RegExp(`\\bid:\\s*["']?${name}["']?\\s*$`).test(line.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*-\s+id:/.test(line));
  return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

// What the permission rows of a dump say (spec §3.6 A4): [{ id, value }], value a mode or policy literal of the row
// itself, or "DSH_PERMISSION_MODE" for a line of a sandbox / approval row that names the variable — the bundle row is
// `DSH_PERMISSION_MODE ?? 'workspace-write'` [04b §7], and whether the dump prints it resolved or as written is
// unverified, so the fallback literal of such a line is not the row's. A literal outside the mode / policy key of a
// sandbox or approval row (GRADED_LITERAL_RE) comes as { id, value, unverified: true }. Empty when no row matches
// PERMISSION_ROW_RE or none names a mode.
export function permissionRows(dump) {
  const ids = [...String(dump ?? "").matchAll(/^\s*-\s+id:\s*["']?([A-Za-z0-9._:/-]+)["']?\s*$/gm)].map((m) => m[1]);
  const found = [];
  for (const id of new Set(ids.filter((name) => PERMISSION_ROW_RE.test(name)))) {
    const graded = GRADED_ROW_RE.test(id);
    for (const line of (dumpSection(dump, id) ?? "").split("\n")) {
      if (graded && /\bDSH_PERMISSION_MODE\b/.test(line)) {
        found.push({ id, value: "DSH_PERMISSION_MODE" });
        continue;
      }
      // Where the literal of each `mode:` / `policy:` key of this line starts.
      const keyed = new Set(graded ? [...line.matchAll(GRADED_LITERAL_RE)].map((m) => m.index + m[0].length - m[1].length) : []);
      for (const m of line.matchAll(MODE_LITERAL_RE)) found.push(keyed.has(m.index) ? { id, value: m[1] } : { id, value: m[1], unverified: true });
    }
  }
  return found;
}

// The dsh-permissions row from a dump doctor ran as a reviewer (DSH_PERMISSION_MODE=read-only): ok when the mode /
// policy of the sandbox and approval rows show read-only or follow the variable; FAIL when one shows another mode or
// approval never (the danger-full-access preset [04b §7]), i.e. a layer replaced the bundle's row; WARN (not verified)
// when a mode literal sits anywhere else — a presets row, another key: the real dump format is unverified, so such a
// row is neither proof nor breach — or when the dump shows none of them. The home layers are only stat'ed, never
// read: the hint names those that exist.
function permissionCheck(dump, writer, dshHome, ctx, requested = "read-only") {
  const rows = permissionRows(dump);
  const found = rows.filter((row) => !row.unverified);
  const unverified = rows.filter((row) => row.unverified);
  const shown = (list) => [...new Set(list.map(({ id, value }) => (value === "DSH_PERMISSION_MODE" ? `${id} follows DSH_PERMISSION_MODE` : `${id} ${value}`)))].join(", ");
  const allowed = new Set(["read-only", "DSH_PERMISSION_MODE", ...(requested === "workspace-write" ? ["workspace-write"] : [])]);
  const wider = found.filter(({ value }) => !allowed.has(value));
  if (wider.length > 0) {
    const layers = HOME_LAYERS.map((parts) => path.join(dshHome, ...parts)).filter((file) => ctx.fs.stat(file)?.isFile?.());
    const modes = [...new Set(wider.map(({ value }) => value).filter((value) => value !== "never"))];
    const effect = modes.length > 0 ? `reviewer jobs run ${modes.join(" / ")}` : "the rows no longer follow it (approval never is the danger-full-access preset's)";
    if (requested !== "read-only") return {
      level: "FAIL",
      hint: `requested ${requested}, but --dump-config shows ${shown(wider)}; a home layer overrides DSH_PERMISSION_MODE`,
    };
    return {
      level: "FAIL",
      hint: `writer ${writer}, reviewer ${modes.length > 0 ? "NOT read-only" : "read-only overridden"}: --dump-config with DSH_PERMISSION_MODE=read-only shows ${shown(wider)} — a row of $DSH_HOME/cordis.patch.yml (or profiles/headless/cordis.patch.yml) overrides DSH_PERMISSION_MODE: ${effect}; ${layers.length > 0 ? `check ${layers.join(", ")} (not read here)` : `no such file in ${dshHome}: check the bundle's rows`}`,
    };
  }
  if (unverified.length > 0) {
    const graded = found.length > 0 ? `; the sandbox / approval rows show ${shown(found)}` : "";
    return {
      level: "WARN",
      hint: `writer ${writer}, reviewer read-only (DSH_PERMISSION_MODE) not verified: --dump-config with DSH_PERMISSION_MODE=read-only shows ${shown(unverified)} outside the mode / policy of a sandbox or approval row, a shape not graded here${graded}; check the dump by hand`,
    };
  }
  if (found.length > 0) {
    return { level: "ok", hint: `writer ${writer}, reviewer read-only: --dump-config with DSH_PERMISSION_MODE=read-only shows ${shown(found)} (headless has no approval answerer, so an escalation is denied)` };
  }
  return { level: "WARN", hint: `writer ${writer}, reviewer read-only (DSH_PERMISSION_MODE) not verified: --dump-config shows no sandbox / approval / permission row with a mode; check the dump by hand` };
}

// Runtime needs proof, unlike doctor's diagnostic WARNs. Accept only resolved mode/policy scalars in the effective
// dump, not expressions merely mentioning DSH_PERMISSION_MODE (which could resolve to anything). The dump format is
// not a stable API: unknown values, missing rows, duplicates and disabled policies fail closed. This deliberately
// does not parse or evaluate arbitrary YAML from a home patch; dsh has already resolved those layers for the dump.
function resolvedPermissions(dump, requested) {
  const ids = [...String(dump ?? "").matchAll(/^\s*-\s+id:\s*["']?([A-Za-z0-9._:/-]+)["']?\s*$/gm)]
    .map((match) => match[1]).filter((id) => GRADED_ROW_RE.test(id));
  if (ids.length !== new Set(ids).size) return "duplicate sandbox / approval rows";
  let modes = 0;
  let policies = 0;
  for (const id of ids) {
    const section = dumpSection(dump, id) ?? "";
    if (/\bdisabled["']?\s*:\s*true\b|\benabled["']?\s*:\s*false\b/.test(section)) return `${id} is disabled`;
    const entries = [...section.matchAll(/(?:^|\n|[,{])\s*["']?(mode|policy)["']?\s*:\s*([^\n,}]*)/g)];
    const key = /sandbox/.test(id) ? "mode" : "policy";
    const values = entries.filter((entry) => entry[1] === key);
    if (values.length !== 1) return `${id} has no unambiguous resolved ${key}`;
    const raw = values[0][2].trim();
    const value = /^(?:"([a-z-]+)"|'([a-z-]+)'|([a-z-]+))$/.exec(raw);
    const scalar = value?.[1] ?? value?.[2] ?? value?.[3];
    if (key === "mode") {
      modes += 1;
      if (scalar !== "read-only" && !(requested === "workspace-write" && scalar === "workspace-write")) {
        return `${id} does not resolve to ${requested} or a stricter mode`;
      }
    } else {
      policies += 1;
      if (scalar !== "ask") return `${id} does not resolve to approval ask`;
    }
  }
  return modes === 0 || policies === 0 ? "missing resolved sandbox / approval rows" : null;
}

// Materialized patch and exact job cwd/home/wrap/environment: the core supplies execHarness after writing adapter
// files and before spawning the harness. The trusted binary must see its key too: Cordis expressions can depend on
// its presence or value, so a scrubbed environment could approve another policy. The offline dump is never logged.
// No model request is made by --dump-config. Unrestricted writers need no fence;
// bounded writers and reviewers must not inherit a wider policy from $DSH_HOME (also rechecked on resume).
export function beforeLaunch(req, ctx) {
  const profile = req.profile ?? {};
  const requested = permissionMode(profile, req.write === true);
  if (requested === "danger-full-access") return;
  if (typeof ctx.execHarness !== "function") throw launchError("cannot verify dsh permissions: no launch-time command runner");
  const patch = path.join(req.job.dir, PATCH_FILE);
  const dump = ctx.execHarness(["--profile", "headless", "--patch", patch, "--dump-config"], { timeoutMs: 60_000, includeSecrets: true });
  if (dump.error || dump.status !== 0 || dump.signal || dump.timedOut || dump.stopped) {
    const why = dump.error?.code ?? (dump.signal ? `signal ${dump.signal}` : dump.timedOut ? "timeout" : dump.stopped ? "stopped" : `exit ${dump.status}`);
    // Do not quote dump diagnostics: native auth/config can contain credentials that the core does not know.
    throw launchError(`cannot verify dsh ${requested} permissions: --dump-config failed (${why}); harness not started`);
  }
  const checked = permissionCheck(dump.stdout, permissionMode(profile, true), dshHomeOf(profile, ctx), ctx, requested);
  const unresolved = resolvedPermissions(dump.stdout, requested);
  if (checked.level !== "ok" || unresolved) {
    throw launchError(`cannot verify dsh ${requested} permissions: ${unresolved ?? checked.hint}; harness not started`);
  }
}

// doctor (spec §4.3, §5.4; [04b §16 doctor row]): the effort vocabulary of the patch rows, Node, the native key file
// (its mode only, never its content), the repo .env, worktrees under the sandbox, and `dsh --profile headless --patch
// <template> --dump-config` with the reviewer's env, which also initializes the headless profile of the job's DSH_HOME
// (no first-run race between parallel jobs [04b open question 4]) and whose permission rows grade dsh-permissions.
// The binary and its version are the CLI's (discover).
export async function doctorChecks(profile, ctx) {
  const checks = [];
  const add = (name, level, hint) => checks.push({ name, level, hint });
  const wrap = Array.isArray(profile.wrap) ? profile.wrap : [];
  const run = (cmd, args, options) => (wrap.length > 0 ? ctx.exec(wrap[0], [...wrap.slice(1), cmd, ...args], options) : ctx.exec(cmd, args, options));
  const cwd = ctx.cwd ?? process.cwd();
  const top = ctx.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  const root = top?.status === 0 && top.stdout.trim() ? top.stdout.trim() : cwd;
  const dshHome = dshHomeOf(profile, ctx);

  // Graded from the dump below (permissionCheck); until then, and when the dump cannot run, not verified.
  const writer = permissionMode(profile, true);
  const permissions = { name: "dsh-permissions", level: "WARN", hint: `writer ${writer}, reviewer read-only (DSH_PERMISSION_MODE) not verified: no --dump-config ran (see dsh-patch)` };
  checks.push(permissions);

  // read-only (every reviewer) and workspace-write run dsh's OS sandbox runner; without one dsh fails closed with
  // SANDBOX_UNAVAILABLE [04b §7, §8, §16 doctor row]. danger-full-access bypasses it.
  const platform = ctx.platform ?? process.platform;
  const sandboxed = `read-only (reviewer)${permissionMode(profile, true) === "workspace-write" ? " and workspace-write (writer)" : ""}`;
  if (platform === "darwin") {
    const ok = Boolean(ctx.fs.stat("/usr/bin/sandbox-exec")?.isFile?.());
    add("dsh-sandbox", ok ? "ok" : "WARN", ok ? `${sandboxed}: Seatbelt (/usr/bin/sandbox-exec)` : `${sandboxed}: /usr/bin/sandbox-exec not found; dsh fails those runs with SANDBOX_UNAVAILABLE`);
  } else if (platform === "linux") {
    const dirs = String(ctx.env?.PATH ?? "").split(path.delimiter).filter(Boolean);
    const bwrap = dirs.map((dir) => path.join(dir, "bwrap")).find((file) => ctx.fs.stat(file)?.isFile?.());
    add("dsh-sandbox", bwrap ? "ok" : "WARN", bwrap ? `${sandboxed}: bwrap (${bwrap})` : `${sandboxed}: bwrap not on PATH; dsh then needs Landlock (not checked), else SANDBOX_UNAVAILABLE`);
  }
  if (wrap.length > 0 && platform === "darwin") {
    // Spec §3.7: Seatbelt cannot nest on macOS, so dsh's own sandbox cannot start under a Seatbelt wrap such as srt.
    add("dsh-wrap", "WARN", `under wrap ${wrap[0]}: if it is a Seatbelt sandbox (srt), ${sandboxed} runs cannot start — only danger-full-access can`);
  }

  let rows = null;
  try {
    rows = patchRows(profile);
  } catch (error) {
    add("dsh-patch", "FAIL", error.message);
  }
  // options.patch may name another model or route than the profile's: the record keeps the patch's (meta.model).
  const patched = rows?.[0].config;
  if (patched && (patched.model !== (profile.model ?? DEFAULT_MODEL) || patched.provider !== PROVIDER)) {
    add("dsh-model", "WARN", `options.patch runs ${patched.provider}/${patched.model}, not the profile's ${PROVIDER}/${profile.model ?? DEFAULT_MODEL}: status and routing show the profile's model`);
  }
  // The efforts the patch file carries in each pinned row (options.patch may replace the profile's): on
  // deepseek-official dsh refuses any outside its vocabulary before the first request [04b §5].
  const provider = rows?.[0].config.provider ?? PROVIDER;
  const effort = profile.effort ?? DEFAULT_EFFORT;
  const efforts = PINNED_ROWS.map((id, i) => [id, rows ? rows[i].config.reasoningEffort : effort]);
  const said = (value) => (typeof value === "string" ? value : JSON.stringify(value ?? null));
  const shown = efforts[0][1] === efforts[1][1] ? `reasoningEffort ${said(efforts[0][1])} in ${PINNED_ROWS.join(" and ")}` : efforts.map(([id, value]) => `reasoningEffort ${said(value)} in ${id}`).join(", ");
  const source = efforts.some(([, value]) => value !== effort) ? " (options.patch)" : profile.effort ? "" : " (dsh's default, written explicitly)";
  const bad = efforts.filter(([, value]) => value !== undefined && value !== null && !EFFORTS.includes(value));
  if (provider === PROVIDER && bad.length > 0) {
    const values = [...new Set(bad.map(([, value]) => said(value)))].join(", ");
    add("dsh-effort", "WARN", `${shown}${source}: ${values} is not one of dsh's ${EFFORTS.join("|")} on ${PROVIDER}: every task fails with UNSUPPORTED_REASONING_EFFORT before any request`);
  } else {
    add("dsh-effort", "ok", `${shown}${source}`);
  }

  const node = run("node", ["--version"]);
  const nodeVersion = /v?(\d+)\.(\d+)\.(\d+)/.exec(`${node.stdout ?? ""}`);
  if (node.error || node.status !== 0 || !nodeVersion) {
    add("dsh-node", "WARN", `node was not found or did not answer --version; dsh needs Node ^22.19.0 || >=24.0.0`);
  } else {
    const [major, minor] = [Number(nodeVersion[1]), Number(nodeVersion[2])];
    const fits = (major === 22 && minor >= 19) || major >= 24;
    add("dsh-node", fits ? "ok" : "WARN", `node ${nodeVersion[0]}${fits ? "" : "; dsh needs ^22.19.0 || >=24.0.0"}`);
  }

  if (!keyed(profile)) {
    const file = path.join(dshHome, ".env");
    const stat = ctx.fs.stat(file);
    if (stat?.isFile?.()) {
      const mode = stat.mode & 0o777;
      add("dsh-auth", mode & 0o077 ? "WARN" : "ok", `native: ${file} (mode ${mode.toString(8)}${mode & 0o077 ? ", expected 600" : ""}); its content is not read here; a ${KEY_VAR} in the repo's .env comes first`);
    } else {
      add("dsh-auth", "WARN", `native: no ${file}; put ${KEY_VAR}=… there (mode 0600), or use a stored key: "auth": {"key": "deepseek"}`);
    }
  }

  if (ctx.fs.exists(path.join(root, ".env"))) {
    add("dsh-repo-env", "WARN", `${path.join(root, ".env")}: dsh loads it before $DSH_HOME/.env — its ${KEY_VAR} wins over "native", proxy variables there stop dsh; DEEPSEEK_BASE_URL is overridden by the pinned baseURL`);
  } else {
    add("dsh-repo-env", "ok", `no .env in ${root}`);
  }

  if (profile.sandbox === "native" && ctx.fs.stat(path.join(root, ".git"))?.isFile?.()) {
    // Unverified [04b §8, open question 1]: the worktree's git metadata lies outside the workspace-write root.
    add("dsh-worktree", "WARN", `${root} is a linked git worktree: under workspace-write, git commit may be denied (its .git metadata lies outside the tree)`);
  }

  if (!rows) return checks;
  if (typeof ctx.writeFiles !== "function") {
    add("dsh-patch", "WARN", "not checked: this agent-dispatch passes no writeFiles to doctorChecks, so `dsh --profile headless --patch <template> --dump-config` cannot run");
    return checks;
  }
  const bin = profile.bin ?? "dsh";
  const dir = path.join(ctx.paths.state, "doctor", `dsh-${ctx.profileName ?? "profile"}`);
  const req = { profile, profileName: ctx.profileName, role: null, write: false, job: { id: null, dir, cwd: root, workspaceRoot: null }, prompt: { path: null, bytes: 0 }, sessionId: null, resume: null, harness: null };
  let env;
  let inv;
  try {
    const home = prepareHome(profile, ctx);
    inv = invocation(req, ctx);
    env = doctorEnv(home, inv, profile, ctx);
    const version = run(bin, ["--version"], { env });
    const who = identify(`${version.stdout ?? ""}\n${version.stderr ?? ""}`);
    if (version.error || !who.ok) {
      add("dsh-patch", "WARN", `not checked: ${bin} ${version.error ? `cannot run (${version.error.code ?? version.error.message})` : `is not DeepSeek Harness (${who.reason})`}`);
      return checks;
    }
    ctx.writeFiles({ dirs: [...(home.dirs ?? []), ...(inv.dirs ?? [])], files: inv.files });
  } catch (error) {
    add("dsh-patch", "FAIL", error.message);
    return checks;
  }
  const patch = inv.files[0].path;
  const dump = run(bin, ["--profile", "headless", "--patch", patch, "--dump-config"], { env, cwd: root, timeoutMs: 60_000 });
  if (dump.error || dump.status !== 0) {
    const why = dump.error ? (dump.error.code ?? dump.error.message) : firstLine(dump.stderr) || firstLine(dump.stdout) || `exit ${dump.status ?? dump.signal}`;
    add("dsh-patch", "FAIL", `dsh refused the patch ${patch}: ${why}`);
    return checks;
  }
  add("dsh-patch", "ok", `--dump-config accepts ${patch}; the headless profile of ${dshHome} is initialized`);
  const text = `${dump.stdout ?? ""}`;
  // The dump ran with the reviewer's env (req.write false): its permission rows are what a reviewer job gets.
  Object.assign(permissions, permissionCheck(text, writer, dshHome, ctx));
  const baseURL = baseUrlOf(profile);
  if (text.includes(baseURL)) add("dsh-endpoint", "ok", `baseURL ${baseURL} (pinned: a repo .env cannot move it)`);
  else add("dsh-endpoint", "WARN", `--dump-config does not show baseURL ${baseURL} in llm-deepseek; check the dump by hand`);
  if (profile.options?.sessionLog === true) {
    add("dsh-session-log", "ok", `on (options.sessionLog): dsh uploads its session log with each request to ${baseURL}`);
  } else {
    const section = dumpSection(text, "session-log-deepseek");
    const off = section !== null && (/\benabled["']?\s*:\s*false\b/.test(section) || /\bdisabled["']?\s*:\s*true\b/.test(section));
    add("dsh-session-log", off ? "ok" : "WARN", off ? "off (session-log-deepseek enabled: false)" : "--dump-config does not show session-log-deepseek off; dsh may upload session logs");
  }
  return checks;
}

export function prepareHome(profile, ctx) {
  if (!isolated(profile)) return { env: {}, dirs: [], files: [] };
  const home = dshHomeOf(profile, ctx);
  return { env: { DSH_HOME: home }, dirs: [home], files: [] };
}

export function invocation(req, ctx) {
  const profile = req.profile ?? {};
  const rows = patchRows(profile);
  const resumeId = req.resume ? req.resume.sessionId : null;
  if (req.resume && !SESSION_ID_RE.test(resumeId ?? "")) throw new Error(`invalid dsh session id ${JSON.stringify(resumeId)}`);
  const patch = path.join(req.job.dir, PATCH_FILE);
  const agentsUser = profile.options?.agentsHome === "user";
  const mode = permissionMode(profile, req.write === true);
  return {
    argv: [binOf(req), "--profile", "headless", "--patch", patch, "--json", ...(resumeId ? ["--session-id", resumeId] : []), "-"],
    env: { DSH_TELEMETRY_DISABLED: "1", ...(agentsUser ? {} : { DSH_AGENTS_HOME: ctx.paths.agentsEmpty }) },
    mandatoryEnv: { DSH_PERMISSION_MODE: mode },
    secretEnv: keyed(profile) ? [KEY_VAR] : [],
    // The native home variable passes for "home": "user"; DSH_AGENTS_HOME only when options.agentsHome is "user".
    inheritEnv: [...(isolated(profile) ? [] : ["DSH_HOME"]), ...(agentsUser ? ["DSH_AGENTS_HOME"] : [])],
    stdinPath: req.prompt?.path ?? null,
    cwd: req.job.cwd,
    dirs: agentsUser ? [] : [ctx.paths.agentsEmpty],
    files: [{ path: patch, mode: 0o600, content: renderPatch(rows) }],
    // Provider and model as the patch sets them: the model family comes from the route [04b §14].
    meta: { provider: rows[0].config.provider, model: rows[0].config.model, baseURL: rows[1].config.baseURL, permissionMode: mode, dshHome: dshHomeOf(profile, ctx), patch },
  };
}

const dsh = {
  id: "dsh",
  idPrefix: "dt",
  manifest: {
    sessionId: "first-event",
    cancel: { ladder: CANCEL_LADDER },
    // No required flags: the headless flags follow the launcher's and their help form is unverified, so only the
    // version and identity are checked (spec §3.2).
    requiredFlags: [],
    homeEnv: ["DSH_HOME"],
    verifiedVersions: VERIFIED_VERSIONS,
  },

  discover(ctx) {
    const bin = ctx.profile?.bin ?? "dsh";
    const r = ctx.exec(bin, ["--version"]);
    if (r.error) {
      const why = r.error.code === "ENOENT" ? "not found" : `cannot run (${r.error.code ?? r.error.message})`;
      throw launchError(`dsh ${why}: ${bin}; install DeepSeek Harness: ${INSTALL_HINT}`);
    }
    const who = identify(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
    if (!who.ok) throw launchError(`${bin} is not DeepSeek Harness: ${who.reason}; install it: ${INSTALL_HINT}`);
    if (r.status !== 0) throw launchError(`${bin} --version exited ${r.status ?? r.signal}${r.stderr?.trim() ? `: ${firstLine(r.stderr)}` : ""}`);
    return { bin, version: who.version };
  },

  prepareHome,
  invocation,
  beforeLaunch,

  // doctor --probe: one read-only PONG turn on the profile as configured, without the web tools.
  probe(req, ctx) {
    const inv = invocation({ ...req, write: false }, ctx);
    const rows = patchRows(req.profile ?? {}).filter((row) => row.id !== "tool-web");
    rows.push({ id: "tool-web", disabled: true });
    return { ...inv, files: [{ ...inv.files[0], content: renderPatch(rows) }] };
  },

  reduce,
  finalize,

  // Resume (spec §3.6 А12): the same cwd and the same DSH_HOME as the session's [04b §4]; an unknown id at run time
  // is resume-lost (reduce, with finalize's resume bit).
  resumeCheck(prev, profile, req, ctx) {
    if (!SESSION_ID_RE.test(prev?.sessionId ?? "")) return `job ${prev?.id} has no valid dsh session id`;
    if (prev.cwd !== req.job.cwd) return `dsh resumes a session only from its cwd (${prev.cwd}), not from ${req.job.cwd}`;
    const then = isObject(prev.meta) ? prev.meta.dshHome : null;
    if (typeof then !== "string" || !then) return `job ${prev.id} recorded no DSH_HOME, so its session cannot be found`;
    const now = dshHomeOf(profile, ctx);
    if (path.resolve(then) !== path.resolve(now)) return `its session lives in DSH_HOME=${then}, this job would run with DSH_HOME=${now}`;
    return null;
  },

  // Fallbacks for a failure reduce() left unclassified (or could not read): the code lines and launch. No resume-lost
  // pattern: patterns also see fresh jobs, and a fresh job cannot lose a session (reduce + finalize decide it).
  patterns: {
    "model-not-selected": [codeLine(codesOf("model-not-selected")), /^(?:dsh: )?HTTP_404:/m],
    auth: [codeLine(codesOf("auth")), /^(?:dsh: )?HTTP_40[13]:/m],
    quota: [codeLine(codesOf("quota")), /^(?:dsh: )?HTTP_402:/m],
    context: [codeLine(codesOf("context"))],
    "rate-limit": [codeLine(codesOf("rate-limit")), /^(?:dsh: )?HTTP_429:/m],
    server: [codeLine(codesOf("server")), /^(?:dsh: )?HTTP_5\d\d:/m],
    launch: [BOOT_FAILURE_RE, codeLine(codesOf("launch")), PROXY_REFUSAL_RE],
  },

  doctorChecks,
  // No loginEnv: `profile env` exports prepareHome().env, the DSH_HOME the jobs use.
};

export default dsh;
