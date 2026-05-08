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

**Repository guard (MUST run first):** Before any other `git rev-parse` call, verify the current directory is inside a git repository.

```bash
# not inside a git repository guard
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not inside a git repository. Please run this skill from within a git repo."
  exit 1
fi
```

If this guard fails, stop immediately. Do NOT proceed with the rest of the steps.

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

#### Repository Context

Before resolving default or project-local paths, check whether the repository is bare:

```bash
IS_BARE_REPO=$(git rev-parse --is-bare-repository 2>/dev/null)
```

If `IS_BARE_REPO` is `true`, automatic worktree directory selection is not supported. Say: "Bare repositories are not supported for automatic worktree directory selection. Please provide an explicit WORKTREE_PATH." Require an explicit full `WORKTREE_PATH` and skip project-local/default directory lookup and `.gitignore` verification.

For non-bare repositories, set the project root once and use it as the base for all project-local path lookup and creation:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
```

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
   ls -d "$PROJECT_ROOT/.worktrees" 2>/dev/null     # Preferred (hidden)
   ls -d "$PROJECT_ROOT/worktrees" 2>/dev/null      # Alternative
   ```
   If found, use as `WORKTREE_PARENT_DIR`. If both exist, `.worktrees` wins.
5. **Existing global parent directory** (backward compatibility with legacy global path):
   ```bash
   project=$(basename "$(git rev-parse --show-toplevel)")
   ls -d "$HOME/.config/superpowers/worktrees/$project" 2>/dev/null
   ```
   If found, use as `WORKTREE_PARENT_DIR`.
6. **Default**: `WORKTREE_PARENT_DIR="$PROJECT_ROOT/.worktrees"` at the project root.

When resolution selects an explicit `WORKTREE_PATH`, set `WORKTREE_PATH_EXPLICIT=1`. When resolution selects only a `WORKTREE_PARENT_DIR` (including inferred/default parent directories), set `WORKTREE_PATH_EXPLICIT=0`.

After resolution, derive both variables:

```bash
# If a project-local input was relative, anchor it to PROJECT_ROOT first:
case "$WORKTREE_PARENT_DIR" in
  ""|/*) ;;
  *) WORKTREE_PARENT_DIR="$PROJECT_ROOT/$WORKTREE_PARENT_DIR" ;;
esac
case "$WORKTREE_PATH" in
  ""|/*) ;;
  *) WORKTREE_PATH="$PROJECT_ROOT/$WORKTREE_PATH" ;;
esac

# If an explicit full path was provided, preserve it and derive its parent:
if [ "$WORKTREE_PATH_EXPLICIT" = "1" ]; then
  WORKTREE_PARENT_DIR=$(dirname "$WORKTREE_PATH")
else
  # If only a parent directory was provided or defaulted, append the branch name:
  WORKTREE_PATH="$WORKTREE_PARENT_DIR/$BRANCH_NAME"
fi
```

If a caller supplies a relative `WORKTREE_PARENT_DIR` or `WORKTREE_PATH` that is intended to be project-local, resolve it from `$PROJECT_ROOT`, not from the current shell directory.

#### Safety Verification (project-local directories only)

**MUST verify the project-local `.gitignore` target before creating the worktree.** The target depends on which input shape was selected:

1. **Explicit `WORKTREE_PATH`:** Check `WORKTREE_PATH` itself. If adding a pattern to `.gitignore`, add `$WORKTREE_PATH/` as a repo-relative, root-anchored pattern. This ignores the exact worktree directory and avoids accidentally ignoring the whole repo root when the explicit path lives directly under `$PROJECT_ROOT`.
2. **Only `WORKTREE_PARENT_DIR` provided, inferred, or defaulted:** Check `WORKTREE_PARENT_DIR`. If adding a pattern to `.gitignore`, add `$WORKTREE_PARENT_DIR/` as a repo-relative, root-anchored pattern. Ignoring the parent ignores all branch worktree children, which is what we want for parent-directory mode.

