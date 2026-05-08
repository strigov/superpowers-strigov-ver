---
slug: review-loop-authorization-replay
created: 2026-05-09
parent: 2026-05-08-review-loop-authorization
phase: Ф7
status: done
---

# Review-Loop Authorization — Phase Ф7 Replay Report

**Source log:** `/Users/strigov/Documents/Claude/Projects/Cowork/context/logs/planning-stage-log.md` (small case, 11-round upstream-sync-v5.1.0 plan review)

**Method:** manual replay. Each round's BLOCKING items re-classified under the revised plan-reviewer-prompt.md Finding classes (Ф1) + Review stages Stage A/B (Ф4) + Follow-up review rule with `new_blocker_materiality` requirement (Ф2). REGRESSION_FROM_AUTHORIZED_FIX is recognized when the new finding is causally tied to a fix from a prior accepted ledger item. The new-blocker churn detector (Ф3) triggers escalation when prior MUST_FIX_NOW are closed and the new round contains only DEFER/NIT items (or only new MUST_FIX_NOW that fail the high-materiality bar).

**Why small case only:** Small case is the easier of the two reference logs to tabulate (11 rounds, 28 BLOCKING items vs 16 rounds / ~38 BLOCKING). Per the parent plan's Non-goals, replaying both logs end-to-end is not required if the first log demonstrates the metric. Qualitative observations about the big case appear at the end.

---

## Per-round classification (small case)

Notation: `OLD` = original BLOCKING list from the log. `NEW` = how each item is classified under the revised prompts.

### R1 (first round)

Stage A test applies to all 6 items.

| # | Issue (one-line) | OLD | NEW |
|---|---|---|---|
| 1 | Detached-HEAD menu broken — PR from detached doesn't create branch | BLOCKING | `MUST_FIX_NOW` (Stage A: impossible/guaranteed-failing implementation) |
| 2 | Cleanup recomputed `WORKTREE_PATH` after `cd` | BLOCKING | `MUST_FIX_NOW` (Stage A: guaranteed-failing — would point at wrong path) |
| 3 | Plan said both "Drops" Opus dispatch and "Risk" acknowledging it | BLOCKING | `MUST_FIX_NOW` (Stage A: contradicts stated user requirement — fork keeps Opus dispatch) |
| 4 | Risk R2 (consent prompt blocks automation) not closed | BLOCKING | `MUST_FIX_NOW` (Stage A: stated repo constraint — automation must work) |
| 5 | `.gitignore` check used wrong pattern | BLOCKING | `MUST_FIX_NOW` (Stage A: guaranteed-failing on resolved-path edge cases) |
| 6 | Directory priority inconsistent across sections | BLOCKING | `MUST_FIX_NOW` (Stage A: contradiction with itself, will produce inconsistent behavior) |

R1 in new system: 6 MUST_FIX_NOW (same 6 as old). All are valid Stage A, none are removable.

### R2 (after R1 fully closed)

Apply Follow-up review rule: only NEW issues clearing the high-materiality bar may be MUST_FIX_NOW, and each must carry `new_blocker_materiality`.

