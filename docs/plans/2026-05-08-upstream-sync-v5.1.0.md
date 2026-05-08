---
slug: upstream-sync-v5.1.0
created: 2026-05-08
status: in-progress
phases:
  - id: Ф1
    scope: "Rewrite using-git-worktrees skill with environment detection, submodule guard, native-tool preference, and explicit user consent"
    status: in-progress
  - id: Ф2
    scope: "Rewrite finishing-a-development-branch with env detection, detached-HEAD menu, provenance-based cleanup, and merge-then-remove ordering"
    status: pending
---

## Goal

Sync the fork `superpowers-strigov-ver` with the architectural improvements landed in upstream `obra/superpowers` v5.1.0 (released 2026-04-30) that are genuinely useful for this fork. Two skills get full content rewrites: `using-git-worktrees` and `finishing-a-development-branch`. Both adopt the environment-detection model (`GIT_DIR != GIT_COMMON`) so the skill no longer creates a nested worktree when an agent is already running inside one, prefers the harness's native worktree tools (e.g. `EnterWorktree`) over `git worktree add`, and only cleans up worktrees that superpowers itself created.

Changes intentionally NOT ported and the reasons are listed in "Risks / unknowns / assumptions" below.

## Files

### Phase Ф1
- `skills/using-git-worktrees/SKILL.md` — full rewrite (replaces 219 lines with ~216 lines, see Contracts/Ф1). Removes "Integration" section referencing `subagent-driven-development` (intentionally excluded from this fork) and `using-superpowers` (also intentionally excluded). Adds Step 0 (environment detection), submodule guard, Step 1a (native-tool preference), Step 1b (git fallback), explicit consent prompt, sandbox fallback note.

### Phase Ф2
- `skills/finishing-a-development-branch/SKILL.md` — full rewrite (replaces 236 lines with ~252 lines, see Contracts/Ф2). Adds Step 2 (environment detection), detached-HEAD-aware menu (named-branch creation step + 3 applicable options), Step 6 (provenance-based cleanup gated on `.worktrees/`, `worktrees/`, or `~/.config/superpowers/worktrees/`), CWD safety (`cd` to main repo root before `git worktree remove`), `git worktree prune` self-healing, merge-then-remove ordering. **Retains the fork-specific `COMMIT_COUNT > 5` Opus PR-body subagent dispatch in Option 2** — this is a hard requirement of this fork; upstream removed it but this fork keeps it. Do not drop or make this block optional.

## Contracts

### Ф1 — `skills/using-git-worktrees/SKILL.md` (full new content)

Replace the entire file with this content verbatim:

```markdown
---
name: using-git-worktrees
description: Use when starting feature work that needs isolation from current workspace or before executing implementation plans - ensures an isolated workspace exists via native tools or git worktree fallback
---

# Using Git Worktrees

## Overview

Ensure work happens in an isolated workspace. Prefer your platform's native worktree tools. Fall back to manual git worktrees only when no native tool is available.

**Core principle:** Detect existing isolation first. Then use native tools. Then fall back to git. Never fight the harness.

**Announce at start:** "I'm using the using-git-worktrees skill to set up an isolated workspace."

## Step 0: Detect Existing Isolation

**Before creating anything, check if you are already in an isolated workspace.**

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
```

**Submodule guard:** `GIT_DIR != GIT_COMMON` is also true inside git submodules. Before concluding "already in a worktree," verify you are not in a submodule:

```bash
# If this returns a path, you're in a submodule, not a worktree — treat as normal repo
git rev-parse --show-superproject-working-tree 2>/dev/null
```

**If `GIT_DIR != GIT_COMMON` (and not a submodule):** You are already in a linked worktree. Skip to Step 3 (Project Setup). Do NOT create another worktree.

Report with branch state:
- On a branch: "Already in isolated workspace at `<path>` on branch `<name>`."
- Detached HEAD: "Already in isolated workspace at `<path>` (detached HEAD, externally managed). Branch creation needed at finish time."

**If `GIT_DIR == GIT_COMMON` (or in a submodule):** You are in a normal repo checkout.

**Automation bypass (MUST):** If the environment variable `SUPERPOWERS_ORCHESTRATOR=1` is set, OR if the invoking instructions already provide an explicit worktree path / directory preference, treat consent as already granted and do NOT prompt. Orchestrated invocations (e.g. `dev-orchestrator`) must never hang on an interactive prompt.

Otherwise, has the user already indicated their worktree preference in your instructions? If not, ask for consent before creating a worktree:

> "Would you like me to set up an isolated worktree? It protects your current branch from changes."

Honor any existing declared preference without asking. If the user declines consent, work in place and skip to Step 3.

## Step 1: Create Isolated Workspace

**You have two mechanisms. Try them in this order.**

### 1a. Native Worktree Tools (preferred)

The user has asked for an isolated workspace (Step 0 consent). Do you already have a way to create a worktree? It might be a tool with a name like `EnterWorktree`, `WorktreeCreate`, a `/worktree` command, or a `--worktree` flag. If you do, use it and skip to Step 3.

Native tools handle directory placement, branch creation, and cleanup automatically. Using `git worktree add` when you have a native tool creates phantom state your harness can't see or manage.

Only proceed to Step 1b if you have no native worktree tool available.

### 1b. Git Worktree Fallback

**Only use this if Step 1a does not apply** — you have no native worktree tool available. Create a worktree manually using git.

#### Directory Selection

**Two distinct input shapes** — keep them separate:

- **`WORKTREE_PARENT_DIR`** — a directory under which the skill creates `$BRANCH_NAME/` as a subdirectory. Final worktree path becomes `WORKTREE_PARENT_DIR/$BRANCH_NAME`.
- **`WORKTREE_PATH`** — an explicit, fully-qualified path to use as the worktree itself (no subdirectory appended). Used when caller wants exact placement.

Inputs from sources 1–3 below MAY supply either shape; sources 4–6 always resolve to a `WORKTREE_PARENT_DIR`. Callers SHOULD declare which they're passing; if ambiguous, treat trailing `/$BRANCH_NAME` (or any path component matching the planned branch name) as `WORKTREE_PATH`, otherwise as `WORKTREE_PARENT_DIR`.

**Canonical priority order (MUST be applied in this exact sequence — explicit user preference always beats observed filesystem state):**

1. **Explicit argument passed in this invocation** (caller supplied `$WORKTREE_PATH` or `$WORKTREE_PARENT_DIR`). Use it.
2. **Environment variable** (`SUPERPOWERS_WORKTREE_DIR` — interpreted as `WORKTREE_PARENT_DIR` unless the value already ends with `/$BRANCH_NAME`). Use it.
3. **Instruction file / prompt declares a worktree directory preference.** Use it without asking. Same parent-vs-explicit disambiguation as above.
4. **Existing project-local worktree parent directory:**
   ```bash
   ls -d .worktrees 2>/dev/null     # Preferred (hidden)
   ls -d worktrees 2>/dev/null      # Alternative
   ```
   If found, use as `WORKTREE_PARENT_DIR`. If both exist, `.worktrees` wins.
