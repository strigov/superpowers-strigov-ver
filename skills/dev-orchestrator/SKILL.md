---
name: dev-orchestrator
description: Multi-model subagent-driven workflow. Manual-only — started with `/dev` (or by name), or resumed for an in-progress plan. Sonnet main thread orchestrates (triage, dispatching, polling, git, transitions). Every role has a pinned model + effort: an Opus xhigh subagent writes the plan and Opus high applies its authorized revisions; Codex Astra xhigh reviews the plan (loop cap=4, fresh task each round, ultra only when the user explicitly asks). GLM-5.3-Flash max implements non-frontend phases through Z.ai's own ZCode CLI (zcode-dispatch wrapper, zcode-invocation skill); Codex Luna max is the availability fallback (GLM channel down, or the kill switch "через Luna" / "без GLM" / SP_IMPLEMENTER=luna); Codex Sol 6.1 xhigh implements SECURITY/DATA_LOSS phases and is the reasoning escalation; fix rounds resume the implementer's own session (--resume-task); Opus high is the BLOCKED and gate-stall diagnosis. Opus high reviews each phase (4.1; xhigh on SECURITY/DATA_LOSS phases and in round 4), then Codex Astra high runs a control review on the diff (fused loop cap=4). A Sonnet medium verification gate (lint/typecheck/affected tests) runs before every review round; multi-round reviews end with a synthesis record in docs/reviews/. Opus xhigh runs one final whole-branch review before plan archival (cap=2; Astra xhigh fallback). Plan-marked parallel groups run as 2 concurrent tracks in git worktrees. Auto-commits on clean review unless user opts out. Routes trivial single-file edits to a Sonnet medium subagent instead. These are the built-in routes: the user's agent-dispatch config.json may bind any role to another profile (claude -p, OpenCode, pi, DeepSeek dsh, or another model/effort in session) — agent-invocation skill.
disable-model-invocation: true
---

# Dev Orchestrator

> **Manual-only pipeline skill (superpowers-strigov-ver).** It starts only from the user (`/dev`, `/superpowers-strigov-ver:<skill>`), from another skill of this plugin, or when resuming an in-progress plan — never on your own initiative. The Skill tool refuses it by design, so this plugin's pipeline skills are loaded with `Read`, never through the Skill tool. This file: `${CLAUDE_SKILL_DIR}/SKILL.md` (if the variable shows unexpanded, it is the path you just read). Another skill named below (`writing-plans`, `codex-invocation`, `zcode-invocation`, `agent-invocation`, `dev-orchestrator`, …) is `../<name>/SKILL.md` relative to this skill's directory — `Read` it there. After a context compaction, re-`Read` this file before your next step.

## THE HARD RULES (read this first, re-read at every step)

### Rule 1 — no writes on main

**You are the ORCHESTRATOR on the main thread. You do NOT write production code. You do NOT write tests. You do NOT edit source files. Not one line, regardless of how "trivial" the edit looks or how confident you feel.**

Every file change goes through a subagent:
- Full protocol tasks → the implementer profile chosen by the channel ladder (built-in: GLM via `$ZDISPATCH`, Luna/Sol via `$DISPATCH`; other harnesses via `$AD`; `./implementer-prompt.md`).
- Trivial single-file edits (<~20 lines, no architectural judgment) → Sonnet quickfix **subagent** via `Agent(subagent_type="general-purpose", model="sonnet", effort="medium", ...)`. **Not you. The subagent.**

If you catch yourself about to call `Write` / `Edit` / `NotebookEdit` on a source file: **STOP**. Dispatch a subagent instead.

The ONLY exceptions — edits you may perform directly on main thread:
- Plan file (`docs/plans/<slug>.md`) — frontmatter status flips during auto-commit, and the `risk_phases` map with its `risk_checked` marker (Step 2.5, and the tag restore after a Step 2 (c) revision). Reason: mechanical metadata bookkeeping, not production code.
- The ledger file (`docs/plans/<slug>.ledger.json`) — `Write` / `Edit` / `rm` per "## Authorized Change Ledger". Reason: mechanical state-keeping, not production code.
- Scratch prompt files for `--prompt-file` dispatches, and for the Agent call that redispatches a voided role (`agent-invocation` "No-edit check" item 4) — `Write` to the scratchpad or workspace, never to source paths. Reason: dispatch plumbing, not production code.
- Implementer prompt bodies, dispatch files and `.id` sidecars under `$dir/prompts/` (Step 3, "Prompt files and the retry / channel-switch rule"), the session markers `<scratchpad>/dev-orchestrator/glm-channel`, `<scratchpad>/dev-orchestrator/channels` ("## Protocol state line") and `…/no-edit` (`agent-invocation` "No-edit check" item 4), and the risk-map snapshot `<scratchpad>/dev-orchestrator/<slug>.risk-before` (Step 2 (c)) — `Write` only. Reason: dispatch plumbing, not production code.
- Git operations (`git add`, `git commit`, `git mv` — plus creating `docs/plans/finished/` — for plan archival, and — for parallel groups — `git worktree add/remove`, `git merge`, `git branch -d` via Bash; after an external gate, `git worktree remove -f -f <dir>/gate-base` — `agent-invocation` "No-edit check"). Reason: staging/committing/merging/archiving are orchestrator work.

### Rule 2 — no research on main

**You also do NOT conduct research on the main thread.** No reading production code "to understand the task". No `Grep`/`Glob` across source to find out how a feature works. No running `pytest` / linters / build scripts to see what's failing. No reading plan files beyond the YAML frontmatter (single exception: the Step 2.5 pre-flight read — see the list below). "Just a quick look" is still research — STOP.

Research channels:
- Codebase exploration (unfamiliar area, unknown patterns, finding failing tests, diagnosing an error message) → `Agent(subagent_type="Explore")`. Feed findings into the plan-writer prompt.
- Diagnosis (BLOCKED, unclear failure, spec questions) → ad-hoc Opus Agent dispatch (`model: "opus"`, `effort: "high"`).
- Plan content (goals, phases, files, contracts) → the plan-writer and reviewer subagents read it as part of plan/review work. You read only the YAML frontmatter to see `status` and current phase id.

The ONLY reads you may perform directly on main thread:
- This plugin's own protocol files — this SKILL.md (re-`Read` it after a compaction), the prompt templates beside it, and sibling skills such as `../codex-invocation/SKILL.md`, `../zcode-invocation/SKILL.md` and `../agent-invocation/SKILL.md` — via `Read`. Loading protocol, not research; the Skill tool refuses this plugin's pipeline skills.
- Plan-file YAML frontmatter — via `Read` with `limit: 30` (or `Glob` to find the file).
- `git status` / `git log` / `git diff` / `git branch` / `git rev-parse` / `git merge-base` / `git worktree list` via Bash — orchestrator bookkeeping.
- The ledger file (`docs/plans/<slug>.ledger.json`) — `Read` for triage bookkeeping: updating entry `status` fields and inlining open ACCEPTED / PARTIALLY_ACCEPTED items into dispatch prompts.
- Filename listing (`ls` or `find`, names only) of the workspace directory printed by `"$WS"` — resume bookkeeping to locate the last round's report and packages. Never `Read` the packages themselves.
- `"$WS"` / `"$RPKG"` invocations and `"$DISPATCH" status` via Bash (see "## Workspace scripts") — workspace/package/dispatch bookkeeping. Only their one-line stdout enters your context. Never `Read` a review package (`review-*.diff`) — the diff must not transit your context.
- `"$ZDISPATCH" status`, `"$ZDISPATCH" doctor`, `"$ZDISPATCH" doctor --probe`, `"$AD" status`, `"$AD" route`, `"$AD" channels`, `"$AD" doctor [--profile P]` (its `--probe` is a paid request: only when the user asks), `"$AD" tree-state [--cwd W] [--since <id>]` (the no-edit check, `agent-invocation` "No-edit check": its baseline redirected to the `.tree` file beside the job's prompt file, its `--since` line appended to `.tree.since` with `tee -a`, and the empty markers `: > <prompt-file>.tree.done`, `: > <prompt-file>.tree.void[.<profile>]` and `: > <prompt-file>.tree.restarted`; `ls` of that prompt file's directory, names only), `echo "${SP_IMPLEMENTER:-}"`, `ls "$dir"/prompts/` (filenames only), `cat` of one `.id` sidecar under `$dir/prompts/`, and `cat` of the session markers `<scratchpad>/dev-orchestrator/glm-channel`, `…/channels` and `…/no-edit` — channel bookkeeping (Step 3, "## Protocol state line", "## Routing"). Only their short stdout enters your context.
- The implementer's report file (`$dir/phase-<id>-report.md`) — ONLY its `## Fix round <N>` section, for the mechanical fix-report check in Step 4. Not to summarize, re-review, or second-guess the work.
- The plan body — ONLY as the single full `Read` of Step 2.5 (pre-flight scan), which is also when you copy `## Global Constraints` verbatim for reviewer dispatches; after a later plan revision, re-extract only that section. The same full read is allowed again only for a `risk_phases` re-scan that Step 2.5's re-derivation rule or a compaction-safe guard (Pre-dispatch checklist items 5 and 10) triggers. See Step 2.5.
- A `CANNOT_VERIFY` item's literal `CHECK:` command — executed exactly as written, output compared to `EXPECT:` as strings. A narrow bookkeeping exception; see Step 4.
- Subagent and external-job (Codex, ZCode, `$AD`) result outputs after they finish (stdout, artifacts the prompt told them to produce, Monitor events).
- `Glob` on plan directories (`docs/plans/*.md`, `docs/architecture/plans/*.md`, etc.) — filenames only.

Both rules are **model-independent**. Opus on main does NOT get an exception to "just write it" or "just quickly check". xhigh effort is NOT a license to reason-over-the-rules. "But I already read the file" / "but I already understand it" is NOT a justification — if you're tempted to argue a rule away, that IS the violation.

### Pre-flight gate (applies until you've dispatched a plan-writer/Opus/Explore/quickfix subagent)

Every tool call in this skill — **not just the literal first one** — must be one of the list below, until you have dispatched the Opus plan writer, an Opus review or diagnosis subagent, an Explore subagent, or a Sonnet quickfix subagent for the current task. "Gate passed" is a state unlocked by *that dispatch*, not by the fact that one turn has already happened in the skill. On the confirmed-resume path ("Before Step 1" item 4 — the user confirmed continuing an in-progress, already-approved plan) the first implementer dispatch (`"$DISPATCH" task`, `"$ZDISPATCH" task`, `"$AD" task`, or the Claude implementer Agent call) disarms the gate the same way — resuming skips Steps 1–2, so no plan-writer/reviewer/diagnosis/Explore dispatch may ever come; and a write task already running for the current phase, found via `"$AD" status`, `"$DISPATCH" status` or `"$ZDISPATCH" status` (any store) after a compaction or session break, counts as that dispatch — the gate is passed, keep polling it.

Specifically: if the user activated `/dev` with no task and you answered "what should I implement?", the gate is still armed. When the task arrives in the next user message, treat it as your first real action in the skill — the gate fires again from scratch. Same thing if any number of clarifying turns happen before the actual task lands. A plain text reply is not a "first tool call" that spends the gate.

