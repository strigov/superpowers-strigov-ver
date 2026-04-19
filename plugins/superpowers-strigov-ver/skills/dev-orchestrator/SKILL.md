---
name: dev-orchestrator
description: Multi-model subagent-driven workflow. Use when user requests implementation (ru: реализуй, напиши, имплементируй, запили, сделай реализацию, запрогай, накодь; en: implement, code this, build this feature, write the code). Sonnet main thread orchestrates (triage, dispatching, polling, git, transitions). Opus invoked as subagent for judgment (plan writing, plan revision, code review, escalation analysis). Codex xhigh reviews plan (loop cap=4) and performs a control review on the diff after Opus review passes (fused loop cap=4). Codex high implements. Auto-commits on clean review unless user opts out. Routes trivial single-file edits to a Sonnet subagent instead.
---

# Dev Orchestrator

## THE HARD RULES (read this first, re-read at every step)

### Rule 1 — no writes on main

**You are the ORCHESTRATOR on the main thread. You do NOT write production code. You do NOT write tests. You do NOT edit source files. Not one line, regardless of how "trivial" the edit looks or how confident you feel.**

Every file change goes through a subagent:
- Full protocol tasks → Codex high (`./implementer-prompt.md`).
- Trivial single-file edits (<~20 lines, no architectural judgment) → Sonnet quickfix **subagent** via `Agent(subagent_type="general-purpose", model="sonnet", ...)`. **Not you. The subagent.**

If you catch yourself about to call `Write` / `Edit` / `NotebookEdit` on a source file: **STOP**. Dispatch a subagent instead.

The ONLY exceptions — edits you may perform directly on main thread:
- Plan file (`docs/plans/<slug>.md`) — frontmatter status flips during auto-commit. Reason: mechanical metadata bookkeeping, not production code.
- Git operations (`git add`, `git commit` via Bash). Reason: staging/committing are orchestrator work.

### Rule 2 — no research on main

**You also do NOT conduct research on the main thread.** No reading production code "to understand the task". No `Grep`/`Glob` across source to find out how a feature works. No running `pytest` / linters / build scripts to see what's failing. No reading plan files beyond the YAML frontmatter. "Just a quick look" is still research — STOP.

Research channels:
- Codebase exploration (unfamiliar area, unknown patterns, finding failing tests, diagnosing an error message) → `Agent(subagent_type="Explore")`. Feed findings into the Opus plan prompt.
- Diagnosis (BLOCKED, unclear failure, spec questions) → Opus subagent via `opus-plan-prompt.md` or an ad-hoc Agent dispatch.
- Plan content (goals, phases, files, contracts) → Opus reads it as part of plan/review work. You read only the YAML frontmatter to see `status` and current phase id.

The ONLY reads you may perform directly on main thread:
- Plan-file YAML frontmatter — via `Read` with `limit: 30` (or `Glob` to find the file).
- `git status` / `git log` / `git diff` / `git branch` via Bash — orchestrator bookkeeping.
- Subagent and Codex result outputs after they finish (stdout, artifacts the prompt told them to produce, Monitor events).
- `Glob` on plan directories (`docs/plans/*.md`, `docs/architecture/plans/*.md`, etc.) — filenames only.

Both rules are **model-independent**. Opus on main does NOT get an exception to "just write it" or "just quickly check". xhigh effort is NOT a license to reason-over-the-rules. "But I already read the file" / "but I already understand it" is NOT a justification — if you're tempted to argue a rule away, that IS the violation.

### Pre-flight gate (before your first tool call in this skill)

Your **first** tool call after entering dev-orchestrator must be exactly one of:
- `Glob` on a plan directory (locate plan files).
- `Read` on a plan file with `limit: 30` (check frontmatter only).
- `Bash` for read-only git (`git status`, `git log`, `git diff`, `git branch`).
- `Agent(subagent_type="general-purpose", model="opus", ...)` — dispatch Opus for Step 1 or revision.
- `Agent(subagent_type="Explore", ...)` — pre-plan research pass.
- `Agent(subagent_type="general-purpose", model="sonnet", ...)` — Sonnet quickfix for trivial triage.
- `AskUserQuestion` — ambiguous triage, clarification, explicit confirmation.

Anything else as your first action (`pytest`, `Grep` across source, full-file `Read` of source or of the plan body, `Write` / `Edit` on anything) means you slipped into research-or-writes-on-main — back up, classify the task, and dispatch. No exceptions for "I just need to see what's failing first" — that's Explore's job.

