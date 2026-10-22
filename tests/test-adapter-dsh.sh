#!/usr/bin/env bash
# Tests for bin/lib/adapters/dsh.mjs, the DeepSeek Harness adapter of agent-dispatch (increment 3 of
# docs/superpowers/specs/2026-10-20-universal-dispatchers-design.md §8, row 3). Zero model calls and no real dsh: the
# profiles' "bin" is a per-run link to tests/fixtures/agent-stub.cjs in its dsh-ndjson dialect
# (tests/fixtures/stub-dialects/dsh-ndjson.cjs), which reproduces dsh 0.2.1-rc.2 headless as
# docs/research/universal-dispatchers/04b-deepseek-harness.md documents it: argv grammar, NDJSON events, exit codes,
# sessions per cwd and DSH_HOME, key resolution, signals. Pure adapter functions are checked directly
# (node --input-type=module); every job runs through the real CLI (bin/lib/agent-dispatch.mjs) with all state under a
# temp root (AGENT_DISPATCH_STATE_DIR, HOME). Runs on macOS and Linux.
#
# Every process a run starts carries the run's temp root in its argv (runners: their jobs dir; the stub: the per-run
# link $DSH), so the cleanup and the leak check touch this run only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_ROOT/bin/lib/agent-dispatch.mjs"
CORE="$REPO_ROOT/bin/lib/agent-core.mjs"
ADAPTER="$REPO_ROOT/bin/lib/adapters/dsh.mjs"
FIX="$SCRIPT_DIR/fixtures"
STUB="$FIX/agent-stub.cjs"
WSTUB="$FIX/wrapper-stub.cjs"

FAILURES=0
PASSES=0
TEST_ROOT=""
OUT=""
ERR=""
RC=0

pass() {
    echo "  [PASS] $1"
    PASSES=$((PASSES + 1))
}
fail() {
    echo "  [FAIL] $1"
    FAILURES=$((FAILURES + 1))
}
# verdict <label> <condition-status> [detail...] — PASS when the status is 0, else FAIL with the details.
verdict() {
    local label="$1" ok="$2"
    shift 2
    if [[ "$ok" -eq 0 ]]; then
        pass "$label"
    else
        fail "$label"
        local line
        for line in "$@"; do echo "    $line"; done
    fi
}

cleanup() {
    # Only this run's processes (see the header). SIGKILL: some stub modes ignore SIGINT / SIGTERM by design.
    if [[ -n "$TEST_ROOT" ]]; then pkill -KILL -f "$TEST_ROOT" 2>/dev/null || true; fi
    if [[ -n "$TEST_ROOT" && -d "$TEST_ROOT" ]]; then rm -rf "$TEST_ROOT"; fi
}

ad() { node "$CLI" "$@"; }

# run_ad <args...> — run agent-dispatch; OUT = stdout, ERR = stderr, RC = exit code.
run_ad() {
    OUT="$(ad "$@" 2>"$TEST_ROOT/stderr.txt")"
    RC=$?
    ERR="$(cat "$TEST_ROOT/stderr.txt")"
}

# jfield <dot.path> — read JSON on stdin, print the field ('' when missing; objects as JSON).
jfield() {
    node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let v = JSON.parse(s);
  for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
  process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
});' "$1"
}

# ffield <file> <dot.path> — a field of a JSON file ('' when the file or the field is missing).
ffield() {
    if [[ -s "$1" ]]; then jfield "$2" <"$1"; fi
}

# jarr <args...> — the JSON array of the arguments.
jarr() { node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@"; }

# env_names <record> <prefix-regex> — the sorted env names of a stub record matching the regex, space-separated.
env_names() {
    node -e '
const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const re = new RegExp(process.argv[2]);
process.stdout.write(Object.keys(r.env).filter((n) => re.test(n)).sort().join(" "));' "$1" "$2"
}

# node_checks <label-prefix> <module body> — an ES module with `mod` (the adapter module), `dsh` (its default export),
# `core` and check(label, ok, detail) in scope; each check becomes a PASS / FAIL line, and a crash is one FAIL.
node_checks() {
    local prefix="$1" body="$2" out rc line
    out="$(ADAPTER="$ADAPTER" CORE="$CORE" node --input-type=module -e "
const { pathToFileURL } = await import('node:url');
const mod = await import(pathToFileURL(process.env.ADAPTER).href);
const dsh = mod.default;
const core = await import(pathToFileURL(process.env.CORE).href);
const check = (label, ok, detail = '') => console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || detail === '' ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
$body" 2>&1)"
    rc=$?
    while IFS= read -r line; do
        case "$line" in
            "PASS "*) pass "$prefix ${line#PASS }" ;;
            "FAIL "*)
                fail "$prefix ${line#FAIL }"
                ;;
            "") ;;
            *) echo "    $line" ;;
        esac
    done <<<"$out"
    if [[ "$rc" -ne 0 ]]; then fail "$prefix: the check script crashed (exit $rc)"; fi
}

# wait_status <id> <regex> <seconds> — poll until the core job's status matches; print it.
wait_status() {
    local id="$1" want="$2" limit="$3"
    local st="" i=0
    while ((i < limit * 5)); do
        st="$(ad status "$id" --json 2>/dev/null | jfield job.status || true)"
        if [[ "$st" =~ ^($want)$ ]]; then break; fi
        sleep 0.2
        i=$((i + 1))
    done
    echo "$st"
}

# wait_child <id> — wait until the runner has recorded childPid; print it.
wait_child() {
    local child="" i=0
    while ((i < 75)); do
        child="$(ad status "$1" --json 2>/dev/null | jfield job.childPid || true)"
        if [[ -n "$child" ]]; then break; fi
        sleep 0.2
        i=$((i + 1))
    done
    echo "$child"
}

# wait_file <file> — wait up to 10 s until the file exists and is not empty (the stub's readiness handshake).
wait_file() {
    local i=0
    while ((i < 50)); do
        if [[ -s "$1" ]]; then return 0; fi
        sleep 0.2
        i=$((i + 1))
    done
    return 1
}

