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

## AUTHORIZED_CHANGE_LEDGER

<paste ledger or write 'N/A — first round'>

## Authorization boundary

Review the plan against:
1. the user's original request;
2. explicit repo constraints supplied by the orchestrator;
3. the plan's own Acceptance criteria / Non-goals;
4. for follow-up rounds, AUTHORIZED_CHANGE_LEDGER.

Do not expand scope. Do not require optional features, extra commands, extra diagnostics, new flags, broader test frameworks, or additional edge-case support unless they are necessary to satisfy the current acceptance criteria or prevent a concrete high-materiality failure.

## Finding classes

Use exactly one class per finding:

- `MUST_FIX_NOW` — blocks approval now. Requires one of:
  - stated requirement missing/contradicted;
  - guaranteed implementation/test failure;
  - material data-loss/security/regression risk;
  - public/API contract required by this plan is broken.

- `REGRESSION_FROM_AUTHORIZED_FIX` — introduced by an accepted fix in this loop.

- `DEFER` — useful hardening or design improvement outside current approval gate.

- `NIT` — wording/style/minor clarity.

- `REJECTED_BY_SCOPE` — outside stated scope or explicitly rejected.

## Output format (strict)

Line 1 must be exactly one of: `APPROVED` or `CHANGES_REQUESTED`.

If `CHANGES_REQUESTED`, after line 1 emit:

```
BLOCKING:
1. class: MUST_FIX_NOW — <issue> — <what to change>
2. class: REGRESSION_FROM_AUTHORIZED_FIX — <issue> — <what to change>
...

DEFER:
- <issue> — <what to change, non-blocking>
- ...

NIT:
- <issue> — <wording/style only>
- ...

REJECTED_BY_SCOPE:
- <issue> — <reason: outside stated scope or explicitly rejected>
- ...
```

Only `MUST_FIX_NOW` and `REGRESSION_FROM_AUTHORIZED_FIX` items are valid in BLOCKING. Findings classified as `DEFER`, `NIT`, or `REJECTED_BY_SCOPE` go into their own section below; do NOT promote them to BLOCKING. If nothing blocks but you have DEFER / NIT / REJECTED_BY_SCOPE items, return `APPROVED` on line 1 and still emit those sections (omit any section that is empty).

Each BLOCKING item starts with `class: <MUST_FIX_NOW | REGRESSION_FROM_AUTHORIZED_FIX>` so the orchestrator can map your findings into the AUTHORIZED_CHANGE_LEDGER mechanically.

Be ruthless on BLOCKING; be sparing — only include what truly blocks per the Finding classes definitions above.

Do not write code. Do not modify files. Read the plan and cited files only.
```

## Follow-up prompt (round 2+, with `--resume-last`)

```
AUTHORIZED_CHANGE_LEDGER (path): `<repo-root>/docs/plans/<slug>.ledger.json` — read this before re-reviewing. The ledger lists which prior findings the orchestrator accepted (with the authorized change), partially accepted, rejected by scope, deferred, or marked NIT.

The plan file at <repo-root>/docs/plans/<slug>.md has been revised. **Re-read it** — the edits happened since your last review.

## Follow-up review rule

Re-read the whole plan for coherence, but your blocker authority is narrower than in round 1. First, verify each ACCEPTED / PARTIALLY_ACCEPTED ledger item:

- fixed correctly;
- no direct regression introduced by the fix;
- no stale cross-reference directly caused by the fix.

For any NEW issue not tied to an open ledger item:

- classify it as `DEFER` unless it clears the high-materiality bar — guaranteed implementation/test failure, data-loss/security risk, regression of an existing public contract, or direct contradiction of a stated user requirement / failure of a phase acceptance criterion.
- For every new `MUST_FIX_NOW`, the BLOCKING line MUST include `new_blocker_materiality: <which high-materiality category and why>`. Without that field the orchestrator treats the item as `DEFER` and will not act on it.
- If all prior ledger blockers are fixed and you found only new non-critical issues, return `APPROVED` on line 1 and emit any `DEFER` / `NIT` items in their respective sections (below the empty BLOCKING block).

**Authorized delta first.** Inspect the authorized delta — the open ledger items plus the plan-file sections the fixer reported as edited — before scanning the wider plan. You may inspect surrounding context to validate that delta, but only escalate older, unrelated issues to `MUST_FIX_NOW` if they clear the high-materiality bar above. Latent issues outside the delta default to `DEFER`.

## What I did with your prior blocking list

[For each prior BLOCKING ledger item: "Fixed in section <X>" / "Rejected — reason: ..." / "Deferred — reason: ..."]

Same output format as round 1 (`APPROVED` or `CHANGES_REQUESTED` on line 1; `class:` on each BLOCKING item; sections for DEFER / NIT / REJECTED_BY_SCOPE). Do not repeat blocking items the orchestrator marked `rejected` with reasoning unless you have a genuinely new argument.
```
