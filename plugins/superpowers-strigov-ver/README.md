# superpowers-strigov-ver

Personal Claude Code plugin assembled from:
- **`dev-orchestrator`** — multi-model subagent-driven workflow (Opus plan + Codex xhigh plan-review loop + Codex high implement + Opus two-stage code review, auto-commit, loop cap=4 with anti-pingpong / no-progress guards).
- **`codex-invocation`** — reference recipe for calling Codex via `companion.mjs --background` + Monitor polling on macOS (bypasses the silent auto-reject on standard Agent/`codex exec` paths).
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

The `codex-invocation` skill hardcodes:

```
~/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs
```

If the Codex plugin version differs on the target machine, update the path in `skills/codex-invocation/SKILL.md` (and the duplicates inside `skills/dev-orchestrator/*-prompt.md`) — or symlink the expected path.

`!codex login` must be run once on the target machine before any Codex task can dispatch.

## Upstream attribution

Original `superpowers` plugin: <https://github.com/obra/superpowers> — MIT-licensed. This personal fork copies and adapts skills from upstream 5.0.7; cross-references have been stripped of the `superpowers:` namespace and pointers to `subagent-driven-development` have been rewritten to `dev-orchestrator`.
