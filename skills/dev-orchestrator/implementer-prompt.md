# Implementer Prompt (Codex high)

Use when dispatching implementation to Codex high.

## Invocation

```bash
"$DISPATCH" task \
  --background \
  --write \
  --effort high \
  "<prompt below>"
```

`$DISPATCH` is the `codex-dispatch` wrapper — resolve it once per session per the `codex-invocation` skill.

For follow-up rounds after the fused review (Step 4), add `--resume-last` and pass the COMBINED BLOCKING list (from Opus review + Codex xhigh control review, merged by the orchestrator) — no full re-briefing.

Poll with Monitor using the terminal-only filter from `codex-invocation`. Fetch via `"$DISPATCH" result task-XXXX`.

## First-round prompt template

```
You are implementing one phase of an approved plan. Follow it exactly — do not expand scope beyond the named phase.

## Approved plan (authoritative — read it)

Path: `<repo-root>/docs/plans/<slug>.md`

Read the entire file including YAML frontmatter. Your task: implement phase **`<id>`** only (scope: `<one-line scope from frontmatter>`). Do not touch files or functionality belonging to other phases.

## Context

- Repository root: [path]
- Style / patterns to follow: [e.g., "match existing module X", "use repository's existing logger"]
- Other phases already done (for context, do not modify): [list of done phase ids + their commits, if any]

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

Emit one report at the end. First line is status:

`DONE` | `DONE_WITH_CONCERNS` | `BLOCKED` | `NEEDS_CONTEXT`

Then:
- What you implemented (or attempted, if blocked)
- What you tested and results (commands + output summary)
- Files changed (paths)
- Self-review findings (if any)
- Concerns / questions / blockers (if status ≠ DONE)

Do NOT silently produce work you're unsure about — use `DONE_WITH_CONCERNS`.
```

## Follow-up prompt (round 2+, with `--resume-last`)

```
Previous implementation had blocking issues from the fused review (Opus + Codex xhigh control). Fix them, re-test, re-report.

## Combined blocking list

1. <issue 1> — file:line — <reviewer: opus | codex-xhigh> — <what to change>
2. <issue 2>
...

## Rules

- Address every blocking item. If you disagree, explain in the report — do not silently ignore.
- Do NOT expand scope beyond fixing these items.
- Re-run tests after fixes; report results.
- Same report format as before.
```
