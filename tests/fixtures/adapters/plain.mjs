// A trivial adapter for the core tests (tests/test-agent-core.sh): drives tests/fixtures/agent-stub.cjs in its
// "plain" dialect (newline-delimited JSON events). It exercises the whole adapter contract of spec §3.2 — discover,
// prepareHome, invocation, reduce, finalize, scrub, resumeCheck, patterns — with no harness behind it.
//
// Environment it asks for: defaults PLAIN_TELEMETRY / PLAIN_MODE (§3.6 Б), mandatory PLAIN_SAFE / PLAIN_JOB_DIR and
// a removed PLAIN_DROPPED (§3.6 А), the key in PLAIN_API_KEY when the profile has a key-based `auth`, and
// PLAIN_HOME_DIR for `"home": "isolated"`. Its "native home variable" is CLAUDE_CONFIG_DIR, because ENV_DENY strips
// CLAUDE_* and the re-admission hook is what is under test. The binary is the profile's `bin`, else
// $AGENT_TEST_STUB (the test's per-run link to the stub, so every process of a run carries the run's temp root in
// its argv), else the stub itself.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent-stub.cjs");

const defaultBin = (ctx) => ctx?.env?.AGENT_TEST_STUB || STUB;
const binOf = (req, ctx) => req.harness?.bin ?? req.profile.bin ?? defaultBin(ctx);
// Where a session of this profile lives — what resume must find again (spec §3.6 А12).
const homeDirOf = (profile, ctx) => (profile.home === "isolated" ? path.join(ctx.paths.homes, ctx.profileName) : (ctx.env.CLAUDE_CONFIG_DIR ?? null));

function reduce(io) {
  let sessionId = null;
  let final = null;
  let error = null;
  for (const event of io.events) {
    if (event?.type === "session" && typeof event.id === "string") sessionId = event.id;
    else if (event?.type === "final" && typeof event.text === "string") final = event;
    else if (event?.type === "error") error = event;
  }
  if (final && !error) {
    return { ok: true, response: final.text, sessionId, usage: final.usage ?? null, reportedModel: final.model ?? null, errorClass: null, errorText: null };
  }
  return {
    ok: false,
    response: null,
    sessionId,
    usage: null,
    reportedModel: null,
    errorClass: typeof error?.class === "string" ? error.class : null,
    errorText: typeof error?.message === "string" ? error.message : null,
  };
}

