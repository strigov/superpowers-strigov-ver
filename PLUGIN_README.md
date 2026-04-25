# superpowers-strigov-ver

Personal Claude Code plugin assembled from:
Current repo/plugin version: `0.3.0`.

- **`dev-orchestrator`** — multi-model subagent-driven workflow (Opus plan + Codex xhigh plan-review loop + Codex high implement + Opus two-stage code review, auto-commit, loop cap=4 with anti-pingpong / no-progress guards).
- **`codex-invocation`** — reference recipe for calling Codex via the `bin/codex-dispatch` wrapper around the vendored `codex-companion.mjs` (background mode + Monitor polling; bypasses the silent auto-reject on standard Agent/`codex exec` paths and pins the model to `gpt-5.5` to block backend auto-downgrade to spark).
- 12 upstream skills copied from `superpowers` (Jesse Vincent / obra), namespace-stripped: `brainstorming`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `verification-before-completion`, `writing-plans`, `writing-skills`. `brainstorming` and `writing-plans` extended to delegate spec/plan writing to Opus and spec/plan review to Codex xhigh (loop cap=4).
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

The Codex companion runtime is **vendored** under `vendor/codex-companion/` (Apache-2.0, copyright OpenAI; sourced from `github.com/openai/codex-plugin-cc`). All dispatch goes through the `bin/codex-dispatch` wrapper, which (1) resolves the script from either the marketplace install path or the local dev tree, (2) pins state to `~/.claude/plugins/data/superpowers-strigov-ver-codex`, and (3) auto-injects `--model gpt-5.5` (overridable via `CODEX_DEFAULT_MODEL=...` or an explicit `--model` flag) for `task`/`review`/`adversarial-review` so the backend can't auto-downgrade to spark. You do **not** need OpenAI's `codex-plugin-cc` installed.

The only external dependency is the standalone `codex` CLI (`npm install -g @openai/codex`) and a one-time `!codex login` per machine.

To bump the vendored runtime, replace the contents of `vendor/codex-companion/{scripts,prompts,schemas}` from a newer `openai/codex-plugin-cc` release and update `vendor/codex-companion/VERSION`.

## Upstream attribution

Original `superpowers` plugin: <https://github.com/obra/superpowers> — MIT-licensed. This personal fork copies and adapts skills from upstream 5.0.7; cross-references have been stripped of the `superpowers:` namespace and pointers to `subagent-driven-development` have been rewritten to `dev-orchestrator`.