```bash
# Choose the .gitignore target from the selected input shape.
if [ "$WORKTREE_PATH_EXPLICIT" = "1" ]; then
  GITIGNORE_TARGET="$WORKTREE_PATH"
else
  GITIGNORE_TARGET="$WORKTREE_PARENT_DIR"
fi

GITIGNORE_TARGET=$(cd "$(dirname "$GITIGNORE_TARGET")" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$(basename "$GITIGNORE_TARGET")" || printf '%s\n' "$GITIGNORE_TARGET")
git check-ignore -q "$GITIGNORE_TARGET" 2>/dev/null
CHECK_IGNORE_STATUS=$?
```

Handle `git check-ignore` exit codes explicitly: 0 means ignored, 1 means not ignored, 128 means fatal.

- **Exit 0:** Path IS gitignored. Proceed normally.
- **Exit 1:** Path is NOT gitignored. Offer to add a repo-relative, root-anchored pattern for `GITIGNORE_TARGET` to `$PROJECT_ROOT/.gitignore`, commit the change, then proceed:
  ```bash
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required to compute a repo-relative .gitignore pattern."
    exit 1
  fi
  pattern=$(python3 -c "import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$GITIGNORE_TARGET" "$PROJECT_ROOT")
  gitignore_pattern="/$pattern/"
  printf '%s\n' "$gitignore_pattern" >> "$PROJECT_ROOT/.gitignore"
  ```
- **Exit 128:** Fatal error, such as path outside the repo or an invalid path. Warn the user that the path may be outside the repo or invalid; do not attempt `.gitignore` modification.

**Why critical:** Prevents accidentally committing worktree contents to repository.

Global directories (paths under `~/.config/superpowers/worktrees/`) and absolute paths outside the repo need no verification — skip this check when `GITIGNORE_TARGET` is not inside the working tree.

#### Preflight Before Creation

Before running `git worktree add`, check for existing directories, registered worktrees, and branch collisions:

```bash
if [ -e "$WORKTREE_PATH" ]; then
  echo "Worktree directory already exists: $WORKTREE_PATH"
fi

git worktree list --porcelain | grep -Fx "worktree $WORKTREE_PATH" >/dev/null

git branch --list -- "$BRANCH_NAME"

BRANCH_WORKTREE=$(git worktree list --porcelain | awk -v ref="refs/heads/$BRANCH_NAME" '
  $1 == "worktree" { worktree=$2 }
  $1 == "branch" && $2 == ref { print worktree }
')
```

- If `[ -e "$WORKTREE_PATH" ]`, the worktree directory already exists. Offer to reuse it if it contains the intended checkout, or choose a different `WORKTREE_PATH`.
- If `git worktree list --porcelain` shows `WORKTREE_PATH` already registered, reuse that worktree and `cd -- "$WORKTREE_PATH"` instead of creating a new one.
- If `BRANCH_WORKTREE` is non-empty, the branch is already checked out in another worktree. Either reuse that existing worktree with `cd -- "$BRANCH_WORKTREE"`, or choose a different `BRANCH_NAME`. Do not run `git worktree add` for that branch.
- If `git branch --list -- "$BRANCH_NAME"` returns a branch and `BRANCH_WORKTREE` is empty, the branch exists but is free. Use `git worktree add -- "$WORKTREE_PATH" "$BRANCH_NAME"` without `-b`.
- If `git branch --list -- "$BRANCH_NAME"` returns nothing, the branch does not exist. Use `git worktree add -b "$BRANCH_NAME" -- "$WORKTREE_PATH"` to create it.

#### Create the Worktree

