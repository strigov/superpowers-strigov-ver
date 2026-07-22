# superpowers-strigov-ver

A Claude Code plugin that replaces the default "Claude does everything" mode with a **structured multi-model development workflow**: Sonnet orchestrates, Opus judges, Codex implements and reviews.

Current repo/plugin version: `0.6.1`.

## The idea

Claude Code's default behavior puts one model in charge of everything — planning, coding, reviewing, committing. This works for small tasks but breaks down on anything non-trivial: the model that writes code also reviews it, which is a conflict of interest; there's no plan to hold work accountable to; each session starts from scratch.

This plugin replaces that with a division of labor matched to what each model is actually good at:

- **Sonnet** (main thread) — cheap, fast orchestration. Reads output, dispatches next step, polls, does git. Never writes production code.
- **GPT-5.6 Sol max** (Codex) — plan writing and plan revisions. (`ultra` — Sol's parallel-subagent mode — exists but is used only when the user explicitly asks for it.)
- **Opus** (subagent, `ultrathink`) — judgment default. Reviews the plan, reviews the code (4.1 routine rounds). Gets a clean context every invocation.
- **Fable 5** (subagent, `ultrathink`) — judgment escalation tier, included in Max plans: writes specs/ADRs in `brainstorming`, takes over 4.1 on SECURITY/DATA_LOSS phases or from round 3 of the fused loop, diagnoses BLOCKED, writes impasse summaries. Falls back to Opus (with an explicit note to the user) when the weekly Fable budget is out.
- **GPT-5.6 Luna max** (Codex) — implementation and fix rounds. Cheap, strong agentic coder; **GPT-5.6 Terra xhigh** is the reasoning escalation when Luna gets stuck.
- **GPT-5.6 Sol xhigh** (Codex) — skeptical read-only control review after Opus clears the code (4.2).

**Family rule**: writer and reviewer of the same artifact are never from the same model family — Sol writes the plan, Opus reviews it; Luna writes the code, Opus reviews it and Sol cross-checks.

The result: a plan exists before a line of code is written, two independent reviewers sign off before anything commits, and the whole session is resumable across days.

---

## Workflow

### Triage

Every task goes through a triage first:

```
Single-file change, <20 lines, no architectural judgment?
  YES → Sonnet quickfix subagent (fast path, no review loop)
  NO  → Full protocol
```

### Full protocol (5 steps)

```
Step 1  Codex Sol max writes a plan  (--write)
        └─ docs/plans/YYYY-MM-DD-<slug>.md
           YAML frontmatter: phases, statuses
           Sections: Goal · Files · Contracts · Test strategy · Risks · Phases

Step 2  Opus reviews the plan  (loop, cap=4; fresh subagent each round)
        └─ APPROVED → commit plan, go to Step 3
           CHANGES_REQUESTED → Sol revises its own thread (--resume-task) → fresh Opus re-review
           4 rounds without approval → escalate to user

Step 3  Codex Luna max implements current phase  (--write)
        (BLOCKED + "needs more reasoning" → resume the thread at Terra xhigh)
        └─ DONE → Step 3.5
           DONE_WITH_CONCERNS → Sonnet reads concerns, decides
           NEEDS_CONTEXT → provide context, resume implementer thread (--resume-task)
           BLOCKED → Fable diagnoses (Opus fallback) → escalate or add context and retry

Step 3.5  Verification gate  (Sonnet subagent; re-runs after every fix round)
        └─ lint + typecheck + affected tests green BEFORE any review round
           GATE_OK → one-line summary fed into both reviewer prompts
           GATE_FAIL → back to implementer (doesn't consume a review round; cap=2)

Step 4  Fused review  (loop, cap=4)
        ├─ 4.1  Opus reviews: spec compliance first, then quality
        │        (Fable takes over on SECURITY/DATA_LOSS phases or round 3+)
        │        REVIEW_OK → trigger 4.2
        │        REVIEW_BLOCKING → back to the fixer with fix list
        └─ 4.2  Codex Sol xhigh control review (only if 4.1 passed)
                 Orthogonal angle: edge cases, races, security, plan-vs-code gaps
                 BOTH CLEAN → Step 4.5 → auto-commit, advance to next phase
                 BLOCKING → fixer resumes its own thread (--resume-task) with combined list

Step 4.5  Review synthesis  (only when the loop took 2+ rounds)
        └─ Sonnet subagent consolidates ledger + final verdicts into
           docs/reviews/<slug>-<phase>.md — the archival review record

Step 5  Auto-commit
        └─ Updates plan frontmatter (phase status: done → next: in-progress)
           Stages phase files + plan + review synthesis (when produced)
           Conventional-commit subject, why-focused body
           Co-Authored-By trailer
           Never git push without explicit user approval
```

All Codex resumes are **thread-addressed** (`--resume-task <task-id>`, a local extension of the vendored companion): each role — plan writer, implementer — continues exactly its own thread, no matter what ran in between. Claude-side reviews (plan review, 4.1) and the Step 4 control review are fresh each round by design: an independent reviewer must not anchor on its own prior rounds.

### Multi-phase plans

A plan can have multiple phases (Ф1, Ф2, Ф3…). Steps 1 and 2 cover **all phases at once** upfront. Steps 3–5 run **per phase** with no confirmation prompts between them — the plan was already approved.

### Resume across sessions

The plan file is the single source of truth. If a session is interrupted, the orchestrator scans `docs/plans/` for a plan with `status: in-progress`, surfaces it to the user, and picks up at the right phase.

---

## Safety guards

**Anti-pingpong**: if Codex raises a review point that was already explicitly rejected with reasoning in a prior round, it is marked `resolved-by-decision` and not looped on again.

**No-progress detector**: if two consecutive review rounds produce an identical blocking list, the loop escalates immediately instead of running to cap.

**Escalation cap**: 4 rounds without clean review → Fable writes a one-sentence summary of the impasse (Opus fallback), user decides: accept / another round / close.

**Auto-commit rules**: never `--no-verify`, never `--amend`. Skips auto-commit if unrelated uncommitted changes exist in the tree. Never pushes without explicit per-session user approval.

---

## Included skills

Two support skills were adapted from [TRIP-workflow](https://github.com/PiLastDigit/TRIP-workflow) (MIT):

| Skill | What it does |
|---|---|
| `codex-ask` | Grounded advisory second opinion from Codex on any question — architecture calls, debugging hypotheses, red-teaming a conclusion. Read-only, threaded per topic, nothing gated on the answer. |
| `architecture-memory` | Maintain `docs/ARCHI.md` — a persistent, tool-agnostic architecture memory (~10–20k token budget), with update discipline wired into dev-orchestrator prompts and a compaction procedure + token-count script. |

Beyond those, `dev-orchestrator`, and `codex-invocation`, the plugin bundles 12 skills from [superpowers](https://github.com/obra/superpowers) v5.0.7 (namespace-stripped):

| Skill | What it does |
|---|---|
| `brainstorming` | Interactive visual brainstorm; specs/ADRs written by Fable, reviewed by Codex Sol xhigh |
| `dispatching-parallel-agents` | Pattern for running independent subagents in parallel |
| `executing-plans` | Guidance for executing a written plan step by step |
| `finishing-a-development-branch` | Checklist before merging: tests, coverage, review, PR |
| `receiving-code-review` | How to process and respond to code review feedback |
| `requesting-code-review` | How to request a thorough code review from a subagent |
| `systematic-debugging` | Root-cause-first debugging protocol with test-pressure resistance |
| `test-driven-development` | TDD cycle adapted for Claude Code; anti-patterns reference |
| `using-git-worktrees` | Safe parallel work via git worktrees |
| `verification-before-completion` | Checklist before declaring any task done |
| `writing-plans` | Standalone plan production — same Sol-max-writes / Opus-reviews pair as the orchestrator |
| `writing-skills` | How to author Claude Code skills; Anthropic best practices |

**Code review** is dispatched as an Opus subagent via `Agent(subagent_type="general-purpose", model="opus", ...)` — see `skills/requesting-code-review/`. The standalone `code-reviewer` agent type from upstream was removed; use the skill instead.

**Not included from upstream**: `subagent-driven-development` (replaced by `dev-orchestrator`), `using-superpowers` (aggressive directive injection not wanted), the SessionStart hook.

---

## Installation

```
/plugin marketplace add strigov/strigov-cc-plugins
/plugin install superpowers-strigov-ver@strigov-cc-plugins
```

Обновление в дальнейшем:

```
/plugin update superpowers-strigov-ver@strigov-cc-plugins
```

### Requirements

1. **Claude Code** (any recent version)
2. **Codex CLI** — `npm install -g @openai/codex` (the standalone CLI, not the OpenAI codex Claude Code plugin — we vendor what we need from that plugin under `vendor/codex-companion/`, see below)
3. **Codex login** — run once per machine: `!codex login` (the `!` prefix runs it in your shell)

### Vendored Codex companion

The Codex companion runtime (originally part of OpenAI's `codex-plugin-cc`) is vendored into this plugin under `vendor/codex-companion/` (Apache-2.0, copyright OpenAI; see `vendor/codex-companion/LICENSE` and `NOTICE`). Vendored release: see `vendor/codex-companion/VERSION`.

All Codex calls go through the wrapper `bin/codex-dispatch`, which:
- resolves `vendor/codex-companion/scripts/codex-companion.mjs` from either the marketplace install path (`~/.claude/plugins/cache/strigov-cc-plugins/superpowers-strigov-ver/<version>/...`) or the local dev tree;
- pins `CLAUDE_PLUGIN_DATA` to `~/.claude/plugins/data/superpowers-strigov-ver-codex` so jobs and broker state stay isolated from any other codex install on the same machine;
- for `task`/`review`/`adversarial-review`, auto-injects `--model gpt-5.6-sol` (overridable via `CODEX_DEFAULT_MODEL` env or by passing an explicit `--model` flag) so the backend can't auto-downgrade to spark on small/low-effort calls; protocol dispatches pass explicit per-role models (Sol plan/review, Luna implementation, Terra escalation).

The vendored companion carries local patches on top of the upstream release (listed in `vendor/codex-companion/VERSION`), most notably `task --resume-task <task-id>` — thread-addressed resume that continues exactly the referenced task's Codex thread regardless of what ran in between — and the `max` / `ultra` reasoning efforts for GPT-5.6 (upstream v1.0.6 still caps at `xhigh`). This is what lets each protocol role keep its own persistent thread (idea borrowed from TRIP-workflow's per-target thread files). Re-apply the patches when bumping the vendored runtime.

You no longer need OpenAI's `codex-plugin-cc` installed in Claude Code. To bump the vendored runtime, copy the contents of `plugins/codex/{scripts,prompts,schemas}` and the top-level `LICENSE`/`NOTICE` from a newer `openai/codex-plugin-cc` release tag into `vendor/codex-companion/` and update `VERSION`.

---

## Usage

```
/dev <task description>
```

Or just describe an implementation task in plain language — `dev-orchestrator` triggers on keywords like *implement*, *build*, *write the code*, *реализуй*, *запили*, *накодь*.

For trivial edits (rename, typo fix, obvious single-line bugfix) the skill routes to Sonnet quickfix automatically — no Codex round trips.

---

## Upstream attribution

Original `superpowers` plugin: https://github.com/obra/superpowers — MIT-licensed.  
Skills copied from upstream 5.0.7; `superpowers:` namespace stripped; references to `subagent-driven-development` rewritten to `dev-orchestrator`.

Several mechanisms were adapted from [TRIP-workflow](https://github.com/PiLastDigit/TRIP-workflow) by PiLastDigit — MIT-licensed: thread-addressed Codex resume (their per-target thread files → our `--resume-task`), the verification gate before review (their testing gate), the review synthesis step, the `codex-ask` skill, and the ARCHI.md architecture-memory concept with its token-count script.
