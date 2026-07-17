# Claude Frontend Implementer Prompt

Use when dispatching a frontend-only phase (or a frontend-only task routed straight from triage) to a Claude subagent instead of Codex. Frontend work is routed to Claude because it responds better to design nuance and the `frontend-design` skill lives on the Claude side.

## Invocation

```
Agent tool:
  subagent_type: "general-purpose"
  model: "opus" | "sonnet"
  description: "Frontend: <phase id or short slug>"
  prompt: |
    <prompt below>
```

Model choice:
- **Opus** — new UI (new page/component, visible redesign, visual rework). The prompt **MUST** begin with the literal keyword `ultrathink` on its own first line to run Opus at max thinking effort.
- **Sonnet** — simple tweaks (CSS change, copy edit, minor markup). Omit the `ultrathink` line — Sonnet does not use it.

The subagent has NO session context. The prompt must be fully self-contained — include plan path + phase id + visual intent + any screenshot references + relevant existing files/components to follow.

Both templates take a `[REPORT_FILE]` placeholder — the implementer writes its full report there so the detail never transits your context. Resolve it once per phase as `$(sdd-workspace <plan-file>)/phase-<id>-report.md` and substitute the absolute path, exactly as for the Codex implementer (see SKILL.md Step 3). Fix rounds append to the same file — never mint a new report path for round 2+.

For follow-up rounds after the fused review (Step 4), start a **fresh** Agent call with the COMBINED BLOCKING list (the open ACCEPTED / PARTIALLY_ACCEPTED ledger items, merged from Opus review + Codex Sol xhigh control review by the orchestrator) and the same `[REPORT_FILE]`. Claude subagents do not have a `--resume-last` equivalent; every round is a fresh dispatch with full context.

## First-round prompt template

