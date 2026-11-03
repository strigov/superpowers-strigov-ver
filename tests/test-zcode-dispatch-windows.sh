#!/usr/bin/env bash
# Windows tests for bin/zcode-dispatch: the config lock by share modes, the CLI under the core's process helper
# (bin/lib/win/agent-proc.cs: a Job Object per run, start times, the boot id), cancel, timeout, a runner that dies,
# what a CLI leaves behind, the environment and the prompt limit of a Windows command line. tests/test-zcode-dispatch.sh
# covers the rest on macOS and Linux; it needs process groups, signals and file modes, which Windows does not have.
# Zero model calls: ZCODE_BIN points at tests/fixtures/zcode-stub.cjs, ZCODE_APP at a fake install, and all state lives
# under a temp root. Runs on Windows under Git Bash (the shell Claude Code uses there); elsewhere it skips.
set -euo pipefail

case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) ;;
    *)
        echo "test-zcode-dispatch-windows: skipped (not Windows)"
        exit 0
        ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ZD="$REPO_ROOT/bin/zcode-dispatch"
MJS="$(cygpath -m "$REPO_ROOT/bin/lib/zcode-dispatch.mjs")"
FIX="$SCRIPT_DIR/fixtures"

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
contains() { [[ "$1" == *"$2"* ]]; }

TEST_ROOT="$(cygpath -m "$(mktemp -d)")"
PIDS="$TEST_ROOT/stub.pids"
cleanup() {
    local pid
    if [[ -f "$PIDS" ]]; then
        while read -r pid; do [[ -n "$pid" ]] && node -e "try{process.kill($pid)}catch{}"; done <"$PIDS"
    fi
    for pid in ${HOLDERS:-}; do node -e "try{process.kill($pid)}catch{}"; done
    rm -rf "$TEST_ROOT"
}
trap cleanup EXIT
HOLDERS=""

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

alive() { node -e "try{process.kill($1,0);process.exit(0)}catch(e){process.exit(e.code==='EPERM'?0:1)}"; }
# all_gone <file> — every pid listed in the file has ended.
all_gone() {
    local pid
    [[ -s "$1" ]] || return 1
    while read -r pid; do
        [[ -z "$pid" ]] && continue
        if alive "$pid"; then return 1; fi
    done <"$1"
    return 0
}
# wait_for <seconds> <command...> — poll until the command succeeds.
wait_for() {
    local limit="$1" i=0
    shift
    while ((i < limit * 5)); do
        if "$@"; then return 0; fi
        sleep 0.2
        i=$((i + 1))
    done
    return 1
}
status_of() { "$ZD" status "$1" --json 2>/dev/null | jfield "job.$2" || true; }
status_is() { [[ "$(status_of "$1" status)" =~ ^($2)$ ]]; }
started_id() { sed -n 's/.* as \(zt-[0-9]*\)$/\1/p'; }
has_child() { [[ -n "$(status_of "$1" childPid)" ]]; }