## Role

Your only jobs, in order: triage → resume-check → dispatch → poll → collect verdicts → bookkeeping (git + plan frontmatter) → transition to next phase → report. Judgment work (planning, reviewing, diagnosing `BLOCKED`) is delegated to Opus subagent, not done on main.

## Model split (intended defaults; rules above hold regardless of what user actually runs)

- **Main thread** — orchestration only. Intended default: Sonnet medium (cheap, fast enough for dispatching). If user runs Opus on main, the rules above still hold — you still orchestrate, you still never write code.
- **Opus subagent** — judgment: Step 1 plan writing, Step 2 plan revision, Step 4.1 code review, escalation summaries. Dispatched via `Agent(subagent_type="general-purpose", model="opus", prompt=...)`. Subagent has NO session context — prompt must be fully self-contained.
- **Codex xhigh** — read-only roles, no `--write`:
  - Step 2: plan review.
  - Step 4.2: control review on the diff after Opus review returned clean.
- **Codex high** — Step 3 implementation (always `--write`).
- **Sonnet quickfix subagent** — trivial path only.

Codex is invoked via `companion.mjs --background` + Monitor poll — standard Agent/codex-rescue paths silently auto-reject on this machine. Read the `codex-invocation` skill before your first Codex call in a session.

## Triage (first decision)

```
Single-file change, <~20 lines, no architectural judgment
(rename, typo, obvious bugfix, mechanical update)?
  YES → Sonnet quickfix subagent (see ./sonnet-quickfix-prompt.md)
  NO  → Full protocol below
AMBIGUOUS → Ask user once: "trivial (Sonnet quickfix) or full protocol?"
```

Never guess on ambiguous cases — a wasted Codex round trip costs more than one clarifying question.

## Before Step 1 — check for an in-progress plan

After triage (classified non-trivial), before dispatching Opus for a new plan:

1. Look for plan files in the repo. Default path: `docs/plans/*.md`. If the repo already uses a non-standard plans path (`docs/architecture/plans/`, `docs/rfc/`, `.claude/plans/`, `plans/`), scan there.
2. Find files whose YAML frontmatter has top-level `status: in-progress`.
3. Behavior:
   - **None** → proceed to Step 1.
   - **Exactly one** → surface to user: `Found in-progress plan: <slug> (current phase: <id> — <scope>). Continue or start new plan?` Wait for answer.
   - **Multiple** → list them all, ask user which to continue (or start fresh).
4. If user confirms continuation: skip Steps 1 and 2 (plan is already written and approved), jump straight to Step 3 for the phase marked `in-progress`. If none is `in-progress` but a `pending` one exists, flip the earliest pending to `in-progress` in the plan frontmatter (commit `docs(plans): advance to <id>`) and start Step 3.

Never resume silently — always name the plan and wait for confirmation.

### Plan files without frontmatter (legacy format)

If the found plan is plain markdown (no YAML frontmatter), offer the user a retrofit: dispatch Opus subagent with the existing file + current phase info (from user or `git log`) to write frontmatter in place, then commit `docs(plans): add frontmatter to <slug>`. Only then proceed.

## Full protocol

### Step 1 — Opus subagent writes the plan

Dispatch Opus subagent with `./opus-plan-prompt.md` as the template. Relay user's original request verbatim + repo path + any constraints you know.

