---
name: requesting-code-review
description: Use when completing tasks, implementing major features, or before merging to verify work meets requirements
---

# Requesting Code Review

Dispatch an Opus subagent to review code changes. The reviewer gets precisely crafted context for evaluation — never your session's history. This keeps the reviewer focused on the work product, not your thought process, and preserves your own context for continued work.

**Core principle:** Review early, review often. Code review is judgment work — always run it on Opus.

## When to Request Review

**Mandatory:**
- After each task in subagent-driven development
- After completing major feature
- Before merge to main

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug

## How to Request

**1. Get git SHAs:**
```bash
BASE_SHA=<the SHA you recorded before the task started>  # or: $(git merge-base origin/main HEAD)
HEAD_SHA=$(git rev-parse HEAD)
```

Never `HEAD~1` as BASE for multi-commit work — it silently drops all but the last commit of a multi-commit task. If you did not record the task's starting SHA, use the merge-base with the mainline, not a fixed number of parents.

**Optionally, pre-build a review package** so the reviewer reads one file instead of re-running git. Resolve the script the same way `codex-invocation` resolves `$DISPATCH`:

```bash
PKG="$(command -v review-package || true)"
[ -z "$PKG" ] && PKG="$(ls -1d ~/.claude/plugins/cache/strigov-cc-plugins/superpowers-strigov-ver/*/bin/review-package 2>/dev/null | sort -rV | head -1)"
[ -z "$PKG" ] && PKG="$(pwd)/bin/review-package"
"$PKG" "$BASE_SHA" "$HEAD_SHA"   # prints: wrote <path>: N commit(s), M bytes
```

Pass the printed path as `{DIFF_FILE}`. Only the `wrote ...` line enters your context — never read the package yourself.

**2. Dispatch Opus subagent:**

Read the template at `./code-reviewer.md`, fill the placeholders, then dispatch:

```
Agent(
  subagent_type="general-purpose",
  model="opus",
  description="Code review: <short scope>",
  prompt=<filled template>
)
```

**Placeholders:**
- `{WHAT_WAS_IMPLEMENTED}` - What you just built
- `{PLAN_OR_REQUIREMENTS}` - What it should do
- `{BASE_SHA}` - Starting commit
- `{HEAD_SHA}` - Ending commit
- `{DIFF_FILE}` - Review package path printed by `review-package` (optional; fill with `none` if you didn't build one — the reviewer then fetches the diff itself)
- `{DESCRIPTION}` - Brief summary

The subagent has no session context — the filled template is all it sees.

**3. Act on Opus feedback:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

**4. Fused review: Codex xhigh control review**

When Opus returns a clean verdict (no Critical/Important issues), dispatch a Codex xhigh control review for an orthogonal second opinion — the same fused-review pattern dev-orchestrator uses in Step 4.

**Skip Codex control review only when:**
- Trivial diff (single typo, <5 lines, no logic change).
- Already running under `dev-orchestrator` (it runs Step 4.2 automatically — don't double up).

**Dispatch:**

Reuse the template at `../dev-orchestrator/codex-control-review-prompt.md`. Adapt the "Phase context" block for standalone use:
- Replace "Plan file" with `{PLAN_OR_REQUIREMENTS}` content (paste it verbatim, not a path).
- Drop "Current phase id".
- Keep "Base commit" = `{BASE_SHA}`. Fill "Review package" with the `review-package` path (`{DIFF_FILE}`); if you built none (`DIFF_FILE: none`), keep the template's fallback in place — the reviewer fetches the diff itself with `git diff --stat <base-sha>` / `git diff -U10 <base-sha>`.
- Fill `[GLOBAL_CONSTRAINTS]` with the project-wide constraints stated in `{PLAN_OR_REQUIREMENTS}`, or literally `None declared` if there are none.
- Fill "Implementer report:" with `none — standalone review` and "Verify additionally" with `none`.
- Ledger references (`AUTHORIZED_CHANGE_LEDGER`, `docs/plans/<slug>.ledger.json`): no ledger exists in standalone use — delete those sentences from the filled prompt.

Invocation is read-only (`--effort xhigh`, no `--write`). Poll via Monitor per `codex-invocation` skill.

**Combined verdict handling (same loop as dev-orchestrator Step 4, cap=4):**

- Both clean → proceed to implementation order.
- Either has BLOCKING → collect combined list (Opus + Codex BLOCKING), fix, then re-dispatch **both** reviewers in a fresh round. Codex rounds 2+ are FRESH tasks using the template's own follow-up section — no `--resume-task` (matches the template's round-2+ rule; adapt its ledger references away as above).
- Round 4 without both-clean → escalate: combined list + one-sentence impasse summary. User picks accept / another round / close.

Anti-pingpong: don't let either reviewer re-raise an item the other side explicitly rejected with reasoning. No-progress: if two consecutive rounds produce identical combined BLOCKING — escalate.

## Example

```
[Just completed Task 2: Add verification function]

You: Let me request code review before proceeding.

BASE_SHA=$(git log --oneline | grep "Task 1" | head -1 | awk '{print $1}')
HEAD_SHA=$(git rev-parse HEAD)

[Dispatch Opus subagent via Agent(subagent_type="general-purpose", model="opus", ...)]
  WHAT_WAS_IMPLEMENTED: Verification and repair functions for conversation index
  PLAN_OR_REQUIREMENTS: Task 2 from docs/superpowers/plans/deployment-plan.md
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661
  DIFF_FILE: none
  DESCRIPTION: Added verifyIndex() and repairIndex() with 4 issue types

[Subagent returns]:
  Strengths: Clean architecture, real tests
  Issues:
    Important: Missing progress indicators
    Minor: Magic number (100) for reporting interval
  Assessment: Ready to proceed

You: [Fix progress indicators]
[Continue to Task 3]
```

## Integration with Workflows

**Subagent-Driven Development:**
- Review after EACH task
- Catch issues before they compound
- Fix before moving to next task

**Executing Plans:**
- Review after each batch (3 tasks)
- Get feedback, apply, continue

**Ad-Hoc Development:**
- Review before merge
- Review when stuck

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback

**If reviewer wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification

See template at: `./code-reviewer.md` (same directory as this SKILL.md).
