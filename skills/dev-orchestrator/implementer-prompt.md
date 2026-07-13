# Implementer Prompt (Codex high)

Use when dispatching implementation to Codex high.

## Invocation

```bash
"$DISPATCH" task \
  --background \
  --write \
  --effort high \
  [--cwd <worktree-path>] \
  --prompt-file <scratch>/implement-<phase-id>.md
```

`$DISPATCH` is the `codex-dispatch` wrapper — resolve it once per session per the `codex-invocation` skill. Write the filled prompt to a scratch file first and pass it via `--prompt-file` — do not inline multi-line text. For a parallel-track phase, add `--cwd <worktree-path>` so Codex works in that track's worktree (and use the same `--cwd` on `status`/`result`).

For follow-up rounds after the fused review (Step 4), resume the implementer's own thread: same flags plus `--resume-task <this phase's implementer task id>`, with the fix-round template below (it carries the authorized blockers; the thread already knows the plan and the phase). Thread-addressed resume is safe even though the control reviewer ran in between — see `codex-invocation` "Resume semantics". Never `--resume-last`. The same `--resume-task` id also serves `NEEDS_CONTEXT` / effort-upgrade re-dispatches in Step 3.

**Fresh fallback**: if the implementer thread is unavailable (phase implemented by a Claude subagent, task id lost, stale job record forcing `--fresh`), prepend the re-brief block from the template's "fresh fallback" note so the new session has full context.

Poll with Monitor using the terminal-only filter from `codex-invocation`. Fetch via `"$DISPATCH" result task-XXXX`.

## First-round prompt template

```
You are implementing one phase of an approved plan. Follow it exactly — do not expand scope beyond the named phase.

## Approved plan (authoritative — read it)

Path: `<repo-root>/docs/plans/<slug>.md`

Read the entire file including YAML frontmatter. Your task: implement phase **`<id>`** only (scope: `<one-line scope from frontmatter>`). Do not touch files or functionality belonging to other phases.

## Context

- Repository root: [path — may be a git worktree when this phase runs as a parallel track; treat it as the entire universe and never touch paths outside it]
- Style / patterns to follow: [e.g., "match existing module X", "use repository's existing logger"]
- If `docs/ARCHI.md` exists, read it before exploring the source — it is the maintained architecture memory. If the plan's steps for your phase include updating it, do so; otherwise do not touch it.
- Other phases already done (for context, do not modify): [list of done phase ids + their commits, if any]
- Parallel track note (include only when applicable): another phase is being implemented concurrently in a separate worktree. Its files are NOT in your scope; if your phase seems to need changes in them, stop and report `BLOCKED` — do not improvise the other phase's side.

## Before you begin

If any of these are unclear, STOP and report status `NEEDS_CONTEXT` with a specific question:
- Requirements or acceptance criteria
- Approach, dependencies, or assumptions
- Anything ambiguous in the plan

Do not guess.

## Your job

1. Implement exactly what the plan specifies — nothing more.
2. Write tests that verify behavior (not that mirror the implementation).
3. Run tests / typecheck / linters; confirm they pass.
4. Self-review (see below) and fix issues before reporting.

## Discipline

