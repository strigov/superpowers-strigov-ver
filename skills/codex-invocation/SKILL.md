---
name: codex-invocation
description: How to invoke Codex CLI from Claude Code on this machine. Use when any workflow needs to dispatch a Codex task — codex-dispatch wrapper + --background + Monitor polling. Contains the exact wrapper, flags, polling loop, and stale-lock workaround. Read this before the first Codex call in a session, including from dev-orchestrator.
---

# Codex invocation (codex-dispatch wrapper, background-only)

The plugin vendors the Codex companion runtime under `vendor/codex-companion/` and exposes it through the `codex-dispatch` shell wrapper in `bin/`. **Do not** call the upstream OpenAI codex plugin — we do not depend on it being installed.

The wrapper handles three things on every call:
1. Resolves the bundled `codex-companion.mjs` from the marketplace cache or the local dev tree.
2. Pins `CLAUDE_PLUGIN_DATA` to `~/.claude/plugins/data/superpowers-strigov-ver-codex` so jobs/broker state stays isolated from any other codex install on the machine.
3. For `task`/`review`/`adversarial-review`, injects `--model gpt-5.5` (overridable via `CODEX_DEFAULT_MODEL` env or by passing an explicit `--model` flag). This blocks the backend from auto-downgrading to spark on small or low-effort tasks.

On this Mac in Claude Code terminal mode, the standard Codex invocation paths silently auto-reject. Use this wrapper with background tasks and Monitor polling.

## Working path

### 1. Resolve the wrapper once per session

```bash
DISPATCH="$(command -v codex-dispatch || true)"
[ -z "$DISPATCH" ] && DISPATCH="$(ls -1d ~/.claude/plugins/cache/strigov-cc-plugins/superpowers-strigov-ver/*/bin/codex-dispatch 2>/dev/null | sort -rV | head -1)"
[ -z "$DISPATCH" ] && DISPATCH="$(pwd)/bin/codex-dispatch"
echo "DISPATCH=$DISPATCH"
```

`command -v codex-dispatch` works when the marketplace install put `bin/` in `PATH`; the glob fallback covers a fresh session before `PATH` refreshes; the `$(pwd)/bin/...` fallback is for local dev runs from the repo root.

### 2. One-time login (user action)

User runs in their shell prompt:

```
!codex login
```

The `!`-prefix in Claude Code makes it a user-shell command, not a tool call. Browser OAuth flow, then "Successfully logged in". Required once per machine. This logs in the standalone `codex` CLI (`npm i -g @openai/codex`), which is the only external dependency of the wrapper.

### 3. Sanity-check the runtime

Before the first task in a session, verify the wrapper and the companion are alive:

```bash
"$DISPATCH" status --json
```

A JSON snapshot (workspaceRoot, sessionRuntime, running, recent) means the wrapper resolved the companion and the broker is reachable.

### 4. Submit task (ALWAYS `--background`)

```bash
"$DISPATCH" task \
  --background \
  [--write] \
  [--effort <low|medium|high|xhigh>] \
  [--resume-last | --fresh] \
  "<prompt>"
```

Expected output: `Codex Task started in the background as task-XXXX`.

**Multi-line prompts go through a file, not inline.** Anything longer than one sentence: write the prompt to a scratch file with the `Write` tool first and pass it via the native `--prompt-file` flag — inline quoting of multi-line text with backticks / `$` / quotes breaks silently:

```bash
"$DISPATCH" task --background --effort xhigh --prompt-file /path/to/scratch/codex-prompt.md
```

**Flag sanity before submitting** (re-check every dispatch):
- `--background` — always;
- `--write` — ONLY when the task must modify files (implementation); never on reviews;
- effort per role: plan / spec / control review = `xhigh`, implementation = `high`;
- `--resume-last` — only for follow-up rounds within the same loop AND only when no other Codex task ran in between (see "Resume semantics" below); never in the dev-orchestrator Step 4 loop; first round of a new loop goes without it.

### 5. Poll with terminal-only filter (via Monitor)

```bash
TASK=task-XXXX
until
  st=$("$DISPATCH" status "$TASK" --json 2>/dev/null \
       | python3 -c "import json,sys; print(json.load(sys.stdin)['job']['status'])")
  case "$st" in
    completed|failed|cancelled) echo "codex task terminal: $st"; true ;;
    *) false ;;
  esac
do
  sleep 25
done
```

Run this via the Monitor tool. **The `case` guard is non-negotiable** — a monitor that prints every poll ("elapsed=40s status=running") floods the chat and auto-stops.

### 6. Fetch result

```bash
"$DISPATCH" result task-XXXX
```

Relay Codex's report to the next step verbatim (or summarize into the next prompt, preserving verdict lines and blocking items exactly).

## Flag reference

- `--background` — return immediately with task id. **Mandatory.**
- `--write` — Codex may modify files. Omit for review-only runs (default is read-only).
- `--effort <low|medium|high|xhigh>` — reasoning effort. In dev-orchestrator: plan review = `xhigh`, implementation = `high`. Nothing lower.
- `--model <name>` — override the default model. The wrapper auto-pins `gpt-5.5` if you don't pass this; pass an explicit `--model` only to override. Override the wrapper default globally with `CODEX_DEFAULT_MODEL=...` in the env.
- `--resume-last` — continue the previous Codex session in this repo. Use for follow-up rounds in review loops — but ONLY when it is safe, see "Resume semantics" below.
- `--fresh` — force new session. Use when stale-lock prevents resume (see below).

Related commands: `status [job-id] [--all] [--json]`, `result [job-id] [--json]`, `cancel [job-id]`.

