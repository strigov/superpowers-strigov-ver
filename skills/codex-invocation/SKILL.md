---
name: codex-invocation
description: How to invoke Codex CLI from Claude Code on this machine. Use when any workflow needs to dispatch a Codex task — companion.mjs + --background + Monitor polling. Contains the exact path, flags, polling loop, and stale-lock workaround. Read this before the first Codex call in a session, including from dev-orchestrator.
---

# Codex invocation (companion.mjs, background-only)

On this Mac in Claude Code terminal mode, the standard Codex invocation paths silently auto-reject. Use the companion CLI with background tasks and Monitor polling.

## Working path

### 1. One-time login (user action)

User runs in their shell prompt:

```
!codex login
```

The `!`-prefix in Claude Code makes it a user-shell command, not a tool call. Browser OAuth flow, then "Successfully logged in". Required once per machine.

### 2. Sanity-check the runtime

Before the first task in a session, verify the companion is alive:

```bash
node ~/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs task --help
```

If help text returns, the shared broker is reachable.

### 3. Submit task (ALWAYS `--background`)

```bash
node ~/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs task \
  --background \
  [--write] \
  [--effort <low|medium|high|xhigh>] \
  [--resume-last | --fresh] \
  "<prompt>"
```

Expected output: `Codex Task started in the background as task-XXXX`.

### 4. Poll with terminal-only filter (via Monitor)

```bash
COMPANION=~/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs
TASK=task-XXXX
until
  st=$(node "$COMPANION" status "$TASK" --json 2>/dev/null \
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

### 5. Fetch result

```bash
node ~/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs result task-XXXX
```

Relay Codex's report to the next step verbatim (or summarize into the next prompt, preserving verdict lines and blocking items exactly).

## Flag reference

- `--background` — return immediately with task id. **Mandatory.**
- `--write` — Codex may modify files. Omit for review-only runs (default is read-only).
- `--effort <low|medium|high|xhigh>` — reasoning effort. In dev-orchestrator: plan review = `xhigh`, implementation = `high`. Nothing lower.
- `--resume-last` — continue the previous Codex session in this repo. Use for follow-up rounds in review loops.
- `--fresh` — force new session. Use when stale-lock prevents resume (see below).
- `--model <name|spark>` — non-default model. Skip unless user explicitly asks.

Related commands: `status [job-id] [--all] [--json]`, `result [job-id] [--json]`, `cancel [job-id]`.

## Stale-lock gotcha

If a prior task was interrupted (Esc) or the broker restarted, the broker may hold in-memory state of `status=running` even after the OS process is gone. A subsequent `--resume-last` fails with:

```
Task task-XXXX is still running. Use /codex:status before continuing it.
```

Patching the on-disk JSON at `~/.claude/plugins/data/codex-openai-codex/state/<workspace-slug>/jobs/<task>.json` does **not** help — the broker holds state in memory via `broker.sock`, not on disk.

**Workaround**: submit a fresh task with `--fresh` instead of `--resume-last`. Codex re-reads project context; new jobs start fine. Proper fix would be restarting the shared broker, but no documented command for that yet.

## Never do

- `Agent(subagent_type="codex:codex-rescue", ...)` — silent auto-reject.
- `Bash("codex exec ...")` — silent auto-reject.
- Omit `--background` for non-trivial prompts — appears to hang, user Esc's, counts as interrupt.
- Print per-poll status from the Monitor loop — floods output, loop auto-stops.

## Session paths (for debugging)

- Plugin root: `~/.claude/plugins/cache/openai-codex/codex/1.0.3/`
- Companion entry: `<root>/scripts/codex-companion.mjs`
- Shared runtime socket: `/var/folders/.../T/cxc-<id>/broker.sock`
- Job log: `~/.claude/plugins/data/codex-openai-codex/state/<workspace-slug>/jobs/task-XXXX.log`

ECONNREFUSED on the socket = broker not yet started; resolves on the first real `task` invocation.
