---
slug: review-loop-authorization
created: 2026-05-08
status: in-progress
phases:
  - id: Ф1
    scope: "Fix A (AUTHORIZED_CHANGE_LEDGER) + Fix B (materiality classes) + concretizing prompt edits in §5.1/§5.2"
    status: done
  - id: Ф2
    scope: "Fix C (delta-gated follow-up review) + Fix D (revision scope contract for fixers) + concretizing edits in §5.2 forbidden-list and §5.6 narrow-delta pattern"
    status: done
  - id: Ф3
    scope: "Fix E (new-blocker churn detector in SKILL.md Step 2/Step 4) + §5.3 implementer fix-round scope"
    status: done
  - id: Ф4
    scope: "Fix F (two-stage plan review) + §5.4 opus-review 4a authorization compliance + §5.5 codex-control authorization boundary"
    status: done
  - id: Ф5
    scope: "Fix G (acceptance-criteria + non-goals in plan formats) — opus-plan-prompt and writing-plans/SKILL.md"
    status: done
  - id: Ф6
    scope: "Schema extension — review-output.schema.json gains optional authorization fields; document vendor-sync risk"
    status: pending
  - id: Ф7
    scope: "Regression-fixture replay acceptance gate — manual replay of two reference logs against revised prompts"
    status: pending
---

# Review-Loop Authorization Boundary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: this plan is intended for direct (writing-plans + manual implementation) execution by a Sonnet/Opus orchestrator. dev-orchestrator is NOT used for implementation because the edits target dev-orchestrator's own prompt files. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the runaway CHANGES_REQUESTED → fix → review loop documented in `docs/changes.md` by introducing an authorization-boundary mechanism (ledger + materiality classes + delta-gated follow-ups + scope contracts for fixers and reviewers) into the dev-orchestrator and writing-plans skills.

**Architecture:** The plan models every CHANGES_REQUESTED verdict as a transition that produces an `AUTHORIZED_CHANGE_LEDGER` — a small JSON file at `docs/plans/<slug>.ledger.json` that the Sonnet orchestrator constructs after triaging reviewer findings. Reviewers and fixers receive that ledger as input on every subsequent round; reviewers must classify each finding under one of the materiality classes (`MUST_FIX_NOW`, `REGRESSION_FROM_AUTHORIZED_FIX`, `DEFER`, `NIT`, `REJECTED_BY_SCOPE`) and tie new blockers either to a ledger item or to a high-materiality escape (data loss, security, guaranteed failure, public-contract break, acceptance-criterion failure). Fixers operate under a "revision scope contract" that forbids opportunistic edits, and `SKILL.md` adds a churn-detector escalation when reviewers return only-new MUST_FIX_NOW items after all prior blockers were closed.

**Components touched:**
- `skills/dev-orchestrator/` — `SKILL.md` + 5 prompt templates (`plan-reviewer-prompt.md`, `opus-plan-prompt.md`, `implementer-prompt.md`, `opus-review-prompt.md`, `codex-control-review-prompt.md`)
- `skills/writing-plans/SKILL.md` — verdict handling + plan format additions (acceptance-criteria + non-goals)
- `vendor/codex-companion/prompts/` — `stop-review-gate.md` and `adversarial-review.md` are NOT edited; the narrow-delta pattern from §5.6 is adapted into dev-orchestrator follow-up prompts only (sync-risk noted)
- `vendor/codex-companion/schemas/review-output.schema.json` — extended with **optional** authorization fields in Phase Ф6 (decision: see Phase Ф6 risks)
- `docs/plans/2026-05-08-review-loop-authorization.md` (this file — frontmatter status flips on phase completion)
- `docs/plans/<slug>.ledger.json` — new transient artifact produced per active plan in any future orchestrated run (specified in Phase Ф1, written by orchestrator at runtime, NOT a source file under version control)

**Source spec:** `docs/changes.md` — read it before any phase. The plan does NOT duplicate spec snippets; it references `§X.Y` for content. Where prompt wording must be adapted for current file context, the affected task calls out the adaptation explicitly.

---

## Top-level Acceptance criteria

- [ ] All seven Fixes A–G applied OR explicitly deferred to a documented follow-up
- [ ] All six revised prompt sections §5.1–§5.6 applied (§5.6 pattern adapted into dev-orchestrator follow-up prompts; `stop-review-gate.md` itself unchanged — see Phase Ф2)
- [ ] Schema extension decision applied: optional authorization fields added in `review-output.schema.json` (Phase Ф6)
- [ ] §6 regression-fixture replay (Phase Ф7) shows new-MUST_FIX_NOW-after-prior-blockers-closed rate <20% on at least one of the two reference logs
- [ ] All five materiality terms (`MUST_FIX_NOW`, `REGRESSION_FROM_AUTHORIZED_FIX`, `DEFER`, `NIT`, `REJECTED_BY_SCOPE`) and the ledger label `AUTHORIZED_CHANGE_LEDGER` appear identically (case-sensitive, underscores, no aliases) across all touched prompt files
- [ ] No CLAUDE.md or README content drift; only files listed in "Components touched" are modified

## Non-goals

- Modifying the Codex companion runtime (`companion.mjs`, dispatcher, hook glue) — out of scope; the schema extension is a passive change made backward-compatible by keeping new fields optional
- Changing model selection (Opus/Sonnet/Codex/xhigh effort tier) — out of scope
- Building tooling that auto-generates the ledger from logs — manual ledger construction by orchestrator suffices for v1
- Rewriting `writing-plans` SKILL.md TDD task/step format — the artifact-design recommendations in §3.7 are deferred unless trivially folded into Phase Ф5
- Editing `vendor/codex-companion/prompts/stop-review-gate.md` or `adversarial-review.md` themselves — the §5.5 and §5.6 ideas are adapted into dev-orchestrator's own prompt templates instead, to avoid divergence from upstream codex-companion
- Backporting any of these changes to the upstream `obra/superpowers` plugin — out of scope for this plan

## Phase ordering rationale

Fix A (the ledger) is referenced by Fixes B/C/D/E/F. Therefore Phase Ф1 lands the ledger plus the smallest reviewer-side change that makes the ledger useful (materiality classes). The §5.x snippets concretize Fixes A–G — so each §5.x edit lands within the same phase as its parent Fix (e.g. §5.1 plan-reviewer "Authorization boundary" + finding-classes wording is part of Phase Ф1; §5.2 fixer revision-scope contract is part of Phase Ф2). Fix E lives in `SKILL.md` (orchestrator state machine), so it has its own phase Ф3 to keep the SKILL.md edit reviewable as a unit. The two-stage plan-review (Fix F) and the orthogonal opus-review/codex-control authorization-boundary edits cluster naturally into Phase Ф4 because they all add the same materiality-bar wording into reviewer prompts. Fix G (Phase Ф5) edits plan formats and depends on the materiality terms already being defined upstream. The schema extension (Phase Ф6) is last because it is the lowest-risk, lowest-impact change and benefits from the prompt edits being settled. Phase Ф7 is the final acceptance gate (regression-fixture replay) — running it earlier would re-run on every iteration and waste effort; running it once at the end against the consolidated prompt edits is correct.

---

## Decision point after Phase 1

After Phase Ф1 lands, the orchestrator pauses and asks the user: continue with Phase Ф2 in this session, or stop and resume later. Phase scope of subsequent rounds may be re-scoped at this point. This is an explicit user requirement to keep the first iteration scope-controlled — Phase Ф1 alone delivers the spec author's "net recommendation" (ledger + materiality classes), so it is a defensible stopping point even if no further phases ship.

---

## Phase Ф1: Ledger + materiality classes (Fix A + Fix B)

### Acceptance criteria

