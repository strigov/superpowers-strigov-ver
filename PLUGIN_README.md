# superpowers-strigov-ver

Personal Claude Code plugin assembled from:
Current repo/plugin version: `0.5.2`.

- **`dev-orchestrator`** — multi-model subagent-driven workflow (GPT-5.6 Sol max plan + Opus plan-review loop + GPT-5.6 Luna max implement with Terra xhigh escalation + Sonnet verification gate + Opus code review + Sol xhigh control review + review synthesis, auto-commit, loop cap=4 with anti-pingpong / no-progress guards; thread-addressed Codex resume via `--resume-task`; `ultra` effort strictly user-initiated).
- **`codex-invocation`** — reference recipe for calling Codex via the `bin/codex-dispatch` wrapper around the vendored `codex-companion.mjs` (background mode + Monitor polling; bypasses the silent auto-reject on standard Agent/`codex exec` paths and pins the default model to `gpt-5.6-sol` to block backend auto-downgrade to spark; per-role GPT-5.6 routing table included).
- **`codex-ask`** — grounded advisory second opinion from Codex on any question (read-only, threaded per topic, nothing gated on the answer). Adapted from TRIP-workflow.
- **`architecture-memory`** — maintain `docs/ARCHI.md`, a persistent tool-agnostic architecture memory with token budget, update discipline, and compaction script. Adapted from TRIP-workflow.
- 12 upstream skills copied from `superpowers` (Jesse Vincent / obra), namespace-stripped: `brainstorming`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `verification-before-completion`, `writing-plans`, `writing-skills`. `brainstorming` extended to delegate spec writing to Opus and spec review to Codex Sol xhigh; `writing-plans` delegates plan writing to Codex Sol max and plan review to Opus (loop cap=4) — the same writer/reviewer pair as dev-orchestrator Steps 1–2.
- `/dev` slash command — explicit entry point for `dev-orchestrator`.

**Code review** is dispatched as an Opus subagent via `Agent(subagent_type="general-purpose", model="opus", ...)` — see `skills/requesting-code-review/`. The standalone `code-reviewer` agent type from upstream was removed; use the skill instead.

**Not included:** upstream `subagent-driven-development` (replaced by `dev-orchestrator`), `using-superpowers` (aggressive MUST-directive was not wanted), the SessionStart hook that injected `using-superpowers`.

## Install on another machine

Copy this directory to the target machine, then:

```
/plugin marketplace add ~/superpowers-strigov-ver
/plugin install superpowers-strigov-ver
/reload-plugins
```

(Adjust the path if you put it elsewhere.)

## Machine-specific assumptions

The Codex companion runtime is **vendored** under `vendor/codex-companion/` (Apache-2.0, copyright OpenAI; sourced from `github.com/openai/codex-plugin-cc`). All dispatch goes through the `bin/codex-dispatch` wrapper, which (1) resolves the script from either the marketplace install path or the local dev tree, (2) pins state to `~/.claude/plugins/data/superpowers-strigov-ver-codex`, and (3) auto-injects `--model gpt-5.6-sol` (overridable via `CODEX_DEFAULT_MODEL=...` or an explicit `--model` flag) for `task`/`review`/`adversarial-review` so the backend can't auto-downgrade to spark. You do **not** need OpenAI's `codex-plugin-cc` installed.

The only external dependency is the standalone `codex` CLI (`npm install -g @openai/codex`) and a one-time `!codex login` per machine.

To bump the vendored runtime, replace the contents of `vendor/codex-companion/{scripts,prompts,schemas}` from a newer `openai/codex-plugin-cc` release and update `vendor/codex-companion/VERSION` — then re-apply the local patches listed in that file (notably the `--resume-task` flag and the `max`/`ultra` reasoning efforts).

## Upstream attribution

Original `superpowers` plugin: <https://github.com/obra/superpowers> — MIT-licensed. This personal fork copies and adapts skills from upstream 5.0.7; cross-references have been stripped of the `superpowers:` namespace and pointers to `subagent-driven-development` have been rewritten to `dev-orchestrator`.

Thread-addressed Codex resume, the verification gate, review synthesis, `codex-ask`, and `architecture-memory` are adapted from [TRIP-workflow](https://github.com/PiLastDigit/TRIP-workflow) (PiLastDigit, MIT).
