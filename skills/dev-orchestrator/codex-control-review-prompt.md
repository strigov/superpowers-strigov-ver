# Codex xhigh — Control Review on Diff (Step 4.2)

Use AFTER Opus review (Step 4.1) returned `REVIEW_OK`. This is a second-opinion cross-check from a different model family, tuned for "what might Opus have missed".

## Invocation

```bash
node ~/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs task \
  --background \
  --effort xhigh \
  "<prompt below>"
```

No `--write`. This is read-only review.

For round 2+ in the same Step 4 loop, add `--resume-last` and tell Codex the diff was updated (new fixes from Codex high). Do NOT re-send full prompt — `--resume-last` carries prior context.

Poll with Monitor using the terminal-only filter from `codex-invocation`. Fetch via `companion.mjs result task-XXXX`.

## First-round prompt template

```
CONTROL REVIEW on an implementation diff. Read-only, do not modify code.

An Opus reviewer already cleared this diff on spec compliance and code quality. Your job is orthogonal: find what Opus might have missed. Do not duplicate Opus's checklist — focus on the following angles.

## Phase context

- Plan file: `<repo-root>/docs/plans/<slug>.md` (read it, especially `## <id>:` section and the Contracts / Risks sections)
- Current phase id: `<id>`
- Base commit: `<base-sha>`
- Current diff: un-committed in working tree (use `git diff <base-sha>`)

## Your review angles (what Opus-flavor review often misses)

1. **Hidden edge cases** — inputs the plan did not enumerate: empty collections, max sizes, unicode, NaN/Inf, negative numbers, off-by-one, timezone boundaries, DST transitions, leap years.
2. **Concurrency / ordering** — implicit global state, shared mutable references, non-atomic read-modify-write, retry semantics, idempotency violations, observable ordering of external writes.
3. **Error paths** — what happens when the network fails mid-way, the DB times out, the filesystem is full, a dependency throws an unexpected exception type, a config value is missing or malformed.
4. **Security** — command injection, path traversal, SSRF, SQL / NoSQL injection, XXE, deserialization, auth bypass (missing permission checks), overly broad CORS / origin checks, secrets leaking to logs or error messages, log injection.
5. **Plan/code ambiguities** — places where the plan was underspecified and Codex made a choice; flag the choice for the user to notice even if it's "probably fine".
6. **Subtle regressions** — implicit contracts the diff may have broken even though tests pass: log format changes, HTTP status codes, event schema fields renamed, DB migration ordering, backward-compat of stored data, tooling / deploy scripts.
7. **Test quality** — tests that pass by construction (mock what they claim to verify), missing negative tests, missing fixture teardown, test pollution across runs.

## Output format (strict)

Line 1 must be exactly one of: `REVIEW_OK` or `REVIEW_BLOCKING`.

If `REVIEW_BLOCKING`:

```
BLOCKING:
1. <angle: e.g. "concurrency"> — <file:line> — <concrete risk> — <what to change>
2. ...

NITS:
- <nit> — informational only, do NOT trigger another round
- ...
```

BLOCKING items must cite `file:line`. Be sparing — this is a control review, not a style pass. Only raise what Opus genuinely missed AND matters. If the angle is "looks fine to me", that's `REVIEW_OK`; don't invent findings.

Do NOT write code. Do NOT modify files. Read plan + diff + any cited files only.
```

## Follow-up prompt (round 2+, with `--resume-last`)

```
The diff has been updated by Codex high based on your prior BLOCKING list. Re-read the current diff — `git diff <base-sha>` again. Same review rules, same output format.

## What the implementer did with your prior blocking list

<for each prior BLOCKING item: "Fixed in <file:line>" / "Rejected — reason">

Review again. Do not repeat items explicitly rejected with reasoning unless you have a new argument.
```