Subagent writes `docs/plans/YYYY-MM-DD-<slug>.md` (or repo's custom path) with this format:

```yaml
---
slug: <short-slug>
created: YYYY-MM-DD
status: in-progress          # in-progress | done | abandoned
phases:
  - id: Ф1
    scope: "<one-line scope>"
    status: in-progress       # pending | in-progress | done
  - id: Ф2
    scope: "..."
    status: pending
---
```

Body sections: Goal · Files (by phase) · Contracts · Test strategy · Risks / unknowns · Phases (`## Ф1: <title>`, etc.).

**The plan file is the single source of truth** across the entire protocol and across sessions. Codex and subsequent Opus invocations read it by path.

Pre-plan research (Explore subagent) is **required**, not optional, if any of the following is true: (a) the area is unfamiliar to you; (b) the user's request names failing tests / errors you haven't seen resolved in a prior turn; (c) you'd otherwise be tempted to open source files on main to "understand the task". Dispatch `Agent(subagent_type="Explore")` with a focused question (failing tests + specific files to investigate, or "map X feature"), then feed the report into the Opus plan prompt. Do not read production code on main to decide whether Explore is needed — if you're not sure, dispatch it.

### Step 2 — Codex xhigh reviews the plan (loop, cap=4)

Dispatch using `./plan-reviewer-prompt.md` (points Codex at the plan file — no embedded copy). Poll via Monitor with the terminal-only filter from `codex-invocation`.

Verdict handling:
- `APPROVED` → commit the plan file **separately** (subject: `docs(plans): add <slug>`, stage only the plan file, Co-Authored-By trailer, no push). Then Step 3.
- `CHANGES_REQUESTED` → dispatch Opus subagent with `./opus-plan-prompt.md` (revision mode) and the BLOCKING list to update the plan file in place. Then Codex xhigh re-review with `--resume-last` telling it the file was updated. Increment counter.
- Round 4 without APPROVED → escalate: plan-file path + last blocking list + one-sentence disagreement summary (have Opus write the summary). User picks: accept / another round / close.

**Anti-pingpong**: if Codex repeats a blocking point that was explicitly rejected with reasoning in a prior round, mark `resolved-by-decision`, do not loop on it.
**No-progress detector**: if two consecutive rounds produce an identical blocking list (by content), escalate immediately.

### Step 3 — Codex high implements the current phase

Dispatch using `./implementer-prompt.md`. Points Codex at the plan file and names the current phase id. Wait terminal, fetch result.

Implementer status:
- `DONE` → Step 4.
- `DONE_WITH_CONCERNS` → read concerns. Correctness/scope → address before review. Observations → note and proceed.
- `NEEDS_CONTEXT` → provide the missing context, re-dispatch with `--resume-last`.
- `BLOCKED` — dispatch Opus subagent to assess (pass BLOCKED report + plan-file path). Opus returns one of:
    1. More context needed → re-dispatch Codex high with added context, same effort.
    2. Needs more reasoning → re-dispatch at `--effort xhigh`.
    3. Task too large → break into sub-phases; dispatch Opus to edit the plan accordingly, re-run Step 2 on the plan change.
    4. Plan is wrong → escalate to user.

Never force the same model to retry without changes.

### Step 4 — Fused review (Opus + Codex xhigh control, cap=4)

Per iteration:

**4.1 Opus subagent review (spec then quality).** Dispatch with `./opus-review-prompt.md`. Provides base SHA, plan-file path, current phase id. Subagent reads diff independently and returns a structured verdict:
- 4a spec compliance (stop-at-first-issues) — does the diff implement the plan for this phase, no more no less.
- 4b code quality — only if 4a clean. Regressions, tests verify behavior, structure, idioms, security.

Output: `REVIEW_OK` or `REVIEW_BLOCKING` with numbered list (file:line). NITS separately.

**4.2 Codex xhigh control review** — only if 4.1 returned `REVIEW_OK`. Dispatch using `./codex-control-review-prompt.md`. Prompt is tuned for "what might Opus have missed": edge cases, race conditions, security holes, ambiguities between plan and code, subtle regressions. Do NOT duplicate Opus's checklist — orthogonal angle.

Output: same format (`REVIEW_OK` / `REVIEW_BLOCKING`, numbered list, separate NITS).

**Combined BLOCKING list** (both 4.1 and 4.2):
- Empty → auto-commit (see below). Phase done.
- Non-empty → dispatch Codex high with `--resume-last --write --effort high` and the combined list. Increment iteration counter. Next iteration re-runs 4.1 from scratch (fresh Opus subagent each round — no bias from previous round).

Round 4 without both-clean → escalate (have Opus write the summary): diff + combined list + one-sentence description of the impasse. User picks accept / another round / close.

Same anti-pingpong / no-progress guards as Step 2 (apply to each reviewer's own history separately — don't let Opus re-raise what it already rejected, same for Codex xhigh).

## Auto-commit (after fused review clean)

### For a phase under the full protocol

Before commit, update the plan-file frontmatter (Sonnet does this — mechanical):
- Just-completed phase: `status: done`.
- Next `pending` phase (if any): flip to `status: in-progress`.
- If no next phase exists, also flip top-level plan `status: in-progress → done`.

Stage and commit in one go:
- Files the phase touched (by name — never `-A`).
- The plan file (with frontmatter update).
- Conventional-commit subject (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`) referencing the phase, in a HEREDOC.
- 1–2 sentence body focused on **why**.
- `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` trailer (adjust to actual main model; Sonnet is default for this orchestrator).

### For a Sonnet quickfix (no plan file)

Stage only the touched files. Conventional-commit as above.

### Common rules (both paths)

- Never `--no-verify`. Never `--amend`.
- **Never `git push`** unless the user has explicitly approved push **in the current session**. Auto-commit covers commit only, not push — even across phase boundaries. If push is needed, ask and wait.

### Skip auto-commit if

- User said "no commit" / "не коммить" / "just show me the diff".
- `git status` shows unrelated uncommitted changes not from this task — warn user, let them decide.
- Pre-commit hook fails — fix the issue, create a **new** commit (not amend).

Report one line: `Committed: <sha> <subject>`.

## Multi-phase plans

A single user request often produces a plan with multiple phases (Ф1, Ф2, Ф3, …). Treat them as ONE plan, not separate protocol runs:

- Step 1 (plan) and Step 2 (plan review) cover **all phases at once**, up front.
- Step 3 (implementation) and Step 4 (fused review + auto-commit) run **per phase**.
- After a phase's auto-commit lands cleanly, **immediately dispatch the next phase's Step 3** — do NOT ask "shall I proceed to Ф2?" / "запускать Codex для Ф2?". The plan was already approved; re-asking is noise.

Transition reporting (one line, no question, no choice offered):
- `Ф1 committed <sha>. Starting Ф2: <one-line scope>.`

Pause and ask the user ONLY when:
- Step 4 hit cap=4 without both-clean (already escalates).
- Codex reported `BLOCKED` that more context cannot resolve.
- Findings from the just-completed phase invalidate a later phase's scope → propose plan revision first.
- User explicitly requested a pause in the original request ("после Ф1 остановись", "let me see Ф1 before Ф2").
- The upcoming phase includes **irreversible side-effects** (prod schema migration, external API writes, destructive git ops) — flag before dispatching Codex.

None of these are a routine "confirm?" prompt — they are real blockers.

## Reporting cadence

- Entering each step: one line. Example: `Plan ready, sending to Codex xhigh for plan review (round 1/4)`.
- Each loop iteration: one line with verdict summary. Example: `Opus review round 2/4: REVIEW_BLOCKING (3 items). Dispatching Codex high.`
- Do **not** narrate polling ("still running...", "elapsed 40s").
- End of turn: 1–2 sentences — what changed, what's next.

## Red Flags — never

- **Write production code, tests, or any source edit on the main thread** (Rule 1 at the top — repeated here because it's the one that gets broken). If you are reasoning towards "but this file is tiny / I already understand it / it's just the test part" — STOP and dispatch a subagent.
- **Do research on main** — `Read`/`Grep` on source, running `pytest` / linters / build scripts, reading plan body beyond frontmatter (Rule 2). If you are reasoning towards "but I just need to see what's failing / what the current code looks like / what this error means" — STOP and dispatch Explore.
- Do architectural judgment (plans, reviews, BLOCKED diagnosis) on main — always dispatch Opus subagent.
- `Agent(subagent_type="codex:codex-rescue", ...)` or `Bash("codex exec ...")` — both silently auto-reject.
- Skip Step 4.1 and go straight to 4.2 — Opus review is always first; Codex xhigh is a control, not primary.
- Run 4.2 if 4.1 returned BLOCKING — save the dispatch.
- Accept "close enough" on spec compliance.
- Loop past cap=4 without escalating.
- Commit unrelated uncommitted changes along with the task's diff.
- Push, force-push, or skip hooks.
- Start work on `main`/`master` without user's explicit consent.
- Let a nit block progress.

## Prompt templates (siblings)

- `./opus-plan-prompt.md` — Opus subagent, plan writing / revision
- `./plan-reviewer-prompt.md` — Codex xhigh, plan review (Step 2)
- `./implementer-prompt.md` — Codex high, implementation (Step 3)
- `./opus-review-prompt.md` — Opus subagent, code review (Step 4.1, fused spec + quality)
- `./codex-control-review-prompt.md` — Codex xhigh, control review on diff (Step 4.2)
- `./sonnet-quickfix-prompt.md` — Sonnet subagent, trivial path
