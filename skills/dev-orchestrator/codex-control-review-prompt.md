# Codex xhigh — Control Review on Diff (Step 4.2)

Use AFTER Opus review (Step 4.1) returned `REVIEW_OK`. This is a second-opinion cross-check from a different model family, tuned for "what might Opus have missed".

## Invocation

```bash
"$DISPATCH" task \
  --background \
  --effort xhigh \
  [--cwd <worktree-path>] \
  --prompt-file <scratch>/control-review.md
```

`$DISPATCH` is the `codex-dispatch` wrapper — resolve it once per session per the `codex-invocation` skill. Write the filled prompt to a scratch file first and pass it via `--prompt-file` — do not inline multi-line text. When reviewing a parallel-track phase, add `--cwd <worktree-path>` (and use the same `--cwd` on `status`/`result`).

No `--write`. This is read-only review.

For round 2+ in the same Step 4 loop, dispatch a **FRESH task** with the follow-up template below (full context, no `--resume-last`). Do NOT use `--resume-last` here: the fixer (Codex high) ran between control-review rounds, so it would resume the fixer's thread — and a control review that continues the conversation of the code it is checking is no longer an independent second opinion (see `codex-invocation` "Resume semantics").

Poll with Monitor using the terminal-only filter from `codex-invocation`. Fetch via `"$DISPATCH" result task-XXXX`.

## First-round prompt template

```
CONTROL REVIEW on an implementation diff. Read-only, do not modify code.

An Opus reviewer already cleared this diff on spec compliance and code quality. Your job is orthogonal: find what Opus might have missed. Do not duplicate Opus's checklist — focus on the following angles.

<authorization_boundary>
This is a control review, not a scope-expansion review.
Do not require new features, flags, diagnostics, guards, dependencies, or broad edge-case support unless the finding demonstrates one of:
- likely data loss / corruption;
- security / trust-boundary failure;
- guaranteed build / test / runtime failure;
- regression of an existing public contract;
- direct failure of the phase Acceptance criteria.

If the issue is a useful hardening idea but does not clear this bar, put it in the `DEFER:` section of your output and return `REVIEW_OK` — there are no material findings.
Items the orchestrator marked `REJECTED_BY_SCOPE` in the AUTHORIZED_CHANGE_LEDGER are out of scope for this control review — do not re-flag them.
</authorization_boundary>

<finding_required_fields>
Each blocking finding MUST include:
- `authorization_relation: PLAN_ACCEPTANCE | REGRESSION_FROM_FIX | SECURITY | DATA_LOSS | GUARANTEED_FAIL`
- `why_now`: why this must block this phase rather than be deferred to a follow-up
- `minimal_fix`: smallest change that addresses only this risk
</finding_required_fields>

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

Line 1 must be exactly the bare token `REVIEW_OK` or `REVIEW_BLOCKING` — no preamble, no markdown heading, no bold.

If `REVIEW_BLOCKING`:

```
BLOCKING:
1. authorization_relation: <PLAN_ACCEPTANCE | REGRESSION_FROM_FIX | SECURITY | DATA_LOSS | GUARANTEED_FAIL>
   <angle: e.g. "concurrency"> — <file:line> — <concrete risk>
   why_now: <why this must block this phase now rather than be deferred to a follow-up>
   minimal_fix: <smallest change that addresses only this risk>
2. ...

DEFER:
- <useful hardening idea that does not clear the bar> — <file:line or scope>
- ...

NITS:
- <nit> — informational only, do NOT trigger another round
- ...
```

If `REVIEW_OK`: after line 1 emit only the `DEFER:` and `NITS:` sections (omit either if empty). Nothing else.

Each BLOCKING item MUST carry the three fields above (`authorization_relation`, `why_now`, `minimal_fix`) per `<finding_required_fields>`. Items missing any of these fields are treated as DEFER by the orchestrator and do not block the phase. BLOCKING items must cite `file:line`. Be sparing — this is a control review, not a style pass. Only raise what Opus genuinely missed AND matters. If the angle is "looks fine to me", that's `REVIEW_OK`; don't invent findings.

Do NOT write code. Do NOT modify files. Read plan + diff + any cited files only.
```

## Follow-up prompt (round 2+ — FRESH task, no `--resume-last`)

Send the FULL first-round prompt again (all sections: authorization boundary, finding required fields, phase context, review angles, output format), with these modifications:

1. Replace the opening paragraph with:

```
CONTROL REVIEW, round <k> of a fix loop. Read-only, do not modify code.

An earlier control review of this diff produced blocking findings; the implementer has since applied authorized fixes. You are a fresh session with no memory of prior rounds. Re-read the current diff — `git diff <base-sha>`.

Verify first that each open ACCEPTED item in the AUTHORIZED_CHANGE_LEDGER (`<repo-root>/docs/plans/<slug>.ledger.json`) is fixed correctly. Then check the fix delta for new problems. Do NOT block on pre-existing issues unrelated to the authorized fixes unless they clear the high-materiality bar (data loss/corruption, security/trust-boundary failure, guaranteed build/test/runtime failure, regression of an existing public contract, direct failure of the phase acceptance criteria) — latent issues outside that bar belong in DEFER/NITS.
```

2. Append this section before the output format:

```
## What the implementer did with the prior blocking list

<for each prior BLOCKING ledger item: "<ledger id>: Fixed in <file:line>" / "Rejected — reason: ...">

Do not re-raise items the orchestrator marked REJECTED_BY_SCOPE or rejected with reasoning unless you have a genuinely new argument.
```
