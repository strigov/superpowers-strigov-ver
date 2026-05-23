---
name: executing-plans
description: Use ONLY for legacy upstream-style plans — plain markdown without YAML frontmatter, flat Task 1..N structure (no phases). For phased plans with YAML frontmatter (Ф1, Ф2, …), use dev-orchestrator instead — it honors phase boundaries, auto-commits per phase, and routes BE/FE phases to the right implementer.
---

# Executing Plans

## Overview

Load plan, review critically, execute all tasks, report when complete.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

**Scope (this fork):** This skill is for **legacy upstream-style plans** — plain markdown without YAML frontmatter, flat `Task 1..N` structure (no phases). Plans produced by this fork's `writing-plans` are phased (YAML frontmatter + `## Ф1`, `## Ф2`, …) and should go through `dev-orchestrator` instead — it honors phase boundaries, auto-commits per phase, and routes BE/FE phases to the right implementer.

**Note:** Tell your human partner that Superpowers works much better with access to subagents. The quality of its work will be significantly higher if run on a platform with subagent support (such as Claude Code or Codex). If subagents are available, use dev-orchestrator instead of this skill.

## The Process

### Step 1: Load and Review Plan
1. Read plan file
2. Review critically - identify any questions or concerns about the plan
3. If concerns: Raise them with your human partner before starting
4. If no concerns: Create TodoWrite and proceed

### Step 2: Execute Tasks

For each task:
1. Mark as in_progress
2. Follow each step exactly (plan has bite-sized steps)
3. Run verifications as specified
4. Mark as completed

### Step 3: Complete Development

After all tasks complete and verified:
- Announce: "I'm using the finishing-a-development-branch skill to complete this work."
- **REQUIRED SUB-SKILL:** Use finishing-a-development-branch
- Follow that skill to verify tests, present options, execute choice

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- Review plan critically first
- Follow plan steps exactly
- Don't skip verifications
- Reference skills when plan says to
- Stop when blocked, don't guess
- Never start implementation on main/master branch without explicit user consent

## Integration

**Required workflow skills:**
- **using-git-worktrees** - REQUIRED: Set up isolated workspace before starting
- **finishing-a-development-branch** - Complete development after all tasks

**Note on plan source.** In this fork `writing-plans` produces phased plans for `dev-orchestrator`, not for this skill. Plans handled here come from upstream `superpowers` (where the upstream `writing-plans` produces flat Task 1..N), from external imports, or from pre-fork files.