# ---- the fake install, state and workspace ----
# No marketplace cache under this HOME, so the shim resolves the dev-tree .mjs.
export HOME="$TEST_ROOT/home"
mkdir -p "$HOME"
export ZCODE_APP="$TEST_ROOT/FakeZCode"
mkdir -p "$ZCODE_APP/resources/config/provider"
cp "$FIX/FakeZCode.app/Contents/Resources/config/provider/zcode-builtin.json" "$ZCODE_APP/resources/config/provider/"
FAKE_APP_VERSION="$(sed -n '/CFBundleShortVersionString/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$FIX/FakeZCode.app/Contents/Info.plist")"
node -e '
const fs = require("node:fs");
const [file, version] = process.argv.slice(1);
const data = Buffer.from(JSON.stringify({ name: "@zcode/desktop", version }));
const json = Buffer.from(JSON.stringify({ files: { "package.json": { size: data.length, offset: "0" } } }));
const padded = Math.ceil(json.length / 4) * 4;
const header = Buffer.alloc(8 + padded);
header.writeUInt32LE(4 + padded, 0);
header.writeUInt32LE(json.length, 4);
json.copy(header, 8);
const prefix = Buffer.alloc(8);
prefix.writeUInt32LE(4, 0);
prefix.writeUInt32LE(header.length, 4);
fs.writeFileSync(file, Buffer.concat([prefix, header, data]));' "$ZCODE_APP/resources/app.asar" "$FAKE_APP_VERSION"
export ZCODE_BIN="$(cygpath -m "$FIX/zcode-stub.cjs")"
export ZCODE_STATE_DIR="$TEST_ROOT/state"
# The core helper is compiled into this data root (agent-core.mjs winHelper).
export AGENT_DISPATCH_STATE_DIR="$TEST_ROOT/agents"
unset ZCODE_NODE ZCODE_TASK_TIMEOUT_MIN SP_IMPLEMENTER ZCODE_SESSION_DB ZCODE_TEST_BOOT_ID
export ZCODE_ENV_PASSTHROUGH="ZCODE_STUB_MODE,ZCODE_STUB_RECORD,ZCODE_STUB_DELAY_MS,ZCODE_STUB_PIDFILE,ZCODE_STUB_GO,ZCODE_STUB_DONE"
export ZCODE_STUB_PIDFILE="$PIDS"
LOCKFILE="$ZCODE_STATE_DIR/personal-provider-config.json.lock"

git init -q -b main "$TEST_ROOT/repo"
REPO="$TEST_ROOT/repo"
printf 'x\n' >"$REPO/a.txt"
(cd "$REPO" && git add a.txt && git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -qm c0)
PROMPT="$TEST_ROOT/prompt.md"
printf 'Implement the thing.\n' >"$PROMPT"
cd "$REPO"

echo "=== Test: zcode-dispatch on Windows ==="

# --- 1. doctor and the platform ---
printf '%s\n' "setup-fake-key-0123456789" | "$ZD" api-key set >/dev/null
out="$("$ZD" doctor 2>&1 || true)"
check "doctor: platform ok on win32 with the process helper" contains "$out" "ok platform: win32 (config lock: exclusive file handles"
check "doctor: the fake app is found under resources/" contains "$out" "ok app: $ZCODE_APP $FAKE_APP_VERSION"
check "doctor: ok overall" contains "$out" "doctor: ok"
out="$(env -u ZCODE_APP -u ZCODE_BIN "$ZD" doctor 2>&1 || true)"
check "without ZCODE_APP the app is looked for in %LOCALAPPDATA%\\Programs\\ZCode" contains "$out" "$(cygpath -w "$LOCALAPPDATA")\\Programs\\ZCode"

# --- 2. a task: helper, start time, session, the CLI's environment ---
REC="$TEST_ROOT/record.json"
id="$(ZCODE_STUB_MODE=record ZCODE_STUB_RECORD="$REC" "$ZD" task --background --prompt-file "$PROMPT" | started_id)"
check "task started ($id)" prefix "$id" "zt-"
wait_for 60 status_is "$id" "completed|failed" || true
check "task completed" eq "$(status_of "$id" status)" "completed"
check "the record names the helper's start time (ft:)" prefix "$(status_of "$id" childStartedAt)" "ft:"
check "the record has a win: boot id" prefix "$(status_of "$id" bootId)" "win:"
check "the session id came back" prefix "$(status_of "$id" sessionId)" "sess_stub_"
env_ok() {
    REC="$REC" node -e '
const r = JSON.parse(require("node:fs").readFileSync(process.env.REC, "utf8"));
const names = Object.keys(r.envAll).map((n) => n.toUpperCase());
const ok = names.includes("PATH") && names.includes("SYSTEMROOT") && names.includes("USERPROFILE") && names.includes("TEMP")
  && !names.includes("ZCODE_SESSION_DB") && !names.includes("ANTHROPIC_API_KEY")
  && r.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE && r.env.ZCODE_DATA_BASE_DIR;
process.exit(ok ? 0 : 1);'
}
check "the CLI gets PATH (from Path), the Windows basics and the cli-home, nothing denied" env_ok

