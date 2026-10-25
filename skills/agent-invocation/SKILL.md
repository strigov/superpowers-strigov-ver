---
name: agent-invocation
description: How to route pipeline roles through agent-dispatch profiles and run headless coding-agent harnesses (claude -p, OpenCode, pi, DeepSeek Harness dsh) as background jobs — $AD resolution, route, task/status/result/cancel, the Monitor loop by id prefix, failure classes, headless preambles, in-session roles on external profiles. Read this before the first $AD call in a session, including from dev-orchestrator.
disable-model-invocation: true
---

# Agent invocation (agent-dispatch: profiles, roles, harnesses)

> **Manual-only pipeline skill (superpowers-strigov-ver).** It starts only from the user (`/dev`, `/superpowers-strigov-ver:<skill>`), from another skill of this plugin, or when resuming an in-progress plan — never on your own initiative. The Skill tool refuses it by design, so this plugin's pipeline skills are loaded with `Read`, never through the Skill tool. This file: `${CLAUDE_SKILL_DIR}/SKILL.md` (if the variable shows unexpanded, it is the path you just read). Another skill named below (`writing-plans`, `codex-invocation`, `zcode-invocation`, `dev-orchestrator`, …) is `../<name>/SKILL.md` relative to this skill's directory — `Read` it there. After a context compaction, re-`Read` this file before your next step.

> GLM through Z.ai's ZCode CLI and the Codex models (Luna, Sol, Astra) keep their own wrappers and skills: `Read` `../zcode-invocation/SKILL.md` and `../codex-invocation/SKILL.md` (manual-only; never through the Skill tool). This skill covers `agent-dispatch` itself: role routing, profiles, and jobs on the headless harnesses `claude -p`, OpenCode, pi and DeepSeek Harness (`dsh`).

## What this is

