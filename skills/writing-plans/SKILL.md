---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
disable-model-invocation: true
---

# Writing Plans

> **Manual-only pipeline skill (superpowers-strigov-ver).** It starts only from the user (`/dev`, `/superpowers-strigov-ver:<skill>`), from another skill of this plugin, or when resuming an in-progress plan — never on your own initiative. The Skill tool refuses it by design, so this plugin's pipeline skills are loaded with `Read`, never through the Skill tool. This file: `${CLAUDE_SKILL_DIR}/SKILL.md` (if the variable shows unexpanded, it is the path you just read). Another skill named below (`writing-plans`, `codex-invocation`, `zcode-invocation`, `dev-orchestrator`, …) is `../<name>/SKILL.md` relative to this skill's directory — `Read` it there. After a context compaction, re-`Read` this file before your next step.

## Overview

Write implementation plans that fix every decision and leave the typing to the implementer. Document what they need to build it without guessing: which files to touch in each phase, the contracts between parts, the behavior each step must produce, the test cases that prove it, the commands that check it, the docs worth reading. Decompose into 2–5 phases of bite-sized TDD steps. DRY. YAGNI. TDD. Frequent commits.

The implementer is a capable model that reads the repository itself and writes the code at implementation time. It has none of your research, so state what you found (exact paths, existing patterns to follow, the gotchas); it does not need the code written out for it. **The plan is not the code.** Implementation code in the plan doubles the work — it is written once here and again by the implementer — and makes the plan too long to review. Code belongs in the plan only where it *is* the decision (see "## Code in the plan").

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** This should be run in a dedicated worktree (created by brainstorming skill).

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
- (User preferences for plan location override this default)

## Model split

Same writer/reviewer pair as `dev-orchestrator` Steps 1–2: **Opus xhigh writes (Opus high revises), Codex Astra xhigh reviews** — writer and reviewer never share a model family.

**Main thread (orchestration only):** announces, gathers context, assembles the writer prompt from the guidance below, dispatches the Opus plan writer, runs the Codex review loop, commits, offers execution options. Never writes the plan directly.

**Opus subagent (effort `xhigh`)** writes the plan. Invocation per `../dev-orchestrator/opus-plan-writer-prompt.md`:

```
Agent(subagent_type="general-purpose", model="opus", effort="xhigh", prompt=<assembled prompt>)
```

**Routed writer.** The writer is the `plan-writer` role (Mode B revisions: `plan-reviser`). After `"$AD" route --all` printed `routes: default` (`../agent-invocation/SKILL.md` steps 1–2 — run it once, before the first writer dispatch) it is this Agent call as written, with no `route` call, and so it is when `$AD` does not run at all (say so once and keep the built-in scheme); otherwise `"$AD" route plan-writer` (`plan-reviser`) first: an `inproc` line → this Agent call at its `model` and `effort` (check 1 below compares those instead), any other → `../agent-invocation/SKILL.md` "In-session roles on an external profile" (check 1 keeps only its no-`ultrathink` part; the profile is the one the route line named).

**Effort is set on the dispatch — no `ultrathink` in the prompt.** Revisions (Mode B) run at `effort="high"`. There is no task id to record — every writer dispatch is fresh; the plan file on disk and the ledger are the continuity, so revisions re-read the plan instead of resuming a thread. The subagent has no session context; the prompt must be fully self-contained and include:

- The Mode A opening block from `../dev-orchestrator/opus-plan-writer-prompt.md` (research-the-repo / write-plan-file-only framing, no-git rule).
- User's original request verbatim.
- Spec file path if available (e.g. when called after brainstorming) — otherwise paste the relevant requirements directly into the prompt.
- Repo root (absolute path), language/framework, any constraints you know.
- Target plan path: `docs/plans/YYYY-MM-DD-<slug>.md` (unless user specified a custom location).
- **All the guidance in this skill below (Scope Check through Self-Review)** — these sections define HOW the writer must build the plan. Paste them into the prompt; don't just reference this skill.
- Instruction to run the Self-Review inline after writing, fixing issues in place (no separate round trip).

**Pre-dispatch verification — run on the assembled prompt before dispatching:**

