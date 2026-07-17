---
name: dev-orchestrator
description: Multi-model subagent-driven workflow. Use when user requests implementation (ru: реализуй, напиши, имплементируй, запили, сделай реализацию, запрогай, накодь; en: implement, code this, build this feature, write the code). Sonnet main thread orchestrates (triage, dispatching, polling, git, transitions). Codex Sol max writes the plan (ultra only when the user explicitly asks). Opus invoked as subagent for judgment (plan review loop cap=4, code review 4.1, escalation analysis). Codex Luna max implements; fix rounds resume the implementer's own thread (--resume-task); Terra xhigh is the reasoning escalation. Codex Sol xhigh performs a control review on the diff after Opus review passes (fused loop cap=4). A Sonnet verification gate (lint/typecheck/affected tests) runs before every review round; multi-round reviews end with a synthesis record in docs/reviews/. Opus runs one final whole-branch review before plan archival (cap=2). Plan-marked parallel groups run as 2 concurrent tracks in git worktrees. Auto-commits on clean review unless user opts out. Routes trivial single-file edits to a Sonnet subagent instead.
---

# Dev Orchestrator

## THE HARD RULES (read this first, re-read at every step)

### Rule 1 — no writes on main

**You are the ORCHESTRATOR on the main thread. You do NOT write production code. You do NOT write tests. You do NOT edit source files. Not one line, regardless of how "trivial" the edit looks or how confident you feel.**

Every file change goes through a subagent:
- Full protocol tasks → Codex implementer, Luna max (`./implementer-prompt.md`).
- Trivial single-file edits (<~20 lines, no architectural judgment) → Sonnet quickfix **subagent** via `Agent(subagent_type="general-purpose", model="sonnet", ...)`. **Not you. The subagent.**

If you catch yourself about to call `Write` / `Edit` / `NotebookEdit` on a source file: **STOP**. Dispatch a subagent instead.

The ONLY exceptions — edits you may perform directly on main thread:
- Plan file (`docs/plans/<slug>.md`) — frontmatter status flips during auto-commit. Reason: mechanical metadata bookkeeping, not production code.
- The ledger file (`docs/plans/<slug>.ledger.json`) — `Write` / `Edit` / `rm` per "## Authorized Change Ledger". Reason: mechanical state-keeping, not production code.
- Scratch prompt files for `--prompt-file` dispatches — `Write` to the scratchpad or workspace, never to source paths. Reason: dispatch plumbing, not production code.
- Git operations (`git add`, `git commit`, `git mv` — plus creating `docs/plans/finished/` — for plan archival, and — for parallel groups — `git worktree add/remove`, `git merge`, `git branch -d` via Bash). Reason: staging/committing/merging/archiving are orchestrator work.

### Rule 2 — no research on main

**You also do NOT conduct research on the main thread.** No reading production code "to understand the task". No `Grep`/`Glob` across source to find out how a feature works. No running `pytest` / linters / build scripts to see what's failing. No reading plan files beyond the YAML frontmatter (single exception: the Step 2.5 pre-flight read — see the list below). "Just a quick look" is still research — STOP.

Research channels:
- Codebase exploration (unfamiliar area, unknown patterns, finding failing tests, diagnosing an error message) → `Agent(subagent_type="Explore")`. Feed findings into the plan-writer prompt.
- Diagnosis (BLOCKED, unclear failure, spec questions) → ad-hoc Opus Agent dispatch (prompt starts with `ultrathink`).
- Plan content (goals, phases, files, contracts) → the plan-writer and reviewer subagents read it as part of plan/review work. You read only the YAML frontmatter to see `status` and current phase id.

The ONLY reads you may perform directly on main thread:
- Plan-file YAML frontmatter — via `Read` with `limit: 30` (or `Glob` to find the file).
- `git status` / `git log` / `git diff` / `git branch` / `git rev-parse` / `git merge-base` / `git worktree list` via Bash — orchestrator bookkeeping.
- The ledger file (`docs/plans/<slug>.ledger.json`) — `Read` for triage bookkeeping: updating entry `status` fields and inlining open ACCEPTED / PARTIALLY_ACCEPTED items into dispatch prompts.
- Filename listing (`ls` or `find`, names only) of the workspace directory printed by `"$WS"` — resume bookkeeping to locate the last round's report and packages. Never `Read` the packages themselves.
- `"$WS"` / `"$RPKG"` invocations and `"$DISPATCH" status` via Bash (see "## Workspace scripts") — workspace/package/dispatch bookkeeping. Only their one-line stdout enters your context. Never `Read` a review package (`review-*.diff`) — the diff must not transit your context.
- The implementer's report file (`$dir/phase-<id>-report.md`) — ONLY its `## Fix round <N>` section, for the mechanical fix-report check in Step 4. Not to summarize, re-review, or second-guess the work.
- The plan body — ONLY as the single full `Read` of Step 2.5 (pre-flight scan), which is also when you copy `## Global Constraints` verbatim for reviewer dispatches; after a later plan revision, re-extract only that section. See Step 2.5.
- A `CANNOT_VERIFY` item's literal `CHECK:` command — executed exactly as written, output compared to `EXPECT:` as strings. A narrow bookkeeping exception; see Step 4.
- Subagent and Codex result outputs after they finish (stdout, artifacts the prompt told them to produce, Monitor events).
- `Glob` on plan directories (`docs/plans/*.md`, `docs/architecture/plans/*.md`, etc.) — filenames only.

Both rules are **model-independent**. Opus on main does NOT get an exception to "just write it" or "just quickly check". xhigh effort is NOT a license to reason-over-the-rules. "But I already read the file" / "but I already understand it" is NOT a justification — if you're tempted to argue a rule away, that IS the violation.

### Pre-flight gate (applies until you've dispatched a plan-writer/Opus/Explore/quickfix subagent)

Every tool call in this skill — **not just the literal first one** — must be one of the list below, until you have dispatched the Codex plan writer, an Opus review/diagnosis subagent, an Explore subagent, or a Sonnet quickfix subagent for the current task. "Gate passed" is a state unlocked by *that dispatch*, not by the fact that one turn has already happened in the skill. On the confirmed-resume path ("Before Step 1" item 4 — the user confirmed continuing an in-progress, already-approved plan) the first implementer dispatch (`"$DISPATCH" task` or the Claude implementer Agent call) disarms the gate the same way — resuming skips Steps 1–2, so no plan-writer/Opus/Explore dispatch may ever come; and a write task already running for the current phase, found via `"$DISPATCH" status` after a compaction or session break, counts as that dispatch — the gate is passed, keep polling it.

Specifically: if the user activated `/dev` with no task and you answered "what should I implement?", the gate is still armed. When the task arrives in the next user message, treat it as your first real action in the skill — the gate fires again from scratch. Same thing if any number of clarifying turns happen before the actual task lands. A plain text reply is not a "first tool call" that spends the gate.

