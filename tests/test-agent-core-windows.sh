#!/usr/bin/env bash
# Windows tests for bin/lib/agent-core.mjs: the process helper (bin/lib/win/agent-proc.cs) and everything that runs on
# it — start times, the process table, the boot id, boundedExec, and the job lifecycle (task, status, result, cancel,
# timeout, a runner that dies, cleanup of what a harness leaves behind). tests/test-agent-core.sh covers the rest of
# the core on macOS and Linux; it needs process groups and signals, which Windows does not have. Zero model calls: the
# core is driven through tests/fixtures/core-harness.mjs with the test adapter tests/fixtures/adapters/plain.mjs, whose
# harness tests/fixtures/agent-stub.cjs runs under the profile's wrap ["node.exe"]. All state lives under a temp root.
# Runs on Windows under Git Bash (the shell Claude Code uses there); elsewhere it skips.
set -euo pipefail

case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) ;;
    *)
        echo "test-agent-core-windows: skipped (not Windows)"
        exit 0
        ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_URL="file:///$(cygpath -m "$REPO_ROOT/bin/lib/agent-core.mjs")"
HARNESS="$(cygpath -m "$SCRIPT_DIR/fixtures/core-harness.mjs")"
STUB="$(cygpath -m "$SCRIPT_DIR/fixtures/agent-stub.cjs")"
NODE_EXE="$(node -p process.execPath)"

FAILURES=0
PASSES=0
pass() {
    echo "  [PASS] $1"
    PASSES=$((PASSES + 1))
}
fail() {
    echo "  [FAIL] $1"
    FAILURES=$((FAILURES + 1))
}
check() {
    local label="$1"
    shift
    if "$@"; then pass "$label"; else fail "$label"; fi
}
eq() { [[ "$1" == "$2" ]]; }
prefix() { [[ "$1" == "$2"* ]]; }
matches() { [[ "$1" =~ $2 ]]; }

