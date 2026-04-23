# superpowers-strigov-ver

A Claude Code plugin that replaces the default "Claude does everything" mode with a **structured multi-model development workflow**: Sonnet orchestrates, Opus judges, Codex implements and reviews.

Current repo/plugin version: `0.2.3`.

## The idea

Claude Code's default behavior puts one model in charge of everything — planning, coding, reviewing, committing. This works for small tasks but breaks down on anything non-trivial: the model that writes code also reviews it, which is a conflict of interest; there's no plan to hold work accountable to; each session starts from scratch.

This plugin replaces that with a division of labor matched to what each model is actually good at:

- **Sonnet** (main thread) — cheap, fast orchestration. Reads output, dispatches next step, polls, does git. Never writes production code.
- **Opus** (subagent) — judgment. Writes the plan, reviews code, diagnoses blockers. Gets a clean context every invocation.
- **Codex xhigh** — skeptical read-only review. Plan review before implementation starts; control review after Opus clears the code.
- **Codex high** — implementation. Writes the actual files.

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
Step 1  Opus subagent writes a plan
        └─ docs/plans/YYYY-MM-DD-<slug>.md
           YAML frontmatter: phases, statuses
           Sections: Goal · Files · Contracts · Test strategy · Risks · Phases

Step 2  Codex xhigh reviews the plan  (loop, cap=4)
        └─ APPROVED → commit plan, go to Step 3
           CHANGES_REQUESTED → Opus revises in place → Codex re-reviews
           4 rounds without approval → escalate to user

Step 3  Codex high implements current phase  (--write --effort high)
        └─ DONE → Step 4
           DONE_WITH_CONCERNS → Sonnet reads concerns, decides
           NEEDS_CONTEXT → provide context, re-dispatch
           BLOCKED → Opus diagnoses → escalate or add context and retry

Step 4  Fused review  (loop, cap=4)
        ├─ 4.1  Opus reviews: spec compliance first, then quality
        │        REVIEW_OK → trigger 4.2
        │        REVIEW_BLOCKING → back to Codex high with fix list
        └─ 4.2  Codex xhigh control review (only if 4.1 passed)
                 Orthogonal angle: edge cases, races, security, plan-vs-code gaps
                 BOTH CLEAN → auto-commit, advance to next phase
                 BLOCKING → back to Codex high with combined list

Step 5  Auto-commit
        └─ Updates plan frontmatter (phase status: done → next: in-progress)
           Conventional-commit subject, why-focused body
           Co-Authored-By trailer
           Never git push without explicit user approval
```

### Multi-phase plans

A plan can have multiple phases (Ф1, Ф2, Ф3…). Steps 1 and 2 cover **all phases at once** upfront. Steps 3–5 run **per phase** with no confirmation prompts between them — the plan was already approved.

### Resume across sessions

The plan file is the single source of truth. If a session is interrupted, the orchestrator scans `docs/plans/` for a plan with `status: in-progress`, surfaces it to the user, and picks up at the right phase.

---

## Safety guards

**Anti-pingpong**: if Codex raises a review point that was already explicitly rejected with reasoning in a prior round, it is marked `resolved-by-decision` and not looped on again.

**No-progress detector**: if two consecutive review rounds produce an identical blocking list, the loop escalates immediately instead of running to cap.

**Escalation cap**: 4 rounds without clean review → Opus writes a one-sentence summary of the impasse, user decides: accept / another round / close.

**Auto-commit rules**: never `--no-verify`, never `--amend`. Skips auto-commit if unrelated uncommitted changes exist in the tree. Never pushes without explicit per-session user approval.

---

## Included skills

Beyond `dev-orchestrator` and `codex-invocation`, the plugin bundles 12 skills from [superpowers](https://github.com/obra/superpowers) v5.0.7 (namespace-stripped):

| Skill | What it does |
|---|---|
| `brainstorming` | Interactive visual brainstorm with a local browser companion |
| `dispatching-parallel-agents` | Pattern for running independent subagents in parallel |
| `executing-plans` | Guidance for executing a written plan step by step |
| `finishing-a-development-branch` | Checklist before merging: tests, coverage, review, PR |
| `receiving-code-review` | How to process and respond to code review feedback |
| `requesting-code-review` | How to request a thorough code review from a subagent |
| `systematic-debugging` | Root-cause-first debugging protocol with test-pressure resistance |
| `test-driven-development` | TDD cycle adapted for Claude Code; anti-patterns reference |
| `using-git-worktrees` | Safe parallel work via git worktrees |
| `verification-before-completion` | Checklist before declaring any task done |
| `writing-plans` | How to write a good implementation plan |
| `writing-skills` | How to author Claude Code skills; Anthropic best practices |

Also included: the `code-reviewer` agent from upstream.

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
2. **OpenAI Codex plugin** — install via `/plugin marketplace add github:openai/codex-plugin-cc` then `/plugin install codex`
3. **Codex login** — run once per machine: `!codex login` (the `!` prefix runs it in your shell)

### Codex path assumption

`codex-invocation` and all `dev-orchestrator` prompts hardcode the Codex companion path:

```
~/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs
```

If your installed Codex version differs, update the path in:
- `skills/codex-invocation/SKILL.md`
- `skills/dev-orchestrator/implementer-prompt.md`
- `skills/dev-orchestrator/plan-reviewer-prompt.md`
- `skills/dev-orchestrator/opus-review-prompt.md`
- `skills/dev-orchestrator/codex-control-review-prompt.md`

Or symlink the expected path to your actual version.

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