const plain = {
  id: "plain",
  idPrefix: "pt",
  manifest: {
    sessionId: "preassign",
    sessionIdFormat: "uuid",
    cancel: { ladder: [["SIGTERM", 1500], ["SIGKILL", 0]] },
    helpArgv: ["--help"],
    requiredFlags: ["--plain-json", "--session-id"],
    homeEnv: ["CLAUDE_CONFIG_DIR"],
  },
  // profile.discoverTimeoutMs / discoverGraceMs (tests): the deadline and the grace of the --version call, else
  // ctx.exec's defaults.
  discover(ctx) {
    const bin = ctx.profile.bin ?? defaultBin(ctx);
    const r = ctx.exec(bin, ["--version"], {
      ...(ctx.profile.discoverTimeoutMs ? { timeoutMs: ctx.profile.discoverTimeoutMs } : {}),
      ...(ctx.profile.discoverGraceMs ? { graceMs: ctx.profile.discoverGraceMs } : {}),
    });
    if (r.error || r.status !== 0) throw Object.assign(new Error(`cannot run ${bin} --version`), { errorClass: "launch" });
    return { bin, version: /\d+\.\d+\.\d+\S*/.exec(r.stdout)?.[0] ?? null };
  },
  prepareHome(profile, ctx) {
    if (profile.home !== "isolated") return { env: {}, dirs: [], files: [] };
    const dir = homeDirOf(profile, ctx);
    return {
      env: { PLAIN_HOME_DIR: dir },
      dirs: [path.join(dir, "sessions")],
      files: [{ path: path.join(dir, "settings.json"), mode: 0o600, content: "{}\n" }],
    };
  },
  invocation(req, ctx) {
    const keyed = req.profile.auth !== null && typeof req.profile.auth === "object";
    return {
      argv: [
        binOf(req, ctx),
        "--plain-json",
        "--session-id",
        req.sessionId ?? "-",
        req.write ? "--write" : "--read-only",
        ...(req.resume ? ["--resume", req.resume.sessionId] : []),
        ...(req.profile.model ? ["--model", req.profile.model] : []),
      ],
      // With profile.checkScrub the stub records its environment (the key too) into the job dir, as pi keeps what it
      // saw in its session files; scrub() hands that file back to the core.
      env: { PLAIN_TELEMETRY: "0", PLAIN_MODE: "default", ...(req.profile.checkScrub ? { AGENT_STUB_RECORD: path.join(req.job.dir, "transcript.json") } : {}) },
      mandatoryEnv: { PLAIN_SAFE: "1", PLAIN_JOB_DIR: req.job.dir, PLAIN_DROPPED: null },
      secretEnv: keyed ? ["PLAIN_API_KEY"] : [],
      stdinPath: req.prompt.path,
      cwd: req.job.cwd,
      files: [{ path: path.join(req.job.dir, "plain.cfg"), mode: 0o600, content: `model=${req.profile.model ?? "stub"}\n` }],
      meta: { homeDir: homeDirOf(req.profile, ctx) },
    };
  },
  reduce,
  // The effective-config hook runs after generated files exist; default subprocesses omit the key, exact-env
  // opt-in exposes it only to the same trusted harness binary for credential-dependent config evaluation.
  // checkBeforeLaunch="reject" proves the hook executes on fresh jobs, resumes and probes before a model run.
  beforeLaunch(req, ctx) {
    if (!req.profile.checkBeforeLaunch) return;
    if (!ctx.fs.readFile(path.join(req.job.dir, "plain.cfg"))?.startsWith("model=")) throw new Error("beforeLaunch ran before materialize");
    const show = (name) => ctx.execHarness(["--print-env", name], { env: { PLAIN_API_KEY: "must-not-override" }, cwd: "/" }).stdout.trim();
    if ("PLAIN_API_KEY" in ctx.env || show("PLAIN_API_KEY") !== "" || show("PLAIN_SAFE") !== "1") throw new Error("beforeLaunch received an unsafe environment");
    if (req.profile.auth?.keyEnv && (req.profile.auth.keyEnv in ctx.env || show(req.profile.auth.keyEnv) !== "")) throw new Error("beforeLaunch received the source key");
    const keyed = req.profile.auth !== null && typeof req.profile.auth === "object";
    const exactKey = ctx.execHarness(["--print-env", "PLAIN_API_KEY"], { includeSecrets: true }).stdout.trim();
    if (keyed && exactKey === "") throw new Error("beforeLaunch exact-env opt-in lost the key");
    if (req.profile.checkBeforeLaunchAlias && ctx.execHarness(["--print-env", req.profile.auth.keyEnv], { includeSecrets: true }).stdout.trim() !== exactKey) throw new Error("beforeLaunch exact-env opt-in lost the source alias");
    if (req.profile.wrap?.includes("WRAPPED=yes") && show("WRAPPED") !== "yes") throw new Error("beforeLaunch bypassed the wrap");
    if (req.profile.checkBeforeLaunch === "reject") throw new Error(`beforeLaunch verified ${req.job.id === null ? "probe" : req.resume ? "resume" : "fresh"}; rejected before harness launch`);
  },
  // With profile.checkFinalize: a second harness process, as opencode export would run it, reports what it saw.
  finalize(job, ctx) {
    if (!ctx.profile.checkFinalize) return null;
    const show = (name) => ctx.execHarness(["--print-env", name]).stdout.trim();
    return { meta: { finalize: { wrapped: show("WRAPPED"), safe: show("PLAIN_SAFE"), key: show("PLAIN_API_KEY"), envHasKey: "PLAIN_API_KEY" in job.env, wrap: job.wrap } } };
  },
  // With profile.checkScrub: the stub's transcript.json, redacted, mode 0640 (profile.checkScrub "throw": a scrub()
  // that fails).
  scrub(job, ctx) {
    if (!ctx.profile.checkScrub) return [];
    if (ctx.profile.checkScrub === "throw") throw new Error("scrub broke on purpose");
    const file = path.join(job.dir, "transcript.json");
    const text = ctx.fs.readFile(file);
    return text === null ? [] : [{ path: file, mode: 0o640, content: ctx.redact(text) }];
  },
  patterns: {
    "resume-lost": ["No conversation found"],
    auth: [/\b401\b/, "unauthorized"],
    quota: ["insufficient balance"],
    context: ["prompt is too long"],
    "rate-limit": [/\b429\b/],
    transient: ["ECONNRESET"],
  },
  resumeCheck(prev, profile, req, ctx) {
    if (prev.cwd !== req.job.cwd) return `session was started in ${prev.cwd}, not ${req.job.cwd}`;
    const now = homeDirOf(profile, ctx);
    const then = prev.meta?.homeDir ?? null;
    return then === now ? null : `session lives in config dir ${then ?? "(default)"}, not ${now ?? "(default)"}`;
  },
};

// The same adapter with dsh's SIGINT-first ladder (shortened for the tests).
export const plainSigint = { ...plain, id: "plain-sigint", manifest: { ...plain.manifest, cancel: { ladder: [["SIGINT", 1500], ["SIGKILL", 0]] } } };

// The same adapter with a long first step, so a test can interrupt a ladder between its SIGTERM and its SIGKILL.
export const plainLongLadder = { ...plain, id: "plain-long-ladder", manifest: { ...plain.manifest, cancel: { ladder: [["SIGTERM", 3000], ["SIGKILL", 0]] } } };

// The plain adapter misbehaving on purpose (profile.leak): it copies the key from the caller's environment
// (auth.keyEnv) into argv, into a file it asks for, or into a discover() error — what the core must refuse or redact.
// profile.rejectPlan: invocation() rejects the profile (as an adapter refusing an invalid option does).
const leakedKey = (ctx) => ctx.env[ctx.profile.auth?.keyEnv] ?? "";
export const plainLeak = {
  ...plain,
  id: "plain-leak",
  discover(ctx) {
    if (ctx.profile.leak === "discover") throw new Error(`cannot start with key ${leakedKey(ctx)}`);
    return plain.discover(ctx);
  },
  invocation(req, ctx) {
    if (req.profile.rejectPlan) throw new Error(`unsupported option ${req.profile.rejectPlan}`);
    const inv = plain.invocation(req, ctx);
    if (req.profile.leak === "argv") inv.argv = [...inv.argv, "--token", leakedKey(ctx)];
    if (req.profile.leak === "file") inv.files = [...inv.files, { path: path.join(req.job.dir, "leak.cfg"), content: `key=${leakedKey(ctx)}\n` }];
    return inv;
  },
};

// The plain adapter with a probe() hook of its own that reads req.harness (as an adapter whose probe turn needs the
// discovered binary may): runProbe must call it only once the harness is known. Its argv says it was used.
export const plainProbe = {
  ...plain,
  id: "plain-probe",
  probe(req, ctx) {
    const inv = plain.invocation(req, ctx);
    return { ...inv, argv: [req.harness.bin, ...inv.argv.slice(1), "--model", `probe-of-${req.harness.version}`] };
  },
};

export default plain;