TEST_ROOT="$(cygpath -m "$(mktemp -d)")"
cleanup() {
    # Every process a test started records its pid in a pids file under the temp root; the helper's jobs take the
    # rest. Nothing else is touched.
    local file pid
    for file in "$TEST_ROOT"/*.pids; do
        [[ -f "$file" ]] || continue
        while read -r pid; do [[ -n "$pid" ]] && node -e "try{process.kill($pid)}catch{}"; done <"$file"
    done
    rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

export AGENT_DISPATCH_STATE_DIR="$TEST_ROOT/state"
export AGENT_ENV_PASSTHROUGH="AGENT_STUB_MODE AGENT_STUB_PIDS AGENT_STUB_RECORD AGENT_STUB_DELAY_MS AGENT_STUB_RESPONSE"
WS="$TEST_ROOT/ws"
mkdir -p "$WS"
git -C "$WS" init -q
git -C "$WS" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
printf 'Do the thing.\n' >"$TEST_ROOT/prompt.md"

ad() { node "$HARNESS" "$@"; }
# alive <pid>: whether the process exists.
alive() { node -e "try{process.kill($1,0)}catch(e){process.exit(e.code==='EPERM'?0:1)}"; }
none_alive() {
    local pid
    for pid in "$@"; do if alive "$pid"; then return 1; fi; done
    return 0
}
all_alive() {
    local pid
    for pid in "$@"; do if ! alive "$pid"; then return 1; fi; done
    return 0
}
# profile <extra JSON fields>: the plain profile running the stub under node.
profile() {
    node -e 'const [node, stub, extra] = process.argv.slice(1); process.stdout.write(JSON.stringify({ harness: "plain", wrap: [node], bin: stub, ...JSON.parse(extra || "{}") }))' "$NODE_EXE" "$STUB" "${1:-}"
}
# field <id> <expr>: a field of the job record (status --json), e.g. "job.status".
field() { ad status "$1" --cwd "$WS" --json | node -e "let t='';process.stdin.on('data',d=>t+=d).on('end',()=>{const job=JSON.parse(t).job;const v=($2);process.stdout.write(v==null?'':String(v))})"; }
# wait_terminal <id> [seconds]: until the job is no longer running.
wait_terminal() {
    local deadline=$((SECONDS + ${2:-30}))
    while ((SECONDS < deadline)); do
        [[ "$(field "$1" job.status)" != running ]] && return 0
        sleep 0.2
    done
    return 1
}
# wait_lines <file> <n> [seconds]
wait_lines() {
    local deadline=$((SECONDS + ${3:-15}))
    while ((SECONDS < deadline)); do
        [[ -f "$1" && "$(grep -c . "$1" || true)" -ge "$2" ]] && return 0
        sleep 0.1
    done
    return 1
}
start_task() {
    local out
    out="$(ad task --profile p --profile-json "$1" --background --cwd "$WS" --prompt-file "$TEST_ROOT/prompt.md" ${2:-})"
    echo "${out##* }"
}
core() { node --input-type=module -e "import * as core from '$CORE_URL'; $1"; }

echo "test-agent-core-windows: helper"
start="$(core 'process.stdout.write(String(core.ownStart()))')"
check "ownStart is a creation time (ft:<n>)" matches "$start" "^ft:[0-9]+$"
check "the helper is compiled into the data root's cache" core "if (!core.winHelper()?.startsWith(process.env.AGENT_DISPATCH_STATE_DIR.replace(/\//g, '\\\\'))) process.exit(1)"
check "processTable lists this process with its parent and start time" core "const row = core.processTable().find((r) => r.pid === process.pid); if (!row || row.ppid !== process.ppid || row.start !== core.ownStart()) process.exit(1)"
check "bootId reads" core "if (!/^win:/.test(core.bootId() ?? '')) process.exit(1)"
check "processStart of a live pid compares as ours" core "if (core.processIdentity(process.pid, core.ownStart()) !== 'ours') process.exit(1)"
check "a recorded start time that differs reads as foreign" core "if (core.processIdentity(process.pid, 'ft:1') !== 'foreign') process.exit(1)"

# Windows hands a freed pid out again soon: a stop signals a pid only while its start time is the one it expects.
check "terminateTree and killTreeSync spare a pid whose start time is not the expected one" core '
  const { spawn } = await import("node:child_process");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const wrong = new Map([[sleeper.pid, "ft:1"]]);
  const stopped = await core.terminateTree(sleeper.pid, [["SIGTERM", 200], ["SIGKILL", 0]], { starts: wrong });
  const killed = core.killTreeSync(sleeper.pid, "SIGKILL", { starts: wrong });
  const spared = core.isAlive(sleeper.pid) && stopped.sent.length === 0 && killed.length === 0;
  const right = await core.terminateTree(sleeper.pid, [["SIGTERM", 2000]], { starts: new Map([[sleeper.pid, core.processStart(sleeper.pid)]]) });
  if (!spared || core.isAlive(sleeper.pid) || right.survivors.length !== 0) { sleeper.kill(); process.exit(1); }'

echo "test-agent-core-windows: boundedExec"
check "argv reaches the command unchanged (spaces, quotes, backslashes, empty, unicode)" core '
  const args = ["plain", "two words", "", "a\"b", "c:\\dir\\", "tail\\\\\"q", "ёлка 🌲", "%PATH%", "x & y | z"];
  const r = core.boundedExec(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args]);
  if (r.error || JSON.stringify(JSON.parse(r.stdout)) !== JSON.stringify(args)) { console.error(r.stdout, r.error); process.exit(1); }'
check "exit code, stdout, stderr and stdin" core '
  const r = core.boundedExec(process.execPath, ["-e", "process.stdout.write(\"out:\" + require(\"fs\").readFileSync(0, \"utf8\")); console.error(\"err\"); process.exit(3)"], { input: "hi" });
  if (r.status !== 3 || r.stdout !== "out:hi" || r.stderr.trim() !== "err" || r.error) process.exit(1);'
check "a missing command is ENOENT" core 'const r = core.boundedExec("no-such-command-agent-test", []); if (r.error?.code !== "ENOENT") process.exit(1);'
PIDS="$TEST_ROOT/exec.pids"
check "the deadline ends the command and a detached grandchild" core "
  const r = core.boundedExec(process.execPath, ['-e', 'const fs = require(\"fs\"); fs.appendFileSync(process.argv[1], process.pid + \"\\\\n\"); require(\"child_process\").spawn(process.execPath, [\"-e\", \"require(\\\\\"fs\\\\\").appendFileSync(process.argv[1], process.pid + \\\\\"\\\\\\\\n\\\\\"); setInterval(() => {}, 1000)\", process.argv[1]], { detached: true, stdio: \"ignore\" }); setInterval(() => {}, 1000)', '$PIDS'], { timeoutMs: 1500 });
  if (r.error?.code !== 'ETIMEDOUT' || !r.timedOut) process.exit(1);"
sleep 0.3
check "  both processes recorded" wait_lines "$PIDS" 2 1
# shellcheck disable=SC2046
check "  and both gone" none_alive $(cat "$PIDS")
STOP="$TEST_ROOT/stop"
check "a stop file ends the command (ECANCELED)" core "
  const r = core.boundedExec(process.execPath, ['-e', 'setTimeout(() => require(\"fs\").writeFileSync(process.argv[1], \"\"), 500); setInterval(() => {}, 1000)', '$STOP'], { timeoutMs: 20000, stopFile: '$STOP' });
  if (r.error?.code !== 'ECANCELED' || !r.stopped) process.exit(1);"

echo "test-agent-core-windows: job lifecycle"
P_OK="$(profile)"
id="$(start_task "$P_OK")"
check "task starts a job ($id)" matches "$id" "^pt-[0-9]+$"
check "  the job completes" wait_terminal "$id"
check "  status completed" eq "$(field "$id" job.status)" completed
check "  result is the stub's answer" eq "$(ad result "$id" --cwd "$WS")" $'DONE\nstub finished'
check "  the cleanup is marked done" test -f "$AGENT_DISPATCH_STATE_DIR/state/$(ls "$AGENT_DISPATCH_STATE_DIR/state")/jobs/$id.json.cleaned"
check "  the child pid is a recorded process group with an ft: start" matches "$(field "$id" job.childStartedAt)" "^ft:[0-9]+$"
JOBS="$AGENT_DISPATCH_STATE_DIR/state/$(ls "$AGENT_DISPATCH_STATE_DIR/state")/jobs"

RECORD="$TEST_ROOT/env.json"
id="$(AGENT_STUB_RECORD="$RECORD" start_task "$P_OK")"
wait_terminal "$id" >/dev/null || true
check "the harness environment keeps SystemRoot and PATH" node -e "const e = require('$RECORD').env; const has = (n) => Object.keys(e).some((k) => k.toUpperCase() === n); if (!has('SYSTEMROOT') || !has('PATH')) process.exit(1)"
check "  and drops secret-like names" node -e "if (Object.keys(require('$RECORD').env).some((k) => /_TOKEN\$|^ANTHROPIC_/i.test(k))) process.exit(1)"

PIDS="$TEST_ROOT/leave.pids"
id="$(AGENT_STUB_MODE=leave-behind AGENT_STUB_PIDS="$PIDS" start_task "$P_OK")"
check "a harness that leaves processes behind still completes" wait_terminal "$id"
check "  status completed" eq "$(field "$id" job.status)" completed
check "  it had left two" wait_lines "$PIDS" 2 1
# shellcheck disable=SC2046
check "  both are gone" none_alive $(cat "$PIDS")
check "  the log names the cleanup" grep -q "cleanup: the harness exited and left" "$JOBS/$id.log"

PIDS="$TEST_ROOT/cancel.pids"
id="$(AGENT_STUB_MODE=detached-child AGENT_STUB_PIDS="$PIDS" start_task "$(profile '{}')" --write)"
check "a write job with detached descendants runs" wait_lines "$PIDS" 2
helper="$(field "$id" job.childPid)"
runner="$(field "$id" job.runnerPid)"
# shellcheck disable=SC2046
check "  its helper, runner and descendants are alive" all_alive "$helper" "$runner" $(cat "$PIDS")
out="$(ad cancel "$id" --cwd "$WS")"
check "cancel reports cancelled" prefix "$out" "cancelled $id"
check "  status cancelled" eq "$(field "$id" job.status)" cancelled
# shellcheck disable=SC2046
check "  the whole tree is gone (helper, descendants, runner)" none_alive "$helper" $(cat "$PIDS") "$runner"
check "  the cleanup is marked done" test -f "$JOBS/$id.json.cleaned"
id2="$(start_task "$P_OK" --write)"
check "  the write reservation was released (a new write task starts)" matches "$id2" "^pt-[0-9]+$"
wait_terminal "$id2" >/dev/null || true

PIDS="$TEST_ROOT/timeout.pids"
id="$(AGENT_STUB_MODE=detached-child AGENT_STUB_PIDS="$PIDS" start_task "$(profile '{"timeoutMin":0.05}')")"
check "a job past its timeout" wait_terminal "$id" 30
check "  is failed/timeout" eq "$(field "$id" job.status)/$(field "$id" job.errorClass)" failed/timeout
# shellcheck disable=SC2046
check "  and its descendants are gone" none_alive $(cat "$PIDS")

PIDS="$TEST_ROOT/runner.pids"
id="$(AGENT_STUB_MODE=detached-child AGENT_STUB_PIDS="$PIDS" start_task "$P_OK")"
wait_lines "$PIDS" 2 >/dev/null || true
helper="$(field "$id" job.childPid)"
runner="$(field "$id" job.runnerPid)"
node -e "process.kill($runner)"
sleep 1
# shellcheck disable=SC2046
check "a runner that dies takes its helper and descendants with it" none_alive "$runner" "$helper" $(cat "$PIDS")
check "  the reaper marks the job failed/crash (runner died)" eq "$(field "$id" job.status)/$(field "$id" job.errorClass)/$(field "$id" job.note)" "failed/crash/runner died"
check "  and its cleanup done" test -f "$JOBS/$id.json.cleaned"

# Without the wrap the stub (a .cjs file) is no executable: CreateProcess refuses it.
id="$(start_task "$(profile '{"wrap":[]}')")"
wait_terminal "$id" >/dev/null || true
check "a harness that is no executable fails the job as launch" eq "$(field "$id" job.status)/$(field "$id" job.errorClass)" failed/launch

out="$(ad probe --profile p --profile-json "$P_OK")"
check "probe completes in the foreground" eq "$out" "probe p: completed response=\"DONE\\nstub finished\""

echo
echo "test-agent-core-windows: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]]