- [x] `skills/dev-orchestrator/SKILL.md` Step 2 and Step 4 describe the AUTHORIZED_CHANGE_LEDGER lifecycle: where it lives (`docs/plans/<slug>.ledger.json`), who writes it (Sonnet orchestrator), when (after every CHANGES_REQUESTED), and what reviewers/fixers receive
- [x] `skills/writing-plans/SKILL.md` "Verdict handling" mentions the same ledger artifact for plan-review CHANGES_REQUESTED rounds
- [x] `skills/dev-orchestrator/plan-reviewer-prompt.md` carries an "Authorization boundary" section AND a "Finding classes" section listing all five materiality terms verbatim
- [x] All five materiality terms (`MUST_FIX_NOW`, `REGRESSION_FROM_AUTHORIZED_FIX`, `DEFER`, `NIT`, `REJECTED_BY_SCOPE`) appear in the plan-reviewer prompt with the spec definitions
- [x] The plan-reviewer first-round output format requires a `class` field per finding (mapped to one of the five terms) AND retains the `APPROVED`/`CHANGES_REQUESTED` line-1 output for backward-compat
- [x] The orchestrator can run end-to-end on a non-trivial task with no further phases applied — the ledger is added but materiality is not yet enforced in fix rounds, follow-up review, or implementer rounds (those are later phases)

### Non-goals

- Editing `opus-plan-prompt.md`, `implementer-prompt.md`, `opus-review-prompt.md`, `codex-control-review-prompt.md` — those land in later phases
- Editing the Codex schema — that's Phase Ф6
- Implementing the new-blocker churn detector — that's Phase Ф3
- Writing tooling that constructs the ledger automatically — orchestrator constructs it manually using `Write` + `jq`
- Making the ledger format strictly schema-validated — for v1 it is conventional JSON whose shape is defined in `SKILL.md` prose
- Mandating the full §5.1 Output per-finding sub-fields (`source_requirement`, `authorization_relation`) in the plan-reviewer prompt itself — these are added as **optional** schema fields in Phase Ф6, but the prompt template requires only `class:` + the existing `<issue> — <what to change>`. Reviewers may emit the optional fields, and the orchestrator may ingest them, but they are not required for round-1 output. Promoting them to required is a separate future fix outside this plan.

### Files

- `skills/dev-orchestrator/SKILL.md` — touch Step 2 ("Codex xhigh reviews the plan") and Step 4 ("Fused review") to insert ledger lifecycle; add a new "## Authorized Change Ledger" H2 between "Role" and "Model split" OR between "Multi-phase plans" and "Reporting cadence" (pick the location with least surrounding-text disruption — see Tasks)
- `skills/dev-orchestrator/plan-reviewer-prompt.md` — replace "## Your job" section (currently lines 41–50) with the §5.1 "Authorization boundary" + "Finding classes" content; extend "## Output format (strict)" to require `class` per finding while keeping line-1 verdict
- `skills/writing-plans/SKILL.md` — append one paragraph in "Verdict handling" (around current lines 44–50) that points at the same ledger artifact described in `dev-orchestrator/SKILL.md`

### Tasks

- [x] **T1.1** Where `skills/dev-orchestrator/SKILL.md` — section choice. Decide ledger H2 insertion site between "## Multi-phase plans" and "## Reporting cadence" (preferred — keeps lifecycle docs near the orchestration loop docs without disturbing the early "HARD RULES" block). Verification: `rg -n '^## ' /Users/strigov/Documents/Claude/projects-сode/superpowers-strigov-ver/skills/dev-orchestrator/SKILL.md` lists existing H2s — confirm "## Multi-phase plans" appears before "## Reporting cadence"
- [x] **T1.2** Where `skills/dev-orchestrator/SKILL.md`:new H2 "## Authorized Change Ledger". What: insert the ledger definition (item shape, who writes, where it lives, what reviewers/fixers receive). Patch source: `changes.md` §4 Fix A (the snippet under "Patch-level change"). Adaptation: the spec snippet says "Fixers receive only ACCEPTED / PARTIALLY_ACCEPTED open items. Reviewers receive the full ledger." — replicate verbatim. Add this fork's specific decision: "Ledger persists at `docs/plans/<slug>.ledger.json` for the duration of the current Step 2 or Step 4 loop; on top-level plan completion or abandonment, the orchestrator deletes it (via `git clean` or `rm`, NEVER committed). The orchestrator main thread (Sonnet) writes it via `Write`/`Edit` of the JSON file — this is mechanical state-keeping, not source code, so the no-writes-on-main rule does not apply (parallel to plan-frontmatter editing already exempted in Rule 1)." Verification: `rg -n '^## Authorized Change Ledger$' skills/dev-orchestrator/SKILL.md` returns exactly one match
- [x] **T1.3** Where `skills/dev-orchestrator/SKILL.md`:Step 2 ("Codex xhigh reviews the plan"). What: in the `CHANGES_REQUESTED` bullet, replace the current "dispatch Opus subagent with `./opus-plan-prompt.md` (revision mode) and the BLOCKING list" with a sequence: "(a) orchestrator triages reviewer findings, classifies each as ACCEPTED / PARTIALLY_ACCEPTED / REJECTED_BY_SCOPE / DEFER / NIT, (b) writes/updates `docs/plans/<slug>.ledger.json`, (c) dispatches Opus subagent revision-mode with the ledger path + open ACCEPTED/PARTIALLY_ACCEPTED items inline, (d) Codex xhigh re-review with `--resume-last` is told ledger path." Patch source: `changes.md` §4 Fix A + §3.4. Verification: `rg -n 'docs/plans/<slug>\.ledger\.json' skills/dev-orchestrator/SKILL.md | wc -l` returns at least 3 (Step 2, Step 4, ledger H2)
- [x] **T1.4** Where `skills/dev-orchestrator/SKILL.md`:Step 4 ("Fused review"). What: in the "Combined BLOCKING list → Non-empty" bullet, mirror the same triage→ledger-write→dispatch sequence used in Step 2; clarify that Step 4 has its OWN ledger entries (id pattern `R<round>-B<n>` with reviewer field set to `opus-review` or `codex-control`). Patch source: `changes.md` §4 Fix A. Verification: both `rg -n 'opus-review' skills/dev-orchestrator/SKILL.md` and `rg -n 'codex-control' skills/dev-orchestrator/SKILL.md` return at least one match each (run as two separate `rg` calls — `\|` inside an `rg` pattern is a literal pipe in Rust regex, so a single combined alternation needs `'opus-review|codex-control'` without the backslash)
- [x] **T1.5** Where `skills/dev-orchestrator/plan-reviewer-prompt.md`:replace the entire "## Your job" section (currently lines 41–50, the bullet list of categories). What: substitute with §5.1 "Authorization boundary" + "Finding classes" wording. Patch source: `changes.md` §5.1 first two H2 blocks (`## Authorization boundary`, `## Finding classes`). Adaptation: the §5.1 snippet refers to "AUTHORIZED_CHANGE_LEDGER" — make sure the prompt template includes the placeholder `<paste ledger or write 'N/A — first round'>` so first-round dispatches still work. Verification: `rg -n '^## Authorization boundary$' skills/dev-orchestrator/plan-reviewer-prompt.md` returns one match; `rg -n 'MUST_FIX_NOW|REGRESSION_FROM_AUTHORIZED_FIX|DEFER|NIT|REJECTED_BY_SCOPE' skills/dev-orchestrator/plan-reviewer-prompt.md | wc -l` returns at least 5 (one per term)
- [x] **T1.6** Where `skills/dev-orchestrator/plan-reviewer-prompt.md`:"## Output format (strict)" section. What: extend the BLOCKING-item line format to require `class: <one of MUST_FIX_NOW | REGRESSION_FROM_AUTHORIZED_FIX>` (only those two are valid in BLOCKING) and add a `DEFER:` / `NIT:` / `REJECTED_BY_SCOPE:` section in CHANGES_REQUESTED output. Keep line 1 of the response = `APPROVED` or `CHANGES_REQUESTED`. Patch source: `changes.md` §5.1 "## Output". Adaptation: the §5.1 spec says "If CHANGES_REQUESTED, emit only MUST_FIX_NOW / REGRESSION_FROM_AUTHORIZED_FIX items under BLOCKING" — match this exactly. Verification: `rg -n 'class:' skills/dev-orchestrator/plan-reviewer-prompt.md` returns at least one match in the output-format block
- [x] **T1.7** Where `skills/dev-orchestrator/plan-reviewer-prompt.md`:"## Follow-up prompt (round 2+, with `--resume-last`)" section. What: add a single line at the top of the follow-up template: "AUTHORIZED_CHANGE_LEDGER (path): `<repo-root>/docs/plans/<slug>.ledger.json` — read this before re-reviewing. The ledger lists which prior findings the orchestrator accepted and which were rejected." Do NOT add the full §5.1 "Follow-up rounds" delta-gated rule yet — that lands in Phase Ф2. Verification: `rg -n 'AUTHORIZED_CHANGE_LEDGER' skills/dev-orchestrator/plan-reviewer-prompt.md` returns at least 2 matches (top of file in Authorization-boundary section, plus follow-up insert)
- [x] **T1.8** Where `skills/writing-plans/SKILL.md`:"Verdict handling" section (currently around lines 44–50). What: append one paragraph stating that for the writing-plans skill's CHANGES_REQUESTED handling, the orchestrator constructs the same `docs/plans/<slug>.ledger.json` artifact described in `dev-orchestrator/SKILL.md` "## Authorized Change Ledger". Cross-link by relative path. Patch source: `changes.md` §4 Fix A files-to-touch list. Verification: `rg -n 'ledger\.json' skills/writing-plans/SKILL.md` returns at least one match
- [x] **T1.9** Cross-cutting wording check. What: confirm all five materiality terms are spelled identically in both `skills/dev-orchestrator/SKILL.md` and `skills/dev-orchestrator/plan-reviewer-prompt.md`. Verification: `rg -n -o 'MUST_FIX_NOW|REGRESSION_FROM_AUTHORIZED_FIX|DEFER|NIT|REJECTED_BY_SCOPE|AUTHORIZED_CHANGE_LEDGER' skills/dev-orchestrator/SKILL.md skills/dev-orchestrator/plan-reviewer-prompt.md skills/writing-plans/SKILL.md | sort -u` shows exactly six unique tokens (the five class names + the ledger label) and zero misspellings/aliases like `MUSTFIX_NOW` or `REGRESSION_FROM_FIX`

