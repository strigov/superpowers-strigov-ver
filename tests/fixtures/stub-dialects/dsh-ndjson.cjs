// The "dsh-ndjson" dialect of tests/fixtures/agent-stub.cjs: DeepSeek Harness 0.2.1-rc.2 headless in --json mode, as
// docs/research/universal-dispatchers/04b-deepseek-harness.md documents it (dsh itself was never run; every shape
// here comes from that report, cited as [04b §n]). Read by bin/lib/adapters/dsh.mjs; see the plain dialect for the
// module contract.
//
// Like dsh it:
// - parses the launcher's argv (--profile, --patch…, --dump-config first; then --json, --session-id, the task "-")
//   [04b §2]; only `--profile headless --json … -` is implemented (anything else is the stub's exit 2);
// - layers $DSH_HOME/profiles/headless/cordis.patch.yml, then $DSH_HOME/cordis.patch.yml, then the --patch files over
//   its base rows, a row replacing that row's whole config [04b §2, §5]; the base permission rows (ids unverified:
//   sandbox-policy {mode, workspaceRoot}, approval-policy {policy}) follow DSH_PERMISSION_MODE ?? workspace-write,
//   approval never only with danger-full-access [04b §7], until a layer replaces them;
// - resolves the key like headless does: the process env (an exported empty value shadows the rest), then
//   <cwd>/.env, then $DSH_HOME/.env; baseURL: explicit config, then DEEPSEEK_BASE_URL from any layer, then
//   https://api.deepseek.com/anthropic [04b §5, §6];
// - refuses to start on proxy variables in <cwd>/.env (exit 1 before the session event) [04b §6, §15 item 4];
// - keeps sessions in $DSH_HOME/sessions/--<cwd>--/<id>/ (raw JSONL here) and refuses an unknown --session-id or one of
//   another cwd with an `error` event before any session event, exit 1 (shape and wording unverified) [04b §3, §4];
// - prints `session` first, `status` turn/step events (usage on step_end), `text`, `turn_end` with a reason, `final`;
//   failures as turn_end reason {kind: "error", error: {code, message}} plus the stderr line `dsh: <CODE>: <message>`
//   and an empty final; exit 0 only for a completed turn [04b §3, §11];
// - on SIGINT / SIGTERM disposes (aborted turn) and exits 130 / 0; a second signal exits at once [04b §10]. The final
//   is empty after SIGINT and a partial answer after SIGTERM (dsh's final is only "often empty" [04b §3]).
// Extra outputs for the tests:
//   AGENT_STUB_EFFECTIVE  a JSON file: the effective config the run booted with (rows, model, efforts, baseURL, the key's
//                         source — never the key —, permission mode and approval policy as the rows resolved them,
//                         homes, telemetry, session id)
//   AGENT_STUB_SIGNALS    "<SIGNAL> <epoch ms>" per signal received (busy, stuck, sigterm-final, late-session)
//   AGENT_STUB_READY      written once the signal handlers of those modes are in place
// AGENT_STUB_MODE (dialect):
//   ok              a completed turn (AGENT_STUB_RESPONSE, "DONE\nresumed <id>" on a resume, else "DONE\nstub finished")
//   error           a failed turn: code AGENT_STUB_CLASS (default SERVER), message AGENT_STUB_MESSAGE, exit 1
//   quota | rate-limit | context   the same with QUOTA ("Insufficient Balance") | RATE_LIMIT | CONTEXT_WINDOW_EXCEEDED
//   max-tokens      turn_end max-tokens with a partial final, exit 1
//   auto-reject     turn_end blocked after a failed tool call, exit 1 (what ends a turn blocked is unverified [04b §3])
//   no-final        a completed turn without a final event, exit 0
//   empty-final     a completed turn with no assistant text: final "", exit 1
//   late-session    the whole stream only after AGENT_STUB_SESSION_DELAY_MS (default 3000); SIGINT → 130, SIGTERM → 0
//   busy            session + turn start, then waits; a signal disposes in ~150 ms (aborted turn) and exits 130 / 0,
//                   SIGTERM with a partial final ("DONE\npartial answer before the abort")
//   stuck           session + turn start, then waits and ignores SIGINT / SIGTERM / SIGHUP (a disposal that hangs)
//   sigterm-final   waits, ignores SIGINT; SIGTERM prints a completed turn with a final answer and exits 0
//   boot-fail       a required plugin fails: report + "Full diagnostics: …/logs/startup-*.log", exit 1, no session
//   boot-error      `dsh: <AGENT_STUB_CLASS>: <message>` on stderr, exit 1, no session
//   usage-error     a JSON error event (usage), exit 1, no session
//   dancer          `--version` answers as Homebrew's dsh (Dancer's shell 0.25.10)
//   dump-fail       `--dump-config` rejects the patch, exit 1
//   dump-key-output `--dump-config` echoes its key on stdout and stderr (must never reach dispatcher logs)
//   dump-key-fail   the same diagnostic output, then exit 1
// Every run mode first checks the task (empty stdin is a usage error), the effort vocabulary of deepseek-official
// (UNSUPPORTED_REASONING_EFFORT) and the key (MISSING_CREDENTIAL), as dsh does before any request [04b §5, §6].
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const VERSION = "0.2.1-rc.2";
const FLAGS = ["--profile", "--patch", "--dump-config", "--json", "--session-id"];
const EFFORTS = ["off", "low", "high", "max"];
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";
const USAGE = { inputTokens: 1200, outputTokens: 40, totalTokens: 1240, cacheReadTokens: 1024 };
const env = process.env;
const mode = env.AGENT_STUB_MODE || "ok";
const line = (value) => `${JSON.stringify(value)}\n`;

