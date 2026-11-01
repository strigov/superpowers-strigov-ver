// The "kimi-jsonl" dialect of tests/fixtures/agent-stub.cjs: Kimi Code CLI 2.4.x (@moonshot-ai/kimi-code) in prompt
// mode, as bin/lib/adapters/kimi.mjs cites it from the source at tag @moonshot-ai/kimi-code@2.4.1 — never a model call.
//
// What it reproduces:
// - argv: Commander's options of the main command with their arity (`-S/--session [id]` takes an optional value).
//   An unknown option is `error: unknown option '<x>'`, a positional word `error: unknown command '<x>'`, exit 1.
//   The prompt-mode conflicts of AKC/cli/options.ts: an empty prompt, --output-format without -p, -p with --yolo /
//   --auto / --plan, -S without an id, --agent / --agent-file with --session / --continue — `error: <message>`, exit 1.
//   The prompt is the -p value only; stdin is not read for it (the stub still records what came on stdin).
// - `--output-format stream-json`: {"role":"meta","type":"system.version","version"} first, assistant lines
//   ({role, content, tool_calls?}), tool lines, retry notices, and after a completed turn the resume hint
//   {"role":"meta","type":"session.resume_hint","session_id","command","content"}. A failed turn prints no JSON: one
//   stderr line `error: failed to run prompt: <code>: <message>`, `See log: …`, exit 1.
// - Home: KIMI_CODE_HOME (default ~/.kimi-code). With a config.toml there that names `api_key_env = "<VAR>"` and
//   `[models."<alias>"]` entries, a run fails as kimi does when <VAR> is empty or -m names no alias. Sessions: a
//   completed turn records its session id and cwd in <home>/stub-sessions.json; `-S <id>` resumes it only from the
//   same cwd (`Session "<id>" not found.` / `… was created under a different directory.`).
//
// Modes of this dialect (they win over the generic ones of agent-stub.cjs):
//   auth | quota | rate-limit | model-missing | context | max-steps | server   a failed turn with kimi's error code
//   ends-on-tool    the turn completes on an assistant tool call (no final text)
//   no-hint         the answer, but the process ends before the resume hint (a turn that did not complete)
//   occupied        {"type":"error","code":"session.occupied"} on stdout, exit 4
//   lose-session    -S <id> is not found
//   context-echo    the answer "DONE\nsession <id> resumed=<bool> prompt=<chars> agentfile=<tools or ->"
//   kimi-sigterm    waits; on SIGTERM appends "SIGTERM <ms>" to AGENT_STUB_SIGNALS and exits 143, as kimi does after
//                   its cleanup
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const VERSION = "2.4.1";
// Commander options of the main command (AKC/cli/commands.ts): 0 a switch, 1 a value, "?" an optional value.
const OPTIONS = {
  "-V": 0, "--version": 0, "-h": 0, "--help": 0, "-S": "?", "--session": "?", "-r": "?", "--resume": "?", "-c": 0, "--continue": 0,
  "-C": 0, "-y": 0, "--yolo": 0, "--yes": 0, "--auto-approve": 0, "--auto": 0, "-m": 1, "--model": 1, "-p": 1, "--prompt": 1,
  "--output-format": 1, "--skills-dir": 1, "--agent": 1, "--agent-file": 1, "--add-dir": 1, "--plan": 0,
};
const HELP = [
  ["--version", "-V, --version", "output the version number"],
  ["--session", "-S, --session [id]", "Resume a session"],
  ["--continue", "-c, --continue", "Continue the most recent session in this directory"],
  ["--yolo", "-y, --yolo", "Approve every tool call"],
  ["--auto", "--auto", "Auto permission mode"],
  ["--model", "-m, --model <model>", "LLM model alias"],
  ["--prompt", "-p, --prompt <prompt>", "Run one prompt non-interactively"],
  ["--output-format", "--output-format <format>", "text or stream-json (prompt mode)"],
  ["--skills-dir", "--skills-dir <dir>", "Skills directory (replaces discovery)"],
  ["--agent", "--agent <name>", "Main agent"],
  ["--agent-file", "--agent-file <path>", "Main agent file"],
  ["--add-dir", "--add-dir <dir>", "Additional directory"],
  ["--plan", "--plan", "Start in plan mode"],
];

const line = (value) => `${JSON.stringify(value)}\n`;
const env = process.env;
const fail = (message, code = 1) => {
  process.stderr.write(`error: ${message}\n`);
  return code;
};