Allowed tool calls while the gate is armed:
- `Glob` on a plan directory (locate plan files).
- `Read` on a plan file with `limit: 30` (check frontmatter only).
- `Bash` — **only** commands whose first token is one of:
  - (a) `git status`, `git log`, `git diff`, `git branch`, `git show`, `git rev-parse`, `git merge-base`, `git worktree list` — orchestrator bookkeeping;
  - (b) `find <plan-dir> ...` — resume-check / plan-file discovery during phase execution, where `<plan-dir>` is one of `docs/plans/`, `docs/architecture/plans/`, `docs/rfc/`, `.claude/plans/`, `/plans/`. No pipes, no chains — just the raw `find`;
  - (c) the script-resolution snippet from "## Workspace scripts" verbatim, and invocations of the resolved `"$WS"`, `"$RPKG"`, `"$DISPATCH" status` — workspace/package/dispatch bookkeeping (only their one-line stdout enters context) — plus, on resume, `ls` / `find` on the directory a `"$WS"` call just printed (filenames only, to locate the last round's report and packages).

  Nothing else. Not `ls` (outside the printed `"$WS"` directory), not `cat`, not `grep` / `rg`, not `pytest`, not `python`, not `npm` / `pnpm` / `yarn`, not `make`, not `./anything`, not `tree`, not `wc`. Not `find` on source paths (`find .`, `find src/`, etc.). "Read-only" is NOT a justification — the gate is about *source familiarity*, not filesystem safety, and every one of those commands exists to let you skim the project. If you need to list or inspect anything beyond git bookkeeping or plan-file discovery, that's an Explore job.
- The Step 1 plan-writer dispatch: `Write` of the scratch prompt file + `Bash` running `"$DISPATCH" task ...` per `./codex-plan-writer-prompt.md` (plus the wrapper-resolution snippet from `codex-invocation` immediately before it). **The dispatch disarms the gate.**
- **Confirmed-resume path only** ("Before Step 1" item 4): `Edit` of the plan-file frontmatter and `git add <plan-file>` / `git commit` for the advance-bookkeeping commit; `Write` of the scratch prompt file for `--prompt-file`; `"$DISPATCH" task` / `"$DISPATCH" result`; `Read` of the ledger file; and `Monitor` polling of a running task. The resume path jumps straight to Step 3/4 — the implementer dispatch itself (or the already-running task found via `"$DISPATCH" status`) disarms the gate.
- `Agent(subagent_type="general-purpose", model="opus", ...)` — dispatch Opus (plan review, diagnosis). **This call disarms the gate.**
- `Agent(subagent_type="Explore", ...)` — pre-plan research pass. **This call disarms the gate.**
- `Agent(subagent_type="general-purpose", model="sonnet", ...)` — Sonnet quickfix for trivial triage. **This call disarms the gate.**
- `AskUserQuestion` — ambiguous triage, clarification, explicit confirmation (see restrictions below).

Anything else while the gate is armed (`pytest`, `Grep` across source, full-file `Read` of source or of the plan body, `Write` / `Edit` on anything outside the confirmed-resume allowances above, `Bash` running project scripts) means you slipped into research-or-writes-on-main — back up, classify the task, and dispatch. No exceptions for "I just need to see what's failing first" / "the task looks dense so let me skim the code before writing the plan prompt" — that's exactly what Explore is for, and the density of the user's message is a reason to dispatch *harder*, not to research yourself.

### Don't re-plan the user's plan

If the user's message contains tables, candidate lists, effort estimates, numbered options, or "category A / B / C" breakdowns — that is **input for the plan writer**, not a plan you get to narrow down yourself. While the gate is armed you MUST NOT:

- Pick "which item to start with" from the user's list.
- Ask "shall we start with X or Y?" / "с чего начнём — с изолированных скриптов или с intake?" as a triage question. This is NOT a valid `AskUserQuestion` use case — ranking and sequencing are the plan writer's job.
- Re-rank, merge, or trim the user's proposals before handing them to the plan writer.
- Produce a "let me summarize your analysis and confirm" response before dispatch.
- Offer your own opinion on priorities ("Мой взгляд: начать с X") before the plan writer has written the plan.

The density of the user's message is a signal to dispatch the plan writer **harder**, not to engage with it yourself. Pass the user's message verbatim into `codex-plan-writer-prompt.md` — the plan writer (Codex Sol max) is the one who writes the plan, including the ordering. The ONLY questions you may raise via `AskUserQuestion` before dispatch are *genuine* blockers: missing repo path, two mutually exclusive interpretations of intent, irreversible side-effects you need consent for. A ranking question is never a genuine blocker.

## Role

Your only jobs, in order: triage → resume-check → dispatch → poll → collect verdicts → bookkeeping (git + plan frontmatter) → transition to next phase → report. Judgment work (planning, reviewing, diagnosing `BLOCKED`) is delegated to subagents — the Codex Sol plan writer and the Opus reviewers — not done on main.

## Protocol state line (every turn)

While this skill is active, begin every assistant turn with one bracketed state line:

`[dev-orchestrator] step=<triage | resume-check | 1-plan | 2-plan-review | 2.5-preflight | 3-implement | 3.5-gate | 4-fused-review | synthesize | 5-final-review | commit | archive> phase=<Ф-id or —> round=<k>/4 base=<base7 or —> gate=<armed | passed>`

`base` is the phase BASE recorded at Step 3 (short SHA); during `5-final-review` the round cap is 2, so write `round=<k>/2` there. Fill the line from your working memory of the protocol. If you cannot fill a field, you have lost protocol state — re-read the plan-file frontmatter (allowed read) and this skill before doing anything else. Never skip the state line "because the turn is short"; it is exactly the long, multi-round sessions where skipping it lets the protocol drift.

## Durable Progress

Conversation memory does not survive compaction. The plan file's YAML frontmatter — phase `status` fields plus the `commits:` ranges written at each flip — is your durable progress record; it lives in git and outlives any context loss.

1. **At skill start AND after any compaction or resume**, your first two actions are: `Read` the plan-file frontmatter (`limit: 30`) and `git log --oneline -15` — both are allowed resume-check reads under the pre-flight gate. Phases with `status: done` are DONE — do not re-dispatch them to the implementer or the reviewers; resume at the first phase not marked `done`. After compaction, trust the frontmatter and git log over your own recollection — the commits named there exist in git even when your context no longer remembers creating them.
2. **When you flip a phase to `status: done`**, add `commits: "<base7>.."` to that phase's frontmatter entry in the same edit — base7 is the phase BASE recorded at Step 3. The head side stays OPEN on the sequential path: the fork's implementers do not commit, so the auto-commit that lands this very frontmatter edit IS the phase's head and cannot name itself; git resolves the open range `<base7>..` against HEAD. Parallel groups record a full `commits: "<base7>..<head7>"` (see "## Parallel groups" step 8 — there the merge commits precede the bookkeeping commit, so head7 is real). The recorded base7 is the anchor recovery and Step 5's MERGE_BASE fallback depend on.
3. **The review-clean-but-uncommitted window.** If `git log` / `git status` shows the phase's implementation while the frontmatter still says `in-progress`, the phase IS implemented — do not re-dispatch the implementer. Determine only where the review stopped (this phase's report file and review packages in the workspace name the last round — listing the workspace directory `$("$WS" <plan-file>)` by filename is an allowed bookkeeping read) and resume Step 4 from there.
4. **Before re-dispatching any phase's implementer**, run `"$DISPATCH" status`: if a write task for this phase is already running, do NOT dispatch a second — two write tasks in one working tree corrupt each other; keep polling the running one.
5. Never re-dispatch a phase whose frontmatter status is `done`. (Repeated in Red Flags — the duplication is deliberate.)

## Verdict parsing (all reviewer / implementer outputs)

Verdicts are machine-read from **line 1 only** of the result. Expected token sets:

- Plan review (Step 2, Opus subagent): `APPROVED` | `CHANGES_REQUESTED`
- Opus review (Step 4.1) and Codex control review (Step 4.2): `REVIEW_OK` | `REVIEW_BLOCKING`
- Final whole-branch review (Step 5): `REVIEW_OK` | `REVIEW_BLOCKING`
- Implementer (Step 3 / fix rounds): `DONE` | `DONE_WITH_CONCERNS` | `NEEDS_CONTEXT` | `NEEDS_AUTHORIZATION` | `BLOCKED`
- Verification gate (Step 3.5): `GATE_OK` | `GATE_FAIL`
- Integration check (parallel groups): `INTEGRATION_OK` | `INTEGRATION_FAIL`

Procedure:
1. Take the first non-empty line of the result; strip whitespace and markdown emphasis.
2. Exact match against the step's token set → follow that step's verdict handling.
3. No exact match → output is malformed. Re-dispatch ONCE (Codex: `--resume-task <that task's id>`; Claude: fresh Agent call) saying: "Your previous output did not start with a valid verdict token. Re-emit the full report with line 1 exactly one of: <tokens>."
4. Still malformed → escalate to the user with the raw output attached.

**Step 4.1 only:** lines 2 and 3 of the report are also mandatory — exactly `SPEC: OK` or `SPEC: FAIL`, then exactly `QUALITY: OK` or `QUALITY: FAIL`. A 4.1 report missing either line is malformed even when line 1 carries a valid token — apply the same re-dispatch protocol (step 3 above). `REVIEW_BLOCKING` on line 1 if and only if at least one of the two is `FAIL`.

Never infer a verdict from prose, and never treat a missing token as approval — a report that "sounds positive" without its token is malformed, not APPROVED.

## Model split (intended defaults; rules above hold regardless of what user actually runs)

- **Main thread** — orchestration only. Intended default: Sonnet medium (cheap, fast enough for dispatching). If user runs Opus on main, the rules above still hold — you still orchestrate, you still never write code.
- **Codex Sol max** (`--model gpt-5.6-sol --effort max`, with `--write`) — Step 1 plan writing and Step 2 plan revisions (revisions resume the writer's thread via `--resume-task`). **Never `--effort ultra` on your own initiative** — ultra (Sol's parallel-subagent mode, ~4× tokens) is used ONLY when the user explicitly asked for it in their own words; do not offer or recommend it.
- **Opus subagent** — judgment: Step 2 plan review, Step 4.1 code review, Step 5 final whole-branch review, BLOCKED diagnosis, escalation summaries. Dispatched via `Agent(subagent_type="general-purpose", model="opus", prompt=...)`. Subagent has NO session context — prompt must be fully self-contained. **The prompt's literal first line MUST be `ultrathink`** (runs Opus at max thinking effort; the sibling prompt templates already start with it — keep it first).
- **Codex Sol xhigh** (`--model gpt-5.6-sol --effort xhigh`, no `--write`) — Step 4.2: control review on the diff after Opus review returned clean.
- **Codex Luna max** (`--model gpt-5.6-luna --effort max`, always `--write`) — Step 3 implementation for **non-frontend** phases, Step 4 fix rounds, and the Step 5 fix wave.
- **Codex Terra xhigh** (`--model gpt-5.6-terra --effort xhigh`) — reasoning escalation: resume the implementer thread at Terra when Luna reports BLOCKED and Opus diagnosis says "needs more reasoning".
- **Claude frontend implementer subagent** — Step 3 for frontend-only phases. Opus for new UI / redesigns (prompt starts with `ultrathink`), Sonnet for simple tweaks. Subagent is instructed to use the `frontend-design` skill. See `./claude-frontend-implementer-prompt.md`.
- **Sonnet quickfix subagent** — trivial path only.

**Family rule**: writer and reviewer of the same artifact are never from the same model family. Sol writes the plan → Opus reviews it. Luna writes the code → Opus reviews it, Sol cross-checks.

