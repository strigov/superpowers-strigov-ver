# superpowers-strigov-ver

Personal Claude Code plugin: multi-model development orchestration.

**Full documentation and workflow overview**: https://github.com/strigov/superpowers-strigov-ver

## Quick start

```
/dev <task description>
```

Sonnet orchestrates → Opus plans & reviews → Codex implements → auto-commit on clean review.

## Contents

- **`dev-orchestrator`** skill — 5-step multi-model workflow (plan → plan-review loop → implement → fused review loop → auto-commit)
- **`codex-invocation`** skill — companion.mjs invocation recipe for macOS (bypasses silent auto-reject on standard paths)
- 12 upstream skills from [superpowers](https://github.com/obra/superpowers) v5.0.7
- `code-reviewer` agent
- `/dev` slash command

## Requirements

- OpenAI Codex plugin installed and authenticated (`!codex login`)
- Codex companion at:
  ```
  ~/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs
  ```
  If your Codex version differs, update the path in `skills/codex-invocation/SKILL.md` and `skills/dev-orchestrator/*-prompt.md` (or symlink).

## Attribution

Skills from [superpowers](https://github.com/obra/superpowers) v5.0.7 — MIT-licensed.
