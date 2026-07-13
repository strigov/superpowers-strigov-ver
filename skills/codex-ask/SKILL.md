---
name: codex-ask
description: Grounded second opinion from Codex on any question — architecture calls, debugging hypotheses, trade-off decisions, red-teaming a conclusion. Advisory only, nothing is gated on the answer. Use when a decision is about to harden and an independent model's disagreement would be valuable, or when genuinely stuck on a bug. Codex answers read-only from inside the repo; threaded per topic for multi-round discussion via --resume-task.
---

# Codex Ask (advisory second opinion)

Free-form second opinion from Codex on **any matter** — architecture decisions, debugging hypotheses, research conclusions, trade-off calls — not just plans and diffs. Codex answers from inside the repository (read-only), so its opinion is grounded in the actual code, not in whatever excerpt happened to be quoted. Ported from [TRIP-workflow](https://github.com/PiLastDigit/TRIP-workflow)'s `codex-ask` onto the `codex-dispatch` runtime.

**Advisory, not authoritative.** Unlike the dev-orchestrator review loops, there are no verdict tokens and nothing is gated on the answer: treat the response as one input to your judgment, exactly like a colleague's opinion. **Agreement is weak evidence; disagreement is a strong signal** — when Codex disagrees with your draft position, surface its answer to the user verbatim; the disagreement itself is the valuable output.

## When to use

- Second opinion on an architecture/design decision **before it hardens** (end of a research/brainstorm session, before writing a plan).
- Root-cause help when genuinely stuck on a bug — different model family, different blind spots.
- "Red-team this conclusion" on a memo or recommendation you are about to present.

## When NOT to use

- Questions that need the **user's** preference or judgment — ask the user, not Codex.
- Trivial lookups or anything settled by reading the code yourself — every ask costs a Codex run.
- As a gate: never block or approve work based on the answer. That is what dev-orchestrator's review loops with verdict tokens are for.
- From the dev-orchestrator main thread while its protocol is active — the orchestrator's channels are fixed (Opus judgment, Explore research); an unscheduled Codex opinion is protocol drift.

## Invocation

Codex is invoked via `codex-dispatch` — read the `codex-invocation` skill first (wrapper resolution, `--background`, Monitor polling, result fetch).

### Topic state

One discussion = one topic = one Codex thread. Persist the mapping in the repo's git dir so follow-ups survive session restarts without polluting the working tree:

```bash
ASK_DIR="$(git rev-parse --git-dir)/codex-ask"
mkdir -p "$ASK_DIR"
# after dispatch: echo task-XXXX > "$ASK_DIR/<topic-label>.task"
```

`<topic-label>` is short kebab-case (`orchestrator-choice`, `flaky-auth-test`). Any task id of the thread resolves to the same thread, so the file may keep the first round's id — but overwrite it with the latest anyway for tidiness.

### Start a discussion

```bash
"$DISPATCH" task --background --effort xhigh --prompt-file <scratch>/ask-<topic>.md
```

No `--write` — ever. Prompt template:

```
ADVISORY CONSULTATION — read-only. Do not modify any files. You are being asked for a grounded second opinion, not a review verdict and not an implementation.

## Question

<the question — one paragraph, specific>

## My draft position (red-team this)

<your current recommendation / hypothesis and the reasoning; omit the section header only if you genuinely have no position yet>

## Context

- Repository root: <path>
- Relevant files / evidence so far: <paths, error messages, measurements>

## What I want back

1. Your independent answer, grounded in the actual code you inspected (cite file:line for every claim about the repo).
2. Where you AGREE with my position — one line each, no elaboration.
3. Where you DISAGREE or see a risk I missed — elaborate ONLY here.
4. What evidence would settle each disagreement.

Be direct. "Your position holds, no material objections" is a complete, valid answer.
```

### Follow up (same topic)

```bash
"$DISPATCH" task --background --effort xhigh \
  --resume-task "$(cat "$ASK_DIR/<topic-label>.task")" \
  --prompt-file <scratch>/ask-<topic>-followup.md
```

The follow-up prompt is free-form: counterpoints, new evidence, "does X change your answer?". Update the `.task` file with the new task id.

### Show / reset

- Last answer without a new run: `"$DISPATCH" result "$(cat "$ASK_DIR/<topic-label>.task")"`
- Drop a topic: `rm "$ASK_DIR/<topic-label>.task"` — next ask starts a fresh thread.

## Discipline

- Include your draft position whenever you have one and explicitly ask for disagreement — a consultation without a position to attack degenerates into a generic essay.
- Poll via Monitor with the terminal-only filter from `codex-invocation`; never foreground-block.
- Default model/effort come from the wrapper (`CODEX_DEFAULT_MODEL`, `--effort xhigh`); drop to `--effort high` for quick sanity checks where latency matters more than depth.
- Relay disagreements to the user verbatim, attributed to Codex. Do not silently fold them into your own voice — the user needs to know two models split.