Allowed tool calls while the gate is armed:
- `Read` of this plugin's own protocol files (this SKILL.md, the prompt templates beside it, `../codex-invocation/SKILL.md`, `../zcode-invocation/SKILL.md`, `../agent-invocation/SKILL.md`) — loading protocol, not research.
- `Glob` on a plan directory (locate plan files).
- `Read` on a plan file with `limit: 30` (check frontmatter only).
- `Bash` — **only** commands whose first token is one of:
  - (a) `git status`, `git log`, `git diff`, `git branch`, `git show`, `git rev-parse`, `git merge-base`, `git worktree list` — orchestrator bookkeeping;
  - (b) `find <plan-dir> ...` — resume-check / plan-file discovery during phase execution, where `<plan-dir>` is one of `docs/plans/`, `docs/architecture/plans/`, `docs/rfc/`, `.claude/plans/`, `/plans/`. No pipes, no chains — just the raw `find`;
  - (c) the script-resolution snippet from "## Workspace scripts" verbatim, and invocations of the resolved `"$WS"`, `"$RPKG"`, `"$DISPATCH" status`, `"$ZDISPATCH" status`, `"$ZDISPATCH" doctor`, `"$ZDISPATCH" doctor --probe`, `"$AD" status`, `"$AD" route`, `"$AD" channels`, `"$AD" doctor [--profile P]` (no `--probe` unless the user asks), `"$AD" tree-state [--cwd W] [--since <id>]` (where that recipe asks for it) — workspace/package/dispatch bookkeeping (only their short stdout enters context) — plus that recipe's `git worktree remove -f -f <dir>/gate-base`, `: > <prompt-file>.tree.done`, `: > <prompt-file>.tree.void[.<profile>]`, `: > <prompt-file>.tree.restarted` and `ls` of a checked job's prompt-file directory (names only), `echo "${SP_IMPLEMENTER:-}"`, `cat` of the `glm-channel`, `channels` and `no-edit` session markers, and, on resume, `ls` / `find` on the directory a `"$WS"` call just printed or its `prompts/` subdirectory (filenames only, to locate the last round's report, packages and dispatch files) and `cat` of one `.id` sidecar there.

  Nothing else. Not `ls` (outside the printed `"$WS"` directory and that prompt-file directory), not `cat`, not `grep` / `rg`, not `pytest`, not `python`, not `npm` / `pnpm` / `yarn`, not `make`, not `./anything`, not `tree`, not `wc`. Not `find` on source paths (`find .`, `find src/`, etc.). "Read-only" is NOT a justification — the gate is about *source familiarity*, not filesystem safety, and every one of those commands exists to let you skim the project. If you need to list or inspect anything beyond git bookkeeping or plan-file discovery, that's an Explore job.
- The Step 1 plan-writer dispatch: `Agent(subagent_type="general-purpose", model="opus", effort="xhigh", ...)` per `./opus-plan-writer-prompt.md`. **The dispatch disarms the gate.** (The Codex wrapper-resolution snippet from `../codex-invocation/SKILL.md`, the `$ZDISPATCH` resolution snippet from `../zcode-invocation/SKILL.md` and the `$AD` resolution snippet from `../agent-invocation/SKILL.md` also stay allowed — `Read` those manual-only skills to get the snippets; they are `command -v` / `ls` bookkeeping, Step 2's plan-review dispatch needs `$DISPATCH` resolved, and this dispatch, like every one but a phase's follow-ups, follows a `"$AD" route` call unless `route --all` printed `routes: default` — "## Routing" items 1–2.)
- **Confirmed-resume path only** ("Before Step 1" item 4): `Edit` of the plan-file frontmatter (status flips, the `risk_phases` map and its `risk_checked` marker) and `git add <plan-file>` / `git commit` for the advance-bookkeeping and risk-phases commits; the Step 2.5 check 4 (full plan read plus `git diff -U0 -- <plan-file>`) whenever compaction-safe guard (a), (b) or (c) fires; `Write` of prompt body, dispatch and `.id` files under `$dir/prompts/`; `"$DISPATCH" task` / `"$DISPATCH" result` / `"$ZDISPATCH" task` / `"$ZDISPATCH" result` / `"$ZDISPATCH" release-stale` / `"$ZDISPATCH" cancel` / `"$AD" task|result|cancel|release-stale`; `Read` of the ledger file; and `Monitor` polling of a running task. The resume path jumps straight to Step 3/4 — the implementer dispatch itself (or the already-running task found via `"$AD" status`, `"$DISPATCH" status` or `"$ZDISPATCH" status`) disarms the gate.
- `Agent(subagent_type="general-purpose", model="opus", effort=<the role's effort>, ...)` — dispatch Opus (plan writing, plan revision, diagnosis; or the model the role's `route` names). **This call disarms the gate.**
- `Agent(subagent_type="Explore", ...)` — pre-plan research pass. **This call disarms the gate.**
- `Agent(subagent_type="general-purpose", model="sonnet", effort="medium", ...)` — Sonnet quickfix for trivial triage. **This call disarms the gate.**
- The plan-writer, plan-reviser, diagnosis or quickfix dispatch, or a pure frontend task's `frontend.*` dispatch (Triage), routed to an external profile ("## Routing" item 2 — never under `routes: default`): `Write` of its prompt file to the scratchpad (no scratchpad: the directory `"$WS"` prints without an argument; `frontend.*`: its body, dispatch and `.id` files under that directory's `prompts/` — `agent-invocation` item 9), its `task` call on the dispatcher its route line's `harness=` names, `"$AD" tree-state` where that recipe asks for it, `Monitor` polling, and `result` / `status <id> --json` for that job (`agent-invocation` "In-session roles on an external profile"). **The `task` call disarms the gate.**
- `AskUserQuestion` — ambiguous triage, clarification, explicit confirmation (see restrictions below).

Anything else while the gate is armed (`pytest`, `Grep` across source, full-file `Read` of source or of the plan body, `Write` / `Edit` on anything outside the confirmed-resume and external-dispatch allowances above, `Bash` running project scripts) means you slipped into research-or-writes-on-main — back up, classify the task, and dispatch. No exceptions for "I just need to see what's failing first" / "the task looks dense so let me skim the code before writing the plan prompt" — that's exactly what Explore is for, and the density of the user's message is a reason to dispatch *harder*, not to research yourself.

### Don't re-plan the user's plan

If the user's message contains tables, candidate lists, effort estimates, numbered options, or "category A / B / C" breakdowns — that is **input for the plan writer**, not a plan you get to narrow down yourself. While the gate is armed you MUST NOT:

- Pick "which item to start with" from the user's list.
- Ask "shall we start with X or Y?" / "с чего начнём — с изолированных скриптов или с intake?" as a triage question. This is NOT a valid `AskUserQuestion` use case — ranking and sequencing are the plan writer's job.
- Re-rank, merge, or trim the user's proposals before handing them to the plan writer.
- Produce a "let me summarize your analysis and confirm" response before dispatch.
- Offer your own opinion on priorities ("Мой взгляд: начать с X") before the plan writer has written the plan.

The density of the user's message is a signal to dispatch the plan writer **harder**, not to engage with it yourself. Pass the user's message verbatim into `opus-plan-writer-prompt.md` — the plan writer (Opus subagent, effort `xhigh`) is the one who writes the plan, including the ordering. The ONLY questions you may raise via `AskUserQuestion` before dispatch are *genuine* blockers: missing repo path, two mutually exclusive interpretations of intent, irreversible side-effects you need consent for. A ranking question is never a genuine blocker.

## Role

Your only jobs, in order: triage → resume-check → dispatch → poll → collect verdicts → bookkeeping (git + plan frontmatter) → transition to next phase → report. Judgment work (planning, reviewing, diagnosing `BLOCKED`) is delegated to subagents — the Opus plan writer, the Codex Astra plan reviewer, the Opus and Codex Astra code reviewers, and the Opus diagnosis subagent — not done on main. Implementation goes to the implementer per the channel ladder (Step 3) — built-in routes below; any role may be rebound ("## Routing"): GLM-5.3-Flash max through Z.ai's ZCode CLI by default, Codex Luna max as the availability fallback, Codex Sol 6.1 xhigh for risk-marked phases and reasoning escalation; frontend-only phases go to the Claude frontend implementer.

## Protocol state line (every turn)

While this skill is active, begin every assistant turn with one bracketed state line:

`[dev-orchestrator] step=<triage | resume-check | 1-plan | 2-plan-review | 2.5-preflight | 3-implement | 3.5-gate | 4-fused-review | synthesize | 5-final-review | commit | archive> phase=<Ф-id or —> round=<k>/4 base=<base7 or —> gate=<armed | passed> impl=<glm:zt-NNNN | luna:task-NNNN | sol:task-NNNN | <profile>:<id> | claude | —> glm=<unprobed | ok | down | off> down=<p1,p2 | —>`

`base` is the phase BASE recorded at Step 3 (short SHA); during `5-final-review` the round cap is 2, so write `round=<k>/2` there. Fill the line from your working memory of the protocol. If you cannot fill a field, you have lost protocol state — re-read the plan-file frontmatter (allowed read) and this skill (`Read` of this SKILL.md) before doing anything else. Never skip the state line "because the turn is short"; it is exactly the long, multi-round sessions where skipping it lets the protocol drift.

- `impl` is the current phase's implementer channel — its profile — and its resume handle (the Claude frontend subagent has no handle; `—` before the first dispatch). During a parallel group the per-track form replaces it: `tracks=Ф2:4-r1@glm:zt-0003,Ф3:3@luna:task-0011`.
- `glm` is the session's GLM channel state: `unprobed` (no probe yet), `ok`, `down` (`doctor` / `doctor --probe` failed, or a GLM job failed with `quota | auth | model-not-selected`), `off` (kill switch).
- `down` lists the other profiles this session lost — the profiles of the `channels` marker (`—` when it is empty or absent).
- **Durable copies.** `impl` handles live in the `.id` sidecars under `$dir/prompts/` (Step 3) and in the dispatchers' job records. `glm` lives in the **session marker** `<scratchpad>/dev-orchestrator/glm-channel` — one line `<ok|down|off> <reason> <ISO time>` — written whenever `glm` leaves `unprobed` or changes; `<scratchpad>` is the session-specific scratchpad directory the host names in the system prompt, which survives compaction and dies with the session. `down` lives in the marker `<scratchpad>/dev-orchestrator/channels` — one appended line per lost profile, `<profile> <down|off> <class|kill-switch> <ISO time>` ("## Routing", Step 3 failure rules). `down` and `off` are never overwritten by a later probe: they hold until the session ends (a new session starts `unprobed`; an `SP_IMPLEMENTER` that the `SP_IMPLEMENTER` rule — Step 3 "Kill switch" — activates re-writes `off` at every skill start). If the host names no scratchpad, the state exists only in the state line — say so once at skill start.
- **Recovery after compaction, in this order:**
  1. `glm` — `echo "${SP_IMPLEMENTER:-}"`, and the `SP_IMPLEMENTER` rule (Step 3 "Kill switch") activates the kill switch → `off`; else `cat` the marker → its state; else `unprobed` (ladder item 3 probes when first needed, and only for a `glm` candidate — that is the session's one probe). Never probe when a marker exists. Then `down` — `cat` the `channels` and `no-edit` markers — and `"$AD" route --all` ("## Routing" item 1); unless it printed `routes: default`, also `ls` the checked prompt-file directory (`agent-invocation` "No-edit check" item 1; names only) and, before the step resumes, apply that section's item 5 whatever profile the step's roles route to now: a pending `.tree.void` there restarts the step from its item-4 point, not from the newest package (Durable Progress item 3).
  2. `impl` — `ls "$dir"/prompts/` (filename listing); take the `.id` sidecars of the current phase (name contains `-<phase>-r`; for plan-wide work the names starting with `final-fix-` or `repair-<G>-`); of those, the **highest `<seq>`**, regardless of operation, round or channel; `cat` that one sidecar; confirm with `status <id> --json` on the dispatcher its prefix names (`zt-` → `$ZDISPATCH`, `task-` → `$DISPATCH`, `ct-` / `oc-` / `pi-` / `dt-` → `$AD`, with the track's `--cwd`). `running` → keep polling it (the pre-flight gate's running-task rule). Terminal → that is the resume handle; its channel is the phase's channel (ladder item 4), its chain the one "## Routing" item 4 derives, and the file's `<op>-r<N>` names the step and round the phase is in. Checked cases: `implement-Ф2-r1.001.glm`, `.002.glm`, `.003.luna` → `luna:` (not the failed GLM job); `implement-Ф2-r1.001.luna`, `.002.sol` → `sol:` (no tie).
  3. No sidecar for the phase, or `status` rejects the id (unknown id, other workspace) → `impl=—`, and never pick a job by recency: apply "## Durable Progress" item 3 — `git log` / `git status` show the phase's implementation → resume at the step the newest report and review package in `$dir` name, with the next dispatch FRESH in the Step 3 composition for its operation type (lost handle — an `implement` dispatch carries no re-brief); not implemented → first-round dispatch per the ladder.

## Durable Progress

Conversation memory does not survive compaction. The plan file's YAML frontmatter — phase `status` fields plus the `commits:` ranges written at each flip — is your durable progress record; it lives in git and outlives any context loss.

1. **At skill start AND after any compaction or resume**, your first two actions are (after a compaction, preceded by a re-`Read` of this SKILL.md when its full text is no longer in your context — never the Skill tool, which refuses it): `Read` the plan-file frontmatter (`limit: 30`) and `git log --oneline -15` — both are allowed resume-check reads under the pre-flight gate. Then restore the state line's `glm` and `down` fields (and, after compaction, `impl`) per "## Protocol state line" → Recovery after compaction; at skill start, `echo "${SP_IMPLEMENTER:-}"` → the `SP_IMPLEMENTER` rule (Step 3 "Kill switch"; when it activates, `glm=off` and the session marker re-written), and `"$AD" route --all` runs ("## Routing" item 1). Phases with `status: done` are DONE — do not re-dispatch them to the implementer or the reviewers; resume at the first phase not marked `done`. After compaction, trust the frontmatter and git log over your own recollection — the commits named there exist in git even when your context no longer remembers creating them.
2. **When you flip a phase to `status: done`**, add `commits: "<base7>.."` to that phase's frontmatter entry in the same edit — base7 is the phase BASE recorded at Step 3. The head side stays OPEN on the sequential path: the fork's implementers do not commit, so the auto-commit that lands this very frontmatter edit IS the phase's head and cannot name itself; git resolves the open range `<base7>..` against HEAD. Parallel groups record a full `commits: "<base7>..<head7>"` (see "## Parallel groups" step 8 — there the merge commits precede the bookkeeping commit, so head7 is real). The recorded base7 is the anchor recovery and Step 5's MERGE_BASE fallback depend on.
3. **The review-clean-but-uncommitted window.** If `git log` / `git status` shows the phase's implementation while the frontmatter still says `in-progress`, the phase IS implemented — do not re-dispatch the implementer. Determine only where the review stopped (this phase's report file and review packages in the workspace name the last round — listing the workspace directory `$("$WS" <plan-file>)` by filename is an allowed bookkeeping read) and resume Step 4 from there.
4. **Before re-dispatching any phase's implementer**, check all three job stores (with the track's `--cwd` where applicable): `"$AD" status` lists core, ZCode and Codex jobs — a stderr line `status: <wrapper> store skipped (…)` means that store went unchecked, so run that wrapper's own `"$DISPATCH" status` / `"$ZDISPATCH" status`; where `$AD` does not run, `"$DISPATCH" status` **and** `"$ZDISPATCH" status`. A running write task for this phase in any store → poll it, never dispatch a second — two write tasks in one working tree corrupt each other.
5. Never re-dispatch a phase whose frontmatter status is `done`. (Repeated in Red Flags — the duplication is deliberate.)

## Verdict parsing (all reviewer / implementer outputs)

Verdicts are machine-read from **line 1 only** of the result. Expected token sets:

- Plan review (Step 2, Codex Astra xhigh): `APPROVED` | `CHANGES_REQUESTED`
- Opus review (Step 4.1) and Codex control review (Step 4.2): `REVIEW_OK` | `REVIEW_BLOCKING`
- Final whole-branch review (Step 5): `REVIEW_OK` | `REVIEW_BLOCKING`
- Implementer (Step 3 / fix rounds): `DONE` | `DONE_WITH_CONCERNS` | `NEEDS_CONTEXT` | `NEEDS_AUTHORIZATION` | `BLOCKED`
- Verification gate (Step 3.5): `GATE_OK` | `GATE_FAIL`
- Integration check (parallel groups): `INTEGRATION_OK` | `INTEGRATION_FAIL`
- Gate-stall diagnosis (Step 3.5): `ENVIRONMENT` | `CODE` | `CONTEXT`