# gone <pid...> — true once none of the processes exists (waits up to 5 s); false for no pid.
gone() {
    local i=0 pid alive
    if (($# == 0)); then return 1; fi
    for pid in "$@"; do [[ -n "$pid" ]] || return 1; done
    while ((i < 25)); do
        alive=0
        for pid in "$@"; do
            if kill -0 "$pid" 2>/dev/null; then alive=1; fi
        done
        if ((alive == 0)); then return 0; fi
        sleep 0.2
        i=$((i + 1))
    done
    return 1
}

# start <task args...> — run `task --background`; JOB = the new id (the last word of the start line), RC its exit.
JOB=""
start() {
    run_ad task --background "$@"
    JOB="${OUT##* }"
}

# finish <task args...> — start a job and wait until it is terminal; ST = its status, SJ = its status JSON.
ST=""
SJ=""
finish() {
    start "$@"
    ST="$(wait_status "$JOB" 'completed|failed|cancelled' 30)"
    SJ="$(ad status "$JOB" --json 2>/dev/null)"
}

now_ms() { node -e 'console.log(Date.now())'; }
mode_of() { node -e 'console.log((require("node:fs").statSync(process.argv[1]).mode & 0o777).toString(8))' -- "$1"; }

main() {
    echo "=== Test: dsh adapter (DeepSeek Harness) ==="

    TEST_ROOT="$(mktemp -d)"
    TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
    trap cleanup EXIT
    umask 022

    export HOME="$TEST_ROOT/home"
    mkdir -p "$HOME" "$TEST_ROOT/bin"
    export AGENT_DISPATCH_STATE_DIR="$TEST_ROOT/state"
    local STATE="$AGENT_DISPATCH_STATE_DIR"
    # The harness of this run: a link named dsh to the stub, under the temp root.
    local DSH="$TEST_ROOT/bin/dsh"
    ln -s "$STUB" "$DSH"
    ln -s "$WSTUB" "$TEST_ROOT/bin/zcode-dispatch"
    ln -s "$WSTUB" "$TEST_ROOT/bin/codex-dispatch"
    export AGENT_DISPATCH_ZCODE="$TEST_ROOT/bin/zcode-dispatch"
    export AGENT_DISPATCH_CODEX="$TEST_ROOT/bin/codex-dispatch"
    export WRAPPER_STUB_DIR="$TEST_ROOT/wrappers"
    printf '#!/bin/sh\nprintf "cmd-key-777\\n"\n' >"$TEST_ROOT/bin/keycmd"
    chmod +x "$TEST_ROOT/bin/keycmd"
    unset AGENT_DISPATCH_ADAPTER_DIR AGENT_TEST_BOOT_ID DSH_HOME DSH_AGENTS_HOME DSH_PERMISSION_MODE DSH_TELEMETRY_DISABLED
    unset DEEPSEEK_API_KEY DEEPSEEK_BASE_URL TEST_DS_KEY
    unset AGENT_STUB_MODE AGENT_STUB_RECORD AGENT_STUB_DELAY_MS AGENT_STUB_MESSAGE AGENT_STUB_CLASS AGENT_STUB_EXIT
    unset AGENT_STUB_RESPONSE AGENT_STUB_SECRET_VAR AGENT_STUB_SIGNALS AGENT_STUB_READY AGENT_STUB_EFFECTIVE
    unset AGENT_STUB_VERSION AGENT_STUB_SESSION_DELAY_MS AGENT_STUB_PIDS AGENT_STUB_CALL_LOG
    export AGENT_STUB_DIALECT=dsh-ndjson
    export AGENT_ENV_PASSTHROUGH="AGENT_STUB_DIALECT,AGENT_STUB_MODE,AGENT_STUB_RECORD,AGENT_STUB_DELAY_MS,AGENT_STUB_MESSAGE,AGENT_STUB_CLASS,AGENT_STUB_EXIT,AGENT_STUB_RESPONSE,AGENT_STUB_SECRET_VAR,AGENT_STUB_SIGNALS,AGENT_STUB_READY,AGENT_STUB_EFFECTIVE,AGENT_STUB_VERSION,AGENT_STUB_SESSION_DELAY_MS,AGENT_STUB_PIDS"
    # Secret-like caller variables the harness must never see (the core's allowlist, spec §3.6 A10).
    export ANTHROPIC_API_KEY="caller-anthropic-leak" UNRELATED_SECRET_TOKEN="caller-token-leak"

    local git_id=(-c user.email=t@example.com -c user.name=t -c commit.gpgsign=false)
    local r
    for r in repo repo2; do
        git init -q -b main "$TEST_ROOT/$r"
        printf 'x\n' >"$TEST_ROOT/$r/a.txt"
        (cd "$TEST_ROOT/$r" && git add a.txt && git "${git_id[@]}" commit -qm c0)
    done
    local repo repo2
    repo="$(cd "$TEST_ROOT/repo" && git rev-parse --show-toplevel)"
    repo2="$(cd "$TEST_ROOT/repo2" && git rev-parse --show-toplevel)"
    local prompt="$TEST_ROOT/prompt.md"
    printf '## Headless run\n\nImplement the thing — ёлка.\n' >"$prompt"
    local KEY="sk-dsh-test-0123456789abcdef"
    printf '%s\n' "$KEY" | ad key set deepseek >/dev/null

    mkdir -p "$TEST_ROOT/wrappers"
    cat >"$STATE/config.json" <<EOF
{
  "version": 1,
  "profiles": {
    "ds-key":     { "harness": "dsh", "auth": { "key": "deepseek" }, "model": "deepseek-v4-pro", "effort": "high", "bin": "$DSH" },
    "ds-rev":     { "harness": "dsh", "auth": { "key": "deepseek" }, "model": "deepseek-v4-pro", "effort": "max", "bin": "$DSH" },
    "ds-native":  { "harness": "dsh", "auth": "native", "model": "deepseek-flash", "effort": "low", "bin": "$DSH" },
    "ds-env":     { "harness": "dsh", "auth": { "keyEnv": "TEST_DS_KEY" }, "bin": "$DSH" },
    "ds-cmd":     { "harness": "dsh", "auth": { "keyCmd": ["$TEST_ROOT/bin/keycmd"] }, "model": "deepseek-v4-pro", "bin": "$DSH" },
    "ds-sbx":     { "harness": "dsh", "auth": { "key": "deepseek" }, "model": "deepseek-v4-pro", "effort": "max", "sandbox": "native", "bin": "$DSH" },
    "ds-iso":     { "harness": "dsh", "auth": { "key": "deepseek" }, "model": "deepseek-v4-pro", "home": "isolated", "bin": "$DSH" },
    "ds-opt":     { "harness": "dsh", "auth": { "key": "deepseek" }, "model": "deepseek-v4-pro", "effort": "max", "endpoint": "https://gw.example.test/anthropic", "bin": "$DSH",
                    "options": { "sessionLog": true, "agentsHome": "user",
                                 "patch": { "llm-deepseek": { "config": { "maxTokens": 64000, "apiKeyEnv": "DEEPSEEK_API_KEY" } },
                                            "tool-web": { "disabled": true },
                                            "plugin-package-inventory-deepseek": { "config": { "enabled": true } } } } },
    "ds-xhigh":   { "harness": "dsh", "auth": { "key": "deepseek" }, "model": "deepseek-v4-pro", "effort": "xhigh", "bin": "$DSH" },
    "ds-envdef":  { "harness": "dsh", "auth": { "key": "deepseek" }, "bin": "$DSH", "env": { "DSH_TELEMETRY_DISABLED": null, "DSH_AGENTS_HOME": "$TEST_ROOT/agents-custom" } },
    "ds-wrap":    { "harness": "dsh", "auth": { "key": "deepseek" }, "bin": "$DSH", "wrap": ["/usr/bin/env", "DSH_WRAPPED=yes"] },
    "ds-to":      { "harness": "dsh", "auth": { "key": "deepseek" }, "bin": "$DSH", "timeoutMin": 0.05 },
    "ds-missing": { "harness": "dsh", "auth": { "key": "deepseek" }, "bin": "$TEST_ROOT/bin/no-such-dsh" },
    "ds-badurl":  { "harness": "dsh", "auth": { "key": "deepseek" }, "bin": "$DSH", "options": { "patch": { "llm-deepseek": { "config": { "baseURL": "https://evil.example.test" } } } } },
    "ds-badkey":  { "harness": "dsh", "auth": { "key": "deepseek" }, "bin": "$DSH", "options": { "patch": { "llm-deepseek": { "config": { "apiKeyEnv": "OTHER_KEY" } } } } },
    "ds-baddis":  { "harness": "dsh", "auth": { "key": "deepseek" }, "bin": "$DSH", "options": { "patch": { "agent-default-model": { "disabled": true } } } },
    "ds-badrow":  { "harness": "dsh", "auth": { "key": "deepseek" }, "bin": "$DSH", "options": { "patch": { "tool-web": { "enabled": false } } } },
    "ds-conmode": { "harness": "dsh", "auth": { "key": "deepseek" }, "bin": "$DSH", "env": { "DSH_PERMISSION_MODE": "workspace-write" } },
    "ds-conkey":  { "harness": "dsh", "auth": { "key": "deepseek" }, "bin": "$DSH", "env": { "DEEPSEEK_API_KEY": "from-config" } },
    "ds-conhome": { "harness": "dsh", "auth": { "key": "deepseek" }, "bin": "$DSH", "home": "isolated", "env": { "DSH_HOME": "/elsewhere" } },
    "ds-nokey":   { "harness": "dsh", "auth": { "key": "absent" }, "bin": "$DSH" }
  },
  "roles": {}
}
EOF
    cd "$repo"
    local JOBS
    JOBS="$(CORE="$CORE" node --input-type=module -e "
const { pathToFileURL } = await import('node:url');
const core = await import(pathToFileURL(process.env.CORE).href);
console.log(core.resolveWorkspace(process.argv[1]).jobsDir);" -- "$repo")"
    # From here on a failing command must not end the suite: FAILURES decides the exit code, and the summary prints.
    set +e

    local rec eff sigs ready id id2 sid child runner t0 t1 st n line want got patch_file

    # =============================================================================================================
    # A. The adapter as data (spec §3.2): manifest, patch file, argv / env per auth mode and role, reduce, discover.
    # =============================================================================================================

    node_checks "A1" '
const m = dsh.manifest;
check("id dsh, job prefix dt-", dsh.id === "dsh" && dsh.idPrefix === "dt", [dsh.id, dsh.idPrefix]);
check("session id from the first event (cannot be preassigned)", m.sessionId === "first-event", m.sessionId);
check("cancel ladder SIGINT, at least 7 s, then SIGKILL", JSON.stringify(m.cancel.ladder) === JSON.stringify([["SIGINT", 7000], ["SIGKILL", 0]]), m.cancel.ladder);
check("no required help flags: the headless flags follow the launcher flags (spec §3.2: only the version is checked)", Array.isArray(m.requiredFlags) && m.requiredFlags.length === 0, m.requiredFlags);
check("native home variable DSH_HOME", JSON.stringify(m.homeEnv) === JSON.stringify(["DSH_HOME"]), m.homeEnv);
check("verified version 0.2.1-rc.2", JSON.stringify(m.verifiedVersions) === JSON.stringify(["0.2.1-rc.2"]), m.verifiedVersions);
for (const hook of ["discover", "prepareHome", "invocation", "probe", "reduce", "finalize", "resumeCheck", "doctorChecks"]) check(`hook ${hook}()`, typeof dsh[hook] === "function");
check("no loginEnv hook: profile env exports prepareHome().env, the one source of the isolated DSH_HOME", !("loginEnv" in dsh));
check("patterns cover auth, quota, model-not-selected, context, rate-limit, server, launch",
  ["auth", "quota", "model-not-selected", "context", "rate-limit", "server", "launch"].every((k) => Array.isArray(dsh.patterns[k]) && dsh.patterns[k].length > 0));
check("no resume-lost pattern: patterns see fresh jobs too, and a fresh job cannot lose a session", !("resume-lost" in dsh.patterns), Object.keys(dsh.patterns));
'

    node_checks "A2" '
const env = { HOME: "/h", PATH: process.env.PATH, AGENT_DISPATCH_STATE_DIR: "/data" };
const ctx = core.makeCtx({ env, profile: {}, profileName: "ds-x" });
const req = (profile, extra = {}) => ({ profile, profileName: "ds-x", role: null, write: false,
  job: { id: "dt-0001", dir: "/data/state/ws/jobs/dt-0001", cwd: "/repo", workspaceRoot: "/repo" },
  prompt: { path: "/data/state/ws/jobs/dt-0001/prompt.md", bytes: 10 }, sessionId: null, resume: null, harness: null, ...extra });
const patchPath = "/data/state/ws/jobs/dt-0001/dsh.patch.yml";
const golden = [
  "# Written by agent-dispatch (bin/lib/adapters/dsh.mjs). Each row replaces that row'"'"'s whole config; apiKeyEnv and baseURL are pinned.",
  "- id: \"agent-default-model\"",
  "  config: {\"provider\": \"deepseek-official\", \"model\": \"deepseek-v4-pro\", \"reasoningEffort\": \"high\"}",
  "- id: \"llm-deepseek\"",
  "  config: {\"apiKeyEnv\": \"DEEPSEEK_API_KEY\", \"baseURL\": \"https://api.deepseek.com/anthropic\", \"reasoningEffort\": \"high\"}",
  "- id: \"session-log-deepseek\"",
  "  config: {\"enabled\": false}",
  "- id: \"plugin-package-inventory-deepseek\"",
  "  config: {\"enabled\": false}",
  "- id: \"session-title-llm\"",
  "  disabled: true",
  ""].join("\n");
const keyed = { harness: "dsh", auth: { key: "deepseek" }, model: "deepseek-v4-pro", effort: "high", home: "user", sandbox: "off" };

// writer, key from the store
let inv = dsh.invocation(req(keyed, { write: true }), ctx);
check("writer/key argv: dsh --profile headless --patch <job>/dsh.patch.yml --json -",
  JSON.stringify(inv.argv) === JSON.stringify(["dsh", "--profile", "headless", "--patch", patchPath, "--json", "-"]), inv.argv);
check("writer/key: the prompt on stdin, cwd = the job cwd", inv.stdinPath === "/data/state/ws/jobs/dt-0001/prompt.md" && inv.cwd === "/repo", [inv.stdinPath, inv.cwd]);
check("writer/key: DSH_PERMISSION_MODE=danger-full-access is mandatory", JSON.stringify(inv.mandatoryEnv) === JSON.stringify({ DSH_PERMISSION_MODE: "danger-full-access" }), inv.mandatoryEnv);
check("writer/key: defaults DSH_TELEMETRY_DISABLED=1 and DSH_AGENTS_HOME=<data>/agents-empty",
  JSON.stringify(inv.env) === JSON.stringify({ DSH_TELEMETRY_DISABLED: "1", DSH_AGENTS_HOME: "/data/agents-empty" }), inv.env);
check("writer/key: the key goes to DEEPSEEK_API_KEY only", JSON.stringify(inv.secretEnv) === JSON.stringify(["DEEPSEEK_API_KEY"]), inv.secretEnv);
check("home user: DSH_HOME is re-admitted from the caller, nothing else", JSON.stringify(inv.inheritEnv) === JSON.stringify(["DSH_HOME"]), inv.inheritEnv);
check("the empty agents dir is created", JSON.stringify(inv.dirs) === JSON.stringify(["/data/agents-empty"]), inv.dirs);
check("one file: the patch, 0600", inv.files.length === 1 && inv.files[0].path === patchPath && inv.files[0].mode === 0o600, inv.files.map((f) => f.path));
check("the patch file, whole (A5 rows + Б defaults)", inv.files[0].content === golden, inv.files[0].content);
check("the patch never names the key value or a key-looking literal", !/sk-|apiKey"?\s*:/.test(inv.files[0].content));
check("meta: provider and model of the patch, baseURL, permission mode, DSH_HOME, patch",
  inv.meta.provider === "deepseek-official" && inv.meta.model === "deepseek-v4-pro" && inv.meta.baseURL === "https://api.deepseek.com/anthropic" && inv.meta.permissionMode === "danger-full-access" && inv.meta.dshHome === "/h/.dsh" && inv.meta.patch === patchPath, inv.meta);

// reviewer: read-only, the same argv
inv = dsh.invocation(req(keyed, { write: false }), ctx);
check("reviewer: DSH_PERMISSION_MODE=read-only", inv.mandatoryEnv.DSH_PERMISSION_MODE === "read-only", inv.mandatoryEnv);
check("reviewer: argv as the writer'"'"'s", JSON.stringify(inv.argv) === JSON.stringify(["dsh", "--profile", "headless", "--patch", patchPath, "--json", "-"]));

// sandbox native
const sbx = { ...keyed, sandbox: "native" };
check("sandbox native, writer: workspace-write", dsh.invocation(req(sbx, { write: true }), ctx).mandatoryEnv.DSH_PERMISSION_MODE === "workspace-write");
check("sandbox native, reviewer: still read-only", dsh.invocation(req(sbx, { write: false }), ctx).mandatoryEnv.DSH_PERMISSION_MODE === "read-only");
check("permissionMode(): writer off → danger-full-access, native → workspace-write, reviewer → read-only",
  mod.permissionMode(keyed, true) === "danger-full-access" && mod.permissionMode(sbx, true) === "workspace-write" && mod.permissionMode(sbx, false) === "read-only");

// auth native: no key variable at all
const native = { ...keyed, auth: "native" };
inv = dsh.invocation(req(native, { write: true }), ctx);
check("native: the adapter sets no DEEPSEEK_API_KEY (dsh reads $DSH_HOME/.env)", inv.secretEnv.length === 0 && !("DEEPSEEK_API_KEY" in inv.env) && !("DEEPSEEK_API_KEY" in inv.mandatoryEnv), inv);
check("native: the same patch rows (apiKeyEnv names the variable dsh resolves)", inv.files[0].content === golden);
for (const auth of [{ keyEnv: "X_KEY" }, { keyCmd: ["pass", "deepseek"] }]) {
  check(`auth ${Object.keys(auth)[0]}: the key in DEEPSEEK_API_KEY`, JSON.stringify(dsh.invocation(req({ ...keyed, auth }), ctx).secretEnv) === JSON.stringify(["DEEPSEEK_API_KEY"]));
}

// home isolated
const iso = { ...keyed, home: "isolated" };
const home = dsh.prepareHome(iso, ctx);
check("home isolated: DSH_HOME=<data>/homes/<profile>/dsh is mandatory and created",
  JSON.stringify(home.env) === JSON.stringify({ DSH_HOME: "/data/homes/ds-x/dsh" }) && JSON.stringify(home.dirs) === JSON.stringify(["/data/homes/ds-x/dsh"]), home);
inv = dsh.invocation(req(iso), ctx);
check("home isolated: no DSH_HOME re-admission; meta names the isolated home", inv.inheritEnv.length === 0 && inv.meta.dshHome === "/data/homes/ds-x/dsh", [inv.inheritEnv, inv.meta.dshHome]);
check("home user: prepareHome sets nothing", JSON.stringify(dsh.prepareHome(keyed, ctx).env) === "{}");
const ctxHome = core.makeCtx({ env: { ...env, DSH_HOME: "/custom/dsh" }, profile: {}, profileName: "ds-x" });
check("home user: the caller'"'"'s DSH_HOME is the session home", dsh.invocation(req(keyed), ctxHome).meta.dshHome === "/custom/dsh");

// options: agentsHome user, sessionLog, endpoint, patch
const opt = { ...keyed, effort: "max", endpoint: "https://gw.example.test/anthropic",
  options: { sessionLog: true, agentsHome: "user", patch: {
    "llm-deepseek": { config: { maxTokens: 64000, apiKeyEnv: "DEEPSEEK_API_KEY", baseURL: "https://gw.example.test/anthropic" } },
    "agent-default-model": { config: { model: "deepseek-flash" } },
    "tool-web": { disabled: true },
    "plugin-package-inventory-deepseek": { config: { enabled: true } } } } };
inv = dsh.invocation(req(opt), ctx);
const rows = mod.patchRows(opt);
const row = (id) => rows.find((r) => r.id === id);
check("agentsHome user: no DSH_AGENTS_HOME default; the caller'"'"'s is re-admitted",
  !("DSH_AGENTS_HOME" in inv.env) && inv.inheritEnv.includes("DSH_AGENTS_HOME") && inv.dirs.length === 0, [inv.env, inv.inheritEnv]);
check("sessionLog true: no session-log-deepseek row", !row("session-log-deepseek"), rows);
check("endpoint → baseURL of llm-deepseek; effort in both rows",
  row("llm-deepseek").config.baseURL === "https://gw.example.test/anthropic" && row("llm-deepseek").config.reasoningEffort === "max" && row("agent-default-model").config.reasoningEffort === "max", rows);
check("options.patch fields merge into the pinned rows (equal apiKeyEnv / baseURL pass)",
  row("llm-deepseek").config.maxTokens === 64000 && row("llm-deepseek").config.apiKeyEnv === "DEEPSEEK_API_KEY" && row("agent-default-model").config.model === "deepseek-flash" && row("agent-default-model").config.provider === "deepseek-official", rows);
check("options.patch adds rows and overrides defaults", row("tool-web").disabled === true && row("plugin-package-inventory-deepseek").config.enabled === true, rows);
check("meta.model is the model options.patch set, not the profile'"'"'s", inv.meta.model === "deepseek-flash", inv.meta);
check("rows keep the file order: pinned first, then defaults, then added", rows.map((r) => r.id).join(",") === "agent-default-model,llm-deepseek,plugin-package-inventory-deepseek,session-title-llm,tool-web", rows.map((r) => r.id));

// defaults when the profile names no model / effort / endpoint
const bare = mod.patchRows({ harness: "dsh", auth: { key: "k" } });
check("no model / effort: dsh'"'"'s own defaults deepseek-flash / high, written explicitly",
  JSON.stringify(bare[0].config) === JSON.stringify({ provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" }) && bare[1].config.baseURL === "https://api.deepseek.com/anthropic", bare.slice(0, 2));

// options.patch refusals (spec §3.6 A5)
const refused = (patch) => { try { mod.patchRows({ ...keyed, options: { patch } }); return null; } catch (error) { return error.message; } };
let msg = refused({ "llm-deepseek": { config: { baseURL: "https://evil.example.test" } } });
check("options.patch cannot move baseURL (it comes from endpoint)", /baseURL/.test(msg ?? "") && /endpoint/.test(msg ?? ""), msg);
msg = refused({ "llm-deepseek": { config: { apiKeyEnv: "OTHER_KEY" } } });
check("options.patch cannot rename apiKeyEnv", /apiKeyEnv/.test(msg ?? ""), msg);
msg = refused({ "agent-default-model": { disabled: true } });
check("options.patch cannot disable a pinned row", /agent-default-model/.test(msg ?? "") && /disabled/.test(msg ?? ""), msg);
msg = refused({ "llm-deepseek": { disabled: false } });
check("options.patch cannot touch disabled on llm-deepseek either", /llm-deepseek/.test(msg ?? ""), msg);
msg = refused({ "tool-web": { enabled: false } });
check("options.patch rows are { config } and/or { disabled }", /tool-web/.test(msg ?? "") && /config/.test(msg ?? ""), msg);
msg = refused({ "tool-web": { config: "off" } });
check("options.patch config must be an object", /config/.test(msg ?? ""), msg);
msg = refused({ "bad id!": { disabled: true } });
check("options.patch row ids are plain names", /row id/.test(msg ?? ""), msg);
for (const id of ["sandbox-policy", "approval-policy", "permission-presets", "fs-sandbox"]) {
  msg = refused({ [id]: { config: { mode: "danger-full-access" } } });
  const off = refused({ [id]: { disabled: true } });
  check(`options.patch cannot touch ${id} (it carries the permission mode, A4)`, new RegExp(id).test(msg ?? "") && /sandbox/.test(msg ?? "") && off !== null, [msg, off]);
}
msg = refused({ "agent-instructions": { disabled: true } });
check("options.patch cannot disable agent-instructions (project AGENTS.md / CLAUDE.md, A6)", /agent-instructions/.test(msg ?? "") && /CLAUDE\.md/.test(msg ?? ""), msg);
check("options.patch may still configure agent-instructions", refused({ "agent-instructions": { config: { budget: 65536 } } }) === null && refused({ "agent-instructions": { disabled: false } }) === null);
let threw = null;
try { dsh.invocation(req({ ...keyed, options: { patch: { "llm-deepseek": { config: { baseURL: "https://x.test" } } } } }), ctx); } catch (error) { threw = error.message; }
check("invocation() refuses such a profile (task: exit 2, doctor: FAIL)", /baseURL/.test(threw ?? ""), threw);

// resume
inv = dsh.invocation(req(keyed, { resume: { sessionId: "session-1234-abcd", prev: {} } }), ctx);
check("resume: --session-id <id> after --json, the prompt still on stdin",
  JSON.stringify(inv.argv) === JSON.stringify(["dsh", "--profile", "headless", "--patch", patchPath, "--json", "--session-id", "session-1234-abcd", "-"]), inv.argv);
threw = null;
try { dsh.invocation(req(keyed, { resume: { sessionId: "--evil", prev: {} } }), ctx); } catch (error) { threw = error.message; }
check("resume: a session id that could pass for a flag is refused", threw !== null, threw);

// the discovered binary and wrap-independence
inv = dsh.invocation(req({ ...keyed, bin: "/opt/dsh/bin/dsh" }, { harness: { bin: "/found/dsh", version: "0.2.1-rc.2" } }), ctx);
check("argv[0] is the discovered binary", inv.argv[0] === "/found/dsh", inv.argv[0]);
check("argv[0] falls back to the profile bin", dsh.invocation(req({ ...keyed, bin: "/opt/dsh/bin/dsh" }), ctx).argv[0] === "/opt/dsh/bin/dsh");

// probe: one read-only PONG turn on the profile as configured, without web tools
const probe = dsh.probe(req(keyed), ctx);
check("probe: read-only, the same argv shape, tool-web disabled",
  probe.mandatoryEnv.DSH_PERMISSION_MODE === "read-only" && probe.argv.join(" ") === inv.argv.join(" ").replace("/found/dsh", "dsh") && /- id: "tool-web"\n  disabled: true/.test(probe.files[0].content), probe);

// the core sees the mandatory names (doctor / task env conflicts)
const owned = await core.mandatorySettings(dsh, keyed, ctx);
check("mandatory names: DSH_PERMISSION_MODE and DEEPSEEK_API_KEY", owned.names.sort().join(",") === "DEEPSEEK_API_KEY,DSH_PERMISSION_MODE", owned.names);
const ownedIso = await core.mandatorySettings(dsh, iso, ctx);
check("mandatory names with an isolated home add DSH_HOME", ownedIso.names.sort().join(",") === "DEEPSEEK_API_KEY,DSH_HOME,DSH_PERMISSION_MODE", ownedIso.names);
check("env conflicts: DSH_PERMISSION_MODE, DEEPSEEK_API_KEY; defaults are free",
  core.envConflicts({ DSH_PERMISSION_MODE: "danger-full-access", DEEPSEEK_API_KEY: "x", DSH_TELEMETRY_DISABLED: null, DSH_AGENTS_HOME: "/a" }, owned).join(",") === "DEEPSEEK_API_KEY,DSH_PERMISSION_MODE");
'

    node_checks "A2 launch guard" '
const profile = { harness: "dsh", auth: "native", home: "user", sandbox: "off" };
const req = { profile, write: false, job: { dir: "/data/jobs/dt-1", cwd: "/repo" } };
const rows = (mode = "read-only", policy = "ask") => `- id: sandbox-policy\n  config:\n    mode: ${JSON.stringify(mode)}\n- id: approval-policy\n  config:\n    policy: ${JSON.stringify(policy)}\n`;
const refusal = (stdout, extra = {}, result = {}) => {
  let call = null;
  const ctx = core.makeCtx({ env: { HOME: "/home/u" }, profile, profileName: "ds-x",
    execHarness: (argv, options) => (call = { argv, options }, { status: 0, stdout, stderr: "", error: null, ...result }) });
  try { dsh.beforeLaunch({ ...req, ...extra }, ctx); return { error: null, call }; }
  catch (error) { return { error, call }; }
};
let got = refusal(rows());
check("resolved read-only / ask passes using the materialized patch and an offline dump", !got.error &&
  JSON.stringify(got.call.argv) === JSON.stringify(["--profile", "headless", "--patch", "/data/jobs/dt-1/dsh.patch.yml", "--dump-config"]) &&
  got.call.options.timeoutMs === 60_000 && got.call.options.includeSecrets === true, got.error?.message ?? got.call);
for (const [name, dump] of [
  ["wider mode", rows("danger-full-access")], ["approval never", rows("read-only", "never")],
  ["unknown mode", rows("future-mode")], ["missing rows", "not a config dump"],
  ["missing approval", "- id: sandbox-policy\n  config: {\"mode\": \"read-only\"}\n"],
  ["disabled sandbox", rows().replace("  config:", "  disabled: true\n  config:")],
  ["enabled false sandbox", rows().replace("    mode:", "    enabled: false\n    mode:")],
  ["duplicate row", rows() + "- id: sandbox-policy\n  config: {\"mode\": \"read-only\"}\n"],
  ["unresolved expression", rows().replace("\"read-only\"", "${{ env.DSH_PERMISSION_MODE ?? \"workspace-write\" }}")],
]) {
  got = refusal(dump);
  check(`${name} fails closed with launch class`, got.error?.errorClass === "launch" && /harness not started/.test(got.error.message), got.error?.message);
}
got = refusal(rows(), {}, { status: 1, stderr: "credential-from-native-config" });
check("dump failure blocks the model turn without echoing native config diagnostics", got.error?.errorClass === "launch" &&
  !got.error.message.includes("credential-from-native-config"), got.error?.message);
for (const result of [{ signal: "SIGTERM" }, { timedOut: true }, { stopped: true }]) {
  got = refusal(rows(), {}, result);
  check(`an interrupted dump with status 0 still refuses launch (${Object.keys(result)[0]})`, got.error?.errorClass === "launch", got.error?.message);
}
got = refusal(rows("workspace-write"), { profile: { ...profile, sandbox: "native" }, write: true });
check("native writer accepts workspace-write", !got.error, got.error?.message);
got = refusal(rows("danger-full-access"), { profile: { ...profile, sandbox: "native" }, write: true });
check("native writer rejects danger-full-access", got.error?.errorClass === "launch", got.error?.message);
got = refusal("not checked", { write: true });
check("unrestricted writer keeps its requested full access without a permission fence", !got.error && got.call === null, got);
got = refusal(rows("workspace-write"), { resume: { sessionId: "previous" } });
check("resume is checked by the same policy", got.error?.errorClass === "launch", got.error?.message);
'

    node_checks "A3" '
const ev = (o) => o;
const session = ev({ type: "session", sessionId: "session-aaaa", cwd: "/repo" });
const turnEnd = (reason) => ({ type: "status", phase: "turn_end", turn: 1, reason });
const step = (usage) => ({ type: "status", phase: "step_end", turn: 1, step: 1, ...(usage ? { usage } : {}) });
const io = (events, { code = 1, signal = null, stderr = "", cancelled = false, resumed } = {}) => ({ events, stdout: "", stderrTail: stderr, exit: { code, signal }, timedOut: false, cancelled, ...(resumed === undefined ? {} : { resumed }) });
const R = dsh.reduce;

let r = R(io([session, { type: "status", phase: "turn_start", turn: 1 }, step({ inputTokens: 100, outputTokens: 5, totalTokens: 105, cacheReadTokens: 64 }), step({ inputTokens: 20, outputTokens: 3, reasoningTokens: 2 }),
  { type: "text", text: "DONE" }, turnEnd({ kind: "completed" }), { type: "final", text: "DONE\nall good\n" }], { code: 0 }));
check("completed: ok, response = final.text verbatim, session id from the session event",
  r.ok === true && r.response === "DONE\nall good\n" && r.sessionId === "session-aaaa" && r.errorClass === null, r);
check("usage is summed over step_end events", JSON.stringify(r.usage) === JSON.stringify({ inputTokens: 120, outputTokens: 8, totalTokens: 105, cacheReadTokens: 64, reasoningTokens: 2, steps: 2 }), r.usage);
r = R(io([session, { type: "session", sessionId: "session-later" }, turnEnd({ kind: "completed" }), { type: "final", text: "DONE" }], { code: 1 }));
check("the first session event wins; exit 1 with a completed turn is still success (exit codes are informational)", r.ok && r.sessionId === "session-aaaa", r);

const codes = {
  AUTH: "auth", MISSING_CREDENTIAL: "auth", INVALID_CREDENTIAL: "auth", ACCOUNT_SIGN_IN_REQUIRED: "auth", ACCOUNT_TOKEN_INVALID: "auth",
  QUOTA: "quota", ACCOUNT_QUOTA: "quota", RATE_LIMIT: "rate-limit",
  TRANSPORT: "server", SERVER: "server", TIMEOUT: "server", HTTP_500: "server", HTTP_503: "server", EMPTY_RESPONSE: "server", MALFORMED_RESPONSE: "server", STREAM_CLOSED: "server",
  HTTP_429: "rate-limit", HTTP_401: "auth", HTTP_403: "auth", HTTP_402: "quota", HTTP_404: "model-not-selected",
  INVALID_REQUEST: "model-not-selected", MODEL_UNSUPPORTED: "model-not-selected", UNSUPPORTED_REASONING_EFFORT: "model-not-selected", UNKNOWN_MODEL: "model-not-selected", CLIENT_UPGRADE_REQUIRED: "model-not-selected",
  CONTEXT_WINDOW_EXCEEDED: "context", SANDBOX_UNAVAILABLE: "launch",
};
const wrongTurn = [], wrongLine = [], wrongExit0 = [];
for (const [code, cls] of Object.entries(codes)) {
  const t = R(io([session, turnEnd({ kind: "error", error: { code, message: "m" } }), { type: "final", text: "" }], { stderr: `dsh: ${code}: m` }));
  if (t.ok || t.errorClass !== cls || !t.errorText.startsWith(code)) wrongTurn.push([code, t.errorClass]);
  const l = R(io([], { stderr: `some line\ndsh: ${code}: from stderr only\n` }));
  if (l.errorClass !== cls) wrongLine.push([code, l.errorClass]);
  const z = R(io([session, turnEnd({ kind: "error", error: { code, message: "m" } }), { type: "final", text: "" }], { code: 0 }));
  if (z.ok || z.errorClass !== cls) wrongExit0.push([code, z.errorClass]);
}
check(`turn_end error codes → classes (${Object.keys(codes).length} codes, spec §3.8)`, wrongTurn.length === 0, wrongTurn);
check("the stderr line dsh: <CODE>: <message> alone → the same classes", wrongLine.length === 0, wrongLine);
check("exit 0 with an error turn is not success (classified by turn_end)", wrongExit0.length === 0, wrongExit0);
r = R(io([session, turnEnd({ kind: "error", error: { code: "QUOTA", message: "Insufficient Balance" } }), { type: "final", text: "" }], { stderr: "dsh: SERVER: earlier\n" }));
check("the turn_end code wins over a stderr line; errorText carries code and message", r.errorClass === "quota" && r.errorText === "QUOTA: Insufficient Balance", r);
check("classOfCode: an unknown code is no class", mod.classOfCode("SOMETHING_NEW") === null && mod.classOfCode("HTTP_418") === null);

r = R(io([session, turnEnd({ kind: "max-tokens" }), { type: "final", text: "partial" }]));
check("turn_end max-tokens → context", r.errorClass === "context", r);
r = R(io([session, { type: "tool_call", callId: "c1", tool: "bash", input: {} }, { type: "tool_result", callId: "c1", status: "error", result: "denied" }, turnEnd({ kind: "blocked" }), { type: "final", text: "" }]));
check("turn_end blocked → blocked; errorText states only the kind (its cause is unverified)", r.errorClass === "blocked" && r.errorText === "turn ended: blocked", r);
r = R(io([session, turnEnd({ kind: "error", error: { message: "socket hang up" } }), { type: "final", text: "" }]));
check("an error turn without a code keeps its message in errorText", r.errorClass === null && r.errorText === "error: socket hang up", r);
r = R(io([session, turnEnd({ kind: "aborted" }), { type: "final", text: "" }], { code: 0 }));
check("aborted at exit 0 (an outside SIGTERM) is no success: crash", !r.ok && r.errorClass === "crash", r);
r = R(io([session, turnEnd({ kind: "aborted" }), { type: "final", text: "" }], { code: 130, cancelled: true }));
check("aborted after a cancel: no class (the record says cancelled)", !r.ok && r.errorClass === null, r);
// Only a completed turn is success: dsh exits 0 on SIGTERM and its final is only "often" empty [04b §3, §10], so
// neither the exit code nor a non-empty final may stand in for the turn_end kind.
for (const kind of ["aborted", "interrupted", "blocked"]) {
  r = R(io([session, { type: "text", text: "DONE\npartial" }, turnEnd({ kind }), { type: "final", text: "DONE\npartial" }], { code: 0 }));
  check(`${kind} at exit 0 with a non-empty final → not ok, no response (${kind === "blocked" ? "blocked" : "crash"})`,
    r.ok === false && r.response === null && r.errorClass === (kind === "blocked" ? "blocked" : "crash"), r);
}
r = R(io([session, { type: "final", text: "DONE\nno turn ended" }], { code: 0 }));
check("a non-empty final without any turn_end at exit 0 → not ok", r.ok === false && r.response === null, r);
r = R(io([session, turnEnd({ kind: "completed" })], { code: 0 }));
check("completed without a final event → malformed", r.errorClass === "malformed", r);
r = R(io([session, turnEnd({ kind: "completed" }), { type: "final", text: "  \n" }], { code: 1 }));
check("completed with an empty final → malformed", r.errorClass === "malformed", r);
r = R(io([], { stderr: "dsh: required plugin failed to activate\nFull diagnostics: /h/.dsh/logs/startup-1-x.log\n" }));
check("exit 1 before any session event → launch (with the diagnostics path)", r.errorClass === "launch" && /Full diagnostics/.test(r.errorText), r);
r = R(io([{ type: "error", message: "usage: dsh headless [--json] [task... | -]" }]));
check("a JSON error event before the session (usage error) → launch", r.errorClass === "launch" && /usage/.test(r.errorText), r);
// resume-lost (spec §3.6 А12): by structure on a resumed job, never on a fresh one.
const odd = { type: "error", message: "--session-id session-x: refused (nothing persisted under this id)" };
check("the stub'"'"'s refusal wording is not one the text heuristic knows (the structural path is what is tested)", !mod.LOST_SESSION_RE.test(odd.message));
r = R(io([odd], { resumed: true }));
check("resumed, exit 1 before the session event, no known code → resume-lost (whatever the wording)", r.errorClass === "resume-lost" && /refused/.test(r.errorText), r);
r = R(io([], { resumed: true, stderr: "dsh: SESSION_GONE: who knows\n" }));
check("resumed, an unknown dsh code before the session event → resume-lost", r.errorClass === "resume-lost", r);
r = R(io([], { resumed: true }));
check("resumed, exit 1 with no output at all → resume-lost with a text", r.errorClass === "resume-lost" && typeof r.errorText === "string" && r.errorText.length > 0, r);
r = R(io([odd]));
check("the same failure on a fresh job → launch", r.errorClass === "launch", r);
r = R(io([{ type: "error", message: "cannot resume session session-x: not found" }]));
check("lost-session wording on a fresh job is still launch (a fresh job cannot lose a session)", r.errorClass === "launch", r);
r = R(io([], { stderr: "dsh: profile headless failed to start\n  required plugin @deepseek-ai/dsh-session-persistence-jsonl: cannot load session store\nFull diagnostics: /h/.dsh/logs/startup-1.log\n" }));
check("a fresh boot failure naming a session-* plugin → launch", r.errorClass === "launch", r);
r = R(io([{ type: "error", message: "failed to load session-log-deepseek config" }]));
check("a fresh failure that mentions session-log-deepseek → launch", r.errorClass === "launch", r);
r = R(io([], { resumed: true, stderr: "dsh: profile headless failed to start\n  required plugin @deepseek-ai/dsh-session-persistence-jsonl: cannot load session store\nFull diagnostics: /h/.dsh/logs/startup-1.log\n" }));
check("a resumed boot failure (Full diagnostics) → launch, not resume-lost", r.errorClass === "launch", r);
r = R(io([], { resumed: true, stderr: "dsh: refusing proxy settings from /repo/.env (HTTPS_PROXY)\n" }));
check("a resumed run refused for proxy variables in the repo .env → launch", r.errorClass === "launch", r);
r = R(io([], { resumed: true, stderr: "dsh: MISSING_CREDENTIAL: DEEPSEEK_API_KEY is not set\n" }));
check("resumed, a known code before the session event keeps its class (auth)", r.errorClass === "auth", r);
r = R(io([session, { type: "error", message: "cannot resume session session-aaaa: live in another process" }], { resumed: true }));
check("resumed, after the session event: lost-session wording in the error event → resume-lost (secondary hint)", r.errorClass === "resume-lost", r);
r = R(io([session, { type: "error", message: "runner failure: socket closed" }], { resumed: true }));
check("resumed, after the session event, other wording → no class (crash by the core)", r.errorClass === null, r);
r = R(io([], { resumed: true, code: 130 }));
check("resumed, SIGINT before the session event, not cancelled → not resume-lost", r.errorClass !== "resume-lost", r);
// finalize(): the resume bit comes from the record (the core'"'"'s io has none)
const job = (resumeOf, theIo) => ({ id: "dt-0002", record: { id: "dt-0002", resumeOf }, io: theIo, reduced: R(theIo) });
let f = dsh.finalize(job("dt-0001", io([odd])));
check("finalize: a failed resumed job (record.resumeOf) is re-read → resume-lost", f?.errorClass === "resume-lost" && f.ok === false, f);
check("finalize: a fresh job → null (the verdict stands)", dsh.finalize(job(null, io([odd]))) === null);
check("finalize: a resumed boot failure → null (launch stands)", dsh.finalize(job("dt-0001", io([], { stderr: "x\nFull diagnostics: /l.log\n" }))) === null);
check("finalize: a resumed job that completed → null", dsh.finalize(job("dt-0001", io([session, turnEnd({ kind: "completed" }), { type: "final", text: "DONE" }], { code: 0 }))) === null);
check("finalize: io that already says resumed → null (reduce decided)", dsh.finalize(job("dt-0001", io([odd], { resumed: true }))) === null);
const out1 = core.classifyOutcome({ io: io([], { stderr: "dsh: something failed to load session storage\n", code: 0 }), reduced: null, patterns: dsh.patterns });
check("patterns alone never give resume-lost", out1.errorClass !== "resume-lost", out1);
r = R(io([], { code: 130 }));
check("SIGINT before the session, not cancelled → crash (not launch)", r.errorClass === null || r.errorClass === "crash", r);
r = R(io([], { code: null, signal: "SIGKILL" }));
check("killed by a signal before the session → not launch", r.errorClass !== "launch", r);
r = R(io([session, turnEnd({ kind: "error", error: { code: "SOMETHING_NEW", message: "?" } }), { type: "final", text: "" }]));
check("an unknown code leaves the class to the patterns / exit (crash)", r.errorClass === null && /SOMETHING_NEW/.test(r.errorText), r);
const out = core.classifyOutcome({ io: { ...io([], { stderr: "dsh: RATE_LIMIT: slow down" }), events: [] }, reduced: null, patterns: dsh.patterns });
check("patterns alone (reduce failed) classify a stderr code line", out.errorClass === "rate-limit", out);
'

    node_checks "A4" '
const id = mod.identify;
let v = id("0.2.1-rc.2\n");
check("identify: a bare 0.2.1-rc.2 is DeepSeek Harness", v.ok && v.version === "0.2.1-rc.2", v);
v = id("@deepseek-ai/dsh 0.3.0\n");
check("identify: a version line naming deepseek", v.ok && v.version === "0.3.0", v);
v = id("Distributed Shell / Dancer'"'"'s shell. version 0.25.10\nCopyright 2001 Junichi Uekawa\n");
check("identify: Dancer'"'"'s shell (Homebrew dsh) is refused", !v.ok && /Dancer/.test(v.reason), v);
v = id("0.25.10\n");
check("identify: a bare 0.25.x (Dancer'"'"'s line) without deepseek is refused", !v.ok, v);
v = id("0.21.0\n");
check("identify: another bare 0.2x version is no refusal (an unverified version is only doctor'"'"'s WARN)", v.ok && v.version === "0.21.0", v);
v = id("@deepseek-ai/dsh 0.25.1\n");
check("identify: 0.25.x naming deepseek passes", v.ok, v);
v = id("dsh: unknown option\n");
check("identify: no version → refused", !v.ok, v);
const exec = (stdout, status = 0, error = null) => () => ({ status, signal: null, stdout, stderr: "", error });
const ctx = (stdout, status, error) => core.makeCtx({ env: { PATH: "/bin" }, profile: { bin: "/x/dsh" }, profileName: "p", exec: exec(stdout, status, error) });
const found = dsh.discover(ctx("0.2.1-rc.2\n"));
check("discover: { bin, version }", found.bin === "/x/dsh" && found.version === "0.2.1-rc.2", found);
let e = null;
try { dsh.discover(ctx("Distributed Shell / Dancer'"'"'s shell. version 0.25.10\n")); } catch (error) { e = error; }
check("discover: Dancer'"'"'s shell → launch, with the install hint", e?.errorClass === "launch" && /not DeepSeek Harness/.test(e.message) && /@deepseek-ai\/dsh/.test(e.message), e?.message);
e = null;
try { dsh.discover(ctx("", null, Object.assign(new Error("spawn"), { code: "ENOENT" }))); } catch (error) { e = error; }
check("discover: no binary → launch, not found, install hint", e?.errorClass === "launch" && /not found/.test(e.message) && /npm i -g @deepseek-ai\/dsh/.test(e.message), e?.message);
e = null;
try { dsh.discover(ctx("0.2.1-rc.2\n", 3)); } catch (error) { e = error; }
check("discover: --version failing → launch", e?.errorClass === "launch", e?.message);
const c0 = core.makeCtx({ env: { PATH: "/bin" }, profile: {}, profileName: "p", exec: (cmd) => ({ status: 0, stdout: cmd === "dsh" ? "0.2.1-rc.2\n" : "", stderr: "", error: null }) });
check("discover: without bin, dsh from PATH", dsh.discover(c0).bin === "dsh");
'

    node_checks "A5" '
const env = { HOME: "/h", PATH: "/bin", AGENT_DISPATCH_STATE_DIR: "/data" };
const ctx = core.makeCtx({ env, profile: {}, profileName: "ds-x" });
const profile = { harness: "dsh", auth: { key: "k" }, home: "user" };
const req = { profile, job: { id: "dt-0002", dir: "/d", cwd: "/repo" } };
const prev = { id: "dt-0001", cwd: "/repo", sessionId: "session-1", meta: { dshHome: "/h/.dsh" } };
check("resumeCheck: same cwd and DSH_HOME → null", dsh.resumeCheck(prev, profile, req, ctx) === null);
let why = dsh.resumeCheck({ ...prev, cwd: "/other" }, profile, req, ctx);
check("resumeCheck: another cwd → refused", /cwd/.test(why ?? ""), why);
why = dsh.resumeCheck({ ...prev, meta: { dshHome: "/elsewhere" } }, profile, req, ctx);
check("resumeCheck: another DSH_HOME → refused", /DSH_HOME/.test(why ?? ""), why);
why = dsh.resumeCheck({ ...prev, meta: null }, profile, req, ctx);
check("resumeCheck: no recorded DSH_HOME → refused", /DSH_HOME/.test(why ?? ""), why);
why = dsh.resumeCheck({ ...prev, sessionId: "-x" }, profile, req, ctx);
check("resumeCheck: a malformed session id → refused", /session id/.test(why ?? ""), why);
why = dsh.resumeCheck(prev, { ...profile, home: "isolated" }, req, ctx);
check("resumeCheck: user home then, isolated home now → refused", /DSH_HOME/.test(why ?? ""), why);
'

    # =============================================================================================================
    # B. Jobs through the CLI (spec §8 row 3): argv / env goldens per auth mode and role, the patch file, secrets.
    # =============================================================================================================

    # --- B1. writer, key from the store ---
    rec="$TEST_ROOT/rec-b1.json"
    eff="$TEST_ROOT/eff-b1.json"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-key --role implementer --write --prompt-file "$prompt"
    local B1="$JOB"
    [[ "$RC" -eq 0 && "$OUT" == "agent-dispatch: ds-key task started in the background as dt-0001" && "$ST" == completed ]]
    verdict "B1 a dsh task starts as dt-0001 and completes" $? "rc=$RC out=$OUT err=$ERR st=$ST" "$(tail -5 "$JOBS/$B1.log" 2>/dev/null)"
    patch_file="$JOBS/$B1/dsh.patch.yml"
    want="$(jarr --profile headless --patch "$patch_file" --json -)"
    [[ "$(ffield "$rec" argv)" == "$want" ]]
    verdict "B1 argv: --profile headless --patch <job>/dsh.patch.yml --json - (the key never in argv)" $? "argv=$(ffield "$rec" argv)" "want=$want"
    [[ "$(ffield "$rec" stdin)" == "$(cat "$prompt")" && "$(ffield "$rec" cwd)" == "$repo" ]]
    verdict "B1 the prompt arrives verbatim on stdin; cwd is the work tree root" $? "cwd=$(ffield "$rec" cwd)"
    [[ "$(env_names "$rec" '^(DSH_|DEEPSEEK_)')" == "DEEPSEEK_API_KEY DSH_AGENTS_HOME DSH_PERMISSION_MODE DSH_TELEMETRY_DISABLED" \
        && "$(ffield "$rec" env.DEEPSEEK_API_KEY)" == "$KEY" && "$(ffield "$rec" env.DSH_PERMISSION_MODE)" == danger-full-access \
        && "$(ffield "$rec" env.DSH_TELEMETRY_DISABLED)" == 1 && "$(ffield "$rec" env.DSH_AGENTS_HOME)" == "$STATE/agents-empty" ]]
    verdict "B1 env (writer, key): DEEPSEEK_API_KEY=<stored key>, DSH_PERMISSION_MODE=danger-full-access, DSH_TELEMETRY_DISABLED=1, DSH_AGENTS_HOME=agents-empty; no DSH_HOME" $? \
        "names=$(env_names "$rec" '^(DSH_|DEEPSEEK_)')" "mode=$(ffield "$rec" env.DSH_PERMISSION_MODE)"
    [[ -z "$(env_names "$rec" '^(ANTHROPIC_|UNRELATED_SECRET_TOKEN|CLAUDE_)')" ]]
    verdict "B1 the caller's secret-like variables do not reach dsh (allowlist)" $? "$(env_names "$rec" '^(ANTHROPIC_|UNRELATED_|CLAUDE_)')"
    [[ -d "$STATE/agents-empty" && -z "$(/bin/ls -A "$STATE/agents-empty")" && "$(mode_of "$STATE/agents-empty")" == 700 ]]
    verdict "B1 agents-empty/ exists, is empty and 0700" $? "$(/bin/ls -la "$STATE/agents-empty" 2>&1)"
    want="$(printf '%s\n' \
        "# Written by agent-dispatch (bin/lib/adapters/dsh.mjs). Each row replaces that row's whole config; apiKeyEnv and baseURL are pinned." \
        '- id: "agent-default-model"' \
        '  config: {"provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "high"}' \
        '- id: "llm-deepseek"' \
        '  config: {"apiKeyEnv": "DEEPSEEK_API_KEY", "baseURL": "https://api.deepseek.com/anthropic", "reasoningEffort": "high"}' \
        '- id: "session-log-deepseek"' \
        '  config: {"enabled": false}' \
        '- id: "plugin-package-inventory-deepseek"' \
        '  config: {"enabled": false}' \
        '- id: "session-title-llm"' \
        '  disabled: true')"
    [[ "$(cat "$patch_file")" == "$want" && "$(mode_of "$patch_file")" == 600 ]]
    verdict "B1 the patch file is written whole (A5 rows, Б defaults), mode 0600" $? "$(diff <(echo "$want") "$patch_file")"
    [[ "$(ffield "$eff" model)" == deepseek-v4-pro && "$(ffield "$eff" effort.agent)" == high && "$(ffield "$eff" effort.llm)" == high \
        && "$(ffield "$eff" baseURL)" == "https://api.deepseek.com/anthropic" && "$(ffield "$eff" keySource)" == env \
        && "$(ffield "$eff" sessionLog)" == false && "$(ffield "$eff" inventory)" == false && "$(ffield "$eff" sessionTitle)" == false && "$(ffield "$eff" telemetryDisabled)" == true ]]
    verdict "B1 the stub's effective config: model, effort in both rows, pinned baseURL, key from the env, session log / inventory / title off" $? "$(cat "$eff" 2>/dev/null | head -40)"
    sid="$(ffield "$eff" sessionId)"
    [[ "$sid" == session-* && "$(jfield job.sessionId <<<"$SJ")" == "$sid" && "$(jfield job.harness <<<"$SJ")" == dsh && "$(jfield job.profile <<<"$SJ")" == ds-key \
        && "$(jfield job.usage.inputTokens <<<"$SJ")" == 1200 && "$(jfield job.meta.permissionMode <<<"$SJ")" == danger-full-access && "$(jfield job.meta.dshHome <<<"$SJ")" == "$HOME/.dsh" ]]
    verdict "B1 status: sessionId from the first session event, harness/profile, usage summed, meta (permission mode, DSH_HOME)" $? "$SJ"
    run_ad result "$B1"
    [[ "$RC" -eq 0 && "$OUT" == $'DONE\nstub finished' ]]
    verdict "B1 result prints the final event verbatim" $? "rc=$RC out=$OUT"
    ! grep -rqF "$KEY" "$JOBS/$B1.log" "$JOBS/$B1.json" "$patch_file" && [[ ! -e "$JOBS/$B1/secret" ]] && ! grep -qF "$KEY" <<<"$SJ"
    verdict "B1 the key is in no log, record, patch file or status; the handoff file is gone" $? "$(grep -rlF "$KEY" "$JOBS" 2>/dev/null)"
    grep -q "start $B1: \"$DSH\" \"--profile\" \"headless\" \"--patch\" \"$patch_file\" \"--json\" \"-\"" "$JOBS/$B1.log" && grep -q "key in: DEEPSEEK_API_KEY" "$JOBS/$B1.log"
    verdict "B1 the job log names the argv and the key variable (not its value)" $? "$(grep -E 'start|env names' "$JOBS/$B1.log")"

    # --- B2. reviewer (no --write), key from the store; sandbox native ---
    rec="$TEST_ROOT/rec-b2.json"
    AGENT_STUB_RECORD="$rec" finish --profile ds-rev --role plan-reviewer --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$rec" env.DSH_PERMISSION_MODE)" == read-only && "$(ffield "$rec" argv)" == "$(jarr --profile headless --patch "$JOBS/$JOB/dsh.patch.yml" --json -)" ]] \
        && grep -q '"reasoningEffort": "max"' "$JOBS/$JOB/dsh.patch.yml"
    verdict "B2 reviewer: DSH_PERMISSION_MODE=read-only, the same argv, its effort in the patch" $? "st=$ST mode=$(ffield "$rec" env.DSH_PERMISSION_MODE)"
    rec="$TEST_ROOT/rec-b2w.json"
    AGENT_STUB_RECORD="$rec" finish --profile ds-sbx --write --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$rec" env.DSH_PERMISSION_MODE)" == workspace-write ]]
    verdict "B2 sandbox native, writer: DSH_PERMISSION_MODE=workspace-write" $? "st=$ST mode=$(ffield "$rec" env.DSH_PERMISSION_MODE)"
    rec="$TEST_ROOT/rec-b2r.json"
    AGENT_STUB_RECORD="$rec" finish --profile ds-sbx --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$rec" env.DSH_PERMISSION_MODE)" == read-only ]]
    verdict "B2 sandbox native, reviewer: still read-only (the role's mode, not the sandbox)" $? "st=$ST mode=$(ffield "$rec" env.DSH_PERMISSION_MODE)"

    # --- B3. auth native: the adapter sets no key; dsh reads $DSH_HOME/.env ---
    rec="$TEST_ROOT/rec-b3.json"
    eff="$TEST_ROOT/eff-b3.json"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-native --write --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == auth && "$(jfield job.errorText <<<"$SJ")" == MISSING_CREDENTIAL:* \
        && -z "$(ffield "$rec" env.DEEPSEEK_API_KEY)" && "$(env_names "$rec" '^DEEPSEEK_')" == "" ]]
    verdict "B3 native without \$DSH_HOME/.env: no DEEPSEEK_API_KEY from the adapter; dsh reports MISSING_CREDENTIAL → failed/auth" $? "st=$ST $SJ"
    mkdir -p "$HOME/.dsh"
    printf 'DEEPSEEK_API_KEY=sk-native-home-key\n' >"$HOME/.dsh/.env"
    chmod 600 "$HOME/.dsh/.env"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-native --write --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$eff" keySource)" == "DSH_HOME .env" && "$(env_names "$rec" '^DEEPSEEK_')" == "" \
        && "$(ffield "$eff" model)" == deepseek-flash && "$(ffield "$eff" effort.llm)" == low && "$(jfield job.hasSecret <<<"$SJ")" == false ]]
    verdict "B3 native with ~/.dsh/.env: completed, the key found by dsh in DSH_HOME/.env, none handed over" $? "st=$ST eff=$(ffield "$eff" keySource)"
    mkdir -p "$TEST_ROOT/dshhome-caller"
    printf 'DEEPSEEK_API_KEY=sk-caller-home-key\n' >"$TEST_ROOT/dshhome-caller/.env"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" DSH_HOME="$TEST_ROOT/dshhome-caller" finish --profile ds-native --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$rec" env.DSH_HOME)" == "$TEST_ROOT/dshhome-caller" && "$(ffield "$eff" dshHome)" == "$TEST_ROOT/dshhome-caller" \
        && "$(jfield job.meta.dshHome <<<"$SJ")" == "$TEST_ROOT/dshhome-caller" ]]
    verdict "B3 home user: the caller's DSH_HOME reaches dsh (native home variable re-admitted) and is the job's session home" $? "st=$ST home=$(ffield "$rec" env.DSH_HOME)"
    printf 'DEEPSEEK_API_KEY=sk-repo-env-key\nDEEPSEEK_BASE_URL=https://evil.example.test/anthropic\n' >"$repo/.env"
    AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-native --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$eff" keySource)" == "cwd .env" && "$(ffield "$eff" baseURL)" == "https://api.deepseek.com/anthropic" ]]
    verdict "B3 a repo .env: its key wins over native (dsh reads it first), but its DEEPSEEK_BASE_URL cannot move the pinned baseURL" $? "st=$ST src=$(ffield "$eff" keySource) url=$(ffield "$eff" baseURL)"
    AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-key --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$eff" keySource)" == env && "$(ffield "$eff" baseURL)" == "https://api.deepseek.com/anthropic" ]]
    verdict "B3 with a stored key the process env outranks the repo .env; baseURL stays pinned" $? "src=$(ffield "$eff" keySource)"
    printf 'HTTPS_PROXY=http://proxy.example.test:8080\n' >"$repo/.env"
    finish --profile ds-key --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && "$(jfield job.sessionId <<<"$SJ")" == "" ]]
    verdict "B3 proxy variables in the repo .env: dsh refuses to start (exit 1 before the session event) → failed/launch" $? "st=$ST $SJ"
    rm -f "$repo/.env"

    # --- B4. keyEnv and keyCmd, and the key refusals ---
    rec="$TEST_ROOT/rec-b4.json"
    AGENT_STUB_RECORD="$rec" TEST_DS_KEY="env-key-555" finish --profile ds-env --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$rec" env.DEEPSEEK_API_KEY)" == env-key-555 && -z "$(ffield "$rec" env.TEST_DS_KEY)" ]] \
        && grep -q '"model": "deepseek-flash", "reasoningEffort": "high"' "$JOBS/$JOB/dsh.patch.yml"
    verdict "B4 keyEnv: the value reaches DEEPSEEK_API_KEY (not its own name); no model/effort → deepseek-flash/high written explicitly" $? "st=$ST"
    AGENT_STUB_RECORD="$rec" finish --profile ds-cmd --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$rec" env.DEEPSEEK_API_KEY)" == cmd-key-777 ]]
    verdict "B4 keyCmd: its stdout (trimmed) reaches DEEPSEEK_API_KEY" $? "st=$ST"
    n="$(/bin/ls "$JOBS" | grep -c '\.json$')"
    run_ad task --background --profile ds-env --prompt-file "$prompt"
    [[ "$RC" -eq 2 && "$ERR" == *"ds-env: key unavailable"*"errorClass=auth"* && "$(/bin/ls "$JOBS" | grep -c '\.json$')" -eq "$n" ]]
    verdict "B4 keyEnv unset: refused before launch (exit 2, errorClass=auth), no job" $? "rc=$RC err=$ERR"
    run_ad task --background --profile ds-nokey --prompt-file "$prompt"
    [[ "$RC" -eq 2 && "$ERR" == *"key unavailable"*"key set absent"* ]]
    verdict "B4 a missing stored key: refused before launch with the key set hint" $? "rc=$RC err=$ERR"

    # --- B5. home isolated, agentsHome / sessionLog / endpoint / options.patch, env defaults, wrap ---
    rec="$TEST_ROOT/rec-b5.json"
    eff="$TEST_ROOT/eff-b5.json"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-iso --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$rec" env.DSH_HOME)" == "$STATE/homes/ds-iso/dsh" && "$(mode_of "$STATE/homes/ds-iso/dsh")" == 700 \
        && -d "$STATE/homes/ds-iso/dsh/sessions" && "$(jfield job.meta.dshHome <<<"$SJ")" == "$STATE/homes/ds-iso/dsh" ]]
    verdict "B5 home isolated: DSH_HOME=<data>/homes/<profile>/dsh (0700); dsh keeps its sessions there" $? "st=$ST home=$(ffield "$rec" env.DSH_HOME)"
    run_ad profile env ds-iso
    [[ "$RC" -eq 0 && "$OUT" == "export DSH_HOME='$STATE/homes/ds-iso/dsh'" ]]
    verdict "B5 profile env ds-iso exports the same DSH_HOME the jobs use" $? "rc=$RC out=$OUT"
    rec="$TEST_ROOT/rec-b5o.json"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" DSH_AGENTS_HOME="$TEST_ROOT/agents-caller" finish --profile ds-opt --prompt-file "$prompt"
    patch_file="$JOBS/$JOB/dsh.patch.yml"
    [[ "$ST" == completed && "$(ffield "$rec" env.DSH_AGENTS_HOME)" == "$TEST_ROOT/agents-caller" && "$(ffield "$eff" sessionLog)" == true \
        && "$(ffield "$eff" baseURL)" == "https://gw.example.test/anthropic" && "$(ffield "$eff" inventory)" == true && "$(ffield "$eff" toolWeb)" == false \
        && "$(ffield "$eff" rows.llm-deepseek.config.maxTokens)" == 64000 && "$(ffield "$eff" effort.agent)" == max ]] \
        && ! grep -q session-log-deepseek "$patch_file"
    verdict "B5 options: agentsHome user (the caller's DSH_AGENTS_HOME passes), sessionLog on (no row), endpoint → baseURL, options.patch rows merged" $? "st=$ST $(cat "$patch_file")"
    rec="$TEST_ROOT/rec-b5d.json"
    AGENT_STUB_RECORD="$rec" finish --profile ds-envdef --prompt-file "$prompt"
    [[ "$ST" == completed && -z "$(ffield "$rec" env.DSH_TELEMETRY_DISABLED)" && "$(ffield "$rec" env.DSH_AGENTS_HOME)" == "$TEST_ROOT/agents-custom" ]]
    verdict "B5 profile env overrides the defaults (Б): DSH_TELEMETRY_DISABLED removed, DSH_AGENTS_HOME elsewhere" $? "st=$ST"
    rec="$TEST_ROOT/rec-b5w.json"
    AGENT_STUB_RECORD="$rec" finish --profile ds-wrap --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$rec" env.DSH_WRAPPED)" == yes ]] && grep -q "start $JOB: \"/usr/bin/env\" \"DSH_WRAPPED=yes\" \"$DSH\" \"--profile\"" "$JOBS/$JOB.log"
    verdict "B5 wrap: the harness runs as <wrap> <bin> <argv>, discover too" $? "st=$ST $(grep start "$JOBS/$JOB.log")"

    # --- B6. refusals before launch: options.patch against A5, env against mandatory settings ---
    local p
    for p in ds-badurl ds-badkey ds-baddis ds-badrow ds-conmode ds-conkey ds-conhome; do
        n="$(/bin/ls "$JOBS" | grep -c '\.json$')"
        run_ad task --background --write --profile "$p" --prompt-file "$prompt"
        case "$p" in
            ds-badurl) want="baseURL" ;;
            ds-badkey) want="apiKeyEnv" ;;
            ds-baddis) want="disabled" ;;
            ds-badrow) want="tool-web" ;;
            ds-conmode) want="env DSH_PERMISSION_MODE conflicts" ;;
            ds-conkey) want="env DEEPSEEK_API_KEY conflicts" ;;
            ds-conhome) want="env DSH_HOME conflicts" ;;
        esac
        [[ "$RC" -eq 2 && "$ERR" == *"profile $p"*"$want"* && "$(/bin/ls "$JOBS" | grep -c '\.json$')" -eq "$n" ]]
        verdict "B6 $p is refused before launch (exit 2: $want), no job left" $? "rc=$RC err=$ERR"
    done

    # --- B7. resume: --session-id from the first session event, same cwd and DSH_HOME ---
    rec="$TEST_ROOT/rec-b7.json"
    sid="$(jfield job.sessionId <<<"$(ad status "$B1" --json)")"
    AGENT_STUB_RECORD="$rec" finish --profile ds-key --write --resume-task "$B1" --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$rec" argv)" == "$(jarr --profile headless --patch "$JOBS/$JOB/dsh.patch.yml" --json --session-id "$sid" -)" \
        && "$(jfield job.sessionId <<<"$SJ")" == "$sid" && "$(jfield job.resumeOf <<<"$SJ")" == "$B1" ]] && [[ "$(ad result "$JOB")" == $'DONE\nresumed '"$sid" ]]
    verdict "B7 --resume-task: --session-id <the session of the first job> before -, the session continues" $? "st=$ST argv=$(ffield "$rec" argv) sid=$sid"
    run_ad task --background --profile ds-rev --resume-task "$B1" --prompt-file "$prompt"
    [[ "$RC" -eq 2 && "$ERR" == *"ran on profile ds-key, not ds-rev"* ]]
    verdict "B7 a session never moves to another profile (exit 2)" $? "rc=$RC err=$ERR"
    run_ad task --background --profile ds-key --resume-task "$B1" --prompt-file "$prompt" --cwd "$repo2"
    [[ "$RC" -eq 2 && "$ERR" == *"unknown job $B1"* ]]
    verdict "B7 another work tree cannot resume it (the job is unknown there)" $? "rc=$RC err=$ERR"
    DSH_HOME="$TEST_ROOT/dshhome-caller" run_ad task --background --profile ds-key --resume-task "$B1" --prompt-file "$prompt"
    [[ "$RC" -eq 2 && "$ERR" == *"cannot resume $B1 on ds-key"*"DSH_HOME"*"dispatch --fresh"* ]]
    verdict "B7 resumeCheck: another DSH_HOME than the session's → refused before launch (exit 2, FRESH)" $? "rc=$RC err=$ERR"
    AGENT_STUB_MODE=boot-fail finish --profile ds-key --resume-task "$B1" --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && "$(jfield job.errorText <<<"$SJ")" == *"Full diagnostics"* ]]
    verdict "B7 a resumed run whose boot fails (Full diagnostics) → failed/launch, not resume-lost" $? "st=$ST $SJ"
    rm -rf "$HOME/.dsh/sessions"
    finish --profile ds-key --resume-task "$B1" --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == resume-lost && "$(jfield job.errorText <<<"$SJ")" == *"refused (nothing persisted under this id)"* ]]
    verdict "B7 dsh no longer knows the session (unknown --session-id, wording unknown to the adapter) → failed/resume-lost by structure" $? "st=$ST $SJ"

    # --- B8. the late session event: the id exists only once dsh printed it ---
    rec="$TEST_ROOT/rec-b8.json"
    eff="$TEST_ROOT/eff-b8.json"
    AGENT_STUB_MODE=late-session AGENT_STUB_SESSION_DELAY_MS=2500 AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" start --profile ds-key --prompt-file "$prompt"
    id="$JOB"
    wait_file "$rec"
    SJ="$(ad status "$id" --json)"
    [[ "$(jfield job.status <<<"$SJ")" == running && -z "$(jfield job.sessionId <<<"$SJ")" ]]
    verdict "B8 while dsh has printed no session event the job has no session id (not preassigned)" $? "$SJ"
    ST="$(wait_status "$id" 'completed|failed|cancelled' 20)"
    [[ "$ST" == completed && "$(ad status "$id" --json | jfield job.sessionId)" == "$(ffield "$eff" sessionId)" && -n "$(ffield "$eff" sessionId)" ]]
    verdict "B8 a late session event is still the job's session id" $? "st=$ST eff=$(ffield "$eff" sessionId)"
    rec="$TEST_ROOT/rec-b8c.json"
    AGENT_STUB_MODE=late-session AGENT_STUB_SESSION_DELAY_MS=30000 AGENT_STUB_RECORD="$rec" start --profile ds-key --prompt-file "$prompt"
    id="$JOB"
    wait_file "$rec"
    ad cancel "$id" >/dev/null
    SJ="$(ad status "$id" --json)"
    run_ad task --background --profile ds-key --resume-task "$id" --prompt-file "$prompt"
    [[ "$(jfield job.status <<<"$SJ")" == cancelled && -z "$(jfield job.sessionId <<<"$SJ")" && "$RC" -eq 2 && "$ERR" == *"is cancelled / has no session"* ]]
    verdict "B8 cancelled before the session event: no session id, and resuming it is refused (FRESH)" $? "$SJ" "rc=$RC err=$ERR"

    # --- B9. error classification through the CLI (spec §3.8) ---
    check_class() { # <label> <class> <errorText-prefix|-> <env assignments...>
        local label="$1" cls="$2" text="$3"
        shift 3
        env "$@" node "$CLI" task --background --profile "${PROFILE:-ds-key}" --prompt-file "$prompt" >"$TEST_ROOT/out.txt" 2>"$TEST_ROOT/stderr.txt"
        local jid
        jid="$(awk '{print $NF}' "$TEST_ROOT/out.txt")"
        local s
        s="$(wait_status "$jid" 'completed|failed|cancelled' 30)"
        local j
        j="$(ad status "$jid" --json)"
        local res
        res="$(ad result "$jid" 2>&1)"
        [[ "$s" == failed && "$(jfield job.errorClass <<<"$j")" == "$cls" && ("$text" == - || "$(jfield job.errorText <<<"$j")" == "$text"*) && "$res" == *"job $jid is failed errorClass=$cls"* ]]
        verdict "B9 $label → failed/$cls" $? "status=$s class=$(jfield job.errorClass <<<"$j") text=$(jfield job.errorText <<<"$j")"
    }
    check_class "dsh: QUOTA (402 Insufficient Balance)" quota "QUOTA: Insufficient Balance" AGENT_STUB_MODE=quota
    check_class "dsh: RATE_LIMIT" rate-limit "RATE_LIMIT:" AGENT_STUB_MODE=rate-limit
    check_class "dsh: CONTEXT_WINDOW_EXCEEDED" context "CONTEXT_WINDOW_EXCEEDED:" AGENT_STUB_MODE=context
    check_class "dsh: AUTH (401 in the turn)" auth "AUTH:" AGENT_STUB_MODE=error AGENT_STUB_CLASS=AUTH AGENT_STUB_MESSAGE="Authentication Fails"
    check_class "dsh: INVALID_CREDENTIAL on stderr only" auth "INVALID_CREDENTIAL:" AGENT_STUB_MODE=boot-error AGENT_STUB_CLASS=INVALID_CREDENTIAL
    check_class "dsh: INVALID_REQUEST (an id deepseek-official does not serve)" model-not-selected "INVALID_REQUEST:" AGENT_STUB_MODE=error AGENT_STUB_CLASS=INVALID_REQUEST
    check_class "dsh: HTTP_503" server "HTTP_503:" AGENT_STUB_MODE=error AGENT_STUB_CLASS=HTTP_503
    check_class "dsh: STREAM_CLOSED" server "STREAM_CLOSED:" AGENT_STUB_MODE=error AGENT_STUB_CLASS=STREAM_CLOSED
    check_class "dsh: SANDBOX_UNAVAILABLE" launch "SANDBOX_UNAVAILABLE:" AGENT_STUB_MODE=error AGENT_STUB_CLASS=SANDBOX_UNAVAILABLE
    check_class "a QUOTA turn at exit 0 (exit codes are informational)" quota "QUOTA:" AGENT_STUB_MODE=exit0-error AGENT_STUB_CLASS=QUOTA
    check_class "turn_end max-tokens" context - AGENT_STUB_MODE=max-tokens
    check_class "turn_end blocked (its cause is unverified)" blocked "turn ended: blocked" AGENT_STUB_MODE=auto-reject
    check_class "a required plugin fails before the session event (Full diagnostics)" launch - AGENT_STUB_MODE=boot-fail
    check_class "a usage error (JSON error event, no session)" launch - AGENT_STUB_MODE=usage-error
    check_class "a completed turn without a final event" malformed - AGENT_STUB_MODE=no-final
    check_class "a completed turn with an empty final" malformed - AGENT_STUB_MODE=empty-final
    PROFILE=ds-xhigh check_class "effort xhigh: dsh's UNSUPPORTED_REASONING_EFFORT" model-not-selected "UNSUPPORTED_REASONING_EFFORT:"
    finish --profile ds-missing --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && "$(jfield job.note <<<"$SJ")" == *"not found"*"npm i -g @deepseek-ai/dsh"* ]]
    verdict "B9 no dsh binary → failed/launch with the install hint" $? "st=$ST $(jfield job.note <<<"$SJ")"
    AGENT_STUB_MODE=dancer finish --profile ds-key --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && "$(jfield job.note <<<"$SJ")" == *"not DeepSeek Harness"*"Dancer"* && -z "$(jfield job.childPid <<<"$SJ")" ]]
    verdict "B9 Homebrew's dsh (Dancer's shell) → failed/launch, never run as a harness" $? "st=$ST $(jfield job.note <<<"$SJ")"

    # --- B10. secrets: a key the harness prints is redacted everywhere ---
    AGENT_STUB_MODE=leak-secret AGENT_STUB_SECRET_VAR=DEEPSEEK_API_KEY finish --profile ds-key --prompt-file "$prompt"
    run_ad result "$JOB"
    [[ "$ST" == completed && "$OUT" == *"key=<redacted>"* && "$OUT" != *"$KEY"* ]] && ! grep -rqF "$KEY" "$JOBS" && grep -q "leaked: <redacted>" "$JOBS/$JOB.log"
    verdict "B10 a key dsh echoes (stderr split across chunks, final answer) is redacted in the log, the record and result" $? "st=$ST out=$OUT" "$(grep -rlF "$KEY" "$JOBS" 2>/dev/null)"

    # --- B11. cancel: SIGINT → ≥ 7 s → SIGKILL; cancelled by the record whatever dsh exits with ---
    sigs="$TEST_ROOT/sig-b11a.txt"
    ready="$TEST_ROOT/ready-b11a"
    AGENT_STUB_MODE=busy AGENT_STUB_SIGNALS="$sigs" AGENT_STUB_READY="$ready" start --profile ds-key --write --prompt-file "$prompt"
    id="$JOB"
    child="$(wait_child "$id")"
    wait_file "$ready"
    t0="$(now_ms)"
    ad cancel "$id" >/dev/null
    t1="$(now_ms)"
    SJ="$(ad status "$id" --json)"
    [[ -n "$child" && "$(cut -d' ' -f1 "$sigs" 2>/dev/null | tr '\n' ' ')" == "SIGINT " && "$(jfield job.status <<<"$SJ")" == cancelled \
        && "$(jfield job.cancelLadder <<<"$SJ")" == '[["SIGINT",7000],["SIGKILL",0]]' ]] && gone "$child" && ((t1 - t0 < 6000))
    verdict "B11 cancel sends SIGINT only; dsh disposes and exits 130 at once; the job is cancelled ($((t1 - t0)) ms)" $? \
        "signals=$(tr '\n' ' ' <"$sigs" 2>/dev/null) $(jfield job.status <<<"$SJ") ladder=$(jfield job.cancelLadder <<<"$SJ")"
    run_ad task --background --profile ds-key --write --prompt-file "$prompt"
    [[ "$RC" -eq 0 ]] && wait_status "${OUT##* }" 'completed|failed' 20 >/dev/null
    verdict "B11 the write reservation is free again after the cancel" $? "rc=$RC err=$ERR"
    sigs="$TEST_ROOT/sig-b11b.txt"
    ready="$TEST_ROOT/ready-b11b"
    AGENT_STUB_MODE=stuck AGENT_STUB_SIGNALS="$sigs" AGENT_STUB_READY="$ready" start --profile ds-key --prompt-file "$prompt"
    id="$JOB"
    child="$(wait_child "$id")"
    wait_file "$ready"
    ad cancel "$id" >/dev/null &
    local cancel_pid=$!
    local dead_at="" i=0
    while ((i < 150)); do
        if ! kill -0 "$child" 2>/dev/null; then dead_at="$(now_ms)"; break; fi
        sleep 0.1
        i=$((i + 1))
    done
    wait "$cancel_pid"
    local sigint_at
    sigint_at="$(awk '$1 == "SIGINT" {print $2; exit}' "$sigs" 2>/dev/null)"
    [[ -n "$child" && -n "$dead_at" && -n "$sigint_at" && "$(cut -d' ' -f1 "$sigs" | tr '\n' ' ')" == "SIGINT " && "$(ad status "$id" --json | jfield job.status)" == cancelled ]] \
        && ((dead_at - sigint_at >= 6900)) && grep -q "SIGINT to groups" "$JOBS/$id.log" && grep -q "SIGKILL to groups" "$JOBS/$id.log"
    verdict "B11 a dsh stuck in its shutdown gets SIGINT, then SIGKILL no sooner than 7 s later, never SIGTERM ($((dead_at - sigint_at)) ms)" $? \
        "signals=$(tr '\n' ' ' <"$sigs" 2>/dev/null) child=$child dead_at=$dead_at sigint_at=$sigint_at" "$(grep -E 'cancel|SIG' "$JOBS/$id.log" | tail -5)"

    # --- B12. SIGTERM: dsh exits 0; never a completed job by that ---
    ready="$TEST_ROOT/ready-b12a"
    AGENT_STUB_MODE=busy AGENT_STUB_READY="$ready" start --profile ds-key --prompt-file "$prompt"
    id="$JOB"
    child="$(wait_child "$id")"
    wait_file "$ready"
    kill -TERM "$child"
    ST="$(wait_status "$id" 'completed|failed|cancelled' 20)"
    SJ="$(ad status "$id" --json)"
    run_ad result "$id"
    [[ "$ST" == failed && "$(jfield job.exitCode <<<"$SJ")" == 0 && "$(jfield job.errorClass <<<"$SJ")" == crash && -z "$(jfield job.response <<<"$SJ")" \
        && "$RC" -ne 0 && "$OUT" != *"partial answer"* ]] && grep -q '"type":"final","text":"DONE\\npartial answer before the abort"' "$JOBS/$id.log"
    verdict "B12 an outside SIGTERM: dsh exits 0, an aborted turn and a partial final → failed/crash, no response, not completed" $? "st=$ST rc=$RC out=$OUT $SJ" "$(grep -F '"final"' "$JOBS/$id.log")"
    sigs="$TEST_ROOT/sig-b12b.txt"
    ready="$TEST_ROOT/ready-b12b"
    AGENT_STUB_MODE=sigterm-final AGENT_STUB_SIGNALS="$sigs" AGENT_STUB_READY="$ready" start --profile ds-key --prompt-file "$prompt"
    id="$JOB"
    child="$(wait_child "$id")"
    runner="$(ad status "$id" --json | jfield job.runnerPid)"
    wait_file "$ready"
    ad cancel "$id" >/dev/null &
    cancel_pid=$!
    i=0
    while ((i < 50)) && [[ "$(ad status "$id" --json | jfield job.status)" != cancelled ]]; do
        sleep 0.05
        i=$((i + 1))
    done
    kill -TERM "$child" 2>/dev/null
    wait "$cancel_pid"
    SJ="$(ad status "$id" --json)"
    [[ "$(jfield job.status <<<"$SJ")" == cancelled && -z "$(jfield job.response <<<"$SJ")" ]] && gone "$child" "$runner"
    verdict "B12 cancelled, then dsh answers SIGTERM with a completed turn and exit 0: still cancelled (the dispatcher's record)" $? \
        "signals=$(tr '\n' ' ' <"$sigs" 2>/dev/null) $SJ"
    run_ad result "$id"
    [[ "$RC" -eq 1 && "$ERR" == *"job $id is cancelled"* ]]
    verdict "B12 result of that job exits 1 (cancelled)" $? "rc=$RC err=$ERR"

    # --- B13. the whole-job timeout runs the same ladder ---
    sigs="$TEST_ROOT/sig-b13.txt"
    AGENT_STUB_MODE=busy AGENT_STUB_SIGNALS="$sigs" finish --profile ds-to --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == timeout && "$(cut -d' ' -f1 "$sigs" | tr '\n' ' ')" == "SIGINT " ]]
    verdict "B13 timeoutMin elapsed: SIGINT to dsh, failed/timeout" $? "st=$ST signals=$(tr '\n' ' ' <"$sigs" 2>/dev/null) $SJ"

    # =============================================================================================================
    # C. doctor and probe (spec §4.3, §5.4): identity, version, env conflicts, --dump-config with the patch.
    # =============================================================================================================

    TEST_ROOT="$TEST_ROOT" REPO="$repo" DSH="$DSH" node_checks "C1" '
