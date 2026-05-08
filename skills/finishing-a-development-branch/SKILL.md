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
FEATURE_BRANCH=$(git branch --show-current)         # FEATURE_BRANCH is "" in detached HEAD
```

This determines which menu to show and how cleanup works:

| State | Menu | Cleanup |
|-------|------|---------|
| `GIT_DIR == GIT_COMMON`, named branch | Standard 4 options | No worktree to clean up |
| `GIT_DIR == GIT_COMMON`, detached HEAD | Reduced 3 options (no merge) | Normal repo detached-HEAD flow: push as new branch, keep, or discard; no branch delete unless a branch is created |
| `GIT_DIR != GIT_COMMON`, named branch | Standard 4 options | Provenance-based (see Step 6) |
| `GIT_DIR != GIT_COMMON`, detached HEAD, provenance-owned | Reduced 3 options (no merge) | Inline `git worktree remove --force` (Option 4a provenance subcase) |
| `GIT_DIR != GIT_COMMON`, detached HEAD, harness-owned | Reduced 3 options (no merge) | Native exit tool only; if unavailable/fails, report failure + manual command (Option 4a harness subcase) |

If `FEATURE_BRANCH` is empty, the workspace is detached HEAD even in a normal repo. Route to the detached-HEAD 3-option menu before any standard 4-option branch workflow; the 4-option workflow assumes a named branch exists for merge/delete.

### Step 3: Determine Base Branch

```bash
# Try common base branches
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null
```

Or ask: "This branch split from main - is that correct?"

Once selected, capture the base branch name exactly once and use the quoted
variable in all subsequent commands:

```bash
BASE_BRANCH="<user-selected-base-branch>"
```

### Step 4: Present Options

**Normal repo and named-branch worktree — present exactly these 4 options:**

```
Implementation complete. What would you like to do?

1. Merge back to $BASE_BRANCH locally
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
FEATURE_BRANCH="$NEW_BRANCH"
```

After the branch exists, proceed with the named-branch Step 5 logic for "Option 2: Push and Create PR" using `"$FEATURE_BRANCH"`.

### Step 5: Execute Choice

**Mapping for detached-HEAD mode (3-option menu):**

| Detached-HEAD option | Executes |
|---|---|
| 1. Push as new branch and create a PR | Create named branch first (see "Detached-HEAD branch naming" above), then run Option 2 below with `$NEW_BRANCH`. **Skip Option 1 (Merge Locally) entirely** — it does not apply. |
| 2. Keep as-is | Run Option 3 below. |
| 3. Discard this work | Run Option 4 case **4a** below. Branches by repo/worktree state: **(normal repo)** `cd "$MAIN_ROOT"` → `git checkout "$BASE_BRANCH"` → report "Discarded (dangling commits pending GC)"; **(provenance-owned)** `cd "$MAIN_ROOT"` → `git worktree remove --force "$FEATURE_WORKTREE_PATH"` → report "Discarded (dangling commits pending GC)"; no checkout. **(harness-owned)** attempt native exit tool — if it succeeds, report "Discarded via harness"; if unavailable/fails, report failure + manual command. **Truthfully report** state in either case; do NOT claim the work was deleted unless the corresponding action actually succeeded. |

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
if ! git checkout "$BASE_BRANCH"; then
  # Report: Failed to switch to $BASE_BRANCH. Resolve the issue and retry.
  exit 1
fi

if ! git pull --ff-only; then
  # Report: Failed to update $BASE_BRANCH from remote (conflict or
  # non-fast-forward). Run git pull manually, resolve, then retry.
  exit 1
fi

git merge "$FEATURE_BRANCH"

# Verify tests on merged result
<test command>

# Only after merge succeeds AND post-merge tests pass: cleanup worktree
# (Step 6 — uses the FEATURE_* values captured above), then delete branch
# (conditionally, see below).
```

Then: Cleanup worktree (Step 6), then delete branch — but **only after** the worktree has been removed (or, for harness-owned workspaces, only after native exit succeeds). If neither condition holds (the workspace is still in place and still has the branch checked out), `git branch -d` will fail; in that case skip branch deletion and report the situation.

```bash
# Run only after Step 6 has actually removed the worktree (provenance-owned
# path) OR after the harness's native exit tool has detached the workspace.
git branch -d "$FEATURE_BRANCH"
```

**Normal-repo path (no worktree, `FEATURE_GIT_DIR == FEATURE_GIT_COMMON`).** Step 6 reports "no worktree to clean up" and exits. The branch is currently NOT checked out (we already ran `git checkout "$BASE_BRANCH"` above), so the merge target is the current HEAD and `git branch -d "$FEATURE_BRANCH"` is safe to run unconditionally after the merged tests pass:

```bash
# Normal-repo only: branch is no longer checked out (we are on $BASE_BRANCH).
git branch -d "$FEATURE_BRANCH"
```