```
ultrathink

You are implementing one phase of an approved plan. This phase is frontend / UI work. Follow the plan exactly — do not expand scope beyond the named phase.

## Use the frontend-design skill

Before writing code, invoke the `frontend-design` skill (`Skill` tool, `skill: "frontend-design:frontend-design"`). Its guidance on layout, typography, color, component structure, and avoiding generic AI aesthetics applies to every visible change in this phase.

## Approved plan (authoritative — read it)

Path: `<repo-root>/docs/plans/<slug>.md`

Read the entire file including YAML frontmatter. Your task: implement phase **`<id>`** only (scope: `<one-line scope from frontmatter>`). Do not touch files or functionality belonging to other phases.

## Context

- Repository root: [path — may be a git worktree when this phase runs as a parallel track; treat it as the entire universe and never touch paths outside it]
- Framework / component library: [e.g., React 19 + Tailwind, Vue 3 + Naive UI, SvelteKit + shadcn-svelte]
- Design tokens / patterns to respect: [e.g., "spacing scale from tokens.css", "button variants in components/ui/Button.tsx"]
- Visual references (screenshots, mockups, links): [paths / URLs if any]
- Other phases already done (for context, do not modify): [list]
- If `docs/ARCHI.md` exists, read it before exploring the source — it is the maintained architecture memory. If the plan's steps for your phase include updating it, do so; otherwise do not touch it.

## Before you begin

If any of these are unclear, STOP and report status `NEEDS_CONTEXT` with a specific question:
- Visual intent (what the UI should look and feel like)
- Component boundaries, props, or data shape the component receives
- Interaction behavior (hover / focus / empty / loading / error / disabled states)

Do not guess on visuals. A wrong mockup is worse than a clarifying question.

## Your job

1. Implement exactly what the plan specifies — nothing more.
2. Cover empty / loading / error states explicitly. Do not ship a "happy path only" UI.
3. Match the existing component and design patterns in the repo (tokens, primitives, utilities).
4. Write tests where they belong for this stack (component tests, snapshot / visual if established, e2e only if the plan asks).
5. Run tests / typecheck / linters; confirm they pass.
6. Self-review (see below) and fix issues before reporting.
7. Write your full report to [REPORT_FILE], then emit the short final message (see Report format below).

## Discipline

- **YAGNI**: build only what the plan asks for. No speculative flags, extra variants, or "nice to haves".
- **Existing patterns**: reuse tokens, primitives, and utilities instead of re-creating them. Follow established conventions.
- **No unrelated commits**: do not modify files outside the plan's scope — even visual polish on neighbouring components.
- **Git**: do NOT run `git commit`, `git push`, or any history-modifying git command — leave all changes uncommitted in the working tree. The orchestrator reviews the diff and handles git itself. (If the plan's last step says "Commit the phase", skip that step and note it in your report.)
- **Accessibility**: semantic HTML, keyboard navigation, visible focus states, sensible aria labels, contrast passes AA. Not "nice to have".

## Self-review before reporting

- Completeness: every requirement implemented? empty / loading / error states covered?
- Visual fidelity: matches design intent? spacing / typography / color consistent with the rest of the app?
- Accessibility: keyboard reachable, focus visible, screen-reader labels present, contrast passes AA?
- YAGNI: built anything not requested? remove it.
- Names: accurate (match what components do, not how they look)?
- Tests: prove behavior, or just mock-match the implementation?

Fix anything you find before reporting.

## Escalate when stuck

It is OK to stop and say "this needs more direction." Bad UI is worse than no UI.

STOP and escalate (`BLOCKED`) when:
- Visual intent is underdefined and you cannot infer it from existing patterns.
- The task needs design decisions with multiple valid directions (layouts, interaction patterns, information architecture).
- The plan itself appears wrong for this UI.

## Report format (strict)

Write your full report to [REPORT_FILE]:
- What you implemented (or attempted, if blocked)
- What you tested and results (commands + output summary)
- Files changed (paths)
- Self-review findings (if any)
- Concerns / questions / blockers (if status ≠ DONE)

Then emit your final message with ONLY (under 15 lines — the detail lives in the report file). Line 1 is the bare status token — no preamble, no markdown formatting:

`DONE` | `DONE_WITH_CONCERNS` | `BLOCKED` | `NEEDS_CONTEXT`

Then:
- One-line test summary (e.g. "14/14 passing")
- Number of files changed (you do not commit — the diff stays in the working tree)
- Your concerns, if any
- The report file path

If BLOCKED or NEEDS_CONTEXT, put the specifics in the final message itself — the orchestrator acts on it directly.

Do NOT silently produce work you're unsure about — use `DONE_WITH_CONCERNS`.
```

## Follow-up prompt (round 2+, fresh Agent call)

```
ultrathink

Previous frontend implementation had blocking issues from the fused review (Opus + Codex Sol xhigh control). Fix them, re-test, re-report.

## Plan + phase

Path: `<repo-root>/docs/plans/<slug>.md`, phase `<id>`. Read the plan file for scope.

## Combined blocking list

1. <issue 1> — file:line — <reviewer: opus | codex-xhigh> — <what to change>
2. <issue 2>
...

## Rules

- Address every blocking item. If you disagree with one, explain in the report — do not silently ignore.
- Do NOT expand scope beyond fixing these items.
- Re-run tests / typecheck / linters after fixes; report results.
- Do NOT run `git commit` / `git push` — leave all changes uncommitted; the orchestrator handles git.

## Required output

First, append a section `## Fix round <N>` to [REPORT_FILE] (the same report file from the first round — do not overwrite it, do not create a new one) containing ALL THREE of:

1. The names of the tests covering each fixed item
2. The exact test command(s) you ran
3. The relevant output

All three are mandatory — a fix-round report missing any of them is returned to you before re-review; reviewers will not re-run the full suite, so your report is the test evidence. Then emit the short final message in the same format as the first round (status token on line 1, test summary, files changed count, concerns, the report file path).
```