const fs = await import("node:fs");
const path = await import("node:path");
const root = process.env.TEST_ROOT;
const env = { ...process.env };
const writes = [];
const writeFiles = (spec) => { writes.push(spec); core.writeAdapterFiles(spec, env); };
const ctxOf = (profile, extra = {}) => core.makeCtx({ env, profile, profileName: "ds-doc", writeFiles, cwd: process.env.REPO, ...extra });
const levels = (checks) => Object.fromEntries(checks.map((c) => [c.name, c.level]));
const hint = (checks, name) => checks.find((c) => c.name === name)?.hint ?? "";
const base = { harness: "dsh", auth: { key: "deepseek" }, model: "deepseek-v4-pro", effort: "high", home: "user", sandbox: "off", bin: process.env.DSH };
let checks = await dsh.doctorChecks(base, ctxOf(base));
let l = levels(checks);
check("doctor: --dump-config accepts the patch (ok)", l["dsh-patch"] === "ok", checks);
check("doctor: the dump shows the pinned baseURL (ok)", l["dsh-endpoint"] === "ok", checks);
check("doctor: the dump shows session-log-deepseek off (ok)", l["dsh-session-log"] === "ok", checks);
check("doctor: the node runtime is checked", ["ok", "WARN"].includes(l["dsh-node"]), checks);
check("doctor: the permission modes are named", /danger-full-access/.test(hint(checks, "dsh-permissions")) && /read-only/.test(hint(checks, "dsh-permissions")));
check("doctor: dsh-permissions ok from the dump run as a reviewer (sandbox-policy read-only, approval ask)",
  l["dsh-permissions"] === "ok" && /sandbox-policy read-only/.test(hint(checks, "dsh-permissions")) && !/approval-policy/.test(hint(checks, "dsh-permissions")), checks);