### Risks

- **Risk:** Ledger content embedded inline into Codex prompts may grow large in the 16-round case. **Mitigation:** spec §4 Fix A says "ledger can be kept compact, only for current loop" — use a JSON file with one entry per open finding, drop closed entries on next round transition; only inline open ACCEPTED/PARTIALLY_ACCEPTED items into Opus revision-mode prompt
- **Risk:** Sonnet orchestrator now writes a JSON file from main thread, which feels close to the "no writes on main" rule. **Mitigation:** the rule's existing exemption for plan-file frontmatter editing covers this case — call it out explicitly in the ledger H2 (see T1.2 wording) so future readers don't get confused. Phase passes the smell test because the file is orchestrator state, not production code
- **Risk:** First-round dispatches now require a placeholder for "no ledger yet". **Mitigation:** T1.5 explicitly mandates the `<paste ledger or write 'N/A — first round'>` token in the template, and T1.6 keeps line-1 `APPROVED`/`CHANGES_REQUESTED` so backward-compat with any in-flight orchestration is preserved

### Done definition

Phase Ф1 is done when all acceptance criteria are checked; in particular the ledger artifact is documented in both skills' SKILL.md files, the plan-reviewer prompt carries the §5.1 authorization-boundary + finding-classes wording with all five materiality terms, and the cross-cutting `rg` wording check (T1.9) returns six unique tokens with no aliases.

---

## Phase Ф2: Delta-gated follow-up review + fixer revision-scope contract (Fix C + Fix D, plus §5.6 narrow-delta adaptation)

### Acceptance criteria

