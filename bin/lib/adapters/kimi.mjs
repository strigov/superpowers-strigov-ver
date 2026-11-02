// adapters/kimi.mjs — the core adapter of the `kimi` harness (Moonshot AI's Kimi Code CLI, @moonshot-ai/kimi-code
// 2.4.x) on agent-dispatch's job core (agent-core.mjs, spec §3.2): headless runs as
// `kimi -p <prompt> --output-format stream-json`, one detached process per turn. The facts were read from the source
// of MoonshotAI/kimi-code at tag @moonshot-ai/kimi-code@2.4.1 (paths below are relative to that repository;
// AKC = apps/kimi-code/src, ACV2 = packages/agent-core-v2/src); kimi itself was not run here.
//
// The command:
//   kimi -p <prompt> --output-format stream-json -m <model alias> --skills-dir <empty dir>
//        [--agent-file <reviewer agent file>] [-S <session id>]
// - The prompt goes only as the `-p` value: nothing in the CLI reads stdin, and `-p -` would send a literal "-"
//   (AKC/cli/options.ts:70-71; AKC/cli/commands.ts:73-74). A command line has a size limit (Linux: 128 KiB for one
//   argument; Windows: 32 767 UTF-16 units for the whole line): task refuses a prompt that cannot fit, and the
//   runner checks the exact text, failing the job with class `context` (the next profile takes it) — never a
//   truncated prompt.
// - `-p` forces kimi's "auto" permission mode, which approves every tool (AKC/cli/v2/run-v2-print.ts:529;
//   ACV2/agent/permissionPolicy/permissionPolicyService.ts:39-55), and refuses --yolo / --auto / --plan
//   (options.ts:79-87). So a writer runs everything. A reviewer is held to reading by tools, not by rules: an agent
//   file passed with --agent-file allows only Read, Glob and Grep (frontmatter `tools`; enforced again before every
//   call, ACV2/agent/toolPolicy/toolPolicyService.ts:36-44). `[permission]` deny rules from config.toml are not used:
//   in 2.4.1 nothing loads them into the engine. kimi cannot combine --agent-file with --session (options.ts:100-106),
//   so a reviewer job never resumes (resumeCheck): its follow-ups go FRESH.
// - stream-json (AKC/cli/prompt-render.ts): {"role":"meta","type":"system.version"} first, then assistant lines
//   ({role, content?, tool_calls?}), tool lines, retry notices ({"role":"meta","type":"turn.step.retrying"}), and,
//   only after a turn that completed, {"role":"meta","type":"session.resume_hint","session_id"} as the last line. The
//   session id is known from that line only (manifest.sessionId "first-event"); kimi cannot take a preassigned one
//   (run-v2-print.ts:512-519). Errors never come as JSON on stdout, except "session.occupied" (exit 4): a failed
//   turn is `error: failed to run prompt: <code>: <message>` on stderr and exit 1 (AKC/cli/startup-error.ts;
//   run-v2-print.ts:1219-1232). There is no token usage in the stream.
// - Home: KIMI_CODE_HOME (default ~/.kimi-code) holds config.toml, sessions, session_index.jsonl, logs and the login
//   (credentials/kimi-code.json). A keyed profile runs in its isolated home, where this adapter writes config.toml:
//   one provider of type "kimi" whose key comes from the variable KEY_VAR (`api_key_env`, re-read on every request;
//   packages/agent-core-v2 model-auth.ts) and one model alias, the profile's model. The key is never written to a
//   file. A login profile uses the user's home (`kimi login` there), or its isolated home after
//   `agent-dispatch profile env <name> -- kimi login`.
// - Defaults (profile.env may override them): telemetry, update checks, cron off; background tasks of the turn are
//   stopped at its end (print background mode "exit"), so a dev server a tool started does not keep the job running
//   for the default wait ceiling of about 24 days (ACV2/agent/task/configSection.ts; printDefaults.ts). The
//   KIMI_MODEL_* variables, which would add a provider of their own and make it the default model (envOverlay.ts), are
//   removed, and so is KIMI_CODE_TRUST_WORKSPACE (project MCP servers stay off).
// - --skills-dir <empty dir> replaces kimi's discovery of user and project skills (commands.ts:85-89). AGENTS.md of
//   the repository stays on, as context files do for the other harnesses (spec §3.6 A6).
// - Cancel: SIGTERM; kimi cancels the turn, saves the session and exits 143 within its 8 s cleanup cap
//   (AKC/run-prompt.ts:63-94; AKC/constant/app.ts:25), then SIGKILL.
//
// Pure data, as the contract asks: processes and files only through ctx.exec / ctx.fs.