const patch = writes.at(-1)?.files?.[0]?.path ?? "";
check("doctor: the patch template is written under the data root (doctor dir)",
  patch.startsWith(path.join(env.AGENT_DISPATCH_STATE_DIR, "state", "doctor")) && fs.existsSync(patch), patch);
check("every check has a name, a level and a hint", checks.every((c) => typeof c.name === "string" && ["ok", "WARN", "FAIL"].includes(c.level) && typeof c.hint === "string"));
check("doctor: the OS sandbox of the reviewer'"'"'s read-only mode is checked on this platform",
  (process.platform !== "darwin" && process.platform !== "linux") || (["ok", "WARN"].includes(l["dsh-sandbox"]) && /read-only/.test(hint(checks, "dsh-sandbox"))), checks);
check("doctor: no dsh-model warning when options.patch keeps the profile'"'"'s model", !("dsh-model" in l), checks);

// --dump-config initializes the headless profile of the job'"'"'s DSH_HOME (04b open question 4): a home no job used yet.
const iso = { ...base, home: "isolated" };
const isoProfile = path.join(env.AGENT_DISPATCH_STATE_DIR, "homes", "ds-init", "dsh", "profiles", "headless");
const before = fs.existsSync(isoProfile);
checks = await dsh.doctorChecks(iso, ctxOf(iso, { profileName: "ds-init" }));
check("doctor: --dump-config initializes the headless profile of a DSH_HOME no job has used (missing before, present after)",
  !before && levels(checks)["dsh-patch"] === "ok" && fs.existsSync(isoProfile), [before, checks]);

// The sandbox runner per platform, and wrap on macOS, with fake fs / exec (no dump: no writeFiles).
const realFs = core.makeCtx({ env }).fs;
const noExec = () => ({ status: 1, signal: null, stdout: "", stderr: "", error: null });
const fake = (platform, { stat, PATH = "/nowhere", profile = base } = {}) =>
  core.makeCtx({ env: { ...env, PATH }, profile, profileName: "ds-doc", platform, exec: noExec, fs: { ...realFs, stat: stat ?? realFs.stat }, cwd: process.env.REPO });
let c = await dsh.doctorChecks(base, fake("darwin", { stat: (f) => (f === "/usr/bin/sandbox-exec" ? null : realFs.stat(f)) }));
check("doctor (macOS, no sandbox-exec): dsh-sandbox WARN — reviewer runs would fail SANDBOX_UNAVAILABLE",
  levels(c)["dsh-sandbox"] === "WARN" && /sandbox-exec/.test(hint(c, "dsh-sandbox")) && /SANDBOX_UNAVAILABLE/.test(hint(c, "dsh-sandbox")), c);
c = await dsh.doctorChecks(base, fake("darwin", { stat: (f) => (f === "/usr/bin/sandbox-exec" ? { isFile: () => true } : realFs.stat(f)) }));
check("doctor (macOS, sandbox-exec present): dsh-sandbox ok, Seatbelt", levels(c)["dsh-sandbox"] === "ok" && /Seatbelt/.test(hint(c, "dsh-sandbox")), c);
const fakebin = path.join(root, "fakebin");
fs.mkdirSync(fakebin, { recursive: true });
fs.writeFileSync(path.join(fakebin, "bwrap"), "");
c = await dsh.doctorChecks(base, fake("linux", { PATH: fakebin }));
check("doctor (Linux, bwrap on PATH): dsh-sandbox ok", levels(c)["dsh-sandbox"] === "ok" && /bwrap/.test(hint(c, "dsh-sandbox")), c);
c = await dsh.doctorChecks(base, fake("linux"));
check("doctor (Linux, no bwrap): dsh-sandbox WARN naming Landlock as unchecked", levels(c)["dsh-sandbox"] === "WARN" && /Landlock/.test(hint(c, "dsh-sandbox")), c);
const sbx = { ...base, sandbox: "native" };
c = await dsh.doctorChecks(sbx, fake("linux", { PATH: fakebin, profile: sbx }));
check("doctor: with sandbox native the writer'"'"'s workspace-write is named too", /workspace-write/.test(hint(c, "dsh-sandbox")), c);
const wrappedFake = { ...base, wrap: ["srt", "--"] };
c = await dsh.doctorChecks(wrappedFake, fake("darwin", { profile: wrappedFake }));
check("doctor (macOS, wrap): dsh-wrap WARN — no nested Seatbelt for read-only / workspace-write", levels(c)["dsh-wrap"] === "WARN" && /Seatbelt/.test(hint(c, "dsh-wrap")) && /read-only/.test(hint(c, "dsh-wrap")), c);
c = await dsh.doctorChecks(wrappedFake, fake("linux", { profile: wrappedFake }));
check("doctor (Linux, wrap): no dsh-wrap warning (the nesting limit is macOS'"'"'s)", !("dsh-wrap" in levels(c)), c);
const remodel = { ...base, options: { patch: { "agent-default-model": { config: { model: "deepseek-flash" } } } } };
c = await dsh.doctorChecks(remodel, fake("linux", { profile: remodel }));
check("doctor: options.patch naming another model than the profile'"'"'s → dsh-model WARN", levels(c)["dsh-model"] === "WARN" && /deepseek-flash/.test(hint(c, "dsh-model")), c);
check("doctor without a dump: dsh-permissions WARN, not verified", levels(c)["dsh-permissions"] === "WARN" && /not verified/.test(hint(c, "dsh-permissions")), c);

// dsh-effort reads the rendered rows: options.patch may set another reasoningEffort than the profile'"'"'s.
const reEffort = { ...base, options: { patch: { "llm-deepseek": { config: { reasoningEffort: "xhigh" } } } } };
c = await dsh.doctorChecks(reEffort, fake("linux", { profile: reEffort }));
check("doctor: options.patch reasoningEffort xhigh in llm-deepseek (profile high) → dsh-effort WARN naming each row'"'"'s value",
  levels(c)["dsh-effort"] === "WARN" && /high in agent-default-model, reasoningEffort xhigh in llm-deepseek \(options\.patch\): xhigh is not one of/.test(hint(c, "dsh-effort")), c);
const fixedEffort = { ...base, effort: "xhigh", options: { patch: { "agent-default-model": { config: { reasoningEffort: "max" } }, "llm-deepseek": { config: { reasoningEffort: "max" } } } } };
c = await dsh.doctorChecks(fixedEffort, fake("linux", { profile: fixedEffort }));
check("doctor: a profile effort xhigh that options.patch replaces with max in both rows → dsh-effort ok",
  levels(c)["dsh-effort"] === "ok" && /reasoningEffort max in agent-default-model and llm-deepseek \(options\.patch\)/.test(hint(c, "dsh-effort")), c);

// The worktree and native-key warnings, with the same fakes (no dump).
const repoGit = path.join(process.env.REPO, ".git");
const linked = (f) => (f === repoGit ? { isFile: () => true } : realFs.stat(f));
c = await dsh.doctorChecks(sbx, fake("linux", { PATH: fakebin, profile: sbx, stat: linked }));
check("doctor: sandbox native in a linked worktree (.git is a file) → dsh-worktree WARN", levels(c)["dsh-worktree"] === "WARN" && /linked git worktree/.test(hint(c, "dsh-worktree")), c);
c = await dsh.doctorChecks(base, fake("linux", { PATH: fakebin, stat: linked }));
check("doctor: the same worktree without sandbox native → no dsh-worktree row (danger-full-access has no fence)", !("dsh-worktree" in levels(c)), c);
const nativeFake = { ...base, auth: "native" };
const keyFile = path.join(env.HOME, ".dsh", ".env");
fs.chmodSync(keyFile, 0o644);
c = await dsh.doctorChecks(nativeFake, fake("linux", { profile: nativeFake }));
fs.chmodSync(keyFile, 0o600);
check("doctor: native with a ~/.dsh/.env readable by others (0644) → dsh-auth WARN, expected 600", levels(c)["dsh-auth"] === "WARN" && /mode 644, expected 600/.test(hint(c, "dsh-auth")), c);

// dsh-permissions on dumps dsh might print — resolved values or the bundle'"'"'s expressions (the dump format and the row
// ids are unverified): a fake exec answers --version and --dump-config.
const dumped = (text) => (cmd, args = []) =>
  args.includes("--dump-config") ? { status: 0, signal: null, stdout: text, stderr: "", error: null }
    : cmd !== "node" && args.includes("--version") ? { status: 0, signal: null, stdout: "0.2.1-rc.2\n", stderr: "", error: null }
    : { status: 1, signal: null, stdout: "", stderr: "", error: null };
const graded = async (text) => {
  const g = await dsh.doctorChecks(base, core.makeCtx({ env, profile: base, profileName: "ds-doc", exec: dumped(text), writeFiles: () => {}, cwd: process.env.REPO }));
  return [levels(g)["dsh-permissions"], hint(g, "dsh-permissions")];
};
const head = "- id: agent-default-model\n  config:\n    provider: \"deepseek-official\"\n";
for (const [label, text, want, re] of [
  ["resolved rows: read-only, approval ask", head + "- id: sandbox-policy\n  config:\n    mode: \"read-only\"\n    workspaceRoot: \"/repo\"\n- id: approval-policy\n  config:\n    policy: \"ask\"\n", "ok", /reviewer read-only: .*sandbox-policy read-only/],
  ["the bundle'"'"'s expressions unresolved (their workspace-write fallback is not the row'"'"'s)",
    head + "- id: sandbox-policy\n  config:\n    mode: ${{ env.DSH_PERMISSION_MODE ?? \"workspace-write\" }}\n- id: approval-policy\n  config:\n    policy: ${{ env.DSH_PERMISSION_MODE === \"danger-full-access\" ? \"never\" : \"ask\" }}\n",
    "ok", /sandbox-policy follows DSH_PERMISSION_MODE, approval-policy follows DSH_PERMISSION_MODE/],
  ["a flow row pinning workspace-write", head + "- id: \"sandbox\"\n  config: {\"mode\": \"workspace-write\", \"workspaceRoot\": \"/repo\"}\n", "FAIL", /NOT read-only: .*shows sandbox workspace-write .*overrides DSH_PERMISSION_MODE: reviewer jobs run workspace-write;/],
  // [04b §7] names permission presets, not the shape of a row that lists them: a literal outside the mode / policy of a
  // sandbox or approval row is not graded (WARN, not verified), whichever mode it names.
  ["a permission-presets row naming danger-full-access", head + "- id: permission-presets\n  config:\n    preset: danger-full-access\n", "WARN",
    /reviewer read-only \(DSH_PERMISSION_MODE\) not verified: .*shows permission-presets danger-full-access outside the mode \/ policy of a sandbox or approval row/],
  ["a presets row listing every mode beside read-only sandbox / approval rows",
    head + "- id: sandbox-policy\n  config:\n    mode: \"read-only\"\n- id: approval-policy\n  config:\n    policy: \"ask\"\n- id: permission-presets\n  config:\n    presets: [\"read-only\", \"workspace-write\", \"danger-full-access\"]\n",
    "WARN", /not verified: .*shows permission-presets read-only, permission-presets workspace-write, permission-presets danger-full-access outside .*; the sandbox \/ approval rows show sandbox-policy read-only;/],
  ["a mode literal under another key of a sandbox row (an unknown shape)", head + "- id: sandbox-policy\n  config: {\"mode\": \"read-only\", \"escalation\": \"danger-full-access\"}\n", "WARN",
    /not verified: .*shows sandbox-policy danger-full-access outside the mode \/ policy .*; the sandbox \/ approval rows show sandbox-policy read-only;/],
  ["a sandbox row widening beside a presets row (graded first)", head + "- id: sandbox-policy\n  config:\n    mode: \"danger-full-access\"\n- id: permission-presets\n  config:\n    preset: read-only\n", "FAIL",
    /NOT read-only: .*shows sandbox-policy danger-full-access — /],
  ["approval never while the mode follows the variable", head + "- id: sandbox-policy\n  config:\n    mode: \"read-only\"\n- id: approval-policy\n  config:\n    policy: \"never\"\n", "FAIL", /reviewer read-only overridden: .*shows approval-policy never — .*no longer follow it/],
  ["no permission row", head + "- id: tool-web\n  config: {}\n", "WARN", /not verified/],
  ["a permission row with no mode (a path is no mode)", head + "- id: sandbox-policy\n  config:\n    workspaceRoot: \"/w/read-only/danger-full-access-repo\"\n", "WARN", /not verified/],
]) {
  const [level, text2] = await graded(text);
  check(`dsh-permissions on a dump with ${label} → ${want}`, level === want && re.test(text2), [level, text2]);
}
check("permissionRows: ids and values of the matching rows only", typeof mod.permissionRows === "function" && JSON.stringify(mod.permissionRows(head + "- id: sandbox-policy\n  config: {\"mode\": \"read-only\"}\n- id: tool-web\n  config: {\"mode\": \"danger-full-access\"}\n")) === JSON.stringify([{ id: "sandbox-policy", value: "read-only" }]));
const marked = mod.permissionRows(head + "- id: permission-presets\n  config:\n    preset: never\n- id: sandbox-policy\n  config: {\"mode\": \"read-only\", \"escalation\": \"never\"}\n- id: approval-policy\n  config:\n    policy: never\n");
check("permissionRows: only the mode / policy of a sandbox or approval row is graded; any other literal is marked unverified",
  JSON.stringify(marked) === JSON.stringify([{ id: "permission-presets", value: "never", unverified: true }, { id: "sandbox-policy", value: "read-only" }, { id: "sandbox-policy", value: "never", unverified: true }, { id: "approval-policy", value: "never" }]), marked);

env.AGENT_STUB_MODE = "dump-fail";
checks = await dsh.doctorChecks(base, ctxOf(base));
check("doctor: dsh rejecting the patch → FAIL with its message", levels(checks)["dsh-patch"] === "FAIL" && /invalid patch/.test(hint(checks, "dsh-patch")), checks);
env.AGENT_STUB_MODE = "dancer";
checks = await dsh.doctorChecks(base, ctxOf(base));
check("doctor: no --dump-config against a dsh that is not DeepSeek Harness", levels(checks)["dsh-patch"] === "WARN" && /not checked/.test(hint(checks, "dsh-patch")), checks);
delete env.AGENT_STUB_MODE;

checks = await dsh.doctorChecks(base, core.makeCtx({ env, profile: base, profileName: "ds-doc" }));
check("doctor: without a file writer in ctx the dump is reported as not checked (WARN)", levels(checks)["dsh-patch"] === "WARN" && /writeFiles/.test(hint(checks, "dsh-patch")), checks);

const native = { ...base, auth: "native" };
checks = await dsh.doctorChecks(native, ctxOf(native));
check("doctor: native with ~/.dsh/.env (0600) → ok, its content never read", levels(checks)["dsh-auth"] === "ok" && /mode 600/.test(hint(checks, "dsh-auth")), checks);
checks = await dsh.doctorChecks({ ...native, home: "isolated" }, ctxOf({ ...native, home: "isolated" }));
check("doctor: native in an isolated home without .env → WARN naming the file", levels(checks)["dsh-auth"] === "WARN" && /homes\/ds-doc\/dsh\/\.env/.test(hint(checks, "dsh-auth")), checks);
checks = await dsh.doctorChecks({ ...base, effort: "xhigh" }, ctxOf({ ...base, effort: "xhigh" }));
check("doctor: an effort outside off|low|high|max → WARN", levels(checks)["dsh-effort"] === "WARN", checks);
checks = await dsh.doctorChecks({ ...base, options: { sessionLog: true } }, ctxOf({ ...base, options: { sessionLog: true } }));
check("doctor: sessionLog on is reported as on", levels(checks)["dsh-session-log"] === "ok" && /uploads/.test(hint(checks, "dsh-session-log")), checks);
fs.writeFileSync(path.join(process.env.REPO, ".env"), "X=1\n");
checks = await dsh.doctorChecks(base, ctxOf(base));
fs.rmSync(path.join(process.env.REPO, ".env"));
check("doctor: a repo .env → WARN (read before $DSH_HOME/.env)", levels(checks)["dsh-repo-env"] === "WARN", checks);

// A row of a $DSH_HOME layer outranks the bundle row that reads DSH_PERMISSION_MODE [04b §2, §7]: the stub applies the
// layers like dsh, and doctor grades the dump it ran as a reviewer. The layers are stat'"'"'ed, never read by the adapter.
const userHome = path.join(env.HOME, ".dsh");
const homeLayer = path.join(userHome, "cordis.patch.yml");
const profileLayer = path.join(userHome, "profiles", "headless", "cordis.patch.yml");
const reads = [];
const spyFs = { ...realFs, readFile: (f, ...rest) => (reads.push(f), realFs.readFile(f, ...rest)) };
const layerTemplate = fs.readFileSync(profileLayer, "utf8");
fs.writeFileSync(homeLayer, "- id: sandbox-policy\n  config: {\"mode\": \"danger-full-access\"}\n");
checks = await dsh.doctorChecks(base, ctxOf(base, { fs: spyFs }));
check("doctor: ~/.dsh/cordis.patch.yml pins sandbox-policy danger-full-access → dsh-permissions FAIL naming both home layers",
  levels(checks)["dsh-permissions"] === "FAIL" && /reviewer NOT read-only: --dump-config with DSH_PERMISSION_MODE=read-only shows sandbox-policy danger-full-access/.test(hint(checks, "dsh-permissions"))
    && hint(checks, "dsh-permissions").includes(`check ${profileLayer}, ${homeLayer} (not read here)`), checks);
check("doctor: the home layers are never read by the adapter (stat only)", !reads.some((f) => f.startsWith(userHome)), reads);
fs.rmSync(homeLayer);
fs.writeFileSync(profileLayer, "- id: approval-policy\n  config: {\"policy\": \"never\"}\n");
checks = await dsh.doctorChecks(base, ctxOf(base));
check("doctor: profiles/headless/cordis.patch.yml pins approval never → dsh-permissions FAIL", levels(checks)["dsh-permissions"] === "FAIL" && /approval-policy never/.test(hint(checks, "dsh-permissions")), checks);
fs.writeFileSync(profileLayer, "- id: sandbox-policy\n  config: {\"mode\": \"read-only\"}\n");
checks = await dsh.doctorChecks(base, ctxOf(base));
check("doctor: a layer that pins read-only → dsh-permissions ok", levels(checks)["dsh-permissions"] === "ok", checks);
fs.writeFileSync(profileLayer, layerTemplate);
const wrapped = { ...base, wrap: ["/usr/bin/env", "DSH_WRAPPED=yes"] };
checks = await dsh.doctorChecks(wrapped, ctxOf(wrapped));
check("doctor: --dump-config runs through wrap too", levels(checks)["dsh-patch"] === "ok", checks);
'

    # The CLI's doctor: identity and version through discover, env conflicts, the adapter's checks.
    run_ad doctor --profile ds-key
    [[ "$RC" -eq 0 && "$OUT" == *"ok harness ds-key: $DSH 0.2.1-rc.2"* && "$OUT" != *"version ds-key"* && "$OUT" == *"ok env ds-key: no conflict"* \
        && "$OUT" == *"ds-key: writer danger-full-access, reviewer read-only"* && "$OUT" == *"ok dsh-patch ds-key:"* && "$OUT" == *"ok dsh-endpoint ds-key:"* \
        && "$OUT" == *"ok dsh-session-log ds-key:"* ]]
    verdict "C2 doctor --profile ds-key: harness 0.2.1-rc.2 (verified), no env conflict, the adapter's checks (the CLI passes writeFiles: dump-config, endpoint and session log ok)" $? "rc=$RC" "$OUT"
    AGENT_STUB_VERSION=0.2.2 run_ad doctor --profile ds-key
    [[ "$RC" -eq 0 && "$OUT" == *"WARN version ds-key: dsh 0.2.2 was not checked; checked: 0.2.1-rc.2"* ]]
    verdict "C2 an unverified dsh version is one WARN line, not a refusal" $? "$OUT"
    AGENT_STUB_MODE=dancer run_ad doctor --profile ds-key
    [[ "$RC" -eq 1 && "$OUT" == *"FAIL harness ds-key:"*"not DeepSeek Harness"*"Dancer"* ]]
    verdict "C2 doctor: Homebrew's dsh is a FAIL naming it" $? "$OUT"
    run_ad doctor --profile ds-conmode
    [[ "$RC" -eq 1 && "$OUT" == *"FAIL env ds-conmode: profile env DSH_PERMISSION_MODE conflicts"* ]]
    verdict "C2 doctor: profile env touching a mandatory setting is a FAIL" $? "$OUT"
    run_ad doctor --profile ds-badurl
    [[ "$RC" -eq 1 && "$OUT" == *"FAIL env ds-badurl:"*"baseURL"* ]]
    verdict "C2 doctor: options.patch against A5 is a FAIL" $? "$OUT"
    run_ad doctor --profile ds-sbx
    [[ "$OUT" == *"sandbox ds-sbx: native"* && "$OUT" == *"writer workspace-write, reviewer read-only"* ]]
    verdict "C2 doctor: sandbox native is checked and named (workspace-write for writers)" $? "$OUT"
    run_ad doctor --profile ds-key
    [[ "$OUT" == *"ok dsh-permissions ds-key: writer danger-full-access, reviewer read-only: --dump-config with DSH_PERMISSION_MODE=read-only shows sandbox-policy read-only"* ]]
    verdict "C2 doctor: dsh-permissions ok only from the dump (run with the reviewer's DSH_PERMISSION_MODE=read-only)" $? "$OUT"
    # A home patch must not widen a bounded launch, including an existing session resumed after the patch changed.
    finish --profile ds-rev --prompt-file "$prompt"
    local c2_base="$JOB"
    [[ "$ST" == completed ]]
    verdict "C2 a normal read-only session completes before changing its home policy" $? "st=$ST $SJ"
    local c2_condition
    for c2_condition in presence value; do
        CONDITION="$c2_condition" TEST_KEY="$KEY" node -e '
const fs = require("node:fs");
const path = require("node:path");
const predicate = process.env.CONDITION === "presence" ? "env.DEEPSEEK_API_KEY" : `env.DEEPSEEK_API_KEY === ${JSON.stringify(process.env.TEST_KEY)}`;
const expression = "${{ " + predicate + " ? \"danger-full-access\" : \"read-only\" }}";
fs.writeFileSync(path.join(process.env.HOME, ".dsh", "cordis.patch.yml"), "- id: sandbox-policy\n  config: " + JSON.stringify({ mode: expression }) + "\n");'
        # This is the stale preflight environment: it reports safe permissions without the job credential.
        out="$(env -u DEEPSEEK_API_KEY "$DSH" --profile headless --dump-config)"
        [[ "$out" == *'mode: "read-only"'* ]]
        verdict "C2 key-$c2_condition conditional config looks read-only in a scrubbed dump" $? "$out"
        rec="$TEST_ROOT/rec-c2-key-$c2_condition.json"
        eff="$TEST_ROOT/eff-c2-key-$c2_condition.json"
        AGENT_STUB_MODE=dump-key-output AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-rev --prompt-file "$prompt"
        [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && ! -e "$rec" && ! -e "$eff" ]]
        verdict "C2 preflight uses the actual key-$c2_condition environment and blocks the wider model turn" $? "st=$ST $SJ"
        ! grep -qF "$KEY" "$JOBS/$JOB.log" "$JOBS/$JOB.json" "$JOBS/$JOB.json.terminal" && [[ "$SJ" != *"$KEY"* ]]
        verdict "C2 key-$c2_condition dump stdout and stderr never expose the key in dispatcher state or logs" $? "job=$JOB"
    done
    rm -f "$HOME/.dsh/cordis.patch.yml"
    rec="$TEST_ROOT/rec-c2-dump-key-fail.json"
    eff="$TEST_ROOT/eff-c2-dump-key-fail.json"
    AGENT_STUB_MODE=dump-key-fail AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-rev --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && ! -e "$rec" && ! -e "$eff" ]] \
        && ! grep -qF "$KEY" "$JOBS/$JOB.log" "$JOBS/$JOB.json" "$JOBS/$JOB.json.terminal" && [[ "$SJ" != *"$KEY"* ]]
    verdict "C2 a failing dump may echo its key on either stream without persisting it or starting a model turn" $? "st=$ST $SJ"
    printf -- '- id: sandbox-policy\n  config: {"mode": "danger-full-access"}\n' >"$HOME/.dsh/cordis.patch.yml"
    rec="$TEST_ROOT/rec-c2l.json"
    eff="$TEST_ROOT/eff-c2l.json"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-rev --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && -z "$(jfield job.childPid <<<"$SJ")" && ! -e "$rec" && ! -e "$eff" \
        && "$(jfield job.note <<<"$SJ")" == *"cannot verify dsh read-only permissions"*"harness not started"* ]]
    verdict "C2 danger-full-access home policy blocks a reviewer before the model-turn stub starts" $? "st=$ST $SJ"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-rev --resume-task "$c2_base" --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && ! -e "$rec" && ! -e "$eff" ]]
    verdict "C2 resume rechecks the changed home policy before starting the old session" $? "st=$ST $SJ"
    TEST_ROOT="$TEST_ROOT" DSH="$DSH" node_checks "C2 probe guard" '
