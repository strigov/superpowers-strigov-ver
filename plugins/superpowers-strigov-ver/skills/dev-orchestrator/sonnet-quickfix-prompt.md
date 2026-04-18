# Sonnet Quickfix Prompt

Use for trivial single-file changes (<~20 lines, no architectural judgment).

## Invocation

```
Agent tool:
  subagent_type: "general-purpose"
  model: "sonnet"
  description: "<short task name>"
  prompt: |
    <prompt below>
```

## Prompt template

```
Make a small focused change.

## Task

[One-sentence description]

## File(s)

[Path(s) — usually one]

## Requirements

[Precise spec: exact rename, exact logic change, exact string. Leave no ambiguity.]

## Constraints

- Do NOT touch files outside the listed path(s).
- Do NOT add new dependencies.
- If existing tests cover this area, run them and confirm they still pass.
- If you need to clarify anything, stop and ask — do not guess.

## Report

After the edit, report:
- Diff summary (one line)
- Tests run + result (if applicable)
- Anything unexpected
```

## After the quickfix subagent reports

The orchestrator (Sonnet main) does a quick diff sanity check itself — no two-stage review, no Opus subagent, no Codex control review. Scope is too small to justify. If sane and tests are green, auto-commit (unless user opted out). If the "trivial" task turned out non-trivial (surprises in the diff, touched files outside the listed path, failing tests that need judgment), abandon the quickfix commit, inform the user, and re-run via the full protocol.