# --- 3. the prompt reaches the CLI byte for byte through the helper's quoting ---
TRICKY="$TEST_ROOT/tricky.md"
printf 'Кавычки "x" и \\"y\\", слэши C:\\dir\\ и конец\\\n%%PATH%% ^& | < > $HOME `tick`\n\ttab  двойной  пробел "\n' >"$TRICKY"
id="$(ZCODE_STUB_MODE=record ZCODE_STUB_RECORD="$REC" "$ZD" task --background --resume-task "$id" --prompt-file "$TRICKY" | started_id)"
wait_for 60 status_is "$id" "completed|failed" || true
prompt_ok() {
    REC="$REC" FILE="$TRICKY" node -e '
const fs = require("node:fs");
const r = JSON.parse(fs.readFileSync(process.env.REC, "utf8"));
const p = r.argv[r.argv.indexOf("-p") + 1];
process.exit(p === fs.readFileSync(process.env.FILE, "utf8") && r.argv.includes("--resume") ? 0 : 1);'
}
check "quotes, backslashes, Cyrillic, %VAR% and newlines arrive intact; the resume passes --resume" prompt_ok

# --- 4. the prompt limit of a Windows command line ---
BIG="$TEST_ROOT/big.md"
node -e 'require("node:fs").writeFileSync(process.argv[1], "a".repeat(29990) + "\"\"\"\"\"\"\"\"\"\"\"")' "$BIG"
rc=0
out="$("$ZD" task --background --fresh --prompt-file "$BIG" 2>&1)" || rc=$?
check "a prompt above 30000 UTF-16 units (quotes counted twice) is refused with exit 2" eq "$rc:$(contains "$out" "a Windows command line takes" && echo y)" "2:y"
node -e 'require("node:fs").writeFileSync(process.argv[1], "я".repeat(29000))' "$BIG"
id="$("$ZD" task --background --fresh --prompt-file "$BIG" | started_id)"
wait_for 60 status_is "$id" "completed|failed" || true
check "29000 Cyrillic characters (58000 bytes) still fit" eq "$(status_of "$id" status)" "completed"

# --- 5. the config lock: a run holds it shared, api-key set needs it exclusive ---
: >"$PIDS"
id="$(ZCODE_STUB_MODE=hang "$ZD" task --background --fresh --prompt-file "$PROMPT" | started_id)"
wait_for 30 has_child "$id" || true
wait_for 30 test -s "$PIDS" || true
rc=0
out="$(printf '%s\n' "another-fake-key-0123456789" | "$ZD" api-key set 2>&1)" || rc=$?
check "api-key set is refused while a run holds the lock" eq "$rc:$(contains "$out" "still holds" && echo y)" "2:y"
helper="$(status_of "$id" childPid)"
out="$("$ZD" cancel "$id")"
check "cancel reports cancelled" eq "$out" "cancelled $id"
check "cancel: the helper has ended" wait_for 10 eval '! alive '"$helper"
check "cancel: the CLI it contained has ended" wait_for 10 all_gone "$PIDS"
check "the record stays cancelled" eq "$(status_of "$id" status)" "cancelled"
check "api-key set works once the run is gone" wait_for 15 eval 'printf "%s\n" another-fake-key-0123456789 | "$ZD" api-key set >/dev/null 2>&1'
# A holder that is not ours (another process with the lock file open exclusively) keeps a run from starting.
node -e '
const fs = require("node:fs");
fs.openSync(process.argv[1], fs.constants.O_RDWR | fs.constants.O_CREAT | 0x10000000);
console.log(process.pid);
setInterval(() => {}, 1000);' "$LOCKFILE" >"$TEST_ROOT/holder.pid" &
wait_for 10 test -s "$TEST_ROOT/holder.pid" || true
HOLDERS="$(cat "$TEST_ROOT/holder.pid")"
rc=0
out="$(printf '%s\n' "third-fake-key-0123456789" | "$ZD" api-key set 2>&1)" || rc=$?
check "an exclusive holder makes api-key set wait and give up" eq "$rc" "2"
node -e "process.kill($HOLDERS)"
HOLDERS=""
check "the lock is free again once that holder ended" wait_for 15 eval 'printf "%s\n" another-fake-key-0123456789 | "$ZD" api-key set >/dev/null 2>&1'