5. **Existing global parent directory** (backward compatibility with legacy global path):
   ```bash
   project=$(basename "$(git rev-parse --show-toplevel)")
   ls -d ~/.config/superpowers/worktrees/$project 2>/dev/null
   ```
   If found, use as `WORKTREE_PARENT_DIR`.
6. **Default**: `WORKTREE_PARENT_DIR=.worktrees/` at the project root.

After resolution, derive both variables:

```bash
# If the input was a parent directory:
WORKTREE_PATH="$WORKTREE_PARENT_DIR/$BRANCH_NAME"

# If the input was an explicit full path, $WORKTREE_PATH is set directly and:
WORKTREE_PARENT_DIR=$(dirname "$WORKTREE_PATH")
```

#### Safety Verification (project-local directories only)

**MUST verify the project-local `WORKTREE_PARENT_DIR` is gitignored before creating the worktree.** The check runs on the parent directory, not on `WORKTREE_PATH` (the per-branch subdirectory inside it). Ignoring the parent ignores all children, which is what we want.

```bash
# Run the ignore check on the PARENT, not the final worktree path.
git check-ignore -q "$WORKTREE_PARENT_DIR" 2>/dev/null
```

**If NOT ignored:** Add `$WORKTREE_PARENT_DIR/` (with trailing slash) to `.gitignore`, commit the change, then proceed.

**Why critical:** Prevents accidentally committing worktree contents to repository.

Global directories (paths under `~/.config/superpowers/worktrees/`) and absolute paths outside the repo need no verification — skip this check when `$WORKTREE_PARENT_DIR` is not inside the working tree.

#### Create the Worktree

```bash
# $WORKTREE_PATH was resolved above (either explicitly supplied or
# derived as $WORKTREE_PARENT_DIR/$BRANCH_NAME). Use it directly.
git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME"
cd "$WORKTREE_PATH"
```

**Sandbox fallback:** If `git worktree add` fails with a permission error (sandbox denial), tell the user the sandbox blocked worktree creation and you're working in the current directory instead. Then run setup and baseline tests in place.

## Step 3: Project Setup

Auto-detect and run appropriate setup:

```bash
# Node.js
if [ -f package.json ]; then npm install; fi

# Rust
if [ -f Cargo.toml ]; then cargo build; fi

# Python
if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
if [ -f pyproject.toml ]; then poetry install; fi

# Go
if [ -f go.mod ]; then go mod download; fi
```

## Step 4: Verify Clean Baseline

Run tests to ensure workspace starts clean:

```bash
# Use project-appropriate command
npm test / cargo test / pytest / go test ./...
```

**If tests fail:** Report failures, ask whether to proceed or investigate.

**If tests pass:** Report ready.

### Report

```
Worktree ready at <full-path>
Tests passing (<N> tests, 0 failures)
Ready to implement <feature-name>
```

## Quick Reference

| Situation | Action |
|-----------|--------|
| Already in linked worktree | Skip creation (Step 0) |
| In a submodule | Treat as normal repo (Step 0 guard) |
| Native worktree tool available | Use it (Step 1a) |
| No native tool | Git worktree fallback (Step 1b) |
| Explicit arg / env var / instruction file specifies dir | Use it (highest priority) |
| `.worktrees/` exists (and no higher-priority preference) | Use it (verify ignored) |
| `worktrees/` exists (and no higher-priority preference) | Use it (verify ignored) |
| Both `.worktrees/` and `worktrees/` exist | Use `.worktrees/` |
| Global path exists (and no project-local) | Use it (backward compat) |
| Nothing else applies | Default `.worktrees/` |
| Chosen project-local `$WORKTREE_PARENT_DIR` not ignored | Add `$WORKTREE_PARENT_DIR/` to .gitignore + commit |
| Permission error on create | Sandbox fallback, work in place |
| Tests fail during baseline | Report failures + ask |
| No package.json/Cargo.toml | Skip dependency install |

## Common Mistakes

### Fighting the harness

- **Problem:** Using `git worktree add` when the platform already provides isolation
- **Fix:** Step 0 detects existing isolation. Step 1a defers to native tools.

### Skipping detection

- **Problem:** Creating a nested worktree inside an existing one
- **Fix:** Always run Step 0 before creating anything

### Skipping ignore verification

- **Problem:** Worktree contents get tracked, pollute git status
- **Fix:** Always use `git check-ignore` before creating project-local worktree

### Assuming directory location

- **Problem:** Creates inconsistency, violates project conventions
- **Fix:** Follow the canonical priority: explicit arg > env var > instruction file > existing project-local > existing global legacy > default `.worktrees/`

### Proceeding with failing tests

- **Problem:** Can't distinguish new bugs from pre-existing issues
- **Fix:** Report failures, get explicit permission to proceed

## Red Flags

**Never:**
- Create a worktree when Step 0 detects existing isolation
- Use `git worktree add` when you have a native worktree tool (e.g., `EnterWorktree`). This is the #1 mistake — if you have it, use it.
- Skip Step 1a by jumping straight to Step 1b's git commands
- Create worktree without verifying it's ignored (project-local)
- Skip baseline test verification
- Proceed with failing tests without asking

**Always:**
- Run Step 0 detection first
- Prefer native tools over git fallback
- Follow directory priority: explicit arg > env var > instruction file > existing project-local > existing global legacy > default `.worktrees/`
- Verify directory is ignored for project-local
- Auto-detect and run project setup
- Verify clean test baseline
```

**Notes for the implementer:**
- This content is ported and adapted from upstream v5.1.0's `skills/using-git-worktrees/SKILL.md` with fork-specific additions (the `SUPERPOWERS_ORCHESTRATOR=1` automation bypass and the canonical 6-tier directory priority order are fork-specific extensions, not verbatim upstream). The upstream file does not contain an `## Integration` section pointing at `subagent-driven-development` / `using-superpowers`, which is correct for this fork (those skills are intentionally excluded).
- Numbering jumps from Step 1 → Step 3 in upstream. Preserve that — do not renumber.
- Do not add fork-specific cross-references to `dev-orchestrator` here; this skill is harness-agnostic by design.

### Ф2 — `skills/finishing-a-development-branch/SKILL.md` (full new content)

Replace the entire file with this content verbatim:

