#!/usr/bin/env node
// Test stand-in for ZCode's zcode.cjs, selected via ZCODE_BIN. Never calls a model.
// ZCODE_STUB_MODE: ok | pong | resume | record | leak | linger | model-not-selected | auth | quota |
//                  launch | hang | ignore-term | split-utf8 | crash | malformed
// ZCODE_STUB_RECORD: file the `record` mode writes, including envAll and
// `resolved`, the stub's model of where the CLI keeps its state; ZCODE_STUB_DELAY_MS: wait before acting;
// ZCODE_STUB_MESSAGE: stderr text for the four error modes; ZCODE_STUB_TERM_DELAY_MS: how long ignore-term waits after SIGTERM before exiting;
// ZCODE_STUB_EXIT: the exit code of the `leak` mode (default 0); ZCODE_STUB_PIDFILE: a file the stub (and the
// lingering descendant of `linger`) appends its pid to.
// Tests explicitly list ZCODE_STUB_* in ZCODE_ENV_PASSTHROUGH because the wrapper filters the CLI env.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const argv = process.argv.slice(2);
const mode = process.env.ZCODE_STUB_MODE || "ok";
if (process.env.ZCODE_STUB_PIDFILE) fs.appendFileSync(process.env.ZCODE_STUB_PIDFILE, `${process.pid}\n`);
if (mode === "ignore-term") {
  process.on("SIGTERM", () => setTimeout(() => process.exit(0), Number(process.env.ZCODE_STUB_TERM_DELAY_MS || 2000)));
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId = flag("--resume") || `sess_stub_${process.pid}`;
// `leak` also prints the personal config as it was when the process started (a key read early, then rotated).
const configAtStart = (() => {
  try {
    return fs.readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8");
  } catch {
    return "";
  }
})();

function emit(response) {
  process.stdout.write(
    `${JSON.stringify({
      sessionId,
      traceId: "trace_stub",
      turnId: "turn_stub",
      response,
      usage: { inputTokens: 100, cacheReadTokens: 40, outputTokens: 7, reasoningTokens: 3 },
      eventCount: 1,
    })}\n`,
  );
}

function fail(defaultMessage) {
  process.stderr.write(`Error: ${process.env.ZCODE_STUB_MESSAGE || defaultMessage}\n`);
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
  });
}

// Where the real CLI (zcode.cjs 3.15.1) would put its state with this environment — a model of its
// resolvers (docs/zcode-cli-findings.md, "CLI data home"): the credential store (Vta: ZCODE_DATA_BASE_DIR,
// else HOME), the storage root (storage.dir: ZCODE_STORAGE_DIR, else ~/.zcode), the session database
// (storage.sessionDbPath: ZCODE_SESSION_DB_PATH or its alias ZCODE_SESSION_DB, else
// ~/.zcode/cli/db/db.sqlite) and the logs (JB: ZCODE_LOG_DIR, else ~/.zcode/cli/log).
function resolvedPaths() {
  const env = process.env;
  const home = os.homedir();
  return {
    credentials: path.join(env.ZCODE_DATA_BASE_DIR || home, ".zcode", "v2", "credentials.json"),
    storageDir: env.ZCODE_STORAGE_DIR || path.join(home, ".zcode"),
    sessionDb: env.ZCODE_SESSION_DB_PATH || env.ZCODE_SESSION_DB || path.join(home, ".zcode", "cli", "db", "db.sqlite"),
    logDir: env.ZCODE_LOG_DIR || path.join(home, ".zcode", "cli", "log"),
  };
}

