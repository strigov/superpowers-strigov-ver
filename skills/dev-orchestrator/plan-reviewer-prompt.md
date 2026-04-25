# Plan Reviewer Prompt (Codex xhigh)

Use when dispatching a plan review to Codex xhigh.

## Invocation

```bash
"$DISPATCH" task \
  --background \
  --effort xhigh \
  "<prompt below>"
```

`$DISPATCH` is the `codex-dispatch` wrapper — resolve it once per session per the `codex-invocation` skill.

No `--write`. Review is read-only.

For round 2+, add `--resume-last` and tell Codex the plan file was updated and must be re-read. Do NOT send the full plan text in any round — always point to the file.

Poll with Monitor using the terminal-only filter from the `codex-invocation` skill. Fetch result via `"$DISPATCH" result task-XXXX`.

## First-round prompt template

```
REVIEW MODE — read-only, do not modify code.

You are reviewing an implementation plan for correctness, completeness, and risk.

## Plan file (authoritative — read it)

Path: <repo-root>/docs/plans/<slug>.md

Read the entire file including YAML frontmatter. The `phases:` array defines the breakdown; review the plan as a cohesive whole, not phase-by-phase.

## Context

- Repository root: [path]
- Relevant files already in repo: [paths the plan touches or depends on]
- Constraints the plan must respect: [e.g., existing API contracts, style, dependencies, performance budget]

## Your job

Flag issues in these categories:

- **Missing pieces**: requirements the plan does not address.
- **Wrong approach**: steps that will not achieve the stated outcome, or will cause regressions.
- **Broken contracts**: signatures, data shapes, APIs the plan changes in ways that break existing callers.
- **Test gaps**: the plan's test strategy does not actually prove the change works.
- **Risk**: hidden dependencies, race conditions, data-migration hazards, security implications.
- **Over-engineering**: speculative abstractions, flags, or features not tied to the stated goal.

## Output format (strict)

Line 1 must be exactly one of: `APPROVED` or `CHANGES_REQUESTED`.

If `CHANGES_REQUESTED`, after line 1 emit:

```
BLOCKING:
1. <issue> — <what to change>
2. ...

NITS:
- <nit> — optional, non-blocking
- ...
```

BLOCKING items MUST change. NITS are stylistic or minor. If nothing blocks but you have nits, return `APPROVED` and still put nits in the NITS section.

Be ruthless on BLOCKING; be sparing — only include what truly blocks.

Do not write code. Do not modify files. Read the plan and cited files only.
```

## Follow-up prompt (round 2+, with `--resume-last`)

```
The plan file at <repo-root>/docs/plans/<slug>.md has been revised. **Re-read it** — the edits happened since your last review. Same review rules, same output format.

## What I did with your prior blocking list

[For each prior BLOCKING item: "Fixed in section <X>" / "Rejected — reason: ..."]

Review again. Do not repeat blocking items I explicitly rejected with reasoning unless you have a new argument.
```