// Synchronous writes: early exits must not lose output on a pipe (asynchronous on macOS).
function emit(fd, text) {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off);
    } catch (error) {
      if (error.code !== "EAGAIN") throw error;
    }
  }
}
const out = (text) => emit(1, text);
const err = (text) => emit(2, text);
const stubDie = (message) => {
  err(`agent-stub dsh-ndjson: ${message}\n`);
  process.exit(2);
};

const dshHome = () => env.DSH_HOME || path.join(env.HOME || os.homedir(), ".dsh");

// launcher flags first; the first token the launcher does not know starts the app args [04b §2].
function parseArgv(args) {
  const launcher = { profile: null, patches: [], dump: null };
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      i += 1;
      break;
    }
    if (arg === "--profile") launcher.profile = args[(i += 1)];
    else if (arg === "--patch") launcher.patches.push(args[(i += 1)]);
    else if (arg.startsWith("--dump-")) launcher.dump = arg;
    else if (arg !== "--from-default-profile") break;
  }
  const app = { json: false, sessionId: null, task: [], unknown: [] };
  for (; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") app.json = true;
    else if (arg === "--session-id") app.sessionId = args[(i += 1)] ?? "";
    else if (arg !== "-" && arg.startsWith("-")) app.unknown.push(arg);
    else app.task.push(arg);
  }
  return { launcher, app };
}