## Resume semantics (`--resume-last`) — read before using it

`--resume-last` resumes the NEWEST completed task thread in this repo for the current session — **regardless of what role that task played** (reviewer, implementer, …). It is NOT "resume my previous task of the same kind". There is no per-task-id resume.

Therefore it is safe ONLY when no other Codex task ran since the thread you intend to continue:

- **Plan / spec review loops** (Codex review → Opus revision → Codex re-review): SAFE — the revision between rounds is a Claude subagent, not a Codex task.
- **Implementer `NEEDS_CONTEXT` / effort-upgrade re-dispatch**: SAFE — no intervening Codex task.
- **dev-orchestrator Step 4 fused-review loop**: NOT SAFE — Codex high (fixer) and Codex xhigh (control reviewer) alternate, so `--resume-last` would resume the OTHER role's thread (e.g. the fixer would continue a conversation that was instructed "read-only, do not modify code"). All Step 4 round-2+ dispatches must be FRESH tasks with fully self-contained prompts.

When in doubt, dispatch fresh with a full prompt: a fresh task merely costs Codex a context re-read; a wrong resume poisons the thread with another role's instructions.

## Parallel tasks and worktrees

Each `--background` task is its own detached OS process — there is no serial queue, so several Codex tasks CAN run at once. The rules:

- **Read-only tasks** (reviews, no `--write`): safe to run in parallel in the same working tree.
- **Write tasks**: NEVER two in the same working tree — they stomp each other's files and their diffs become inseparable. Each parallel write task gets its own git worktree.
- **Dispatching into a worktree**: pass `--cwd <worktree-path>` (no `cd` needed):

  ```bash
  "$DISPATCH" task --background --write --effort high --cwd <worktree-path> --prompt-file <scratch>/prompt.md
  ```

  The companion resolves the workspace from `--cwd` (`git rev-parse --show-toplevel`), so each worktree gets its OWN state directory, broker, job list, and thread history — fully isolated tracks.
- **`status` / `result` / `cancel` for a worktree task must pass the same `--cwd <worktree-path>`** — without it the wrapper looks in the main repo's workspace and won't find the job.
- **Resume isolation**: thread history is per-worktree, so parallel tracks never collide on `--resume-last`; the within-track rules from "Resume semantics" still apply unchanged.
- **Width cap: max 2 concurrent write tasks.** Subscription rate limits and orchestrator attention both degrade beyond that. Do not launch other Codex tasks while 2 write tasks are live.

## Terminal status handling

After the Monitor loop reports a terminal status:

- `completed` → fetch with `result`; machine-read the FIRST line for the verdict / status token.
- `failed` → read the tail of the job log (`~/.claude/plugins/data/superpowers-strigov-ver-codex/state/<workspace-slug>/jobs/task-XXXX.log`). Retry ONCE with `--fresh` and the same full prompt. A second `failed` → stop and escalate to the user with the log tail.
- `cancelled` → someone interrupted the task. Do NOT silently re-dispatch — report to the user and wait for instruction.

## Stale-lock gotcha

If a prior task was interrupted (Esc) or the broker restarted, the broker may hold in-memory state of `status=running` even after the OS process is gone. A subsequent `--resume-last` fails with:

```
Task task-XXXX is still running. Use /codex:status before continuing it.
```

Patching the on-disk JSON at `~/.claude/plugins/data/superpowers-strigov-ver-codex/state/<workspace-slug>/jobs/<task>.json` does **not** help — the broker holds state in memory via `broker.sock`, not on disk.

**Workaround**: submit a fresh task with `--fresh` instead of `--resume-last`. Codex re-reads project context; new jobs start fine.

**When you fall back to `--fresh` inside a review loop**, the new thread has NO memory of prior rounds. Do NOT send the short follow-up prompt — send the full first-round prompt PLUS a digest of prior rounds (ledger path, open ACCEPTED items, what was already fixed/rejected).

Note: orphan broker processes from prior crashed Claude Code sessions are now cleaned up automatically - the broker self-terminates within ~6 s of its parent dying (heartbeat in `app-server-broker.mjs`), and `ensureBrokerSession` reaps any leftover orphans (including legacy state files without `parentPid`) on startup. The `--fresh` workaround above addresses a different symptom: stale in-memory job state inside a still-alive broker after an interrupted task.

## Never do

- `Agent(subagent_type="codex:codex-rescue", ...)` — that subagent belongs to OpenAI's separately-installed codex plugin and silently auto-rejects in this terminal mode anyway. We do not require nor use it.
- `Bash("codex exec ...")` — silent auto-reject.
- Call the old hardcoded path `~/.claude/plugins/cache/openai-codex/codex/.../codex-companion.mjs` — we no longer depend on that plugin being installed.
- Omit `--background` for non-trivial prompts — appears to hang, user Esc's, counts as interrupt.
- Print per-poll status from the Monitor loop — floods output, loop auto-stops.

## Session paths (for debugging)

- Wrapper: `<plugin-root>/bin/codex-dispatch`
- Vendored companion: `<plugin-root>/vendor/codex-companion/scripts/codex-companion.mjs`
- Vendored companion version: `<plugin-root>/vendor/codex-companion/VERSION` and `.claude-plugin/plugin.json`
- State + jobs + broker.sock: `~/.claude/plugins/data/superpowers-strigov-ver-codex/state/<workspace-slug>/`
- Job log: `~/.claude/plugins/data/superpowers-strigov-ver-codex/state/<workspace-slug>/jobs/task-XXXX.log`

ECONNREFUSED on the socket = broker not yet started; resolves on the first real `task` invocation.
