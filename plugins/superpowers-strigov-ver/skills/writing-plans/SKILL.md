---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

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

This skill produces plans in the TDD Task/Step format described below. For the alternative YAML-phases format used by the `dev-orchestrator` skill, see `../dev-orchestrator/opus-plan-prompt.md` — do NOT mix the two.

**Codex xhigh** reviews the plan after Opus writes it. Reuse the template at `../dev-orchestrator/plan-reviewer-prompt.md` for the invocation — the review categories (missing pieces, wrong approach, broken contracts, test gaps, risk, over-engineering) apply equally to this format. Dispatched via `companion.mjs --background` per `codex-invocation` skill. Loop cap=4.

Verdict handling (identical to dev-orchestrator Step 2):

- `APPROVED` → commit the plan file separately (`docs(plans): add <slug>`, stage only the plan file, Co-Authored-By trailer). Then proceed to Execution Handoff.
- `CHANGES_REQUESTED` → dispatch Opus again with the BLOCKING list and the plan file path, instructing it to revise in place (not rewrite). After Opus returns, re-run Codex with `--resume-last`. Increment counter.
- Round 4 without APPROVED → escalate to user: plan path + last blocking list + one-sentence disagreement summary. User picks: accept / another round / close.

Anti-pingpong: if Codex repeats a blocking point that was explicitly rejected with reasoning in a prior round, mark `resolved-by-decision`, do not loop on it. No-progress: if two consecutive rounds produce an identical blocking list, escalate immediately.

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dev-orchestrator (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**
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

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Remember
- Exact file paths always
- Complete code in every step — if a step changes code, show the code
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## Self-Review

Opus runs this self-review inline while writing the plan — include these instructions in the Opus prompt. This is a checklist Opus runs itself — not a separate subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

After Codex xhigh returns APPROVED and the plan is committed, offer execution choice:

**"Plan complete, reviewed by Codex xhigh, and saved to `docs/plans/<filename>.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?"**

**If Subagent-Driven chosen:**
- **REQUIRED SUB-SKILL:** Use dev-orchestrator
- Fresh subagent per task + two-stage review

**If Inline Execution chosen:**
- **REQUIRED SUB-SKILL:** Use executing-plans
- Batch execution with checkpoints for review