import path from "node:path";
import { UsageError, parseEvents } from "../agent-core.mjs";

export const VERIFIED_VERSIONS = ["2.4.1"];
export const INSTALL_HINT = "npm i -g @moonshot-ai/kimi-code@2.4.1, or on Windows the native kimi.exe from WinGet (with npm on Windows, npm installs a .cmd shim, which is not started: give the profile \"wrap\": [\"node\"] and \"bin\": \"<npm prefix>\\\\node_modules\\\\@moonshot-ai\\\\kimi-code\\\\dist\\\\main.mjs\")";
export const HOME_VAR = "KIMI_CODE_HOME";
// The variable the job's key travels in; config.toml names it (api_key_env), never the key.
export const KEY_VAR = "AGENT_DISPATCH_KIMI_API_KEY";
export const PROVIDER_ID = "agent-dispatch";
// Kimi Code's global endpoint (packages/oauth/src/managed-usage.ts:8-9); mainland China: https://api.kimi.com/coding/v1.
export const DEFAULT_ENDPOINT = "https://api.kimi.ai/coding/v1";
export const DEFAULT_CONTEXT = 262144;
export const REVIEWER_TOOLS = ["Read", "Glob", "Grep"];
export const DEFAULT_ENV = {
  KIMI_DISABLE_TELEMETRY: "1",
  KIMI_CODE_NO_AUTO_UPDATE: "1",
  KIMI_DISABLE_CRON: "1",
  KIMI_CODE_BACKGROUND_PRINT_BACKGROUND_MODE: "exit",
};
// Removed from every run (mandatory): each would route the job past the profile's model or open project MCP servers.
const REMOVED_ENV = ["KIMI_MODEL_NAME", "KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL", "KIMI_MODEL_PROVIDER_TYPE", "KIMI_BASE_URL", "KIMI_API_KEY", "KIMI_CODE_TRUST_WORKSPACE"];
// The largest prompt a command line takes: Linux caps one argument at 32 pages (MAX_ARG_STRLEN, 131072 bytes with
// its NUL); macOS only the total (ARG_MAX, 1 MiB with the environment); Windows the whole command line at 32 767
// UTF-16 units, quoting included. Headroom is left for the other arguments.
export const PROMPT_LIMIT = { linux: { unit: "bytes", max: 120 * 1024 }, darwin: { unit: "bytes", max: 200 * 1024 }, win32: { unit: "UTF-16 units", max: 30_000 } };
const PROBE_PROMPT = "Reply with exactly: PONG";

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keyed = (profile) => isObject(profile?.auth) && ["key", "keyEnv", "keyCmd"].some((source) => source in profile.auth);
const isolated = (profile) => profile?.home === "isolated";
const binOf = (req) => req.harness?.bin ?? req.profile?.bin ?? "kimi";
const firstLine = (text) => String(text ?? "").trim().split("\n")[0].slice(0, 160);
const limitOf = (platform = process.platform) => PROMPT_LIMIT[platform] ?? PROMPT_LIMIT.linux;

// The home kimi runs with: the profile's own under the data root ("isolated"); with "home": "user" the one
// profile.env sets, else the caller's KIMI_CODE_HOME, else null for kimi's default ~/.kimi-code.
export function homeOf(profile, ctx) {
  if (isolated(profile)) return path.join(ctx.paths.homes, ctx.profileName, "kimi");
  if (isObject(profile?.env) && Object.hasOwn(profile.env, HOME_VAR)) {
    const value = profile.env[HOME_VAR];
    return value === null || value === undefined ? null : String(value) || null;
  }
  return ctx.env?.[HOME_VAR] || null;
}

