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

**The prompt's literal first line MUST be `ultrathink`** — it runs Opus at max thinking effort. Both templates below already start with it; keep it first when filling them in.

---

## Mode A: Write a new plan (Step 1)

```
ultrathink

You are writing an implementation plan for a multi-phase feature. This is dispatched by dev-orchestrator; the orchestrator (Sonnet main thread) will then send your plan to Codex xhigh for review.

## User's original request (verbatim)

<paste user message>

## Repository context

- Root: <absolute path>
- Language / frameworks: <e.g., Python/Django, TypeScript/React — fill what you know>
- Existing patterns to respect: <e.g., "existing module X for analogous behavior", "logger pattern", "test layout">
- Files / modules known to be relevant: <list if any>
- Constraints: <e.g., "cannot touch public API of module Y", "performance budget X ms", "no new external deps">

If `docs/ARCHI.md` exists in the repo, read it FIRST — it is the maintained architecture memory (see the `architecture-memory` skill) and replaces most from-scratch exploration. Trust it for orientation, verify against source anything your plan depends on. If your plan will change something ARCHI.md describes (modules, contracts, data flow), add an explicit final step to the affected phase: "update docs/ARCHI.md section <X> accordingly".

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
    parallel_group: G1        # optional — see "Parallel groups" in decomposition rules
  - id: Ф3
    scope: "..."
    status: pending
    parallel_group: G1
---
```

Body must have these H2 sections, in order:

1. `## Goal` — what this enables, why now. Two short paragraphs max.
1a. `## Acceptance criteria` — 3–7 externally observable criteria that define "done" for the whole plan. Reviewers may block only on these criteria, stated user requirements, repo constraints, or high-materiality risks (`DATA_LOSS`, `SECURITY`, `GUARANTEED_FAIL`, `REGRESSION`, `ACCEPTANCE_CRITERIA`).
1b. `## Non-goals / deferred` — explicit exclusions. Reviewers MUST classify requests for these as `REJECTED_BY_SCOPE` or `DEFER` unless the orchestrator authorizes scope expansion.
2. `## Files` — paths to create/modify, grouped by phase. Each file: one-line responsibility.
3. `## Contracts` — function signatures, data shapes, API surface. Exact enough that Codex can implement without guessing.
4. `## Test strategy` — what proves correctness, per phase. Test types (unit/integration/e2e), key cases, what NOT to test.
5. `## Risks / unknowns / assumptions` — named explicitly. Anything you are guessing at.
6. `## Phases` — per phase an H2 `## Ф1: <title>`, `## Ф2: <title>`, ... with the detailed steps inside each.