// Commander-like parse: { opts, error }.
function parse(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) return { error: `unknown command '${arg}'` };
    const [name, inline] = arg.includes("=") && arg.startsWith("--") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!(name in OPTIONS)) return { error: `unknown option '${name}'` };
    const arity = OPTIONS[name];
    let value = true;
    if (arity === 1) {
      value = inline ?? argv[++i];
      if (value === undefined) return { error: `option '${name}' argument missing` };
    } else if (arity === "?") {
      if (inline !== undefined) value = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) value = argv[++i];
    }
    const key = { "-S": "session", "--session": "session", "-r": "session", "--resume": "session", "-c": "continue", "--continue": "continue", "-C": "continue",
      "-y": "yolo", "--yolo": "yolo", "--yes": "yolo", "--auto-approve": "yolo", "-m": "model", "--model": "model", "-p": "prompt", "--prompt": "prompt" }[name] ?? name.replace(/^-+/, "");
    if (Array.isArray(opts[key])) opts[key].push(value);
    else if (key === "add-dir" || key === "skills-dir") opts[key] = [value];
    else opts[key] = value;
  }
  return { opts };
}

// The prompt-mode checks of AKC/cli/options.ts, in its order; the message or null.
function conflict(o) {
  const promptMode = o.prompt !== undefined;
  if (promptMode && String(o.prompt).trim() === "") return "Prompt cannot be empty.";
  if (o.model !== undefined && String(o.model).trim() === "") return "Model cannot be empty.";
  if (!promptMode && o["output-format"] !== undefined) return "Output format is only supported in prompt mode.";
  if (promptMode && o.yolo) return "Cannot combine --prompt with --yolo.";
  if (promptMode && o.auto) return "Cannot combine --prompt with --auto.";
  if (promptMode && o.plan) return "Cannot combine --prompt with --plan.";
  if ((o.agent !== undefined || o["agent-file"] !== undefined) && (o.session !== undefined || o.continue)) return "Cannot combine --agent / --agent-file with --session or --continue.";
  if (promptMode && o.session === true) return "Cannot use --session without an id in prompt mode.";
  if (o.continue && o.session !== undefined) return "Cannot combine --continue with --session.";
  if (o["output-format"] !== undefined && !["text", "stream-json"].includes(o["output-format"])) return `option '--output-format <format>' argument '${o["output-format"]}' is invalid.`;
  return null;
}

const homeOf = () => env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
const sessionsFile = () => path.join(homeOf(), "stub-sessions.json");
function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile(), "utf8"));
  } catch {
    return {};
  }
}
function saveSession(id) {
  const all = readSessions();
  all[id] = { cwd: process.cwd(), turns: (all[id]?.turns ?? 0) + 1 };
  fs.mkdirSync(homeOf(), { recursive: true });
  fs.writeFileSync(sessionsFile(), JSON.stringify(all));
}