```markdown
---
name: finishing-a-development-branch
description: Use when implementation is complete, all tests pass, and you need to decide how to integrate the work - guides completion of development work by presenting structured options for merge, PR, or cleanup
---

# Finishing a Development Branch

## Overview

Guide completion of development work by presenting clear options and handling chosen workflow.

**Core principle:** Verify tests → Detect environment → Present options → Execute choice → Clean up.

**Announce at start:** "I'm using the finishing-a-development-branch skill to complete this work."

## The Process

### Step 1: Verify Tests

**Before presenting options, verify tests pass:**

```bash
# Run project's test suite
npm test / cargo test / pytest / go test ./...
```

**If tests fail:**
```
Tests failing (<N> failures). Must fix before completing:

[Show failures]

Cannot proceed with merge/PR until tests pass.
```

Stop. Don't proceed to Step 2.

**If tests pass:** Continue to Step 2.

### Step 2: Detect Environment

**Determine workspace state before presenting options:**

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
```

This determines which menu to show and how cleanup works:

| State | Menu | Cleanup |
|-------|------|---------|
| `GIT_DIR == GIT_COMMON` (normal repo) | Standard 4 options | No worktree to clean up |
| `GIT_DIR != GIT_COMMON`, named branch | Standard 4 options | Provenance-based (see Step 6) |
| `GIT_DIR != GIT_COMMON`, detached HEAD, provenance-owned | Reduced 3 options (no merge) | Inline `git worktree remove --force` (Option 4a provenance subcase) |
| `GIT_DIR != GIT_COMMON`, detached HEAD, harness-owned | Reduced 3 options (no merge) | Native exit tool only; if unavailable/fails, report failure + manual command (Option 4a harness subcase) |

### Step 3: Determine Base Branch

```bash
# Try common base branches
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null
```

Or ask: "This branch split from main - is that correct?"

### Step 4: Present Options

**Normal repo and named-branch worktree — present exactly these 4 options:**

```
Implementation complete. What would you like to do?

1. Merge back to <base-branch> locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)
4. Discard this work

Which option?
```

**Detached HEAD — present exactly these 3 options (no local merge; merge requires a named branch and detached HEAD has none yet):**

```
Implementation complete. You're on a detached HEAD.

1. Push as new branch and create a Pull Request
2. Keep as-is (I'll handle it later)
3. Discard this work

Which option?
```

The menu wording is provenance-neutral: workspace ownership (provenance-owned vs harness-owned) is determined later in Step 5 / Option 4a from `$FEATURE_WORKTREE_PATH` and dictates how discard executes, not which options are offered.

**Don't add explanation** - keep options concise.

**Detached-HEAD branch naming (required before Option 1):** When the user picks Option 1 in detached-HEAD mode, you MUST first create or select a named branch pointing at the current commit before any push / PR work. There is no local-merge path in detached HEAD.

```bash
# Ask for a branch name if the user has not supplied one in their instructions
# (suggest a default like feat/<short-description>).
git checkout -b "$NEW_BRANCH"
```

After the branch exists, proceed with the named-branch Step 5 logic for "Option 2: Push and Create PR" using `$NEW_BRANCH` as `<feature-branch>`.

### Step 5: Execute Choice

**Mapping for detached-HEAD mode (3-option menu):**

| Detached-HEAD option | Executes |
|---|---|
| 1. Push as new branch and create a PR | Create named branch first (see "Detached-HEAD branch naming" above), then run Option 2 below with `$NEW_BRANCH`. **Skip Option 1 (Merge Locally) entirely** — it does not apply. |
| 2. Keep as-is | Run Option 3 below. |
| 3. Discard this work | Run Option 4 case **4a** below. Branches by provenance: **(provenance-owned)** `cd "$MAIN_ROOT"` → `git worktree remove --force "$FEATURE_WORKTREE_PATH"` → report "Discarded (dangling commits pending GC)"; no checkout. **(harness-owned)** attempt native exit tool — if it succeeds, report "Discarded via harness"; if unavailable/fails, report failure + manual command. **Truthfully report** state in either case; do NOT claim the work was deleted unless the corresponding action actually succeeded. |

**Mapping for normal repo / named-branch worktree (4-option menu):** options 1–4 below correspond directly.

#### Option 1: Merge Locally

Option 1 requires a named feature branch. If you reach this from detached-HEAD mode, you have already created `$NEW_BRANCH` per the "Detached-HEAD branch naming" subsection above and `FEATURE_BRANCH` is non-empty.

```bash
# Capture feature-side state BEFORE any cd / checkout (required by Step 6).
# All four values MUST be captured here — Step 6 reuses them and does NOT
# recompute, because after `cd "$MAIN_ROOT"` git rev-parse returns the
# main repo, not the feature worktree.
FEATURE_WORKTREE_PATH=$(git rev-parse --show-toplevel)
FEATURE_BRANCH=$(git branch --show-current)
FEATURE_GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
FEATURE_GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)

cd "$MAIN_ROOT"

# Merge first — verify success before removing anything
git checkout <base-branch>
git pull
git merge "$FEATURE_BRANCH"

# Verify tests on merged result
<test command>

# Only after merge succeeds: cleanup worktree (Step 6 — uses
# the FEATURE_* values captured above), then delete branch
# (conditionally, see below).
```

Then: Cleanup worktree (Step 6), then delete branch — but **only after** the worktree has been removed (or, for harness-owned workspaces, only after native exit succeeds). If neither condition holds (the workspace is still in place and still has the branch checked out), `git branch -d` will fail; in that case skip branch deletion and report the situation.

```bash
# Run only after Step 6 has actually removed the worktree (provenance-owned
# path) OR after the harness's native exit tool has detached the workspace.
git branch -d "$FEATURE_BRANCH"
```

**Normal-repo path (no worktree, `FEATURE_GIT_DIR == FEATURE_GIT_COMMON`).** Step 6 reports "no worktree to clean up" and exits. The branch is currently NOT checked out (we already ran `git checkout <base-branch>` above), so the merge target is the current HEAD and `git branch -d "$FEATURE_BRANCH"` is safe to run unconditionally after the merged tests pass:

```bash
# Normal-repo only: branch is no longer checked out (we are on <base-branch>).
git branch -d "$FEATURE_BRANCH"
```

#### Option 2: Push and Create PR

**Decide how to generate the PR body first:**

```bash
COMMIT_COUNT=$(git log --oneline <base-branch>..HEAD | wc -l | tr -d ' ')
```

**If `COMMIT_COUNT ≤ 5`** (small PR) — write the body yourself from the commit list using this template:

```
## Summary
<2-3 bullets of what changed>

## Test Plan
- [ ] <verification steps>
```