1. `model="opus"`, `effort="xhigh"` (Mode B revisions: `effort="high"`), and no `ultrathink` in the prompt.
2. Every bullet above is physically present in the prompt. In particular the FULL TEXT of these sections must be pasted in: Scope Check, File Structure, Bite-Sized Step Granularity, Plan Document Header, Required body sections, Phase Structure, Risk Tags, Code in the plan, No Placeholders, Remember, Self-Review. Litmus test: if the prompt does not contain the fenced YAML frontmatter template, the `## Ф1:` example layout, and the `<!-- risk-tag checklist` block, you referenced instead of pasted — go back and paste.
3. No unfilled `<placeholder>` tokens remain (scan the prompt for `<`).
4. All paths absolute.

**After the writer returns — mechanical frontmatter validation (main thread):**

Read the plan file's first 30 lines and check: file starts with `---`; frontmatter has `slug`, `created`, `status: in-progress`, and a `phases:` list; first phase `status: in-progress`, all others `status: pending`; every `phases[].id` matches a `## <id>:` H2 in the body (check via `grep -n '^## Ф' <plan-file>`); if any `parallel_group` is present, each group id appears on exactly 2 phases; `risk_phases` is present as one top-level line directly after the top-level `status:` line, its keys are exactly the `phases[].id`s, and every value lists only `SECURITY` / `DATA_LOSS` or is empty (`[]`); there is no `risk_checked:` line (orchestrator-only — delete it mechanically if the writer wrote one). If a check fails: frontmatter-only defects you may fix mechanically yourself; body defects → dispatch a fresh Opus writer at effort `high` (Mode B shape: plan path + the specific defect as the authorized change). A missing key, a missing or extra phase id, or a value outside `SECURITY` / `DATA_LOSS` in `risk_phases` counts as a body defect: choosing a risk tag is judgment — never write or guess one yourself (only a misplaced but otherwise valid line may be moved mechanically). Do not send a malformed plan to review.

This skill produces plans in the YAML-frontmatter + phases format consumed natively by `dev-orchestrator`. The TDD discipline (failing test → minimal impl → passing test → commit) lives **inside** each phase as the step pattern — phases are the orchestration unit, TDD steps are the work pattern. The canonical format definition lives in `../dev-orchestrator/opus-plan-writer-prompt.md` Mode A — keep this skill's format guidance below in sync with it.

**Codex Astra xhigh** reviews the plan after the Opus writer produces it — precisely, the profile of the `plan-reviewer` role (`"$AD" route plan-reviewer`, per `../agent-invocation/SKILL.md`); by default Astra, the same command. Reuse `../dev-orchestrator/codex-plan-reviewer-prompt.md` verbatim (built-in `--model gpt-6-astra --effort xhigh`, no `--write`, fresh task each round; adapt the opening line to name this skill instead of dev-orchestrator). A route line with `readOnly=none` puts the job inside `../agent-invocation/SKILL.md` "No-edit check". The review stages, finding classes, and output format apply unchanged. Loop cap=4.

Verdict handling (identical to dev-orchestrator Step 2):

- `APPROVED` → commit the plan file separately (`docs(plans): add <slug>`, stage only the plan file, Co-Authored-By trailer). Then proceed to Execution Handoff.
- `CHANGES_REQUESTED` → run the ledger sequence from `../dev-orchestrator/SKILL.md` Step 2, in order: (a) triage the BLOCKING list, (b) write/update the ledger (see "Authorized Change Ledger" below), (c) dispatch a fresh Opus writer at effort `high` (Mode B from `../dev-orchestrator/opus-plan-writer-prompt.md`) with the plan file path, the ledger path, and the open ACCEPTED / PARTIALLY_ACCEPTED items inline — revise in place, not rewrite, (d) after the writer returns, dispatch a FRESH Codex Astra xhigh reviewer with the follow-up template. Never dispatch the writer on the raw BLOCKING list before the ledger exists. Increment counter.
- Round 4 without APPROVED → escalate to user: plan path + last blocking list + one-sentence disagreement summary. User picks: accept / another round / close.

Anti-pingpong: if the reviewer repeats a blocking point that was explicitly rejected with reasoning in a prior round, mark `resolved-by-decision`, do not loop on it — except a finding that asks to add a missing risk tag (`risk_phases`), which is never filtered: an extra tag is always safe, so it goes to the writer as ACCEPTED. No-progress: if two consecutive rounds produce an identical blocking list, escalate immediately.

**New-blocker churn detector.** Escalate immediately, even before cap=4, when all prior blockers are closed (per the ledger) and the reviewer returns only NEW `MUST_FIX_NOW` items that don't cite DATA_LOSS / SECURITY / GUARANTEED_FAIL materiality. `REGRESSION_FROM_AUTHORIZED_FIX` items don't count as "new" — they are causally tied to a prior accepted fix. Canonical wording lives in `../dev-orchestrator/SKILL.md` Step 2 verdict-handling; mirror it from there rather than restating.