For sections 1a and 1b, use this template body verbatim (replace bullets with the plan's actual content):

## Acceptance criteria

List 3–7 externally observable criteria that define "done" for the whole plan. Reviewers may block only on these criteria, stated user requirements, repo constraints, or high-materiality risks.

## Non-goals / deferred

List explicit exclusions. Reviewers MUST classify requests for these as `REJECTED_BY_SCOPE` or `DEFER` unless the orchestrator authorizes scope expansion.

## Phase decomposition rules

- Each phase must be independently commit-able and produce a working system (no "Ф1 breaks build, Ф2 fixes it").
- Each phase should be shippable in one implementer run (roughly a few files, a few hours of work).
- Prefer 2–5 phases. More than 5 is a signal to split into multiple plans.
- Put risky / blocking decisions as early as possible so later phases can assume they're settled.
- **Backend / frontend split (required for full-stack work)**: if a candidate phase would touch BOTH backend (.py, .rs, .go, .java, server-side .ts/.js, SQL, protobuf, etc.) AND frontend (.tsx, .jsx, .vue, .svelte, .css, .scss), split it into two phases — one BE, one FE — with an explicit contract between them (API endpoint shape, request/response schema, event names, data types). Reason: the orchestrator routes BE phases to Codex and FE phases to a Claude subagent; mixed phases cannot be dispatched cleanly.
- **Parallel groups (optional)**: mark exactly two phases with the same `parallel_group: G<n>` in the frontmatter `phases[]` ONLY when ALL of: (a) their file sets are fully disjoint; (b) neither depends on the other's *implementation* — only on contracts frozen in `## Contracts` (a BE+FE pair with an explicit contract is the canonical case); (c) each phase still commits independently. The orchestrator builds a marked group concurrently in separate git worktrees and merges afterwards — overlapping files or an implementation dependency guarantee a failed merge. When in doubt, do NOT mark: sequential is always correct.

## Discipline

- **YAGNI**: only what the user asked for. No speculative flags, extra abstractions, or "nice to have" features.
- **DRY**: don't invent new abstractions; reuse what exists.
- **TDD-friendly**: tests should be writable before or alongside implementation, not as an afterthought.
- **Single responsibility per file**: no god-files created.
- **In existing codebases**: follow established patterns. Don't unilaterally restructure unrelated code.
- **Acceptance-criteria gate**: the `## Acceptance criteria` section is the reviewer's sole authority for blocking on missing requirements; `## Non-goals / deferred` is the explicit defer-list. Together they bound the reviewer's mandate — any reviewer finding outside these sections must be classified `DEFER` or `REJECTED_BY_SCOPE`, never `MUST_FIX_NOW`, unless it clears the high-materiality bar.

## Output

Write the plan to the file. After writing, return to the orchestrator:

1. Path to the plan file.
2. Brief summary (1 paragraph) of the plan's shape — number of phases, main risks, any decisions you made where the request was ambiguous.

That's it. Do NOT commit — the orchestrator handles git.
```

---

## Mode B: Revise a plan (Step 2 CHANGES_REQUESTED)

The orchestrator dispatches Mode B after Codex xhigh returned `CHANGES_REQUESTED` and the orchestrator has triaged the findings into the AUTHORIZED_CHANGE_LEDGER (see `dev-orchestrator/SKILL.md` "## Authorized Change Ledger"). The ledger is the single authoritative input for this dispatch — work only on its open ACCEPTED / PARTIALLY_ACCEPTED items.

```
ultrathink

You are revising an implementation plan based on reviewer feedback. Do not rewrite from scratch — apply only the changes the orchestrator has authorized via the ledger below.

## Plan file to revise

`<absolute path>`

Read it in full (including frontmatter) before editing.

## AUTHORIZED_CHANGE_LEDGER

`<absolute path to docs/plans/<slug>.ledger.json>`

<paste open ledger items inline — orchestrator inlines ACCEPTED / PARTIALLY_ACCEPTED entries so you don't need to re-parse JSON>

The ledger is the authoritative scope for this revision. Items not appearing as ACCEPTED / PARTIALLY_ACCEPTED here are NOT authorized — do not act on them, even if you remember them from a prior round.

## Revision scope contract

Apply only open ACCEPTED / PARTIALLY_ACCEPTED ledger items.

For each edit, preserve a narrow causal chain:

  accepted blocker → required plan change → exact sections touched.

Do NOT:

- act on NITs;
- perform a general consistency pass;
- add new requirements, guards, flags, diagnostics, APIs, tests, dependencies, or edge-case handling unless they are necessary to fix an accepted blocker;
- rewrite unrelated sections for clarity;
- restructure phases/tasks unless the accepted blocker explicitly requires it.

If a ledger item appears wrong or already fixed:
return `rejected — <reason>` or `already_fixed — <section>` for that ledger id.

If fixing an accepted blocker requires broader scope than the ledger lists:
do NOT apply the broader change silently. Stop the revision and return
`NEEDS_AUTHORIZATION: <ledger id> requires <extra change> because <reason>`
so the orchestrator can extend the ledger before you continue.

Preserve the existing frontmatter structure; update only what this revision actually changes. Do NOT commit — the orchestrator handles git.

## Output

Return to the orchestrator:

1. Updated plan file path (same file).
2. Per ledger item, one line:
   `<id>: fixed | rejected | already_fixed | needs_authorization — <one-line note + sections_changed list>`
3. `no_nits_applied: true|false` (MUST be `true` unless the orchestrator explicitly authorized a NIT in the ledger).
4. `deferred_observations: [<unrelated issue you noticed but did NOT edit>, ...]` — empty list if none.
5. One-sentence summary of the revision shape (e.g., "fixed Ф2 contract gap; deferred two cosmetic observations").
```