**If `COMMIT_COUNT > 5`** (large PR) — delegate body-writing to an Opus subagent. Summarizing many commits into a coherent narrative is judgment work.

```
Agent(
  subagent_type="general-purpose",
  model="opus",
  description="PR body: <branch name>",
  prompt=<see below>
)
```

Include in the prompt:
- Branch name, base branch, commit count.
- `git log --oneline <base>..HEAD` output (verbatim).
- `git diff --stat <base>..HEAD` output (verbatim).
- Original feature goal (one sentence).
- Plan file path (if one exists).
- Template to fill: `## Summary` (3-5 bullets grouped by theme, not per-commit) + `## Test Plan` (checklist of what a reviewer should verify, not just "run tests").

Opus returns the filled body. Main thread does the push + `gh pr create`.

**Then push and create the PR:**

```bash
# Push branch
git push -u origin <feature-branch>

# Create PR — paste the body produced above
gh pr create --title "<title>" --body "$(cat <<'EOF'
<body here>
EOF
)"
```

**Do NOT clean up worktree** — user needs it alive to iterate on PR feedback.

#### Option 3: Keep As-Is

Report: "Keeping branch <name>. Worktree preserved at <path>."

**Don't cleanup worktree.**

#### Option 4: Discard

**Capture FEATURE_* state BEFORE the confirmation prompt.** The state-specific confirmation wording below references `FEATURE_BRANCH`, `FEATURE_GIT_DIR == FEATURE_GIT_COMMON`, and the provenance of `FEATURE_WORKTREE_PATH`, so all five values MUST be captured first — while the shell is still inside the feature workspace. Step 6 reuses these values and does NOT recompute them.

```bash
# Capture feature-side state BEFORE confirmation and BEFORE any cd / checkout.
FEATURE_WORKTREE_PATH=$(git rev-parse --show-toplevel)
FEATURE_BRANCH=$(git branch --show-current)         # may be "" in detached HEAD
FEATURE_GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
FEATURE_GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
```

**Now confirm — wording is state-specific. Do NOT promise to delete things the skill cannot actually delete in this state.**

- **Normal repo (`FEATURE_GIT_DIR == FEATURE_GIT_COMMON`):**
  ```
  This will permanently delete:
  - Branch <name>
  - All commits on it: <commit-list>

  Type 'discard' to confirm.
  ```

- **Provenance-owned worktree (under `.worktrees/`, `worktrees/`, or `~/.config/superpowers/worktrees/`):**
  ```
  This will permanently delete:
  - Branch <name>
  - All commits: <commit-list>
  - Worktree at <path>

  Type 'discard' to confirm.
  ```

- **Harness-owned worktree (named branch, but workspace not under a provenance path):** the skill cannot remove the workspace itself — that is the harness's job (e.g. `ExitWorktree`). Tell the truth:
  ```
  This workspace is managed by the harness, so I cannot remove it directly.
  If you confirm, I will:
  - Delegate workspace removal to the harness's native exit tool
    (e.g. ExitWorktree) — no manual checkout performed inside this workspace
  - Let that native tool perform branch deletion as part of its cleanup

  Type 'discard' to confirm.
  ```

- **Detached HEAD, provenance-owned workspace** (`$FEATURE_WORKTREE_PATH` under `.worktrees/`, `worktrees/`, or `~/.config/superpowers/worktrees/`): no named branch exists, so there is nothing to delete; superpowers owns the worktree, so we remove it inline. Tell the truth:
  ```
  Discard detached-HEAD workspace? This will:
  1. cd to main repo root ($MAIN_ROOT)
  2. git worktree remove --force <FEATURE_WORKTREE_PATH> — removes the worktree directory
  3. Report 'Discarded (dangling commits pending GC)'
  Note: no branch checkout is performed. Dangling commits remain until `git gc`.

  Type 'discard' to confirm.
  ```

- **Detached HEAD, harness-owned workspace** (no named branch, workspace not under a provenance path): the skill must not manually remove a harness-owned workspace; it can only delegate to the harness's native exit tool, which may be unavailable. Tell the truth — including the failure path:
  ```
  Discard detached-HEAD workspace? This will:
  1. Attempt native harness exit/abandon tool (e.g. ExitWorktree) on <FEATURE_WORKTREE_PATH>
  2. If successful: report 'Discarded via harness (dangling commits pending GC)'
  3. If native exit unavailable or fails: report failure with manual command
     (cd "$MAIN_ROOT" && git worktree remove --force "$FEATURE_WORKTREE_PATH")
  Note: no branch checkout is performed. Dangling commits remain until `git gc`.

  Type 'discard' to confirm.
  ```

Wait for exact confirmation.

If confirmed, branch on the four sub-cases below. **Each subcase follows its own documented ordering using the pre-captured `FEATURE_*` values** — no further state probing inside the feature workspace is required, because everything Step 6 needs was captured before the confirmation prompt. Specifically: 4a and 4b `cd "$MAIN_ROOT"` first (CWD safety: `git worktree remove` cannot run from inside the worktree being removed); 4c delegates entirely to the harness's native exit tool and performs no `cd` of its own; 4d stays in the normal repo context (there is no separate worktree to leave). Branch deletion MUST be conditional; running `git branch -D` while the branch is still checked out in a still-present worktree will fail.

**4a. Detached-HEAD discard (`FEATURE_BRANCH` is empty).** No branch was ever created, so there is nothing to delete. Do NOT attempt to `git checkout <base-branch>` inside the linked worktree — git refuses to check out a branch that is already checked out in the main worktree, so the checkout would fail and `|| true` would mask the failure into a false "switched off detached HEAD" report. Instead, abandon the detached state by leaving the workspace context entirely; the dangling commits become unreachable as soon as no worktree HEAD pins them:

```bash
# Step out of the feature workspace context. Do NOT attempt a checkout
# inside the linked worktree — it will fail if <base-branch> is checked
# out in the main repo, and there is no value in trying.
cd "$MAIN_ROOT"

# FEATURE_BRANCH is "" — skip git branch -D entirely (no branch exists).
```

Then branch on provenance — and report state-specifically. Do NOT claim discard succeeded for harness-owned workspaces unless the native exit tool was actually invoked AND succeeded:

- **Provenance-owned workspace** (`$FEATURE_WORKTREE_PATH` under `.worktrees/`, `worktrees/`, or `~/.config/superpowers/worktrees/`): we already `cd`-ed to `$MAIN_ROOT` above, so force-remove the workspace inline. This is the only thing that makes the dangling commits unreachable from any worktree HEAD. Step 6 sees no worktree to clean up after this (its existence guard will skip the redundant remove and just run `prune`).

  ```bash
  # CWD is already $MAIN_ROOT (set above). Removing from inside the
  # workspace would violate CWD safety; do not re-enter it.
  git worktree remove --force "$FEATURE_WORKTREE_PATH"
  git worktree prune
  ```

  Then report success:

  ```
  Discarded (dangling commits pending GC). The detached-HEAD commits are
  no longer reachable from any worktree HEAD but remain in the repository
  until git's garbage collector runs. To force-discard them now:
      git reflog expire --expire=now --all && git gc --prune=now
  Workspace: provenance-owned worktree force-removed inline.
  ```