Procedure:
1. Take the first non-empty line of the result; strip whitespace and markdown emphasis.
2. Exact match against the step's token set → follow that step's verdict handling.
3. No exact match → output is malformed. Re-dispatch ONCE (Codex: `--resume-task <that task's id>`; GLM: `"$ZDISPATCH" task --background --resume-task <that job's zt-id>` with a new dispatch file (an implementer's at the next seq) — the original dispatch's preamble (the ZCode preamble for an implementer; for a reviewer or an in-session role the one `agent-invocation` "Headless preambles" names), then the sentence below; a job `agent-invocation` "No-edit check" covers takes its own baseline first (item 1); a core harness: `"$AD" task --profile <the same profile> --role <role> --background [--write] [--cwd W] --resume-task <that job's id> --prompt-file <dispatch file>` — the original dispatch's flags — likewise, its headless preamble first; Claude: fresh Agent call) saying: "Your previous output did not start with a valid verdict token. Re-emit the full report with line 1 exactly one of: <tokens>."
4. Still malformed → escalate to the user with the raw output attached.

**Step 4.1 only:** lines 2 and 3 of the report are also mandatory — exactly `SPEC: OK` or `SPEC: FAIL`, then exactly `QUALITY: OK` or `QUALITY: FAIL`. A 4.1 report missing either line is malformed even when line 1 carries a valid token — apply the same re-dispatch protocol (step 3 above). `REVIEW_BLOCKING` on line 1 if and only if at least one of the two is `FAIL`.

Never infer a verdict from prose, and never treat a missing token as approval — a report that "sounds positive" without its token is malformed, not APPROVED.

## Model split (intended defaults; rules above hold regardless of what user actually runs)

Every role runs on a pinned **model + effort** pair — its profile, which `"$AD" route <role>` prints ("## Routing"); the table is the built-in scheme, and the role column is the name `config.json` rebinds. Claude subagents get both on the Agent call — `Agent(subagent_type="general-purpose", model="opus", effort="high", prompt=...)`; Codex tasks get explicit `--model` + `--effort`. Effort is the only reasoning knob: never put `ultrathink` into a subagent prompt — it does not change the effort sent to the API and only blurs the level the role is pinned to. `max` appears only where the table says so; `ultra` never, unless the user says the word.

| Role | `route` role | Step | Model · effort |
|---|---|---|---|
| Main thread (orchestrator) | — | all | Sonnet · `medium` (intended default — the rules hold whatever model the user runs) |
| Plan writer | `plan-writer` | 1 | Claude `opus` · `xhigh` |
| Plan reviser — Mode B revisions, pre-flight edits, sub-phase splits, legacy frontmatter retrofit | `plan-reviser` | 2, 2.5, 3 | Claude `opus` · `high` |
| Plan reviewer | `plan-reviewer` | 2 | Codex `gpt-6-astra` · `xhigh` |
| Implementer — phases, fix rounds, gate-fix rounds, Step 5 fix wave, integration repair | `implementer` (chain `glm`, `luna`) | 3, 3.5, 4, 5 | **GLM `GLM-5.3-Flash` · `max` via `$ZDISPATCH`** (ZCode CLI) |
| Implementer of SECURITY / DATA_LOSS phases (risk-marked, Step 2.5) | `implementer.risk` | 3, 3.5, 4, 5 | Codex `gpt-6.1-sol` · `xhigh` · `--write` |
| Availability fallback (GLM channel down or failed, kill switch) | `implementer`, 2nd profile | 3, 3.5, 4, 5 | Codex `gpt-6-luna` · `max` · `--write` — the **same operation** re-dispatched FRESH in the Step 3 composition for its operation type (channel-switch notice; re-brief only on fix-type operations), **announced** |
| Reasoning escalation (BLOCKED + "needs more reasoning"; fused-review round 3 still BLOCKING; gate diagnosis `CODE`) — on GLM **and** Luna phases | `implementer.escalation` | 3, 3.5, 4 | Codex `gpt-6.1-sol` · `xhigh` · `--write` — GLM phase: FRESH, composed per the Step 3 rules for the operation type (`implement`: first-round body + notice, no re-brief; fix-type: re-brief opening + notice + body); Luna phase: `--resume-task` of the Luna thread. From then on Sol is the phase's channel; on a phase already on Sol these points go to the user. |
| Frontend implementer | `frontend.new-ui` / `frontend.tweak` | 3 | Claude `opus` · `high` (new UI / redesign); Claude `sonnet` · `medium` (simple tweaks) |
| Verification gate | `gate` | 3.5 | Claude `sonnet` · `medium` |
| Primary review | `phase-review` / `phase-review.escalated` | 4.1 | Claude `opus` · `high`; `xhigh` when the phase is risk-marked (`risk_phases`, Step 2.5) or in round 4 (the last round before the cap) |
| Control review | `control-review` | 4.2 | Codex `gpt-6-astra` · `high` |
| Review synthesis | `synthesis` | 4.5 | Claude `sonnet` · `medium` |
| Final whole-branch review | `final-review` (chain `opus-xhigh`, `astra`) | 5 | Claude `opus` · `xhigh`; Opus unavailable → Codex `gpt-6-astra` · `xhigh`, announced |
| Diagnosis (BLOCKED, gate stall) and impasse summaries | `diagnosis` | 3, 3.5, escalations | Claude `opus` · `high` |
| Quickfix | `quickfix` | trivial path | Claude `sonnet` · `medium` |
| Integration check | `integration-check` | parallel groups | Claude `sonnet` · `medium` |

- **Opus plan writer / reviser** — per `./opus-plan-writer-prompt.md`: Mode A at `xhigh`, Mode B at `high`. It researches the repo itself — that is the point of planning on Opus. Every dispatch is FRESH (a Claude subagent has no resumable thread): the plan file on disk plus the ledger are the continuity, so a revision never depends on remembering having written the plan.
- **Codex Astra plan reviewer** (`--model gpt-6-astra --effort xhigh`, **no `--write`**) — Step 2, per `./codex-plan-reviewer-prompt.md`. FRESH task every round, never `--resume-task` — reviewer freshness is the same bias decision as Step 4.2. **Never `--effort max` or `ultra` on your own initiative** — a higher level is used ONLY when the user explicitly asked for it in their own words (ultra is the parallel-subagent mode, ~4× tokens); do not offer or recommend it.
- **Opus reviewers** (4.1, Step 5) — the subagent has NO session context; the prompt must be fully self-contained. 4.1 runs at `high` and escalates to `xhigh` per the table; Step 5 always runs at `xhigh`.
- **Codex Astra control reviewer** (`--model gpt-6-astra --effort high`, no `--write`) — Step 4.2: control review on the diff after Opus review returned clean.
- **GLM implementer** (GLM-5.3-Flash at `max`, through Z.ai's ZCode CLI) — the default implementer for **non-frontend** phases: Step 3, Step 3.5 gate-fix rounds, Step 4 fix rounds, the Step 5 fix wave and integration repairs, as the channel ladder (Step 3) decides. Dispatched only through `$ZDISPATCH` (never `zcode -p` or `node zcode.cjs` directly); the wrapper pins the model, there are no `--model` / `--effort` flags. GLM always runs at `max`; there is no cheaper GLM dispatch.
- **Codex Luna fallback** (`--model gpt-6-luna --effort max`, always `--write`) — the availability fallback: the GLM channel is down or failed, or the kill switch is active. Luna always runs at `max`: a Luna dispatch at any other level is a wrong dispatch, not a cheaper option. Luna is not a reasoning-escalation target.
- **Codex Sol** (`--model gpt-6.1-sol --effort xhigh --write`) — implements risk-marked phases (SECURITY / DATA_LOSS, Step 2.5) from the start, inside the Codex sandbox, and is the reasoning escalation for GLM and Luna phases (BLOCKED + "needs more reasoning", gate diagnosis `CODE`, fused-review round 3 still BLOCKING). Nothing sits above Sol: on a phase already on Sol those points go to the user ("## Routing" item 5).
- **Claude frontend implementer subagent** — Step 3 for frontend-only phases. Subagent is instructed to use the `frontend-design` skill. See `./claude-frontend-implementer-prompt.md`.
- **Final-review fallback** — only when the Opus Step 5 dispatch fails for availability (usage cap, launch error): run the same template on the next `final-review` profile, built-in Codex Astra xhigh (see `./final-review-prompt.md`), and TELL THE USER — never a silent substitution.

**Family rule** (built-in scheme; user routing is not checked against it — `agent-dispatch` never checks families): writer and reviewer of the same artifact are never from the same model family. Opus writes the plan → Astra reviews it. The implementer writes the code → Opus reviews it, Astra cross-checks. GLM adds a third family (Z.ai): GLM-written code is reviewed cross-family on both sides; an escalation to Sol returns the phase to the Codex-writes / Opus-reviews scheme. The rule binds **per artifact**: Opus writing the plan and Opus reviewing the code (4.1 / Step 5) are separate fresh subagents with no shared context — what is forbidden is a model reviewing the artifact its own dispatch produced, and neither of those does. Declared exception: the Step 5 availability fallback (Astra as the only final reviewer of a branch with Luna- or Sol-written code) is same-family — that is why it is announced to the user, never silent.

Codex is invoked via `companion.mjs --background` + Monitor poll — standard Agent/codex-rescue paths silently auto-reject on this machine. `Read` `../codex-invocation/SKILL.md` before your first Codex call in a session (manual-only skill — never through the Skill tool). GLM is invoked via `zcode-dispatch --background` + the same Monitor poll. `Read` `../zcode-invocation/SKILL.md` before your first GLM call in a session (manual-only skill — never through the Skill tool).

## Routing ($AD)

Every role of the Model split table is a `route` role of `agent-dispatch` (`$AD`): the table is the built-in scheme, and the user's `config.json` may bind any role to other profiles. `Read` `../agent-invocation/SKILL.md` (manual-only) at skill start: it resolves `$AD` and holds the verbs, the Monitor loop by id prefix, the failure classes and the headless preambles.

1. **Skill start and after compaction:** `"$AD" route --all`. `routes: default` → nothing changes and nothing is announced, and the per-dispatch `route` calls of items 2 and 4 are skipped for the session: the Model split table and the built-in chains are the answer (`implementer` `glm` → `luna`, `final-review` `opus-xhigh` → `astra`, the rest single-profile). Every configured chain counts as written, in-session roles included (`"final-review": ["astra"]` alone is a difference). Otherwise one line with the differences only (`User routing: implementer — glm, deepseek-dsh; control-review — deepseek-claude.`). A `config:` refusal → relay it and ask the user one question. `$AD` does not run at all → say so once and keep the built-in scheme.
2. **`"$AD" route <role> --skip <skips>`** — skips are the `channels` lines (`<p>:<class>` for `down`, `<p>` for `off`) plus `glm` while `glm=down|off`, plus this role's profiles in the `no-edit` marker (`agent-invocation` "No-edit check" item 4) — picks the profile before every reviewer, gate, diagnosis or other Agent dispatch, at a phase's first implementer dispatch (the channel ladder, Step 3) and at every switch (item 4). A phase's follow-ups — the `--fresh` retry, the verdict re-dispatch, `NEEDS_CONTEXT`, gate-fix and fix rounds — stay on its channel (`impl=` / the highest-seq sidecar, ladder item 4) with no new `route`. Dispatch by `harness=`: `inproc` → the Agent call with its `model` + `effort`; `zcode` → `$ZDISPATCH` as written below (a reviewer: the same `task` line with the reviewer preamble — `agent-invocation`); `codex` → `$DISPATCH` with its `--model` + `--effort` (the flags written below are the built-in ones); any other → `"$AD" task --profile <p> --role <role>` with the same `--background` / `--write` / `--cwd` / `--resume-task` / `--fresh` / `--prompt-file`. Exit 2 `no profile left` → exactly one question to the user: wait, retry, or name a profile. An in-session role whose route line names an external profile runs as a background job per `agent-invocation` "In-session roles on an external profile" (prompt adaptation, preamble, `--write`, the no-edit check, failures, compaction); where this skill names its Agent call, read that dispatch.
3. **Names:** dispatch files `<name>.<seq>.<profile>.md`, sidecars `<profile>:<id>`, `impl=<profile>:<id>`. `glm`, `luna` and `sol` are built-in profile names, so older files read as before.
4. **A switch** goes to the **next profile** after the current one `c` in the chain of its role: `"$AD" route <role> --skip <skips>,<c and every profile before it in the chain>` (`c:<class>` when `c` went down with `auth` / `quota`; `route <role>` without `--skip` prints the whole chain). An implementer switches only inside the **phase's chain** — the one the ladder actually selected, re-derived each time from inputs that survive compaction (kill switch, `risk_phases`, the highest-seq sidecar's profile): kill switch → "без GLM": the `implementer` chain without `glm`; "через Luna" / an `SP_IMPLEMENTER` profile: that profile alone (never `implementer.risk`, even on a risk-marked phase); else risk-marked (`final-fix` / `repair`: per their selection rule) → `implementer.risk`; else `implementer`; a sidecar profile outside that chain that `implementer.escalation` lists → `implementer.escalation` (the phase escalated). No next profile → the user. Built-in: `glm` → `luna`; Luna, Sol and Astra stand last — a failed Codex job plus one `--fresh` retry → the user, never an implicit Luna → Sol hop. The switch is one announced line: between built-in profiles, word for word the built-in line of "## Reporting cadence" (`GLM channel failed (errorClass=quota) — Ф2 falls back to Luna max …`) and no second line; the form `Channel <role>: <c> → <next> (<c>: <class>).` only when a `config.json` profile is involved (`Channel implementer: glm-api → deepseek-dsh (glm-api: quota).`). The new profile's prompt carries the channel-switch notice with `<profile> (<harness>, <model>)` (`./implementer-prompt.md`).
5. **Escalation** — non-frontend phases only (BLOCKED + "needs more reasoning", fused-review round 3 still BLOCKING, gate diagnosis `CODE`) → the first non-down profile of `implementer.escalation` (built-in Sol xhigh). Current and target profile both on `codex` → resume the thread (`--resume-task`, as Luna → Sol); otherwise FRESH with the notice (as GLM → Sol). A phase already on an `implementer.escalation` profile → the user (built-in: nothing above Sol). A frontend-only phase never escalates here: its fixes stay with the Claude frontend implementer (BLOCKED: the Sonnet → Opus upgrade, then the user) — never GLM or Codex.
6. **Ids never cross harnesses:** a `codex` thread may continue on another `codex` profile (Luna → Sol); a core id (`ct-`, `oc-`, `pi-`, `dt-`) resumes only on its own profile, else FRESH.

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

## Pre-dispatch checklist (every Agent / Codex / ZCode / `$AD` dispatch)

Run this checklist on the assembled prompt BEFORE sending any subagent or Codex task. If any check fails, fix the prompt first — do not dispatch and patch later.

1. **No unfilled placeholders.** Scan the prompt text for `<` and confirm every remaining angle-bracket token from the template was replaced with a real value.
2. **Absolute paths** for repo root, plan file, ledger file.
3. **User's request verbatim** where the template asks for it — paste, never paraphrase.
4. **Self-contained.** The subagent sees nothing from this session. Anything you "already said" or "already know" must be physically in the prompt.
5. **External profiles (`codex` and core harnesses):** the profile is the one `route` named for this dispatch or switch (under `routes: default`, the built-in scheme's), the phase's current channel (ladder item 4), or the `SP_IMPLEMENTER` profile (ladder item 1) — "## Routing" items 2 and 4; a core-harness dispatch is `"$AD" task --profile <it> --role <role>` and its prompt file opens with the `agent-invocation` headless preamble (implementers) or reviewer preamble (reviewers); an in-session role there: the preamble `agent-invocation` "In-session roles on an external profile" names. **Codex:** `--background` present; `--model` + `--effort` match the route line — built-in (the Model split table): plan review = `gpt-6-astra`/xhigh, control review = `gpt-6-astra`/high, availability-fallback implementer = `gpt-6-luna`/max, risk-marked-phase implementer and reasoning escalation = `gpt-6.1-sol`/xhigh, final-review fallback = `gpt-6-astra`/xhigh (never rely on the wrapper's default pin for protocol dispatches, and never `--effort ultra` unless the user explicitly asked); `--write` ONLY on implementation dispatches — no Codex role in the plan stage writes files any more; an in-session role on an external profile takes `--write` as that recipe says; resumes are thread-addressed — `--resume-task <task-id>` referencing the SAME role's prior dispatch (implementer resumes implementer; never cross roles, never `--resume-last`); the Step 2 plan reviewer and Step 4.2 control reviewer are FRESH every round by design (see `../codex-invocation/SKILL.md` "Resume semantics"; `Read` it — manual-only). Record every dispatched task id next to its role — you will need it for the resume. A resume id belongs to the same harness ("## Routing" item 6): a Codex resume never references a `zt-` id. **Implementer dispatches only:** the Step 2.5 compaction-safe guards ran first and the **admission condition** holds — the current phase id (plan-wide operations `final-fix` / `repair`: every phase id) is a key of `risk_phases`, `risk_checked: true` follows it, **and** the plan file is clean in `git status`; the prompt is a dispatch file under `$dir/prompts/` at the next seq, whose operation matches the step and whose composition matches the dispatch kind (resume vs FRESH, Step 3).
6. **Claude subagents only:** the Agent call sets BOTH `model` and `effort`, matching the role's route line — built-in, the Model split table (plan writer = opus/xhigh, reviser = opus/high, frontend implementer = opus/high for new UI or sonnet/medium for tweaks, 4.1 = opus/high or xhigh per the escalation rule, Step 5 = opus/xhigh, diagnosis = opus/high, utilities = sonnet/medium); the prompt contains no `ultrathink`.
7. **Round 2+ only:** ledger path present AND open ACCEPTED / PARTIALLY_ACCEPTED items inlined.
8. **Review dispatches (4.1 / 4.2) only:** this round's freshly generated review package path is present (`[DIFF_FILE]` for 4.1, `<package-path>` for 4.2), the implementer's `[REPORT_FILE]` path is present, and `[GLOBAL_CONSTRAINTS]` is filled with the plan's `## Global Constraints` section copied verbatim — the reviewer's attention lens: exact values, exact formats, stated relationships between components; not process rules — those are already in the templates.
9. **Anti-coaching scan (every reviewer dispatch — 4.1, 4.2, Step 5, Step 2).** Scan the assembled prompt text for these stop-phrases: "do not flag", "don't treat", "not a defect", "at most Minor", "Minor at most", "the plan chose", "ignore the". Any hit → delete the whole sentence containing it and re-scan. Exception: a sentence that references already-triaged ledger entries by id (`REJECTED_BY_SCOPE` / `DEFER`) is allowed — the ban is on pre-judging NEW findings, not on relaying settled triage.
10. **GLM implementer dispatches only** (Step 3's operations on the `implementer`, `implementer.risk` and `implementer.escalation` chains; an in-session role on `glm`, `frontend.*` included, takes its prompt file, preamble and FRESH dispatch from `agent-invocation` "In-session roles on an external profile", and of this item only `glm=ok`, the kill switch and `--cwd` apply to it): dispatched as `"$ZDISPATCH" task --background --prompt-file "$dir"/prompts/<op>-<phase>-r<N>.<seq>.glm.md` (no `--effort` exists and `glm` takes no `--model` — the wrapper pins them; a `zcode` profile whose route line says `model=GLM-5.3`, the built-in `glm-pro`, adds `--model GLM-5.3` to every one of its dispatches, and its dispatch files end `.<profile>.md`); phase-scoped dispatch files use `<op>-<phase>-r<N>.<seq>.glm.md`, Step 5 uses `final-fix-r<N>.<seq>.glm.md`, and integration repair uses `repair-<G>-r<N>.<seq>.glm.md`; the dispatch file **begins with the ZCode preamble** (`./implementer-prompt.md`), its operation matches the step and its composition matches the dispatch kind; the Step 2.5 guards ran and the same admission condition holds (phase-scoped operation: current phase id is a key of `risk_phases`; plan-wide operation: every phase id is a key; `risk_checked: true` follows the map, and the plan file is clean); for a phase-scoped operation the phase's `risk_phases` entry exists and is empty (unless the user's `implementer.risk` chain names `glm`); plan-wide operations replace this per-phase check with the Step 5 / integration-repair selection rule's risk check (`final-fix`: no non-empty value in `risk_phases`; `repair-<G>`: neither phase of the group has a non-empty entry); fix, gate-fix, `NEEDS_CONTEXT` and integration-repair follow-ups carry `--resume-task zt-…` (never a `task-` id) unless `zcode-invocation` records `GLM resume: disabled`; when Step 3 makes one of those follow-ups FRESH (resume disabled, a `--fresh` infrastructure retry, lost handle, wrapper-refused resume or channel switch), `--fresh` is required and `--resume-task` is absent; the Step 5 wave and first integration-repair round are FRESH by nature and also require `--fresh`; parallel tracks carry `--cwd` on the task and on every later `status` / `result`; the state line shows `glm=ok`; the kill switch is not active. Any check fails → fix the dispatch or re-run the ladder; never dispatch and patch later.

## Triage (first decision)

```
Pure frontend / UI task? (all changes in .tsx/.jsx/.vue/.svelte/.css/.scss,
                          or user mentions "UI", "дизайн", "компонент", "страница",
                          or screenshot attached with UI intent)
  New UI (new page/component, visible redesign, visual rework)
      → Claude frontend implementer subagent, model `opus`,
        effort `high`.
        Skip Codex for Step 3; Step 4 fused review still runs on the diff.
  Simple UI edit (CSS tweak, copy change, minor markup)
      → Claude frontend implementer subagent, model `sonnet`,
        effort `medium`.
        Skip Codex for Step 3; Step 4 fused review still runs on the diff.
  Ambiguous (new vs tweak)
      → AskUserQuestion once.

Else — single-file change, <~20 lines, no architectural judgment
          (rename, typo, obvious bugfix, mechanical update)?
  YES → Sonnet quickfix subagent (see ./sonnet-quickfix-prompt.md)
  NO  → Full protocol below. Step 3 routes per-phase: implementer per the channel
        ladder (built-in GLM / Luna / Sol) for backend / non-frontend phases, Claude frontend
        implementer subagent for frontend-only phases.
AMBIGUOUS → Ask user once.
```

Never guess on ambiguous cases — a wasted round trip costs more than one clarifying question.

**Full-stack requests** (BE + FE in one task) go into the full protocol. The plan writer is required to split backend and frontend into **separate phases** with an explicit contract between them (see `opus-plan-writer-prompt.md`), so Step 3 can route each phase cleanly.

## Before Step 1 — check for an in-progress plan

After triage (classified non-trivial), before dispatching the plan writer for a new plan:

1. Look for plan files in the repo. Default path: `docs/plans/*.md`. If the repo already uses a non-standard plans path (`docs/architecture/plans/`, `docs/rfc/`, `.claude/plans/`, `plans/`), scan there.
2. Find files whose YAML frontmatter has top-level `status: in-progress`.
3. Behavior:
   - **None** → proceed to Step 1.
   - **Exactly one** → surface to user: `Found in-progress plan: <slug> (current phase: <id> — <scope>). Continue or start new plan?` Wait for answer.
   - **Multiple** → list them all, ask user which to continue (or start fresh).
4. If user confirms continuation: skip Steps 1 and 2 (plan is already written and approved), jump straight to Step 3 for the phase marked `in-progress`. If none is `in-progress` but a `pending` one exists, flip the earliest pending to `in-progress` in the plan frontmatter (commit `docs(plans): advance to <id>`) and start Step 3. Before dispatching, apply the "## Durable Progress" checks: if `git log` / `git status` already shows the phase's implementation, resume at Step 4 instead of re-dispatching the implementer; and run the store check of "## Durable Progress" item 4 first (`"$AD" status`; `"$DISPATCH" status` and `"$ZDISPATCH" status` for a skipped store or without `$AD`) — a write task already running for the phase in any store means poll, not re-dispatch.

Never resume silently — always name the plan and wait for confirmation.

### Plan files without frontmatter (legacy migration only)

`writing-plans` now produces YAML frontmatter natively, so this path is rare. It only triggers for plans created before the format unification or imported from upstream `superpowers` (TDD-flat format). When you do hit one: offer the user a retrofit — dispatch an Opus subagent (effort `high`) with the existing file + current phase info (from user or `git log`) to write frontmatter in place, then commit `docs(plans): add frontmatter to <slug>`. Only then proceed. If you find yourself running retrofit on a freshly-written `writing-plans` plan, that's a bug in `writing-plans` — surface it, don't paper over.

## Full protocol

### Step 1 — Opus subagent writes the plan

Dispatch the Opus plan writer per `./opus-plan-writer-prompt.md` Mode A: `Agent(subagent_type="general-purpose", model="opus", effort="xhigh", prompt=...)`. Relay user's original request verbatim + repo path + any constraints you know. There is no task id to record — every writer dispatch is fresh, and Step 2 revisions carry their scope in the ledger instead of a thread. Keep the writer's returned summary in context: it is what you paste into the reviewer's `## Context` section, and each revision's per-ledger-item report is what fills the Step 2 follow-up template's "What the writer did with your prior blocking list".

The plan writer writes `docs/plans/YYYY-MM-DD-<slug>.md` (or repo's custom path) with this format:

```yaml
---
slug: <short-slug>
created: YYYY-MM-DD
status: in-progress          # in-progress | done | abandoned
risk_phases: { Ф1: [], Ф2: [] }   # written by the plan writer — one key per phase id (Step 2.5 check 4)
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

Body sections: Goal · Files (by phase) · Contracts · Test strategy · Risks / unknowns (opens with one `- <id> — <KIND>: …` line per risk tag) · Phases (`## Ф1: <title>`, etc.).

**The plan file is the single source of truth** across the entire protocol and across sessions. All subsequent Codex and Opus invocations read it by path — including the plan writer's own revision dispatches, which have no thread to remember it from.

Pre-plan research (Explore subagent) is **required**, not optional, if any of the following is true: (a) the area is unfamiliar to you; (b) the user's request names failing tests / errors you haven't seen resolved in a prior turn; (c) you'd otherwise be tempted to open source files on main to "understand the task". Dispatch `Agent(subagent_type="Explore")` with a focused question (failing tests + specific files to investigate, or "map X feature"), then feed the report into the plan-writer prompt. Do not read production code on main to decide whether Explore is needed — if you're not sure, dispatch it.

Scope Explore to what YOU need in order to fill the writer prompt — the entry points, the failing tests, the constraint you must state. The Opus writer explores the repo itself and verifies every path and signature it names, so a second full sweep is duplicated spend; Explore's job here is the starting map, not the whole survey.

If the repo maintains `docs/ARCHI.md` (see the `architecture-memory` skill), tell the Explore subagent to start from it — a current architecture memory usually shrinks the Explore pass to verification of the relevant sections. Do NOT read ARCHI.md on main yourself: it is architecture content, i.e. research (Rule 2); you only pass its path along.

### Step 2 — Codex Astra xhigh reviews the plan (loop, cap=4)

Dispatch the `plan-reviewer` profile — built-in Codex Astra xhigh — using `./codex-plan-reviewer-prompt.md` (`--model gpt-6-astra --effort xhigh`, no `--write`, `--prompt-file`; the prompt points the reviewer at the plan file — no embedded copy). FRESH task each round, never `--resume-task` — the ledger, not thread memory, carries the round history. A route line with `readOnly=none` puts the job inside `agent-invocation` "No-edit check".

Verdict handling:
- `APPROVED` → commit the plan file **separately** (subject: `docs(plans): add <slug>`, stage only the plan file, Co-Authored-By trailer, no push). Then Step 3.
- `CHANGES_REQUESTED` → run the ledger sequence (see "## Authorized Change Ledger" for ledger shape and rules):
  - **(a) Triage.** Classify each reviewer finding's `class:` into a ledger `decision`. `MUST_FIX_NOW` and `REGRESSION_FROM_AUTHORIZED_FIX` map to `ACCEPTED` (or `PARTIALLY_ACCEPTED` if you accept only part of the change); the reviewer's `DEFER` / `NIT` / `REJECTED_BY_SCOPE` items map directly to ledger `decision`s of the same name. Exception: a finding labeled `plan-mandated` is NEVER triaged into `ACCEPTED` or `REJECTED_BY_SCOPE` — "the plan chose it" is not a triage basis. Record it as `ESCALATED_TO_HUMAN` and present it to the user: the finding + the plan text that mandates it + "which governs?". Do not dispatch a fix that contradicts the plan without the answer.
  - **(b) Write/update ledger** at `docs/plans/<slug>.ledger.json` with this round's items — ids `P<round>-B<n>` (see "## Authorized Change Ledger" for the per-stage id scheme), reviewer `codex-plan`. If the file already exists from a prior round, first update those entries' `status` (`fixed` / `rejected` / `deferred`) based on what the latest plan revision did, then append the new round's entries.
  - **(c) Dispatch the plan-writer revision.** A FRESH Opus subagent (`model: "opus"`, `effort: "high"`), using `./opus-plan-writer-prompt.md` Mode B; pass the plan-file path, the ledger path (`docs/plans/<slug>.ledger.json`), the open ACCEPTED / PARTIALLY_ACCEPTED items inline, and the reviewer's BLOCKING lines behind those items verbatim as context. The writer re-reads the plan from disk and updates it in place. **Risk-map carry-over in the loop.** The plan file is still uncommitted here, so no `git diff` can show a tag the revision dropped: before this dispatch, read the plan's frontmatter (`Read limit: 30`) and save its `risk_phases:` line verbatim to `<scratchpad>/dev-orchestrator/<slug>.risk-before` (overwrite). After the writer returns, read the frontmatter again and apply the carry-over rule (Step 2.5 check 4) from the saved line to the current `risk_phases` line — a tag leaves a phase that still exists only with the ledger id the writer's output line `risk_phases: … (removed by <ledger id>)` names; restore every other dropped tag with a frontmatter `Edit`, and give the re-review in (d) the restored line. If the saved file is missing (compaction, resume), the writer's output line `<old line> → <new line>` is the old map; no saved file and no such line → treat the revision as having dropped nothing only when its output says `risk_phases: unchanged`, otherwise rebuild the map with Step 2.5 (4b) and carry over from the current line. If the revision returns `NEEDS_AUTHORIZATION: <ledger id> requires <extra change>...`, triage the requested extension: within the plan's scope and Non-goals → extend that item's `authorized_change` / `forbidden_expansions` in the ledger and dispatch a fresh Mode B writer with the extended item inline; outside the plan's scope → record the item `ESCALATED_TO_HUMAN` and ask the user before any further dispatch.
  - **(d) Re-dispatch a FRESH plan reviewer** (built-in Codex Astra xhigh) with the follow-up template from `./codex-plan-reviewer-prompt.md` — it carries the ledger path and the writer's revision report (including its `risk_phases:` line verbatim) so the reviewer can verify each ACCEPTED item is addressed. Increment counter.
**Loop-control checks — run IN ORDER after every `CHANGES_REQUESTED`, before dispatching a fix round. First match wins; if a check fires, stop and do what it says.**

1. **Anti-pingpong filter.** Remove from the blocking list any item that repeats a point explicitly rejected with reasoning in a prior round — mark it `resolved-by-decision` in the ledger. Never filter a finding that asks to add a missing risk tag (`risk_phases`) — an extra tag is always safe, so it goes to the writer as ACCEPTED. If the list becomes empty after filtering, treat the verdict as `APPROVED` and proceed accordingly.
2. **No-progress detector.** Blocking list identical (by content) to the previous round's → escalate immediately: plan-file path + the repeated list + one-sentence impasse summary (have an Opus subagent, effort `high`, write the summary). User picks: accept / another round / close.
3. **New-blocker churn detector.** Escalate immediately, even before cap=4, if ALL three hold: (a) every blocker from the previous round is fixed or rejected-by-scope (per the ledger); (b) the remaining blocking items are all NEW `MUST_FIX_NOW` (items classed `REGRESSION_FROM_AUTHORIZED_FIX` do NOT count as new — they are causally tied to a prior accepted fix); (c) none cite DATA_LOSS, SECURITY, or GUARANTEED_FAIL materiality. Escalation summary must include: prior blockers closed; new blockers with their materiality labels; recommendation — approve now plus defer list, OR authorize another high-materiality round.
4. **Round cap.** The next round would be round 5 (cap=4 exhausted) → escalate: plan-file path + last blocking list + one-sentence disagreement summary (have an Opus subagent, effort `high`, write the summary). User picks: accept / another round / close.
5. **None fired** → run the ledger sequence (a)–(d) above and start the next round.

### Step 2.5 — Pre-flight scan (orchestrator itself, NO dispatch)

After the plan is approved and committed, before the first Step 3 dispatch, scan the plan once yourself. This is the one place you read the plan body on main: a single full `Read` of the plan file, used ONLY for the four mechanical checks below and to copy the `## Global Constraints` section verbatim for later reviewer dispatches (re-extract just that section after any later plan revision). It is not a license to re-plan, second-guess phasing, or open source files.

1. **Global Constraints vs phases.** For each line of `## Global Constraints`, look for a phase whose text names a conflicting value — a different version floor, dependency, name, or format for the same thing.
2. **Consumes ↔ Produces.** Every `Consumes:` line of every phase must match, as a string, a `Produces:` line of an earlier phase or an entry in `## Contracts`. A name or signature that matches nothing is a plan bug. Exception: lines reading literally `Consumes: nothing` / `Produces: nothing` are the plan format's explicit empty marker — they are exempt from this check, not a bug.
3. **Rubric-mandated defects.** The plan explicitly mandates an item from this fixed list: a test that asserts nothing; verbatim duplication of a logic block; an instruction to skip tests.
4. **Risk phases.** The top-level frontmatter key `risk_phases` holds one entry per phase id; the value lists the phase's risk kinds — only `SECURITY` and `DATA_LOSS` — and an empty list means "checked, no risk". Since 0.9.1 the plan writer writes it (`./opus-plan-writer-prompt.md` "Risk tags") and the Step 2 reviewer checks it; plans written earlier have none. The line directly after it, `risk_checked: true`, is **yours alone**: it records that this check ran on the current plan text. The writer never writes it, and every Mode B revision deletes it.

   **Carry-over rule** (moves tags from an old map to the current one; used by (4a) checks 2 and 3): every kind the old map lists on an id that is still a phase id stays on that id; a kind on an id that is no longer a phase id goes to every phase id the old map did not have (a split or renamed phase inherits its parent's tags); an old value holding anything other than `SECURITY` / `DATA_LOSS` counts as `[SECURITY, DATA_LOSS]`. A kind may leave a phase that still exists only when the Mode B writer's output line `risk_phases: …` names the ACCEPTED / PARTIALLY_ACCEPTED ledger id whose change removed the matching step.

   First match wins:

   - **(4a) The frontmatter has `risk_phases`** (the writer's map, or one this step derived earlier). Run these four checks in order:
     1. **Placement.** It is ONE top-level flow-style line (`risk_phases: { … }`) directly after the top-level `status:` line, so it stays within the `Read limit: 30` window. Elsewhere, or spread over several lines → rewrite it as that one line in that place, with the same keys and values.
     2. **Shape.** Its keys are exactly the ids of the frontmatter `phases:` list (none missing, none extra) and every value is a list holding only `SECURITY` / `DATA_LOSS` (`[]` allowed). Any failure → the map is malformed: build a new map with (4b) below, then apply the carry-over rule from the malformed map. Announce one line: `risk_phases malformed (<what failed>) — rebuilt from the plan text.`
     3. **No silent removal.** Run `git diff -U0 -- <plan-file>`. It shows a removed `-risk_phases:` line (the map changed since the plan file's last commit) → apply the carry-over rule from that old line to the current map. A plan file that was never committed (still inside the Step 2 loop) has no such diff: there, the saved `<scratchpad>/dev-orchestrator/<slug>.risk-before` line of Step 2 (c) is the old map — apply the carry-over rule from it.
     4. **Plan-text cross-check.** For every phase that the plan's `## Risks / unknowns` section (or the phase's own Risks lines) names with `SECURITY` or `DATA_LOSS`, the value carries that kind → otherwise add it. The plan text can add a tag, never remove one.
   - **(4b) No `risk_phases` key** (a plan written before 0.9.1 — the legacy fallback). Classify **every** phase: a phase is risk-marked when the plan's `## Risks / unknowns` section (or the phase's own Risks lines) names `SECURITY` or `DATA_LOSS` for it — the same determination the 4.1 `xhigh` escalation makes. Write ONE top-level key into the plan-file YAML frontmatter directly after the top-level `status:` line, so it stays within the `Read limit: 30` window, listing every phase id — an empty list means "scanned, no risk":

     ```yaml
     risk_phases: { Ф1: [], Ф2: [], Ф3: [DATA_LOSS], Ф4: [], Ф5: [SECURITY, DATA_LOSS] }
     risk_checked: true
     ```

   Finish (4a) and (4b) alike: the line directly after `risk_phases` is `risk_checked: true` — add it if it is missing. Every edit of these two lines is a mechanical metadata edit under Rule 1: commit the plan file alone as `docs(plans): record risk phases for <slug>` (same class as the `docs(plans): advance to <id>` bookkeeping commit). Map unchanged and the marker already there → no edit, no commit of your own (guard (c) below still commits a dirty plan file). Never remove a tag yourself outside the carry-over rule's ledger exception, and never pick one from source code — tags come only from the maps and the plan text. "Phase X is risk-marked" ⇔ `risk_phases[X]` is non-empty; "the plan has a risk-marked phase" ⇔ any value is non-empty. The channel ladder (Step 3), Step 5, integration repair and the 4.1 `xhigh` escalation read this key; the value lists the kinds for the announcement line. After compaction the frontmatter read ("## Durable Progress" item 1) restores it — no second read of the plan body. This check produces no findings for the batched question below; it only validates or writes the map.

Findings → ONE batched `AskUserQuestion` covering all of them — each finding beside the plan text that mandates it, asking which governs — before execution begins, not one interrupt per discovery mid-plan. Nothing found → proceed to Step 3 WITHOUT comment (no "I checked the plan and found no issues"). The review loop remains the net for conflicts that only emerge from implementation.

Plan edits the user accepts go through the existing ledger sequence (reviewer `"preflight"`, ids `PF-B<n>`) + a plan-writer revision dispatch (fresh Opus subagent at effort `high`, `./opus-plan-writer-prompt.md` Mode B). Re-run the four checks once on the revised plan, then proceed.

**Re-derivation after plan changes.** Every plan-writer Mode B dispatch that lands after Step 2.5 has run — pre-flight edits the user accepted, a BLOCKED "task too large" sub-phase split (Step 3), a scope revision after a completed phase's findings ("## Multi-phase plans"), a legacy frontmatter retrofit — is followed, **before the revised plan file is committed and before any implementer dispatch**, by a re-run of the four checks on the revised plan. The Mode B writer keeps `risk_phases` current itself and deletes `risk_checked` (its "Risk tags stay current" rules; its output line `risk_phases: unchanged | <old> → <new>`); check 4 (4a) then validates that map — rebuilding it when malformed, restoring tags the revision dropped without a ledger id, adding tags the plan text names — re-adds `risk_checked: true`, and both lines land in the same commit as the revision.

**Compaction-safe guards** — checked before every non-frontend implementer dispatch (Pre-dispatch checklist items 5 and 10), first match wins:
- (a) no `risk_phases` key, or no `risk_checked: true` line after it (check 4 has not run on the current plan text: a plan handed over by `writing-plans` or resumed on the confirmed-resume path, both of which can skip Step 2.5; a plan written before 0.9.1; a revision whose re-run has not happened yet) → run check 4 now — this full read of the plan body is allowed — and commit;
- (b) the current phase id — for the plan-wide operations `final-fix` and `repair`, every id in the frontmatter `phases:` list — is not a key of the map (new sub-phase, renamed phase) → the map is stale → re-run check 4 (its (4a) shape check rebuilds the map, carrying the old tags over), commit, then dispatch;
- (c) the plan file is dirty in `git status` → a revision may have landed without its re-scan → re-run check 4 and commit the plan file — carrying whatever uncommitted revision it holds — as `docs(plans): record risk phases for <slug>`;
- (d) otherwise the map is current — a present, complete, `risk_checked` map is never re-derived without one of these triggers.

**Admission condition** (checked by Pre-dispatch checklist items 5 and 10 after any guard fired): the needed phase ids are keys of `risk_phases`, the line after it is `risk_checked: true`, **and** the plan file is clean in `git status`. No implementer dispatch while any part fails.

### Step 3 — implement the current phase

**Before every implementer dispatch** (both routes, every phase — including re-dispatches after an interrupted session):

1. **Record the phase BASE**: `git rev-parse HEAD`. Carry it in the state line (`base=<base7>`). Every review package for this phase and its frontmatter `commits:` range derive from this recorded SHA — never `HEAD~1`, which silently drops all but the last commit of a multi-commit task.
2. **Resolve `[REPORT_FILE]`** once per phase: `$("$WS" <plan-file>)/phase-<id>-report.md`, substituted as an absolute path into the dispatch — both implementer templates (Codex and the Claude frontend implementer) take it, and the same path later goes to both reviewers. For a parallel track, run `"$WS"` with cwd inside the track's worktree. Fix rounds append to the same file — never mint a new report path for round 2+.
3. **Non-frontend phase: decide the channel** — at the phase's first Step 3 dispatch, run the channel ladder below; write the result into the state line (`impl=`) and announce it in one line ("## Reporting cadence").
4. **Before the first GLM dispatch of a session** (only when the ladder's candidate at item 3 is `glm` with `glm=unprobed`, or a route answers `glm` while `glm=unprobed`; a chain without `glm` never probes GLM): resolve `$ZDISPATCH` from `../zcode-invocation/SKILL.md` (`Read` it — manual-only), run `"$ZDISPATCH" doctor`, then `"$ZDISPATCH" doctor --probe` (cwd inside the repo). Both exit 0 → `glm=ok`. Either fails → `glm=down`, one announcement (`ZCode doctor failed (<first FAIL line>) — implementer for this session: Luna max.`; a rebound `implementer` chain names its next profile instead of `Luna max`), and ladder item 3 applies for the rest of the session. Other profiles are never probed: a failed first job switches to the next profile. When the first FAIL line is `FAIL auth: no Coding Plan API key …` or `FAIL personal-config: … does not pin …` from `doctor`, or `model-selected: FAIL(auth)` / `model-selected: FAIL(model-not-selected)` from the probe (the CLI rejected the key; stderr carries the hint `store a valid one: zcode-dispatch api-key set`), the same announcement tells the user and gives them the line to run themselves, absolute path filled in (`zcode-invocation` "One-time setup", step 2): `"$ZDISPATCH" api-key set` in a terminal (hidden prompt), or `! pbpaste | "$ZDISPATCH" api-key set` after copying the key last; GLM comes back in a later session. On `FAIL auth: ZCode template incompatible …` there is no user remedy: announce that the installed ZCode changed its `zai-api` template and the wrapper needs an update. There is no OAuth login. Never run `api-key set` yourself, and never ask for the key in the chat. If `zcode-invocation` records `Model confirmation: required`, then — after a passing probe, once per session — ask the user (`AskUserQuestion`) to confirm that ZCode runs GLM-5.3-Flash with reasoning `max`; a "no" → `glm=down` with reason `model not confirmed`. Write the result to the session marker. The probe runs **once per session**; after compaction the marker, not a new probe, restores the state.

**Channel ladder** (non-frontend phases; decided **once per phase**, at its first Step 3 dispatch; Steps 3.5, 4, 5 and "## Parallel groups" use the channel it picked; items 1, 2 and 3 (whose candidate is item 5's answer) are one `route` call each, "## Routing" item 2 — none under `routes: default` while the `channels` marker holds no `off` line, where the built-in names below apply). First match wins:

1. **Kill switch active** — the user said "через Luna" or "без GLM" in this session, or the `SP_IMPLEMENTER` rule ("Kill switch" below) activated it → every phase, risk-marked included, goes to: "через Luna" and `SP_IMPLEMENTER=luna` → `luna`; `SP_IMPLEMENTER=<p>` (a `config.json` profile — the rule below) → profile `p` instead of a route answer, its harness, model and effort from `"$AD" channels`; "без GLM" → the first non-down profile of the `implementer` chain without `glm` (`--skip glm`; built-in: Codex Luna max). `glm=off`. (Risk-marked phases also go to Luna under the kill switch, as they did before 0.8.0; the gate-stall and review-stall rules of Steps 3.5 and 4 still apply — they are pipeline rules, not GLM rules.)
2. **Phase is risk-marked** (`risk_phases[<id>]` non-empty, Step 2.5) → the `implementer.risk` chain (built-in: Codex Sol 6.1 xhigh `--write`).
3. **GLM channel down this session.** When the state line still shows `glm=unprobed` and the candidate — item 5's profile, the first non-down profile of the `implementer` chain (built-in: `glm`) — is `glm`, run item 4 above now and set `glm` before evaluating this item; any other candidate → no GLM probe. `glm=down` → the next non-down profile of the `implementer` chain (built-in: Codex Luna max), announced once per session.
4. **Phase already handed to a fallback or escalation profile** (built-in Luna or Sol, earlier in this phase) → stays there; resume that thread with `--resume-task <id>`.
5. **Otherwise** → the first non-down profile of the `implementer` chain (built-in: GLM-5.3-Flash max via `$ZDISPATCH`).

Frontend-only phases do not enter the ladder (Claude frontend implementer, unchanged).

**Kill switch.** Session: the user says "через Luna" or "без GLM" (in any message of the session) → `glm=off`, written to the session marker so it survives compaction; ladder item 1 for every phase until the session ends — nothing re-enables GLM within the session. "без <profile>" for any profile other than GLM ("без GLM" is the GLM kill switch above and writes no `channels` line), only when `route --all` did not print `routes: default` (the user's `config.json` changes routing) → a line `<profile> off kill-switch <ISO time>` in the `channels` marker: that profile leaves every chain until the session ends. Under `routes: default` no such switch exists, as before 0.12.0. Permanent — the **`SP_IMPLEMENTER` rule**, applied at every skill start (setting `glm=off` and the marker when it activates) and in compaction recovery: empty or `glm` → no kill switch; `luna` → the kill switch, as always; the name of a profile that the user's `config.json` defines (a `source=config` row of `"$AD" channels`) whose harness is not `inproc` → the kill switch on that profile for every non-frontend phase; any other value — a built-in profile other than `luna` (`sol`, `astra`, …), an unknown name, an `inproc` profile, garbage, or `$AD` not running — is ignored, as before 0.12.0: no kill switch, GLM stays. Silently when `"$AD" channels` lists no `source=config` profile or `$AD` does not run (no `config.json`: exactly as before); otherwise one announcement line at skill start, never repeated after compaction. `zcode-dispatch` itself refuses `task` only for `luna`. Nothing else: no per-phase toggles.

**Prompt files and the retry / channel-switch rule** (every implementer dispatch on every non-frontend channel — Steps 3, 3.5, 4, 5 and integration repair):

- Every dispatch belongs to exactly one **operation**: `implement` (first round), `fix r<N>` (Step 4 fix round), `gatefix r<N>` (Step 3.5 gate-fix round), `final-fix` (Step 5 fix wave) or `repair r<N>` (integration repair). The operation fixes the template (first-round or fix-round, with the "Step 5 fix wave" substitutions where applicable), the scope, the ledger items inlined, the round number and `[REPORT_FILE]`.
- Write the operation's **body file** once — the filled template and nothing else — to `$dir/prompts/<name>.md`, where `$dir = $("$WS" <plan-file>)` (for a parallel track, `"$WS"` run inside the worktree) and `<name>` is one of `implement-<id>-r1`, `fix-<id>-r<N>`, `gatefix-<id>-r<N>`, `final-fix-r<N>`, `repair-<G>-r<N>`. The plan-scoped workspace, not the session scratchpad, so the files outlive compaction and sessions. A continuation of the same operation (`NEEDS_CONTEXT`, added context after a diagnosis) appends an `## Added context` section to the body file before the `--resume-task` follow-up, so a later retry carries it.
- Every dispatch — every `task` invocation, resumes and follow-ups included — is written to a **dispatch file** `$dir/prompts/<name>.<seq>.<profile>.md` (built-in `glm`, `luna`, `sol`). `<seq>` is a three-digit **per-phase dispatch sequence number** (per operation name for the plan-wide `final-fix` / `repair-<G>`), monotonic across operations, rounds **and channels**: the next seq is the highest seq present for the phase plus one (`ls "$dir"/prompts/`). Composition, by operation type and dispatch kind:
  - `implement` — ZCode preamble (GLM target only; a core-harness target opens with `agent-invocation`'s headless preamble instead, everywhere below) → the body (the self-contained first-round template); on a retry or channel switch the channel-switch notice is inserted right after the body's opening paragraph. **Never the fresh-fallback re-brief** — that block declares a fix round and would contradict the first-round template.
  - fix-type operations (`fix`, `gatefix`, `final-fix`, `repair`), **thread resume** (`--resume-task` — a GLM session resume, a Luna/Sol thread resume, and the Luna → Sol escalation, which resumes the Luna thread) — preamble (GLM only) → the body as written (fix-round template with its standard opening paragraph). No re-brief, no notice: the thread holds the history.
  - fix-type operations, **FRESH** (a new thread: a switch between harnesses such as GLM ↔ Codex, `--fresh` retry, lost handle; the Step 5 wave and integration repair are fresh by nature) — preamble (GLM only) → the body with its opening paragraph **replaced** by the fresh-fallback re-brief block (`./implementer-prompt.md`), and the channel-switch notice inserted right after the re-brief whenever an earlier dispatch of this operation exists.
  - a continuation follow-up on a resumed thread (`NEEDS_CONTEXT`, added context) is the short follow-up text — on a GLM target still preceded by the ZCode preamble, which opens **every** GLM dispatch file without exception; it still takes the next seq, a dispatch file and a sidecar.
- The moment the dispatcher prints the id, write it — `glm:zt-NNNN` / `luna:task-NNNN` / `sol:task-NNNN` / `<profile>:<id>` — into the sidecar `<same name>.id` (`$dir/prompts/<name>.<seq>.<profile>.id`; a one-line bookkeeping write, same class as the ledger). Because seq is monotonic across channels, **the highest seq for a phase is always its current channel and handle** — e.g. `implement-Ф2-r1.001.glm` → `.002.glm` (retry) → `.003.luna` (fallback) resolves to Luna; `implement-Ф2-r1.001.luna` → `.002.sol` (escalation) resolves to Sol.
- **A retry or a channel switch never changes the operation.** A failed `fix r2` on GLM is re-dispatched as `fix r2` on the new channel with the same body — same AUTHORIZED_BLOCKERS, same round number, same `[REPORT_FILE]` append rule; a failed `final-fix` stays a whole-plan fix wave; a failed `gatefix r1` stays a gate-fix round. The first-round template appears only when the operation is `implement`. On `codex` and core-harness profiles the failure rules after "GLM infrastructure failures" below apply, with the same body file at the next seq.
- **GLM resume disabled.** When `zcode-invocation` records `GLM resume: disabled` (discovery found that a resumed ZCode session loses the model), every GLM dispatch this skill writes as `--resume-task <zt-id>` is instead a FRESH GLM dispatch of the same operation (`--fresh`, the FRESH composition for its operation type); a continuation's added context goes into the body file's `## Added context` section, which the FRESH dispatch carries.

**Route by phase type** (decide from the plan's `Files` section for this phase):

- **Frontend-only phase** (all files in .tsx/.jsx/.vue/.svelte/.css/.scss; visual/UI work) →
  Dispatch Claude frontend implementer subagent using `./claude-frontend-implementer-prompt.md`.
  Opus at effort `high` for new UI / redesign; Sonnet at effort `medium` for simple tweaks.
  Subagent is instructed to use the `frontend-design` skill.
- **Backend / non-frontend phase** → implementer per the channel ladder: GLM via `$ZDISPATCH` with `./implementer-prompt.md` prefixed by the ZCode preamble; Luna or Sol via `$DISPATCH` as before; a core-harness profile via `"$AD" task` ("## Routing" item 2). The prompt points the implementer at the plan file and names the current phase id. GLM dispatch line:

  ```bash
  "$ZDISPATCH" task --background [--cwd <worktree-path>] --prompt-file "$dir"/prompts/implement-<id>-r1.<seq>.glm.md
  ```

  Poll with the Monitor loop from `../zcode-invocation/SKILL.md` (`Read` it — manual-only; identical to Codex's, `zt-` ids, terminal set `completed|failed|cancelled`; core ids: `../agent-invocation/SKILL.md`), fetch with `"$ZDISPATCH" result zt-NNNN`, parse line 1 exactly as for Codex.

Dispatch, wait terminal (GLM / Codex) or Agent completion (Claude subagent), fetch result.

Implementer status (same shape from both paths):
- `DONE` → Step 3.5 (verification gate), then Step 4.
- `DONE_WITH_CONCERNS` → read concerns. Correctness/scope → address before review. Observations → note and proceed.
- `NEEDS_CONTEXT` → provide the missing context and re-dispatch — append it to the body file as `## Added context`, then: GLM `"$ZDISPATCH" task --background --resume-task <zt-id>` with a follow-up dispatch file; Codex `--resume-task <implementer-task-id>`; a core-harness profile the original `"$AD" task` flags with `--resume-task <its id>` ("## Verdict parsing" step 3); Claude subagent: fresh Agent call carrying the added context.
- `NEEDS_AUTHORIZATION` — a fix-round-only token (a first-round implementer has no ledger to be authorized against); if it appears, handle it per the Step 4(c) `NEEDS_AUTHORIZATION` branch: triage the requested extension, extend the ledger item or escalate, re-dispatch.
- `BLOCKED` — dispatch an Opus subagent to assess (`model: "opus"`, `effort: "high"`; pass BLOCKED report + plan-file path). The diagnosis returns one of:
    1. More context needed → resume the phase's channel with the added context (appended to the body file; GLM: `"$ZDISPATCH" task --background --resume-task <zt-id>`), same effort.
    2. Needs more reasoning → non-frontend phase: the escalation profile ("## Routing" item 5; built-in Codex Sol xhigh, `--write --model gpt-6.1-sol --effort xhigh`; the built-in case is spelled out here). GLM phase: **FRESH** Sol dispatch of the same operation — dispatch file `<name>.<seq>.sol.md` in the FRESH composition for its operation type (`implement`: the first-round body with the channel-switch notice, naming the GLM job id and the report file, after its opening paragraph, no re-brief; fix-type: re-brief opening + notice + body), the BLOCKED report appended to the body as `## Added context`. Luna phase (fallback or kill switch): `--resume-task <luna id>`. In both cases Sol becomes the phase's channel (ladder item 4). A phase already on Sol (risk-marked or escalated) → hand to the user — nothing above Sol. Claude path: upgrade from Sonnet `medium` to Opus `high`; if already Opus, hand back to user.
    3. Task too large → break into sub-phases; dispatch the plan writer (fresh Opus subagent at effort `high`, `./opus-plan-writer-prompt.md` Mode B) to edit the plan accordingly, re-run Step 2 on the plan change, then the `risk_phases` re-derivation (Step 2.5) before the revised plan is committed.
    4. Plan is wrong → escalate to user.

Never force the same model to retry without changes.

**GLM infrastructure failures** — the job reached `failed` (the Monitor loop reported it; read the class with `"$ZDISPATCH" status <zt-id> --json | python3 -c "import json,sys; print(json.load(sys.stdin)['job']['errorClass'])"`) or `cancelled`. First match wins:

1. `errorClass ∈ {quota, auth, model-not-selected}` → retry is pointless. Set `glm=down` for the session (state line + marker; on `auth` / `quota` also a `channels` line `glm down <class> <ISO time>`, so `route` drops the profiles linked to it), announce (`GLM channel failed (errorClass=<class>) — Ф<id> falls back to Luna max; GLM is off for this session.`; a rebound `implementer` chain names its next profile instead of `Luna max`; on `auth` / `model-not-selected` the announcement also gives the user the same remedy as a failed probe, absolute path filled in — `api-key set`, `zcode-invocation` "One-time setup", step 2), re-dispatch the **same operation** FRESH on the next profile ("## Routing" item 4; default `luna`: Codex Luna max) — dispatch file `<name>.<seq>.<profile>.md` (built-in `.luna.md`) in the FRESH composition for its operation type (`implement`: body + notice; fix-type: re-brief opening + notice + body; the tree may hold partial GLM work).
2. `errorClass ∈ {timeout, crash, launch, malformed}` → ONE retry of the same operation on GLM: `"$ZDISPATCH" task --background --fresh --prompt-file "$dir"/prompts/<name>.<seq>.glm.md` (same FRESH composition). The retry fails again with any class → the next profile (default `luna`) per item 1's mechanics (announce; set `glm=down` only if the second class is in item 1's set).
3. `cancelled` → report to the user and wait, exactly as for Codex.

A `completed` job whose line 1 is not a valid token is **not** an infrastructure failure: apply "## Verdict parsing" step 3 (re-dispatch once with `--resume-task <zt-id>`). A `task` exit 1 with no start line and stderr `zcode-dispatch: failed to start the runner for <zt-id>` or `zcode-dispatch: workspace reservation was lost before the runner started for <zt-id>` has a finalized `failed/launch` record — apply item 2 above (one `--fresh` retry, then the announced next profile if it fails again). A `task` exit 2 with stderr `zcode-dispatch: prompt file is <bytes> bytes, above MAX_PROMPT_BYTES=<n> for the argv transport` (`<n>` is 204800 on macOS, 122880 on Linux; only `zcode` has this limit) is a deterministic guard, not a GLM job failure — dispatch the same operation FRESH on the next profile ("## Routing" item 4; default `luna`: Luna max) and announce the switch; do not trim the prompt. Any other wrapper exit 2 on `task` is a refused dispatch, not a job failure — fix the dispatch (wrong `--cwd`, missing prompt file, another job running, kill switch); a refusal naming the app version (`Info.plist` / `app.asar`), the ZCode CLI or the provider config counts as a failed `doctor` (`glm=down`).

**Codex and core-harness failures** (class → action table and `"$AD"` refusals: `../agent-invocation/SKILL.md`). A `codex` job `failed` → one `--fresh` retry on the same profile, then the next profile of the phase's chain ("## Routing" item 4 — the chain the ladder selected, never `implementer.risk` under the kill switch), else the user — for the built-in chains (Luna, Sol, Astra stand last) this is `codex-invocation`'s retry-then-user. A core job (`ct-`, `oc-`, `pi-`, `dt-`) `failed` → read its `errorClass` as for GLM: `timeout`, `crash`, `launch`, `malformed`, `rate-limit`, `server` → one `--fresh` retry on the same profile, and a second failure → the next profile; `context`, `blocked` → the next profile; `auth`, `quota`, `model-not-selected` → the profile is down (`channels` line `<p> down <class> <ISO time>`; `auth` / `quota` also drop its linked profiles), the next profile; `resume-lost` or a refused resume (exit 2 `… dispatch --fresh`) → FRESH on the same profile, not a failure. Each switch is one announced line; `cancelled` → the user.

**Stale workspace reservation** — `"$ZDISPATCH" task` exits 2 with the stale message (contains `release-stale`; the wrapper never reclaims a stale reservation automatically). First match wins. Run `"$ZDISPATCH" release-stale` with the same `--cwd` as the task; single actor: never run a `task` / `release-stale` / `cancel` in parallel for this workspace, and never delete `active.lock.*` by hand:
1. Exact stdout `released <workspace> generation <n>` → the reservation is free; re-run the identical `task` command once on GLM (same dispatch file; the refused call spawned nothing and wrote no sidecar).
2. Exact stderr `zcode-dispatch: workspace reservation generation <n> is already released` → the reservation is free; re-run the identical `task` command once on GLM.
3. Exact stderr `zcode-dispatch: workspace reservation generation <n> is held by live runner pid <pid>` or `zcode-dispatch: workspace reservation generation <n> still has live CLI process group <pid>` → dispatch NOTHING into this workspace (on no profile). Wait in a Monitor loop for up to 10 minutes total: every 30 s run `"$ZDISPATCH" status`, then `"$ZDISPATCH" release-stale` (same `--cwd`; `status` reaps dead runners and kills orphaned CLI groups). If the result is step 1 or 2, do that single GLM re-dispatch; if it is step 4, follow step 4; if it is step 6, follow step 6; if it is still refused at 10 minutes, follow step 5.
4. Exact stderr `zcode-dispatch: workspace reservation changed while checking; retry release-stale` → another job holds the workspace; apply Durable Progress item 4: poll it and never dispatch a second task.
5. The single GLM task re-run is refused again or the wait remains refused at 10 minutes → stop dispatching into this workspace and escalate to the user with the exact wrapper output.
6. Exact stderr `zcode-dispatch: no workspace reservation to release` or `zcode-dispatch: workspace reservation generation <n> has no valid holder`, any other `release-stale` refusal, or `release-stale` exit 1 → the same stop-and-escalate action as step 5, quoting the output.
A fallback to the next profile is allowed only after step 1 or 2 confirmed release and the accepted GLM re-dispatch then fails under the existing infrastructure-failure ladder. A core-harness `"$AD" task` refused as stale follows the same steps with `"$AD" release-stale` (its messages carry the `agent-dispatch:` prefix and say "harness process group"); "on GLM" then reads "on that profile".

### Step 3.5 — Verification gate (before every review round)

A cheap mechanical gate between implementation and the expensive review loop (pattern borrowed from TRIP-workflow's testing gate). The fused review reads code; the gate proves the tree actually builds and passes its own tests — and a red tree fails fast on a Sonnet dispatch instead of burning an Opus review round.

**When it runs:**
- After every implementer `DONE` / `DONE_WITH_CONCERNS` (Step 3), before the first 4.1 dispatch.
- After every Step 4 fix round, before re-dispatching 4.1.
- Parallel tracks: per track, inside the track's worktree.

**How:** dispatch `Agent(subagent_type="general-purpose", model="sonnet", effort="medium")` with `./verification-gate-prompt.md` (repo root, phase's files). Not on main — running tests is research/verification, not orchestrator bookkeeping.

**Verdict handling:**
- `GATE_OK` → record the one-line gate summary (`lint: … | typecheck: … | tests: …`) and proceed to Step 4. Pass the summary into the 4.1 and 4.2 prompts (`## Verification gate summary` section) so reviewers know what already ran and on which tree state.
- `GATE_FAIL` → do NOT start (or resume) the review loop. Dispatch a gate-fix round (operation `gatefix r<N>`) on the phase's channel with the gate's failure report as the fix list (fix-round template): GLM `"$ZDISPATCH" task --background --resume-task <zt-id> --prompt-file "$dir"/prompts/gatefix-<id>-r<N>.<seq>.glm.md` (preamble prepended); Luna / Sol `--resume-task <task-id>`; any other channel its original dispatch flags with `--resume-task <id>`; a frontend-only phase, the Claude frontend implementer's follow-up template (fresh Agent call). A gate-fix round does NOT increment the fused-review round counter.
- **Gate stall — every non-frontend channel (GLM, Luna, Sol, any profile):** the second consecutive gate-fix round ends without `GATE_OK` → do **not** dispatch a third fix. Dispatch the gate-stall diagnosis — **at most once per phase**; a later stall on the same phase goes straight to the user — `Agent(subagent_type="general-purpose", model="opus", effort="high")` with this skeleton:

  ```
  You are diagnosing why a verification gate keeps failing after two fix attempts. Read the plan at <plan-path> (phase <id>), the implementer report at [REPORT_FILE] (all sections), and the two gate failure reports below. Do not modify files.

  Line 1 of your answer is exactly one token, first match wins:
  ENVIRONMENT — the failure is caused by the machine, not the code: missing or wrong toolchain, missing system dependency, a service (DB, broker) not running, network or infrastructure flake. On line 2 write exactly `fix-location: in-repo` if the remedy is a change to files inside the repository (package manifest, lockfile, in-repo config), otherwise exactly `fix-location: machine`.
  CODE — the code or tests are wrong in a way two attempts did not resolve; the phase needs stronger reasoning.
  CONTEXT — the implementer lacks information that exists (plan text, repo convention, a file it did not find); name it.

  Then: the evidence (file:line, command output), and for ENVIRONMENT the exact commands a human would run to fix the machine.

  ## Gate failure 1
  <verbatim>
  ## Gate failure 2
  <verbatim>
  ```

  Handling (one more round, then the user):
  - `ENVIRONMENT` + `fix-location: in-repo` → ONE more gate-fix round on the phase's channel with the diagnosis inlined.
  - `ENVIRONMENT` + `fix-location: machine` → **pause the phase**; report the diagnosis and the proposed commands to the user verbatim. Run none of them (machine state changes need consent). When the user confirms the environment is fixed, re-run the gate (not the fixer — the tree did not change) with the consecutive counter reset to 0; a `GATE_FAIL` there starts ordinary gate-fix rounds again, and because the diagnosis already ran once for this phase, a second stall goes to the user.
  - `CODE` → ONE gate-fix round on the escalation profile ("## Routing" item 5; built-in Sol xhigh, `--write --model gpt-6.1-sol --effort xhigh`), the diagnosis inlined: GLM phase → FRESH Sol, dispatch file `gatefix-<id>-r<N>.<seq>.sol.md` (FRESH fix-type composition: re-brief opening + notice + body); Luna phase (fallback or kill switch) → Sol resuming the Luna thread (`--resume-task <luna id>`, resume composition — plain body). In both cases Sol becomes the phase's channel. A phase already on Sol → the user directly (nothing above Sol).
  - `CONTEXT` → ONE more gate-fix round on the phase's channel with the named context added.
  - After that round: `GATE_OK` → Step 4; `GATE_FAIL` → the user, with both failure outputs and the diagnosis. Malformed diagnosis (line 1 not one of the three tokens) → the standard verdict-parsing re-dispatch, then the user.
- **Frontend-only phases** keep the old cap: 2 consecutive gate-fix rounds without `GATE_OK` → escalate to the user with the failure output.
- Malformed output → verdict-parsing procedure as usual (re-dispatch once, then escalate).

The gate never blocks on pre-existing failures unrelated to the phase: the gate prompt instructs the subagent to compare against the base commit when a failure looks inherited, and to report inherited failures as a note under `GATE_OK` rather than a `GATE_FAIL`.

**State line during the gate:** `step=3.5-gate`.

### Step 4 — Fused review (Opus + Astra control, cap=4)

Per iteration:

**4.0 Build this round's review package** — before every 4.1 dispatch, every round:

```bash
dir=$("$WS" <plan-file>)
"$RPKG" <BASE> WORKTREE "$dir/review-<phase-id>-r<round>-<base7>.diff"
```

BASE is the SHA recorded before this phase's implementer dispatch (Step 3) — never `HEAD~1`, which silently drops all but the last commit of a multi-commit task. Only the printed `wrote <path>: ...` line enters your context — never Read the package. For a parallel-track phase run both scripts with cwd inside the track's worktree, so the package lands in — and its path points into — that worktree.

**4.1 Opus subagent review (spec + quality, both every round).** Requires a `GATE_OK` from Step 3.5 on the current tree state. Dispatch with `./opus-review-prompt.md` (`model: "opus"`, `effort: "high"`). Fill: base SHA, plan-file path, current phase id, review round, the gate summary, `[DIFF_FILE]` = this round's package path, `[REPORT_FILE]` = the implementer's report, `[GLOBAL_CONSTRAINTS]` = the plan's `## Global Constraints` section verbatim. **Reviewer escalation**: dispatch at `effort: "xhigh"` instead of `"high"` when the phase is risk-marked (`risk_phases[<id>]` non-empty — Step 2.5) or in round 4 of this fused loop (the last round before the cap) — same model, same template. Opus runs BOTH parts every round — findings in one never skip the other:
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

**4.2 Codex Astra high control review** — only if 4.1 returned `REVIEW_OK`. Dispatch the `control-review` profile — built-in Codex Astra high — using `./codex-control-review-prompt.md` (`--model gpt-6-astra --effort high`). Fill `<package-path>` with THIS round's package (relative to the Codex working directory — `--cwd` for a parallel track), the implementer's `[REPORT_FILE]` path (the template's `Implementer report:` line in the Phase context), `[GLOBAL_CONSTRAINTS]` verbatim, the gate summary line, and the template's `Verify additionally` line with any CANNOT_VERIFY items handed over per step 4 above (or `none`). Prompt is tuned for "what might Opus have missed": edge cases, race conditions, security holes, ambiguities between plan and code, subtle regressions. Do NOT duplicate Opus's checklist — orthogonal angle. 4.2 runs no tests — test execution belongs to the verification gate and 4.1. A route line with `readOnly=none` puts the job inside `agent-invocation` "No-edit check".

Output: same format (`REVIEW_OK` / `REVIEW_BLOCKING`, numbered list, separate NITS).

**Combined BLOCKING list** (both 4.1 and 4.2). Whatever the verdicts, FIRST record both reviewers' `DEFER:` and `NITS:` sections in the ledger (`decision: DEFER` / `NIT`, `status: deferred`) — Step 5's ledger triage reads them; items not recorded here are silently lost to the final gate. Then:
- Empty AND no open CANNOT_VERIFY items → auto-commit (see below). Phase done.
- Non-empty → run the ledger sequence (see "## Authorized Change Ledger"):
  - **(a) Triage** the combined list. Each finding's class maps to a ledger `decision`. Tag each ledger entry's `reviewer` field as `opus-review` (for 4.1 findings) or `codex-control` (for 4.2 findings). A 4.2 BLOCKING item missing any of its three required fields (`authorization_relation`, `why_now`, `minimal_fix`) is triaged `decision: DEFER` and does not block the phase — the control-review template promises exactly this degradation. Step 4 uses the SAME ledger file as Step 2 (`docs/plans/<slug>.ledger.json`), but with ids `F<round>-B<n>` derived from the fused-review round counter — the stage prefix keeps them distinct from Step 2's `P<round>-B<n>` entries in the same file, and ledger entries from prior Step 2 rounds remain in place with their final `status`. Exception: findings labeled `plan-mandated` (the 4.1 `PLAN_MANDATED:` section, or a 4.2 BLOCKING item carrying the label) are NEVER triaged into `ACCEPTED` or `REJECTED_BY_SCOPE` — "the plan chose it" is not a triage basis. Record them as `ESCALATED_TO_HUMAN` and present each to the user: the finding + the plan text that mandates it + "which governs?". Do not dispatch a fix that contradicts the plan without the answer.
  - **(b) Write/update the ledger** with the triaged items.
  - **(c) Dispatch the fix round (operation `fix r<N>`) on the phase's channel**, resuming the implementer's own thread or session (full context retained; the control reviewer having run in between does not matter, the resume is addressed by id): GLM `"$ZDISPATCH" task --background [--cwd …] --resume-task <zt-id> --prompt-file "$dir"/prompts/fix-<id>-r<N>.<seq>.glm.md` — the fix-round template with the preamble prepended (resume composition); Luna `--write --model gpt-6-luna --effort max --resume-task <task-id>`; Sol `--write --model gpt-6.1-sol --effort xhigh --resume-task <task-id>`; any other channel its original dispatch flags with `--resume-task <id>` (no new `route`). Use the fix-round template in `./implementer-prompt.md`: ledger path, `[REPORT_FILE]` (the fixer appends its `## Fix round <N>` section there), plus the open ACCEPTED / PARTIALLY_ACCEPTED items inline. For a frontend-only phase, dispatch the Claude frontend implementer's follow-up template instead (fresh Agent call, same ledger-derived list, same `[REPORT_FILE]` rules) — never GLM or Codex. `--resume-last` remains FORBIDDEN anywhere in Step 4 — positional resume would land in the control reviewer's read-only thread (the ZCode wrapper has no such flag at all). **Lost handle** (no `.id` sidecar, `status` does not know the id, or the wrapper refuses the resume) or a stale job record: the same operation FRESH on the same channel at the next seq, in the FRESH composition for its operation type (Step 3). Increment iteration counter.
  - **Review stall (non-frontend phases not yet on an escalation profile — built-in: GLM and Luna phases):** when fused-review **round 3** returns a non-empty combined BLOCKING list, the fixer for `## Fix round 3` is the escalation profile ("## Routing" item 5) — built-in **Codex Sol xhigh** (`--write --model gpt-6.1-sol --effort xhigh`). GLM phase → FRESH Sol, dispatch file `fix-<id>-r3.<seq>.sol.md` (FRESH fix-type composition: re-brief opening + notice + body); the body's fix-round template carries the ledger path, the open ACCEPTED / PARTIALLY_ACCEPTED items inline, and the explicit instruction to read **every** `## Fix round` section already in `[REPORT_FILE]` so closed items are not redone (pass the path and the instruction; do not read or inline those sections — Rule 2). Luna phase (fallback or kill switch) → Sol resuming the Luna thread (`--resume-task <luna id>`, plain fix-round body — the thread already holds the history). In both cases Sol becomes the phase's channel and Sol's task id goes into `impl=`. Round 4's review proceeds as usual; the round cap (the next round would be 5) escalates to the user as before — Sol gets exactly one fix round inside the loop. A frontend-only phase has no review-stall escalation: its fix rounds stay with the Claude frontend implementer up to the round cap.
  - **Review stall on a phase already on Sol** (risk-marked, or escalated earlier in this phase; any `implementer.escalation` profile): round 3 still BLOCKING → do **not** dispatch fix round 3; escalate to the user immediately with the same content as the round-cap escalation (diff, combined list, one-sentence impasse summary by an Opus `high` subagent). Nothing above Sol.
  - **`NEEDS_AUTHORIZATION` from a fixer** (`NEEDS_AUTHORIZATION: <ledger id> requires <extra change> because <reason>`): triage the requested extension. Within the plan's scope and Non-goals → extend that ledger item's `authorized_change` / `forbidden_expansions` and re-dispatch the fixer (same `--resume-task`) with the extended list; outside the plan's scope → record the item `ESCALATED_TO_HUMAN` and ask the user before any further fix dispatch. Never treat the token as DONE and never re-dispatch unchanged.
  - **Fix-report check (before every re-review).** When the fixer reports DONE, `Read` the `## Fix round <N>` section of `[REPORT_FILE]` and confirm ALL THREE are present: (1) the names of the tests covering each fixed blocker, (2) the exact test command(s), (3) the relevant output. Any of the three missing → return the report to the fixer (re-dispatch naming what is missing); do NOT dispatch the re-review. This read is bookkeeping, not research — reviewers will not re-run the full suite, so the fix report is the test evidence.
  - Next iteration first re-runs the verification gate (Step 3.5) on the updated tree, then re-runs 4.1 from scratch (fresh Opus subagent each round — no bias from previous round), starting with a fresh 4.0 package under the new round's name. The fresh Opus is given the ledger path so it can verify prior-round ACCEPTED items closed cleanly. 4.2 round 2+ is likewise a FRESH task (built-in: Codex) with the full control-review prompt (see `./codex-control-review-prompt.md` follow-up section), reading this round's fresh package — never a prior round's file. Reviewer freshness is a bias decision and is NOT relaxed by `--resume-task`.

**Loop-control checks (Step 4)** — run the SAME ordered procedure as Step 2 (anti-pingpong → no-progress → churn → round cap → next round; first match wins) after every non-empty combined BLOCKING list, with these substitutions:

- **Anti-pingpong and no-progress** apply to each reviewer's own history separately — don't let Opus re-raise what it already rejected, same for Codex Astra.
- **New-blocker churn detector** uses the COMBINED reviewer output (opus-review + codex-control), not each reviewer's history independently — a finding raised by either reviewer counts. Same three conditions as Step 2; `REGRESSION_FROM_AUTHORIZED_FIX` items are excluded from the new-MUST_FIX_NOW count. Both review templates require a `class:` label on every BLOCKING item (4.1 `class:`, 4.2 `authorization_relation:` — `REGRESSION_FROM_AUTHORIZED_FIX` is the shared regression token); a BLOCKING item that arrives WITHOUT a label counts as a NEW `MUST_FIX_NOW` citing no materiality — compute conditions (b)/(c) on that basis rather than stalling.
- **Round cap** escalation content: diff + combined list + one-sentence description of the impasse (have an Opus subagent, effort `high`, write the summary). User picks accept / another round / close.

### Step 4.5 — Review synthesis (only after a multi-round fused review)

When the fused review comes back both-clean AND the loop took **2+ rounds**, produce a consolidated review record before auto-commit (idea borrowed from TRIP-workflow's synthesize step). Each round's verdicts were deltas; the ledger is transient and deleted at plan archival — without synthesis the review history evaporates.

Dispatch `Agent(subagent_type="general-purpose", model="sonnet", effort="medium")` with `./synthesize-review-prompt.md`: ledger path, plan path, phase id, base SHA, the final 4.1/4.2 outputs (DEFER / NITS sections included). The subagent writes `docs/reviews/<slug>-<phase-id>.md` and reports `SYNTHESIS_DONE <path>` on line 1.

- Single-round clean review → SKIP synthesis entirely (nothing to consolidate; the commit message suffices).
- The synthesis file is staged with the phase's auto-commit (see below).
- Escalated / capped loops: if the user chose "accept" at an escalation, still synthesize — the record of what stayed open is the most valuable part. Note the open items under "Open at accept".
- Never write the synthesis on the main thread — it summarizes review content, which is judgment-adjacent; the Sonnet subagent does it from the ledger + verdicts you pass in.

**State line:** `step=synthesize`.

### Step 5 — Final whole-branch review (once per plan, cap=2)

Runs exactly once: after the LAST phase's auto-commit has landed (top-level plan `status` just flipped to `done`), BEFORE plan archival. Every phase passed its phase-scoped gate; this is the single broad merge review of the entire branch. Codex control review does NOT participate in Step 5 (Codex appears only as the announced Astra availability fallback — the second profile of the `final-review` chain). State line: `step=5-final-review round=<k>/2`.

1. **Determine MERGE_BASE**: `git merge-base main HEAD`. If the repo has no `main` branch (master/trunk — the command errors), or the work ran directly on the mainline (with user consent) so it returns HEAD and is useless — fall back to the recorded BASE of the plan's first phase (its frontmatter `commits:` range names the base7).
2. **Build the package** (`dir=$("$WS" <plan-file>)` as in Step 4.0): `"$RPKG" <MERGE_BASE> HEAD "$dir/review-final-r1-<base7>.diff"` — pass the OUTFILE explicitly; the range-mode default would land in the shared `.superpowers/sdd/` root, not the plan-scoped workspace. If the last phase was left uncommitted (user said "no commit"), use WORKTREE mode instead: `"$RPKG" <MERGE_BASE> WORKTREE "$dir/review-final-r1-<base7>.diff"`.
3. **Dispatch ONE Opus subagent** per `./final-review-prompt.md` (`model: "opus"`, `effort: "xhigh"`), filling: repo root, plan path, ledger path, MERGE_BASE/HEAD SHAs, `[DIFF_FILE]` = the printed package path. The anti-coaching scan (Pre-dispatch checklist) applies. If the Opus dispatch fails for availability (usage cap, launch error), the next `final-review` profile takes it, and tell the user: under `routes: default` (no `route` call — "## Routing" item 1), use the template's Codex Astra xhigh fallback; otherwise `"$AD" route final-review --skip <skips>,<the in-session profile the last final-review route line named; built-in opus-xhigh>` gives it — another `inproc` one runs this same dispatch at its model and effort; an external one takes the template's external fallback; when `route final-review` names an external profile first (the user's chain starts there, or its in-session profiles are down/off), that path is taken directly; the ledger reviewer id stays `opus-final` (it names the stage, not the model).
4. **Verdict** (line 1, standard parsing):
   - `REVIEW_OK` → proceed to the clean finish below.
   - `REVIEW_BLOCKING` → record ALL findings in the same ledger (reviewer `"opus-final"`, ids `FR<round>-B<n>`). Findings labeled `plan-mandated` → `ESCALATED_TO_HUMAN`, never handed to a fixer. Everything else → dispatch ONE fixer (operation `final-fix`). If `glm=unprobed`, the kill-switch / any-risk branch has not selected another profile, and the candidate — the first non-down `implementer` profile — is `glm` (built-in: it is; a chain without `glm` never probes GLM), run the same Step 3 pre-dispatch item 4 checks once before evaluating the `glm=down` / default GLM branches: `"$ZDISPATCH" doctor`, then `"$ZDISPATCH" doctor --probe`; both exit 0 → `glm=ok`; either fails → `glm=down` and announce the next profile per that item. Then choose first match wins (each a `route` call — none under `routes: default` while the `channels` marker holds no `off` line, "## Routing" item 1, where the built-in names below apply) — kill switch active → ladder item 1's profile, Codex Luna max (`--write --model gpt-6-luna --effort max`); **the plan has any risk-marked phase** (any non-empty value in `risk_phases`) → `implementer.risk`, Codex Sol xhigh (`--write --model gpt-6.1-sol --effort xhigh`) does the whole wave; `glm=down` → the next `implementer` profile, Codex Luna max; otherwise → the first `implementer` profile, GLM via `$ZDISPATCH` (`--fresh`, preamble prepended). Always FRESH, no resume — the whole-plan fix wave has no single implementer thread; body `$dir/prompts/final-fix-r1.md`, dispatch file `final-fix-r1.<seq>.<profile>.md` in the FRESH fix-type composition (Step 3); an infrastructure failure of the wave follows the retry / channel-switch rule (the re-dispatch is still the whole-plan wave with the same findings list and the same report file). The fixer gets the COMPLETE findings list — all BLOCKING items plus all `MUST_FIX_BEFORE_MERGE` ledger triages. Never one fixer per finding: per-finding fixers each rebuild context and re-run suites; a real session's final-review fix wave cost more than all its tasks combined. Use the fix-round template in `./implementer-prompt.md` with the whole plan (not one phase) as scope and `[REPORT_FILE]` = `$dir/final-fix-report.md`, applying the template's "Step 5 fix wave" substitutions (fresh task with the fresh-fallback re-brief, committed diff against MERGE_BASE, reviewer `opus-final`, fresh report file); the fix-report check from Step 4 applies before the round-2 re-review.
5. **Round 2**: build a FRESH whole-branch package in WORKTREE mode (the fixer does not commit): `"$RPKG" <MERGE_BASE> WORKTREE "$dir/review-final-r2-<base7>.diff"`, then dispatch a fresh Opus (same availability fallback) per the template's Round 2 section, inlining the round-1 fix list.
6. **Cap**: still `REVIEW_BLOCKING` after round 2 → escalate to the user: findings list + ledger path + one-sentence impasse summary (have an Opus subagent, effort `high`, write the summary; if Opus is unavailable, escalate without it and quote the reviewer's `Ready to merge:` line). User picks accept / another round / close.
7. **Clean finish**: on `REVIEW_OK`, if the fixer — or an edit kept at an `agent-invocation` "No-edit check" — changed anything, auto-commit those changes per the common auto-commit rules (stage by name; subject e.g. `fix: address final-review findings for <slug>`). Then — and only then — proceed to "## Plan archival".

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
- `Co-Authored-By: Claude <main-thread model name, e.g. Sonnet 5.5> <noreply@anthropic.com>` trailer — use the model actually running the main thread, not a hardcoded name.

### For a Sonnet quickfix (no plan file)

Stage only the touched files. Conventional-commit as above.

### Common rules (both paths)

- Never `--no-verify`. Never `--amend`.
- **Never `git push`** unless the user has explicitly approved push **in the current session**. Auto-commit covers commit only, not push — even across phase boundaries. If push is needed, ask and wait.

### Skip auto-commit if

- User said "no commit" / "не коммить" / "just show me the diff".
- `git status` shows unrelated uncommitted changes not from this task, a staged one included (`git commit` commits the whole index) — warn user, let them decide. Exception: the untracked ledger file (`docs/plans/<slug>.ledger.json`) is expected orchestrator state, never "unrelated changes" — ignore it for this check.
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
- The implementer reported `BLOCKED` that more context cannot resolve.
- Findings from the just-completed phase invalidate a later phase's scope → propose plan revision first.
- User explicitly requested a pause in the original request ("после Ф1 остановись", "let me see Ф1 before Ф2").
- The upcoming phase includes **irreversible side-effects** (prod schema migration, external API writes, destructive git ops) — flag before dispatching the implementer.

None of these are a routine "confirm?" prompt — they are real blockers.

## Parallel groups (two tracks max)

The plan writer may mark 2 phases as a **parallel group** in the frontmatter (`parallel_group: G1` on both phases — see `writing-plans` / `opus-plan-writer-prompt.md` for the marking rules; canonical case: a BE+FE pair with a frozen contract). When the next pending phases share a `parallel_group`, run them as two concurrent tracks instead of sequentially. If you see 3+ phases in one group, run 2 at a time — the width cap is HARD (subscription rate limits + orchestrator attention).

Routing per track = the channel ladder per phase (Step 3): frontend-only phase → Claude frontend implementer subagent (Opus `high` for new UI, Sonnet `medium` for tweaks); everything else → the profile the ladder decides (built-in: GLM, Luna or Sol). Any pair of profiles is valid (GLM+GLM, GLM+Luna, Codex+Claude, …). **Shared-profile concurrency:** when `zcode-invocation` records `GLM concurrency: 1` (two ZCode processes cannot run at once), a group runs at most **one** GLM track; likewise for any profile whose `route` line shows `maxParallel=1`. First resolve each track's profile by the ladder as usual (frontend-only → Claude, risk-marked → `implementer.risk`, kill switch / `glm=down` / earlier hand-off → the next profile); only when **both** tracks resolved to the same such profile, the track whose phase is listed first in the frontmatter keeps it and the other takes the next profile ("## Routing" item 4; built-in: Luna max) for the duration of the group, announced in the group's setup line. A `"$AD" task` refused with `is at maxParallel` → the track takes the next profile the same way. A pair on two different profiles is unaffected. `"$AD" task` counts core jobs only: on a `codex` or `zcode` profile (`glm`: the `GLM concurrency` line instead) keep the route line's `maxParallel=<n>` across the two tracks yourself, for every role (implementers, reviewers, gates, in-session roles on an external profile) — before each dispatch of a track on such a profile, count the running jobs of both tracks on it (`"$AD" status --cwd <worktree>` per track; it lists a Codex job under the first `"$AD" channels` codex profile with the same model and effort and a ZCode job under `glm`, so count those lines as jobs on this profile); at `<n>` the dispatch counts as refused with `is at maxParallel`, and the track takes the next profile of that role's chain. Never under `routes: default`: no route line there, and each built-in `codex` profile allows 2 with at most one job per track; an `SP_IMPLEMENTER` profile has no route line either, and its `maxParallel` is not checked.

**Preconditions (all must hold; else fall back to sequential):**
1. Both phases `pending`, same `parallel_group`, plan approved by Step 2.
2. `git status` clean in the main working tree.
3. No other write task running on **any** dispatcher — the store check of "## Durable Progress" item 4 (`"$AD" status`; `"$DISPATCH" status` and `"$ZDISPATCH" status` for a skipped store or without `$AD`). The width cap (max 2 concurrent write tasks) counts across all dispatchers.

**Track lifecycle:**

1. **Setup.** First flip both phases to `status: in-progress` in the plan frontmatter on the main branch and commit `docs(plans): start parallel group <G> (<id>+<id>)`. THEN, for EACH phase, from the main tree:
   `git worktree add <repo-parent>/<repo-name>-wt-<phase-id> -b wt/<slug>/<phase-id>` (branches off the current branch). Order matters: a worktree created before the flip commit would carry a plan copy that forever shows both phases `pending`, breaking any resume read inside the track.
2. **Dispatch both implementers concurrently.**
   - External profiles (GLM / Codex / `$AD`): standard implementer dispatch on the track's profile plus `--cwd <worktree-path>` (`--prompt-file` as usual; the dispatch file lives in the track's own `$dir/prompts/`). In the prompt, `Repository root:` = the worktree path.
   - Claude subagent: prompt names the worktree path as the working root and forbids touching anything outside it.
3. **Poll both.** External profiles via Monitor — every `task` / `status` / `result` / `cancel` for a track carries the track's `--cwd <worktree-path>` on whichever dispatcher owns the job (the job lives in that worktree's workspace); Claude via Agent completion. Handle each track's verdict independently per Step 3 rules.
4. **Steps 3.5 + 4 per track, independently** — verification gate first (Sonnet subagent pointed at the track's worktree), then the same fused review loop, run against the track's worktree: build each round's package (4.0) by running `"$WS"` / `"$RPKG"` with cwd inside that worktree, so the package and report paths point into the worktree; Opus reviewer and Codex control reviewer get the worktree path as repo root (external profiles: `--cwd`). Per-track ledger lives INSIDE the worktree at `<worktree>/docs/plans/<slug>.ledger.json` — tracks never share a ledger. All fix-round dispatches carry the track's `--cwd`.
5. **Commit per track.** When a track's fused review is clean: stage the phase's files by name and commit IN THE WORKTREE (conventional subject, Co-Authored-By trailer, no plan-file edits there).
6. **Merge (sequential, main tree).** After BOTH tracks committed: `git merge --no-ff wt/<slug>/<id-1>` then `git merge --no-ff wt/<slug>/<id-2>`. A conflict means the plan's independence claim was wrong — abort the merge, escalate to the user with both branch names. Do not resolve conflicts yourself.
7. **Integration check (dispatched — not run on main).** The tracks were reviewed in isolation; the merged combination was never tested. Dispatch `Agent(subagent_type="general-purpose", model="sonnet", effort="medium")`:

   ```
   Run the repository's standard verification in <repo-root>: tests, typecheck, linter (whatever the repo provides). Do not modify any files. Report line 1 exactly `INTEGRATION_OK` or `INTEGRATION_FAIL`, then the failing commands and output excerpts.
   ```

   - `INTEGRATION_FAIL` → dispatch the integration repairer (operation `repair r<N>`, FRESH, main tree) with the failure report + plan path + both phase ids to repair the integration; re-run the check. The repairer is chosen like the Step 5 fixer. If `glm=unprobed`, the kill-switch / group-risk branch has not selected another profile, and the candidate — the first non-down `implementer` profile — is `glm` (built-in: it is; a chain without `glm` never probes GLM), run the same Step 3 pre-dispatch item 4 checks once before evaluating the `glm=down` / default GLM branches: `"$ZDISPATCH" doctor`, then `"$ZDISPATCH" doctor --probe`; both exit 0 → `glm=ok`; either fails → `glm=down` and announce the next profile per that item. Then use first-match order (built-in profiles named): kill switch active → ladder item 1's profile, Codex Luna max; either phase of the group risk-marked (non-empty `risk_phases` entry) → `implementer.risk`, Codex Sol xhigh; `glm=down` → the next `implementer` profile, Codex Luna max; otherwise → the first `implementer` profile, GLM via `$ZDISPATCH` (`--fresh`). Body `$dir/prompts/repair-<G>-r<N>.md`; round 2 of the repair resumes the repairer (`--resume-task` on its own harness). Cap 2 repair rounds, then escalate.
   - **Repair gate + commit.** If the repair changed anything, it has passed no review yet: run ONE Opus review round on the repair diff (4.1 template at `effort: "high"`, `"xhigh"` per the 4.1 escalation rule; package `"$RPKG" HEAD WORKTREE "$dir/review-repair-<G>-r1.diff"` — the repair is uncommitted against the merged HEAD). Blocking verdict → one fix round via the ledger sequence, then escalate. Clean → stage the repair's files by name and commit `fix: repair integration of group <G>` — an uncommitted repair would otherwise trip the next phase's unrelated-uncommitted-changes guard.
8. **Bookkeeping + cleanup.** First merge each track's ledger (`<worktree>/docs/plans/<slug>.ledger.json`) into the main ledger: append its entries, re-suffixing ids on collision with the track's phase id (e.g. `F1-B1-Ф2`) — per-track ledgers die with their worktrees, and Step 5's triage reads only the main ledger. Then flip both phases to `done` (next pending → `in-progress`) in the plan frontmatter, each with its `commits: "<base7>..<head7>"` range (base recorded at the track's dispatch, head = `git rev-parse --short HEAD` after both merges), commit `docs(plans): complete parallel group <G>`. Then `git worktree remove <path>` and `git branch -d wt/<slug>/<id>` for both tracks. Report: `Group <G> merged: <sha-1>, <sha-2>. Starting <next>.`

**Failure asymmetry.** If one track passes and the other escalates (cap, BLOCKED): merge the passing track alone (steps 6–8 for it, its phase → `done`), keep the failed track's worktree intact, and escalate with the worktree path. Never delete a worktree with unmerged work.

**Resume.** If resume-check finds TWO `in-progress` phases sharing a `parallel_group`, run `git worktree list`: worktrees exist → offer to continue the group from where each track stopped; missing → offer to restart the group (re-create worktrees, re-dispatch Step 3).

**State line during a group:** replace `impl=` with `tracks=<id>:<step>-r<k>@<impl>,<id>:<step>-r<k>@<impl>` (e.g. `tracks=Ф2:4-r1@glm:zt-0003,Ф3:3@luna:task-0011`).

## Authorized Change Ledger

`AUTHORIZED_CHANGE_LEDGER` is the explicit state object the orchestrator maintains across every CHANGES_REQUESTED verdict in Step 2 (plan review) and Step 4 (fused review), plus pre-flight findings the user accepts (Step 2.5, reviewer `preflight`) and Step 5's final-review findings (reviewer `opus-final`). After every CHANGES_REQUESTED, the orchestrator MUST create or update the ledger before dispatching a fixer.

**Where it lives.** `docs/plans/<slug>.ledger.json` — one file per active plan, shared between the Step 2, Step 4, and Step 5 loops. The ledger is transient orchestrator state, NOT a source artifact: never staged, never committed. It outlives the top-level `status: done` flip — Step 5 still reads and extends it. Only on plan archival (Step 5 returned `REVIEW_OK`) or abandonment does the orchestrator delete it via `rm` or `git clean`. Reviewers and fixers reference the ledger by absolute path; the orchestrator may also inline the open items into the dispatcher prompt when that is more compact than a path read.

**Who writes it.** The Sonnet orchestrator main thread, via `Write` / `Edit` on the JSON file. This is mechanical state-keeping, not production code — the no-writes-on-main rule (HARD RULE 1) does NOT apply here, parallel to the existing plan-file frontmatter exemption.

**Item shape** (one entry per triaged reviewer finding):

```json
{
  "id": "P<round>-B<n> | PF-B<n> | F<round>-B<n> | FR<round>-B<n>",
  "reviewer": "codex-plan | preflight | opus-review | codex-control | opus-final",
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
    "reviewer": "codex-plan",
    "decision": "ACCEPTED",
    "authorized_change": "Add a step to Ф2: invalidate the session cookie on password change",
    "forbidden_expansions": ["do not add a global session-revocation service"],
    "materiality": "SECURITY",
    "status": "open"
  },
  {
    "id": "P1-B2",
    "reviewer": "codex-plan",
    "decision": "PARTIALLY_ACCEPTED",
    "authorized_change": "Fix the Ф1/Ф3 signature mismatch for createUser() — align Ф3 to the Ф1 contract; do NOT redesign the contract",
    "forbidden_expansions": [],
    "materiality": "BUILD_BREAK",
    "status": "open"
  },
  {
    "id": "P1-B3",
    "reviewer": "codex-plan",
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

- Entering each step: one line. Example: `Plan ready, sending to Codex Astra xhigh for plan review (round 1/4)`.
- Each loop iteration: one line with verdict summary. Example: `Opus review round 2/4: REVIEW_BLOCKING (3 items). Dispatching the fixer (GLM-5.3-Flash max).`
- **Implementer channel lines are mandatory, one line each:** `Ф2 → GLM-5.3-Flash max via ZCode (zt-0007).` · `GLM channel failed (errorClass=quota) — Ф2 falls back to Luna max (task-0012); GLM off for this session.` · `Ф3 is risk-marked (DATA_LOSS) → Sol 6.1 xhigh (task-0013).` · `Ф2 review round 3 still BLOCKING → fix round 3 on Sol 6.1 xhigh (task-0015).` · `Gate stalled on Ф2 → Opus diagnosis: ENVIRONMENT (machine) — paused; commands for you below.` · With built-in profiles only (no `config.json`) every announcement is word for word these lines or the one its rule spells out, the models named `Luna max` / `Sol 6.1 xhigh`, never by profile name (`luna`). Rebound roles name the profile: `Ф2 → deepseek-dsh (dsh, deepseek-v4-pro high) (dt-0002).` · `Channel implementer: glm-api → deepseek-dsh (glm-api: quota).`
- Do **not** narrate polling ("still running...", "elapsed 40s").
- End of turn: 1–2 sentences — what changed, what's next.

## Red Flags — never

- **Write production code, tests, or any source edit on the main thread** (Rule 1 at the top — repeated here because it's the one that gets broken). If you are reasoning towards "but this file is tiny / I already understand it / it's just the test part" — STOP and dispatch a subagent.
- **Do research on main** — `Read`/`Grep` on source, running `pytest` / linters / build scripts, reading plan body beyond frontmatter (Rule 2). If you are reasoning towards "but I just need to see what's failing / what the current code looks like / what this error means" — STOP and dispatch Explore.
- Do architectural judgment (plans, reviews, BLOCKED diagnosis) on main — dispatch the Opus plan writer, the Codex Astra plan reviewer, the Opus code reviewer, or the Opus diagnosis subagent.
- Offer, suggest, or default to `--effort ultra` — ultra is exclusively user-initiated. If the user didn't say "ultra", it does not exist.
- Dispatch a Claude subagent without an explicit `effort`, put `ultrathink` in its prompt, or run any role at a model/effort other than its `route` line's (built-in: the Model split table's).
- `Agent(subagent_type="codex:codex-rescue", ...)` or `Bash("codex exec ...")` — both silently auto-reject.
- `--resume-last` anywhere in this protocol — positional resume lands in whatever thread happens to be newest, regardless of role. All resumes are `--resume-task <task-id>` against the SAME role's prior dispatch; a wrong resume poisons the thread with another role's instructions. The Step 2 plan review and control review rounds 2+ stay FRESH by design. Ids are per dispatcher — a `zt-` id never goes to `$DISPATCH`, a `task-` id never to `$ZDISPATCH`, and a `ct-`/`oc-`/`pi-`/`dt-` id goes only to `"$AD"` on the profile that started it.
- Skip Step 4.1 and go straight to 4.2 — Opus review is always first; Codex Astra is a control, not primary.
- Start (or resume) the fused review without a `GATE_OK` from Step 3.5 on the current tree state — reviewers read code; the gate is what proves the tree builds and its tests pass.
- Run the verification gate on the main thread ("it's just pytest") — the gate is a dispatched Sonnet subagent, per Rule 2.
- Run 4.2 if 4.1 returned BLOCKING — save the dispatch.
- Dispatch a reviewer (4.1, 4.2, or Step 5) without THIS round's freshly generated review package — run `"$RPKG"` first and name the printed path in the prompt.
- Tell a reviewer what not to flag, or pre-rate a finding's severity in the dispatch prompt ("treat it as Minor at most") — referencing already-triaged ledger entries by id is the only allowed form (see the anti-coaching scan).
- Triage a `plan-mandated` finding into ACCEPTED or REJECTED_BY_SCOPE — its only ledger decision is `ESCALATED_TO_HUMAN`.
- Re-dispatch a phase whose frontmatter status is `done` — after any compaction or resume, check the frontmatter and `git log` first (see "## Durable Progress").
- Mark a phase done while a CANNOT_VERIFY item is still open.
- Dispatch one fixer per finding in Step 5 — the final-review fix wave is ONE implementer task with the complete list.
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
- **Extract tokens from `~/.zcode`, read `credentials.json`, or call the Z.ai API / SDK directly** — it violates the Coding Plan terms. The ZCode CLI through `$ZDISPATCH` is the only channel.
- **Dispatch on any profile but the one `route` named for this dispatch or switch (under `routes: default`, the built-in scheme's), the phase's current channel (ladder item 4) or the `SP_IMPLEMENTER` profile** — external work goes only through `$ZDISPATCH`, `$DISPATCH` or `"$AD"`.
- **Give GLM a SECURITY / DATA_LOSS phase** — risk-marked phases run on the `implementer.risk` profile (built-in: Sol in the Codex sandbox); `glm` only when the user's own `implementer.risk` chain names it.
- **Run two write tasks in one working tree across dispatchers**, or more than 2 write tasks in total — check all three stores before every dispatch ("## Durable Progress" item 4).
- **Switch implementer channels silently** — every fallback and escalation is one announced line ("## Reporting cadence").
- **Call `zcode -p` (or `node zcode.cjs`) bypassing the wrapper** — the wrapper is what guarantees the env, the identification headers, the git-tree guard and the job record. Likewise never call `claude -p`, `opencode`, `pi` or `dsh` past `"$AD"`, and never run `"$AD" key set` (a user action).
- **Change ZCode settings, plugins or the API key on the user's behalf** — storing or clearing the Coding Plan API key (`"$ZDISPATCH" api-key set|clear`), enabling or disabling plugins are user actions; ask, never do, and never ask for the key in the chat. Never run the CLI's own `zcode login` / `logout`. The wrapper's own personal provider config (the model pin and the user's API-key rule, mode 0600) is the only ZCode-format file it writes.

## Prompt templates (siblings)

- `./opus-plan-writer-prompt.md` — Opus subagent, plan writing (xhigh, Step 1) / revision (high, Step 2 Mode B)
- `./codex-plan-reviewer-prompt.md` — Codex Astra xhigh, plan review (Step 2)
- `./implementer-prompt.md` — GLM-5.3-Flash max via ZCode (default) / Codex Luna max (fallback) / Codex Sol xhigh (risk-marked phases, escalation) / any rebound profile, implementation + fix rounds (Step 3 / 3.5 / 4 / 5, non-frontend phases); carries the ZCode preamble and the channel-switch notice (core harnesses: the headless preamble from `agent-invocation`)
- `./claude-frontend-implementer-prompt.md` — Claude subagent (Opus high / Sonnet medium), implementation (Step 3, frontend-only phases)
- `./verification-gate-prompt.md` — Sonnet medium subagent, verification gate (Step 3.5)
- `./opus-review-prompt.md` — Opus subagent (high; xhigh on escalation), code review (Step 4.1, fused spec + quality)
- `./codex-control-review-prompt.md` — Codex Astra high, control review on diff (Step 4.2)
- `./synthesize-review-prompt.md` — Sonnet medium subagent, review synthesis (Step 4.5)
- `./final-review-prompt.md` — Opus xhigh subagent (Codex Astra xhigh fallback), final whole-branch review (Step 5)
- `./sonnet-quickfix-prompt.md` — Sonnet medium subagent, trivial path