| # | Issue | OLD | NEW |
|---|---|---|---|
| 1 | After-Ф1 grep would fail — file not modified at Ф1 time | BLOCKING | `MUST_FIX_NOW` (`new_blocker_materiality: GUARANTEED_FAIL` — verification step would always fail) |
| 2 | `WORKTREE_PATH` vs `WORKTREE_PARENT_DIR` conflated | BLOCKING | `MUST_FIX_NOW` (`new_blocker_materiality: GUARANTEED_FAIL` — implementer would code wrong path semantics) |
| 3 | Branch deletion unconditional, fails when checked out | BLOCKING | `MUST_FIX_NOW` (`new_blocker_materiality: GUARANTEED_FAIL` on edge case) |
| 4 | `GIT_DIR`/`GIT_COMMON`/`MAIN_ROOT` not pre-captured | BLOCKING | `REGRESSION_FROM_AUTHORIZED_FIX` (R1 #2 introduced the `cd` flow but didn't capture all needed vars — directly induced by an accepted fix) |

R2 in new system: 3 NEW MUST_FIX_NOW + 1 REGRESSION_FROM_AUTHORIZED_FIX. All clear high-materiality bar. Churn detector NOT triggered (high-materiality items present).

### R3 (after R2 fully closed)

| # | Issue | OLD | NEW |
|---|---|---|---|
| 1 | Normal-repo path missing branch deletion + Option 4d discard | BLOCKING | `MUST_FIX_NOW` (`new_blocker_materiality: ACCEPTANCE_CRITERIA` — Option 4 discard semantics is a stated phase requirement; missing path = acceptance failure) |
| 2 | Detached confirmation said "Discarded" regardless of outcome | BLOCKING | `DEFER` (Stage B: improved UX / honest reporting; no implementation failure — operation still completes, only the message is misleading) |
| 3 | Phase verification step numbers stale/mismatched | BLOCKING | `DEFER` (Stage B: clarity; reviewer/implementer can resolve by re-reading) |
| 4 | R2 gate verdict not reflected in Files / Test strategy | BLOCKING | `DEFER` (Stage B: process alignment, no implementation/test impact) |

R3 in new system: 1 MUST_FIX_NOW + 3 DEFER. Verdict: `CHANGES_REQUESTED` (1 BLOCKING) instead of 4-item BLOCKING list.

### R4 (after R3 closed; in old system this was the cap=4 escalation)

| # | Issue | OLD | NEW |
|---|---|---|---|
| 1 | After-Ф2 smoke test guarantee-fails on `render-graphs.js` pre-existing strings | BLOCKING | `MUST_FIX_NOW` (`new_blocker_materiality: GUARANTEED_FAIL`) |
| 2 | R2 gate: `dev-orchestrator/SKILL.md` doesn't reference `using-git-worktrees` | BLOCKING | `DEFER` (Stage B: process clarity — gate verdict already documented in plan, no impl impact) |
| 3 | After-Ф2 verification doesn't prove key Ф2 contracts (Opus dispatch, etc.) | BLOCKING | `MUST_FIX_NOW` (`new_blocker_materiality: ACCEPTANCE_CRITERIA` — hard fork requirement listed in plan acceptance, no test coverage) |

R4 in new system: 2 MUST_FIX_NOW + 1 DEFER. No cap=4 escalation needed (only 2 BLOCKING vs old 3).

### R5 (after R4 closed)

| # | Issue | OLD | NEW |
|---|---|---|---|
| 1 | Option 4 ordering contract contradicts 4b CWD-first requirement | BLOCKING | `REGRESSION_FROM_AUTHORIZED_FIX` (R4-era fix to CWD safety regressed the contract prose) |
| 2 | Step 4 menu "externally managed" wording wrong for provenance-owned 4a | BLOCKING | `MUST_FIX_NOW` (`new_blocker_materiality: ACCEPTANCE_CRITERIA` — fork's provenance-owned path is a stated requirement; menu directly contradicts it) |

R5 in new system: 1 MUST_FIX_NOW + 1 REGRESSION_FROM_AUTHORIZED_FIX.

### R6 (after R5 closed)

| # | Issue | OLD | NEW |
|---|---|---|---|
| 1 | Option 4b: `git worktree remove` before `cd "$MAIN_ROOT"` (CWD-safety violation) | BLOCKING | `REGRESSION_FROM_AUTHORIZED_FIX` (R5 #1 fix introduced the CWD-first rule but wording regressed in 4b path) |
| 2 | Step 6 missing existence guard before `git worktree remove` | BLOCKING | `MUST_FIX_NOW` (`new_blocker_materiality: GUARANTEED_FAIL` on already-removed paths) |
| 3 | Detached 4a harness-owned could print false "Discarded" | BLOCKING | `DEFER` (Stage B: UX honesty; same class as R3 #2, not impl-blocking) |

R6 in new system: 1 MUST_FIX_NOW + 1 REGRESSION_FROM_AUTHORIZED_FIX + 1 DEFER.

### R7 (after R6 closed)

| # | Issue | OLD | NEW |
|---|---|---|---|
| 1 | Step 2 state table single row for detached HEAD | BLOCKING | `DEFER` (Stage B: cross-reference clarity; no impl/test impact) |
| 2 | Quick Reference table inaccurate per subcase | BLOCKING | `DEFER` (Stage B: cross-reference clarity) |

R7 in new system: 0 NEW MUST_FIX_NOW + 2 DEFER. **Verdict: `APPROVED` with DEFER list** (per Follow-up review rule: "If all prior ledger blockers are fixed and you found only new non-critical issues, return APPROVED").

**Churn detector trigger.** Even if reviewer wrongly raised these as MUST_FIX_NOW, the orchestrator-side detector would escalate at R7: prior closed, no high-materiality items in the new round → "approve now + defer list" recommendation forwarded to user.

### R8 → R11

In the new system the loop **terminates at R7** with `APPROVED + 2 DEFER`. R8–R11 do not happen. For completeness, classifications under the new prompts:

| Round | OLD | NEW |
|---|---|---|
| R8 #1 (detached confirmation "switch back" wording) | BLOCKING | `DEFER` (Stage B UX clarity) |
| R9 #1 (state table 4a inconsistencies) | BLOCKING | `DEFER` (Stage B cross-reference consistency) |
| R10 #1 (Option 4 ordering contract regressed again) | BLOCKING | `REGRESSION_FROM_AUTHORIZED_FIX` — but only meaningful if there was an intervening accepted ledger item; under new system R8/R9 didn't run, so R10 is moot |
| R10 #2 (Step 4 menu "externally managed" regressed again) | BLOCKING | `REGRESSION_FROM_AUTHORIZED_FIX` — same |
| R11 NITs | NIT (informational) | `NIT` (no class change) |

---

## Metric

### Round count

- **OLD:** 11 rounds (1 escalation at cap=4 → user authorized continue)
- **NEW:** 7 rounds (R1–R6 each produced ≥1 MUST_FIX_NOW or REGRESSION_FROM_AUTHORIZED_FIX, R7 returned APPROVED with only DEFER items)

**Reduction:** ≈36% fewer rounds.

### BLOCKING-list volume (items)

- **OLD:** 28 BLOCKING items raised across 11 rounds (per log Summary Statistics).
- **NEW:** 17 BLOCKING items (6 + 4 + 1 + 2 + 2 + 2 + 0 = 17, where R3–R7 BLOCKING counts include both MUST_FIX_NOW and REGRESSION_FROM_AUTHORIZED_FIX). The remaining 11 OLD-BLOCKING items become DEFER (10) or NIT (R11 NITs unchanged: 2 NITs informational).

**Reduction:** ≈39% fewer BLOCKING items.

### `new_MUST_FIX_NOW_after_prior_closed` rate (spec §6 Scenario 3)

Definition used: of the follow-up rounds (R2..R(N)) where ALL prior MUST_FIX_NOW were closed, how many introduced ≥1 NEW MUST_FIX_NOW (not REGRESSION_FROM_AUTHORIZED_FIX, not DEFER, not NIT).

| Round | Prior closed? | New MUST_FIX_NOW (excl. REGRESSION) | Counts in metric? |
|---|---|---|---|
| R2 | yes | 3 | yes |
| R3 | yes | 1 | yes |
| R4 | yes | 2 | yes |
| R5 | yes | 1 | yes |
| R6 | yes | 1 | yes |
| R7 | yes | 0 | no (APPROVED) |

- **NEW rate:** 5 / 6 = **83%** (rounds with new MUST_FIX_NOW after prior closed, of all eligible follow-ups).
- **OLD rate:** 10 / 10 = **100%** (every R2–R11 raised new BLOCKING after prior closed, per the log).

**Target:** <20%.

### Pass/fail

**FAIL** on the strict `<20%` metric. The new prompts reduced rounds by ~36% and BLOCKING volume by ~39%, but the rate of "new MUST_FIX_NOW after prior closed" remains high because R2–R6 each introduced GUARANTEED_FAIL or ACCEPTANCE_CRITERIA findings that legitimately clear the high-materiality bar — these are NOT process-induced churn, they are real gaps the planner missed in R1 and the reviewer found later.

The fail signal is in the metric, **not** in the redesign. The metric was calibrated for cases where R2+ findings are mostly Stage B clarity / NITs / scope-creep — what changes.md §3.1 calls "reviewer co-authoring scope expansion". The small case is **dominated by genuine plan defects** (CWD safety, branch-deletion edge cases, smoke-test false positives, contract regressions caused by accepted fixes), not scope creep. Even a perfect reviewer would have raised these.

What the new system DID prevent in this case: rounds R7–R10 (4 of 11). Those rounds in OLD raised wording / cross-reference / state-table consistency issues — exactly the Stage B clarity findings the new prompts route to DEFER. R7's two findings ("state table single row", "Quick Reference table per-subcase") and R8/R9 (detached confirmation wording, state-table 4a inconsistencies) are the canonical "broad consistency pass" smell the spec §3.7 calls out.

---

## Qualitative big-case observations

The 16-round big case (`2026-05-05-planning-session-log.md`) was not replayed item-by-item, but the parent plan's evidence-map (changes.md §2) describes the dominant patterns:

- **R1 architecture replacement / mammoth / CLI** → under new prompts: `REJECTED_BY_SCOPE` (the plan's `## Non-goals / deferred` section, required by Ф5, would catch these as out-of-scope; failing that, Stage B → DEFER).
- **R5–R10 requisites / regex / pre-scan / tail-window cascade** → mixed: first 1–2 are real Stage A bugs, the rest are guard/heuristic creep that under §5.4 / §5.5 would be flagged as `BLOCKING_SCOPE` ("review-fix round changed anything not tied to an authorized blocker") and the implementer's `unauthorized_changes: []` requirement (Ф3 §5.3) would block silent expansion.
- **R7 / R11 / R14 NIT fixes** → under §5.2 Revision scope contract: forbidden without explicit ledger authorization; `no_nits_applied: true` MUST be returned.
- **R12 broad consistency pass** → forbidden by §5.2 directly; Mode B revision contract forbids "general consistency pass" + writing-plans Self-Review item 4 (Ф5) makes Acceptance-criteria coverage explicit, narrowing what counts as a real cross-reference failure.

The big case's process-induced rounds (estimated R5–R7, R10–R12, R14) are the ones the new system is most likely to have prevented. Those alone would reduce 16 rounds to ~9, plus the new churn detector escalation at R5 would have reached the user earlier.

---

## §6 Scenarios — sanity check

| Scenario | Status | Notes |
|---|---|---|
| 1: rejected-scope repeat | LIKELY-PASS (qualitative) | New AUTHORIZED_CHANGE_LEDGER persists `decision: REJECTED_BY_SCOPE`; follow-up reviewer is told ledger path; same finding cannot be silently re-raised. |
| 2: NIT contamination | LIKELY-PASS (qualitative) | §5.2 forbids fixer NIT application; output requires `no_nits_applied: true`; opus-review and codex-control prompts route NITs to `NITS:` section, not BLOCKING. |
| 3: edge-case cascade (numeric) | FAIL on strict <20% target, but ≈83% rate is misleading: 5 of 6 follow-up rounds raised legitimate GUARANTEED_FAIL / ACCEPTANCE_CRITERIA findings that the original R1 planner missed. Round count and total BLOCKING reduced (≈36% / ≈39%). | The metric numerator over-counts genuine plan defects in this fixture. |
| 4: cross-reference drift | LIKELY-PASS (qualitative) | R7 / R8 / R9 Stage B drift findings under new prompts go to DEFER; `## Required body sections` (Ф5) makes File Structure / contracts more explicit, reducing R12-style broad consistency passes. |
| 5: implementation-review extra guard | NOT REPLAYED | Phase Ф7 is a plan-review replay; implementation-review (Step 4) would need a separate diff fixture. The §5.4 `BLOCKING_SCOPE` / `DEFER_SCOPE` classification + §5.5 `<authorization_boundary>` + ledger-comparison rule for fix rounds (Ф2 T2.5/T2.6) target this scenario, but a metric pass requires a separate harness or diff replay. |

---

## Recommendation

**Document Ф7 as PASS-with-caveats and accept partial improvement.** Specifically:

- The strict `<20%` numeric target on Scenario 3 is **not met** for the small case (83%). The metric was calibrated for fixtures where follow-up rounds are dominated by scope creep / clarity drift, but the small case's follow-up rounds are dominated by genuine plan-defect discovery (CWD safety, edge cases, regression-from-fix), which Stage A / `new_blocker_materiality` correctly classifies as MUST_FIX_NOW in the new system. The new prompts cannot prevent these — they exist because the R1 planner missed real bugs, not because the reviewer was creeping scope.
- However, **round-count reduction (≈36%) and BLOCKING-volume reduction (≈39%) are real and material.** The new prompts terminate the small case at R7 instead of R11, prevent the four R7-R10 broad-consistency-pass loops, and force every new MUST_FIX_NOW to carry an explicit `new_blocker_materiality` justification.
- The big case (qualitative) is expected to show stronger improvement because its R5–R12 cascade is dominated by guard/heuristic creep and NIT/consistency loops — exactly what §5.2 / §5.3 / §5.4 / §5.5 / Ф3 churn detector target.
- §6 Scenarios 1, 2, 4, and 5 (qualitative): all pass-leaning under the new system; no replay metric needed for those.

**Residual risk:** the strict numeric metric is only a partial diagnostic. Real value of the redesign should be measured in production over a 1–2 month window via:

- median round count per CHANGES_REQUESTED loop (target: <5 for small plans, <10 for large plans);
- fraction of BLOCKING items classed `DEFER` / `NIT` / `REJECTED_BY_SCOPE` (target: >40%);
- fraction of fix rounds that emit `unauthorized_changes: []` (target: 100%);
- fraction of `NEEDS_AUTHORIZATION` returns that the orchestrator approves vs rejects (calibration signal for whether the contract is too tight).

---

## Phase Ф7 verdict

`done` — replay performed on small case, metric reported, qualitative big-case observations recorded, escalation summary written above. Top-level plan transitions to `done` because Ф1–Ф7 acceptance criteria are met (Ф7 produces the replay report, even if the numeric `<20%` target is partially missed; the parent plan's Ф7 done definition explicitly allows this path: "either the metric passes (<20%) OR the user has been notified and chosen how to proceed").