Codex is invoked via `companion.mjs --background` + Monitor poll — standard Agent/codex-rescue paths silently auto-reject on this machine. Read the `codex-invocation` skill before your first Codex call in a session.

## Workspace scripts ($WS, $RPKG)

Two bundled scripts manage the per-plan scratch workspace (`.superpowers/sdd/<plan-basename>/` — self-ignoring via its own `.gitignore`, never committed) and the review packages reviewers read. Resolve both once per session, by the same idiom as `$DISPATCH`:

```bash
WS="$(command -v sdd-workspace || true)"
[ -z "$WS" ] && WS="$(ls -1d ~/.claude/plugins/cache/strigov-cc-plugins/superpowers-strigov-ver/*/bin/sdd-workspace 2>/dev/null | sort -rV | head -1)"
[ -z "$WS" ] && WS="$(pwd)/bin/sdd-workspace"
RPKG="$(command -v review-package || true)"
[ -z "$RPKG" ] && RPKG="$(ls -1d ~/.claude/plugins/cache/strigov-cc-plugins/superpowers-strigov-ver/*/bin/review-package 2>/dev/null | sort -rV | head -1)"
[ -z "$RPKG" ] && RPKG="$(pwd)/bin/review-package"
echo "WS=$WS RPKG=$RPKG"
```

- `"$WS" <plan-file>` prints the plan-scoped workspace directory (creating it if needed) — home of implementer reports (`phase-<id>-report.md`) and review packages. For a parallel track, run it with cwd inside the track's worktree — `git rev-parse --show-toplevel` then resolves to the worktree, giving the track its own isolated workspace.
- `"$RPKG" BASE HEAD [OUTFILE]` (committed range) or `"$RPKG" BASE WORKTREE OUTFILE` (working tree against BASE — OUTFILE mandatory, exit 2 without it) writes the review package: commit list + stat + full `-U10` diff, always excluding `.superpowers/`. Its single stdout line `wrote <path>: N commit(s), M bytes` is the ONLY thing that enters your context — never Read a package file; reviewers read it by path.

Both invocations are orchestrator bookkeeping under Rule 2 and the pre-flight gate, like `git status`.

## Pre-dispatch checklist (every Agent / Codex dispatch)

Run this checklist on the assembled prompt BEFORE sending any subagent or Codex task. If any check fails, fix the prompt first — do not dispatch and patch later.