`bin/agent-dispatch` runs the profile a pipeline role is bound to. A **profile** is a harness, a way to pay (the harness's own login or an API key), a model, an effort and options. A **role** (`implementer`, `plan-reviewer`, …) has a **chain** of profiles: the first is the primary, the rest are fallbacks in order. The **channel** is the profile currently running a role.

- The user's profiles and roles live in `~/.claude/plugins/data/superpowers-strigov-ver-agents/config.json` (no secrets; keys sit in `keys/<name>`, mode 0600). **No file → the built-in scheme**, which is the dev-orchestrator Model split table, unchanged. A role in the file replaces that role's built-in chain; every other role stays built-in.
- Built-in profiles: `glm` (harness `zcode`, GLM-5.3-Flash `max`), `luna` (`codex`, `gpt-6-luna` `max`), `sol` (`codex`, `gpt-6.1-sol` `xhigh`), `astra` (`codex`, `gpt-6-astra` `xhigh`), `astra-high` (`codex`, `gpt-6-astra` `high`), `opus-xhigh`, `opus-high`, `sonnet-medium` (harness `inproc`). They cannot be redefined.
- `zcode` and `codex` profiles are **passed through** to `zcode-dispatch` / `codex-dispatch`: the same argv, the same `zt-…` / `task-…` ids, job stores, refusals and exit codes. Core harnesses run as background jobs of `agent-dispatch` itself, with ids `ct-NNNN` (claude), `oc-NNNN` (opencode), `pi-NNNN` (pi), `dt-NNNN` (dsh). `inproc` profiles are Claude subagents of the session (Agent tool); `task` refuses them (exit 2).
- Profiles, keys, logins and `config.json` belong to the user. The orchestrator never edits `config.json`, never runs `key set`, `profile add` or a harness login, never asks for a key in the chat, and never runs `doctor --probe` (one paid request) unless the user asks for it.

## Working path

### 1. Resolve `$AD` once per session

```bash
AD="$(command -v agent-dispatch || true)"
[ -z "$AD" ] && AD="$(ls -1d ~/.claude/plugins/cache/strigov-cc-plugins/superpowers-strigov-ver/*/bin/agent-dispatch 2>/dev/null | sort -rV | head -1)"
[ -z "$AD" ] && AD="$(pwd)/bin/agent-dispatch"
echo "AD=$AD"
```

The same idiom as `$DISPATCH` (`codex-invocation`) and `$ZDISPATCH` (`zcode-invocation`). Shell variables do not survive between tool calls: put the absolute path this prints into later commands.

### 2. Routes: `route --all` at skill start, `route <role>` to pick a profile

```bash
"$AD" route --all
"$AD" route <role> [--skip <profile>[:<class>],…]
```

- **`route --all`** prints `routes: default` when every role's chain equals the built-in one (no `config.json`, or one that spells out the built-in chains) → announce nothing. Otherwise it prints one line per role that differs, in the `route <role>` format below; announce the differences once, in one line: `User routing: implementer — glm, deepseek-dsh; control-review — deepseek-claude.`
- **`route <role>`** runs before every reviewer and in-session dispatch, at a phase's first implementer dispatch and at every switch; a phase's follow-ups (retry, resume, fix rounds) stay on its channel without it (dev-orchestrator "## Routing" item 2). After `routes: default` it is not called at all while the session's `channels` marker holds no `off` line: the built-in scheme answers (dev-orchestrator "## Routing" item 1). It prints one line:

  ```
  route <role>: <profile> harness=<h> model=<m> effort=<e> readOnly=<os|tools|rules|none|-> maxParallel=<n|-> (chain: <a>, <b>; skipped: <c>=<state>)
  ```

  The profile is the word after the colon. `harness=` picks the dispatch command (step 3); `model=` and `effort=` go into it. `readOnly=` says how the profile keeps a reviewer read-only: `os` (an OS sandbox), `tools` (a restricted tool set), `rules` (the harness's permission rules, not a sandbox), `none` (it cannot: `glm` always runs `--mode yolo` — a read-only role on it, a reviewer or `diagnosis`, is allowed, `route` adds a one-line warning on stderr, and "## No-edit check" brackets the job). `maxParallel=` is the profile's limit of concurrent jobs; `task` enforces it for the core harnesses only (`claude`, `opencode`, `pi`, `dsh`), and for `codex` / `zcode` dev-orchestrator's "## Parallel groups" rule keeps it across the two tracks. An `inproc` profile shows `-` for both.
- **`--skip`** takes the profiles the session lost: one entry per line of dev-orchestrator's `channels` marker (`<p>:<class>` for `down`, `<p>` for `off`), plus `glm` while the `glm-channel` marker says `down` or `off`, plus, for this role, the profiles its lines in the `no-edit` marker name ("## No-edit check" item 4). With class `auth` or `quota`, `route` also skips every profile linked to that one (the same `key`, the same harness login — an OpenCode or pi login counts per provider — the same `shares` label — the built-in `glm` carries `zai-coding-plan`) and lists them under `skipped`.
- **The next profile** after the current one `c` (a switch; an implementer's in the phase's chain — dev-orchestrator "## Routing" item 4): add `c` and every profile before it in the chain to `--skip` (`c:<class>` when it went down with `auth` / `quota`); `route <role>` without `--skip` prints the whole chain. Exit 2 → nothing comes after `c`.
- **Exit 2 `route <role>: no profile left (skipped: …)`** → the chain is exhausted: ask the user exactly one question — wait, retry, or name a profile. No waiting loops.
- **Exit 2 `agent-dispatch: config: <path>: <problem>`** (a broken `config.json`) → relay the line and ask the user one question; dispatch nothing on that role until it is fixed or the user says to use the built-in scheme.
- **In-session roles** — `plan-writer`, `plan-reviser`, `frontend.new-ui`, `frontend.tweak`, `gate`, `phase-review`, `phase-review.escalated`, `synthesis`, `final-review`, `diagnosis`, `quickfix`, `integration-check` — run on whatever their route line names, like every other role: an `inproc` line → the Agent call at its `model` and `effort`; any other → "## In-session roles on an external profile" below. Their built-in chains start in the session, so with no `config.json` nothing changes, and `final-review`'s built-in Astra fallback stays as dev-orchestrator Step 5 writes it.
- **Announcing.** A switch to another profile is one line, e.g. `Channel implementer: glm-api → deepseek-dsh (glm-api: quota).` — when a `config.json` profile is involved; between built-in profiles the built-in line of dev-orchestrator "## Reporting cadence" instead, never both. The new profile's prompt carries the channel-switch notice (`../dev-orchestrator/implementer-prompt.md`) naming `<profile> (<harness>, <model>)`.

### 3. Dispatch by the route line's `harness=`

| `harness=` | Command | Poll · result · cancel |
|---|---|---|
| `inproc` | `Agent(subagent_type="general-purpose", model=<model>, effort=<effort>, ...)` | Agent completion |
| `zcode` | `"$ZDISPATCH" task --background [--cwd W] [--resume-task zt-N \| --fresh] --prompt-file F` — no model flags (`zcode-invocation`) | `$ZDISPATCH` |
| `codex` | `"$DISPATCH" task --background [--write] --model <model> --effort <effort> [--cwd W] [--resume-task task-… \| --fresh] --prompt-file F` (`codex-invocation`) | `$DISPATCH` |
| `claude`, `opencode`, `pi`, `dsh` | `"$AD" task --profile <profile> --role <role> --background [--write] [--cwd W] [--resume-task <id> \| --fresh] --prompt-file F` | `$AD` |

`"$AD" task --profile <p>` on a `zcode` or `codex` profile runs exactly the wrapper command of this table (pass-through; `--write`, `--profile` and `--role` never reach `zcode-dispatch`, which has no read-only mode — without `--write`, `agent-dispatch` prints one WARN line about it), so either form is valid; dev-orchestrator writes the wrapper form. A reviewer on `zcode` uses the same `task` line (it runs with write access and takes the ZCode reservation), the reviewer preamble below and "## No-edit check". `--write` marks a role that writes files or runs the project's commands — the implementers and every in-session role except `diagnosis` and `final-review` ("## In-session roles on an external profile" item 2); without it the harness runs read-only, and `"$AD" task --role` prints one WARN line when the flag disagrees with the role (not on `zcode`, which always writes). Every prompt goes through `--prompt-file` — never inline.

Start line on stdout: `agent-dispatch: <profile> task started in the background as ct-0001` — the id is the last word. A pass-through prints the wrapper's own line: `ZCode Task started in the background as zt-NNNN` (last word) or `Codex Task started in the background as task-… . Check …` (the `task-…` token). Write `<profile>:<id>` into the dispatch file's `.id` sidecar at once.

### 4. Poll with the terminal-only filter (via Monitor)

```bash
ID=ct-0001
case "$ID" in
  ct-*|oc-*|pi-*|dt-*) D="$AD" ;;
  zt-*)                D="$ZDISPATCH" ;;
  task-*)              D="$DISPATCH" ;;
esac
until
  st=$("$D" status "$ID" --json 2>/dev/null \
       | python3 -c "import json,sys; print(json.load(sys.stdin)['job']['status'])" 2>/dev/null)
  case "$st" in
    completed|failed|cancelled) echo "agent task terminal: $st"; true ;;
    "") echo "agent task status unreadable: $("$D" status "$ID" --json 2>&1 >/dev/null | head -1)"; true ;;
    *) false ;;
  esac
do
  sleep 25
done
```

Run this via the Monitor tool; add `--cwd <worktree-path>` to `status` for a worktree job. **The `case` guard is non-negotiable** — a monitor that prints every poll floods the chat and auto-stops. `status unreadable` ends the loop with the dispatcher's first stderr line: a `config:` refusal (`config.json` edited mid-run) goes to the user as one question — the job keeps running; restart the loop once the file is fixed. Anything else: check the id and `--cwd`. The prefix picks the store: core ids on `$AD`, `zt-` on `$ZDISPATCH`, `task-` on `$DISPATCH` (`"$AD" status <zt-…|task-…>` passes through and prints the wrapper's output unchanged, so it works too).

### 5. Fetch the result

```bash
"$AD" result ct-0001
```

`completed` → the harness's final message verbatim on stdout (line 1 is the model's verdict or status token), exit 0. Any other status → exit 1 and stderr `job <id> is <status> errorClass=<class>` plus the last 20 log lines, as `zcode-dispatch` does. Read the class with `"$AD" status <id> --json | python3 -c "import json,sys; print(json.load(sys.stdin)['job']['errorClass'])"`. For `zt-` / `task-` ids `result` passes through and prints the wrapper's output.