const fs = await import("node:fs");
const path = await import("node:path");
const record = path.join(process.env.TEST_ROOT, "rec-c2-probe.json");
const effective = path.join(process.env.TEST_ROOT, "eff-c2-probe.json");
const profile = { harness: "dsh", auth: "native", home: "user", sandbox: "off", bin: process.env.DSH };
const env = { ...process.env, AGENT_STUB_RECORD: record, AGENT_STUB_EFFECTIVE: effective };
let refusal = null;
try { await core.runProbe({ adapter: dsh, profileName: "ds-native", profile, env }); }
catch (error) { refusal = error; }
check("a direct probe with a wider home policy never starts the model-turn stub", refusal?.errorClass === "launch" &&
  /harness not started/.test(refusal.message) && !fs.existsSync(record) && !fs.existsSync(effective), refusal?.message);
'
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-sbx --write --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && ! -e "$rec" && ! -e "$eff" ]]
    verdict "C2 native writer also refuses a home policy wider than workspace-write" $? "st=$ST $SJ"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-key --write --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$eff" permissionMode)" == danger-full-access ]]
    verdict "C2 writer with sandbox off preserves its explicit full-access mode" $? "st=$ST eff=$(ffield "$eff" permissionMode)"
    run_ad doctor --profile ds-rev
    [[ "$RC" -eq 1 && "$OUT" == *"FAIL dsh-permissions ds-rev: writer danger-full-access, reviewer NOT read-only:"*"sandbox-policy danger-full-access"*"$HOME/.dsh/cordis.patch.yml"* ]]
    verdict "C2 doctor: that layer → FAIL dsh-permissions naming the file, exit 1" $? "rc=$RC" "$OUT"
    rm -f "$rec" "$eff"
    printf -- '- id: sandbox-policy\n  config: {"mode": "workspace-write"}\n' >"$HOME/.dsh/cordis.patch.yml"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-rev --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && ! -e "$rec" && ! -e "$eff" ]]
    verdict "C2 workspace-write is still too wide for a reviewer" $? "st=$ST $SJ"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-sbx --write --prompt-file "$prompt"
    [[ "$ST" == completed && "$(ffield "$eff" permissionMode)" == workspace-write ]]
    verdict "C2 native writer accepts a matching workspace-write home policy" $? "st=$ST eff=$(ffield "$eff" permissionMode)"
    rm -f "$rec" "$eff"
    printf -- '- id: approval-policy\n  config: {"policy": "never"}\n' >"$HOME/.dsh/cordis.patch.yml"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-rev --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && ! -e "$rec" && ! -e "$eff" ]]
    verdict "C2 approval never cannot silently override a bounded reviewer" $? "st=$ST $SJ"
    printf -- '- id: sandbox-policy\n  config: {"mode": "future-mode"}\n' >"$HOME/.dsh/cordis.patch.yml"
    AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-rev --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && ! -e "$rec" && ! -e "$eff" ]]
    verdict "C2 an unknown effective mode fails closed before a model turn" $? "st=$ST $SJ"
    rm -f "$HOME/.dsh/cordis.patch.yml"
    AGENT_STUB_MODE=dump-fail AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" finish --profile ds-rev --prompt-file "$prompt"
    [[ "$ST" == failed && "$(jfield job.errorClass <<<"$SJ")" == launch && ! -e "$rec" && ! -e "$eff" ]]
    verdict "C2 a failing offline dump cannot fall through into a reviewer model turn" $? "st=$ST $SJ"

    # --- C3. doctor --probe: one read-only PONG turn, no web tools ---
    rec="$TEST_ROOT/rec-c3.json"
    eff="$TEST_ROOT/eff-c3.json"
    AGENT_STUB_RESPONSE=PONG AGENT_STUB_RECORD="$rec" AGENT_STUB_EFFECTIVE="$eff" run_ad doctor --profile ds-key --probe
    [[ "$RC" -eq 0 && "$(tail -1 <<<"$OUT")" == "ok probe ds-key: PONG in "*" s" && "$(ffield "$rec" env.DSH_PERMISSION_MODE)" == read-only \
        && "$(ffield "$rec" env.DEEPSEEK_API_KEY)" == "$KEY" && "$(ffield "$eff" toolWeb)" == false && "$(ffield "$eff" model)" == deepseek-v4-pro ]]
    verdict "C3 doctor --probe: PONG through the core, read-only, the profile's model, tool-web disabled" $? "rc=$RC" "$OUT" "$(head -c 600 "$eff" 2>/dev/null)"
    AGENT_STUB_MODE=quota run_ad doctor --profile ds-key --probe
    [[ "$RC" -eq 1 && "$(tail -1 <<<"$OUT")" == "FAIL probe ds-key: failed/quota: QUOTA: Insufficient Balance" ]]
    verdict "C3 a probe on an empty balance: FAIL failed/quota" $? "$OUT"

    # --- leak check: nothing this run started is still running ---
    local left=""
    i=0
    while ((i < 50)); do
        left="$(pgrep -f "$TEST_ROOT" | tr '\n' ' ')"
        [[ -z "$left" ]] && break
        sleep 0.2
        i=$((i + 1))
    done
    [[ -z "$left" ]]
    verdict "no process of this run (runner, stub) outlives the suite" $? "left: $left"

    echo ""
    echo "PASS count: $PASSES"
    if [[ "$FAILURES" -ne 0 ]]; then
        echo "FAILED: $FAILURES assertion(s)."
        exit 1
    fi
    echo "PASS"
}

main "$@"