**Authorized Change Ledger.** For each `CHANGES_REQUESTED` round, the orchestrator constructs the same `docs/plans/<slug>.ledger.json` artifact described in `../dev-orchestrator/SKILL.md` (see "## Authorized Change Ledger" there for shape, lifecycle, and the reviewer-side materiality vocabulary — `MUST_FIX_NOW`, `REGRESSION_FROM_AUTHORIZED_FIX`, `DEFER`, `NIT`, `REJECTED_BY_SCOPE` — alongside the orchestrator-side label `AUTHORIZED_CHANGE_LEDGER`). Pass the ledger path to the Opus writer on every revision dispatch and to the fresh Codex reviewer each round. The ledger is transient orchestrator state — never staged, never committed — but it is NOT deleted when this skill's review loop ends: it survives `APPROVED` and is handed to `dev-orchestrator`, whose Step 4 and Step 5 loops share the same file; only plan archival (Step 5 `REVIEW_OK`) or abandonment deletes it (see "Where it lives" under "## Authorized Change Ledger" in `../dev-orchestrator/SKILL.md`). The same vocabulary applies to plan-review rounds run from this skill.

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

Note: when the plan is executed via `dev-orchestrator`, the final "Commit" step is performed by the orchestrator's auto-commit, not by the implementer (GLM-5.3-Flash via `zcode-dispatch` by default; Codex Luna as the availability fallback and Codex Sol for risk-tagged phases; the Claude frontend implementer for frontend phases) — the implementer prompt tells it to skip that step and leave the working tree uncommitted for review. Keep the step in the plan anyway: it documents intent and serves direct human execution.

## Plan Document Header

**Every plan MUST start with YAML frontmatter followed by a markdown title:**

````markdown
---
slug: <short-kebab-slug>
created: YYYY-MM-DD
status: in-progress          # in-progress | done | abandoned
risk_phases: { Ф1: [], Ф2: [], Ф3: [] }   # one key per phases[] id — see "Risk Tags"
phases:
  - id: Ф1
    scope: "<one-line scope>"
    status: in-progress       # pending | in-progress | done
  - id: Ф2
    scope: "..."
    status: pending
    parallel_group: G1        # optional — see "Parallel groups" in decomposition rules
  - id: Ф3
    scope: "..."
    status: pending
    parallel_group: G1
---

# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: implement this plan phase-by-phase with the `dev-orchestrator` skill of the superpowers-strigov-ver plugin (`/dev`; manual-only — `Read` its SKILL.md, the Skill tool refuses it). Steps inside each phase use checkbox (`- [ ]`) syntax for tracking.

---
````

After the `---` separator the body begins, starting with `## Goal` and following the H2 sequence below. Do NOT add `**Goal:**` / `**Architecture:**` / `**Tech Stack:**` bold lines before the H2 sections — those are upstream mini-header conventions and would duplicate `## Goal`.

The first phase MUST start at `status: in-progress`; all others at `status: pending`. The top-level `status: in-progress` until the last phase flips to `done`. These fields are what `dev-orchestrator` reads during resume-check and auto-commit — keep them well-formed. On phase completion the orchestrator appends a `commits:` range field (`"<base7>.."` on the sequential path, `"<base7>..<head7>"` for parallel groups) to that phase's `phases[]` entry — a runtime field written by the orchestrator, never by the plan author; do not emit it when writing the plan. `risk_phases` is the opposite: the plan author writes it (see "## Risk Tags"), and `dev-orchestrator` routes every phase by it. The `risk_checked: true` line the orchestrator later adds after it is again orchestrator-only — never emit it.

## Required body sections

After the YAML frontmatter and the `# [Feature Name] Implementation Plan` title, every plan MUST contain these H2 sections, in order:

1. `## Goal` — what this enables and why now. Two short paragraphs max.
1a. `## Acceptance criteria` — 3–7 externally observable criteria that define "done" for the whole plan. Reviewers may block ONLY on these criteria, stated user requirements, repo constraints, or high-materiality risks (`DATA_LOSS`, `SECURITY`, `GUARANTEED_FAIL`, `REGRESSION`, `ACCEPTANCE_CRITERIA`).
1b. `## Non-goals / deferred` — explicit exclusions. Reviewers MUST classify requests for these as `REJECTED_BY_SCOPE` or `DEFER` unless the orchestrator authorizes scope expansion.
1c. `## Global Constraints` — the spec's project-wide requirements — version floors, dependency limits, naming and copy rules, platform requirements — one line each, with exact values copied verbatim from the spec or user request. Every phase's requirements implicitly include this section. If the spec imposes none, write literally `None declared in the spec.` Do NOT merge into `## Contracts`: Contracts define interfaces between phases; Global Constraints are external requirements binding the whole plan.
2. `## Files` — paths to create/modify, grouped by phase. Each file: one-line responsibility (see "## File Structure" guidance above).
3. `## Contracts` — function signatures, data shapes, API surface. Exact enough that the implementer can build without guessing.
4. `## Test strategy` — what proves correctness, per phase. Test types (unit/integration/e2e), key cases, what NOT to test.
5. `## Risks / unknowns / assumptions` — named explicitly. Anything you are guessing at. It opens with the risk-tag lines (see "## Risk Tags" below).
6. `## Phases` — per phase an H2 `## Ф1: <title>`, `## Ф2: <title>`, ... with the detailed TDD steps inside each (see "## Phase Structure" below).

This mirrors `dev-orchestrator/opus-plan-writer-prompt.md` Mode A — the two files are the joint authority for the format. Keep them aligned when either changes.

Self-Review (see below) is a check the plan writer runs in-process while writing — it is NOT a section in the committed plan file.

## Phase Structure

### Phase decomposition rules

- Each phase must be independently commit-able and produce a working system (no "Ф1 breaks build, Ф2 fixes it").
- Each phase should be shippable in one implementer run (roughly a few files, a few hours of work).
- **Right-sizing (lower bound)**: a phase is the smallest unit that carries its own test cycle and is worth a fresh reviewer's gate. When drawing phase boundaries: fold setup, configuration, scaffolding, and documentation steps into the phase whose deliverable needs them; split only where a reviewer could meaningfully reject one phase while approving its neighbor. Each phase ends with an independently testable deliverable.
- Prefer 2–5 phases. More than 5 is a signal to split into multiple plans.
- Put risky / blocking decisions as early as possible so later phases can assume they're settled.
- **Backend / frontend split (required for full-stack work)**: if a candidate phase would touch BOTH backend (.py, .rs, .go, .java, server-side .ts/.js, SQL, protobuf, etc.) AND frontend (.tsx, .jsx, .vue, .svelte, .css, .scss), split it into two phases — one BE, one FE — with an explicit contract between them. Reason: `dev-orchestrator` routes BE phases to the backend implementer (GLM via ZCode by default, Codex Sol for risk-tagged phases) and FE phases to a Claude subagent; mixed phases cannot be dispatched cleanly.
- **Parallel groups (optional)**: mark exactly two phases with the same `parallel_group: G<n>` in the frontmatter `phases[]` ONLY when ALL of: (a) their file sets are fully disjoint; (b) neither depends on the other's *implementation* — only on contracts frozen in `## Contracts` (a BE+FE pair with an explicit contract is the canonical case); (c) each phase still commits independently. The orchestrator builds a marked group concurrently in separate git worktrees and merges afterwards — overlapping files or an implementation dependency guarantee a failed merge. When in doubt, do NOT mark: sequential is always correct.

### Per-phase layout