# --- 6. timeout: the whole job is terminated ---
: >"$PIDS"
id="$(ZCODE_TASK_TIMEOUT_MIN=0.03 ZCODE_STUB_MODE=hang "$ZD" task --background --fresh --prompt-file "$PROMPT" | started_id)"
wait_for 60 status_is "$id" "failed" || true
check "a hung CLI fails with errorClass timeout" eq "$(status_of "$id" status)/$(status_of "$id" errorClass)" "failed/timeout"
check "timeout: the CLI has ended" wait_for 10 all_gone "$PIDS"

# --- 7. what the CLI leaves behind ends with it ---
: >"$PIDS"
id="$(ZCODE_STUB_MODE=linger ZCODE_STUB_GO="$TEST_ROOT/go" ZCODE_STUB_DONE="$TEST_ROOT/done" "$ZD" task --background --fresh --prompt-file "$PROMPT" | started_id)"
wait_for 60 status_is "$id" "completed|failed" || true
check "linger: the CLI completed" eq "$(status_of "$id" status)" "completed"
check "linger: its lingering descendant was terminated with the job" wait_for 10 all_gone "$PIDS"
# Were it still alive, the descendant would create the done file within 50 ms of the go file.
touch "$TEST_ROOT/go"
sleep 1
check "linger: the descendant never got to run on" test ! -e "$TEST_ROOT/done"

# --- 8. a runner that dies takes the CLI with it, and the lock is released ---
: >"$PIDS"
id="$(ZCODE_STUB_MODE=hang "$ZD" task --background --fresh --prompt-file "$PROMPT" | started_id)"
wait_for 30 has_child "$id" || true
wait_for 30 test -s "$PIDS" || true
runner="$(status_of "$id" runnerPid)"
taskkill //F //PID "$runner" >/dev/null 2>&1 || true
check "runner killed: the CLI ended with it (Job Object)" wait_for 15 all_gone "$PIDS"
check "runner killed: status marks the job failed/crash" wait_for 15 eval '[[ "$(status_of '"$id"' status)/$(status_of '"$id"' errorClass)" == failed/crash ]]'
check "runner killed: the config lock is free" wait_for 15 eval 'printf "%s\n" another-fake-key-0123456789 | "$ZD" api-key set >/dev/null 2>&1'
rc=0
"$ZD" release-stale >/dev/null 2>&1 || rc=$?
id="$(ZCODE_STUB_MODE=ok "$ZD" task --background --fresh --prompt-file "$PROMPT" 2>&1 | started_id || true)"
check "after release-stale a new task runs" eval '[[ -n "$id" ]] && wait_for 60 status_is "$id" completed'

# --- 9. a stored pid with another start time is never signalled ---
victim_pid=""
node -e 'console.log(process.pid); setInterval(() => {}, 1000)' >"$TEST_ROOT/victim.pid" &
wait_for 10 test -s "$TEST_ROOT/victim.pid" || true
victim_pid="$(cat "$TEST_ROOT/victim.pid")"
HOLDERS="$victim_pid"
JOBS_DIR="$(ls -d "$ZCODE_STATE_DIR"/state/*/jobs | head -1)"
printf '{"id":"zt-0999","status":"running","errorClass":null,"sessionId":null,"model":"GLM-5.3-Flash$max","startedAt":"%s","finishedAt":null,"runnerPid":%s,"childPid":%s,"childStartedAt":"ft:1","bootId":"%s","note":null}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$victim_pid" "$victim_pid" "$(status_of "$id" bootId)" >"$JOBS_DIR/zt-0999.json"
"$ZD" cancel zt-0999 >/dev/null 2>&1 || true
check "cancel leaves a live pid with another start time alone" alive "$victim_pid"
node -e "process.kill($victim_pid)"
HOLDERS=""

echo
echo "test-zcode-dispatch-windows: $PASSES passed, $FAILURES failed"
[[ "$FAILURES" -eq 0 ]]