1. **No unfilled placeholders.** Scan the prompt text for `<` and confirm every remaining angle-bracket token from the template was replaced with a real value.
2. **Absolute paths** for repo root, plan file, ledger file.
3. **User's request verbatim** where the template asks for it — paste, never paraphrase.
4. **Self-contained.** The subagent sees nothing from this session. Anything you "already said" or "already know" must be physically in the prompt.
5. **Codex only:** `--background` present; `--model` + `--effort` match the role — plan writer = sol/max, control review = sol/xhigh, implementer = luna/max, reasoning escalation = terra/xhigh (never rely on the wrapper's default pin for protocol dispatches, and never `--effort ultra` unless the user explicitly asked); `--write` ONLY on plan-writer and implementation dispatches; resumes are thread-addressed — `--resume-task <task-id>` referencing the SAME role's prior dispatch (plan reviewer resumes plan reviewer, implementer resumes implementer; never cross roles, never `--resume-last`); Step 4 control review rounds 2+ are FRESH by design (see `codex-invocation` "Resume semantics"). Record every dispatched task id next to its role — you will need it for the resume.
6. **Opus subagent only:** the prompt's literal first line is `ultrathink` (runs Opus at max thinking effort).
7. **Round 2+ only:** ledger path present AND open ACCEPTED / PARTIALLY_ACCEPTED items inlined.
8. **Review dispatches (4.1 / 4.2) only:** this round's freshly generated review package path is present (`[DIFF_FILE]` for 4.1, `<package-path>` for 4.2), the implementer's `[REPORT_FILE]` path is present, and `[GLOBAL_CONSTRAINTS]` is filled with the plan's `## Global Constraints` section copied verbatim — the reviewer's attention lens: exact values, exact formats, stated relationships between components; not process rules — those are already in the templates.
9. **Anti-coaching scan (every reviewer dispatch — 4.1, 4.2, Step 5, Step 2).** Scan the assembled prompt text for these stop-phrases: "do not flag", "don't treat", "not a defect", "at most Minor", "Minor at most", "the plan chose", "ignore the". Any hit → delete the whole sentence containing it and re-scan. Exception: a sentence that references already-triaged ledger entries by id (`REJECTED_BY_SCOPE` / `DEFER`) is allowed — the ban is on pre-judging NEW findings, not on relaying settled triage.

## Triage (first decision)

```
Pure frontend / UI task? (all changes in .tsx/.jsx/.vue/.svelte/.css/.scss,
                          or user mentions "UI", "дизайн", "компонент", "страница",
                          or screenshot attached with UI intent)
  New UI (new page/component, visible redesign, visual rework)
      → Claude frontend implementer subagent, model `opus`
        (prompt starts with `ultrathink`).
        Skip Codex for Step 3; Step 4 fused review still runs on the diff.
  Simple UI edit (CSS tweak, copy change, minor markup)
      → Claude frontend implementer subagent, model `sonnet`.
        Skip Codex for Step 3; Step 4 fused review still runs on the diff.
  Ambiguous (new vs tweak)
      → AskUserQuestion once.

Else — single-file change, <~20 lines, no architectural judgment
          (rename, typo, obvious bugfix, mechanical update)?
  YES → Sonnet quickfix subagent (see ./sonnet-quickfix-prompt.md)
  NO  → Full protocol below. Step 3 routes per-phase: Codex implementer (Luna max)
        for backend / non-frontend phases, Claude frontend implementer subagent for
        frontend-only phases.
AMBIGUOUS → Ask user once.
```

Never guess on ambiguous cases — a wasted round trip costs more than one clarifying question.

**Full-stack requests** (BE + FE in one task) go into the full protocol. The plan writer is required to split backend and frontend into **separate phases** with an explicit contract between them (see `codex-plan-writer-prompt.md`), so Step 3 can route each phase cleanly.

## Before Step 1 — check for an in-progress plan

After triage (classified non-trivial), before dispatching the plan writer for a new plan:

1. Look for plan files in the repo. Default path: `docs/plans/*.md`. If the repo already uses a non-standard plans path (`docs/architecture/plans/`, `docs/rfc/`, `.claude/plans/`, `plans/`), scan there.
2. Find files whose YAML frontmatter has top-level `status: in-progress`.
3. Behavior:
   - **None** → proceed to Step 1.
   - **Exactly one** → surface to user: `Found in-progress plan: <slug> (current phase: <id> — <scope>). Continue or start new plan?` Wait for answer.
   - **Multiple** → list them all, ask user which to continue (or start fresh).
4. If user confirms continuation: skip Steps 1 and 2 (plan is already written and approved), jump straight to Step 3 for the phase marked `in-progress`. If none is `in-progress` but a `pending` one exists, flip the earliest pending to `in-progress` in the plan frontmatter (commit `docs(plans): advance to <id>`) and start Step 3. Before dispatching, apply the "## Durable Progress" checks: if `git log` / `git status` already shows the phase's implementation, resume at Step 4 instead of re-dispatching the implementer; and run `"$DISPATCH" status` first — a write task already running for the phase means poll, not re-dispatch.

Never resume silently — always name the plan and wait for confirmation.

### Plan files without frontmatter (legacy migration only)

`writing-plans` now produces YAML frontmatter natively, so this path is rare. It only triggers for plans created before the format unification or imported from upstream `superpowers` (TDD-flat format). When you do hit one: offer the user a retrofit — dispatch Opus subagent with the existing file + current phase info (from user or `git log`) to write frontmatter in place, then commit `docs(plans): add frontmatter to <slug>`. Only then proceed. If you find yourself running retrofit on a freshly-written `writing-plans` plan, that's a bug in `writing-plans` — surface it, don't paper over.

## Full protocol

### Step 1 — Codex Sol max writes the plan

Dispatch the Codex plan writer per `./codex-plan-writer-prompt.md` (Sol max, `--write`, `--prompt-file`). Relay user's original request verbatim + repo path + any constraints you know. Record the task id (role: plan writer) — Step 2 revisions resume it. Effort is `max`; `ultra` exists only when the user explicitly asked for it.

The plan writer writes `docs/plans/YYYY-MM-DD-<slug>.md` (or repo's custom path) with this format:

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
    parallel_group: G1        # optional — two phases sharing a group id run as parallel tracks
---
```

Body sections: Goal · Files (by phase) · Contracts · Test strategy · Risks / unknowns · Phases (`## Ф1: <title>`, etc.).

**The plan file is the single source of truth** across the entire protocol and across sessions. All subsequent Codex and Opus invocations read it by path.

Pre-plan research (Explore subagent) is **required**, not optional, if any of the following is true: (a) the area is unfamiliar to you; (b) the user's request names failing tests / errors you haven't seen resolved in a prior turn; (c) you'd otherwise be tempted to open source files on main to "understand the task". Dispatch `Agent(subagent_type="Explore")` with a focused question (failing tests + specific files to investigate, or "map X feature"), then feed the report into the plan-writer prompt. Do not read production code on main to decide whether Explore is needed — if you're not sure, dispatch it.

If the repo maintains `docs/ARCHI.md` (see the `architecture-memory` skill), tell the Explore subagent to start from it — a current architecture memory usually shrinks the Explore pass to verification of the relevant sections. Do NOT read ARCHI.md on main yourself: it is architecture content, i.e. research (Rule 2); you only pass its path along.

### Step 2 — Opus reviews the plan (loop, cap=4)

Dispatch an Opus subagent using `./opus-plan-reviewer-prompt.md` (points the reviewer at the plan file — no embedded copy). Fresh subagent each round — the ledger, not thread memory, carries the round history.

Verdict handling:
- `APPROVED` → commit the plan file **separately** (subject: `docs(plans): add <slug>`, stage only the plan file, Co-Authored-By trailer, no push). Then Step 3.
- `CHANGES_REQUESTED` → run the ledger sequence (see "## Authorized Change Ledger" for ledger shape and rules):
  - **(a) Triage.** Classify each reviewer finding's `class:` into a ledger `decision`. `MUST_FIX_NOW` and `REGRESSION_FROM_AUTHORIZED_FIX` map to `ACCEPTED` (or `PARTIALLY_ACCEPTED` if you accept only part of the change); the reviewer's `DEFER` / `NIT` / `REJECTED_BY_SCOPE` items map directly to ledger `decision`s of the same name. Exception: a finding labeled `plan-mandated` is NEVER triaged into `ACCEPTED` or `REJECTED_BY_SCOPE` — "the plan chose it" is not a triage basis. Record it as `ESCALATED_TO_HUMAN` and present it to the user: the finding + the plan text that mandates it + "which governs?". Do not dispatch a fix that contradicts the plan without the answer.
  - **(b) Write/update ledger** at `docs/plans/<slug>.ledger.json` with this round's items — ids `P<round>-B<n>` (see "## Authorized Change Ledger" for the per-stage id scheme), reviewer `opus-plan`. If the file already exists from a prior round, first update those entries' `status` (`fixed` / `rejected` / `deferred`) based on what the latest plan revision did, then append the new round's entries.
  - **(c) Dispatch the plan-writer revision.** Codex Sol max with `--resume-task <plan-writer-task-id>`, using `./codex-plan-writer-prompt.md` Mode B; pass the plan-file path, the ledger path (`docs/plans/<slug>.ledger.json`), and the open ACCEPTED / PARTIALLY_ACCEPTED items inline. The writer updates the plan file in place. If the revision returns `NEEDS_AUTHORIZATION: <ledger id> requires <extra change>...`, triage the requested extension: within the plan's scope and Non-goals → extend that item's `authorized_change` / `forbidden_expansions` in the ledger and re-dispatch the revision (same `--resume-task`) with the extended item inline; outside the plan's scope → record the item `ESCALATED_TO_HUMAN` and ask the user before any further dispatch.
  - **(d) Re-dispatch a FRESH Opus reviewer** with the follow-up template from `./opus-plan-reviewer-prompt.md` — it carries the ledger path and the writer's revision report so the reviewer can verify each ACCEPTED item is addressed. Increment counter.
**Loop-control checks — run IN ORDER after every `CHANGES_REQUESTED`, before dispatching a fix round. First match wins; if a check fires, stop and do what it says.**

1. **Anti-pingpong filter.** Remove from the blocking list any item that repeats a point explicitly rejected with reasoning in a prior round — mark it `resolved-by-decision` in the ledger. If the list becomes empty after filtering, treat the verdict as `APPROVED` and proceed accordingly.
2. **No-progress detector.** Blocking list identical (by content) to the previous round's → escalate immediately: plan-file path + the repeated list + one-sentence impasse summary (have Opus write the summary). User picks: accept / another round / close.
3. **New-blocker churn detector.** Escalate immediately, even before cap=4, if ALL three hold: (a) every blocker from the previous round is fixed or rejected-by-scope (per the ledger); (b) the remaining blocking items are all NEW `MUST_FIX_NOW` (items classed `REGRESSION_FROM_AUTHORIZED_FIX` do NOT count as new — they are causally tied to a prior accepted fix); (c) none cite DATA_LOSS, SECURITY, or GUARANTEED_FAIL materiality. Escalation summary must include: prior blockers closed; new blockers with their materiality labels; recommendation — approve now plus defer list, OR authorize another high-materiality round.
4. **Round cap.** The next round would be round 5 (cap=4 exhausted) → escalate: plan-file path + last blocking list + one-sentence disagreement summary (have Opus write the summary). User picks: accept / another round / close.
5. **None fired** → run the ledger sequence (a)–(d) above and start the next round.

### Step 2.5 — Pre-flight scan (orchestrator itself, NO dispatch)

After the plan is approved and committed, before the first Step 3 dispatch, scan the plan once yourself. This is the one place you read the plan body on main: a single full `Read` of the plan file, used ONLY for the three mechanical string checks below and to copy the `## Global Constraints` section verbatim for later reviewer dispatches (re-extract just that section after any later plan revision). It is not a license to re-plan, second-guess phasing, or open source files.

1. **Global Constraints vs phases.** For each line of `## Global Constraints`, look for a phase whose text names a conflicting value — a different version floor, dependency, name, or format for the same thing.
2. **Consumes ↔ Produces.** Every `Consumes:` line of every phase must match, as a string, a `Produces:` line of an earlier phase or an entry in `## Contracts`. A name or signature that matches nothing is a plan bug. Exception: lines reading literally `Consumes: nothing` / `Produces: nothing` are the plan format's explicit empty marker — they are exempt from this check, not a bug.
3. **Rubric-mandated defects.** The plan explicitly mandates an item from this fixed list: a test that asserts nothing; verbatim duplication of a logic block; an instruction to skip tests.

Findings → ONE batched `AskUserQuestion` covering all of them — each finding beside the plan text that mandates it, asking which governs — before execution begins, not one interrupt per discovery mid-plan. Nothing found → proceed to Step 3 WITHOUT comment (no "I checked the plan and found no issues"). The review loop remains the net for conflicts that only emerge from implementation.

Plan edits the user accepts go through the existing ledger sequence (reviewer `"preflight"`, ids `PF-B<n>`) + a plan-writer revision dispatch (Codex Sol max, `--resume-task <plan-writer-task-id>`, `./codex-plan-writer-prompt.md` Mode B). Re-run the three checks once on the revised plan, then proceed.

### Step 3 — implement the current phase

**Before every implementer dispatch** (both routes, every phase — including re-dispatches after an interrupted session):

1. **Record the phase BASE**: `git rev-parse HEAD`. Carry it in the state line (`base=<base7>`). Every review package for this phase and its frontmatter `commits:` range derive from this recorded SHA — never `HEAD~1`, which silently drops all but the last commit of a multi-commit task.
2. **Resolve `[REPORT_FILE]`** once per phase: `$("$WS" <plan-file>)/phase-<id>-report.md`, substituted as an absolute path into the dispatch — both implementer templates (Codex and the Claude frontend implementer) take it, and the same path later goes to both reviewers. For a parallel track, run `"$WS"` with cwd inside the track's worktree. Fix rounds append to the same file — never mint a new report path for round 2+.

**Route by phase type** (decide from the plan's `Files` section for this phase):

- **Frontend-only phase** (all files in .tsx/.jsx/.vue/.svelte/.css/.scss; visual/UI work) →
  Dispatch Claude frontend implementer subagent using `./claude-frontend-implementer-prompt.md`.
  Opus for new UI / redesign (prompt starts with `ultrathink`); Sonnet for simple tweaks.
  Subagent is instructed to use the `frontend-design` skill.
- **Backend / non-frontend phase** → Codex implementer (Luna max) using `./implementer-prompt.md`. Points Codex at the plan file and names the current phase id.

Dispatch, wait terminal (Codex) or Agent completion (Claude subagent), fetch result.

Implementer status (same shape from both paths):
- `DONE` → Step 3.5 (verification gate), then Step 4.
- `DONE_WITH_CONCERNS` → read concerns. Correctness/scope → address before review. Observations → note and proceed.
- `NEEDS_CONTEXT` → provide the missing context and re-dispatch (Codex: `--resume-task <implementer-task-id>`; Claude subagent: fresh Agent call carrying the added context).
- `NEEDS_AUTHORIZATION` — a fix-round-only token (a first-round implementer has no ledger to be authorized against); if it appears, handle it per the Step 4(c) `NEEDS_AUTHORIZATION` branch: triage the requested extension, extend the ledger item or escalate, re-dispatch.
- `BLOCKED` — dispatch Opus subagent to assess (pass BLOCKED report + plan-file path). Opus returns one of:
    1. More context needed → re-dispatch implementer with added context, same effort.
    2. Needs more reasoning → Codex path: re-dispatch with `--resume-task <implementer-task-id>` at Terra xhigh (`--model gpt-5.6-terra --effort xhigh`). Claude path: upgrade from Sonnet to Opus (with `ultrathink`); if already Opus, hand back to user.
    3. Task too large → break into sub-phases; dispatch Opus to edit the plan accordingly, re-run Step 2 on the plan change.
    4. Plan is wrong → escalate to user.

Never force the same model to retry without changes.

### Step 3.5 — Verification gate (before every review round)

A cheap mechanical gate between implementation and the expensive review loop (pattern borrowed from TRIP-workflow's testing gate). The fused review reads code; the gate proves the tree actually builds and passes its own tests — and a red tree fails fast on a Sonnet dispatch instead of burning an Opus xhigh round.

**When it runs:**
- After every implementer `DONE` / `DONE_WITH_CONCERNS` (Step 3), before the first 4.1 dispatch.
- After every Step 4 fix round, before re-dispatching 4.1.
- Parallel tracks: per track, inside the track's worktree.

**How:** dispatch `Agent(subagent_type="general-purpose", model="sonnet")` with `./verification-gate-prompt.md` (repo root, phase's files). Not on main — running tests is research/verification, not orchestrator bookkeeping.

**Verdict handling:**
- `GATE_OK` → record the one-line gate summary (`lint: … | typecheck: … | tests: …`) and proceed to Step 4. Pass the summary into the 4.1 and 4.2 prompts (`## Verification gate summary` section) so reviewers know what already ran and on which tree state.
- `GATE_FAIL` → do NOT start (or resume) the review loop. Dispatch the implementer (`--resume-task <implementer-task-id>`, or fresh-fallback) with the gate's failure report as the fix list — this is a gate-fix round, it does NOT increment the fused-review round counter. Cap: 2 consecutive gate-fix rounds without reaching `GATE_OK` → escalate to the user with the failure output.
- Malformed output → verdict-parsing procedure as usual (re-dispatch once, then escalate).

The gate never blocks on pre-existing failures unrelated to the phase: the gate prompt instructs the subagent to compare against the base commit when a failure looks inherited, and to report inherited failures as a note under `GATE_OK` rather than a `GATE_FAIL`.

**State line during the gate:** `step=3.5-gate`.

### Step 4 — Fused review (Opus + Sol xhigh control, cap=4)

Per iteration:

**4.0 Build this round's review package** — before every 4.1 dispatch, every round:

```bash
dir=$("$WS" <plan-file>)
"$RPKG" <BASE> WORKTREE "$dir/review-<phase-id>-r<round>-<base7>.diff"
```

BASE is the SHA recorded before this phase's implementer dispatch (Step 3) — never `HEAD~1`, which silently drops all but the last commit of a multi-commit task. Only the printed `wrote <path>: ...` line enters your context — never Read the package. For a parallel-track phase run both scripts with cwd inside the track's worktree, so the package lands in — and its path points into — that worktree.

**4.1 Opus subagent review (spec + quality, both every round).** Requires a `GATE_OK` from Step 3.5 on the current tree state. Dispatch with `./opus-review-prompt.md`. Fill: base SHA, plan-file path, current phase id, review round, the gate summary, `[DIFF_FILE]` = this round's package path, `[REPORT_FILE]` = the implementer's report, `[GLOBAL_CONSTRAINTS]` = the plan's `## Global Constraints` section verbatim. Opus runs BOTH parts every round — findings in one never skip the other:
- 4a spec compliance — does the diff implement the plan for this phase, no more no less.
- 4b code quality — regressions, tests verify behavior, structure, idioms, security.

Test policy by round: in round 1 the reviewer runs the phase's own tests plus anything the gate summary marked skipped or that its review puts in doubt (the gate already proved mechanical greenness — the reviewer targets what the gate cannot see); in rounds 2+ it runs only focused tests under a named doubt plus verification that ACCEPTED ledger items closed — never a full suite (details live in the prompt templates).

Output: line 1 `REVIEW_OK` or `REVIEW_BLOCKING`; line 2 `SPEC: OK|FAIL`; line 3 `QUALITY: OK|FAIL` (both lines mandatory — see Verdict parsing); then `CANNOT_VERIFY` / `PLAN_MANDATED` sections if any, numbered BLOCKING list (file:line), NITS separately.

**CANNOT_VERIFY items** — process mechanically, immediately after parsing a 4.1 report. For each `CANNOT_VERIFY: <requirement> | CHECK: <command> | EXPECT: <result>` item:

1. Execute the CHECK literally — the exact command or `Read <file:line>` as written, nothing else. This is a narrow bookkeeping exception to Rule 2: only the literal command from the item, output compared to EXPECT as strings, no interpretation, no follow-up exploration.
2. Output matches EXPECT → item closed; record it in the ledger with `status: verified-by-controller`.
3. Output does not match → a failed spec review: ledger `decision: ACCEPTED`, and the item joins THIS round's combined BLOCKING list as a 4.1 finding. Even when 4.1's line-1 token was `REVIEW_OK`, the combined list is now non-empty: skip the 4.2 dispatch this round (save it) and run the ledger sequence (a)–(c) directly.
4. CHECK is not executable without judgment (no concrete command, or the comparison is not a string match) → record the item in the ledger FIRST (reviewer `opus-review`, `status: open`, note `handed-to-4.2` in `authorized_change`), so it survives compaction and rounds where no 4.2 runs. Carry it as an explicit "verify additionally: <requirement>" line into the FIRST 4.2 dispatch that follows — this round's if 4.1 returned `REVIEW_OK`, otherwise the next round's. It closes (`status: verified-by-controller`) when that 4.2 returns without raising the item in its BLOCKING list; if 4.2 raises it, it becomes a normal 4.2 finding.

Invariant: a phase is never marked done while any CANNOT_VERIFY item is open.

**4.2 Codex Sol xhigh control review** — only if 4.1 returned `REVIEW_OK`. Dispatch using `./codex-control-review-prompt.md` (`--model gpt-5.6-sol --effort xhigh`). Fill `<package-path>` with THIS round's package (relative to the Codex working directory — `--cwd` for a parallel track), the implementer's `[REPORT_FILE]` path (the template's `Implementer report:` line in the Phase context), `[GLOBAL_CONSTRAINTS]` verbatim, the gate summary line, and the template's `Verify additionally` line with any CANNOT_VERIFY items handed over per step 4 above (or `none`). Prompt is tuned for "what might Opus have missed": edge cases, race conditions, security holes, ambiguities between plan and code, subtle regressions. Do NOT duplicate Opus's checklist — orthogonal angle. 4.2 runs no tests — test execution belongs to the verification gate and 4.1.

Output: same format (`REVIEW_OK` / `REVIEW_BLOCKING`, numbered list, separate NITS).

**Combined BLOCKING list** (both 4.1 and 4.2). Whatever the verdicts, FIRST record both reviewers' `DEFER:` and `NITS:` sections in the ledger (`decision: DEFER` / `NIT`, `status: deferred`) — Step 5's ledger triage reads them; items not recorded here are silently lost to the final gate. Then:
- Empty AND no open CANNOT_VERIFY items → auto-commit (see below). Phase done.
- Non-empty → run the ledger sequence (see "## Authorized Change Ledger"):
  - **(a) Triage** the combined list. Each finding's class maps to a ledger `decision`. Tag each ledger entry's `reviewer` field as `opus-review` (for 4.1 findings) or `codex-control` (for 4.2 findings). A 4.2 BLOCKING item missing any of its three required fields (`authorization_relation`, `why_now`, `minimal_fix`) is triaged `decision: DEFER` and does not block the phase — the control-review template promises exactly this degradation. Step 4 uses the SAME ledger file as Step 2 (`docs/plans/<slug>.ledger.json`), but with ids `F<round>-B<n>` derived from the fused-review round counter — the stage prefix keeps them distinct from Step 2's `P<round>-B<n>` entries in the same file, and ledger entries from prior Step 2 rounds remain in place with their final `status`. Exception: findings labeled `plan-mandated` (the 4.1 `PLAN_MANDATED:` section, or a 4.2 BLOCKING item carrying the label) are NEVER triaged into `ACCEPTED` or `REJECTED_BY_SCOPE` — "the plan chose it" is not a triage basis. Record them as `ESCALATED_TO_HUMAN` and present each to the user: the finding + the plan text that mandates it + "which governs?". Do not dispatch a fix that contradicts the plan without the answer.
  - **(b) Write/update the ledger** with the triaged items.
  - **(c) Dispatch the fix round to the Codex implementer** (`--write --model gpt-5.6-luna --effort max`) with `--resume-task <implementer-task-id>` — the fixer continues its own implementation thread (full context retained; the control reviewer having run in between does not matter, the resume is thread-addressed). Use the fix-round template in `./implementer-prompt.md`: ledger path, `[REPORT_FILE]` (the fixer appends its `## Fix round <N>` section there), plus the open ACCEPTED / PARTIALLY_ACCEPTED items inline. For a frontend-only phase, dispatch the Claude frontend implementer's follow-up template instead (fresh Agent call, same ledger-derived list, same `[REPORT_FILE]` rules) — never Codex. `--resume-last` remains FORBIDDEN anywhere in Step 4 — positional resume would land in the control reviewer's read-only thread. If the implementer thread is unavailable (Claude-implemented phase, lost task id, stale job record), fall back to a FRESH task with the same template prefixed by the fresh-fallback re-brief block. Increment iteration counter.
  - **`NEEDS_AUTHORIZATION` from a fixer** (`NEEDS_AUTHORIZATION: <ledger id> requires <extra change> because <reason>`): triage the requested extension. Within the plan's scope and Non-goals → extend that ledger item's `authorized_change` / `forbidden_expansions` and re-dispatch the fixer (same `--resume-task`) with the extended list; outside the plan's scope → record the item `ESCALATED_TO_HUMAN` and ask the user before any further fix dispatch. Never treat the token as DONE and never re-dispatch unchanged.
  - **Fix-report check (before every re-review).** When the fixer reports DONE, `Read` the `## Fix round <N>` section of `[REPORT_FILE]` and confirm ALL THREE are present: (1) the names of the tests covering each fixed blocker, (2) the exact test command(s), (3) the relevant output. Any of the three missing → return the report to the fixer (re-dispatch naming what is missing); do NOT dispatch the re-review. This read is bookkeeping, not research — reviewers will not re-run the full suite, so the fix report is the test evidence.
  - Next iteration first re-runs the verification gate (Step 3.5) on the updated tree, then re-runs 4.1 from scratch (fresh Opus subagent each round — no bias from previous round), starting with a fresh 4.0 package under the new round's name. The fresh Opus is given the ledger path so it can verify prior-round ACCEPTED items closed cleanly. 4.2 round 2+ is likewise a FRESH Codex task with the full control-review prompt (see `./codex-control-review-prompt.md` follow-up section), reading this round's fresh package — never a prior round's file. Reviewer freshness is a bias decision and is NOT relaxed by `--resume-task`.

**Loop-control checks (Step 4)** — run the SAME ordered procedure as Step 2 (anti-pingpong → no-progress → churn → round cap → next round; first match wins) after every non-empty combined BLOCKING list, with these substitutions:

- **Anti-pingpong and no-progress** apply to each reviewer's own history separately — don't let Opus re-raise what it already rejected, same for Codex xhigh.
- **New-blocker churn detector** uses the COMBINED reviewer output (opus-review + codex-control), not each reviewer's history independently — a finding raised by either reviewer counts. Same three conditions as Step 2; `REGRESSION_FROM_AUTHORIZED_FIX` items are excluded from the new-MUST_FIX_NOW count. Both review templates require a `class:` label on every BLOCKING item (4.1 `class:`, 4.2 `authorization_relation:` — `REGRESSION_FROM_AUTHORIZED_FIX` is the shared regression token); a BLOCKING item that arrives WITHOUT a label counts as a NEW `MUST_FIX_NOW` citing no materiality — compute conditions (b)/(c) on that basis rather than stalling.
- **Round cap** escalation content: diff + combined list + one-sentence description of the impasse (have Opus write the summary). User picks accept / another round / close.

### Step 4.5 — Review synthesis (only after a multi-round fused review)

When the fused review comes back both-clean AND the loop took **2+ rounds**, produce a consolidated review record before auto-commit (idea borrowed from TRIP-workflow's synthesize step). Each round's verdicts were deltas; the ledger is transient and deleted at plan archival — without synthesis the review history evaporates.

Dispatch `Agent(subagent_type="general-purpose", model="sonnet")` with `./synthesize-review-prompt.md`: ledger path, plan path, phase id, base SHA, the final 4.1/4.2 outputs (DEFER / NITS sections included). The subagent writes `docs/reviews/<slug>-<phase-id>.md` and reports `SYNTHESIS_DONE <path>` on line 1.

- Single-round clean review → SKIP synthesis entirely (nothing to consolidate; the commit message suffices).
- The synthesis file is staged with the phase's auto-commit (see below).
- Escalated / capped loops: if the user chose "accept" at an escalation, still synthesize — the record of what stayed open is the most valuable part. Note the open items under "Open at accept".
- Never write the synthesis on the main thread — it summarizes review content, which is judgment-adjacent; the Sonnet subagent does it from the ledger + verdicts you pass in.

**State line:** `step=synthesize`.

### Step 5 — Final whole-branch review (once per plan, cap=2)

Runs exactly once: after the LAST phase's auto-commit has landed (top-level plan `status` just flipped to `done`), BEFORE plan archival. Every phase passed its phase-scoped gate; this is the single broad merge review of the entire branch. Codex control review does NOT participate in Step 5. State line: `step=5-final-review round=<k>/2`.

1. **Determine MERGE_BASE**: `git merge-base main HEAD`. If the repo has no `main` branch (master/trunk — the command errors), or the work ran directly on the mainline (with user consent) so it returns HEAD and is useless — fall back to the recorded BASE of the plan's first phase (its frontmatter `commits:` range names the base7).
2. **Build the package** (`dir=$("$WS" <plan-file>)` as in Step 4.0): `"$RPKG" <MERGE_BASE> HEAD "$dir/review-final-r1-<base7>.diff"` — pass the OUTFILE explicitly; the range-mode default would land in the shared `.superpowers/sdd/` root, not the plan-scoped workspace. If the last phase was left uncommitted (user said "no commit"), use WORKTREE mode instead: `"$RPKG" <MERGE_BASE> WORKTREE "$dir/review-final-r1-<base7>.diff"`.
3. **Dispatch ONE Opus subagent** per `./final-review-prompt.md` (literal first line `ultrathink`), filling: repo root, plan path, ledger path, MERGE_BASE/HEAD SHAs, `[DIFF_FILE]` = the printed package path. The anti-coaching scan (Pre-dispatch checklist) applies.
4. **Verdict** (line 1, standard parsing):
   - `REVIEW_OK` → proceed to the clean finish below.
   - `REVIEW_BLOCKING` → record ALL findings in the same ledger (reviewer `"opus-final"`, ids `FR<round>-B<n>`). Findings labeled `plan-mandated` → `ESCALATED_TO_HUMAN`, never handed to a fixer. Everything else → dispatch ONE fixer: a single Codex Luna max FRESH task (`--write --model gpt-5.6-luna --effort max`; no resume — the whole-plan fix wave has no single implementer thread) with the COMPLETE findings list — all BLOCKING items plus all `MUST_FIX_BEFORE_MERGE` ledger triages. Never one fixer per finding: per-finding fixers each rebuild context and re-run suites; a real session's final-review fix wave cost more than all its tasks combined. Use the fix-round template in `./implementer-prompt.md` with the whole plan (not one phase) as scope and `[REPORT_FILE]` = `$dir/final-fix-report.md`, applying the template's "Step 5 fix wave" substitutions (fresh task with the fresh-fallback re-brief, committed diff against MERGE_BASE, reviewer `opus-final`, fresh report file); the fix-report check from Step 4 applies before the round-2 re-review.
5. **Round 2**: build a FRESH whole-branch package in WORKTREE mode (the fixer does not commit): `"$RPKG" <MERGE_BASE> WORKTREE "$dir/review-final-r2-<base7>.diff"`, then dispatch a fresh Opus per the template's Round 2 section, inlining the round-1 fix list.
6. **Cap**: still `REVIEW_BLOCKING` after round 2 → escalate to the user: findings list + ledger path + one-sentence impasse summary (have Opus write the summary). User picks accept / another round / close.
7. **Clean finish**: on `REVIEW_OK`, if the fixer changed anything, auto-commit those fixes per the common auto-commit rules (stage by name; subject e.g. `fix: address final-review findings for <slug>`). Then — and only then — proceed to "## Plan archival".

## Auto-commit (after fused review clean)

### For a phase under the full protocol

Before commit, update the plan-file frontmatter (Sonnet does this — mechanical):
- Just-completed phase: `status: done`, and in the same edit add `commits: "<base7>.."` to that phase's entry — base7 is the phase BASE recorded at Step 3. The head side stays open: the implementers do not commit, so this very auto-commit is the phase's head and cannot name itself; git resolves `<base7>..` against HEAD. (Parallel groups record a full range — step 8 there.) See "## Durable Progress": the recorded base7 anchors recovery and Step 5's MERGE_BASE fallback.
- Next `pending` phase (if any): flip to `status: in-progress`.
- If no next phase exists, also flip top-level plan `status: in-progress → done`. The plan is not finished yet — Step 5 (final whole-branch review) still gates archival.

Stage and commit in one go:
- Files the phase touched (by name — never `-A`). The name list comes from `git status --porcelain` (allowed bookkeeping read) — exclude the plan file (staged next), the ledger file, and anything unrelated to this task.
- The plan file (with frontmatter update).
- The review synthesis file `docs/reviews/<slug>-<phase-id>.md`, when Step 4.5 produced one.
- Conventional-commit subject (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`) referencing the phase, in a HEREDOC.
- 1–2 sentence body focused on **why**.
- `Co-Authored-By: Claude <main-thread model name, e.g. Opus 4.8> <noreply@anthropic.com>` trailer — use the model actually running the main thread, not a hardcoded name.

### For a Sonnet quickfix (no plan file)

Stage only the touched files. Conventional-commit as above.

### Common rules (both paths)

- Never `--no-verify`. Never `--amend`.
- **Never `git push`** unless the user has explicitly approved push **in the current session**. Auto-commit covers commit only, not push — even across phase boundaries. If push is needed, ask and wait.

### Skip auto-commit if

- User said "no commit" / "не коммить" / "just show me the diff".
- `git status` shows unrelated uncommitted changes not from this task — warn user, let them decide. Exception: the untracked ledger file (`docs/plans/<slug>.ledger.json`) is expected orchestrator state, never "unrelated changes" — ignore it for this check.
- Pre-commit hook fails — fix the issue, create a **new** commit (not amend).

Report one line: `Committed: <sha> <subject>`.

## Plan archival (after Step 5 clean)

When Step 5's final whole-branch review has returned `REVIEW_OK` (top-level plan `status` flipped to `done` at the last phase's auto-commit; Step 5 fixes, if any, committed), after the last `Committed: <sha>` line ask the user exactly once:

> План реализован. Переместить в `docs/plans/finished/`? [y/N]

- `y` / `да` / `yes` → `git mv docs/plans/<file>.md docs/plans/finished/<file>.md` (create `finished/` if missing), commit as `chore: archive <slug>` in a **separate** commit (never `--amend`), report `Archived: <sha>`.
- anything else → skip silently, do not ask again.

Only after Step 5 returned `REVIEW_OK`. Never between phases, never for quickfixes (no plan file — quickfixes also skip Step 5).

## Multi-phase plans

A single user request often produces a plan with multiple phases (Ф1, Ф2, Ф3, …). Treat them as ONE plan, not separate protocol runs:

- Step 1 (plan) and Step 2 (plan review) cover **all phases at once**, up front.
- Step 3 (implementation) and Step 4 (fused review + auto-commit) run **per phase**.
- After a phase's auto-commit lands cleanly, **immediately dispatch the next phase's Step 3** — do NOT ask "shall I proceed to Ф2?" / "запускать Codex для Ф2?". The plan was already approved; re-asking is noise.
- Before dispatching the next phase, check its frontmatter: if it shares a `parallel_group` with another pending phase, run them as a parallel group (see "## Parallel groups") instead of sequentially.
- After the LAST phase's auto-commit, do not archive yet — run Step 5 (final whole-branch review) first.

Transition reporting (one line, no question, no choice offered):
- `Ф1 committed <sha>. Starting Ф2: <one-line scope>.`

Pause and ask the user ONLY when:
- Step 4 hit cap=4 without both-clean (already escalates).
- Step 5 hit cap=2 still blocking, or returned `plan-mandated` findings (both already escalate).
- Codex reported `BLOCKED` that more context cannot resolve.
- Findings from the just-completed phase invalidate a later phase's scope → propose plan revision first.
- User explicitly requested a pause in the original request ("после Ф1 остановись", "let me see Ф1 before Ф2").
- The upcoming phase includes **irreversible side-effects** (prod schema migration, external API writes, destructive git ops) — flag before dispatching Codex.

None of these are a routine "confirm?" prompt — they are real blockers.

## Parallel groups (two tracks max)

The plan writer may mark 2 phases as a **parallel group** in the frontmatter (`parallel_group: G1` on both phases — see `writing-plans` / `codex-plan-writer-prompt.md` for the marking rules; canonical case: a BE+FE pair with a frozen contract). When the next pending phases share a `parallel_group`, run them as two concurrent tracks instead of sequentially. If you see 3+ phases in one group, run 2 at a time — the width cap is HARD (subscription rate limits + orchestrator attention).

Routing per track is unchanged: frontend-only phase → Claude frontend implementer subagent (Opus with `ultrathink` for new UI, Sonnet for tweaks); everything else → Codex implementer (Luna max). Codex+Codex, Codex+Claude, Claude+Claude are all valid pairs.

**Preconditions (all must hold; else fall back to sequential):**
1. Both phases `pending`, same `parallel_group`, plan approved by Step 2.
2. `git status` clean in the main working tree.
3. No other Codex write task currently running.

**Track lifecycle:**

1. **Setup.** First flip both phases to `status: in-progress` in the plan frontmatter on the main branch and commit `docs(plans): start parallel group <G> (<id>+<id>)`. THEN, for EACH phase, from the main tree:
   `git worktree add <repo-parent>/<repo-name>-wt-<phase-id> -b wt/<slug>/<phase-id>` (branches off the current branch). Order matters: a worktree created before the flip commit would carry a plan copy that forever shows both phases `pending`, breaking any resume read inside the track.
2. **Dispatch both implementers concurrently.**
   - Codex: standard implementer dispatch plus `--cwd <worktree-path>` (`--prompt-file` as usual). In the prompt, `Repository root:` = the worktree path.
   - Claude subagent: prompt names the worktree path as the working root and forbids touching anything outside it.
3. **Poll both.** Codex via Monitor (remember `--cwd <worktree-path>` on every `status`/`result` call); Claude via Agent completion. Handle each track's verdict independently per Step 3 rules.
4. **Steps 3.5 + 4 per track, independently** — verification gate first (Sonnet subagent pointed at the track's worktree), then the same fused review loop, run against the track's worktree: build each round's package (4.0) by running `"$WS"` / `"$RPKG"` with cwd inside that worktree, so the package and report paths point into the worktree; Opus reviewer and Codex control reviewer get the worktree path as repo root (Codex: `--cwd`). Per-track ledger lives INSIDE the worktree at `<worktree>/docs/plans/<slug>.ledger.json` — tracks never share a ledger. All fix-round dispatches carry the track's `--cwd`.
5. **Commit per track.** When a track's fused review is clean: stage the phase's files by name and commit IN THE WORKTREE (conventional subject, Co-Authored-By trailer, no plan-file edits there).
6. **Merge (sequential, main tree).** After BOTH tracks committed: `git merge --no-ff wt/<slug>/<id-1>` then `git merge --no-ff wt/<slug>/<id-2>`. A conflict means the plan's independence claim was wrong — abort the merge, escalate to the user with both branch names. Do not resolve conflicts yourself.
7. **Integration check (dispatched — not run on main).** The tracks were reviewed in isolation; the merged combination was never tested. Dispatch `Agent(subagent_type="general-purpose", model="sonnet")`:

   ```
   Run the repository's standard verification in <repo-root>: tests, typecheck, linter (whatever the repo provides). Do not modify any files. Report line 1 exactly `INTEGRATION_OK` or `INTEGRATION_FAIL`, then the failing commands and output excerpts.
   ```

   - `INTEGRATION_FAIL` → dispatch the Codex implementer (fresh, main tree, `--write --model gpt-5.6-luna --effort max`) with the failure report + plan path + both phase ids to repair the integration; re-run the check. Cap 2 repair rounds, then escalate.
   - **Repair gate + commit.** If the repair changed anything, it has passed no review yet: run ONE Opus review round on the repair diff (4.1 template; package `"$RPKG" HEAD WORKTREE "$dir/review-repair-<G>-r1.diff"` — the repair is uncommitted against the merged HEAD). Blocking verdict → one fix round via the ledger sequence, then escalate. Clean → stage the repair's files by name and commit `fix: repair integration of group <G>` — an uncommitted repair would otherwise trip the next phase's unrelated-uncommitted-changes guard.
8. **Bookkeeping + cleanup.** First merge each track's ledger (`<worktree>/docs/plans/<slug>.ledger.json`) into the main ledger: append its entries, re-suffixing ids on collision with the track's phase id (e.g. `F1-B1-Ф2`) — per-track ledgers die with their worktrees, and Step 5's triage reads only the main ledger. Then flip both phases to `done` (next pending → `in-progress`) in the plan frontmatter, each with its `commits: "<base7>..<head7>"` range (base recorded at the track's dispatch, head = `git rev-parse --short HEAD` after both merges), commit `docs(plans): complete parallel group <G>`. Then `git worktree remove <path>` and `git branch -d wt/<slug>/<id>` for both tracks. Report: `Group <G> merged: <sha-1>, <sha-2>. Starting <next>.`

**Failure asymmetry.** If one track passes and the other escalates (cap, BLOCKED): merge the passing track alone (steps 6–8 for it, its phase → `done`), keep the failed track's worktree intact, and escalate with the worktree path. Never delete a worktree with unmerged work.

**Resume.** If resume-check finds TWO `in-progress` phases sharing a `parallel_group`, run `git worktree list`: worktrees exist → offer to continue the group from where each track stopped; missing → offer to restart the group (re-create worktrees, re-dispatch Step 3).

**State line during a group:** append `tracks=<id>:<step>-r<k>,<id>:<step>-r<k>` (e.g. `tracks=Ф2:4-r1,Ф3:3`).

## Authorized Change Ledger

`AUTHORIZED_CHANGE_LEDGER` is the explicit state object the orchestrator maintains across every CHANGES_REQUESTED verdict in Step 2 (plan review) and Step 4 (fused review), plus pre-flight findings the user accepts (Step 2.5, reviewer `preflight`) and Step 5's final-review findings (reviewer `opus-final`). After every CHANGES_REQUESTED, the orchestrator MUST create or update the ledger before dispatching a fixer.

**Where it lives.** `docs/plans/<slug>.ledger.json` — one file per active plan, shared between the Step 2, Step 4, and Step 5 loops. The ledger is transient orchestrator state, NOT a source artifact: never staged, never committed. It outlives the top-level `status: done` flip — Step 5 still reads and extends it. Only on plan archival (Step 5 returned `REVIEW_OK`) or abandonment does the orchestrator delete it via `rm` or `git clean`. Reviewers and fixers reference the ledger by absolute path; the orchestrator may also inline the open items into the dispatcher prompt when that is more compact than a path read.

**Who writes it.** The Sonnet orchestrator main thread, via `Write` / `Edit` on the JSON file. This is mechanical state-keeping, not production code — the no-writes-on-main rule (HARD RULE 1) does NOT apply here, parallel to the existing plan-file frontmatter exemption.

**Item shape** (one entry per triaged reviewer finding):

```json
{
  "id": "P<round>-B<n> | PF-B<n> | F<round>-B<n> | FR<round>-B<n>",
  "reviewer": "opus-plan | preflight | opus-review | codex-control | opus-final",
  "decision": "ACCEPTED | PARTIALLY_ACCEPTED | REJECTED_BY_SCOPE | DEFER | NIT | ESCALATED_TO_HUMAN",
  "authorized_change": "<exact allowed change, or null>",
  "forbidden_expansions": ["<optional>", "..."],
  "materiality": "BUILD_BREAK | ACCEPTANCE_CRITERIA | DATA_LOSS | SECURITY | REGRESSION | CONSISTENCY | NICE_TO_HAVE",
  "status": "open | fixed | rejected | deferred | verified-by-controller"
}
```

**Id scheme.** Ids are unique per stage — `P<r>-B<n>` (Step 2 plan review), `PF-B<n>` (Step 2.5 pre-flight), `F<r>-B<n>` (Step 4 fused review), `FR<r>-B<n>` (Step 5 final review). Each stage counts its own rounds, but the prefixes guarantee no id ever repeats across stages in the one flat array — fixer prompts reference items by bare id, so an ambiguous id would mis-scope a fix.

**Worked example** — the whole file is a JSON array of items. `docs/plans/user-auth.ledger.json` after Step 2 round 1 triage (reviewer returned two blockers and one out-of-scope ask):

```json
[
  {
    "id": "P1-B1",
    "reviewer": "opus-plan",
    "decision": "ACCEPTED",
    "authorized_change": "Add a step to Ф2: invalidate the session cookie on password change",
    "forbidden_expansions": ["do not add a global session-revocation service"],
    "materiality": "SECURITY",
    "status": "open"
  },
  {
    "id": "P1-B2",
    "reviewer": "opus-plan",
    "decision": "PARTIALLY_ACCEPTED",
    "authorized_change": "Fix the Ф1/Ф3 signature mismatch for createUser() — align Ф3 to the Ф1 contract; do NOT redesign the contract",
    "forbidden_expansions": [],
    "materiality": "BUILD_BREAK",
    "status": "open"
  },
  {
    "id": "P1-B3",
    "reviewer": "opus-plan",
    "decision": "REJECTED_BY_SCOPE",
    "authorized_change": null,
    "forbidden_expansions": [],
    "materiality": "NICE_TO_HAVE",
    "status": "rejected"
  }
]
```

On the next round you would first update these entries' `status` (e.g. `P1-B1` → `fixed`), then append `P2-B1`, `P2-B2`, … from the new verdict.

**Distribution rule.** Fixers receive only ACCEPTED / PARTIALLY_ACCEPTED open items. Reviewers receive the full ledger.

**`ESCALATED_TO_HUMAN`** is reserved for `plan-mandated` findings (Steps 2, 4, 5) and for `NEEDS_AUTHORIZATION` requests that fall outside the plan's scope: the item stays `open` until the user answers — it is never given to a fixer and never counted as ACCEPTED/REJECTED in loop-control checks. **`verified-by-controller`** is the terminal status for CANNOT_VERIFY verification items whose literal CHECK matched EXPECT (Step 4); such entries record `reviewer: "opus-review"`, `decision: "ACCEPTED"` (a verification item, not an authorized change), and no `authorized_change`.

**Materiality vocabulary (reviewer side).** Reviewers classify each finding using exactly one of: `MUST_FIX_NOW`, `REGRESSION_FROM_AUTHORIZED_FIX`, `DEFER`, `NIT`, `REJECTED_BY_SCOPE`. The orchestrator maps reviewer-class → ledger `decision` when triaging (e.g. `MUST_FIX_NOW` → ACCEPTED or PARTIALLY_ACCEPTED, `REJECTED_BY_SCOPE` → REJECTED_BY_SCOPE, etc.). Only `MUST_FIX_NOW` and `REGRESSION_FROM_AUTHORIZED_FIX` are valid in a reviewer's BLOCKING list; the other three land in DEFER / NIT / REJECTED_BY_SCOPE sections of the CHANGES_REQUESTED output.

In Phase Ф1 the ledger is documented and produced, but its `materiality` field and the reviewer-side materiality classes are NOT yet enforced inside fix rounds, follow-up review prompts, or the implementer prompt — those constraints land in later phases of the review-loop-authorization plan.

## Reporting cadence

- Entering each step: one line. Example: `Plan ready, sending to Opus for plan review (round 1/4)`.
- Each loop iteration: one line with verdict summary. Example: `Opus review round 2/4: REVIEW_BLOCKING (3 items). Dispatching the fixer (Luna max).`
- Do **not** narrate polling ("still running...", "elapsed 40s").
- End of turn: 1–2 sentences — what changed, what's next.

## Red Flags — never

- **Write production code, tests, or any source edit on the main thread** (Rule 1 at the top — repeated here because it's the one that gets broken). If you are reasoning towards "but this file is tiny / I already understand it / it's just the test part" — STOP and dispatch a subagent.
- **Do research on main** — `Read`/`Grep` on source, running `pytest` / linters / build scripts, reading plan body beyond frontmatter (Rule 2). If you are reasoning towards "but I just need to see what's failing / what the current code looks like / what this error means" — STOP and dispatch Explore.
- Do architectural judgment (plans, reviews, BLOCKED diagnosis) on main — always dispatch the plan writer or an Opus subagent.
- Offer, suggest, or default to `--effort ultra` — ultra is exclusively user-initiated. If the user didn't say "ultra", it does not exist.
- `Agent(subagent_type="codex:codex-rescue", ...)` or `Bash("codex exec ...")` — both silently auto-reject.
- `--resume-last` anywhere in this protocol — positional resume lands in whatever thread happens to be newest, regardless of role. All resumes are `--resume-task <task-id>` against the SAME role's prior dispatch; a wrong resume poisons the thread with another role's instructions. Control review rounds 2+ stay FRESH by design.
- Skip Step 4.1 and go straight to 4.2 — Opus review is always first; Codex xhigh is a control, not primary.
- Start (or resume) the fused review without a `GATE_OK` from Step 3.5 on the current tree state — reviewers read code; the gate is what proves the tree builds and its tests pass.
- Run the verification gate on the main thread ("it's just pytest") — the gate is a dispatched Sonnet subagent, per Rule 2.
- Run 4.2 if 4.1 returned BLOCKING — save the dispatch.
- Dispatch a reviewer (4.1, 4.2, or Step 5) without THIS round's freshly generated review package — run `"$RPKG"` first and name the printed path in the prompt.
- Tell a reviewer what not to flag, or pre-rate a finding's severity in the dispatch prompt ("treat it as Minor at most") — referencing already-triaged ledger entries by id is the only allowed form (see the anti-coaching scan).
- Triage a `plan-mandated` finding into ACCEPTED or REJECTED_BY_SCOPE — its only ledger decision is `ESCALATED_TO_HUMAN`.
- Re-dispatch a phase whose frontmatter status is `done` — after any compaction or resume, check the frontmatter and `git log` first (see "## Durable Progress").
- Mark a phase done while a CANNOT_VERIFY item is still open.
- Dispatch one fixer per finding in Step 5 — the final-review fix wave is ONE Codex task with the complete list.
- Skip Step 5, or archive the plan before it returns `REVIEW_OK`.
- Accept "close enough" on spec compliance.
- Loop past cap=4 (Step 5: cap=2) without escalating.
- Commit unrelated uncommitted changes along with the task's diff.
- Run two write-implementers in the SAME working tree, or more than 2 write tasks at once — parallel tracks exist ONLY as separate worktrees, max 2.
- Parallelize phases the approved plan did not mark with a shared `parallel_group` — sequencing is the plan writer's call, not yours.
- Resolve merge conflicts between tracks yourself — a conflict falsifies the plan's independence claim; abort and escalate.
- Delete a worktree with unmerged work.
- Push, force-push, or skip hooks.
- Start work on `main`/`master` without user's explicit consent.
- Let a nit block progress.

## Prompt templates (siblings)

- `./codex-plan-writer-prompt.md` — Codex Sol max, plan writing / revision (Step 1 + Step 2 Mode B)
- `./opus-plan-reviewer-prompt.md` — Opus subagent, plan review (Step 2)
- `./implementer-prompt.md` — Codex Luna max, implementation + fix rounds (Step 3 / Step 4, non-frontend phases)
- `./claude-frontend-implementer-prompt.md` — Claude subagent (Opus / Sonnet), implementation (Step 3, frontend-only phases)
- `./verification-gate-prompt.md` — Sonnet subagent, verification gate (Step 3.5)
- `./opus-review-prompt.md` — Opus subagent, code review (Step 4.1, fused spec + quality)
- `./codex-control-review-prompt.md` — Codex xhigh, control review on diff (Step 4.2)
- `./synthesize-review-prompt.md` — Sonnet subagent, review synthesis (Step 4.5)
- `./final-review-prompt.md` — Opus subagent, final whole-branch review (Step 5)
- `./sonnet-quickfix-prompt.md` — Sonnet subagent, trivial path
