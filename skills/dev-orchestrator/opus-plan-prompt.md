# Opus Subagent — Plan Writing / Revision

Use when the Sonnet orchestrator needs Opus judgment to write a new plan (Step 1) or revise an existing plan (Step 2 CHANGES_REQUESTED).

## Invocation

```
Agent tool:
  subagent_type: "general-purpose"
  model: "opus"
  description: "Plan: <short-slug>"   # or "Plan revision: <slug>"
  prompt: |
    <prompt below>
```

The subagent has NO session context. The prompt must be fully self-contained — include user's original request, repo path, any conventions or constraints you know, and the previous plan (if revising).

---

## Mode A: Write a new plan (Step 1)

```
You are writing an implementation plan for a multi-phase feature. This is dispatched by dev-orchestrator; the orchestrator (Sonnet main thread) will then send your plan to Codex xhigh for review.

## User's original request (verbatim)

<paste user message>

## Repository context

- Root: <absolute path>
- Language / frameworks: <e.g., Python/Django, TypeScript/React — fill what you know>
- Existing patterns to respect: <e.g., "existing module X for analogous behavior", "logger pattern", "test layout">
- Files / modules known to be relevant: <list if any>
- Constraints: <e.g., "cannot touch public API of module Y", "performance budget X ms", "no new external deps">

## Plan path

Default: `docs/plans/YYYY-MM-DD-<slug>.md` (today's date). If the repo uses a non-standard plan path (check `docs/architecture/plans/`, `docs/rfc/`, `.claude/plans/`, `plans/`), use that. Create the directory if missing.

## Required format

YAML frontmatter + markdown body:

```yaml
---
slug: <short-kebab-slug>
created: YYYY-MM-DD
status: in-progress          # in-progress | done | abandoned
phases:
  - id: Ф1
    scope: "<one-line>"
    status: in-progress       # pending | in-progress | done
  - id: Ф2
    scope: "..."
    status: pending
---
```

Body must have these H2 sections, in order:

1. `## Goal` — what this enables, why now. Two short paragraphs max.
2. `## Files` — paths to create/modify, grouped by phase. Each file: one-line responsibility.
3. `## Contracts` — function signatures, data shapes, API surface. Exact enough that Codex can implement without guessing.
4. `## Test strategy` — what proves correctness, per phase. Test types (unit/integration/e2e), key cases, what NOT to test.
5. `## Risks / unknowns / assumptions` — named explicitly. Anything you are guessing at.
6. `## Phases` — per phase an H2 `## Ф1: <title>`, `## Ф2: <title>`, ... with the detailed steps inside each.

## Phase decomposition rules

- Each phase must be independently commit-able and produce a working system (no "Ф1 breaks build, Ф2 fixes it").
- Each phase should be shippable in one Codex run (roughly a few files, a few hours of work).
- Prefer 2–5 phases. More than 5 is a signal to split into multiple plans.
- Put risky / blocking decisions as early as possible so later phases can assume they're settled.

## Discipline

- **YAGNI**: only what the user asked for. No speculative flags, extra abstractions, or "nice to have" features.
- **DRY**: don't invent new abstractions; reuse what exists.
- **TDD-friendly**: tests should be writable before or alongside implementation, not as an afterthought.
- **Single responsibility per file**: no god-files created.
- **In existing codebases**: follow established patterns. Don't unilaterally restructure unrelated code.

## Output

Write the plan to the file. After writing, return to the orchestrator:

1. Path to the plan file.
2. Brief summary (1 paragraph) of the plan's shape — number of phases, main risks, any decisions you made where the request was ambiguous.

That's it. Do NOT commit — the orchestrator handles git.
```

---

## Mode B: Revise a plan (Step 2 CHANGES_REQUESTED)

```
You are revising an implementation plan based on reviewer feedback. Do not rewrite from scratch — update the existing plan in place.

## Plan file to revise

`<absolute path>`

Read it in full (including frontmatter) before editing.

## Reviewer's BLOCKING list

<paste BLOCKING items from Codex xhigh — one per line, numbered>

## Reviewer's NITS (informational only — do NOT act on these in this round)

<paste NITS, if any>

## What I already decided in prior rounds

<if this is round 3+, paste prior "resolved-by-decision" items so you don't re-litigate>

## Your job

1. For each BLOCKING item: update the plan file in place (edit the relevant section). Each fix should be precise and minimal — don't restructure unrelated sections.
2. If a BLOCKING item is wrong or was already addressed, write a short rebuttal — do NOT silently ignore. Return it in the output so the orchestrator can tell Codex.
3. Preserve the existing frontmatter structure; update only what this revision actually changes.
4. Do NOT commit — the orchestrator handles git.

## Output

Return to the orchestrator:

1. Updated plan file path (same file).
2. Per BLOCKING item: `fixed in <section>` OR `rejected — <reason>`.
3. One-sentence summary of the revision shape (e.g., "restructured Ф2 contracts, added missing test for edge case X").
```