Each phase is an H2 (`## Ф1: <title>`) inside the `## Phases` section. Every phase opens with a `**Files in this phase:**` list followed by an `**Interfaces:**` block. The `**Interfaces:**` block is mandatory in EVERY phase — an empty side is written explicitly as `nothing`, never omitted. It matters most for `parallel_group` phases (built concurrently — neighbors' code is invisible until merge) and for BE/FE pairs building to one contract, and it gives reviewers a mechanical cross-phase consistency check. Inside the phase, list bite-sized TDD steps as checkboxes. A phase may contain multiple `test → impl → pass` cycles before its final commit, but it must still ship in one implementer run.

````markdown
## Ф1: [Phase Name]

**Files in this phase:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: [what this phase uses from earlier phases — exact signatures. If nothing, write literally `nothing`]
- Produces: [what later phases rely on — exact function names, parameter and return types. If nothing, write literally `nothing`]

- [ ] **Step 1: Write the failing tests** in `tests/path/test.py`:
  - `test_parses_empty_input` — `parse("")` returns `[]`;
  - `test_rejects_unclosed_quote` — `parse('a "b')` raises `ParseError` whose message contains `unclosed quote at 2`;
  - follow the fixture style of `tests/path/test_other.py` (`tmp_path`, no mocks of the filesystem).

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py -v`
Expected: FAIL — `parse` is not defined

- [ ] **Step 3: Implement `parse(text: str) -> list[Token]`** in `src/path/file.py` per `## Contracts`. Reuse `Tokenizer` from `src/path/lexer.py:40` instead of a new scanner; the column in the error is 1-based.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit the phase**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: <phase scope summary>"
```
````

## Risk Tags

`dev-orchestrator` picks each backend phase's implementer from the frontmatter `risk_phases` map, never from prose: a phase with a non-empty value runs on Codex Sol inside the Codex sandbox; a phase with `[]` normally runs on GLM, which is **not sandboxed** (it can touch any file of the user and reach the network). A tag also raises the code reviewer's effort for that phase. Follow these rules mechanically:

<!-- risk-tag rules — keep byte-identical in dev-orchestrator/opus-plan-writer-prompt.md and writing-plans/SKILL.md (tests/test-pipeline-context.sh compares them) -->
1. Write `risk_phases` as ONE line directly after the top-level `status:` line — one key per `phases[]` id, in the same order, no other keys: `risk_phases: { Ф1: [], Ф2: [DATA_LOSS], Ф3: [SECURITY, DATA_LOSS] }`.
2. A value is exactly one of `[]`, `[SECURITY]`, `[DATA_LOSS]`, `[SECURITY, DATA_LOSS]` — upper case, nothing else. `[]` means "checked, no risk"; it is never a default you skip checking.
3. Tag every phase, frontend phases included: walk each of its steps through the checklist below; a step that matches adds that kind.
4. For each tag, `## Risks / unknowns / assumptions` opens with one line `- <id> — <KIND>: <the matching step and why>`, e.g. `- Ф2 — DATA_LOSS: Step 3 rewrites stored config files in place.` No phase tagged → the section's first line is literally `- Risk tags: none.` Never name `SECURITY` or `DATA_LOSS` for a phase anywhere in the plan without the tag in the map.
5. Before returning, check: the map's keys equal the `phases[]` ids; each tag has exactly one risk-tag line and each risk-tag line has its tag.
6. Never write a `risk_checked:` line — the orchestrator adds it after its own check.
<!-- /risk-tag rules -->

This mirrors `../dev-orchestrator/opus-plan-writer-prompt.md` Mode A "Risk tags"; the Codex plan reviewer checks the map against the same checklist (`../dev-orchestrator/codex-plan-reviewer-prompt.md`). Keep the three checklist copies byte-identical.

<!-- risk-tag checklist — keep byte-identical in dev-orchestrator/opus-plan-writer-prompt.md, writing-plans/SKILL.md, dev-orchestrator/codex-plan-reviewer-prompt.md (tests/test-pipeline-context.sh compares them) -->
**SECURITY** — the phase has a step that:
- adds or changes authentication, authorization, sessions, tokens, or a permission check;
- reads, stores, logs, or sends secrets, credentials, API keys, or tokens;
- adds or changes cryptography, signing, or randomness used for security;
- builds a shell command, SQL query, file path, URL, HTML/template, or deserialized object from input the code does not control;
- adds or changes a listening endpoint, CORS / CSP / TLS settings, or an outbound call that carries credentials;
- changes a sandbox, file permissions, process isolation, or the environment passed to a child process.

**DATA_LOSS** — the phase has a step that:
- deletes, overwrites, truncates, or moves persisted data (user or project files, database rows, stored state);
- adds or changes a schema or data migration, or a stored format that existing data must still load from;
- runs, or ships code that runs, a destructive filesystem or git operation (`rm -rf`, `git reset --hard`, `git clean`, force-push, branch deletion);
- changes backup, retention, cleanup, or garbage-collection logic;
- changes how writes reach storage (atomic rename, locking, transactions, write order) so that a crash or a concurrent write could lose data.

Steps that touch only documentation, or only test code working inside a temporary directory the test itself creates, do not match. Unsure whether a step matches → tag it: an extra tag only moves the phase to the slower sandboxed implementer; a missing tag runs a risky phase unsandboxed.
<!-- /risk-tag checklist -->

## Code in the plan

The plan fixes decisions; the implementer writes the code. A step says **what** to build and **how to know it is right**, not the lines that build it.

Write as code (short fenced blocks or inline) only what is itself the decision — the implementer could not guess it, and getting it different would be a bug:
- signatures, data shapes, schemas, config keys, CLI flags, API request/response formats — normally once, in `## Contracts`;
- exact strings the outside world sees or matches: error messages, log lines, file formats, regexes;
- a tricky fragment where correctness hinges on exact form (an ordering, an escaping rule, a race-sensitive sequence) — at most ~15 lines, with one line on why it must be exactly this.

Do NOT write:
- function or method bodies, whole files, or the full text of a test;
- boilerplate the implementer derives from the repo (imports, wiring, fixtures, registration);
- the same code twice — once in `## Contracts`, and the steps reference it by name.

Tests are specified as cases: test name, input or setup, expected outcome — enough that two implementers would write equivalent tests.

## No Placeholders

Every step must contain the actual decisions an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases" — name which errors, which validation, which cases, and what happens in each
- "Write tests for the above" — without the list of cases (name, input, expected outcome)
- "Similar to Ф N" / "Same as earlier phase" — restate the specifics (names, cases, paths); the implementer may dispatch phases out of order
- References to types, functions, or methods not defined in any earlier phase or in `## Contracts`, and not present in the repository

A step without a code block is not a placeholder. A step whose behavior, interface, or test cases are left vague is.

## Remember
- Exact file paths always
- Decisions, not code — behavior, contracts, and test cases; code only where it is the decision (see "## Code in the plan")
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## Self-Review

The plan writer runs this self-review inline while writing the plan — include these instructions in the writer prompt. This is a checklist the writer runs itself — not a separate dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a phase (and a step inside it) that implements it? List any gaps.

**2. Placeholder and code scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them. Then scan for implementation code: a fenced block with a function body, a whole file or a full test → replace it with the behavior, the contract reference, or the list of test cases (see "## Code in the plan").

**3. Type consistency:** Do the types, method signatures, and property names you used in later phases match what you defined in earlier phases? A function called `clearLayers()` in Ф1 but `clearFullLayers()` in Ф3 is a bug. Mechanical check: every `Consumes:` line in a phase's `**Interfaces:**` block MUST string-match a `Produces:` line of an earlier phase or a line in `## Contracts`. A `Consumes:` entry that matches neither is a plan bug — fix the name/signature mismatch; do not delete the line. Exception: lines reading literally `Consumes: nothing` / `Produces: nothing` are the explicit empty marker — exempt from this check, not a bug.

**4. Acceptance-criteria coverage:** does every phase produce something observable in the `## Acceptance criteria` list? Are `## Non-goals / deferred` entries explicit enough that a reviewer would classify a scope-expansion request as `REJECTED_BY_SCOPE`?

**5. Frontmatter sanity:** YAML frontmatter present and well-formed? `phases[]` ids match the `## ФN:` H2 titles in the body? First phase `status: in-progress`, all others `status: pending`, top-level `status: in-progress`?

**6. Risk tags:** walk every phase's steps through the "## Risk Tags" checklist once more. `risk_phases` sits directly after the top-level `status:` line, its keys equal the `phases[]` ids, every value is `[]`, `[SECURITY]`, `[DATA_LOSS]` or `[SECURITY, DATA_LOSS]`, and every tag has its `- <id> — <KIND>: …` line at the top of `## Risks / unknowns / assumptions` (or the line `- Risk tags: none.`). A step you are unsure about gets the tag.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no phase, add the phase (and update the frontmatter `phases[]` list to match).

## Execution Handoff

After the Codex review returns APPROVED and the plan is committed, hand off to the implementer:

**"Plan complete (written by Opus xhigh, reviewed by Astra xhigh), saved to `docs/plans/<filename>.md`. Ready to execute via `dev-orchestrator` — one phase at a time, with auto-commit per phase and fused Opus + Codex review on each diff. Start now?"**

- **REQUIRED SUB-SKILL:** `Read` `../dev-orchestrator/SKILL.md` and follow it (manual-only — never through the Skill tool; it reads the YAML frontmatter, picks up the first `status: in-progress` phase, and dispatches the implementer).

**No inline-execution fallback for phased plans.** `executing-plans` is reserved for legacy flat `Task 1..N` plans without YAML frontmatter — period. Phased plans produced by this skill MUST go through `dev-orchestrator`; there is no supported inline path, because per-phase auto-commit, route-by-phase (BE/FE), and resume-check have no equivalent in `executing-plans` and running a phased plan through it would silently drop those guarantees. If the user lacks subagent support, the answer is to upgrade the environment or write a flat plan in upstream `superpowers`, not to coerce `executing-plans` into running a phased one.