- **Harness-owned workspace:** do NOT manually remove anything. Attempt to invoke the harness's native exit/abandon tool (e.g. `ExitWorktree`) on `$FEATURE_WORKTREE_PATH`. The report you print depends on whether that native call actually succeeded — there are two distinct branches and you MUST NOT collapse them into a single "Discarded" message:

  - **Native exit tool available AND succeeded:** report
    ```
    Discarded via harness (dangling commits pending GC). The native exit
    tool detached the workspace; the detached-HEAD commits are no longer
    reachable from any worktree HEAD but remain in the repository until
    git's garbage collector runs. To force-discard them now:
        git reflog expire --expire=now --all && git gc --prune=now
    ```

  - **Native exit tool unavailable OR failed:** do NOT claim the work was discarded. Report the situation truthfully so the user can take the next step:
    ```
    Could not discard: the harness's native exit tool is unavailable or
    failed, and this skill must not manually remove a harness-owned
    workspace. The detached-HEAD commits remain reachable from this
    workspace's HEAD. To complete the discard, either:
      - invoke the harness's worktree-exit tool (e.g. ExitWorktree) on
        <path>, or
      - manually run, from outside the workspace:
          cd "$MAIN_ROOT" && git worktree remove --force "$FEATURE_WORKTREE_PATH"
    ```

**4b. Named-branch discard, provenance-owned worktree.** Order is load-bearing AND CWD-safety-bound: you MUST `cd "$MAIN_ROOT"` FIRST (you cannot `git worktree remove` a worktree from inside it — see Red Flags / "Running git worktree remove from inside the worktree"), THEN remove the worktree, THEN force-delete the branch. `git branch -D` fails while the branch is still checked out in a still-present worktree, so the worktree removal MUST complete before the branch delete is attempted. Step 6's provenance-owned cleanup block is therefore a no-op for 4b (the worktree is already gone — Step 6's existence guard skips the redundant `git worktree remove` and just runs `git worktree prune`):

```bash
# 1. Leave the feature workspace context FIRST. Mandatory: removing a
#    worktree from inside it is unsafe and prohibited by the CWD-safety
#    rule in Red Flags / Step 6. FEATURE_* values were already captured
#    BEFORE the confirmation prompt, so no information is lost by cd-ing
#    out now.
cd "$MAIN_ROOT"

# 2. Now safely force-remove the worktree. --force because we are
#    discarding uncommitted state along with the branch.
git worktree remove --force "$FEATURE_WORKTREE_PATH"

# 3. Worktree is gone, so the branch is no longer checked out anywhere
#    and force-delete is safe.
git branch -D "$FEATURE_BRANCH"
```

**4c. Named-branch discard, harness-owned worktree.** The harness owns the workspace. Do NOT manually `git worktree remove`, do NOT manually `git branch -D` (the delete will fail while the branch is still checked out in the harness workspace), and do NOT `git checkout` inside the harness workspace either — invoke the harness's native exit/abandon tool (e.g. `ExitWorktree`) and let it perform branch deletion + workspace removal as part of native cleanup:

```bash
# No cd here — the harness's native exit tool handles its own context.
# Invoke ExitWorktree (or equivalent) on $FEATURE_WORKTREE_PATH /
# $FEATURE_BRANCH and stop. Step 6's "harness-owned" branch will also
# leave the workspace in place.
```

If no native exit tool is available, leave the branch and the workspace alone and report the situation to the user — do NOT print a "Discarded" message that isn't true.

**4d. Named-branch discard, normal repo (`FEATURE_GIT_DIR == FEATURE_GIT_COMMON`).** No separate worktree, so the current shell IS the right context. The branch is currently checked out, so the only safe order is: switch to base, then force-delete (no `cd "$MAIN_ROOT"` needed — we are already there):

```bash
git checkout "<base-branch>"
git branch -D "$FEATURE_BRANCH"
```

### Step 6: Cleanup Workspace

**Only runs for Options 1 and 4.** Options 2 and 3 always preserve the worktree.

**CRITICAL ordering rule:** Step 5 (Option 1 / Option 4) captures all of `FEATURE_WORKTREE_PATH`, `FEATURE_BRANCH`, `FEATURE_GIT_DIR`, `FEATURE_GIT_COMMON`, and `MAIN_ROOT` at its very start, BEFORE any `cd` / `git checkout`. Step 6 reuses those values verbatim — it must NOT recompute them, because after `cd "$MAIN_ROOT"` `git rev-parse --show-toplevel` returns the main repo, not the feature worktree, and `git rev-parse --git-dir` likewise no longer points at the feature worktree's `.git` link.

For reference, the capture block (already present in Option 1 / Option 4) is:

```bash
FEATURE_WORKTREE_PATH=$(git rev-parse --show-toplevel)
FEATURE_BRANCH=$(git branch --show-current)         # may be empty in detached HEAD
FEATURE_GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
FEATURE_GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
```

**If `FEATURE_GIT_DIR == FEATURE_GIT_COMMON`:** Normal repo, no worktree to clean up. Done.

**Provenance-owned cleanup — if `$FEATURE_WORKTREE_PATH` is under `.worktrees/`, `worktrees/`, or `~/.config/superpowers/worktrees/`:** Superpowers created this worktree — we own cleanup. Use the captured paths; do NOT recompute them. The block MUST be guarded against double-removal: Option 4 subcases 4a (provenance-owned) and 4b already remove the worktree inline before reaching Step 6, so an unguarded `git worktree remove` here would fail on the already-removed path. Skip the remove when the path no longer exists:

```bash
cd "$MAIN_ROOT"

# Existence/registration guard: 4a (provenance-owned) and 4b removed the
# worktree inline; only Option 1 (merge locally) reaches Step 6 with the
# worktree still on disk. Skip remove if it is already gone.
if [ -d "$FEATURE_WORKTREE_PATH" ] && \
   git worktree list --porcelain | grep -q "^worktree $FEATURE_WORKTREE_PATH$"; then
  git worktree remove "$FEATURE_WORKTREE_PATH"
fi
git worktree prune  # Self-healing: clean up any stale registrations
```