#### Option 2: Push and Create PR

**Decide how to generate the PR body first:**

```bash
COMMIT_COUNT=$(git rev-list --count "$BASE_BRANCH"..HEAD)
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
- `git log --oneline "$BASE_BRANCH"..HEAD` output (verbatim).
- `git diff --stat "$BASE_BRANCH"..HEAD` output (verbatim).
- Original feature goal (one sentence).
- Plan file path (if one exists).
- Template to fill: `## Summary` (3-5 bullets grouped by theme, not per-commit) + `## Test Plan` (checklist of what a reviewer should verify, not just "run tests").

Opus returns the filled body. Main thread does the push + `gh pr create`.

**Then push and create the PR:**

```bash
# Push branch
git push -u origin -- "$FEATURE_BRANCH"

# Create PR — paste the body produced above
gh pr create --head "$FEATURE_BRANCH" --base "$BASE_BRANCH" --title "<title>" --body "$(cat <<'EOF'
<body here>
EOF
)"
```

**Do NOT clean up worktree** — user needs it alive to iterate on PR feedback.

#### Option 3: Keep As-Is

If `FEATURE_BRANCH` is empty, report: "Keeping workspace in detached HEAD state at $(git rev-parse --short HEAD). No cleanup performed."

Otherwise, report: "Keeping branch <name>. Worktree preserved at <path>."

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

- **Detached HEAD, normal repo** (`FEATURE_GIT_DIR == FEATURE_GIT_COMMON`): no named branch exists and there is no separate worktree to remove. Tell the truth:
  ```
  Discard detached-HEAD state in this normal repo? This will:
  1. git checkout "$BASE_BRANCH"
  2. Leave detached-HEAD commits dangling until `git gc`
  Note: no branch is deleted because no branch exists.

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

**4a. Detached-HEAD discard (`FEATURE_BRANCH` is empty).** No branch was ever created, so there is nothing to delete. Do NOT attempt to `git checkout "$BASE_BRANCH"` inside the linked worktree — git refuses to check out a branch that is already checked out in the main worktree, so the checkout would fail and `|| true` would mask the failure into a false "switched off detached HEAD" report. Instead, abandon the detached state by leaving the workspace context entirely; the dangling commits become unreachable as soon as no worktree HEAD pins them:

```bash
# Step out of the feature workspace context. Do NOT attempt a checkout
# inside the linked worktree — it will fail if $BASE_BRANCH is checked
# out in the main repo, and there is no value in trying.
cd "$MAIN_ROOT"

# FEATURE_BRANCH is "" — skip git branch -D entirely (no branch exists).
```

Then branch on repo/worktree state and provenance — and report state-specifically. Do NOT claim discard succeeded for harness-owned workspaces unless the native exit tool was actually invoked AND succeeded:

- **Normal repo** (`FEATURE_GIT_DIR == FEATURE_GIT_COMMON`): no worktree exists and no branch was created. Switch back to the base branch; the detached commits become dangling unless another ref points to them.

  ```bash
  # CWD is already $MAIN_ROOT (set above). No worktree removal and no
  # branch deletion apply in a normal repo detached-HEAD discard.
  git checkout "$BASE_BRANCH"
  ```

  Then report success:

  ```
  Discarded (dangling commits pending GC). The detached-HEAD commits are
  no longer reachable from HEAD but remain in the repository until git's
  garbage collector runs. To force-discard them now:
      git reflog expire --expire=now --all && git gc --prune=now
  Workspace: normal repo; no worktree removal was needed.
  ```

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
if ! git worktree remove --force "$FEATURE_WORKTREE_PATH"; then
  # Report: Failed to remove worktree at $FEATURE_WORKTREE_PATH. Please
  # remove it manually, then run: git branch -D $FEATURE_BRANCH
  exit 1
fi

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
git checkout "$BASE_BRANCH"
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
   git worktree list --porcelain | grep -Fqx "worktree $FEATURE_WORKTREE_PATH"; then
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
| 4a. Discard — detached HEAD, normal repo | - | - | n/a (no worktree; checkout base) | n/a (no branch; commits dangle until GC) |
| 4a. Discard — detached HEAD, provenance-owned | - | - | no (inline `git worktree remove --force`, no checkout) | n/a (no branch; commits dangle until GC) |
| 4a. Discard — detached HEAD, harness-owned | - | - | no (via native exit; if unavailable/fails, report failure + manual command) | n/a (no branch; commits dangle until GC) |
| 4b. Discard — provenance-owned worktree | - | - | no (`worktree remove --force`) | yes (`-D`, after worktree removed) |
| 4c. Discard — harness-owned worktree | - | - | no (via native exit) | via native exit (not manual) |
| 4d. Discard — normal repo | - | - | n/a (no worktree) | yes (`-D`, after `checkout "$BASE_BRANCH"`) |

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
