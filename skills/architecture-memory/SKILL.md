---
name: architecture-memory
description: Maintain docs/ARCHI.md — a persistent, tool-agnostic architecture memory of the repository. Use when the user asks to create, update, or compact an architecture overview / ARCHI.md, or when repeated Explore passes keep re-mapping the same codebase. Covers creation, the update discipline, the token budget (~10-20k tokens), and the compaction procedure with a bundled token-count script.
---

# Architecture Memory (ARCHI.md)

`docs/ARCHI.md` is a curated, always-current snapshot of the repository's architecture — the agent's long-term memory of the codebase. Concept borrowed from [TRIP-workflow](https://github.com/PiLastDigit/TRIP-workflow) (MIT).

**Why**: without it, every session re-derives the architecture through glob/grep/read passes — slow, token-hungry, and prone to guessing ("there's probably a utils folder…"). With it, one read gives the full picture. Unlike `CLAUDE.md`, ARCHI.md is purely about architecture and tool-agnostic — any agent (Claude, Codex, other) can consume it; reference it from `CLAUDE.md` if you want it in every conversation.

It is **optional infrastructure**: nothing in this plugin requires it. But when it exists, the dev-orchestrator prompts already exploit it — the Opus plan writer and the implementers read it first, and Explore passes start from it instead of from zero.

## What goes in (and what doesn't)

Keep: **what** exists and **why** it is shaped that way. Remove: **how** (implementation specifics that belong in the code).

Recommended H2 skeleton — adapt to the project:

1. `## Overview` — what the system is, 3–5 sentences.
2. `## Stack` — languages, frameworks, key deps, versions that matter.
3. `## Module map` — directories/modules with one-line responsibilities. Summarize file groups (`src/auth/ — auth UI components (Login, Logout, Register)`), never exhaustive file listings.
4. `## Data flow / control flow` — how a request/event travels. A mermaid diagram beats prose.
5. `## Contracts` — public API surface, event/schema shapes, invariants other modules rely on.
6. `## Conventions` — error handling, logging, naming, test layout; the things reviewers enforce.
7. `## Decisions` — short ADR-style log: choice, why, date. Append-only.

Density rules (these keep the file useful):
- Tables and bullet fragments over paragraphs; `code` for every path/command/type.
- One concept explained once — cross-reference, don't repeat.
- No implementation walk-throughs: `useTranscription: orchestrates transcription fetching and state` — nothing about its useState internals.

## Token budget

Target **10–20k tokens** (roughly ≤10% of a working context). Measure with the bundled script:

```bash
bash <plugin-root>/skills/architecture-memory/count-tokens.sh docs/ARCHI.md
```

(±5% on markdown. Resolve `<plugin-root>` the same way `codex-invocation` resolves the wrapper: marketplace cache or local dev tree.)

## Creating it

Dispatch exploration, don't skim by hand: an Explore/general-purpose subagent maps the codebase (structure, stack, patterns, contracts), then a writing pass fills the skeleton above. Verify claims against source before writing — ARCHI.md that guesses is worse than no ARCHI.md, because it is trusted. Commit as `docs: add ARCHI.md architecture memory`.

## Update discipline

ARCHI.md is only valuable while it is TRUE. The maintenance loop is built into dev-orchestrator:

- The Opus plan writer must add "update `docs/ARCHI.md` section <X>" as an explicit step to any phase that changes something ARCHI.md describes.
- The implementer executes that step like any other; the diff review then covers the ARCHI.md edit too.
- Outside the orchestrator: whenever you land an architectural change (new module, moved responsibility, changed contract), update the affected section in the same commit.

If you find ARCHI.md contradicting the source, fix ARCHI.md immediately (separate `docs:` commit) — stale sections poison every downstream plan.

## Compaction

When the file exceeds ~20k tokens, compact. Confirm with the user first (show the measured count and the top bloat sources), then apply in order:

1. **Deduplicate** — merge repeated/overlapping explanations; restructure instead of "see above".
2. **Densify** — prose → tables/bullets; flows → mermaid; keep the facts, drop the narration.
3. **Collapse implementation detail** — anything explaining *how* code works gets cut to a one-line *what/why*.
4. **Summarize file listings** — directory-level lines with the member names in parentheses.
5. **Archive dead weight** — sections about removed subsystems go to `docs/ARCHI-archive.md` (never deleted silently).

After compaction: re-run the token count, spot-check 3–5 claims against the source (compaction must not change meaning), commit as `docs: compact ARCHI.md (<before> → <after> tokens)`.

## Boundaries

- dev-orchestrator main thread never reads ARCHI.md — it is architecture content, i.e. research (Rule 2). The orchestrator only passes its path to subagents.
- ARCHI.md is not a changelog, not a roadmap, not API reference docs — link to those instead of absorbing them.
