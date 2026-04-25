# Spec Reviewer Prompt (Codex xhigh)

Use when dispatching a design spec review to Codex xhigh after Opus writes the spec.

## Invocation

```bash
"$DISPATCH" task \
  --background \
  --effort xhigh \
  "<prompt below>"
```

`$DISPATCH` is the `codex-dispatch` wrapper — resolve it once per session per the `codex-invocation` skill.

No `--write`. Review is read-only.

For round 2+, add `--resume-last` and tell Codex the spec file was updated and must be re-read. Do NOT send the full spec text — always point to the file.

Poll with Monitor using the terminal-only filter from the `codex-invocation` skill. Fetch result via `"$DISPATCH" result task-XXXX`.

## First-round prompt template

```
REVIEW MODE — read-only, do not modify files.

You are reviewing a design spec for clarity, completeness, and consistency before implementation planning begins.

## Spec file (authoritative — read it)

Path: <absolute path to spec file>

Read the entire file.

## Context

- Repository root: [path]
- User's original request: [verbatim]
- Relevant existing files/modules the spec references: [paths if any]

## Your job

Flag issues in these categories:

- **Missing requirements**: features or behaviors the user asked for that the spec does not cover.
- **Ambiguity**: any requirement that could be interpreted two or more different ways. Each requirement must have exactly one interpretation.
- **Internal contradictions**: sections that conflict with each other (e.g., architecture section says X, feature description implies not-X).
- **Scope creep**: anything in the spec the user did not ask for. Flag speculative features, "nice to haves", or abstractions not tied to stated goals.
- **Unimplementable as written**: vague enough that an engineer cannot write a test for it.
- **Placeholders**: any "TBD", "TODO", incomplete sections, or intentionally deferred decisions that would block implementation planning.

## Output format (strict)

Line 1 must be exactly one of: `APPROVED` or `CHANGES_REQUESTED`.

**If `CHANGES_REQUESTED`**, after line 1 emit:

```
BLOCKING:
1. <issue> — <what to change>
2. ...

NITS:
- <nit> — optional, non-blocking
- ...
```

**If `APPROVED` with nits**, after line 1 emit only the NITS section (no BLOCKING):

```
NITS:
- <nit>
- ...
```

**If `APPROVED` with nothing to note**, line 1 is the entire response.

BLOCKING items MUST change. NITS are minor suggestions, never block approval.

Be ruthless on BLOCKING; be sparing — only include what truly blocks implementation planning.

Do not write code. Do not modify files. Read the spec and referenced files only.
```

## Follow-up prompt (round 2+, with `--resume-last`)

```
The spec file at <absolute path> has been revised. **Re-read it** — the edits happened since your last review. Same review rules, same output format.

## What I did with your prior blocking list

[For each prior BLOCKING item: "Fixed in section <X>" / "Rejected — reason: ..."]

Review again. Do not repeat blocking items I explicitly rejected with reasoning unless you have a new argument.
```