**Note:** Option 4's discard subcases 4a (provenance-owned branch only) and 4b already perform their own inline `git worktree remove --force`. For those subcases, the existence guard above causes Step 6 to skip the redundant remove and run only `git worktree prune`. Only Option 1 (Merge Locally) on a provenance-owned worktree relies on Step 6 to perform the actual `git worktree remove`. Subcase 4a's harness-owned branch never reaches this Step 6 block (Step 6 below routes harness-owned workspaces to "Otherwise" and skips this code path).

**Conditional branch deletion (back in Step 5):**

- Run `git branch -d "$FEATURE_BRANCH"` (Option 1) or `git branch -D "$FEATURE_BRANCH"` (Option 4) **only after** the worktree has been removed by the block above (provenance-owned path) **or** after the harness's native exit tool has succeeded. If `$FEATURE_WORKTREE_PATH` is still on disk and still has the branch checked out, the delete will fail — skip it and report.
- If `FEATURE_BRANCH` is empty (detached-HEAD discard), skip branch deletion entirely — there is no branch to delete. See Option 4a above.

**Otherwise (harness-owned workspace):** Do NOT remove it. If your platform provides a workspace-exit tool, use it (and let it perform branch deletion as part of native cleanup). Otherwise, leave the workspace in place and skip the manual `git branch -d/-D` — see Option 4c.

## Quick Reference

Cleanup behavior depends on workspace state. Worktree removal and branch deletion vary by sub-case for Options 1 and 4.

| Option | Merge | Push | Keep Worktree | Cleanup Branch |
|--------|-------|------|---------------|----------------|
| 1. Merge locally — normal repo | yes | - | n/a (no worktree) | yes (`-d`, after merge) |
| 1. Merge locally — provenance-owned worktree | yes | - | no (`worktree remove` after merge) | yes (`-d`, after worktree removed) |
| 1. Merge locally — harness-owned worktree | yes | - | no (via native exit) | via native exit (not manual) |
| 2. Create PR | - | yes | yes | - |
| 3. Keep as-is | - | - | yes | - |
| 4a. Discard — detached HEAD, provenance-owned | - | - | no (inline `git worktree remove --force`, no checkout) | n/a (no branch; commits dangle until GC) |
| 4a. Discard — detached HEAD, harness-owned | - | - | no (via native exit; if unavailable/fails, report failure + manual command) | n/a (no branch; commits dangle until GC) |
| 4b. Discard — provenance-owned worktree | - | - | no (`worktree remove --force`) | yes (`-D`, after worktree removed) |
| 4c. Discard — harness-owned worktree | - | - | no (via native exit) | via native exit (not manual) |
| 4d. Discard — normal repo | - | - | n/a (no worktree) | yes (`-D`, after `checkout <base>`) |

## Common Mistakes

**Skipping test verification**
- **Problem:** Merge broken code, create failing PR
- **Fix:** Always verify tests before offering options

**Open-ended questions**
- **Problem:** "What should I do next?" is ambiguous
- **Fix:** Present exactly 4 structured options (or 3 for detached HEAD)

**Cleaning up worktree for Option 2**
- **Problem:** Remove worktree user needs for PR iteration
- **Fix:** Only cleanup for Options 1 and 4

**Deleting branch before removing worktree**
- **Problem:** `git branch -d` fails because worktree still references the branch
- **Fix:** Merge first, remove worktree, then delete branch

**Running git worktree remove from inside the worktree**
- **Problem:** Command fails silently when CWD is inside the worktree being removed
- **Fix:** Always `cd` to main repo root before `git worktree remove`

**Cleaning up harness-owned worktrees**
- **Problem:** Removing a worktree the harness created causes phantom state
- **Fix:** Only clean up worktrees under `.worktrees/`, `worktrees/`, or `~/.config/superpowers/worktrees/`

**No confirmation for discard**
- **Problem:** Accidentally delete work
- **Fix:** Require typed "discard" confirmation

## Red Flags

**Never:**
- Proceed with failing tests
- Merge without verifying tests on result
- Delete work without confirmation
- Force-push without explicit request
- Remove a worktree before confirming merge success
- Clean up worktrees you didn't create (provenance check)
- Run `git worktree remove` from inside the worktree

**Always:**
- Verify tests before offering options
- Detect environment before presenting menu
- Present exactly 4 options (or 3 for detached HEAD)
- Get typed confirmation for Option 4
- Clean up worktree for Options 1 & 4 only
- `cd` to main repo root before worktree removal
- Run `git worktree prune` after removal
```

**Notes for the implementer:**
- This content is ported and adapted from upstream v5.1.0 with fork-specific additions retained: the Option 2 "PR body" branching for `COMMIT_COUNT > 5` (Opus subagent dispatch), the detached-HEAD branch-naming step before Option 1, the FEATURE_* pre-cd capture block, and the 4a/4b/4c/4d conditional branch-deletion subcases. Upstream removed this; this fork already shipped it (fork's prior `finishing-a-development-branch/SKILL.md` lines 92-127). It is judgment work the fork's main thread already delegates to Opus elsewhere — keep it.
- The upstream `## Integration` section ("Called by: subagent-driven-development / executing-plans") is removed because `subagent-driven-development` is intentionally excluded from this fork. `executing-plans` is present and still calls this skill, but per upstream's decision integration sections are legacy cleanup.
- Do not renumber. Steps go 1 → 2 → 3 → 4 → 5 → 6.

## Test strategy

Skills are plain markdown read by the harness/agent — there is no compilation or unit-test step. Verification is structural and behavioral.

**Phase-scoped checks** (each grep MUST target only the file changed in that phase — running cross-file greps against a not-yet-modified skill produces false BLOCKERs).

**After Ф1 (only `skills/using-git-worktrees/SKILL.md` has changed), verify:**

1. **Frontmatter integrity:**
   ```bash
   head -4 skills/using-git-worktrees/SKILL.md
   ```

2. **No accidental fork-name references in the Ф1 file:**
   ```bash
   grep -E '(/Users/jesse|obra/superpowers)' skills/using-git-worktrees/SKILL.md
   ```
   Expected: no matches.

3. **No references to skills excluded from this fork — Ф1 file only:**
   ```bash
   grep -nE '(subagent-driven-development|using-superpowers)' skills/using-git-worktrees/SKILL.md
   ```
   Expected: no matches. Do NOT grep `finishing-a-development-branch/SKILL.md` here — it still contains the upstream-style Integration mentions until Ф2 lands.

4. **Self-containment:** `using-git-worktrees` references no other skill files by path.

