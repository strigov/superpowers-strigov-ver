---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch in each phase, code, testing, docs they might need to check, how to test it. Decompose into 2–5 phases of bite-sized TDD steps. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** This should be run in a dedicated worktree (created by brainstorming skill).

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
- (User preferences for plan location override this default)

## Model split

**Main thread (orchestration only):** announces, gathers context, constructs the Opus prompt from the guidance below, dispatches Opus, runs Codex review loop, commits, offers execution options. Never writes the plan directly.

**Opus subagent** writes the plan. Dispatch via:

```
Agent(subagent_type="general-purpose", model="opus", description="Plan: <slug>", prompt=...)
```

The subagent has NO session context. Construct a fully self-contained prompt that includes:

- User's original request verbatim.
- Spec file path if available (e.g. when called after brainstorming) — otherwise paste the relevant requirements directly into the prompt.
- Repo root (absolute path), language/framework, any constraints you know.
- Target plan path: `docs/plans/YYYY-MM-DD-<slug>.md` (unless user specified a custom location).
- **All the guidance in this skill below (Scope Check through Self-Review)** — these sections define HOW Opus must write the plan. Paste them into the prompt; don't just reference the file.
- Instruction to run the Self-Review inline after writing, fixing issues in place (no separate round trip).

This skill produces plans in the YAML-frontmatter + phases format consumed natively by `dev-orchestrator`. The TDD discipline (failing test → minimal impl → passing test → commit) lives **inside** each phase as the step pattern — phases are the orchestration unit, TDD steps are the work pattern. The canonical format definition lives in `../dev-orchestrator/opus-plan-prompt.md` Mode A — keep this skill's format guidance below in sync with it.

**Codex xhigh** reviews the plan after Opus writes it. Reuse the template at `../dev-orchestrator/plan-reviewer-prompt.md` for the invocation — the review categories (missing pieces, wrong approach, broken contracts, test gaps, risk, over-engineering) apply equally to this format. Dispatched via `companion.mjs --background` per `codex-invocation` skill. Loop cap=4.

Verdict handling (identical to dev-orchestrator Step 2):

- `APPROVED` → commit the plan file separately (`docs(plans): add <slug>`, stage only the plan file, Co-Authored-By trailer). Then proceed to Execution Handoff.
- `CHANGES_REQUESTED` → dispatch Opus again with the BLOCKING list and the plan file path, instructing it to revise in place (not rewrite). After Opus returns, re-run Codex with `--resume-last`. Increment counter.
- Round 4 without APPROVED → escalate to user: plan path + last blocking list + one-sentence disagreement summary. User picks: accept / another round / close.

Anti-pingpong: if Codex repeats a blocking point that was explicitly rejected with reasoning in a prior round, mark `resolved-by-decision`, do not loop on it. No-progress: if two consecutive rounds produce an identical blocking list, escalate immediately.

**New-blocker churn detector.** Escalate immediately, even before cap=4, when all prior blockers are closed (per the ledger) and the reviewer returns only NEW `MUST_FIX_NOW` items that don't cite DATA_LOSS / SECURITY / GUARANTEED_FAIL materiality. `REGRESSION_FROM_AUTHORIZED_FIX` items don't count as "new" — they are causally tied to a prior accepted fix. Canonical wording lives in `../dev-orchestrator/SKILL.md` Step 2 verdict-handling; mirror it from there rather than restating.

**Authorized Change Ledger.** For each `CHANGES_REQUESTED` round, the orchestrator constructs the same `docs/plans/<slug>.ledger.json` artifact described in `../dev-orchestrator/SKILL.md` (see "## Authorized Change Ledger" there for shape, lifecycle, and the reviewer-side materiality vocabulary — `MUST_FIX_NOW`, `REGRESSION_FROM_AUTHORIZED_FIX`, `DEFER`, `NIT`, `REJECTED_BY_SCOPE` — alongside the orchestrator-side label `AUTHORIZED_CHANGE_LEDGER`). Pass the ledger path to Opus on revision dispatch and to Codex on `--resume-last`. The ledger is transient orchestrator state, kept only for the duration of the current Step-2 review loop, and is never committed. The same vocabulary applies to plan-review rounds run from this skill.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining phases, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the phase decomposition. Each phase should produce self-contained changes that make sense (and ship) independently.

## Bite-Sized Step Granularity

**Each step inside a phase is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step (the last step of the phase commits the whole phase)

## Plan Document Header

**Every plan MUST start with YAML frontmatter followed by a markdown title:**

````markdown
---
slug: <short-kebab-slug>
created: YYYY-MM-DD
status: in-progress          # in-progress | done | abandoned
phases:
  - id: Ф1
    scope: "<one-line scope>"
    status: in-progress       # pending | in-progress | done
  - id: Ф2
    scope: "..."
    status: pending
---

# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dev-orchestrator to implement this plan phase-by-phase. Steps inside each phase use checkbox (`- [ ]`) syntax for tracking.

---
````

After the `---` separator the body begins, starting with `## Goal` and following the H2 sequence below. Do NOT add `**Goal:**` / `**Architecture:**` / `**Tech Stack:**` bold lines before the H2 sections — those are upstream mini-header conventions and would duplicate `## Goal`.