## Verb reference

Exit codes everywhere, as in `zcode-dispatch`: **0** success · **1** runtime failure · **2** refusal without a launch.

| Verb | Behaviour |
|---|---|
| `task --profile P [--role R] --background [--write] [--cwd W] [--resume-task ID \| --fresh] --prompt-file F` | Starts a job; `zcode` / `codex` profiles pass through to their wrapper. Before a launch it checks the write reservation of the tree across all three stores (Codex jobs of every Claude session) and the resume, and on a core profile also its `maxParallel` and the key (see "Refusals"). |
| `status [ID] [--cwd W] [--json]` | Without an id: the tree's jobs from all three stores (core, ZCode, Codex), one line each — `<id> <profile> <status> write=<yes\|no> cwd=<root>`; `--json` gives `{"jobs":[…]}` (core entries also carry the job's `role`). The ZCode and Codex lines are what that wrapper's own `status` lists (Codex: only this session's jobs while `$CODEX_COMPANION_SESSION_ID` is set). A wrapper that fails leaves one stderr line `agent-dispatch: status: <wrapper> store skipped (…)` and exit 0: that store was **not** checked — run that wrapper's own `status` before any write dispatch. With a core id: `{"job":{…}}` shaped like `zcode-dispatch`'s (`job.status` ∈ running, completed, failed, cancelled; `job.errorClass`; plus `job.profile`, `job.harness`). With `zt-` / `task-`: the wrapper's output as is. |
| `result ID [--cwd W]` | Step 5 above. |
| `cancel ID [--cwd W]` | Cancels and kills the job's whole process tree (the harness's own signal ladder); `zt-` / `task-` go to their wrapper. |
| `release-stale [--cwd W]` | Frees a stale reservation of core jobs; its messages carry the prefix `agent-dispatch:` and otherwise read like `zcode-dispatch`'s (`released <workspace> generation <n>`, `… is already released`, `… is held by live runner pid <pid>`, `… still has live harness process group <pid>`, `… changed while checking; retry release-stale`, `no workspace reservation to release`, `… has no valid holder`). The ZCode reservation stays with `"$ZDISPATCH" release-stale`. |
| `tree-state [--cwd W] [--since TREE]` | One line `tree <id>`: the tree's content (tracked and untracked files, a submodule or nested repository by its HEAD and its content; ignored files and `.superpowers/` left out) as a git tree id, built in a temporary index — the index, HEAD, refs and files stay untouched. `--since <id>` (a tree id an earlier `tree-state` printed; anything else exits 2) adds `: unchanged` or `: changed since <id7>: <paths>` (a submodule or nested repository first, as `<path> (nested repository)`; the first 10, then `(+<n> more)`; a name holding a control character, `, ` or a leading `"` JSON-quoted); a tree git cannot index exits 1 with git's message. Bookkeeping read ("## No-edit check"). |
| `route ROLE [--skip …] [--json]` · `route --all [--json]` | Step 2. |
| `channels` | Every profile: harness, model, the key or login it pays with, and the profiles that share it. Bookkeeping read. |
| `doctor [--profile P] [--probe]` | Offline checks without a model call; `--probe` adds one paid "PONG" request — the user runs it. |
| `key set NAME` · `key list` · `key rm NAME` | The user's keys. `key set` reads a hidden prompt or a pipe in the user's own terminal (`! pbpaste \| "$AD" key set <name>`; Linux `wl-paste` or `xclip -o -selection clipboard`; Windows: the hidden prompt of `node <plugin>\bin\lib\agent-dispatch.mjs key set <name>` in PowerShell or cmd, since Git Bash's terminal cannot hide input). Never run by the orchestrator. |
| `profile list` · `profile show P` · `profile add NAME --from PRESET …` · `profile env P [-- COMMAND]` · `preset list` | Profile management — user actions; `list` / `show` are reads. |

## Failure handling

The failure rules depend on the job's harness (dev-orchestrator Step 3, "GLM infrastructure failures" and the paragraph after it):

1. **`zcode` jobs** (`glm`) — dev-orchestrator's GLM table, unchanged, with "→ Luna max" read as "→ the next profile of the role's chain (step 2; by default `luna`)" — the `MAX_PROMPT_BYTES` refusal included. When `glm` goes down with `auth` or `quota`, write a `channels` line for it too, so `route` drops its linked profiles.
2. **`codex` jobs** — one `--fresh` retry, then the next profile of the chain (step 2); none left → the user. For the built-in chains this is today's rule (`codex-invocation`: retry, then the user): Luna, Sol and Astra stand last in their chains.
3. **Core jobs** (`ct-`, `oc-`, `pi-`, `dt-`) — by `errorClass`:

| Class | Typical signs | Action |
|---|---|---|
| `timeout` | ran past the profile's `timeoutMin`; claude `error_max_turns` | one `--fresh` retry on the same profile, then the next profile |
| `crash` | non-zero exit without a parsed error | the same |
| `launch` | no binary; the wrong binary (Homebrew `dsh`, OpenCode 2.x); a required flag missing from the harness help; dsh `SANDBOX_UNAVAILABLE`, proxy variables in the repo's `.env`, exit 1 before the `session` event; pi `Failed to load extension`; OpenCode `agent … not found` | the same |
| `malformed` | no final answer or final event | the same |
| `rate-limit` | 429 without signs of an exhausted limit, 529; dsh `RATE_LIMIT` | the same |
| `server` | 5xx, `ECONNREFUSED`; dsh `TRANSPORT`, `SERVER`, `TIMEOUT`, `HTTP_5xx`, `EMPTY_RESPONSE`, `MALFORMED_RESPONSE`, `STREAM_CLOSED` | the same |
| `auth` | claude `api_error_status` 401/403; dsh `AUTH`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`; pi `No API key found for`; no login; a key that did not resolve | the profile and every profile linked to it are `down`; the next profile |
| `quota` | claude 402, or 429 with a limit or balance text; dsh `QUOTA`; OpenCode: an error of any status with `insufficient_quota`, `usage_not_included`, `GoUsageLimitError` or `FreeUsageLimitError` (in its name or body), and 402 or `Insufficient Balance`; an OpenCode 429 without them is `rate-limit`, its "Quota exceeded…" after five retries included | the same |
| `model-not-selected` | 404 on the model; claude "There's an issue with the selected model"; dsh `INVALID_REQUEST`, `MODEL_UNSUPPORTED`, `UNSUPPORTED_REASONING_EFFORT`; OpenCode `Model not found:`; pi `Model "…" not found`, `Unknown provider` | the profile is `down`; the next profile |
| `context` | `prompt_too_long`; dsh `CONTEXT_WINDOW_EXCEEDED`; a context overflow in pi | the next profile for this job |
| `blocked` | OpenCode's remaining `ask` (`auto-rejecting` on stderr); a permission refusal without a result | the next profile |
| `resume-lost` | the harness lost the session | FRESH on the same profile with the re-brief; not a failure |

- A `down` or `off` profile stays so until the session ends: append `<profile> <down|off> <class|kill-switch> <ISO time>` to `<scratchpad>/dev-orchestrator/channels` (`off` comes from the user's "без <profile>", which exists only when the user's routing differs from the built-in scheme; "без GLM" is the GLM kill switch and writes no line). The next `route` call skips it (dev-orchestrator Step 3 "Kill switch").
- Every switch is one announced line; the same operation goes to the new profile FRESH at the next seq, composed per dev-orchestrator Step 3. `cancelled` → report to the user and wait.
- The chain exhausted → `route` exits 2 with `no profile left` → exactly one question to the user.

**Refusals** — `"$AD" task` exit 2, nothing launched, stderr `agent-dispatch: …`:

| Stderr | Action |
|---|---|
| `config: <path>: <problem>` | relay the line, one question to the user |
| `<p>: key unavailable (<reason>) errorClass=auth` | handle as `auth` (the profile and its linked ones `down`, the next profile); tell the user the remedy for their own terminal (`key set <name>`, or the `keyEnv` / `keyCmd` source) |
| `profile <p> is at maxParallel=<n> (running: <id> cwd=<root>, …)` | run the step-4 Monitor loop on the named jobs, each with `status <id> --cwd <root>` (a quoted `<root>` is a JSON string), until one is terminal, then re-run the identical command; a parallel track takes the next profile of the chain instead |
| a running write task named (`<id> is still running in this workspace; one write task per working tree`, or a ZCode / Codex write job) | dev-orchestrator "## Durable Progress" item 4: poll it, never dispatch a second |
| a message containing `release-stale` | dev-orchestrator "Stale workspace reservation", with `"$AD" release-stale` |
| a resume refusal ending `dispatch --fresh` | the same operation FRESH on the same profile (re-brief on fix-type operations) |
| `profile <p>: harness <h> is not available in this version` (its adapter file `bin/lib/adapters/<h>.mjs` is missing: a damaged or partial plugin install) | the profile is `down` for the session (`channels` line, class `launch`); the next profile of the chain, announced with the quoted line; tell the user to reinstall or update the plugin |
| any other refusal naming the profile (an `env` conflict with a mandatory setting, a field holding the key) | the next profile of the chain, announced with the quoted line |
| a usage error (flags, paths, missing prompt file) | fix the dispatch |

## Headless preambles

Prepend the block verbatim to every dispatch file of its kind; replace `[REPORT_FILE]` with the absolute path the template uses. A `glm` implementer gets the ZCode preamble (`../dev-orchestrator/implementer-prompt.md`) instead of the implementer preamble; a `glm` reviewer gets the reviewer preamble; `codex` and `inproc` dispatches get neither block. An in-session role on an external profile gets the block "## In-session roles on an external profile" names.

**Implementer preamble** — every implementer dispatch (`implement`, `fix`, `gatefix`, `final-fix`, `repair`, follow-ups) on `claude`, `opencode`, `pi` or `dsh`:

```
## Headless run — read this first

- This is a headless, non-interactive run. Nobody can answer questions. Do not ask. If something is unclear, stop and finish with the status token `NEEDS_CONTEXT` (first round) or `BLOCKED`, with the specific question in your final message.
- Do not invoke skills, plugins, dynamic workflows, sub-agents, browser or computer-use tools, or goal mode. Use only file reads, file edits and shell commands.
- No git operations that change history, refs or the index: no `git commit`, `git push`, `git branch`, `git checkout`, `git switch`, `git stash`, `git reset`, `git rebase`, `git add`. Read-only git (`git status`, `git diff`, `git log`, `git show`) is fine.
- Stay inside the repository root named below. Never read or write `~/.claude` (this plugin's data under `~/.claude/plugins/data/` included), `~/.config/opencode`, `~/.local/share/opencode`, `~/.pi`, `~/.dsh`, `~/.zcode`, `~/.codex`, `~/.ssh`, `~/.aws`, keychains, or any credential store, and never read `.env` files outside the repository.
- Network only for package installs the plan explicitly requires (for example an `npm install` / `pip install` of a dependency the plan names). No other downloads, no API calls.
- Write the full report to [REPORT_FILE] (create parent directories if needed). Your final message is at most 15 lines; line 1 is the bare status token and nothing else.
```

**Reviewer preamble** — every reviewer dispatch on an external profile other than `codex` (the plan, spec, control, final and ad-hoc reviews):

```
## Headless review — read this first

- This is a headless, non-interactive run. Nobody can answer questions. Do not ask; if something stops the review, say so in your report.
- Read-only: create, edit or delete no file, and run nothing that changes the working tree, the index, HEAD or branches. Read-only git (`git show`, `git diff`, `git log`, `git status`) is fine where your tools allow it; where they do not, the files and the review package named below are your only sources.
- Do not invoke skills, plugins, sub-agents, browser or computer-use tools. Stay inside the repository root named below; never read credential stores, harness directories (`~/.claude`, `~/.config/opencode`, `~/.local/share/opencode`, `~/.pi`, `~/.dsh`, `~/.zcode`, `~/.codex`, `~/.ssh`, `~/.aws`) or `.env` files. No network.
- Your final message is the full report, with no length limit. Line 1 is the bare verdict token the instructions below name, and nothing else.
```

## In-session roles on an external profile

`plan-writer`, `plan-reviser`, `frontend.new-ui`, `frontend.tweak`, `gate`, `phase-review`, `phase-review.escalated`, `synthesis`, `final-review`, `diagnosis`, `quickfix` and `integration-check` run as Agent calls on their built-in chains. When the user's `config.json` routes one to an external profile (its route line's `harness=` is not `inproc` — never under `routes: default`), the same dispatch runs as a background job:

1. **Prompt.** Fill the role's template exactly as for the Agent call and adapt it for the headless run as below — nothing else changes: the template's rules on what to write, what to run, the test policy and the output format stand. Write it to a new file per dispatch: `frontend.*` — item 9; every other role — `<scratchpad>/dev-orchestrator/<role>-<phase id or plan slug>-r<round>-<n>.md` (`integration-check`: a parallel group's names its group id, Step 5's check 6 the plan slug; no scratchpad: the directory `"$WS"` prints without an argument).
   - Prepend the preamble: `frontend.*` — the implementer preamble (on `glm`: the ZCode preamble); `final-review` — its template's external recipe (`../dev-orchestrator/final-review-prompt.md`: reviewer preamble, check 6 split off); every other role — the session-role preamble below. `codex` profiles get none.
   - In the opening line, name the profile instead of the Claude model: `<profile> (<harness>, <model>)` for "Opus subagent", "Sonnet subagent" or "Claude Opus subagent".
   - `frontend.*`: replace the `## Use the frontend-design skill` section with the "Design quality" block below — a headless run has no Skill tool.
   - `gate`: open its instructions with "Before anything else: if `<dir>/gate-base` exists or `git worktree list` names it, run `git worktree remove -f -f <dir>/gate-base`", and in the inherited-failure rule replace the `git stash` example with "a rerun in a temporary checkout of the base commit: `git worktree add --detach <dir>/gate-base <base-sha>`, then `git worktree remove --force <dir>/gate-base`", `<dir>` being the absolute `"$WS" <plan-file>` directory (a parallel track: `"$WS"` run inside its worktree).
   - `diagnosis` and `quickfix`: their prompts (the gate-stall skeleton, the BLOCKED and impasse prompts, `sonnet-quickfix-prompt.md`) name no repository root — add the line `Repository root: <absolute path>` (the `--cwd` worktree for a parallel track, otherwise the main tree) right after the opening paragraph, so the preamble's "repository root named below" names one.
2. **Dispatch** by `harness=` (step 3) with `--background`, the absolute `--prompt-file`, `--cwd <worktree>` for a parallel track, `--role <role>` on `"$AD" task`, and `--write` for every role except `diagnosis` and `final-review` (`roleKinds` in `agents-defaults.json`; `"$AD" task --role` warns on a mismatch). The writers (`plan-writer`, `plan-reviser`, `frontend.*`, `synthesis`, `quickfix`) edit files; `gate`, `integration-check`, `phase-review` and `phase-review.escalated` run the project's tests and tools, which no harness allows in read-only mode — their templates' no-edit rules keep them read-only, and item 4 checks it. Every dispatch is FRESH, as an Agent call is; only the verdict re-dispatch (dev-orchestrator "## Verdict parsing" step 3) resumes, by the job's harness.
3. **Poll** with the Monitor loop (step 4), **fetch** with `result` (step 5), and read the output as the Agent result: line 1 against the step's token set; prose where the template names no token (plan writer and reviser, quickfix, BLOCKED diagnosis, impasse summaries).
4. **No-edit check** — every `gate`, `phase-review`, `phase-review.escalated` and `integration-check` job, and every `diagnosis` or `final-review` job whose route line says `readOnly=none`, runs inside "## No-edit check" below: its baseline right before the dispatch, its check as soon as the job ends.
5. **Unchanged:** ledger reviewer ids name the stage (`opus-review`, `opus-final`) whatever profile ran it; the family rule is not checked for user routing.
6. **A `--write` job** takes the tree's write reservation like an implementer: it starts after the phase's implementer job has ended, and in a parallel group it is its track's write task. A refusal → "Refusals" above.
7. **Failures** — for a job item 4 checks, its `--since` check comes first (a changed tree → "## No-edit check", never a retry on that profile); then "## Failure handling": the next profile of this role's chain (`route <role> --skip <skips>,<the failed profile and every profile before it>`), announced as `Channel <role>: <c> → <next> (<c>: <class>).`; an `inproc` next profile runs the Agent call; `no profile left` → one question to the user. An Agent call on a user-configured chain that fails for availability is a switch too: a `channels` line (usage cap: every `inproc` profile of that model, class `quota`; launch error: that profile, class `launch`), then the next profile.
8. **After a compaction**, re-derive the step as dev-orchestrator "## Durable Progress" says. A running job of the step's role (`"$AD" status --json`: a core job's `role`), or one whose store records no role (`codex`, `zcode`) → keep polling it; a running write job of another role → poll it to its end first (Durable Progress item 4). A step whose role "## No-edit check" item 4 lists then goes through its item 5 before any result counts or any FRESH dispatch, whatever profile it now routes to; any other step uses the polled job's result, or is dispatched FRESH. A `frontend.*` phase recovers from its sidecar (item 9).
9. **`frontend.*` is an implementer:** dev-orchestrator Step 3 "Prompt files" — body `$dir/prompts/<name>.md` (`implement-<id>-r1`: the first-round template; `fix-<id>-r<N>` / `gatefix-<id>-r<N>`: the follow-up template; no plan file — a pure frontend task from Triage: `$dir` is `"$WS"` without an argument), dispatch file `<name>.<seq>.<profile>.md` holding the preamble, then the body (every frontend dispatch except item 2's verdict re-dispatch is FRESH, and its templates are self-contained: no re-brief; a switch adds the channel-switch notice after the body's opening paragraph), the `.id` sidecar, `impl=<profile>:<id>`. The Step 2.5 compaction-safe guards and admission condition (dev-orchestrator Pre-dispatch checklist item 5) are not checked for it: Step 2.5 runs them before non-frontend implementer dispatches only. A frontend sidecar's chain is its `frontend.*` role — the one whose chain lists the sidecar's profile, `frontend.new-ui` first — never `implementer.escalation`.
10. **Reading dev-orchestrator.** For these roles its "Opus subagent", "Sonnet subagent", "Claude frontend implementer", "fresh Agent call" and "Agent completion" mean the routed profile's dispatch above. "Never GLM or Codex" for a frontend phase means its fixes never leave its `frontend.*` role for the `implementer` / `implementer.escalation` chains; the BLOCKED "Sonnet → Opus" upgrade is `frontend.tweak` → `frontend.new-ui`, and a phase already on `frontend.new-ui` goes to the user.

**Session-role preamble** — every external dispatch of an in-session role other than `frontend.*` and `final-review`, on `claude`, `opencode`, `pi`, `dsh` or `zcode`:

```
## Headless run — read this first

- This is a headless, non-interactive run. Nobody can answer questions. Do not ask: when something stops you, finish with the status token the instructions below name for that case, or, if they name none, with the specific question in your final message.
- Do not invoke skills, plugins, dynamic workflows, sub-agents, browser or computer-use tools, or goal mode. Use only file reads, shell commands and the file writes the instructions below ask for.
- Create, edit or delete only the files the instructions below tell you to write; running the project's tests, linters and builds is fine. No git operations that change history, refs, the index or the working tree: no `git commit`, `git push`, `git branch`, `git checkout`, `git switch`, `git stash`, `git restore`, `git reset`, `git clean`, `git rebase`, `git add` — except a temporary `git worktree add --detach` / `git worktree remove` the instructions below name. Read-only git (`git status`, `git diff`, `git log`, `git show`) is fine where your tools allow it.
- Stay inside the repository root named below. Never read or write `~/.claude` (this plugin's data under `~/.claude/plugins/data/` included), `~/.config/opencode`, `~/.local/share/opencode`, `~/.pi`, `~/.dsh`, `~/.zcode`, `~/.codex`, `~/.ssh`, `~/.aws`, keychains, or any credential store, and never read `.env` files outside the repository.
- No network: no downloads, no package installs, no API calls.
- Your final message is the full answer in the format the instructions below give, with no length limit; when they name a line-1 token, line 1 is that bare token and nothing else.
```

**Design quality** — replaces the frontend template's `## Use the frontend-design skill` section on an external profile:

```
## Design quality

No design skill is available in this run, so hold the bar yourself. Pick one clear visual direction that fits the product and keep it consistent: a deliberate type scale, spacing on one rhythm, a restrained palette with sufficient contrast, and real states (hover, focus, disabled, loading, empty, error). Reuse the project's components, tokens and patterns before adding new ones, and avoid generic template looks.
```

## No-edit check

Every job of a `run` role (`gate`, `phase-review`, `phase-review.escalated`, `integration-check`) on an external profile, and every job of a `read` role (`plan-reviewer`, `spec-reviewer`, `control-review`, `final-review`, `diagnosis`, `adhoc-review`) whose route line says `readOnly=none` (`roleKinds` in `agents-defaults.json`), runs between a baseline and a check of the working tree — never under `routes: default`, whose chains keep these roles in the session or the Codex sandbox. Whoever dispatches the job runs both; `W` is its `--cwd`.

1. **Baseline**, right before the dispatch: `"$AD" tree-state [--cwd W] > <prompt-file>.tree`. A checked dispatch always writes a new prompt file, `<scratchpad>/dev-orchestrator/<role>-<phase id or plan slug>-r<round>-<n>.md` whatever name its recipe gives ("## In-session roles on an external profile" item 1; `spec-reviewer`: the spec slug; `adhoc-review`: `adhoc`; no scratchpad: the directory `"$WS"` prints without an argument), with a new `<n>` each time: the baseline beside it outlives a compaction, a marker never passes to another job, and one names-only `ls` of that directory finds every marker. The call fails → dispatch nothing and ask the user one question with git's message: the tree fails there, not the profile — the step waits for the user to fix the tree, or runs on a profile of the chain that needs no check (an `inproc` one, or for a read role one whose route line does not say `readOnly=none`).
2. **Check**, as soon as the job ends, whatever its status — after the `result` of a `completed` job, before any retry or switch of a `failed` or `cancelled` one: `"$AD" tree-state --since "$(cut -c6- <prompt-file>.tree)" [--cwd W] | tee -a <prompt-file>.tree.since` (the record tells a later compaction this job was checked). `unchanged` → `: > <prompt-file>.tree.done`, go on. Anything else voids that run's verdict and nothing is committed: `changed since …: <paths>`, or no such line (a non-zero exit — a missing or empty `.tree` exits 2 — or another line), where item 3 names git's message instead of the paths. After a `gate` job's check: if `<dir>/gate-base` (`<dir>`: the `"$WS" <plan-file>` directory) exists or `git worktree list` names it, run `git worktree remove -f -f <dir>/gate-base` (double force: an add killed mid-checkout leaves it locked) before any retry, switch or next step.
3. **One question.** First `route <role> --skip <skips>,<that profile and every profile before it in the chain>` (the next profile, as "## In-session roles on an external profile" item 7). Then ask the user exactly one question, naming the paths — keep them or revert them; when that `route` exited `no profile left`, the same question also asks where the step runs again (that profile again, or one the user names) — never a second question. The revert is one command the user runs at the root of that tree (neither you nor a subagent reverts): `git diff-tree -p --binary <after> "$(cut -c6- <prompt-file>.tree)" | git apply`, `<after>` being the id the `--since` line prints after `tree`; it undoes that job's edits to the tree's own files and keeps the phase's uncommitted work, which a `git checkout` / `git restore` from HEAD would discard too. A path marked `(nested repository)` is beyond that command: name it apart — the user reverts inside that repository by hand (`git -C <path> status` / `diff`, `log` if its HEAD moved) or keeps it; never suggest `checkout -- .`, `clean` or `reset --hard` there.
4. **After the answer.** First — unless the user chose that profile again — append `<role> <the profile that edited> <ISO time>` to `<scratchpad>/dev-orchestrator/no-edit`: every later `route <role>` adds that role's profiles from it to `--skip`. The user reverted → item 2's command once more against the same `.tree`; anything but `unchanged` → one status line `Not reverted: <paths> — kept.`, and those paths count as kept (no second question). Then `: > <prompt-file>.tree.void` — `: > <prompt-file>.tree.void.<profile>` when the answer named the profile (item 3's `route` exited `no profile left`) — not `.tree.done` (names only: this job's verdict is void and its step restarts from its role's point below — item 5 finds it after a compaction). The restart's dispatch of that role — an Agent call too, with the prompt it passes — writes a new prompt file (item 1's naming); once that dispatch has started (an external job: in its dispatch's own Bash command, `<dispatch command> && : > <the voided prompt-file>.tree.restarted`; an Agent call: in the same message, right after the call), `: > <the voided prompt-file>.tree.restarted` (names only) — after the dispatch, never before, so a compaction in between repeats the restart rather than losing it (a running job of that role, found by "## In-session roles on an external profile" item 8, is that dispatch: write the marker and poll it, never dispatch it twice). The step runs again on item 3's profile (the one a `.tree.void.<profile>` names), from:
   - `gate`, `phase-review`, `phase-review.escalated` and `control-review` — the verification gate (dev-orchestrator Step 3.5), so a kept edit reaches a fresh 4.0 package and a fresh 4.1;
   - `final-review`, and an `integration-check` run as its check 6 — that round's package rebuilt in WORKTREE mode in either round (`"$RPKG" <MERGE_BASE> WORKTREE "$dir/review-final-r<k>-<base7>.diff"`), then its dispatch (dev-orchestrator Step 5 item 3; round 2: item 5), so the package carries whatever stays, a round-2 fix wave included; a kept edit is committed with the fixes at dev-orchestrator Step 5 item 7;
   - any other `integration-check` — its own check (Parallel groups step 7);
   - `plan-reviewer` / `spec-reviewer` — a fresh review of the plan / spec as it now stands, at the same round number, with nothing from the voided verdict in the ledger; a checked review's `APPROVED` is committed (`docs(plans): add …` / `docs(specs): add …`) only after its `unchanged` line;
   - `diagnosis` — its dispatch; `adhoc-review` — the verdict is void and the review re-runs.
5. **After a compaction**, before a result of any role item 4 lists counts or its step is dispatched — on whatever profile it routes to now, `inproc` and a read-only one included (item 4's skip can move it to one that needs no check) — look at the prompt files (names only) of that role and of every role sharing its restart point (item 4) among those whose name carries this step's phase id or plan slug (a parallel track: its own phase; Step 5: the plan slug) — dev-orchestrator Steps 3.5–4: `gate`, `phase-review`, `phase-review.escalated`, `control-review`; Step 5: `final-review` and its check-6 `integration-check`, whose prompt file names the plan slug (a parallel group's names its group id: "## In-session roles on an external profile" item 1). First a pending restart, then each role's newest prompt file (a pending restart still sets where the step runs):
   - `.tree.void` or `.tree.void.<profile>` and no `.tree.restarted`, beside any of them → the restart is pending, whatever newer prompt files exist: no verdict of that job counts; the step runs again from item 4's restart point for its role, with no new question (the answer was given); with `<profile>`, the role's restart dispatch runs there, not on a `route` answer. A void with `.tree.restarted` is spent.
   - `.tree.done` → the check passed; nothing to do here.
   - No `.tree` beside it → that job needed no check (the restart's own dispatch, or one on a profile that needs none); nothing to do here.
   - A `.tree` with neither → the job's check never finished. No `.tree.since` → it was never checked: a job of the step still running → poll it to its end; then run item 2 against that `.tree` now. A `.tree.since` → it was checked but never settled: run item 2 against that same `.tree` once more (the same baseline, so the check repeats); that job's verdict stays void. Anything but `unchanged` → items 3–4. `unchanged` → the result of a job polled to its end counts when its `job.promptFile` (`status <id> --json`) is that file; otherwise dispatch the step FRESH.

## Resume and read-only, by harness

| Harness | `--resume-task` | Read-only reviewer |
|---|---|---|
| `zcode` | a `completed` job with a session, same `--cwd` (`zcode-invocation`) | none: always `--mode yolo` |
| `codex` | any inactive job with a thread; another `codex` profile may continue it (Luna → Sol) | the Codex sandbox (no `--write`) |
| `claude` | a `completed` `ct-` job of the same profile; the same config directory and `cwd` | Read, Glob, Grep and read-only git |
| `opencode` | a `completed` `oc-` job of the same profile; the same `--dir` and profile directory | its own reviewer agent: read, grep, glob, list and read-only git |
| `pi` | a `completed` `pi-` job of the same profile; the same `cwd` and session file | `read,grep,find,ls` — **no git**: the review package is the reviewer's only source of the diff |
| `dsh` | a `completed` `dt-` job of the same profile; the same `cwd` | the `read-only` permission mode |

Ids never cross harnesses. A core id resumes only on its own profile; a refused resume or `resume-lost` → FRESH on the same profile. Reviewers stay FRESH every round wherever dev-orchestrator says so, whatever the harness.

## Facts from sources (not run)

Each harness adapter is written against one version; `doctor` prints one line when the installed version differs ("not checked") and does not block the run. OpenCode 2, which has another CLI, is refused (`launch`).

- `claude` 2.1.302 — checked by running it (`docs/research/universal-dispatchers/01-claude-code-headless.md`).
- `opencode` 1.19.3, `pi` 1.3.0, `dsh` 0.2.1-rc.2 — not run on the owner's machine; facts from their sources and documentation (`02-opencode.md`, `03-pi.md`, `04b-deepseek-harness.md` in the same directory).

The per-harness facts the orchestrator relies on are in "Resume and read-only, by harness" and "Failure handling" above; each adapter (`bin/lib/adapters/*.mjs`) cites its source for the rest.

## Never do

- Run a harness CLI (`claude -p`, `opencode`, `pi`, `dsh`, `zcode`, `codex exec`) directly — `$AD` and the two wrappers guarantee the environment allowlist, the key handling, the write reservation, the job record and the signal ladder.
- Read, print or copy a key: `keys/`, `config.json` key sources, a harness's own credential store. Never ask for a key in the chat or pass one as an argument; the user runs `key set` in their own terminal.
- Edit `config.json`, add or change profiles, or log in to a harness on the user's behalf.
- Dispatch on a profile other than the one `route` printed for the dispatch or switch, the phase's current channel, or the `SP_IMPLEMENTER` profile (dev-orchestrator ladder item 1, its details from `"$AD" channels`), or switch profiles silently — every switch is one announced line.
- Resume a core id on another profile, or a `zt-` / `task-` id on `$AD`'s core store.
- Run two write tasks in one working tree across the three stores.
- Run `doctor --probe` on your own — it spends the user's money; omit the `case` guard from a Monitor loop.

## Session paths (for debugging)

- CLI: `<plugin-root>/bin/agent-dispatch` → `<plugin-root>/bin/lib/agent-dispatch.mjs` (the job core: `bin/lib/agent-core.mjs`)
- Data: `~/.claude/plugins/data/superpowers-strigov-ver-agents/` — `config.json`, `keys/<name>` (0600), `homes/<profile>/` (isolated harness homes), `cache/` (harness help by version), `state/<workspace-slug>/jobs/` (`ct-`, `oc-`, `pi-`, `dt-` records and logs; secrets scrubbed)
- ZCode and Codex jobs stay in their own stores (`…-zcode`, `…-codex`; see their skills)