- [x] `skills/dev-orchestrator/plan-reviewer-prompt.md` follow-up section enforces the §5.1/§5.3 "Follow-up rounds" rule: re-read whole plan, but new MUST_FIX_NOW findings require `new_blocker_materiality` field
- [x] `skills/dev-orchestrator/opus-plan-prompt.md` Mode B (revision) carries the §5.2 "Revision scope contract" wording — fixers cannot apply NITs or do broad consistency passes without authorization
- [x] `skills/dev-orchestrator/opus-plan-prompt.md` Mode B output schema requires per-ledger-item status (`fixed | rejected | already_fixed | needs_authorization`), `no_nits_applied: true/false`, and `deferred_observations: [...]`
- [x] The §5.6 narrow-delta pattern is adapted into `plan-reviewer-prompt.md` follow-up + `opus-review-prompt.md` follow-up + `codex-control-review-prompt.md` follow-up sections (one paragraph each); `vendor/codex-companion/prompts/stop-review-gate.md` is NOT modified
- [x] Phase Ф1's churn behavior persists: ledger items still flow through orchestrator → fixer; this phase narrows the FIXER's authorized scope but does not yet add the orchestrator-side escalation (that's Phase Ф3)

### Non-goals

- Editing `SKILL.md` Step 2 / Step 4 churn detector logic — that is Phase Ф3
- Editing `implementer-prompt.md` — that is Phase Ф3 §5.3
- Editing `vendor/codex-companion/prompts/stop-review-gate.md` itself — see Risks
- Editing the schema or the adversarial-review prompt — Phase Ф6

### Files

- `skills/dev-orchestrator/plan-reviewer-prompt.md` — extend "## Follow-up prompt" with the §5.1 "Follow-up rounds" + §5.3 follow-up-review-rule wording AND a one-paragraph §5.6 narrow-delta adaptation
- `skills/dev-orchestrator/opus-plan-prompt.md` — Mode B (lines 97–134): replace "Your job" content with §5.2 "Revision scope contract" + the Mode B output schema; preserve the Mode A header/wrapper
- `skills/dev-orchestrator/opus-review-prompt.md` — append a one-paragraph §5.6 narrow-delta hint into the existing prompt (at the end, before final discipline section, so first-round behavior is unchanged)
- `skills/dev-orchestrator/codex-control-review-prompt.md` — extend "## Follow-up prompt (round 2+, with `--resume-last`)" with the same §5.6 narrow-delta paragraph

### Tasks

- [x] **T2.1** Where `skills/dev-orchestrator/plan-reviewer-prompt.md`:"## Follow-up prompt (round 2+, with `--resume-last`)". What: replace current 5-line follow-up template with the §5.1 "Follow-up rounds" + §5.3 "Follow-up review rule" wording. Required fields: ledger items must be verified first; new MUST_FIX_NOW requires `new_blocker_materiality`; if all prior closed and only new non-critical issues, return APPROVED with DEFER/NIT items. Patch source: `changes.md` §5.1 "## Follow-up rounds" + §4 Fix C "## Follow-up review rule". Verification: `rg -n 'new_blocker_materiality' skills/dev-orchestrator/plan-reviewer-prompt.md` returns at least one match
- [x] **T2.2** Where `skills/dev-orchestrator/plan-reviewer-prompt.md`:end of follow-up section. What: append one paragraph adapting §5.6 narrow-delta — "First inspect only the authorized delta (the ledger items and the plan-file changes the fixer reported); only escalate older unrelated issues to MUST_FIX_NOW if they meet the high-materiality bar." Patch source: `changes.md` §5.6. Verification: `rg -n 'authorized delta' skills/dev-orchestrator/plan-reviewer-prompt.md` returns one match
- [x] **T2.3** Where `skills/dev-orchestrator/opus-plan-prompt.md`:Mode B section (lines 97–134). What: replace the body of the prompt template (the part inside the triple-backtick block) with: (a) §5.2 "AUTHORIZED_CHANGE_LEDGER" placeholder, (b) §5.2 "Revision scope contract" (Allowed / Forbidden / NEEDS_AUTHORIZATION fallback), (c) §5.2 "Output" schema with per-ledger-item status, no_nits_applied, deferred_observations. Patch source: `changes.md` §5.2 in full (both H2 blocks). Verification: `rg -n 'NEEDS_AUTHORIZATION' skills/dev-orchestrator/opus-plan-prompt.md` returns at least one match; `rg -n 'no_nits_applied' skills/dev-orchestrator/opus-plan-prompt.md` returns at least one match
- [x] **T2.4** Where `skills/dev-orchestrator/opus-plan-prompt.md`:Mode B header (lines 95–98 region). What: keep the existing "## Mode B: Revise a plan (Step 2 CHANGES_REQUESTED)" section header but ensure the prose immediately above the prompt block mentions the ledger as authoritative input (one sentence). Patch source: `changes.md` §3.4 + §4 Fix A. Verification: `rg -n -B1 -A2 'AUTHORIZED_CHANGE_LEDGER' skills/dev-orchestrator/opus-plan-prompt.md` shows the ledger reference inside Mode B
- [x] **T2.5** Where `skills/dev-orchestrator/opus-review-prompt.md`:tail of file before "## Discipline" (current end region around line 90). What: insert a one-paragraph "## Follow-up review delta" stub. Content: "For round 2+ in Step 4, first verify the ACCEPTED ledger items (`docs/plans/<slug>.ledger.json`) are fixed correctly. Inspect surrounding context only as needed; do not promote pre-existing unrelated issues to BLOCKING unless they meet the high-materiality bar (data loss, security, guaranteed failure, public-contract break, or direct failure of phase acceptance criteria)." Patch source: `changes.md` §5.6. Verification: `rg -n '## Follow-up review delta' skills/dev-orchestrator/opus-review-prompt.md` returns one match
- [x] **T2.6** Where `skills/dev-orchestrator/codex-control-review-prompt.md`:"## Follow-up prompt (round 2+, with `--resume-last`)" section (currently lines 67–77). What: extend the follow-up template with the same narrow-delta paragraph as T2.5 but adapted to control-review context: "Focus on the delta between the previous diff and the current diff. The orchestrator's ledger (`docs/plans/<slug>.ledger.json`) lists what was authorized; do not block on pre-existing issues unrelated to the authorized fixes unless they meet the high-materiality bar." Patch source: `changes.md` §5.6. Verification: `rg -n 'authorized fixes' skills/dev-orchestrator/codex-control-review-prompt.md` returns at least one match
- [x] **T2.7** Where `vendor/codex-companion/prompts/stop-review-gate.md`:NO EDIT. What: confirm the file is unchanged. Patch source: this plan's decision (see Phase Ф2 Risks). Verification: `git diff --name-only HEAD vendor/codex-companion/prompts/stop-review-gate.md` returns empty (no modifications to that file)
- [x] **T2.8** Cross-cutting wording check. What: confirm `AUTHORIZED_CHANGE_LEDGER` is referenced (not just the ledger file path) in plan-reviewer follow-up + opus-plan Mode B + opus-review follow-up + codex-control follow-up. Verification: `rg -l 'AUTHORIZED_CHANGE_LEDGER' skills/dev-orchestrator/` returns at least 5 distinct files (SKILL.md from Ф1, plan-reviewer-prompt.md, opus-plan-prompt.md, opus-review-prompt.md, codex-control-review-prompt.md)

### Risks

- **Risk:** `vendor/codex-companion/prompts/` is vendored from upstream codex-companion; editing files there creates merge conflicts on next vendor sync. **Mitigation:** this phase deliberately does NOT edit `stop-review-gate.md` or `adversarial-review.md` — the §5.6 pattern is adapted into dev-orchestrator's own prompts instead. Document this decision in the phase Done definition; future vendor syncs only need to re-check the dev-orchestrator-side adaptation, not the upstream prompt
- **Risk:** Mode B revision contract may be too strict — a fixer might encounter a genuine NEEDS_AUTHORIZATION case mid-edit. **Mitigation:** §5.2 spec already provides the `NEEDS_AUTHORIZATION` return path for this case; preserve it verbatim in T2.3
- **Risk:** Adding `class: MUST_FIX_NOW` to plan-reviewer output (from Ф1) without yet enforcing materiality on follow-up rounds (this phase) creates an awkward intermediate state if a user stops between phases. **Mitigation:** Phase Ф1 alone is functional because line-1 verdict is unchanged; this phase only narrows what the FIXER does and what reviewers escalate in round 2+. Either order is committable

### Done definition

Phase Ф2 is done when all acceptance criteria are checked; the four prompt files (plan-reviewer, opus-plan, opus-review, codex-control) all reference the ledger and the narrow-delta pattern, and `vendor/codex-companion/prompts/` shows a clean diff (no edits there).

---

## Phase Ф3: Churn detector + implementer fix-round scope (Fix E + §5.3)

### Acceptance criteria

- [x] `skills/dev-orchestrator/SKILL.md` Step 2 carries a "## New-blocker churn detector" subsection (or inline paragraph in Step 2's verdict-handling) with the §4 Fix E escalation rule
- [x] `skills/dev-orchestrator/SKILL.md` Step 4 carries the same churn-detector logic for the fused-review loop
- [x] `skills/writing-plans/SKILL.md` "Verdict handling" carries the same churn-detector logic (since it shares Step 2's loop semantics — see Ф1 T1.8 for the existing cross-link)
- [x] `skills/dev-orchestrator/implementer-prompt.md` "## Follow-up prompt (round 2+, with `--resume-last`)" carries the §5.3 "Fix-round scope" wording — implementer cannot fix NITs, opportunistic cleanup, or apply broad consistency passes without authorization
- [x] Implementer follow-up output requires `status: DONE | DONE_WITH_CONCERNS | NEEDS_AUTHORIZATION | BLOCKED` and `unauthorized_changes: []` (must be empty)

### Non-goals

- Touching `opus-review-prompt.md` Step 4a authorization-compliance section (that's Phase Ф4)
- Touching the schema (Phase Ф6)
- Adding tooling that auto-detects churn from logs (manual orchestrator decision is sufficient for v1)

### Files

- `skills/dev-orchestrator/SKILL.md` — Step 2 verdict-handling (currently around lines 167–177), Step 4 cap=4 escalation block (currently around lines 217–223)
- `skills/writing-plans/SKILL.md` — "Verdict handling" section (currently around lines 44–50)
- `skills/dev-orchestrator/implementer-prompt.md` — "## Follow-up prompt (round 2+)" (currently lines 96–113)

### Tasks

- [x] **T3.1** Where `skills/dev-orchestrator/SKILL.md`:Step 2 verdict-handling. What: insert a new bullet between "No-progress detector" and the next H3 — "**New-blocker churn detector**: escalate immediately, even before cap=4, if (a) all blockers from the previous round are fixed or rejected-by-scope, AND (b) the reviewer returns only new MUST_FIX_NOW items, AND (c) none are DATA_LOSS, SECURITY, or GUARANTEED_FAIL materiality. Escalation summary: prior blockers closed + new blockers with materiality labels + recommendation: approve now + defer list OR authorize another high-materiality round." Patch source: `changes.md` §4 Fix E. Verification: `rg -n 'New-blocker churn detector' skills/dev-orchestrator/SKILL.md` returns at least 2 matches (Step 2 + Step 4)
- [x] **T3.2** Where `skills/dev-orchestrator/SKILL.md`:Step 4 fused-review loop guards. What: same churn-detector text as T3.1, applied to the Step 4 loop (each reviewer's blocking history tracked separately as the existing Step 4 anti-pingpong already does — clarify that the churn detector applies to the COMBINED list across opus-review and codex-control). Patch source: `changes.md` §4 Fix E + §3.8. Verification: covered by T3.1 verification + `rg -n -A2 'churn detector' skills/dev-orchestrator/SKILL.md | rg -i 'combined|fused'` returns at least one match
- [x] **T3.3** Where `skills/writing-plans/SKILL.md`:"Verdict handling" section. What: append the same churn-detector bullet (cross-link to dev-orchestrator/SKILL.md so the wording is canonical there). Patch source: `changes.md` §4 Fix E. Verification: `rg -n 'churn detector' skills/writing-plans/SKILL.md` returns at least one match
- [x] **T3.4** Where `skills/dev-orchestrator/implementer-prompt.md`:"## Follow-up prompt (round 2+, with `--resume-last`)" section (currently lines 96–113). What: replace the "## Rules" subsection with the §5.3 "Fix-round scope" wording (Allowed / Forbidden lists + NEEDS_AUTHORIZATION fallback). Add `AUTHORIZED_BLOCKERS:` placeholder where the orchestrator pastes ledger items. Patch source: `changes.md` §5.3 in full. Verification: `rg -n 'AUTHORIZED_BLOCKERS' skills/dev-orchestrator/implementer-prompt.md` returns at least one match; `rg -n 'NEEDS_AUTHORIZATION' skills/dev-orchestrator/implementer-prompt.md` returns at least one match
- [x] **T3.5** Where `skills/dev-orchestrator/implementer-prompt.md`:Required output for follow-up. What: extend the report format in the follow-up section to include `status: DONE | DONE_WITH_CONCERNS | NEEDS_AUTHORIZATION | BLOCKED`, `blockers_fixed: [ids]`, `files_changed_by_blocker:`, `unauthorized_changes: []` (must be empty), `nits_applied: false`. Patch source: `changes.md` §5.3 "## Required output". Verification: `rg -n 'unauthorized_changes' skills/dev-orchestrator/implementer-prompt.md` returns at least one match
- [x] **T3.6** Cross-cutting verification. Verification: `rg -n -o 'NEEDS_AUTHORIZATION' skills/dev-orchestrator/ skills/writing-plans/ | wc -l` returns at least 3 (opus-plan from Ф2, implementer from this phase, plus any internal references) — this confirms the term is consistent across files

### Risks

- **Risk:** Churn detector may misfire on borderline cases (e.g. a stale-cross-reference blocker that is technically "new" but causally tied to a prior fix). **Mitigation:** the spec's `REGRESSION_FROM_AUTHORIZED_FIX` materiality class (defined in Phase Ф1) explicitly handles this case — those findings are NOT counted as "new MUST_FIX_NOW only" in the churn detector test
- **Risk:** Implementer's `unauthorized_changes: []` field requires implementer to self-audit; Codex high may not always do this faithfully. **Mitigation:** opus-review Step 4a (Phase Ф4) cross-checks scope compliance, so even if the implementer self-report is wrong, the next reviewer catches it. This is a defense-in-depth design

### Done definition

Phase Ф3 is done when all acceptance criteria are checked; the churn detector appears in both SKILL.md files for dev-orchestrator and writing-plans, and the implementer follow-up prompt enforces the fix-round scope contract with the new output schema.

---

## Phase Ф4: Two-stage plan review + opus-review and codex-control authorization-boundary (Fix F + §5.4 + §5.5)

### Acceptance criteria

- [x] `skills/dev-orchestrator/plan-reviewer-prompt.md` carries a "## Review stages" H2 with Stage A (requirements compliance) and Stage B (design hardening) — only Stage A produces MUST_FIX_NOW; Stage B findings default to DEFER unless promoted with explicit Stage A criterion citation
- [x] `skills/dev-orchestrator/opus-review-prompt.md` 4a section is rewritten per §5.4 — uses BLOCKING_SCOPE / DEFER_SCOPE / NIT classification; for fix rounds compares against AUTHORIZED_CHANGE_LEDGER; "prefer BLOCKING over NIT" sentence in line 93 is replaced
- [x] `skills/dev-orchestrator/codex-control-review-prompt.md` carries the §5.5 `<authorization_boundary>` and `<finding_required_fields>` blocks; finding format requires `authorization_relation`, `why_now`, `minimal_fix`
- [x] All three reviewer prompts (plan-reviewer, opus-review, codex-control) reach the same materiality bar wording — DATA_LOSS, SECURITY, GUARANTEED_FAIL, REGRESSION (public contract), ACCEPTANCE_CRITERIA — and use it consistently

### Non-goals

- Editing the schema (Phase Ф6) — this phase changes only prompt text, not the JSON contract Codex returns
- Editing `vendor/codex-companion/prompts/adversarial-review.md` — the §5.5 wording is added to dev-orchestrator's own `codex-control-review-prompt.md`, not the vendored adversarial prompt
- Editing implementer or opus-plan prompts (covered in Ф2/Ф3)

### Files

- `skills/dev-orchestrator/plan-reviewer-prompt.md` — append "## Review stages" H2 between "## Finding classes" (added in Ф1) and "## Output format (strict)"
- `skills/dev-orchestrator/opus-review-prompt.md` — replace "### 4a. Spec compliance" body with §5.4 wording; replace "If unsure about a boundary case, prefer BLOCKING over NIT" line with the §5.4 replacement
- `skills/dev-orchestrator/codex-control-review-prompt.md` — insert `<authorization_boundary>` and `<finding_required_fields>` XML-tagged blocks at the top of the first-round prompt template, before "## Phase context"

### Tasks

- [x] **T4.1** Where `skills/dev-orchestrator/plan-reviewer-prompt.md`:between "## Finding classes" (from Ф1) and "## Output format (strict)". What: insert "## Review stages" H2 with Stage A (only producer of MUST_FIX_NOW) and Stage B (design hardening, defaults to DEFER) per §4 Fix F. The Stage A criteria list: missing stated requirement, contradiction with accepted repo constraints, impossible/guaranteed-failing implementation/test, material data-loss/security/regression risk. Stage B promotion rule: must cite exact Stage A criterion. Patch source: `changes.md` §4 Fix F in full. Verification: `rg -n '^## Review stages$' skills/dev-orchestrator/plan-reviewer-prompt.md` returns one match; `rg -n 'Stage A' skills/dev-orchestrator/plan-reviewer-prompt.md` returns at least 2 matches (definition + promotion rule)
- [x] **T4.2** Where `skills/dev-orchestrator/opus-review-prompt.md`:"### 4a. Spec compliance" section (currently lines 35–47). What: replace section content with §5.4 wording — BLOCKING_SCOPE, DEFER_SCOPE, NIT classification + AUTHORIZED_CHANGE_LEDGER comparison rule for fix rounds. Patch source: `changes.md` §5.4 in full. Adaptation: the §5.4 snippet uses `### 4a. Scope and authorization compliance` as the heading; rename current `### 4a. Spec compliance` to that. Verification: `rg -n '### 4a\. Scope and authorization compliance' skills/dev-orchestrator/opus-review-prompt.md` returns one match; `rg -n 'BLOCKING_SCOPE' skills/dev-orchestrator/opus-review-prompt.md` returns at least one match
- [x] **T4.3** Where `skills/dev-orchestrator/opus-review-prompt.md`:line 93 ("If unsure about a boundary case, prefer BLOCKING over NIT — a false alarm costs one Codex round; a missed bug ships."). What: replace with §5.4 final paragraph — "Do not use 'prefer BLOCKING over NIT.' Instead: When unsure, classify by impact. Block only if the impact is material and current." Patch source: `changes.md` §5.4 final paragraph + §3.3. Verification: `rg -n 'prefer BLOCKING over NIT' skills/dev-orchestrator/opus-review-prompt.md` returns ZERO matches; `rg -n 'classify by impact' skills/dev-orchestrator/opus-review-prompt.md` returns at least one match
- [x] **T4.4** Where `skills/dev-orchestrator/codex-control-review-prompt.md`:top of first-round prompt template (currently lines 24–46), before "## Phase context". What: insert `<authorization_boundary>` block + `<finding_required_fields>` block per §5.5. The bar list: data loss/corruption, security/trust-boundary failure, guaranteed build/test/runtime failure, regression of existing public contract, direct failure of phase acceptance criteria. Required fields: `authorization_relation`, `why_now`, `minimal_fix`. Patch source: `changes.md` §5.5 in full. Verification: `rg -n '<authorization_boundary>' skills/dev-orchestrator/codex-control-review-prompt.md` returns one match; `rg -n 'authorization_relation' skills/dev-orchestrator/codex-control-review-prompt.md` returns at least one match
- [x] **T4.5** Where `skills/dev-orchestrator/codex-control-review-prompt.md`:"## Output format (strict)" section. What: extend the BLOCKING-item line format to require `authorization_relation: PLAN_ACCEPTANCE | REGRESSION_FROM_FIX | SECURITY | DATA_LOSS | GUARANTEED_FAIL`, `why_now`, `minimal_fix`. Patch source: `changes.md` §5.5 `<finding_required_fields>` block. Verification: `rg -n 'authorization_relation' skills/dev-orchestrator/codex-control-review-prompt.md` returns at least 2 matches (declaration + output requirement)
- [x] **T4.6** Cross-cutting consistency check. Verification: `rg -n -o 'DATA_LOSS|SECURITY|GUARANTEED_FAIL|REGRESSION|ACCEPTANCE_CRITERIA' skills/dev-orchestrator/plan-reviewer-prompt.md skills/dev-orchestrator/opus-review-prompt.md skills/dev-orchestrator/codex-control-review-prompt.md` shows all five high-materiality bar tokens appearing across the three reviewer prompts (each token appears at least once across the three files; not every token must appear in every file, but the bar wording must be consistent where present — e.g. all three reviewers use `DATA_LOSS` not `data-loss` or `DataLoss`)

### Risks

- **Risk:** Spec compliance reviewer (Stage A) may under-flag genuine architectural problems that don't fit the four narrow Stage A categories. **Mitigation:** the §4 Fix F note "If a Stage B suggestion is promoted to MUST_FIX_NOW, cite the exact Stage A criterion" preserves an escape hatch — capture this in T4.1 verbatim
- **Risk:** Removing "prefer BLOCKING over NIT" weakens defensive review behavior. **Mitigation:** the materiality classes (Phase Ф1) and the high-materiality escape (DATA_LOSS, SECURITY, GUARANTEED_FAIL, REGRESSION, ACCEPTANCE_CRITERIA) provide a structured way to keep important findings as blockers — this is not a softening, it is a re-targeting

### Done definition

Phase Ф4 is done when all acceptance criteria are checked; the three reviewer prompts (plan-reviewer, opus-review, codex-control) all share the same authorization-boundary wording, and the high-materiality term list is consistent across files.

---

## Phase Ф5: Plan-format acceptance-criteria + non-goals (Fix G)

### Acceptance criteria

- [x] `skills/dev-orchestrator/opus-plan-prompt.md` Mode A "Required format" body sections list now includes `## Acceptance criteria` and `## Non-goals / deferred` (in addition to existing Goal/Files/Contracts/Test strategy/Risks/Phases)
- [x] `skills/writing-plans/SKILL.md` "Plan Document Header" or a new section close to it documents the same two H2 sections as required for plans produced through this skill
- [x] Both files clarify the gating rule from §4 Fix G: "Reviewers may block only on these criteria, stated user requirements, repo constraints, or high-materiality risks" and "Reviewers must classify requests for these as REJECTED_BY_SCOPE or DEFER unless the orchestrator authorizes scope expansion"

### Non-goals

- Rewriting the writing-plans TDD task/step format itself — §3.7 deferred
- Editing existing plan files in `docs/plans/` to retrofit acceptance-criteria/non-goals — this plan affects only NEW plans written after the prompt edit lands
- Touching the schema (Phase Ф6)

### Files

- `skills/dev-orchestrator/opus-plan-prompt.md` — Mode A "## Required format" body-sections list (currently around lines 60–67)
- `skills/writing-plans/SKILL.md` — "## Plan Document Header" section (currently around lines 76–92) OR insert a sibling section after it

### Tasks

- [x] **T5.1** Where `skills/dev-orchestrator/opus-plan-prompt.md`:Mode A "## Required format", body-sections numbered list. What: insert two new entries — `1a. ## Acceptance criteria` (3–7 externally observable criteria) and `1b. ## Non-goals / deferred` (explicit exclusions). Position: between current "1. ## Goal" and "2. ## Files". Use the `1a/1b` numbering scheme to AVOID renumbering existing entries 2–6 (chosen to minimize edit surface). Patch source: `changes.md` §4 Fix G in full. Adaptation: §4 Fix G provides the patch-level snippet for the section bodies — quote the gating-rule wording verbatim. Verification: `rg -n '^## Acceptance criteria' skills/dev-orchestrator/opus-plan-prompt.md` returns one match; `rg -n '^## Non-goals' skills/dev-orchestrator/opus-plan-prompt.md` returns one match; `rg -n '^[0-9]+\.' skills/dev-orchestrator/opus-plan-prompt.md` shows entries 1, 2, 3, 4, 5, 6 with original numbering preserved (no renumbering)
- [x] **T5.2** Where `skills/dev-orchestrator/opus-plan-prompt.md`:Mode A "## Discipline" section. What: append a bullet — "Acceptance-criteria gate: the Acceptance criteria section is the reviewer's sole authority for blocking on missing requirements; Non-goals are the explicit defer-list. Together they bound the reviewer's mandate." Patch source: `changes.md` §4 Fix G. Verification: `rg -n 'Acceptance-criteria gate' skills/dev-orchestrator/opus-plan-prompt.md` returns one match
- [x] **T5.3** Where `skills/writing-plans/SKILL.md`:after "## Plan Document Header" (currently ends around line 92). What: insert a new H2 "## Required body sections" listing Goal, Acceptance criteria, Non-goals / deferred, File Structure, Task list, Self-Review — and copy the §4 Fix G gating rule wording. Cross-link to `dev-orchestrator/opus-plan-prompt.md` for the YAML-phases variant. Patch source: `changes.md` §4 Fix G. Verification: `rg -n '## Required body sections' skills/writing-plans/SKILL.md` returns one match; `rg -n 'Acceptance criteria' skills/writing-plans/SKILL.md` returns at least 2 matches (in header section + in required-body-sections list)
- [x] **T5.4** Where `skills/writing-plans/SKILL.md`:"## Self-Review" section (currently around lines 154–164). What: append one bullet to the self-review checklist — "**4. Acceptance-criteria coverage:** does every phase produce something observable in the Acceptance criteria list? Are Non-goals explicit enough that a reviewer would reject scope-expansion requests?" Patch source: `changes.md` §4 Fix G + §3.7. Verification: `rg -n 'Acceptance-criteria coverage' skills/writing-plans/SKILL.md` returns one match
- [x] **T5.5** Cross-cutting consistency check. Verification: `rg -n -o 'REJECTED_BY_SCOPE' skills/dev-orchestrator/ skills/writing-plans/` shows the term in at least 5 files (plan-reviewer from Ф1, opus-plan from Ф2/Ф5, opus-review from Ф4, codex-control from Ф4, writing-plans/SKILL.md from this phase) — confirms the materiality term ties back to Phase Ф1's vocabulary

### Risks

- **Risk:** Existing in-progress plans (e.g. `2026-05-08-upstream-sync-v5.1.0.md`) lack Acceptance criteria / Non-goals sections; new plans written by Opus after this phase lands will have them, but old plans won't — reviewer behavior on old plans falls back to scope = "whatever's in the plan body". **Mitigation:** explicitly call out in T5.3 that this affects only NEW plans; do NOT add a retrofit step to this phase
- **Risk:** Adding two more required H2 sections increases the smallest reasonable plan size. **Mitigation:** the spec §4 Fix G says "3–7 externally observable criteria" — bound the section size; small plans don't pay much overhead

### Done definition

Phase Ф5 is done when all acceptance criteria are checked; both plan-format files require `## Acceptance criteria` and `## Non-goals / deferred` sections, and the self-review checklist confirms coverage.

---

## Phase Ф6: Schema extension — optional authorization fields

### Acceptance criteria

- [ ] `vendor/codex-companion/schemas/review-output.schema.json` `findings.items.properties` gains six new fields: `class`, `authorization_relation`, `source_requirement`, `materiality`, `why_now`, `minimal_fix`
- [ ] All six new fields are OPTIONAL (NOT in the `required` array of `findings.items`)
- [ ] `additionalProperties: false` is preserved on `findings.items` (otherwise the schema would silently accept anything)
- [ ] `class` enum constrains to: `MUST_FIX_NOW`, `REGRESSION_FROM_AUTHORIZED_FIX`, `DEFER`, `NIT`, `REJECTED_BY_SCOPE` (matching Phase Ф1 wording)
- [ ] The schema validates against existing adversarial-review JSON outputs (i.e. outputs produced by `vendor/codex-companion/prompts/adversarial-review.md` without the new fields still validate)
- [ ] A short comment block (top of the JSON file, as a `description` property on the schema root, since JSON has no native comments) records the vendor-sync risk for future maintainers

### Non-goals

- Editing `vendor/codex-companion/prompts/adversarial-review.md` to start emitting the new fields — that would be a behavior change in the vendored path; this phase only makes the schema accept them
- Editing the `companion.mjs` runtime to consume the new fields — runtime changes are out of scope per top-level Non-goals
- Making the new fields strictly typed beyond the spec wording — `class` gets an enum; `authorization_relation`, `materiality` get freeform strings (orchestrator-internal classification)

### Files

- `vendor/codex-companion/schemas/review-output.schema.json` — extend `findings.items.properties` with six new fields, leave `required` array unchanged

### Tasks

- [ ] **T6.1** Where `vendor/codex-companion/schemas/review-output.schema.json`:`findings.items.properties` (lines 38–75 region). What: add six properties — `class` (string with `enum: [MUST_FIX_NOW, REGRESSION_FROM_AUTHORIZED_FIX, DEFER, NIT, REJECTED_BY_SCOPE]`), `authorization_relation` (string), `source_requirement` (string), `materiality` (string), `why_now` (string), `minimal_fix` (string). Patch source: `changes.md` §7 item 2. Verification: `jq '.properties.findings.items.properties | keys' vendor/codex-companion/schemas/review-output.schema.json | rg -c 'class|authorization_relation|source_requirement|materiality|why_now|minimal_fix'` returns at least 6
- [ ] **T6.2** Where `vendor/codex-companion/schemas/review-output.schema.json`:`findings.items.required` array (currently lines 28–37). What: do NOT modify — keep the existing required list (`severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation`). Verification: `jq '.properties.findings.items.required | length' vendor/codex-companion/schemas/review-output.schema.json` returns 8 (unchanged)
- [ ] **T6.3** Where `vendor/codex-companion/schemas/review-output.schema.json`:root level. What: add a `description` property documenting the vendor-sync risk — "Optional fields `class`, `authorization_relation`, `source_requirement`, `materiality`, `why_now`, `minimal_fix` are dev-orchestrator-internal extensions added on YYYY-MM-DD; they MUST remain optional to keep upstream codex-companion adversarial-review.md output backward-compatible. See docs/plans/2026-05-08-review-loop-authorization.md Phase Ф6." Patch source: `changes.md` §7 item 2 + this plan's risk note. Verification: `jq '.description' vendor/codex-companion/schemas/review-output.schema.json` returns a non-null string mentioning "dev-orchestrator-internal"
- [ ] **T6.4** Backward-compat check. What: validate the unchanged adversarial-review output shape still matches the schema. Construction: build TWO synthetic JSON objects — (a) minimal: verdict + summary + empty findings array + empty next_steps; (b) typical: verdict + summary + one-element findings array where the single finding contains ONLY the eight existing required fields (`severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation`) + next_steps. Both must validate cleanly. Verification: run `python3 -c "import json,jsonschema; s=json.load(open('vendor/codex-companion/schemas/review-output.schema.json')); a={'verdict':'approve','summary':'x','findings':[],'next_steps':[]}; b={'verdict':'needs-attention','summary':'x','findings':[{'severity':'low','title':'t','body':'b','file':'f','line_start':1,'line_end':1,'confidence':0.5,'recommendation':'r'}],'next_steps':['n']}; jsonschema.validate(a,s); jsonschema.validate(b,s); print('ok')"` (jsonschema package preferred; fallback to `jq -e . vendor/codex-companion/schemas/review-output.schema.json > /dev/null && echo ok` for at-minimum-syntax-valid). The full jsonschema validation of both shapes is preferred but the `jq` fallback is acceptable if the package is unavailable
- [ ] **T6.5** Where `additionalProperties` constraint. What: confirm `additionalProperties: false` on `findings.items` is preserved after T6.1's edits. Verification: `jq '.properties.findings.items.additionalProperties' vendor/codex-companion/schemas/review-output.schema.json` returns `false`

### Risks

- **Risk (high):** `vendor/codex-companion/schemas/review-output.schema.json` is vendored from upstream codex-companion. Adding fields here creates a real merge-conflict surface on next vendor sync. **Mitigation:** (a) keep the new fields strictly optional so that upstream-emitted JSON still validates without modification, (b) document the divergence in the schema's `description` property (T6.3) for future maintainers, (c) if upstream eventually adds incompatible fields under the same names, the divergence is detectable via `jq` diff during sync. Document the diff in the existing `docs/plans/2026-05-08-upstream-sync-v5.1.0.md` follow-up notes if a sync-tracking doc exists; otherwise note in this plan's done definition for future readers
- **Risk (low):** `additionalProperties: false` being preserved means the schema now actively rejects any other future field. **Mitigation:** this is the existing schema behavior, not a new risk; preserve as-is

### Done definition

Phase Ф6 is done when all acceptance criteria are checked; the schema extension is backward-compatible (existing adversarial-review outputs still validate) and the `description` property documents the vendor-sync risk inline in the file.

---

## Phase Ф7: Regression-fixture replay (final acceptance gate)

### Acceptance criteria

- [ ] At least one of the two reference logs (16-round big case OR 11-round small case from §2 evidence map) is replayed through the revised prompts (manual replay, since there is no automated harness)
- [ ] The replay produces a per-round table comparing OLD vs NEW classification: each old MUST_FIX_NOW gets re-classified as one of MUST_FIX_NOW / REGRESSION_FROM_AUTHORIZED_FIX / DEFER / NIT / REJECTED_BY_SCOPE
- [ ] The replay measures `new_MUST_FIX_NOW_after_prior_closed` rate — target <20% on at least one log (per spec §6 Scenario 3)
- [ ] If the target metric fails, the orchestrator escalates to user with "regression test failed; recommend stopping at Phase ФN" rather than silently completing the plan
- [ ] All five §6 scenarios are touched at least lightly (Scenario 1: rejected-scope repeat; Scenario 2: NIT contamination; Scenario 3: edge-case cascade; Scenario 4: cross-reference drift; Scenario 5: implementation-review extra guard) — even if only one scenario produces a hard metric pass, the others are sanity-checked qualitatively

### Non-goals

- Building an automated replay harness — manual replay through revised prompts is sufficient for v1
- Replaying both logs end-to-end if the first log already meets the metric — second log can stay qualitative
- Re-running on synthetic fixtures (Scenario 5) at production effort — a small handcrafted diff suffices

### Files

- No source files modified in this phase. Output is a "replay report" appended to this plan file (frontmatter `status: done` flip on completion) OR as a sibling document `docs/plans/2026-05-08-review-loop-authorization-replay.md` (decide at execution time based on size — plan author preference is a sibling document if the report exceeds 200 lines)

### Tasks

- [ ] **T7.1** Identify the two reference logs by content. What: locate the 16-round big case (`docs/changes.md` §2 references "2026-05-05..." paths) and the 11-round small case (referenced as `planning-stage-log.md`) in the repo. Verification: `find /Users/strigov/Documents/Claude/projects-сode/superpowers-strigov-ver -name 'planning-stage-log.md' -o -name '2026-05-05*'` returns both files (or escalate to user if either is missing)
- [ ] **T7.2** For each log: extract the per-round summary into a tabular form (round number, reviewer findings, orchestrator decisions). Manual transcription is acceptable. Patch source: `changes.md` §6 Regression-fixture method. Verification: at least one log table is constructed and recorded in the replay report
- [ ] **T7.3** Replay big case (or small case, whichever is logistically easier) by feeding each round's reviewer findings into the revised plan-reviewer-prompt.md (in a fresh Codex/Opus dispatch with no `--resume-last` to avoid memory contamination). Capture re-classification per finding. Verification: the replay report contains a per-round before/after classification table with at least one full pass through the chosen log
- [ ] **T7.4** Compute metrics. What: count `new_MUST_FIX_NOW_after_prior_closed` (the rate of new MUST_FIX_NOW findings in round N+1 when all round N MUST_FIX_NOW were closed). Patch source: `changes.md` §6 Scenario 3. Verification: a numeric rate is reported (e.g. "8/40 = 20%"); compare against the target <20%
- [ ] **T7.5** Assess pass/fail. What: if the rate is <20% on at least one log, mark this phase as PASS; if not, escalate to user with the failed metric and a recommendation to either (a) refine specific prompt edits and re-run, or (b) accept the partial improvement and document residual risk. Verification: a pass/fail line in the replay report
- [ ] **T7.6** Update plan frontmatter on success. What: orchestrator flips top-level `status: in-progress → done` and Phase Ф7 `status: pending → done`. Verification: `head -30 docs/plans/2026-05-08-review-loop-authorization.md | rg 'status: done'` returns at least one match (top-level)

### Risks

- **Risk:** Manual replay is subjective; classifier judgment may be inconsistent across rounds. **Mitigation:** force the replay to use the SAME revised prompt-text per round (no improvisation). If a round's classification is genuinely ambiguous, log it as "AMBIGUOUS — both classifications defensible" and exclude from the metric numerator/denominator
- **Risk:** Reference logs may have evolved since `changes.md` was written; line numbers and round counts could drift. **Mitigation:** T7.1 verifies file presence, not line numbers; replay operates on round-summary content, not exact lines
- **Risk:** Target metric (<20%) is aspirational and may fail. **Mitigation:** T7.5 explicitly handles the fail path — escalate to user rather than silently mark phase done

### Done definition

Phase Ф7 is done when at least one log has been replayed, the new-MUST_FIX_NOW-after-prior-closed metric is reported, and either the metric passes (<20%) OR the user has been notified and chosen how to proceed.

---

## Self-Review (run inline)

**1. Spec coverage:**
- Fix A → Phase Ф1
- Fix B → Phase Ф1
- Fix C → Phase Ф2
- Fix D → Phase Ф2
- Fix E → Phase Ф3
- Fix F → Phase Ф4
- Fix G → Phase Ф5
- §5.1 → Phase Ф1 (T1.5, T1.6, T1.7) + §5.1 follow-up rule → Phase Ф2 (T2.1)
- §5.2 → Phase Ф2 (T2.3, T2.4)
- §5.3 → Phase Ф3 (T3.4, T3.5)
- §5.4 → Phase Ф4 (T4.2, T4.3)
- §5.5 → Phase Ф4 (T4.4, T4.5)
- §5.6 → Phase Ф2 (T2.2, T2.5, T2.6) — adapted, not edited in upstream `stop-review-gate.md`
- §7 item 2 (schema) → Phase Ф6
- §6 regression-fixture replay → Phase Ф7

No gaps.

**2. Wording consistency:**
- `AUTHORIZED_CHANGE_LEDGER` — used identically in all phase task descriptions and verification commands
- `MUST_FIX_NOW`, `REGRESSION_FROM_AUTHORIZED_FIX`, `DEFER`, `NIT`, `REJECTED_BY_SCOPE` — five terms, used identically across all phase descriptions

**3. Phase independence:**
- Phase Ф1 introduces the ledger artifact and updates plan-reviewer; the orchestrator can run end-to-end after Ф1 because line-1 verdict semantics are preserved (APPROVED/CHANGES_REQUESTED). Fixers (opus-plan Mode B) and other reviewers continue with old behavior; only the plan-reviewer first-round + ledger-write step are new
- Phase Ф2 narrows fixer + adds delta gate to plan-reviewer follow-up; orchestrator works without Ф3/4/5/6/7
- Phase Ф3 adds churn detector + implementer fix-round contract; Ф1's ledger is referenced but not strictly required by the implementer prompt (the AUTHORIZED_BLOCKERS placeholder accepts any inline list)
- Phase Ф4 adds two-stage plan review + opus-review/codex-control authorization-boundary; reviewer prompts work without other phases
- Phase Ф5 adds Acceptance criteria + Non-goals to plan formats; pure additive change to plan-format documentation
- Phase Ф6 schema extension is backward-compatible by construction (optional fields)
- Phase Ф7 is the final acceptance gate; no source edits

Each phase is independently commit-able.

**4. Net recommendation alignment:**
Phase Ф1 contains exactly Fix A (ledger) + Fix B (materiality classes) + the §5.1 prompt sections that concretize them (Authorization boundary + Finding classes + first-round Output format). It does NOT contain Fix C (delta gate, in Ф2), Fix D (revision contract, in Ф2), Fix E (churn detector, in Ф3), Fix F (two-stage review, in Ф4), Fix G (acceptance-criteria, in Ф5), or §5.2/§5.3/§5.4/§5.5/§5.6 in their entirety. The follow-up rule of §5.1 is split between Ф1 (the AUTHORIZED_CHANGE_LEDGER reference inserted in T1.7 to give round 2+ reviewers something to read) and Ф2 (the actual delta-gated rule in T2.1). This split is intentional: Ф1 alone gives the reviewer a ledger pointer without changing the verdict semantics.

**5. Verification specificity:**
Every Task uses concrete `rg`/`grep`/`jq`/`jsonschema` commands or git-diff checks. No "manually inspect" instructions. Spot-check: T1.5 uses `rg -n '^## Authorization boundary$'`; T6.4 uses `jq -e .` plus optional jsonschema. All commands are runnable on the dev machine (jq and rg are installed, confirmed).

**6. Decision point present:**
The `## Decision point after Phase 1` H2 section exists between "## Phase ordering rationale" and "## Phase Ф1".

**7. No placeholders:**
No "TBD"/"TODO"/"details later" tokens. Every task names the file, the section, the patch source by §X.Y, and a concrete verification command. Spot-check confirmed by reading T2.3 (full §5.2 in Mode B), T4.4 (full §5.5 XML blocks), T6.1 (six explicit field names with enum). Phase Ф7 acknowledges manual replay but specifies the per-task verification (presence of replay report, computed metric).

All seven self-review items pass.