// A TOML basic string: JSON's escapes are TOML's for the characters a model id or URL can hold.
const tomlString = (value) => JSON.stringify(String(value));

// The config.toml of a keyed profile's isolated home: the profile's model as the only alias, on one provider of type
// "kimi" whose key is read from KEY_VAR (docs/en/configuration/providers.md, config-files.md).
export function configToml(profile) {
  const model = String(profile.model);
  const context = Number.isInteger(profile.options?.contextSize) ? profile.options.contextSize : DEFAULT_CONTEXT;
  return [
    "# Written by agent-dispatch for this profile on every task; edits here are overwritten.",
    `default_model = ${tomlString(model)}`,
    "telemetry = false",
    "",
    `[providers.${tomlString(PROVIDER_ID)}]`,
    'type = "kimi"',
    `base_url = ${tomlString(profile.endpoint ?? DEFAULT_ENDPOINT)}`,
    `api_key_env = ${tomlString(KEY_VAR)}`,
    "",
    `[models.${tomlString(model)}]`,
    `provider = ${tomlString(PROVIDER_ID)}`,
    `model = ${tomlString(model)}`,
    `max_context_size = ${context}`,
    'capabilities = ["thinking", "tool_use"]',
    "",
    "[thinking]",
    "enabled = true",
    "",
  ].join("\n");
}

// The reviewer's agent file: Read, Glob and Grep only (docs/en/customization/agents.md "Agent File Format"). Its body
// is the main agent's system prompt for the run; the reviewer preamble of the prompt carries the actual rules.
export const REVIEWER_AGENT = [
  "---",
  "name: agent-dispatch-reviewer",
  "description: Read-only reviewer started by agent-dispatch",
  "tools:",
  ...REVIEWER_TOOLS.map((tool) => `  - ${tool}`),
  "---",
  "",
  "You are a careful code reviewer running non-interactively. You can only read files (Read, Glob, Grep); you cannot",
  "run commands or change anything. Follow the user's message exactly and end with the report it asks for.",
  "",
].join("\n");

