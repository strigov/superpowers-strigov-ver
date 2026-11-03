#!/usr/bin/env bash
# Tests for bin/lib/adapters/kimi.mjs, the core adapter of the kimi harness (Kimi Code CLI 2.4.x). Zero model calls
# and no real kimi: profiles point "bin" at a per-run link to tests/fixtures/agent-stub.cjs in its kimi-jsonl dialect
# (tests/fixtures/stub-dialects/kimi-jsonl.cjs), which reproduces kimi's prompt mode as the adapter cites it from the
# 2.4.1 source and records argv, env and stdin. Jobs go through the real CLI (bin/lib/agent-dispatch.mjs) with all
# state under a temp root (AGENT_DISPATCH_STATE_DIR, HOME); the pure adapter functions are also called directly.
# Runs on macOS and Linux.
#
# Every process a run starts carries the run's temp root in its argv, so the cleanup and the leak check touch this run
# only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_ROOT/bin/lib/agent-dispatch.mjs"
CORE="$REPO_ROOT/bin/lib/agent-core.mjs"
ADAPTER="$REPO_ROOT/bin/lib/adapters/kimi.mjs"
STUB="$SCRIPT_DIR/fixtures/agent-stub.cjs"

FAILURES=0
PASSES=0
TEST_ROOT=""
OUT=""
ERR=""
RC=0
ID=""

pass() {
    echo "  [PASS] $1"
    PASSES=$((PASSES + 1))
}
fail() {
    echo "  [FAIL] $1"
    FAILURES=$((FAILURES + 1))
}
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
    if [[ -n "$TEST_ROOT" ]]; then pkill -KILL -f "$TEST_ROOT" 2>/dev/null || true; fi
    if [[ -n "$TEST_ROOT" && -d "$TEST_ROOT" ]]; then rm -rf "$TEST_ROOT"; fi
}