// What config.toml says (a line-based read of the shapes the adapter writes): the api_key_env names and the aliases.
function configOf() {
  let text;
  try {
    text = fs.readFileSync(path.join(homeOf(), "config.toml"), "utf8");
  } catch {
    return null;
  }
  const keyVars = [...text.matchAll(/^api_key_env\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  const models = [...text.matchAll(/^\[models\."([^"]+)"\]/gm)].map((m) => m[1]);
  return { keyVars, models };
}

let parsed = null;
const opts = () => parsed?.opts ?? {};

// A failed turn: kimi prints the version line, then the error on stderr.
function failedTurn(io, codeAndMessage) {
  io.write(line({ role: "meta", type: "system.version", version: VERSION }));
  process.stderr.write(`error: failed to run prompt: ${codeAndMessage}\nSee log: ${path.join(homeOf(), "logs", "kimi-code.log")}\n`);
  process.exitCode = 1;
}

function completed(io, sessionId, lines) {
  io.write(line({ role: "meta", type: "system.version", version: VERSION }));
  for (const value of lines) io.write(line(value));
  saveSession(sessionId);
  io.write(line({ role: "meta", type: "session.resume_hint", session_id: sessionId, command: `kimi -r ${sessionId}`, content: `To resume this session: kimi -r ${sessionId}` }));
}

module.exports = {
  name: "kimi-jsonl",
  version: VERSION,
  flags: HELP.map(([flag]) => flag),
  help(flags) {
    const rows = HELP.filter(([flag]) => flags.includes(flag)).map(([, usage, text]) => `  ${usage.padEnd(28)} ${text}`);
    return `Usage: kimi [options] [command]\n\nOptions:\n${rows.join("\n")}\n  -h, --help                   display help for command\n`;
  },

  // Runs before every mode: the argument checks, the resume lookup, the key and model checks of config.toml. Returns
  // an exit code when the run ends here, else false. --version / --help are left to agent-stub.cjs.
  answer(argv, io) {
    if (argv.includes("--version") || argv.includes("-V") || argv.includes("--help") || argv.includes("--print-env")) return false;
    parsed = parse(argv);
    if (parsed.error) return fail(parsed.error);
    const o = parsed.opts;
    const message = conflict(o);
    if (message) return fail(message);
    if (o.prompt === undefined) return fail("the stub runs prompt mode only (-p)");
    const sessionId = typeof o.session === "string" ? o.session : null;
    if (sessionId) {
      const known = env.AGENT_STUB_MODE === "lose-session" ? undefined : readSessions()[sessionId];
      if (!known) return fail(`failed to run prompt: Session "${sessionId}" not found.`);
      if (known.cwd !== process.cwd()) {
        process.stderr.write(`Session "${sessionId}" was created under a different directory.\n  cd "${known.cwd}" && kimi -r ${sessionId}\n`);
        return 1;
      }
    }
    const config = configOf();
    if (config) {
      for (const name of config.keyVars) {
        if (!env[name]) {
          io.write(line({ role: "meta", type: "system.version", version: VERSION }));
          return fail(`failed to run prompt: Provider "agent-dispatch" declares api_key_env = "${name}" in config.toml, but the environment variable is not set or is empty.`);
        }
      }
      if (o.model !== undefined && !config.models.includes(o.model)) return fail(`failed to run prompt: config.invalid: Model "${o.model}" is not configured in config.toml.`);
    }
    return false;
  },

  sessionId(flag) {
    const resumed = typeof opts().session === "string" ? opts().session : null;
    return resumed ?? `session_${crypto.randomUUID()}`;
  },
  final({ sessionId, text }) {
    let out = line({ role: "meta", type: "system.version", version: VERSION });
    out += line({ role: "assistant", content: text });
    saveSession(sessionId);
    out += line({ role: "meta", type: "session.resume_hint", session_id: sessionId, command: `kimi -r ${sessionId}`, content: `To resume this session: kimi -r ${sessionId}` });
    return out;
  },
  error({ message }) {
    process.stderr.write(`error: failed to run prompt: ${message}\n`);
    process.exitCode = 1;
    return line({ role: "meta", type: "system.version", version: VERSION });
  },

  modes: {
    auth: (io) => failedTurn(io, "provider.auth_error: 401 Invalid Authentication"),
    quota: (io) => failedTurn(io, "provider.api_error: exceeded_current_quota_error: Your account exceeded your current token quota"),
    "rate-limit": (io) => {
      io.write(line({ role: "meta", type: "system.version", version: VERSION }));
      io.write(line({ role: "meta", type: "turn.step.retrying", failed_attempt: 1, next_attempt: 2, max_attempts: 10, delay_ms: 500, error_name: "APIProviderRateLimitError", error_message: "429 Too Many Requests", status_code: 429 }));
      process.stderr.write("error: failed to run prompt: provider.rate_limit: 429 Too Many Requests\n");
      process.exitCode = 1;
    },
    "model-missing": (io) => failedTurn(io, `config.invalid: Model "${opts().model}" is not configured in config.toml.`),
    context: (io) => failedTurn(io, "context.overflow: the prompt exceeds the maximum context length"),
    "max-steps": (io) => failedTurn(io, "loop.max_steps_exceeded: Turn exceeded maxSteps=3."),
    server: (io) => failedTurn(io, "provider.connection_error: Connection error: socket hang up"),
    "ends-on-tool": (io) =>
      completed(io, io.sessionId, [{ role: "assistant", content: "Let me check.", tool_calls: [{ type: "function", id: "call_1", function: { name: "Read", arguments: "{\"path\":\"a.txt\"}" } }] }]),
    "no-hint": (io) => {
      io.write(line({ role: "meta", type: "system.version", version: VERSION }));
      io.write(line({ role: "assistant", content: env.AGENT_STUB_RESPONSE || "DONE\nno hint" }));
    },
    occupied: (io) => {
      io.write(line({ type: "error", code: "session.occupied", message: "Session is in use by another process.", details: {} }));
      process.exitCode = 4;
    },
    "context-echo": (io) => {
      const o = opts();
      let tools = "-";
      if (typeof o["agent-file"] === "string") {
        const text = fs.readFileSync(o["agent-file"], "utf8");
        tools = [...text.matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1]).join(",");
      }
      const resumed = typeof o.session === "string";
      completed(io, io.sessionId, [
        { role: "assistant", content: "Reading.", tool_calls: [{ type: "function", id: "call_1", function: { name: "Read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "x" },
        { role: "assistant", content: `DONE\nsession ${io.sessionId} resumed=${resumed} prompt=${String(o.prompt).length} agentfile=${tools}` },
      ]);
    },
    "kimi-sigterm": (io) => {
      process.on("SIGTERM", () => {
        io.appendLine(env.AGENT_STUB_SIGNALS, `SIGTERM ${Date.now()}`);
        process.exit(143);
      });
      io.forever();
    },
  },
};