// Why this prompt cannot go on kimi's command line, or null. `text` when the prompt file is readable (the runner),
// else only its byte count (task time: the job's prompt.md is written after planning): UTF-8 takes at least as many
// bytes as UTF-16 units and at most three per unit, so a byte count alone refuses only what cannot fit.
export function promptTooLong({ text = null, bytes = 0 }, platform = process.platform) {
  const limit = limitOf(platform);
  if (typeof text === "string") {
    const size = limit.unit === "bytes" ? Buffer.byteLength(text) : text.length + (text.match(/["\\]/g) ?? []).length;
    return size > limit.max ? `the prompt is ${size} ${limit.unit}, above the ${limit.max} a kimi command line takes on ${platform} (kimi reads its prompt only from -p)` : null;
  }
  const lower = limit.unit === "bytes" ? bytes : Math.ceil(bytes / 3);
  return lower > limit.max ? `the prompt is ${bytes} bytes, above the ${limit.max} ${limit.unit} a kimi command line takes on ${platform} (kimi reads its prompt only from -p)` : null;
}

function promptText(req, ctx) {
  const file = req.prompt?.path;
  if (!file) return null;
  const text = ctx?.fs?.readFile?.(file);
  return typeof text === "string" ? text : null;
}

function prepareHomeOf(profile, ctx) {
  if (!isolated(profile)) return { env: {}, dirs: [], files: [] };
  const dir = homeOf(profile, ctx);
  const files = keyed(profile) && profile.model ? [{ path: path.join(dir, "config.toml"), mode: 0o600, content: configToml(profile) }] : [];
  return { env: { [HOME_VAR]: dir }, dirs: [dir], files };
}

function baseInvocation(req, ctx, { prompt, jobLess }) {
  const profile = req.profile ?? {};
  const skillsDir = path.join(req.job.dir, "no-skills");
  const reviewer = !jobLess && req.write !== true;
  const agentFile = path.join(req.job.dir, "reviewer-agent.md");
  const argv = [binOf(req), "-p", prompt, "--output-format", "stream-json"];
  if (profile.model) argv.push("-m", profile.model);
  argv.push("--skills-dir", skillsDir);
  if (reviewer) argv.push("--agent-file", agentFile);
  if (!jobLess && req.resume?.sessionId) argv.push("-S", req.resume.sessionId);
  const env = { ...DEFAULT_ENV, ...(profile.effort ? { KIMI_MODEL_THINKING_EFFORT: String(profile.effort) } : {}) };
  return {
    argv,
    env,
    mandatoryEnv: Object.fromEntries(REMOVED_ENV.map((name) => [name, null])),
    secretEnv: keyed(profile) ? [KEY_VAR] : [],
    stdinPath: null,
    cwd: req.job.cwd,
    dirs: [skillsDir],
    files: reviewer ? [{ path: agentFile, mode: 0o600, content: REVIEWER_AGENT }] : [],
    meta: jobLess ? null : { home: homeOf(profile, ctx), reviewer },
  };
}

// ---------- reduce: the outcome from the stream-json lines ----------

// The `<code>: <message>` of kimi's last "error: failed to run prompt: …" line on stderr (colour codes removed).
export function stderrError(stderr) {
  const lines = String(stderr ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^error:\s*(?:failed to run prompt:\s*)?(.+)$/.exec(lines[i].trim());
    if (match) return match[1].trim();
  }
  return null;
}

export function reduce(io) {
  const events = Array.isArray(io?.events) ? io.events : parseEvents(io?.stdout);
  let version = null;
  let last = null; // the last assistant line
  let answer = null; // the last assistant text that came without tool calls
  let resume = null; // session.resume_hint: the turn completed
  let occupied = null;
  let retry = null;
  for (const event of events) {
    if (!isObject(event)) continue;
    if (event.role === "meta" && event.type === "system.version") version = typeof event.version === "string" ? event.version : version;
    else if (event.role === "assistant") {
      last = event;
      const calls = Array.isArray(event.tool_calls) && event.tool_calls.length > 0;
      if (!calls && typeof event.content === "string" && event.content.trim() !== "") answer = event.content;
    } else if (event.role === "meta" && event.type === "session.resume_hint" && typeof event.session_id === "string") resume = event;
    else if (event.role === "meta" && event.type === "turn.step.retrying") retry = event;
    else if (event.type === "error" && event.code === "session.occupied") occupied = event;
  }
  const base = { sessionId: resume ? resume.session_id : null, usage: null, reportedModel: null, meta: version ? { kimiVersion: version } : null };
  const failed = (errorClass, errorText) => ({ ok: false, response: null, ...base, errorClass, errorText });
  const endsOnTool = Array.isArray(last?.tool_calls) && last.tool_calls.length > 0;
  if (resume && answer !== null && !endsOnTool) return { ok: true, response: answer, ...base, errorClass: null, errorText: null };
  if (occupied) return failed("blocked", `kimi: ${occupied.message ?? "the session is in use by another kimi process"} (session.occupied)`);
  // Unclassified failures leave errorClass null: the core matches `patterns` against errorText and the stderr tail.
  const fromStderr = stderrError(io?.stderrTail);
  // The core's patterns have no timeout class: kimi's step cap (loop.max_steps_exceeded) is set here, as claude's
  // error_max_turns is.
  if (fromStderr && /loop\.max_steps_exceeded/.test(fromStderr)) return failed("timeout", fromStderr);
  if (fromStderr) return failed(null, fromStderr);
  if (resume && endsOnTool) return failed(null, "kimi completed the turn on a tool call, without a final answer");
  if (resume) return failed(null, "kimi completed the turn without a final answer");
  if (retry) return failed(null, `kimi stopped after retrying: ${retry.error_name ?? ""} ${retry.error_message ?? ""}${retry.status_code ? ` (status ${retry.status_code})` : ""}`.trim());
  return failed(null, version ? "kimi ended without completing the turn" : null);
}

// ---------- doctor (no model call) ----------

export function doctorChecks(profile, ctx) {
  const checks = [];
  const name = ctx.profileName ?? "<profile>";
  const home = homeOf(profile, ctx);
  const where = home ?? "~/.kimi-code";
  if (keyed(profile)) {
    checks.push({ name: "kimi-auth", level: "ok", hint: `the key goes in through ${KEY_VAR}, named as api_key_env in the config.toml written to ${where} on every task (provider ${PROVIDER_ID}, ${profile.endpoint ?? DEFAULT_ENDPOINT})` });
  } else {
    const credentials = home ? path.join(home, "credentials", "kimi-code.json") : null;
    const loginHint = `the user logs in: ${isolated(profile) ? `agent-dispatch profile env ${name} -- kimi login` : "kimi login"}`;
    if (credentials && ctx.fs.exists(credentials)) checks.push({ name: "kimi-auth", level: "ok", hint: `a Kimi Code login is stored in ${where}` });
    else if (!credentials) checks.push({ name: "kimi-auth", level: "WARN", hint: `the login in ~/.kimi-code is not checked (KIMI_CODE_HOME is not set); without one a task fails with errorClass auth: ${loginHint}` });
    else checks.push({ name: "kimi-auth", level: "FAIL", hint: `no Kimi Code login in ${where}; ${loginHint}` });
    if (typeof profile.model === "string" && !profile.model.includes("/")) {
      checks.push({ name: "kimi-model", level: "WARN", hint: `model ${JSON.stringify(profile.model)}: a login names its models kimi-code/<id> (e.g. kimi-code/k3); -m takes an alias of config.toml` });
    }
  }
  checks.push({ name: "kimi-reviewer", level: "ok", hint: `a read-only job runs with --agent-file allowing ${REVIEWER_TOOLS.join(", ")} only; it cannot be resumed (kimi refuses --agent-file with --session)` });
  return checks;
}

// ---------- the adapter ----------

const kimi = {
  id: "kimi",
  idPrefix: "ki",
  manifest: {
    sessionId: "first-event",
    // SIGTERM: kimi saves the session and exits within its 8 s cleanup cap.
    cancel: { ladder: [["SIGTERM", 10000], ["SIGKILL", 0]] },
    helpArgv: ["--help"],
    requiredFlags: ["--prompt", "--output-format", "--model", "--session", "--skills-dir", "--agent-file"],
    homeEnv: [HOME_VAR],
    verifiedVersions: VERIFIED_VERSIONS,
  },

  discover(ctx) {
    const bin = ctx.profile?.bin ?? "kimi";
    const r = ctx.exec(bin, ["--version"]);
    if (r.error) {
      const why = r.error.code === "ENOENT" ? "not found" : `cannot run (${r.error.code ?? r.error.message})`;
      throw Object.assign(new Error(`kimi ${why}: ${bin}; install it: ${INSTALL_HINT}`), { errorClass: "launch" });
    }
    if (r.status !== 0) {
      throw Object.assign(new Error(`${bin} --version exited ${r.status ?? r.signal}${r.stderr?.trim() ? `: ${firstLine(r.stderr)}` : ""}`), { errorClass: "launch" });
    }
    // Commander prints the bare version, e.g. "2.4.1" (AKC/cli/commands.ts:41).
    return { bin, version: /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(`${r.stdout}\n${r.stderr}`)?.[0] ?? null };
  },

  prepareHome: prepareHomeOf,

  // `profile env <name>` gives an isolated home (a `kimi login` there) without writing config.toml.
  loginEnv(profile, ctx) {
    return isolated(profile) ? { [HOME_VAR]: homeOf(profile, ctx) } : {};
  },

  invocation(req, ctx) {
    const profile = req.profile ?? {};
    const jobLess = !req.job?.id;
    if (keyed(profile) && !isolated(profile)) {
      throw new UsageError(`profile ${req.profileName ?? ctx?.profileName ?? "-"}: a keyed kimi profile runs only in its isolated home (the default with a key), where agent-dispatch writes the config.toml that names its key; remove "home": "user"`);
    }
    if (keyed(profile) && !profile.model) throw new UsageError(`profile ${req.profileName ?? ctx?.profileName ?? "-"}: a keyed kimi profile needs model (the Kimi Code model id, e.g. k3.1-pro)`);
    const text = promptText(req, ctx);
    if (!jobLess) {
      const tooLong = promptTooLong({ text, bytes: Number(req.prompt?.bytes) || 0 });
      if (tooLong) {
        // At task time a refusal (exit 2, the next profile); in the runner, where the exact text is known, a failed
        // job of class context, which the orchestrator also hands to the next profile.
        if (text === null) throw new UsageError(`profile ${req.profileName ?? ctx?.profileName ?? "-"}: ${tooLong}`);
        throw Object.assign(new Error(tooLong), { errorClass: "context" });
      }
    }
    return baseInvocation(req, ctx, { prompt: text ?? "(the prompt file is read when the job starts)", jobLess });
  },

  // One "Reply with exactly: PONG" turn in the probe's scratch dir; the profile's model and effort, no agent file.
  probe(req, ctx) {
    const plan = baseInvocation({ ...req, write: true }, ctx, { prompt: promptText(req, ctx) ?? PROBE_PROMPT, jobLess: true });
    return plan;
  },

  reduce,

  // spec §3.6 A12: kimi resumes a session only from the directory it was created in (run-v2-print.ts:459-470), from
  // the same home (its session_index.jsonl), and never with --agent-file — so a read-only job is not resumed.
  resumeCheck(prev, profile, req, ctx) {
    if (req.write !== true) return "a read-only kimi job runs with --agent-file, which kimi cannot combine with --session";
    if (prev.meta?.reviewer === true) return `job ${prev.id} ran read-only (with --agent-file); its session is not resumed`;
    if (prev.cwd !== req.job.cwd) return `the kimi session of ${prev.id} was started in ${prev.cwd}, not ${req.job.cwd}`;
    if (typeof prev.sessionId !== "string" || !/^session_[0-9A-Za-z-]+$/.test(prev.sessionId)) return `job ${prev.id} recorded no kimi session id`;
    const home = homeOf(profile, ctx);
    if ((prev.meta?.home ?? null) !== home) return `the kimi session of ${prev.id} lives in ${prev.meta?.home ?? "~/.kimi-code"}, not ${home ?? "~/.kimi-code"}`;
    return null;
  },

  // Matched by the core against reduce()'s errorText and the stderr tail when reduce() left the class open. Sources:
  // ACV2/llm-adapter/contract/errors.ts, ACV2/human/llm-kimi/errors.ts, ACV2/human/llm/errors.ts, ACV2/app/auth/auth.ts,
  // AKC/cli/options.ts, run-v2-print.ts.
  patterns: {
    "resume-lost": [/Session "[^"]*" not found/, /was created under a different directory/],
    "model-not-selected": [/is not configured in config\.toml/, /model\.not_found/, /auth\.model_not_resolved/, /No model configured/, /no default model configured/, /does not resolve to a configured provider/, /does not exist/, /\b404\b/],
    auth: [
      /provider\.auth_error/,
      /auth\.token_missing/,
      /auth\.login_required/,
      /auth\.provisioning_required/,
      /has no credential configured/,
      /requires login before it can be used/,
      /declares api_key_env/,
      /rejected (OAuth credentials|the API key)/,
      /\b401\b/,
      /\b403\b/,
      /unauthori[sz]ed/i,
      /invalid[_ ]?api[_ ]?key/i,
    ],
    quota: [/exceeded_current_quota_error/, /exceeded your current (token )?quota/i, /check your account balance/i, /insufficient balance/i, /recharge/i, /in arrears/i, /\b402\b/, /usage limit/i, /limit exhausted/i],
    context: [/context\.overflow/, /context[ _-]?length/i, /maximum context/i, /prompt is too long/i, /a kimi command line takes/],
    blocked: [/Prompt hook blocked the request/, /safety policy blocked/i, /session\.occupied/],
    "rate-limit": [/provider\.rate_limit/, /\b429\b/, /\b529\b/, /rate.?limit/i, /too many requests/i, /overloaded/i],
    server: [/provider\.connection_error/, /\b50[0-4]\b/, /internal server error/i, /service unavailable/i, /bad gateway/i, /ECONNRESET/, /ECONNREFUSED/, /ENOTFOUND/, /EAI_AGAIN/, /fetch failed/i, /socket hang up/i, /timed? ?out/i],
    launch: [/Cannot combine --prompt/, /unknown option/i, /unknown command/i, /Prompt cannot be empty/],
  },

  doctorChecks,
};

export default kimi;