```bash
# $WORKTREE_PATH was resolved above (either explicitly supplied or
# derived as $WORKTREE_PARENT_DIR/$BRANCH_NAME). Use it directly.
if [ -n "$BRANCH_WORKTREE" ]; then
  echo "Branch '$BRANCH_NAME' is already checked out in another worktree: $BRANCH_WORKTREE"
  echo "Reuse it with: cd -- \"$BRANCH_WORKTREE\""
  echo "Or choose a different branch name."
  exit 1
elif git branch --list --format='%(refname:short)' -- "$BRANCH_NAME" | grep -Fx -- "$BRANCH_NAME" >/dev/null; then
  git worktree add -- "$WORKTREE_PATH" "$BRANCH_NAME"
  WORKTREE_ADD_STATUS=$?
else
  git worktree add -b "$BRANCH_NAME" -- "$WORKTREE_PATH"
  WORKTREE_ADD_STATUS=$?
fi

if [ "$WORKTREE_ADD_STATUS" -ne 0 ]; then
  echo "git worktree add failed for: $WORKTREE_PATH"
  echo "Do not cd into the worktree. Stop execution and report the error above."
  if [ -d "$WORKTREE_PATH" ]; then
    echo "A partial directory was created at $WORKTREE_PATH. Offer to clean it up before retrying."
  fi
  exit "$WORKTREE_ADD_STATUS"
fi

cd -- "$WORKTREE_PATH"
```

**Sandbox failure:** If `git worktree add` fails with a permission error (sandbox denial), tell the user the sandbox blocked worktree creation, check whether a partial directory was created, offer cleanup if needed, and stop execution. Do not continue in the current directory unless the user explicitly asks for that separate fallback.

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
| Nothing else applies | Default `$PROJECT_ROOT/.worktrees` |
| Bare repo | Require explicit full `$WORKTREE_PATH`; skip automatic project-local/default selection |
| Chosen project-local `$WORKTREE_PARENT_DIR` not ignored | Offer to add repo-relative `/$pattern/` to `.gitignore` + commit |
| `git check-ignore` exits 128 | Warn path may be outside repo or invalid; do not edit `.gitignore` |
| Existing `$WORKTREE_PATH` | Reuse if appropriate or choose a different path |
| Existing registered worktree | Reuse it |
| Existing `$BRANCH_NAME` checked out in another worktree | Reuse that worktree or choose a new branch name |
| Existing free `$BRANCH_NAME` | Add worktree with existing branch, without `-b` |
| Missing `$BRANCH_NAME` | Add worktree with `-b` to create the branch |
| `git worktree add` failed | Report the error, offer cleanup for any partial directory, and stop |
| Permission error on create | Report sandbox failure, offer cleanup for any partial directory, and stop |
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
- **Fix:** Always use `git check-ignore` before creating project-local worktree, and handle exit codes 0, 1, and 128 distinctly

### Assuming directory location

- **Problem:** Creates inconsistency, violates project conventions
- **Fix:** Follow the canonical priority: explicit arg > env var > instruction file > existing project-local under `$PROJECT_ROOT` > existing global legacy > default `$PROJECT_ROOT/.worktrees`

### Proceeding with failing tests

- **Problem:** Can't distinguish new bugs from pre-existing issues
- **Fix:** Report failures, get explicit permission to proceed

## Red Flags

**Never:**
- Create a worktree when Step 0 detects existing isolation
- Use `git worktree add` when you have a native worktree tool (e.g., `EnterWorktree`). This is the #1 mistake — if you have it, use it.
- Skip Step 1a by jumping straight to Step 1b's git commands
- Create worktree without verifying it's ignored (project-local)
- Treat a bare repo like a normal checkout for automatic directory selection
- Run `git worktree add` before checking existing path, registered worktree, and branch name
- Skip baseline test verification
- Proceed with failing tests without asking

**Always:**
- Run Step 0 detection first
- Prefer native tools over git fallback
- Follow directory priority: explicit arg > env var > instruction file > existing project-local under `$PROJECT_ROOT` > existing global legacy > default `$PROJECT_ROOT/.worktrees`
- Verify directory is ignored for project-local
- Auto-detect and run project setup
- Verify clean test baseline