4a. **R2 gate — dev-orchestrator does not invoke `using-git-worktrees` directly.** The positive passing condition is that `skills/dev-orchestrator/SKILL.md` contains **no** references to `using-git-worktrees`, `SUPERPOWERS_ORCHESTRATOR`, `WORKTREE_*`, or `.worktrees/`. Because the orchestrator never calls this skill, the new consent prompt cannot block it — there is nothing to bypass at the call site. The env-var / explicit-path bypass added in Step 0 exists only as a defense-in-depth contract for any future caller.

   ```bash
   grep -rE 'using-git-worktrees|SUPERPOWERS_ORCHESTRATOR|WORKTREE_|\.worktrees/' skills/dev-orchestrator/SKILL.md
   ```
   Expected: **no matches**. This is the passing condition: it proves dev-orchestrator does not invoke `using-git-worktrees` and therefore cannot regress on consent.

   If matches DO appear, the orchestrator has started invoking the skill and the gate must be revisited — `skills/dev-orchestrator/SKILL.md` would then need to be brought into scope to ensure either `SUPERPOWERS_ORCHESTRATOR=1` is set or an explicit worktree path is passed (see Risks R2).

**After Ф2 (both skill files now in their final state), verify:**

5. **Frontmatter integrity for the Ф2 file:**
   ```bash
   head -4 skills/finishing-a-development-branch/SKILL.md
   ```

6. **No fork-name references in the Ф2 file:**
   ```bash
   grep -E '(/Users/jesse|obra/superpowers)' skills/finishing-a-development-branch/SKILL.md
   ```
   Expected: no matches.

7. **Cross-file excluded-skills check (run only after Ф2):**
   ```bash
   grep -nE '(subagent-driven-development|using-superpowers)' skills/using-git-worktrees/SKILL.md skills/finishing-a-development-branch/SKILL.md
   ```
   Expected: no matches.

8. **Self-containment:** `finishing-a-development-branch` references no other skill files by path.

9. **Behavioral smoke test (manual, optional):** in a clone of this repo, with a child agent, run a session that asks the agent to "set up an isolated workspace for a small task" and confirm:
   - The agent runs the Step 0 detection.
   - When run inside an existing worktree (which is typical when dev-orchestrator already created one), the agent reports the existing isolation and skips creation rather than nesting a worktree.
   - When run with no `EnterWorktree` tool available, the agent falls through to the `git worktree add` path.

10. **Target-file smoke (run after Ф2) — narrowed to the two target skill files only:**
    ```bash
    grep -nE 'subagent-driven-development|using-superpowers' \
      skills/using-git-worktrees/SKILL.md \
      skills/finishing-a-development-branch/SKILL.md
    ```
    Expected: no matches.

    **Explicitly excluded from this check:** `skills/writing-skills/render-graphs.js` — it contains pre-existing example strings (e.g. `subagent-driven-development`) from prior plugin versions and is **not** modified by this plan. Do NOT grep the whole `skills/` directory; doing so produces a guaranteed false BLOCKER on `render-graphs.js`. If a future plan needs to scrub those example strings, it does so on its own scope.

11. **Ф2 contract assertions — prove the fork-specific contract landed.** These targeted greps verify the four hard requirements of the Ф2 rewrite (Opus dispatch, Option 2 worktree preservation, FEATURE_* pre-cd capture, conditional branch deletion):

    a. **Opus dispatch retained in `COMMIT_COUNT > 5` block:**
       ```bash
       grep -cE 'opus|Opus' skills/finishing-a-development-branch/SKILL.md
       ```
       Expected: ≥1 match, located inside the Option 2 `COMMIT_COUNT > 5` block.

    b. **Option 2 preserves worktree:**
       ```bash
       grep -nE 'keep.*worktree|worktree.*keep|Do NOT clean up worktree|preserve' skills/finishing-a-development-branch/SKILL.md
       ```
       Expected: ≥1 match showing Option 2 explicitly preserves the worktree for PR iteration.

    c. **FEATURE_* captured BEFORE any `cd`:**
       ```bash
       grep -nE 'FEATURE_WORKTREE_PATH|FEATURE_GIT_DIR' skills/finishing-a-development-branch/SKILL.md
       ```
       Expected: ≥1 match. Manually inspect that the first occurrence in Option 1 / Option 4 precedes the first `cd "$MAIN_ROOT"` in the same code block.

    d. **Conditional branch deletion (empty-FEATURE_BRANCH guard):**
       ```bash
       grep -nE 'FEATURE_BRANCH.*empty|empty.*FEATURE_BRANCH|FEATURE_BRANCH is "\"|skip git branch' skills/finishing-a-development-branch/SKILL.md
       ```
       Expected: ≥1 match showing the detached-HEAD-discard path skips `git branch -D` when `FEATURE_BRANCH` is empty.

12. **Manual smoke checklist (human verification, not automated) — exercise the four execution paths after Ф2:**
    - [ ] **Normal repo** (`GIT_DIR == GIT_COMMON`): finishing flow shows the standard 4-option menu; Step 6 reports "no worktree to clean up"; Option 1 deletes the branch unconditionally after merge.
    - [ ] **Provenance-owned worktree** (under `.worktrees/`): standard 4-option menu; Step 6 runs `git worktree remove` + `git worktree prune`; branch deletion runs only after the worktree is removed.
    - [ ] **Harness-owned worktree** (named branch, workspace not under a provenance path): skill leaves the workspace in place, defers to native exit tool, does NOT print a false "Discarded" message (case 4c).
    - [ ] **Detached HEAD**: reduced 3-option menu; Option 1 forces named-branch creation first; Option 4 (case 4a) skips `git branch -D` and truthfully reports dangling commits remain until GC. Test both 4a sub-cases:
        - [ ] **(a) provenance-owned** (workspace under `.worktrees/`, `worktrees/`, or `~/.config/superpowers/worktrees/`): confirmation prompt discloses inline `git worktree remove --force`; after confirmation, verify the worktree directory is removed and "Discarded (dangling commits pending GC)" is reported.
        - [ ] **(b) harness-owned** (workspace not under a provenance path): confirmation prompt discloses native-exit delegation and the failure path; after confirmation, verify the harness's native exit tool is invoked and the success/failure report matches what actually happened (no false "Discarded" message if the native call was unavailable or failed).

13. **Commit per phase:** Ф1 and Ф2 each land as their own commit so they can be reverted independently.

## Risks / unknowns / assumptions

**Risks**

- **R1. Behavior change for in-flight worktrees.** Step 0 detection means that a session already running inside a `.worktrees/<branch>` checkout will *no longer* create a nested worktree. Anything that implicitly relied on the old behavior (rare, but possible in custom workflows that intentionally nest) will see a behavior change. Mitigation: the new behavior matches what the user almost certainly wants (no nesting); document the change in commit message.

