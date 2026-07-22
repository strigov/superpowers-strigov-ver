#!/usr/bin/env bash
# Tests for the fork's SDD workspace scripts: bin/sdd-workspace resolves a
# self-ignoring (optionally plan-scoped) working-tree directory, and
# bin/review-package writes review packages in range and WORKTREE modes,
# always excluding .superpowers/ from the diff.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$REPO_ROOT/bin"

FAILURES=0
TEST_ROOT=""

pass() { echo "  [PASS] $1"; }
fail() {
    echo "  [FAIL] $1"
    FAILURES=$((FAILURES + 1))
}

cleanup() {
    if [[ -n "$TEST_ROOT" && -d "$TEST_ROOT" ]]; then
        rm -rf "$TEST_ROOT"
    fi
}

main() {
    echo "=== Test: sdd-workspace + review-package ==="

    TEST_ROOT="$(mktemp -d)"
    trap cleanup EXIT

    # Resolve repo to its physical path so string comparisons match the
    # helper's output (git rev-parse --show-toplevel resolves symlinks; on
    # macOS mktemp lives under /var -> /private/var).
    git init -q -b main "$TEST_ROOT/repo"
    local repo
    repo="$(cd "$TEST_ROOT/repo" && git rev-parse --show-toplevel)"

    local git_id=(-c user.email=t@example.com -c user.name=t -c commit.gpgsign=false)
    printf 'line1\n' > "$repo/src.txt"
    ( cd "$repo" && git add src.txt && git "${git_id[@]}" commit -qm c0 )

    # --- sdd-workspace, no argument: shared root ---
    local dir
    dir="$(cd "$repo" && "$BIN/sdd-workspace")"

    if [[ "$dir" == "$repo/.superpowers/sdd" ]]; then
        pass "no-arg sdd-workspace prints <repo-root>/.superpowers/sdd"
    else
        fail "no-arg sdd-workspace prints <repo-root>/.superpowers/sdd"
        echo "    got: $dir"
    fi

    if [[ -f "$repo/.superpowers/sdd/.gitignore" && "$(cat "$repo/.superpowers/sdd/.gitignore")" == "*" ]]; then
        pass "self-ignoring .gitignore created at .superpowers/sdd/ with '*'"
    else
        fail "self-ignoring .gitignore created at .superpowers/sdd/ with '*'"
    fi

    printf 'x\n' > "$repo/.superpowers/sdd/artifact.md"
    local status
    status="$(cd "$repo" && git status --porcelain)"
    if [[ -z "$status" ]]; then
        pass "workspace invisible to git status"
    else
        fail "workspace invisible to git status"
        echo "    status: $status"
    fi

    ( cd "$repo" && git add -A )
    local staged
    staged="$(cd "$repo" && git diff --cached --name-only)"
    if [[ -z "$staged" ]]; then
        pass "git add -A does not stage the workspace"
    else
        fail "git add -A does not stage the workspace"
        echo "    staged: $staged"
    fi

    local rc=0
    (cd "$repo" && "$BIN/sdd-workspace" a.md b.md >/dev/null 2>&1) || rc=$?
    if [[ "$rc" -eq 2 ]]; then
        pass "sdd-workspace with two arguments errors with exit 2"
    else
        fail "sdd-workspace with two arguments errors with exit 2"
        echo "    exit: $rc"
    fi

    # --- plan scoping: two plans resolve to isolated subdirectories ---
    cat > "$repo/plan-a.md" <<'PLAN'
# Plan A

## Phase 1: First thing

Do the first thing.
PLAN
    cat > "$repo/plan-b.md" <<'PLAN'
# Plan B

## Phase 1: Other thing

Do the other thing.
PLAN
    ( cd "$repo" && git add plan-a.md plan-b.md && git "${git_id[@]}" commit -qm plans )

    local dir_a dir_b
    dir_a="$(cd "$repo" && "$BIN/sdd-workspace" plan-a.md)"
    dir_b="$(cd "$repo" && "$BIN/sdd-workspace" plan-b.md)"

    if [[ "$dir_a" == "$repo/.superpowers/sdd/plan-a" ]]; then
        pass "plan-scoped call prints <repo-root>/.superpowers/sdd/<plan-basename>"
    else
        fail "plan-scoped call prints <repo-root>/.superpowers/sdd/<plan-basename>"
        echo "    got: $dir_a"
    fi

    if [[ "$dir_a" != "$dir_b" && -d "$dir_a" && -d "$dir_b" ]]; then
        pass "two plans resolve to two distinct directories"
    else
        fail "two plans resolve to two distinct directories"
        echo "    a: $dir_a"
        echo "    b: $dir_b"
    fi

    printf 'x\n' > "$dir_a/artifact.md"
    status="$(cd "$repo" && git status --porcelain)"
    if [[ "$status" != *".superpowers"* ]]; then
        pass "plan-scoped workspace invisible to git status"
    else
        fail "plan-scoped workspace invisible to git status"
        echo "    status: $status"
    fi

    rc=0
    (cd "$repo" && "$BIN/sdd-workspace" no-such-plan.md >/dev/null 2>&1) || rc=$?
    if [[ "$rc" -eq 2 ]]; then
        pass "sdd-workspace with a missing plan file errors with exit 2"
    else
        fail "sdd-workspace with a missing plan file errors with exit 2"
        echo "    exit: $rc"
    fi

    # --- review-package, range mode ---
    ( cd "$repo" \
        && printf 'line2\n' >> src.txt && git add src.txt \
        && git "${git_id[@]}" commit -qm c1 )
    local rp_out rp_path
    rp_out="$(cd "$repo" && "$BIN/review-package" HEAD~1 HEAD)"
    rp_path="$(printf '%s\n' "$rp_out" | sed -n 's/^wrote \(.*\): [0-9].*$/\1/p')"
    case "$rp_path" in
        "$repo/.superpowers/sdd/review-"*.diff)
            pass "range mode: default OUTFILE lands under the workspace, named per range" ;;
        *)
            fail "range mode: default OUTFILE lands under the workspace, named per range"
            echo "    got: $rp_path"
            ;;
    esac

    if [[ -f "$rp_path" ]] \
        && grep -q '^## Commits$' "$rp_path" \
        && grep -q '^## Files changed$' "$rp_path" \
        && grep -q '^## Diff$' "$rp_path" \
        && grep -q ' c1$' "$rp_path" \
        && grep -q '^+line2$' "$rp_path"; then
        pass "range mode: package has Commits/Files changed/Diff sections with the change"
    else
        fail "range mode: package has Commits/Files changed/Diff sections with the change"
    fi

    if [[ "$rp_out" =~ ^wrote\ .*:\ 1\ commit\(s\),\ [0-9]+\ bytes$ ]]; then
        pass "range mode: stdout is one 'wrote <path>: N commit(s), M bytes' line"
    else
        fail "range mode: stdout is one 'wrote <path>: N commit(s), M bytes' line"
        echo "    got: $rp_out"
    fi

    local rp_explicit
    rp_explicit="$(cd "$repo" && "$BIN/review-package" HEAD~1 HEAD "$TEST_ROOT/explicit.diff")"
    if [[ -s "$TEST_ROOT/explicit.diff" && "$rp_explicit" == *"$TEST_ROOT/explicit.diff"* ]]; then
        pass "range mode: honors an explicit OUTFILE"
    else
        fail "range mode: honors an explicit OUTFILE"
        echo "    got: $rp_explicit"
    fi

    rc=0
    (cd "$repo" && "$BIN/review-package" no-such-ref HEAD >/dev/null 2>&1) || rc=$?
    if [[ "$rc" -eq 2 ]]; then
        pass "bad BASE errors with exit 2"
    else
        fail "bad BASE errors with exit 2"
        echo "    exit: $rc"
    fi

    rc=0
    (cd "$repo" && "$BIN/review-package" HEAD~1 >/dev/null 2>&1) || rc=$?
    if [[ "$rc" -eq 2 ]]; then
        pass "too few arguments errors with exit 2"
    else
        fail "too few arguments errors with exit 2"
        echo "    exit: $rc"
    fi

    rc=0
    (cd "$repo" && "$BIN/review-package" HEAD~1 HEAD a b >/dev/null 2>&1) || rc=$?
    if [[ "$rc" -eq 2 ]]; then
        pass "too many arguments errors with exit 2"
    else
        fail "too many arguments errors with exit 2"
        echo "    exit: $rc"
    fi

    # --- review-package, WORKTREE mode ---
    printf 'uncommitted\n' >> "$repo/src.txt"
    local wt_pkg="$dir_a/review-phase-1-r1.diff"
    local wt_out
    wt_out="$(cd "$repo" && "$BIN/review-package" HEAD WORKTREE "$wt_pkg")"
    if [[ -s "$wt_pkg" ]] && grep -q '^+uncommitted$' "$wt_pkg"; then
        pass "WORKTREE mode: uncommitted change appears in ## Diff"
    else
        fail "WORKTREE mode: uncommitted change appears in ## Diff"
    fi

    if grep -q '^plus uncommitted working-tree changes$' "$wt_pkg"; then
        pass "WORKTREE mode: Commits section notes uncommitted working-tree changes"
    else
        fail "WORKTREE mode: Commits section notes uncommitted working-tree changes"
    fi

    if [[ "$wt_out" =~ ^wrote\ .*:\ 0\ commit\(s\),\ [0-9]+\ bytes$ ]]; then
        pass "WORKTREE mode: stdout reports 0 commit(s) for an uncommitted-only change"
    else
        fail "WORKTREE mode: stdout reports 0 commit(s) for an uncommitted-only change"
        echo "    got: $wt_out"
    fi

    rc=0
    (cd "$repo" && "$BIN/review-package" HEAD WORKTREE >/dev/null 2>&1) || rc=$?
    if [[ "$rc" -eq 2 ]]; then
        pass "WORKTREE mode without OUTFILE errors with exit 2"
    else
        fail "WORKTREE mode without OUTFILE errors with exit 2"
        echo "    exit: $rc"
    fi

    # --- WORKTREE mode: untracked (new) files must appear in the package.
    # Implementers do not commit or stage, so every file a phase CREATES is
    # untracked at review time — the package must still show it.
    printf 'brand new module\n' > "$repo/newmodule.txt"
    local unt_pkg="$dir_a/review-phase-1-r3.diff"
    ( cd "$repo" && "$BIN/review-package" HEAD WORKTREE "$unt_pkg" >/dev/null )
    if grep -q '^+brand new module$' "$unt_pkg" \
        && grep -q 'newmodule\.txt' "$unt_pkg"; then
        pass "WORKTREE mode: untracked new file appears in ## Diff"
    else
        fail "WORKTREE mode: untracked new file appears in ## Diff"
    fi

    status="$(cd "$repo" && git status --porcelain -- newmodule.txt)"
    if [[ "$status" == "?? newmodule.txt" ]]; then
        pass "WORKTREE mode: real index untouched (new file stays untracked)"
    else
        fail "WORKTREE mode: real index untouched (new file stays untracked)"
        echo "    status: $status"
    fi
    rm "$repo/newmodule.txt"

    # --- OUTFILE with a missing parent directory must not fake success ---
    local deep_pkg="$TEST_ROOT/no/such/dir/deep.diff"
    local deep_out
    rc=0
    deep_out="$(cd "$repo" && "$BIN/review-package" HEAD WORKTREE "$deep_pkg" 2>/dev/null)" || rc=$?
    if [[ "$rc" -eq 0 && -s "$deep_pkg" \
        && "$deep_out" =~ ^wrote\ .*:\ 0\ commit\(s\),\ [0-9]+\ bytes$ ]]; then
        pass "missing OUTFILE parent is created; 'wrote' line names a real file"
    else
        fail "missing OUTFILE parent is created; 'wrote' line names a real file"
        echo "    exit: $rc"
        echo "    got: $deep_out"
    fi

    # --- .superpowers excluded from the diff (both modes) ---
    # Force-track a file inside the workspace, commit it, then modify it: the
    # working-tree diff against BASE must show src.txt but never the
    # workspace file.
    printf 'v1\n' > "$repo/.superpowers/sdd/tracked.txt"
    ( cd "$repo" && git add -f .superpowers/sdd/tracked.txt \
        && git "${git_id[@]}" commit -qm sp1 )
    printf 'v2\n' > "$repo/.superpowers/sdd/tracked.txt"
    local excl_pkg="$dir_a/review-phase-1-r2.diff"
    ( cd "$repo" && "$BIN/review-package" HEAD WORKTREE "$excl_pkg" >/dev/null )
    if grep -q '^+uncommitted$' "$excl_pkg" && ! grep -q 'superpowers' "$excl_pkg"; then
        pass "WORKTREE mode: .superpowers excluded from the diff"
    else
        fail "WORKTREE mode: .superpowers excluded from the diff"
    fi

    ( cd "$repo" && git add src.txt && git add -f .superpowers/sdd/tracked.txt \
        && git "${git_id[@]}" commit -qm c2 )
    local range_pkg="$TEST_ROOT/range-excl.diff"
    ( cd "$repo" && "$BIN/review-package" HEAD~1 HEAD "$range_pkg" >/dev/null )
    if grep -q '^+uncommitted$' "$range_pkg" && ! grep -q 'tracked\.txt' "$range_pkg"; then
        pass "range mode: .superpowers excluded from the diff"
    else
        fail "range mode: .superpowers excluded from the diff"
    fi

    # --- Worktree isolation: a linked worktree resolves its own workspace ---
    local wt="$TEST_ROOT/wt"
    ( cd "$repo" && git worktree add -q "$wt" -b wt-feature )
    local wt_root wt_dir
    wt_root="$(cd "$wt" && git rev-parse --show-toplevel)"
    wt_dir="$(cd "$wt" && "$BIN/sdd-workspace" plan-a.md)"
    if [[ "$wt_dir" == "$wt_root/.superpowers/sdd/plan-a" && "$wt_dir" != "$dir_a" ]]; then
        pass "linked worktree resolves its own distinct workspace"
    else
        fail "linked worktree resolves its own distinct workspace"
        echo "    main: $dir_a"
        echo "    wt:   $wt_dir"
    fi

    printf 'y\n' > "$wt_dir/artifact.md"
    local wt_status
    wt_status="$(cd "$wt" && git status --porcelain)"
    if [[ "$wt_status" != *".superpowers"* ]]; then
        pass "worktree workspace invisible to git status"
    else
        fail "worktree workspace invisible to git status"
        echo "    status: $wt_status"
    fi

    echo ""
    if [[ "$FAILURES" -ne 0 ]]; then
        echo "FAILED: $FAILURES assertion(s)."
        exit 1
    fi
    echo "PASS"
}

main "$@"