- **YAGNI**: build only what the plan asks for. No speculative abstractions, extra flags, or "nice to haves".
- **File responsibility**: follow the file layout from the plan. If a file grows beyond the plan's intent, stop and report `DONE_WITH_CONCERNS` — do not split files on your own.
- **Existing patterns**: match established conventions in the repo. Improve code you're touching, but do not restructure anything outside your task.
- **No unrelated commits**: do not modify files outside the plan's scope, even for "cleanups".
- **Git**: do NOT run `git commit`, `git push`, or any history-modifying git command — leave all changes uncommitted in the working tree. The orchestrator reviews the diff and handles git itself. (If the plan's last step says "Commit the phase", skip that step and note it in your report.)

## Self-review before reporting

- Completeness: every requirement implemented? edge cases?
- YAGNI: built anything not requested? remove it.
- Names: accurate (match what things do, not how)?
- Tests: prove behavior, or just mock-match the implementation?

Fix anything you find before reporting.

## Escalate when stuck

It is OK to stop and say "this is too hard." Bad work is worse than no work.

STOP and escalate (`BLOCKED`) when:
- The task needs architectural decisions with multiple valid approaches.
- You need codebase knowledge beyond what was provided and cannot derive clarity.
- You're reading file after file without progress.
- The plan itself appears wrong.

## Report format (strict)

Emit one report at the end. Line 1 is the bare status token — no preamble, no markdown formatting:

`DONE` | `DONE_WITH_CONCERNS` | `BLOCKED` | `NEEDS_CONTEXT`

Then:
- What you implemented (or attempted, if blocked)
- What you tested and results (commands + output summary)
- Files changed (paths)
- Self-review findings (if any)
- Concerns / questions / blockers (if status ≠ DONE)

Do NOT silently produce work you're unsure about — use `DONE_WITH_CONCERNS`.
```

## Fix-round prompt (round 2+ — `--resume-task <implementer-task-id>`)

```
You are in the fix round of a review loop, continuing the thread in which you implemented this phase. The fused review (Opus + Codex xhigh control) found blocking issues in your diff. Fix ONLY the AUTHORIZED_BLOCKERS below, re-test, re-report.

Re-inspect your current diff first — `git diff <base-sha>` — the tree may have moved since your last turn.

## Git

Do NOT run `git commit` / `git push` / history-modifying git commands. Leave all changes uncommitted — the orchestrator handles git.

## AUTHORIZED_BLOCKERS

<paste open ACCEPTED / PARTIALLY_ACCEPTED ledger items inline; orchestrator pulls these from `<repo-root>/docs/plans/<slug>.ledger.json` — see dev-orchestrator/SKILL.md "## Authorized Change Ledger">

Format per item:

1. `<ledger id>` — `<reviewer: opus-review | codex-control>` — `<file:line>` — `<authorized change>`
2. ...

Items not in this list are NOT authorized — do not act on them, even if you remember them from a prior round.

## Fix-round scope

You are in a review/fix loop. This is NOT a new implementation pass.

You may only change code/tests/docs necessary to fix the AUTHORIZED_BLOCKERS above.

Forbidden without explicit authorization:

- fixing NITs;
- opportunistic cleanup or refactors;
- broad consistency passes;
- adding new guards / flags / diagnostics / dependencies / tests not required by an authorized blocker;
- touching files outside the phase plan unless the blocker cannot be fixed otherwise.

If a blocker requires broader scope than the ledger lists, stop and return:
`NEEDS_AUTHORIZATION: <ledger id> requires <extra change> because <reason>`
so the orchestrator can extend the ledger before you continue.

## Required output

Line 1 is the bare status token — no preamble, no markdown formatting:

`DONE` | `DONE_WITH_CONCERNS` | `NEEDS_AUTHORIZATION` | `BLOCKED`

Then emit the structured fields:

- `blockers_fixed: [<ledger ids>]`
- `files_changed_by_blocker:`
  - `<ledger id>: [<file paths>]`
- `unauthorized_changes: []`   — MUST be empty; if not empty, each entry MUST explain why the change was unavoidable
- `nits_applied: false`        — MUST be `false` unless the orchestrator explicitly authorized a NIT in the ledger
- Concerns / questions / remaining ledger items not yet fixed (if status ≠ `DONE`)
- Test / typecheck / linter results (commands + pass/fail summary)

Re-run tests after fixes. Every change in the diff must trace back either to an entry in AUTHORIZED_BLOCKERS or to `unauthorized_changes` (with justification).
```

**Fresh fallback re-brief block** — when the fix round cannot resume the implementer thread (Claude-implemented phase, lost task id, stale job record), replace the opening paragraph above with:

```
You are in the fix round of a review loop. A previous run implemented one phase of an approved plan; the fused review (Opus + Codex xhigh control) found blocking issues. You are a fresh session with no memory of that run — re-read the context below, then fix ONLY the AUTHORIZED_BLOCKERS, re-test, re-report.

## Plan + phase (authoritative — read it)

Path: `<repo-root>/docs/plans/<slug>.md`. Your phase: **`<id>`** (scope: `<one-line scope from frontmatter>`). The phase's implementation is the un-committed diff in the working tree — inspect it via `git diff <base-sha>`.
```