- **R2. dev-orchestrator interaction (RESOLVED — gate verdict recorded).** The fork's `dev-orchestrator` skill creates worktrees through its own path and may call `using-git-worktrees`. The new consent prompt MUST NOT block orchestrated automation.
  - **Contract (mandatory):** Step 0 of `using-git-worktrees` MUST bypass the consent prompt when (a) `SUPERPOWERS_ORCHESTRATOR=1` is set in the environment, OR (b) the invoking instructions / arguments declare an explicit worktree path or directory. This is captured in the Step 0 "Automation bypass" block in the Ф1 Contracts above.
  - **Gate verdict:** `skills/dev-orchestrator/SKILL.md` requires **no changes** in this plan. The orchestrator does not invoke `using-git-worktrees` at all (verified by the static check in "After Ф1" item 4a), so the new consent prompt cannot block it — there is nothing to bypass at the call site. The `SUPERPOWERS_ORCHESTRATOR=1` env-var / explicit-path bypass in Step 0 is retained as defense-in-depth for any future caller that DOES invoke this skill from automation. `skills/dev-orchestrator/SKILL.md` is therefore **not** in `Files / Phase Ф1` and Ф1 ships no commit touching it.
  - **Verification (in "After Ф1" Test strategy item 4a):** the gate passes because `grep` for `using-git-worktrees|SUPERPOWERS_ORCHESTRATOR|WORKTREE_|\.worktrees/` in `skills/dev-orchestrator/SKILL.md` returns no matches. If that ever changes (the orchestrator starts invoking the skill), the gate must be revisited and `skills/dev-orchestrator/SKILL.md` brought into scope.

- **R3. Option 2 PR body composition (FIXED REQUIREMENT, not optional).** The fork's Opus PR-body subagent dispatch for `COMMIT_COUNT > 5` MUST be retained verbatim in Option 2. Upstream dropped it; this fork keeps it. The Ф2 Contracts retain it; the implementer MUST NOT drop it, gate it, or mark it optional. Removing it is out of scope for this plan.

**Unknowns**

- **U1. Whether `executing-plans` (kept in this fork) calls `finishing-a-development-branch` by path or by name.** Implementer should grep before changing the file to confirm no path-based reference breaks. The frontmatter `name:` and file path are unchanged, so by-name dispatch is fine.

**Assumptions**

- **A1. The fork keeps the rule "no `subagent-driven-development`, no `using-superpowers`."** The contracts above explicitly omit any cross-reference to those skills. If that policy ever changes, those references can be added back.

- **A2. AI-contributor guidelines (CLAUDE.md / AGENTS.md) are NOT ported.** Reasoning: upstream's guidelines exist to deter people from sending slop PRs to `obra/superpowers`. This fork is itself a fork — by upstream's rule #56 ("Fork-specific changes will be closed"), the fork would never legitimately submit upstream PRs of this kind. The repo also has no root-level `CLAUDE.md` (only the user's global one). Adding one purely to mirror upstream prose adds no value here. Skip.

- **A3. Code-review consolidation is NOT ported.** Reasoning: the fork's `requesting-code-review` SKILL.md already (a) co-locates `code-reviewer.md` in the same directory, (b) dispatches `Agent(subagent_type="general-purpose", model="opus", ...)` rather than the named `superpowers:code-reviewer` agent that upstream removed, and (c) goes further than upstream by adding a Codex xhigh fused-control-review step. Importing the upstream SKILL.md would *regress* the fork. Skip.

- **A4. Bootstrap caching is NOT ported.** Reasoning: that change applies to the OpenCode harness runtime. The fork ships skills for Claude Code only; the vendored `codex-companion` is a separate runtime path. Skip.

- **A5. `receiving-code-review` is NOT ported.** Reasoning: the fork's local copy already matches upstream and additionally includes a fork-specific "Opus Triage for Complex External Review Threads" section. Importing upstream would lose that section.

## Phases

### Ф1: Rewrite using-git-worktrees skill

Replace `skills/using-git-worktrees/SKILL.md` with the full content given in Contracts/Ф1. Verify by running the full **"After Ф1"** block from "Test strategy" (frontmatter, fork-name grep, excluded-skills grep on Ф1 file only, self-containment, **R2 dev-orchestrator gate verification**). Do NOT run the "After Ф2" cross-file or plugin-level checks yet — `finishing-a-development-branch/SKILL.md` is still upstream-style at this point and those checks will false-BLOCKER. Commit with message:

```
feat(using-git-worktrees): port upstream v5.1.0 rewrite

- Adds Step 0 environment detection (GIT_DIR != GIT_COMMON) so the skill
  no longer creates a nested worktree when already running inside one.
- Adds submodule guard (git rev-parse --show-superproject-working-tree).
- Adds Step 1a native-tool preference for harnesses that ship their own
  worktree controls (e.g. EnterWorktree); only falls back to
  `git worktree add` when no native tool is available.
- Requires explicit user consent before creating a worktree.
- Adds sandbox fallback note for `git worktree add` permission errors.

Source: obra/superpowers v5.1.0 (release 2026-04-30, PRI-974/PR #1121).
Integration section referencing subagent-driven-development /
using-superpowers (intentionally excluded from this fork) was already
absent upstream — preserved that absence.
```

### Ф2: Rewrite finishing-a-development-branch skill

Replace `skills/finishing-a-development-branch/SKILL.md` with the full content given in Contracts/Ф2. Verify by running the full **"After Ф2"** block from "Test strategy" (Ф2 frontmatter, fork-name grep on Ф2 file, cross-file excluded-skills grep across both skill files, self-containment, target-file smoke narrowed to the two target files, Ф2 contract assertions a–d, manual 4-path smoke checklist, per-phase commit check). The behavioral smoke test (item 9) is optional. Commit with message:

```
feat(finishing-a-development-branch): port upstream v5.1.0 rewrite

- Adds Step 2 environment detection so the menu and cleanup logic
  branch on whether we are in a normal repo, a named-branch worktree,
  or a detached-HEAD workspace (further split by provenance:
  provenance-owned vs harness-owned).
- Adds reduced 3-option menu for detached HEAD (no local merge).
- Provenance-based cleanup: Step 6 only removes worktrees under
  .worktrees/, worktrees/, or ~/.config/superpowers/worktrees/.
  Harness-owned worktrees are left alone.
- Merge-then-remove ordering: merge succeeds first, worktree removed
  next, branch deleted last (fixes `git branch -d` failing with
  worktree still attached).
- `cd` to main repo root before `git worktree remove` (CWD safety).
- Adds `git worktree prune` after removal as self-healing for stale
  registrations.

Source: obra/superpowers v5.1.0. Retains the fork-specific Opus PR-body
subagent dispatch for COMMIT_COUNT > 5 in Option 2 (upstream dropped
this; we keep it).
```