ad() { node "$CLI" "$@"; }
run_ad() {
    OUT="$(ad "$@" 2>"$TEST_ROOT/stderr.txt")"
    RC=$?
    ERR="$(cat "$TEST_ROOT/stderr.txt")"
}
run_env() {
    local -a vars=()
    while [[ $# -gt 0 && "$1" != "--" ]]; do
        vars+=("$1")
        shift
    done
    shift
    OUT="$(env ${vars[@]+"${vars[@]}"} node "$CLI" "$@" 2>"$TEST_ROOT/stderr.txt")"
    RC=$?
    ERR="$(cat "$TEST_ROOT/stderr.txt")"
}
start() {
    local -a vars=()
    while [[ $# -gt 0 && "$1" != "--" ]]; do
        vars+=("$1")
        shift
    done
    shift
    run_env ${vars[@]+"${vars[@]}"} -- task --background "$@"
    ID=""
    if [[ "$RC" -eq 0 ]]; then ID="${OUT##* }"; fi
}
jfield() {
    node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let v = JSON.parse(s);
  for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
  process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
});' "$1"
}
jarr() { node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@"; }
env_names() {
    node -e 'const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
console.log(Object.keys(r.env).filter((n) => new RegExp(process.argv[2]).test(n)).sort().join(" "));' -- "$1" "$2"
}
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
job() { ad status "$1" --json 2>/dev/null | jfield "job.$2"; }
outcome() {
    local st
    st="$(wait_status "$1" 'completed|failed|cancelled' 20)"
    echo "$st/$(job "$1" errorClass)"
}
wait_file() {
    local i=0
    while ((i < 50)); do
        if [[ -s "$1" ]]; then return 0; fi
        sleep 0.2
        i=$((i + 1))
    done
    return 1
}
mode_of() { node -e 'console.log((require("node:fs").statSync(process.argv[1]).mode & 0o777).toString(8))' -- "$1"; }
kimi_js() {
    local script="$1"
    shift
    CORE="$CORE" ADAPTER="$ADAPTER" node --input-type=module -e "
const { pathToFileURL } = await import('node:url');
const core = await import(pathToFileURL(process.env.CORE).href);
const mod = await import(pathToFileURL(process.env.ADAPTER).href);
const kimi = mod.default;
$script" "$@"
}
jobs_dir_of() { kimi_js 'console.log(core.resolveWorkspace(process.argv[1]).jobsDir);' "$1"; }

main() {
    echo "=== Test: kimi adapter ==="

    TEST_ROOT="$(mktemp -d)"
    trap cleanup EXIT
    umask 022

    export HOME="$TEST_ROOT/home"
    mkdir -p "$HOME" "$TEST_ROOT/bin" "$TEST_ROOT/rec" "$TEST_ROOT/user-kimi"
    export AGENT_DISPATCH_STATE_DIR="$TEST_ROOT/state"
    local STATE="$AGENT_DISPATCH_STATE_DIR"
    local CONFIG="$STATE/config.json"
    local KIMI="$TEST_ROOT/bin/kimi"
    ln -s "$STUB" "$KIMI"
    ln -s "$STUB" "$TEST_ROOT/bin/kimi-drop"
    unset AGENT_TEST_BOOT_ID AGENT_DISPATCH_ADAPTER_DIR WRAPPED
    unset AGENT_STUB_MODE AGENT_STUB_RECORD AGENT_STUB_DELAY_MS AGENT_STUB_MESSAGE AGENT_STUB_CLASS AGENT_STUB_EXIT AGENT_STUB_RESPONSE
    unset AGENT_STUB_PIDS AGENT_STUB_SIGNALS AGENT_STUB_VERSION AGENT_STUB_HELP_DROP AGENT_STUB_CALL_LOG
    export AGENT_STUB_DIALECT=kimi-jsonl
    export AGENT_ENV_PASSTHROUGH="AGENT_STUB_DIALECT,AGENT_STUB_MODE,AGENT_STUB_RECORD,AGENT_STUB_DELAY_MS,AGENT_STUB_MESSAGE,AGENT_STUB_EXIT,AGENT_STUB_RESPONSE,AGENT_STUB_PIDS,AGENT_STUB_SIGNALS,AGENT_STUB_VERSION,AGENT_STUB_HELP_DROP,KIMI_MODEL_NAME,KIMI_CODE_TRUST_WORKSPACE"
    # The caller's environment carries a kimi home and env-only model settings: none may reach a keyed profile.
    export KIMI_CODE_HOME="$TEST_ROOT/user-kimi"
    export KIMI_MODEL_NAME="caller-model" KIMI_CODE_TRUST_WORKSPACE=1
    local KKEY="kimi-key-value-271828"

    local git_id=(-c user.email=t@example.com -c user.name=t -c commit.gpgsign=false)
    git init -q -b main "$TEST_ROOT/repo"
    printf 'x\n' >"$TEST_ROOT/repo/a.txt"
    (cd "$TEST_ROOT/repo" && git add a.txt && git "${git_id[@]}" commit -qm c0)
    local repo
    repo="$(cd "$TEST_ROOT/repo" && git rev-parse --show-toplevel)"
    local prompt="$TEST_ROOT/prompt.md"
    printf '## Headless run\n\nImplement the thing. "Quoted" text stays one argument.' >"$prompt"
    local big="$TEST_ROOT/big.md"
    node -e 'process.stdout.write("x".repeat(130 * 1024))' >"$big"
    cd "$repo"
    local JOBS
    JOBS="$(jobs_dir_of "$repo")"
    printf '%s\n' "$KKEY" | ad key set kimi-code >/dev/null

    local base="\"harness\": \"kimi\", \"bin\": \"$KIMI\""
    local keyp="$base, \"auth\": { \"key\": \"kimi-code\" }, \"model\": \"k3.1-pro\""
    mkdir -p "$STATE"
    cat >"$CONFIG" <<EOF
{
  "version": 1,
  "profiles": {
    "kimi-key": { $keyp, "effort": "max" },
    "kimi-k28": { $base, "auth": { "key": "kimi-code" }, "model": "kimi-k2.8-preview", "endpoint": "https://api.kimi.com/coding/v1", "options": { "contextSize": 1048576 } },
    "kimi-key-user": { $keyp, "home": "user" },
    "kimi-login": { $base, "auth": "login", "model": "kimi-code/k3" },
    "kimi-login-iso": { $base, "auth": "login", "model": "kimi-code/k3", "home": "isolated" },
    "kimi-clash": { $keyp, "env": { "KIMI_MODEL_NAME": "x" } },
    "kimi-telemetry": { $keyp, "env": { "KIMI_DISABLE_TELEMETRY": "0" } },
    "kimi-drop": { "harness": "kimi", "bin": "$TEST_ROOT/bin/kimi-drop", "auth": { "key": "kimi-code" }, "model": "k3.1-pro" }
  }
}
EOF
    set +e

    local ok want got rec st id1 dir n line

    # --- 1. the adapter contract and its loading by the CLI ---
    got="$(kimi_js 'const m = kimi.manifest;
console.log(JSON.stringify([kimi.id, kimi.idPrefix, m.sessionId, m.cancel.ladder, m.helpArgv, m.requiredFlags, m.homeEnv, m.verifiedVersions,
  ["discover", "prepareHome", "invocation", "probe", "reduce", "resumeCheck", "doctorChecks", "loginEnv"].every((k) => typeof kimi[k] === "function"),
  Object.keys(kimi.patterns).sort()]));')"
    want='["kimi","ki","first-event",[["SIGTERM",10000],["SIGKILL",0]],["--help"],["--prompt","--output-format","--model","--session","--skills-dir","--agent-file"],["KIMI_CODE_HOME"],["2.4.1"],true,["auth","blocked","context","launch","model-not-selected","quota","rate-limit","resume-lost","server"]]'
    [[ "$got" == "$want" ]]
    verdict "1 contract: id kimi, prefix ki, session id from the stream (first-event), SIGTERM 10 s → SIGKILL, required flags, KIMI_CODE_HOME, 2.4.1" $? "got:  $got" "want: $want"
    got="$(CLI="$CLI" node --input-type=module -e "
const { pathToFileURL } = await import('node:url');
const cli = await import(pathToFileURL(process.env.CLI).href);
const a = await cli.loadCoreAdapter('kimi');
console.log(a?.id, a?.idPrefix, cli.CORE_HARNESSES.includes('kimi'));")"
    [[ "$got" == "kimi ki true" ]]
    verdict "1 agent-dispatch loads bin/lib/adapters/kimi.mjs for harness kimi" $? "got: $got"

    # --- 2. writer, keyed: argv, env, the config.toml of the isolated home ---
    start AGENT_STUB_RECORD="$TEST_ROOT/rec/key-w.json" -- --profile kimi-key --role implementer --write --prompt-file "$prompt"
    id1="$ID"
    st="$(outcome "$id1")"
    rec="$TEST_ROOT/rec/key-w.json"
    want="$(jarr -p "$(cat "$prompt")" --output-format stream-json -m k3.1-pro --skills-dir "$JOBS/$id1/no-skills")"
    got="$(jfield argv <"$rec")"
    [[ "$OUT" == "agent-dispatch: kimi-key task started in the background as $id1" && "$id1" == ki-0001 && "$st" == completed/ && "$got" == "$want" ]]
    verdict "2 writer: kimi -p <prompt file text> --output-format stream-json -m <model> --skills-dir <job>/no-skills (no --agent-file, no -S)" $? "out: $OUT st: $st" "got:  $got" "want: $want"
    local home="$STATE/homes/kimi-key/kimi"
    [[ "$(jfield env.AGENT_DISPATCH_KIMI_API_KEY <"$rec")" == "$KKEY" && "$(jfield env.KIMI_CODE_HOME <"$rec")" == "$home" && "$(mode_of "$home")" == 700 \
        && "$(jfield env.KIMI_DISABLE_TELEMETRY <"$rec")" == 1 && "$(jfield env.KIMI_CODE_NO_AUTO_UPDATE <"$rec")" == 1 && "$(jfield env.KIMI_DISABLE_CRON <"$rec")" == 1 \
        && "$(jfield env.KIMI_CODE_BACKGROUND_PRINT_BACKGROUND_MODE <"$rec")" == exit && "$(jfield env.KIMI_MODEL_THINKING_EFFORT <"$rec")" == max \
        && -z "$(jfield env.KIMI_MODEL_NAME <"$rec")" && -z "$(jfield env.KIMI_CODE_TRUST_WORKSPACE <"$rec")" && "$(jfield stdin <"$rec")" == "" ]]
    verdict "2 env: the key only in AGENT_DISPATCH_KIMI_API_KEY, isolated KIMI_CODE_HOME (0700), telemetry/update/cron off, background mode exit, effort → KIMI_MODEL_THINKING_EFFORT; the caller's KIMI_MODEL_NAME and KIMI_CODE_TRUST_WORKSPACE removed even when passed through" $? \
        "names: $(env_names "$rec" '^KIMI_|^AGENT_DISPATCH_KIMI')"
    local cfg="$home/config.toml"
    [[ -f "$cfg" && "$(mode_of "$cfg")" == 600 ]] && grep -qxF 'default_model = "k3.1-pro"' "$cfg" && grep -qxF 'api_key_env = "AGENT_DISPATCH_KIMI_API_KEY"' "$cfg" \
        && grep -qxF 'base_url = "https://api.kimi.ai/coding/v1"' "$cfg" && grep -qxF '[models."k3.1-pro"]' "$cfg" && grep -qxF 'max_context_size = 262144' "$cfg" \
        && ! grep -qF "$KKEY" "$cfg"
    verdict "2 config.toml (0600) of the isolated home: provider of type kimi on https://api.kimi.ai/coding/v1 with api_key_env, the model as the only alias, 256K context; the key itself is nowhere in it" $? "$(cat "$cfg" 2>/dev/null)"
    [[ "$(job "$id1" sessionId)" =~ ^session_[0-9a-f-]{36}$ && "$(ad result "$id1")" == $'DONE\nstub finished' && "$(job "$id1" meta.kimiVersion)" == 2.4.1 ]] && ! grep -qF "$KKEY" "$JOBS/$id1.log"
    verdict "2 completed: the session id from the resume hint, the final assistant text as the result, kimi's version in meta; no key in the job log" $? "sid=$(job "$id1" sessionId)"

    start AGENT_STUB_RECORD="$TEST_ROOT/rec/k28.json" -- --profile kimi-k28 --role implementer --write --prompt-file "$prompt"
    st="$(outcome "$ID")"
    cfg="$STATE/homes/kimi-k28/kimi/config.toml"
    [[ "$st" == completed/ && "$(jfield argv <"$TEST_ROOT/rec/k28.json")" == *'"-m","kimi-k2.8-preview"'* && -z "$(jfield env.KIMI_MODEL_THINKING_EFFORT <"$TEST_ROOT/rec/k28.json")" ]] \
        && grep -qxF 'base_url = "https://api.kimi.com/coding/v1"' "$cfg" && grep -qxF 'max_context_size = 1048576' "$cfg"
    verdict "2 a second model on the same key: its own home and config.toml (endpoint, options.contextSize); no effort, no KIMI_MODEL_THINKING_EFFORT" $? "st: $st"

    # --- 3. reviewer: --agent-file with Read, Glob, Grep only ---
    start AGENT_STUB_MODE=context-echo AGENT_STUB_RECORD="$TEST_ROOT/rec/key-r.json" -- --profile kimi-key --role control-review --prompt-file "$prompt"
    st="$(outcome "$ID")"
    dir="$JOBS/$ID"
    want="$(jarr -p "$(cat "$prompt")" --output-format stream-json -m k3.1-pro --skills-dir "$dir/no-skills" --agent-file "$dir/reviewer-agent.md")"
    [[ "$st" == completed/ && "$(jfield argv <"$TEST_ROOT/rec/key-r.json")" == "$want" && "$(ad result "$ID")" == *"agentfile=Read,Glob,Grep" ]]
    verdict "3 reviewer (no --write): --agent-file <job>/reviewer-agent.md whose tools are Read, Glob, Grep; the answer is the last text after the tool turn" $? "st: $st" "result: $(ad result "$ID")"
    local reviewer_id="$ID"

    # --- 4. resume ---
    start AGENT_STUB_MODE=context-echo -- --profile kimi-key --role implementer --write --prompt-file "$prompt"
    local first="$ID"
    st="$(outcome "$first")"
    local sid
    sid="$(job "$first" sessionId)"
    start AGENT_STUB_MODE=context-echo AGENT_STUB_RECORD="$TEST_ROOT/rec/resume.json" -- --profile kimi-key --role implementer --write --resume-task "$first" --prompt-file "$prompt"
    st="$(outcome "$ID")"
    [[ "$st" == completed/ && "$(jfield argv <"$TEST_ROOT/rec/resume.json")" == *"\"-S\",\"$sid\""* && "$(ad result "$ID")" == *"session $sid resumed=true"* && "$(job "$ID" sessionId)" == "$sid" ]]
    verdict "4 --resume-task: -S <the session id of the job> from the same cwd and home; the session goes on" $? "st: $st sid: $sid result: $(ad result "$ID")"
    run_ad task --profile kimi-key --role control-review --background --resume-task "$first" --prompt-file "$prompt"
    [[ "$RC" -eq 2 && "$ERR" == *"read-only kimi job runs with --agent-file, which kimi cannot combine with --session"*"dispatch --fresh" ]]
    verdict "4 a read-only job is never resumed (kimi refuses --agent-file with --session): refused, dispatch --fresh" $? "rc=$RC err: $ERR"
    run_ad task --profile kimi-key --role implementer --write --background --resume-task "$reviewer_id" --prompt-file "$prompt"
    [[ "$RC" -eq 2 && "$ERR" == *"ran read-only"*"dispatch --fresh" ]]
    verdict "4 a writer does not resume a reviewer's session: refused, dispatch --fresh" $? "rc=$RC err: $ERR"
    start AGENT_STUB_MODE=lose-session -- --profile kimi-key --role implementer --write --resume-task "$first" --prompt-file "$prompt"
    st="$(outcome "$ID")"
    [[ "$st" == failed/resume-lost ]]
    verdict "4 kimi does not find the session (Session \"<id>\" not found.): failed/resume-lost" $? "st: $st"

    # --- 5. failure classes ---
    local m want_class
    for m in "auth auth" "quota quota" "rate-limit rate-limit" "model-missing model-not-selected" "context context" "max-steps timeout" "server server" \
        "occupied blocked" "ends-on-tool malformed" "no-hint malformed"; do
        set -- $m
        start AGENT_STUB_MODE="$1" -- --profile kimi-key --role implementer --write --prompt-file "$prompt"
        st="$(outcome "$ID")"
        [[ "$st" == "failed/$2" ]]
        verdict "5 mode $1 → failed/$2" $? "st: $st" "$(tail -3 "$JOBS/$ID.log")"
    done
    set --

    # --- 6. refusals at task time ---
    n="$(/bin/ls "$JOBS" | wc -l | tr -d ' ')"
    run_ad task --profile kimi-key --role implementer --write --background --prompt-file "$big"
    [[ "$RC" -eq 2 && "$ERR" == *"profile kimi-key: the prompt is 133120 bytes, above the 122880 bytes a kimi command line takes on linux"* || "$(uname)" != Linux ]]
    verdict "6 a prompt too long for kimi's command line (it reads the prompt only from -p) is refused at task time (Linux: one argument ≤ 120 KiB)" $? "rc=$RC err: $ERR"
    run_ad task --profile kimi-key-user --role implementer --write --background --prompt-file "$prompt"
    [[ "$RC" -eq 2 && "$ERR" == *'a keyed kimi profile runs only in its isolated home'* ]]
    verdict "6 a keyed profile with \"home\": \"user\" is refused (the key needs the config.toml agent-dispatch writes)" $? "rc=$RC err: $ERR"
    run_ad task --profile kimi-clash --role implementer --write --background --prompt-file "$prompt"
    [[ "$RC" -eq 2 && "$ERR" == *"env KIMI_MODEL_NAME"*"conflicts with a mandatory setting"* ]]
    verdict "6 profile env touching a removed variable (KIMI_MODEL_NAME) is refused" $? "rc=$RC err: $ERR"
    [[ "$(/bin/ls "$JOBS" | wc -l | tr -d ' ')" == "$n" ]]
    verdict "6 the refusals leave no job behind" $?
    start AGENT_STUB_RECORD="$TEST_ROOT/rec/telemetry.json" -- --profile kimi-telemetry --role implementer --write --prompt-file "$prompt"
    st="$(outcome "$ID")"
    [[ "$st" == completed/ && "$(jfield env.KIMI_DISABLE_TELEMETRY <"$TEST_ROOT/rec/telemetry.json")" == 0 ]]
    verdict "6 a default (KIMI_DISABLE_TELEMETRY) can be overridden through profile env" $? "st: $st"

    # --- 7. login profiles ---
    start AGENT_STUB_RECORD="$TEST_ROOT/rec/login.json" -- --profile kimi-login --role implementer --write --prompt-file "$prompt"
    st="$(outcome "$ID")"
    rec="$TEST_ROOT/rec/login.json"
    [[ "$st" == completed/ && "$(jfield env.KIMI_CODE_HOME <"$rec")" == "$TEST_ROOT/user-kimi" && -z "$(jfield env.AGENT_DISPATCH_KIMI_API_KEY <"$rec")" && "$(jfield argv <"$rec")" == *'"-m","kimi-code/k3"'* ]] \
        && [[ ! -e "$TEST_ROOT/user-kimi/config.toml" ]]
    verdict "7 login, home user: the caller's KIMI_CODE_HOME, no key variable, nothing written into that home" $? "st: $st home: $(jfield env.KIMI_CODE_HOME <"$rec")"
    run_ad doctor --profile kimi-login
    [[ "$OUT" == *"FAIL kimi-auth kimi-login: no Kimi Code login in $TEST_ROOT/user-kimi; the user logs in: kimi login"* ]]
    verdict "7 doctor: no credentials/kimi-code.json in the home → FAIL kimi-auth with the login step" $? "$OUT"
    mkdir -p "$TEST_ROOT/user-kimi/credentials" && printf '{}' >"$TEST_ROOT/user-kimi/credentials/kimi-code.json"
    run_ad doctor --profile kimi-login
    [[ "$OUT" == *"ok kimi-auth kimi-login: a Kimi Code login is stored in $TEST_ROOT/user-kimi"* && "$OUT" == *"ok harness kimi-login"*"2.4.1"* ]]
    verdict "7 doctor with a login: ok kimi-auth; harness version 2.4.1 and the required flags found" $? "$OUT"
    run_ad profile env kimi-login-iso
    [[ "$RC" -eq 0 && "$OUT" == *"export KIMI_CODE_HOME='$STATE/homes/kimi-login-iso/kimi'"* ]]
    verdict "7 profile env of an isolated login profile exports its KIMI_CODE_HOME (for kimi login there)" $? "rc=$RC out: $OUT err: $ERR"

    # --- 8. doctor of a keyed profile ---
    run_ad doctor --profile kimi-key
    [[ "$OUT" == *"ok kimi-auth kimi-key: the key goes in through AGENT_DISPATCH_KIMI_API_KEY"* && "$OUT" != *"$KKEY"* ]]
    verdict "8 doctor --profile <keyed>: the key path named, the key not printed" $? "$OUT"
    run_env AGENT_STUB_HELP_DROP=--agent-file -- doctor --profile kimi-drop
    [[ "$OUT" == *"FAIL harness kimi-drop"*"--agent-file"* ]]
    verdict "8 a kimi whose --help lacks a required flag (--agent-file) fails the harness check" $? "$OUT"

    # --- 9. cancel ---
    : >"$TEST_ROOT/signals.txt"
    start AGENT_STUB_MODE=kimi-sigterm AGENT_STUB_SIGNALS="$TEST_ROOT/signals.txt" AGENT_STUB_RECORD="$TEST_ROOT/rec/cancel.json" -- --profile kimi-key --role implementer --write --prompt-file "$prompt"
    id1="$ID"
    wait_file "$TEST_ROOT/rec/cancel.json"
    run_ad cancel "$id1"
    st="$(outcome "$id1")"
    [[ "$st" == cancelled/ && "$(cat "$TEST_ROOT/signals.txt")" == "SIGTERM "* ]]
    verdict "9 cancel: SIGTERM, kimi exits 143 after its cleanup; the job is cancelled" $? "st: $st signals: $(cat "$TEST_ROOT/signals.txt")"

    # --- 10. pure functions ---
    got="$(kimi_js 'console.log(JSON.stringify([
  mod.promptTooLong({ bytes: 100 * 1024 }, "linux"), mod.promptTooLong({ bytes: 80000 }, "win32"), Boolean(mod.promptTooLong({ bytes: 100000 }, "win32")),
  Boolean(mod.promptTooLong({ text: "ж".repeat(29000) }, "win32")) === false, Boolean(mod.promptTooLong({ text: "\"".repeat(16000) }, "win32")),
  mod.stderrError("\u001b[31merror: failed to run prompt: provider.rate_limit: 429\u001b[0m\nSee log: /x")]));')"
    [[ "$got" == '[null,null,true,true,true,"provider.rate_limit: 429"]' ]]
    verdict "10 promptTooLong: bytes at task time refuse only what cannot fit (Windows: ≥ 3 bytes per unit); the exact text counts UTF-16 units and escaped quotes; stderrError strips colour codes" $? "got: $got"

    # --- leak check ---
    local left="" i=0
    while ((i < 50)); do
        left="$(pgrep -f "$TEST_ROOT" | tr '\n' ' ')"
        [[ -z "$left" ]] && break
        sleep 0.2
        i=$((i + 1))
    done
    [[ -z "$left" ]]
    verdict "no process of this run outlives the suite" $? "left: $left"

    echo ""
    echo "PASS count: $PASSES"
    if [[ "$FAILURES" -ne 0 ]]; then
        echo "FAILED: $FAILURES assertion(s)."
        exit 1
    fi
    echo "PASS"
}

main "$@"