// KEY=VALUE lines (optional `export`, quotes stripped); {} when the file is missing.
function readDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const vars = {};
  for (const raw of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (m && !raw.trim().startsWith("#")) vars[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return vars;
}

// The patch format the adapter writes: `- id: <id>`, `  config: <JSON flow mapping>`, `  disabled: true|false`. A real
// YAML parser is dsh's; this one refuses anything else, so a format drift in the adapter shows up as a boot failure.
function parsePatch(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw Object.assign(new Error(`cannot read it (${error.code})`), { file });
  }
  const rows = [];
  let row = null;
  for (const [n, raw] of text.split("\n").entries()) {
    const l = raw.replace(/\s+$/, "");
    if (l === "" || /^\s*#/.test(l)) continue;
    let m;
    if ((m = /^- id: (.+)$/.exec(l))) {
      const id = m[1].startsWith('"') ? JSON.parse(m[1]) : m[1];
      row = { id };
      rows.push(row);
      continue;
    }
    if (row && (m = /^ {2}config: (.+)$/.exec(l))) {
      let config;
      try {
        config = JSON.parse(m[1]);
      } catch (error) {
        throw Object.assign(new Error(`line ${n + 1}: ${error.message}`), { file });
      }
      if (!config || typeof config !== "object" || Array.isArray(config)) throw Object.assign(new Error(`line ${n + 1}: config must be a mapping`), { file });
      row.config = config;
      continue;
    }
    if (row && (m = /^ {2}disabled: (true|false)$/.exec(l))) {
      row.disabled = m[1] === "true";
      continue;
    }
    throw Object.assign(new Error(`line ${n + 1}: unexpected ${JSON.stringify(l)}`), { file });
  }
  return rows;
}

// The layers of $DSH_HOME that exist, in dsh's order: the home layer outranks the profile's [04b §2].
const homeLayers = () =>
  [path.join(dshHome(), "profiles", "headless", "cordis.patch.yml"), path.join(dshHome(), "cordis.patch.yml")].filter((file) => fs.existsSync(file));

// dsh's base rows as far as the report names them [04b §5, §7, §9] (the permission rows resolved from the env); each
// row of a home layer, then of a --patch, replaces a row's whole config.
function effectiveRows(patches, cwd) {
  const permission = env.DSH_PERMISSION_MODE ?? "workspace-write";
  const rows = [
    { id: "agent-default-model", config: { provider: "deepseek-official", model: "deepseek-flash" } },
    { id: "llm-deepseek", config: { apiKeyEnv: "DEEPSEEK_API_KEY" } },
    { id: "session-log-deepseek", config: { enabled: true } },
    { id: "plugin-package-inventory-deepseek", config: { enabled: true } },
    { id: "session-title-llm", config: {} },
    { id: "tool-web", config: {} },
    { id: "sandbox-policy", config: { mode: permission, workspaceRoot: cwd } },
    { id: "approval-policy", config: { policy: permission === "danger-full-access" ? "never" : "ask" } },
  ];
  for (const file of [...homeLayers(), ...patches]) {
    for (const patch of parsePatch(file)) {
      let row = rows.find((entry) => entry.id === patch.id);
      if (!row) {
        row = { id: patch.id, config: {} };
        rows.push(row);
      }
      if (patch.config) row.config = patch.config;
      if ("disabled" in patch) row.disabled = patch.disabled;
    }
  }
  // Test-only expression vocabulary, never eval: model the same Cordis env resolution for both an offline dump and
  // a model turn. A preflight without the actual key would approve read-only, while the keyed run would be writable.
  for (const row of rows.filter((entry) => entry.id === "sandbox-policy")) {
    const conditional = /^\$\{\{ env\.DEEPSEEK_API_KEY(?: === "([^"]+)")? \? "danger-full-access" : "read-only" \}\}$/.exec(row.config?.mode ?? "");
    if (conditional) {
      const matches = conditional[1] === undefined ? Boolean(env.DEEPSEEK_API_KEY) : env.DEEPSEEK_API_KEY === conditional[1];
      row.config.mode = matches ? "danger-full-access" : "read-only";
    }
  }
  return rows;
}

function initProfile() {
  const dir = path.join(dshHome(), "profiles", "headless");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "cordis.patch.yml");
  if (!fs.existsSync(file)) fs.writeFileSync(file, "# initialized by agent-stub (dsh-ndjson)\n");
}

const sessionsDir = () => path.join(dshHome(), "sessions");
const sessionDir = (id, cwd) => path.join(sessionsDir(), `--${cwd.replace(/[^A-Za-z0-9]/g, "-")}--`, encodeURIComponent(id));

// "here" | "elsewhere" (recorded in another cwd) | "none".
function findSession(id, cwd) {
  if (fs.existsSync(sessionDir(id, cwd))) return "here";
  let dirs = [];
  try {
    dirs = fs.readdirSync(sessionsDir());
  } catch {
    dirs = [];
  }
  return dirs.some((dir) => fs.existsSync(path.join(sessionsDir(), dir, encodeURIComponent(id)))) ? "elsewhere" : "none";
}

function bootFail() {
  const logs = path.join(dshHome(), "logs");
  fs.mkdirSync(logs, { recursive: true });
  const log = path.join(logs, `startup-${Date.now()}-${randomUUID()}.log`);
  fs.writeFileSync(log, "agent-stub: required plugin @deepseek-ai/dsh-llm-deepseek-api-key failed to activate\n");
  err(`dsh: profile headless failed to start\n  required plugin @deepseek-ai/dsh-llm-deepseek-api-key failed to activate\nFull diagnostics: ${log}\n`);
  process.exit(1);
}

const usageError = (reason) => {
  out(line({ type: "error", message: `usage: dsh --profile headless [--patch <yml>]... [--json] [--session-id <id>] [task... | -]: ${reason}` }));
  process.exit(1);
};

// Set by sessionId() once dsh has booted: { id, cwd, resumed, eff }.
let state = null;

function effective(rows, cwd) {
  const row = (id) => rows.find((entry) => entry.id === id) ?? { id, config: {} };
  const enabled = (id) => row(id).disabled !== true && (row(id).config ?? {}).enabled !== false;
  const agent = row("agent-default-model").config ?? {};
  const llm = row("llm-deepseek").config ?? {};
  const layers = [
    ["env", env],
    ["cwd .env", readDotEnv(path.join(cwd, ".env"))],
    ["DSH_HOME .env", readDotEnv(path.join(dshHome(), ".env"))],
  ];
  const lookup = (name) => {
    for (const [source, vars] of layers) if (Object.hasOwn(vars, name)) return { source, value: vars[name] };
    return null;
  };
  const keyVar = llm.apiKeyEnv || "DEEPSEEK_API_KEY";
  const key = lookup(keyVar);
  return {
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    effort: { agent: agent.reasoningEffort ?? null, llm: llm.reasoningEffort ?? null },
    baseURL: llm.baseURL ?? (lookup("DEEPSEEK_BASE_URL")?.value || DEFAULT_BASE_URL),
    keyVar,
    keySource: key && key.value !== "" ? key.source : null, // an exported empty variable shadows the .env layers
    sessionLog: enabled("session-log-deepseek"),
    inventory: enabled("plugin-package-inventory-deepseek"),
    sessionTitle: enabled("session-title-llm"),
    toolWeb: enabled("tool-web"),
    telemetryDisabled: Boolean(env.DSH_TELEMETRY_DISABLED),
    permissionMode: (row("sandbox-policy").config ?? {}).mode ?? null, // DSH_PERMISSION_MODE unless a layer pinned it
    approvalPolicy: (row("approval-policy").config ?? {}).policy ?? null,
    dshHome: dshHome(),
    agentsHome: env.DSH_AGENTS_HOME || path.join(env.HOME || os.homedir(), ".agents"),
    rows: Object.fromEntries(rows.map((entry) => [entry.id, { config: entry.config ?? null, disabled: entry.disabled === true }])),
  };
}

// ---- the event stream ----
const sessionEvent = () => line({ type: "session", sessionId: state.id, cwd: state.cwd });
const turnStart = () => line({ type: "status", phase: "turn_start", turn: 1 });
const stepStart = () => line({ type: "status", phase: "step_start", turn: 1, step: 1 });
const stepEnd = () => line({ type: "status", phase: "step_end", turn: 1, step: 1, usage: USAGE });
const turnEnd = (reason) => line({ type: "status", phase: "turn_end", turn: 1, reason });
const finalEvent = (text) => line({ type: "final", text });
const completedTurn = (text) =>
  stepStart() + line({ type: "thinking", text: "Working through the task." }) + line({ type: "text", text }) + stepEnd() + turnEnd({ kind: "completed" }) + finalEvent(text);

const DEFAULT_MESSAGES = {
  QUOTA: "Insufficient Balance",
  RATE_LIMIT: "Rate Limit Reached (429) after 5 retries",
  CONTEXT_WINDOW_EXCEEDED: "This model's maximum context length is 1048576 tokens",
  AUTH: "Authentication Fails",
  INVALID_CREDENTIAL: "Authentication Fails (401)",
  SERVER: "Server Error (500)",
};

// A failed turn: the error reason, an empty final, the stderr code line; exit 1 [04b §3, §11].
function turnError(code, message, exitCode = 1) {
  out(sessionEvent() + turnStart() + turnEnd({ kind: "error", error: { code, message } }) + finalEvent(""));
  err(`dsh: ${code}: ${message}\n`);
  process.exit(exitCode);
}

// The checks dsh makes before any request.
function preflight(io) {
  if (!String(io.stdin ?? "").trim()) usageError("the task on stdin is empty");
  const { eff } = state;
  const bad = [eff.effort.agent, eff.effort.llm].find((value) => value !== null && !EFFORTS.includes(value));
  if (eff.provider === "deepseek-official" && bad) {
    turnError("UNSUPPORTED_REASONING_EFFORT", `reasoningEffort ${JSON.stringify(bad)} is not supported by deepseek-official (${EFFORTS.join("|")})`);
  }
  if (!eff.keySource) turnError("MISSING_CREDENTIAL", `${eff.keyVar} is not set (environment, ${state.cwd}/.env, ${eff.dshHome}/.env)`);
}

const ready = () => {
  if (env.AGENT_STUB_READY) fs.writeFileSync(env.AGENT_STUB_READY, `${process.pid}\n`);
};
const record = (io, signal) => io.appendLine(env.AGENT_STUB_SIGNALS, `${signal} ${Date.now()}`);
const answerText = () => env.AGENT_STUB_RESPONSE || (state.resumed ? `DONE\nresumed ${state.id}` : "DONE\nstub finished");

function dumpConfig(launcher) {
  if (launcher.dump !== "--dump-config") stubDie(`${launcher.dump} is not implemented`);
  if (mode === "dump-key-output" || mode === "dump-key-fail") {
    out(`# credential diagnostic: ${env.DEEPSEEK_API_KEY ?? "(missing)"}\n`);
    err(`credential diagnostic: ${env.DEEPSEEK_API_KEY ?? "(missing)"}\n`);
    if (mode === "dump-key-fail") process.exit(1);
  }
  if (mode === "dump-fail") {
    err(`dsh: invalid patch ${launcher.patches.at(-1) ?? "-"}: row llm-deepseek: unknown field "reasoningEffort"\n`);
    process.exit(1);
  }
  let rows;
  try {
    rows = effectiveRows(launcher.patches, process.cwd());
  } catch (error) {
    err(`dsh: invalid patch ${error.file ?? "-"}: ${error.message}\n`);
    process.exit(1);
  }
  initProfile(); // --dump-config initializes missing profile files without booting [04b §2]
  const lines = [`# effective config of profile ${launcher.profile} (dsh ${VERSION}; agent-stub)`];
  for (const row of rows) {
    lines.push(`- id: ${row.id}`);
    if (row.disabled !== undefined) lines.push(`  disabled: ${row.disabled}`);
    lines.push("  config:");
    for (const [key, value] of Object.entries(row.config ?? {})) lines.push(`    ${key}: ${JSON.stringify(value)}`);
  }
  out(`${lines.join("\n")}\n`);
}

module.exports = {
  name: "dsh-ndjson",
  version: VERSION,
  flags: FLAGS,
  help(flags) {
    return `usage: dsh --profile <name> [--patch <yml>]... [--dump-config] [--json] [--session-id <id>] [task... | -]\noptions:\n${flags.map((flag) => `  ${flag}`).join("\n")}\n  --version\n  --help\n`;
  },

  answer(argv) {
    if (argv.includes("--version")) {
      if (mode === "dancer") out("Distributed Shell / Dancer's shell. version 0.25.10\nCopyright 2001-2015 Junichi Uekawa, distributed under GPL\n");
      else out(`${env.AGENT_STUB_VERSION || VERSION}\n`);
      return true;
    }
    const { launcher } = parseArgv(argv);
    if (launcher.dump) {
      dumpConfig(launcher);
      return true;
    }
    return false;
  },

  // Boot: argv, the cwd .env, the patches, the session. Exits like dsh when it would not start.
  sessionId() {
    const { launcher, app } = parseArgv(process.argv.slice(2));
    if (mode === "boot-fail") bootFail();
    if (mode === "boot-error") {
      err(`dsh: ${env.AGENT_STUB_CLASS || "INVALID_CREDENTIAL"}: ${env.AGENT_STUB_MESSAGE || DEFAULT_MESSAGES[env.AGENT_STUB_CLASS] || "boot failure"}\n`);
      process.exit(1);
    }
    if (launcher.profile !== "headless") stubDie(`only --profile headless is implemented, got ${JSON.stringify(launcher.profile)}`);
    if (!app.json) stubDie("only --json mode is implemented");
    if (mode === "usage-error") usageError("missing task");
    if (app.unknown.length > 0) usageError(`unrecognized option ${app.unknown[0]}`);
    if (app.task.length !== 1 || app.task[0] !== "-") stubDie(`only the task on stdin ("-", last) is implemented, got ${JSON.stringify(app.task)}`);
    const cwd = process.cwd();
    const proxies = PROXY_VARS.filter((name) => Object.hasOwn(readDotEnv(path.join(cwd, ".env")), name));
    if (proxies.length > 0) {
      err(`dsh: refusing proxy settings from ${path.join(cwd, ".env")} (${proxies.join(", ")}); set proxies in the launch environment\n`);
      process.exit(1);
    }
    let rows;
    try {
      rows = effectiveRows(launcher.patches, cwd);
    } catch (error) {
      err(`dsh: invalid patch ${error.file ?? "-"}: ${error.message}\n`);
      process.exit(1);
    }
    initProfile();
    let id;
    let resumed = false;
    if (app.sessionId !== null) {
      const where = findSession(app.sessionId, cwd);
      if (where !== "here") {
        // The real wording is unverified [04b §4]; this one deliberately avoids the adapter's LOST_SESSION_RE, so the
        // tests prove that a resume failing before its session event is read from structure, not from text.
        out(line({ type: "error", message: `--session-id ${app.sessionId}: refused (${where === "elsewhere" ? "recorded in another cwd" : "nothing persisted under this id"})` }));
        process.exit(1);
      }
      id = app.sessionId;
      resumed = true;
    } else {
      id = `session-${randomUUID()}`;
    }
    const dir = sessionDir(id, cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "session.v1.jsonl"), line({ type: resumed ? "resume" : "create", at: Date.now() }));
    state = { id, cwd, resumed, eff: effective(rows, cwd) };
    if (env.AGENT_STUB_EFFECTIVE) fs.writeFileSync(env.AGENT_STUB_EFFECTIVE, JSON.stringify({ ...state.eff, sessionId: id, resumed }, null, 2));
    return id;
  },

  final({ text }) {
    return sessionEvent() + turnStart() + completedTurn(text);
  },

  // The shape of a failed turn (the generic exit0-error mode prints it and exits 0).
  error({ message, errorClass }) {
    const code = errorClass || "SERVER";
    err(`dsh: ${code}: ${message}\n`);
    return sessionEvent() + turnStart() + turnEnd({ kind: "error", error: { code, message } }) + finalEvent("");
  },

  modes: {
    ok: (io) => {
      preflight(io);
      out(sessionEvent() + turnStart() + completedTurn(answerText()));
    },
    error: (io) => {
      preflight(io);
      const code = env.AGENT_STUB_CLASS || "SERVER";
      turnError(code, env.AGENT_STUB_MESSAGE || DEFAULT_MESSAGES[code] || "stub failure");
    },
    quota: (io) => {
      preflight(io);
      turnError("QUOTA", env.AGENT_STUB_MESSAGE || DEFAULT_MESSAGES.QUOTA);
    },
    "rate-limit": (io) => {
      preflight(io);
      turnError("RATE_LIMIT", env.AGENT_STUB_MESSAGE || DEFAULT_MESSAGES.RATE_LIMIT);
    },
    context: (io) => {
      preflight(io);
      turnError("CONTEXT_WINDOW_EXCEEDED", env.AGENT_STUB_MESSAGE || DEFAULT_MESSAGES.CONTEXT_WINDOW_EXCEEDED);
    },
    "max-tokens": (io) => {
      preflight(io);
      const partial = "DONE\npartial answer, cut at maxTokens";
      out(sessionEvent() + turnStart() + stepStart() + line({ type: "text", text: partial }) + stepEnd() + turnEnd({ kind: "max-tokens" }) + finalEvent(partial));
      process.exit(1);
    },
    // A denied ask is `unavailable` at the tool [04b §7]; [04b §3] lists `blocked` among the turn_end kinds without
    // naming its cause. Unverified: that such a denial ends the turn blocked — this mode only exercises the kind.
    "auto-reject": (io) => {
      preflight(io);
      out(
        sessionEvent() +
          turnStart() +
          stepStart() +
          line({ type: "tool_call", callId: "call-1", tool: "bash", input: { command: "git push", sandbox_permissions: "danger-full-access", justification: "push the branch" } }) +
          line({ type: "tool_result", callId: "call-1", status: "error", result: "approval unavailable: the escalation was denied" }) +
          stepEnd() +
          turnEnd({ kind: "blocked" }) +
          finalEvent(""),
      );
      process.exit(1);
    },
    "no-final": (io) => {
      preflight(io);
      out(sessionEvent() + turnStart() + stepStart() + line({ type: "text", text: "DONE" }) + stepEnd() + turnEnd({ kind: "completed" }));
    },
    "empty-final": (io) => {
      preflight(io);
      out(sessionEvent() + turnStart() + stepStart() + stepEnd() + turnEnd({ kind: "completed" }) + finalEvent(""));
      process.exit(1);
    },
    "late-session": (io) => {
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => {
          record(io, signal);
          process.exit(signal === "SIGINT" ? 130 : 0);
        });
      }
      ready();
      setTimeout(() => {
        preflight(io);
        out(sessionEvent() + turnStart() + completedTurn(answerText()));
        process.exit(0);
      }, Number(env.AGENT_STUB_SESSION_DELAY_MS || 3000));
    },
    busy: (io) => {
      preflight(io);
      out(sessionEvent() + turnStart() + stepStart());
      let first = null;
      const onSignal = (signal) => {
        record(io, signal);
        const code = signal === "SIGINT" ? 130 : 0;
        if (first) process.exit(code); // a second signal forces an immediate exit
        first = signal;
        // After SIGTERM the turn leaves a partial answer behind: exit 0 with a non-empty final, still not a success.
        const partial = signal === "SIGTERM" ? "DONE\npartial answer before the abort" : "";
        setTimeout(() => {
          out((partial ? line({ type: "text", text: partial }) : "") + turnEnd({ kind: "aborted" }) + finalEvent(partial));
          process.exit(code);
        }, 150);
      };
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => onSignal(signal));
      ready();
      io.forever();
    },
    stuck: (io) => {
      preflight(io);
      out(sessionEvent() + turnStart() + stepStart());
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => record(io, signal));
      ready();
      io.forever();
    },
    "sigterm-final": (io) => {
      preflight(io);
      out(sessionEvent() + turnStart());
      process.on("SIGINT", () => record(io, "SIGINT"));
      process.on("SIGTERM", () => {
        record(io, "SIGTERM");
        out(completedTurn("DONE\nterminated politely"));
        process.exit(0);
      });
      ready();
      io.forever();
    },
    // Handled at --version / --dump-config; a run in these modes is an ordinary one.
    dancer: (io) => module.exports.modes.ok(io),
    "dump-fail": (io) => module.exports.modes.ok(io),
  },
};