The first phase MUST start at `status: in-progress`; all others at `status: pending`. The top-level `status: in-progress` until the last phase flips to `done`. These fields are what `dev-orchestrator` reads during resume-check and auto-commit — keep them well-formed.

## Required body sections

After the YAML frontmatter and the `# [Feature Name] Implementation Plan` title, every plan MUST contain these H2 sections, in order:

1. `## Goal` — what this enables and why now. Two short paragraphs max.
1a. `## Acceptance criteria` — 3–7 externally observable criteria that define "done" for the whole plan. Reviewers may block ONLY on these criteria, stated user requirements, repo constraints, or high-materiality risks (`DATA_LOSS`, `SECURITY`, `GUARANTEED_FAIL`, `REGRESSION`, `ACCEPTANCE_CRITERIA`).
1b. `## Non-goals / deferred` — explicit exclusions. Reviewers MUST classify requests for these as `REJECTED_BY_SCOPE` or `DEFER` unless the orchestrator authorizes scope expansion.
2. `## Files` — paths to create/modify, grouped by phase. Each file: one-line responsibility (see "## File Structure" guidance above).
3. `## Contracts` — function signatures, data shapes, API surface. Exact enough that the implementer can build without guessing.
4. `## Test strategy` — what proves correctness, per phase. Test types (unit/integration/e2e), key cases, what NOT to test.
5. `## Risks / unknowns / assumptions` — named explicitly. Anything you are guessing at.
6. `## Phases` — per phase an H2 `## Ф1: <title>`, `## Ф2: <title>`, ... with the detailed TDD steps inside each (see "## Phase Structure" below).

This mirrors `dev-orchestrator/opus-plan-prompt.md` Mode A — the two files are the joint authority for the format. Keep them aligned when either changes.

Self-Review (see below) is a check Opus runs in-process while writing — it is NOT a section in the committed plan file.

## Phase Structure

### Phase decomposition rules

- Each phase must be independently commit-able and produce a working system (no "Ф1 breaks build, Ф2 fixes it").
- Each phase should be shippable in one implementer run (roughly a few files, a few hours of work).
- Prefer 2–5 phases. More than 5 is a signal to split into multiple plans.
- Put risky / blocking decisions as early as possible so later phases can assume they're settled.
- **Backend / frontend split (required for full-stack work)**: if a candidate phase would touch BOTH backend (.py, .rs, .go, .java, server-side .ts/.js, SQL, protobuf, etc.) AND frontend (.tsx, .jsx, .vue, .svelte, .css, .scss), split it into two phases — one BE, one FE — with an explicit contract between them. Reason: `dev-orchestrator` routes BE phases to Codex and FE phases to a Claude subagent; mixed phases cannot be dispatched cleanly.

### Per-phase layout

Each phase is an H2 (`## Ф1: <title>`) inside the `## Phases` section. Inside the phase, list bite-sized TDD steps as checkboxes. A phase may contain multiple `test → impl → pass` cycles before its final commit, but it must still ship in one implementer run.

````markdown
## Ф1: [Phase Name]

**Files in this phase:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit the phase**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: <phase scope summary>"
```
````

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Ф N" / "Same as earlier phase" (repeat the code — the implementer may dispatch phases out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any earlier phase

## Remember
- Exact file paths always
- Complete code in every step — if a step changes code, show the code
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## Self-Review

Opus runs this self-review inline while writing the plan — include these instructions in the Opus prompt. This is a checklist Opus runs itself — not a separate subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a phase (and a step inside it) that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later phases match what you defined in earlier phases? A function called `clearLayers()` in Ф1 but `clearFullLayers()` in Ф3 is a bug.

**4. Acceptance-criteria coverage:** does every phase produce something observable in the `## Acceptance criteria` list? Are `## Non-goals / deferred` entries explicit enough that a reviewer would classify a scope-expansion request as `REJECTED_BY_SCOPE`?

**5. Frontmatter sanity:** YAML frontmatter present and well-formed? `phases[]` ids match the `## ФN:` H2 titles in the body? First phase `status: in-progress`, all others `status: pending`, top-level `status: in-progress`?

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no phase, add the phase (and update the frontmatter `phases[]` list to match).

## Execution Handoff

After Codex xhigh returns APPROVED and the plan is committed, hand off to the implementer:

**"Plan complete, reviewed by Codex xhigh, and saved to `docs/plans/<filename>.md`. Ready to execute via `dev-orchestrator` — one phase at a time, with auto-commit per phase and fused Opus + Codex review on each diff. Start now?"**

- **REQUIRED SUB-SKILL:** Use `dev-orchestrator` (it reads the YAML frontmatter, picks up the first `status: in-progress` phase, and dispatches the implementer).

**No inline-execution fallback for phased plans.** `executing-plans` is reserved for legacy flat `Task 1..N` plans without YAML frontmatter — period. Phased plans produced by this skill MUST go through `dev-orchestrator`; there is no supported inline path, because per-phase auto-commit, route-by-phase (BE/FE), and resume-check have no equivalent in `executing-plans` and running a phased plan through it would silently drop those guarantees. If the user lacks subagent support, the answer is to upgrade the environment or write a flat plan in upstream `superpowers`, not to coerce `executing-plans` into running a phased one.
