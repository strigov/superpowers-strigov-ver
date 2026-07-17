# Opus Subagent — Final Whole-Branch Review (Step 5)

Use AFTER the last phase has passed Step 4 and been committed, BEFORE plan archival. This is the single broad merge review of the entire branch — every phase already passed its phase-scoped gate (Step 4); this review checks what those gates cannot see: cross-phase integration, whole-branch architecture, and merge readiness. Codex control review does NOT participate in Step 5. Loop cap=2: round 1 review → ONE fixer → round 2 re-review; still blocking after round 2 → escalate to the user. Fresh subagent each round (no bias from the previous round).

## Invocation

```
Agent tool:
  subagent_type: "general-purpose"
  model: "opus"
  description: "Final review <slug>"
  prompt: |
    <prompt below>
```

**The prompt's literal first line MUST be `ultrathink`** — it runs Opus at max thinking effort. The template below already starts with it; keep it first.

Before dispatching, build the whole-branch review package with `bin/review-package` (resolve it the same way as `$DISPATCH` per SKILL.md; only the printed path enters your context, never the diff):

- **Round 1:** `review-package <MERGE_BASE> HEAD "$(sdd-workspace <plan-file>)/review-final-r1-<base7>.diff"` — MERGE_BASE comes from `git merge-base main HEAD`; if there is no `main` branch (the command errors) or it returns HEAD itself (work ran directly on the mainline), fall back to the recorded base7 of the plan's first phase (frontmatter `commits:`). Pass the OUTFILE explicitly — the range-mode default would land in the shared `.superpowers/sdd/` root, not the plan-scoped workspace.
- **Round 2** (the fixer's changes are uncommitted): `review-package <MERGE_BASE> WORKTREE "$(sdd-workspace <plan-file>)/review-final-r2-<base7>.diff"` — OUTFILE is mandatory in WORKTREE mode.

Never build the package from `HEAD~1` — MERGE_BASE is the recorded branch start; anything else silently drops earlier phases from the review.

## Prompt template

```
ultrathink

You are the final whole-branch review stage of dev-orchestrator (Step 5). You are a fresh Opus subagent with no context from the per-phase reviews — treat the branch skeptically and verify independently. This is a merge review of the ENTIRE branch, not a phase gate: do not re-run the per-phase checklists; your job is the whole.

## Branch context

- Working directory / repo root: `<absolute path>`
- Plan file (authoritative): `<absolute path>` — read the YAML frontmatter, `## Goal`, `## Acceptance criteria`, `## Non-goals / deferred`, `## Contracts`, and every `## Ф<n>:` phase section
- Merge base (branch start): `<merge-base-sha>`
- Head: `<head-sha>` (round 2: uncommitted working tree — orchestrator will tell you)
- Review package (REQUIRED): `[DIFF_FILE]` — the whole-branch diff MERGE_BASE..HEAD written by `review-package`: commit list + stat + full diff
- Change ledger: `<repo-root>/docs/plans/<slug>.ledger.json` — accumulated findings from all phase-review rounds; you triage its open DEFER / NIT items below

Read the plan file and the ledger first. Then read `[DIFF_FILE]` in ONE Read call — it contains the commit list, a stat summary, and the full diff with surrounding context. The diff's context lines ARE the changed files: do not Read a changed file separately unless a hunk you must judge is cut off mid-function — and say so in your report. Do not re-derive the diff with git commands. If the package file is missing, fetch the diff yourself: `git log --oneline <merge-base-sha>..<head-sha>`, `git diff --stat <merge-base-sha>..<head-sha>`, `git diff -U10 <merge-base-sha>..<head-sha>`.

Unlike a phase gate, inspecting code OUTSIDE the diff is legitimate here — that is how you verify integration and architecture — but tie each excursion to a numbered check below, and name what you checked in your report.

## Read-only review

Your review is read-only on this checkout. Do not mutate the working tree, the index, HEAD, or branch state in any way. Use tools like `git show`, `git diff`, and `git log` to inspect history. If you need a working copy of a different revision, check it out into a separate temporary directory (e.g. `git worktree add /tmp/review-[SHA] [SHA]`) — never move HEAD on this checkout.

## Merge-level checks (run ALL, in order — do not stop at the first failure)

1. **Whole-branch architecture** — sound design across all phases taken together? Duplicate mechanisms introduced by different phases (two config readers, two error-wrapping helpers)? Abstractions layered inconsistently between phases? Integrates cleanly with pre-existing code?
2. **Cross-phase consistency** — for every contract between phases (the plan's `## Contracts` section and any per-phase Consumes/Produces declarations, Ф-n ↔ Ф-m): verify the produced artifact/API and the consuming call site actually match — names, types, shapes, error semantics. Cite `file:line` for each contract you checked.
3. **Plan completeness** — every item in `## Acceptance criteria` is observable in the final tree; nothing planned was dropped or overwritten by later-phase rework; unexplained deviations from the plan are findings.
4. **Security** — across the branch as a whole: no secrets in code/logs/fixtures; no command injection, path traversal, SSRF, SQL injection; external inputs validated at trust boundaries; auth/permission checks present on new surfaces.
5. **Production readiness** — migration strategy if schema changed; backward compatibility of stored data and existing public contracts (log formats, CLI output, HTTP codes, event shapes); documentation the plan requires; no leftover debug output, dead flags, placeholder TODOs.
6. **Full test suite + typecheck** — run the repo's FULL test suite and typecheck/linter and record the outputs. This is the ONLY point in the workflow where a full-suite run is mandatory (phase reviews after round 1 run focused tests only), so this run is the merge gate's safety net. Run it in EVERY Step 5 round — round 2 reviews code that changed after round 1's run. Skip only if the repo has no such tooling (say so explicitly).
7. **Ready to merge?** — the final judgment that feeds the verdict token and the last line of your report.

## Ledger triage

The ledger accumulated DEFER / NIT items from every phase round that were deliberately left unfixed at phase time (those are the only deferred `decision` values the ledger schema has). Triage EVERY such open item — one line each:

- `MUST_FIX_BEFORE_MERGE` — the item, seen at whole-branch level, clears the high-materiality bar (data loss/corruption, security/trust-boundary failure, guaranteed build/test/runtime failure, regression of an existing public contract, broken cross-phase contract), or several deferred items compound into one of these.
- `STAYS_DEFERRED` — everything else; it ships and remains on the follow-up list.

Do not re-raise items with decision `REJECTED_BY_SCOPE` or `ESCALATED_TO_HUMAN`, or items already marked fixed — those are settled.

## Calibration

- Block only on material, current impact: the high-materiality bar above, or a failed Acceptance criterion. Polish and "coverage could be broader" are NITS.
- If the branch faithfully implements something the plan's text explicitly mandates but this rubric treats as a defect, report it as a BLOCKING item labeled `plan-mandated` — the orchestrator escalates it to the human instead of dispatching a fix.
- Issues must cite `file:line`.

## Output format (strict)

Line 1 must be exactly the bare token `REVIEW_OK` or `REVIEW_BLOCKING` — no preamble, no markdown heading, no bold. `REVIEW_BLOCKING` if and only if the BLOCKING list is non-empty OR any ledger item is triaged `MUST_FIX_BEFORE_MERGE` (a failed suite or typecheck is itself a BLOCKING item).

After line 1, always emit all four sections:

```
BLOCKING:
1. <issue> — <file:line> — <what to change>   (append the label `plan-mandated` where it applies)
2. ...
(or "BLOCKING: none")

LEDGER_TRIAGE:
- <ledger id>: MUST_FIX_BEFORE_MERGE — <one line: why it cannot ship as-is>
- <ledger id>: STAYS_DEFERRED — <one line: why it can wait>
(one line per open DEFER/NIT item — cover them all; "LEDGER_TRIAGE: no open items" if the ledger has none)

NITS:
- <nit> — <file:line or scope> (informational — do NOT trigger another round)

Verification run:
- <command>: <pass/fail + brief output>

Ready to merge: <yes | no> — <1-2 sentence technical reasoning>
```

## Round 2 (re-review after the fix wave)

You are a fresh subagent; the orchestrator inlines the fix list from round 1 (BLOCKING items + MUST_FIX_BEFORE_MERGE ledger items). First verify each item on that list is closed correctly in the new package. Then check the fix delta for new problems and re-run check 6 (full suite + typecheck). Do NOT promote latent pre-existing issues to BLOCKING unless they clear the high-materiality bar or were introduced by the fixes — they belong in NITS.

## Discipline

- Read the diff yourself. Do not trust phase-review verdicts or commit messages — they cleared phases, not the merge.
- Do not fix code yourself. You are reviewing, not implementing.
- Do not rewrite this checklist into the report — stick to findings.
```

## After the verdict (orchestrator)

`REVIEW_OK` → proceed to plan archival. `REVIEW_BLOCKING` → record the findings in the ledger (ids `FR<round>-B<n>`, reviewer `opus-final`), then dispatch ONE fixer — a single Codex Luna max FRESH task (`--write --model gpt-5.6-luna --effort max`; no resume — the whole-plan fix wave has no single implementer thread) — with the COMPLETE findings list (all BLOCKING items plus all MUST_FIX_BEFORE_MERGE ledger items; items labeled `plan-mandated` are excluded — those are escalated to the human, never handed to a fixer), not one fixer per finding. Per-finding fixers each rebuild context and re-run suites; a real session's final-review fix wave cost more than all its tasks combined.