// Writes $ZCODE_STUB_RECORD: argv, stdin, cwd, selected wrapper env, all variables the CLI received
// (envAll), where it would resolve its state (resolvedPaths), and the personal provider config.
function writeStubRecord(stdin) {
  let personalConfig = null;
  try {
    personalConfig = JSON.parse(fs.readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8"));
  } catch {
    personalConfig = null;
  }
  fs.writeFileSync(
    process.env.ZCODE_STUB_RECORD,
    JSON.stringify({
      argv,
      stdin,
      cwd: process.cwd(),
      env: {
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? null,
        ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: process.env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE ?? null,
        ZCODE_APP_VERSION: process.env.ZCODE_APP_VERSION ?? null,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? null,
        ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR ?? null,
        ZCODE_STORAGE_DIR: process.env.ZCODE_STORAGE_DIR ?? null,
        ZCODE_SESSION_DB_PATH: process.env.ZCODE_SESSION_DB_PATH ?? null,
        ZCODE_SESSION_DB: process.env.ZCODE_SESSION_DB ?? null,
        ZCODE_LOG_DIR: process.env.ZCODE_LOG_DIR ?? null,
        ZCODE_HTTP_PROXY: process.env.ZCODE_HTTP_PROXY ?? null,
      },
      envAll: { ...process.env },
      resolved: resolvedPaths(),
      personalConfig,
    }),
  );
}

async function run() {
  switch (mode) {
    case "ok":
      return emit("DONE\nstub finished");
    case "pong":
      return emit("PONG");
    case "resume":
      if (!flag("--resume")) fail("stub resume mode: --resume is missing");
      return emit("DONE\nresumed");
    case "record":
      writeStubRecord(flag("-p") === "-" ? await readStdin() : null);
      return emit("DONE\nrecorded");
    case "linger": {
      // A descendant outlives the CLI: it inherits the CLI's stderr but, like ZCode's tool processes, not fd 3
      // (the wrapper's config lock); it waits for the file $ZCODE_STUB_GO, writes one stderr line, creates
      // $ZCODE_STUB_DONE and exits.
      const script = `
        const fs = require("node:fs");
        if (process.env.ZCODE_STUB_PIDFILE) fs.appendFileSync(process.env.ZCODE_STUB_PIDFILE, process.pid + "\\n");
        process.stderr.on("error", () => {});
        const tick = setInterval(() => {
          if (!fs.existsSync(process.env.ZCODE_STUB_GO)) return;
          clearInterval(tick);
          try { process.stderr.write("late-line from a lingering descendant\\n"); } catch {}
          fs.writeFileSync(process.env.ZCODE_STUB_DONE, "done");
          setTimeout(() => process.exit(0), 100);
        }, 50);
        setTimeout(() => process.exit(0), 60000);`;
      require("node:child_process").spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "inherit"] }).unref();
      return emit("DONE\nlinger");
    }
    case "leak": {
      // Stand-in for GLM's shell printing the personal provider config (in api-key mode it holds the key),
      // now and as read at process start: the text goes to stderr in two chunks split inside the first key
      // value, then to the response (exit 0) or raw to stdout with exit ZCODE_STUB_EXIT.
      const now = fs.readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8");
      const text = `${now} || at start: ${configAtStart}`.replace(/\s+/g, " ");
      const at = text.indexOf('"apiKey":');
      const splitAt = at >= 0 ? text.indexOf('"', at + 9) + 6 : Math.floor(text.length / 2);
      process.stderr.write(`leaked: ${text.slice(0, splitAt)}`);
      setTimeout(() => {
        process.stderr.write(`${text.slice(splitAt)}\n`);
        const code = Number(process.env.ZCODE_STUB_EXIT || 0);
        if (code === 0) return emit(`DONE\n${text}`);
        process.stdout.write(`${text}\n`);
        return process.exit(code);
      }, 50);
      return undefined;
    }
    case "split-utf8": {
      const value = {
        sessionId,
        traceId: "trace_stub",
        turnId: "turn_stub",
        response: "Ответ: Привет ё",
        usage: { inputTokens: 100, cacheReadTokens: 40, outputTokens: 7, reasoningTokens: 3 },
        eventCount: 1,
      };
      const output = Buffer.from(`${JSON.stringify(value)}\n`);
      const splitAt = output.indexOf(Buffer.from("ё")) + 1;
      process.stdout.write(output.subarray(0, splitAt));
      setTimeout(() => process.stdout.write(output.subarray(splitAt)), 50);
      return undefined;
    }
    case "model-not-selected":
      return fail("Model creation failed — Select a model before continuing");
    case "auth":
      return fail("401 Unauthorized");
    case "quota":
      return fail("429 usage limit reached");
    case "launch":
      return fail("Cannot find module '@zcode/bootstrap'");
    case "hang":
      setTimeout(() => {}, 600_000);
      return undefined;
    case "ignore-term":
      setTimeout(() => {}, 600_000);
      return undefined;
    case "crash":
      process.kill(process.pid, "SIGKILL");
      return undefined;
    case "malformed":
      process.stdout.write("not json\n");
      return undefined;
    default:
      return fail(`unknown ZCODE_STUB_MODE: ${mode}`);
  }
}

setTimeout(run, Number(process.env.ZCODE_STUB_DELAY_MS || 0));
