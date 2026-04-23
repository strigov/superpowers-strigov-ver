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

For follow-up rounds after the fused review (Step 4), start a **fresh** Agent call with the COMBINED BLOCKING list (from Opus review + Codex xhigh control review, merged by the orchestrator). Claude subagents do not have a `--resume-last` equivalent; every round is a fresh dispatch with full context.

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

- Repository root: [path]
- Framework / component library: [e.g., React 19 + Tailwind, Vue 3 + Naive UI, SvelteKit + shadcn-svelte]
- Design tokens / patterns to respect: [e.g., "spacing scale from tokens.css", "button variants in components/ui/Button.tsx"]
- Visual references (screenshots, mockups, links): [paths / URLs if any]
- Other phases already done (for context, do not modify): [list]

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

## Discipline

- **YAGNI**: build only what the plan asks for. No speculative flags, extra variants, or "nice to haves".
- **Existing patterns**: reuse tokens, primitives, and utilities instead of re-creating them. Follow established conventions.
- **No unrelated commits**: do not modify files outside the plan's scope — even visual polish on neighbouring components.
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

Emit one report at the end. First line is status:

`DONE` | `DONE_WITH_CONCERNS` | `BLOCKED` | `NEEDS_CONTEXT`

Then:
- What you implemented (or attempted, if blocked)
- What you tested and results (commands + output summary)
- Files changed (paths)
- Self-review findings (if any)
- Concerns / questions / blockers (if status ≠ DONE)

Do NOT silently produce work you're unsure about — use `DONE_WITH_CONCERNS`.
```

## Follow-up prompt (round 2+, fresh Agent call)

```
ultrathink

Previous frontend implementation had blocking issues from the fused review (Opus + Codex xhigh control). Fix them, re-test, re-report.

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
- Same report format as before.
```
