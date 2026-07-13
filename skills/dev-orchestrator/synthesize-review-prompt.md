# Review Synthesis Prompt (Sonnet subagent, Step 4.5)

Use after a fused review converged in 2+ rounds (or the user accepted at an escalation). Produces the consolidated, human-readable review record — the per-round verdicts were deltas and the ledger is transient.

## Invocation

```
Agent tool:
  subagent_type: "general-purpose"
  model: "sonnet"
  description: "Synthesize review <phase-id>"
  prompt: |
    <prompt below>
```

## Prompt template

```
You are the review-synthesis stage of dev-orchestrator. Consolidate a multi-round review into one archival document. This is mechanical consolidation of the inputs below — do NOT re-review the code, do NOT add new findings.

## Inputs

- Repository root: `<absolute path>`
- Plan file: `<absolute path>/docs/plans/<slug>.md`
- Phase id: `<id>` (scope: `<one-line scope>`)
- Base commit: `<base-sha>`
- AUTHORIZED_CHANGE_LEDGER: `<absolute path>/docs/plans/<slug>.ledger.json` — read it; it holds every triaged finding of every round with reviewer, decision, and final status. Include only entries whose ids belong to this phase's Step 4 rounds (the orchestrator will tell you the round-id range if Step 2 entries share the file).
- Rounds taken: <k>
- Final round verdicts (paste verbatim, including DEFER / NITS sections):
  <4.1 Opus output>
  <4.2 Codex control output>
- Outcome: <both-clean | accepted-at-escalation>

## Output file

Write `docs/reviews/<slug>-<phase-id>.md` (create `docs/reviews/` if missing) with exactly these sections:

# Review: <slug> — <phase-id>

- **Date**: <YYYY-MM-DD>
- **Phase scope**: <one-line>
- **Base commit**: <base-sha>
- **Rounds**: <k> (Opus 4.1 + Codex xhigh 4.2 control)
- **Outcome**: <CLEAN | ACCEPTED AT ESCALATION>

## Findings history

One row per ledger item: | id | reviewer | finding (one line) | decision | final status |

## Deferred

DEFER items from the final verdicts and ledger — these are the acknowledged follow-up candidates.

## Nits (informational)

## Open at accept

Only when outcome is accepted-at-escalation: the blocking items the user chose to accept, verbatim.

## Report

Line 1: `SYNTHESIS_DONE docs/reviews/<slug>-<phase-id>.md`
Then one sentence per section you filled or omitted. Touch NOTHING else in the repository.
```
