# ZCode CLI findings — discovery for the GLM implementer channel

- ZCode.app: 3.15.1 (3.15.1.8093)
- Embedded CLI: zcode 0.16.9
- Source tag read: v3.15.1 (`gh api -H 'Accept: application/vnd.github.raw' repos/zai-org/ZCode/contents/<path>?ref=v3.15.1`)
- Node: v26.11.0 (`/opt/homebrew/bin/node`)
- Date: 2026-10-13
- Method: source reading at the tag above, plus direct CLI runs (discovery-only exception — the wrapper did not exist yet) against throwaway git repos. Nothing under `~/.zcode` was read; the executor made no login/logout, settings or plugin change. The user ran the one-time `zcode login zai` (U1), with the personal provider config pointed at a probe-owned file.
- Network (this machine): the CLI's own HTTP client takes a proxy only from its config `network.httpProxy` or the env variable `ZCODE_HTTP_PROXY`. It ignores `HTTPS_PROXY`/`HTTP_PROXY` and the macOS system proxy, which is 127.0.0.1:1082 here; the desktop app (Chromium) uses that system proxy. The user's `zcode login zai` failed with `Error: fetch failed` (`HttpClientPortError` in the `POST https://zcode.z.ai/api/v1/oauth/cli/init` call) until `ZCODE_HTTP_PROXY=http://127.0.0.1:1082` was added. All model runs in this spike went from Claude Code's Bash straight to `https://api.z.ai/api/anthropic` and worked without it: DNS answers with a 198.18.x fake-IP, the address a TUN-mode proxy client uses for interception. Whether a given shell needs `ZCODE_HTTP_PROXY` therefore depends on the machine's proxy client; the CLI never picks the system proxy up by itself.

## Go / no-go

VERDICT: GO

## U1 — how a headless `-p` run receives the model
- Answer: A fresh headless run takes the `defaultModelSelection` stored under `config` in the personal provider config file named by `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (default `~/.zcode/v2/provider_config.json`). The selection only counts if the provider is entitled, and the standalone CLI's Coding Plan provider is entitled only after the CLI's own `zcode login zai`. That login writes `account-provider:<id>:identity` into ZCode's credential store; the desktop app's login does not do this for the CLI. With no valid default, the CLI silently falls back to the first registry model at its highest reasoning level. With no entitled model at all, it fails with `Error: Model creation failed`.
  - No headless model selection exists besides this file: no `--model`/`--effort` flag and no model env variable. The embedded CLI ships without its TUI (`Cannot find package '@zcode/tui'`), and headless `-p '/model …'` is sent as plain prompt text.
  - The user ran `zcode login zai` once, with `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` pointing at a probe-owned file. The login wrote `{"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]},"defaultModelSelection":{"providerId":"account:zai-individual-coding-plan","modelId":"GLM-5.3"}}}`. Its shape is `schemaVersion:number, config:{providerConfigRules:{providerRules:array}, modelConfigRules:{providerModelRules:array, manualProviderModelRules:array}, defaultModelSelection:{providerId:string, modelId:string}}`, with no credential-like value.
  - The default was then pinned to `{"providerId":"account:zai-individual-coding-plan","modelId":"GLM-5.3-Flash","options":{"reasoningLevel":"max"}}`. That matches the bundle's strict selection schema `{providerId, modelId, options?:{reasoningLevel?}}`.
  - Probe 2 then ran a fresh PONG. It exited 0, `response` was `PONG`, and the session was `sess_aa3d8b5a-…`. The model evidence comes from the stream run (`--output-format stream-json --verbose`): the only model-identifying matches are 3× `"modelId":"GLM-5.3-Flash"`. Each sits under `"providerId":"account:zai-individual-coding-plan"` in the `session.updated` / `model_request_started` / `model_request_completed` events. Those events carry `"baseURL":"https://api.z.ai/api/anthropic"` and `"reasoning":{"capability":"unknown","requestedControl":"provider_default","requestedState":"provider_default","requestedLevel":"max","effectiveControl":"unknown","effectiveState":"unknown","effectiveLevel":"unknown"}`. So the run used GLM-5.3-Flash, and its only reasoning level was the requested `max`. The CLI does not report an effective level (`unknown`), and the request control is `provider_default`.
- How verified:
  - Source at v3.15.1:
    - `arguments.ts` uses strict `parseArgs` and has no model flag.
    - `prompt-command.ts` passes `configuredDefaultModelSelection` and `resume` to `createApp`.
    - `provider-runtime-env.ts` defines the personal config path and `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`.
    - `runtime-model.ts` holds the `Select a model before continuing` throw.
    - In `command-center/handlers/model.ts`, `/model` saves the default, but only in the TUI command center. Headless, only `/expert` and `/goal` route there.
  - Bundle `zcode.cjs`:
    - Initial resolution (`Yoc` / `oQe`): `if(e.resume)return;` and then `configured-default` → `registry-fallback` → `none`.
    - `NodeModelSelectionConfigRepository.read()` returns `defaultModelSelection`.
    - Account entitlement (`FNn`) needs the `account-provider:<id>:identity` credential.
    - The login (`jNn`) saves the provider's first `builtinModelIds` entry as the default.
  - Live runs:
    - Probe 1, before the login: exit 1, `Error: Model creation failed (traceId: …)`; `--verbose` adds `Cause: Error: Select a model before continuing`.
    - Headless `-p '/model'` failed the same way.
    - The user's login printed `Model: account:zai-individual-coding-plan/GLM-5.3`.
    - Probe 2 (`pong2.out`) and its stream counterpart (`pong2s.out`) ran on the pin and gave the evidence above.
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence: `MODEL_MECHANISM = personal-config`.
  - The wrapper owns its personal provider config, `<ZCODE_STATE_DIR>/personal-provider-config.json`. It passes the file as `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`, and before every run it wrote `PERSONAL_CONFIG_BASE` with `PINNED_SELECTION` at `SELECTION_PATH` (until 0.10.0; since then `api-key set` writes the pin, and runs only check it — see "CLI login lifetime").
  - Historical (until 0.10.0): the user's one-time `zcode login zai` was a prerequisite (on this machine with `ZCODE_HTTP_PROXY=http://127.0.0.1:1082`); 0.10.0 replaced it with the Coding Plan API key (`zcode-dispatch api-key set`). The login should also point `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` away from `~/.zcode/v2/provider_config.json` so the desktop app's selection is untouched.
  - A PONG alone does not prove the pin, because an invalid pin silently falls back to `GLM-5.3`. Only the stream events name the model, and the JSON summary does not (U3). Doctor/probe can therefore confirm entitlement, but it cannot confirm the model from the `json` output.
  - The effective reasoning level is not observable (`effectiveLevel:"unknown"`).

## U2 — does `--resume` keep model and effort
- Answer: Yes.
  - Live: `--resume sess_aa3d8b5a-…` exited 0 with the same `sessionId` and `response` `PONG2`. A resume probe after SIGTERM also exited 0 (U7).
  - Source: a resumed run skips the configured default (`if(e.resume)return;` in `Yoc`) and uses the session's own bound selection. `runtime-unbound-resume.test.ts` shows two things. A resumed session without a bound selection is not given one from history and fails with `Select a model before continuing`. Once a session has a selection, `getSessionModelSelection()` returns the full object including `options.reasoningLevel`.
  - So a successful resume means the session's bound selection, GLM-5.3-Flash with reasoning `max`, was restored. A later change of the default does not affect resumed sessions.
- How verified: `resume.ts`, `runtime-unbound-resume.test.ts` and the bundle's `Yoc` read at v3.15.1. Live run `zc -p 'Reply with exactly one word: PONG2' … --resume sess_aa3d8b5a-28a3-4f73-aff0-d4ceb88e4e72` → exit 0, same `sessionId`.
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence: fix rounds may resume the GLM session (`--resume <sessionId>`). The model and effort are those bound when the session started; they are not re-read from the pin.

## U3 — effective model in the JSON; `usage` field names and semantics
- Answer: The `--output-format json` summary has the keys `sessionId traceId turnId response usage eventCount projection`. `turnResponses` appears only for multi-turn runs and `workspaceHookTrust` only when a project hook is blocked. **No model field.** `usage` is `{"source":"provider","modelRequestCount":1,"inputTokens":14011,"outputTokens":35,"totalTokens":14046,"cacheReadTokens":7872,"cacheWriteTokens":0,"reasoningTokens":0,"webFetchRequests":0,"webSearchRequests":0}`. How the counts relate:
  - `inputTokens` already includes cache read and cache write; `cacheReadTokens` is a subset of it.
  - `reasoningTokens` is a breakdown inside `outputTokens`, not an extra counter. The AI SDK v6 adapter in the bundle sets `outputTokens = outputTokens.total` and `reasoningTokens = outputTokens.reasoning`.
  - `totalTokens = inputTokens + outputTokens`. Every run confirms it: 14011+35=14046, 14057+20=14077, 33200+14=33214.
  - The model id appears only in the stream-json events (`payload.modelId` / `payload.providerId` of `model_request_started`).
- How verified: `prompt-command.ts` JSON summary at v3.15.1. `turn-model-step-usage.ts`: "AI SDK v6 已把 Anthropic cache read/write 并入 inputTokens", with hit rate = `cacheReadTokens / inputTokens`. The bundle's usage adapter (`outputTokenDetails.reasoningTokens` = `reasoningTokens` = `outputTokens.reasoning`). Live `pong2.out`, `resume.out`, `p150.out`.
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence:
  - `REPORTED_MODEL_PATH = null` (`reportedModel` stays null; `doctor --probe` prints `reported-model: unreported`).
  - `USAGE_FIELDS = {input: "inputTokens", cached: "cacheReadTokens", output: "outputTokens"}`.
  - Reasoning is billed inside output, so the Ф5 measurement needs no separate reasoning counter. Every probe so far reported `reasoningTokens: 0` even at requested `max`.

## U4 — error strings and exit codes (auth, model-not-selected, quota, hang)
- Answer: Every failure prints `Error: <message> (traceId: <uuid>)` on stderr and exits 1. `--verbose` adds `Cause:` and a stack.
  - **Model not selected / no entitled model:** `Error: Model creation failed (traceId: …)`. The cause, `Select a model before continuing`, is printed only with `--verbose`.
  - **SIGTERM:** exit code 143, stderr `Error: Turn was cancelled. (traceId: …)`, and stream event `model_request_failed`.
  - **Empty prompt:** `--prompt requires non-empty text.`, exit 1.
  - **Auth** (bundle, not provoked): HTTP 401/403 → `Provider authentication failed.`
  - **Quota/rate** (bundle, not provoked):
    - 429 → `Provider rate limited the model request.`
    - Quota provider codes are mapped to non-retryable rate limiting: `insufficient_quota`, `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded`, `exceeded_current_quota_error`, and Z.ai codes `2056`, `20097`, `1316`–`1321`.
    - Account-level: `quota_exceeded`, `coding_plan_required`.
  - **Server:** 529 → `Provider is overloaded.`; 5xx → `Provider returned a server error.`
  - **Startup** (source): `Failed to load environment file: <path>`, `ZCode app factory is unavailable.`, `Provider Registry runtime is unavailable.`. The TUI-less bundle yields `Cannot find package '@zcode/tui' …`.
  - **Network:** `Error: fetch failed` (login, see header).
  - Retries: the CLI retries provider calls itself (`maxAttempts: 11` in `model_request_started`).
  - **Benign stderr on every run, including successful ones:** `ZCode Built-in 刷新失败: EPERM: operation not permitted, mkdir '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin-refresh.json.lock'`. It appears because `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` points into the read-only app bundle, so the CDN refresh cannot take its lock. The run still succeeds on the bundled config.
  - The bundle has no `not logged in` / `token expired` literal. Auth and quota failures were not provoked: no logout, no quota exhaustion.
- How verified: `prompt-command.ts` (catch → `Error: …`, return 1), `runtime-model.ts`, `process-errors.ts` at v3.15.1. Bundle greps of the provider error table and the quota code lists. Live probe 1, `-p '/model'`, the 6 s SIGTERM probe (`long6.out.err`), and the stderr of every live run.
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence: classify on the exit code first, and use stderr patterns only for failed runs. Two cautions:
  - Before matching, strip the ` (traceId: <uuid>)` suffix: a uuid can contain digit runs such as `401` or `429`.
  - Never treat the `ZCode Built-in 刷新失败 … EPERM … .lock` line as a failure. It contains `EPERM`/`lock`, and none of the patterns below match it.

  Unknown strings stay `crash`.

## U5 — can two `zcode -p` processes run concurrently
- Answer: Yes. Two simultaneous PONG runs in two worktrees of one repo both exited 0 with `PONG`, in separate sessions (`sess_bc2503de-…`, `sess_3a484b16-…`). The plan's `grep -il 'lock\|busy\|sqlite'` matched both stderr files, but the only stderr line in each was the benign `ZCode Built-in 刷新失败: EPERM … zcode-builtin-refresh.json.lock`. That same line appears in every serial run (`pong2.err`, `resume.err`), so it is not a concurrency lock error.
- How verified: Ф1 Step 9 live (`conc.txt`: `wt2 exit=0`, `wt1 exit=0`; `wt1.err` / `wt2.err` contain only the refresh warning).
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence: `GLM concurrency: 2`; two parallel tracks may both run on GLM.

## U6 — what `--disallowedTools` applies to
- Answer: It removes whole tools by name for that run, including plugin-provided MCP tools. The headless tool list was `Agent AskUserQuestion Bash Edit EnterPlanMode ExitPlanMode Read Skill TaskOutput TaskStop TodoRead TodoWrite WebFetch WebSearch Write SendMessage ReadSessionContext ReplyToChannel mcp__node_repl__js mcp__web_reader__webReader`. With `--disallowedTools mcp__node_repl__js` the same list came back without `mcp__node_repl__js`.
  - Headless exposes no browser-use, computer-use or presentations tools. Those plugins contribute only skills here: `plugins list` shows `mcp: none` for every plugin, and Browser Use needs `--browser-use headless`.
  - The two non-built-in tools, a JS REPL and a web reader, are general-purpose rather than "irrelevant to implementation".
- How verified: `arguments.ts` `extractDisallowedToolsArgs` (comma/space-separated, `web_search` → `WebSearch`, passed as `runtimeConfig.toolDisallowlist`) at v3.15.1. Live `tools1.out` vs `tools2.out`.
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence: `DISALLOWED_TOOLS = none`, and the wrapper passes no `--disallowedTools`. The mechanism is verified to cover plugin tools, so a list can be added if a later app version exposes browser/computer-use/presentation tools headless. The preamble stays the restriction.

## U7 — is the session saved on SIGTERM
- Answer: Yes. A SIGTERM to the CLI mid-stream ended it with exit code 143 and `Error: Turn was cancelled.`; the session id `sess_06d2ef73-…` was visible in the stream. `--resume sess_06d2ef73-…` with the PONG prompt then exited 0, with the same `sessionId` and `response` `PONG`.
  - The plan's 20 s probe was not a test: the "count to 300" run finished in under 20 s (exit 0, `result` event), so its SIGTERM hit an exited process. It was re-run with the timer at 6 s (`sigterm-probe6.mjs`).
- How verified: Ф1 Step 10 live (`long.out`, then `long6.out` + `long6.out.err`, then `resume-sigterm.out`).
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence: none. A retry after a timeout is still `--fresh`, and a cancelled job is never resumed.

## U8 — which plugins load headless; any auto-activation
- Answer: `zcode plugins list` (read-only) shows 13 plugins, all from `zcode-plugins-official`, every one with `hooks: 0, mcp: none`.
  - Enabled: visualize, node-repl-host, browser-use, documents, pdf, presentations, spreadsheets, image-search, plugin-creator, skill-creator, zcode-guide.
  - Disabled: ios-simulator, computer-use.

  A `--verbose` headless PONG with `--workflow-mode disabled` printed no plugin, hook or workflow line; the only stderr line was the benign built-in refresh warning. Plugins contribute skills (the `Skill` tool) and the `mcp__node_repl__js` tool, but nothing auto-activates.
- How verified: source `plugins-command.ts` (`list [--json] [--available]`; `zcode plugins --help` prints only the global help) at v3.15.1. Live `plugins-list.txt`, `verbose.err`.
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence: `INTERFERING_PLUGINS = none`; no user action needed.

## U9 — is the 1.5× ZCode quota bonus active
- Answer: Inconclusive. Three GLM requests (probe, E2E task, one resumed fix round) were expected to cost 30.241 credits at the standard rate; the console measured 10 (9 → 19). The ratio expected/measured is 3.02 at the standard rate, outside both interpretation bands. It is 1.51 if the window was off-peak and billed at 50 %, which would mean "active". The console does not show whether the window (11:48–11:53 UTC+8, Wednesday) was off-peak; only an unverified third-party source puts peak at 14:00–18:00 UTC+8 on weekdays. The console shows integer credits, but the conclusion holds across ±1: off-peak 1.37–1.68, standard 2.75–3.36. So the data fits "active, window off-peak", but the off-peak status was not verified.
- How verified: live acceptance, this file
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence: none for the protocol; measured in Ф5. To settle it, re-measure inside a known peak window, or once Z.ai documents its off-peak hours.

## U10 — prompt-size limit of `-p`; does `-p -` read stdin
- Answer: `-p` is a plain string option. Nothing reads stdin for `-p -`, so `-` would be sent as a literal one-character prompt. A 153,492-byte prompt (150 KiB) passed in argv answered `PONG` (exit 0, `inputTokens` 33200). The OS argv check printed `status 0 len 307200`.
- How verified: `arguments.ts` and `run.ts` at v3.15.1: `parsed.values.prompt` goes straight to `runPrompt`, and stdin is read only by the app-server/protocol paths. Live `p150.out` and the spawnSync argv check (`argv-check.txt`).
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence: `PROMPT_TRANSPORT = argv`, `MAX_PROMPT_BYTES = 204800`.

## U11 — what the desktop app sets as `ZCODE_APP_VERSION`
- Answer: The short version, `3.15.1`.
  - In `app.asar`, the `"ZCODE_APP_VERSION"` constant sits in the module that defines the build constant `yh="3.15.1"` (commit `f18d6db7`, built `2026-10-10T06:47:14.105Z`).
  - The main process uses `appVersion: Y||j.getVersion()`.
  - The only `3.15.1…` literal in the 341 MB asar is `"3.15.1"` (6×); `3.15.1.8093` never occurs.
  - The desktop app also sends `X-ZCode-App-Version: <appVersion>`.
  - The app was not running, so there was no `ps` sample.
- How verified: Ф1 Step 3 greps of `/Applications/ZCode.app/Contents/Resources/app.asar` (`ZCODE_APP_VERSION` context; literal count of `3.15.1.<n>` = 0). `plutil` gives `CFBundleShortVersionString` = `3.15.1` and `CFBundleVersion` = `3.15.1.8093`.
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence: `APP_VERSION_PLIST_KEY = CFBundleShortVersionString`, `VERIFIED_APP_VERSION = 3.15.1`.

## CLI data home — why the wrapper's CLI keeps its credentials and state out of `~/.zcode` (2026-10-14)
- Answer: The CLI's standalone login and the ZCode desktop app keep their Z.ai login in one credential store under one key, but store different token kinds there, so each login invalidates the other. The wrapper therefore gives the CLI its own credential store, and its own state directories wherever the CLI offers an override.
  - Both resolve the store as `<ZCODE_DATA_BASE_DIR, else $HOME>/.zcode/v2/credentials.json`, and both use the key `oauth:zai:access_token`.
  - The desktop app exchanges its OAuth token for a business token (`exchangeToken`) and stores the exchanged token in that key.
  - The CLI's `zcode login zai` stores its OAuth token there. Before every model request (`refreshBeforeModelRequest`) the CLI exchanges the stored token via `POST https://api.z.ai/api/auth/z/login`. With the desktop app's token in the key, that exchange fails with `project_token_login_failed`, so every CLI run fails. With the CLI's token in the key, the desktop app rejects it and asks the user to sign in again.
  - The CLI login stores no refresh token, so it also expires on its own; the CLI then fails the same way until the user logs in again (see "CLI login lifetime" below, which also covers the API-key mode that avoids the exchange).
  - `ZCODE_DATA_BASE_DIR` moves only the credential store. The headless path (`runPrompt` → `INn`) resolves its other state separately; each resolver and its override (bundle 3.15.1, env names exact):

    | State | Resolver | Default location | Override |
    |---|---|---|---|
    | Credentials | `Vta` | `~/.zcode/v2/credentials.json` | `ZCODE_DATA_BASE_DIR` (→ `<dir>/.zcode/v2/credentials.json`) |
    | Storage root: plugins, rollouts, memories (`<root>/cli/…`) | `storage.dir` in the merged config (`Fm` default), `K0` → `hU` | `~/.zcode` | `ZCODE_STORAGE_DIR` (env config `egn`, scope Env, above user and project config) |
    | Session database | `vae` → `LYo` (`storage.sessionDbPath`, `Fm` default; not derived from `storage.dir`) | `~/.zcode/cli/db/db.sqlite` | `ZCODE_SESSION_DB_PATH`, alias `ZCODE_SESSION_DB` (env config `egn`) |
    | Logs | `JB` → `xGs` | `~/.zcode/cli/log` | `ZCODE_LOG_DIR` (read from the env the headless entry passes) |
    | User config | `Ig` → `yLe` | `~/.zcode/cli/config.json` | none: only a programmatic `userConfigPath` / `skipUserConfig`; `parseGlobalArgs` has no flag for it, no env name exists, and `HOME` is ruled out |

  - The user config stays the CLI's normal shared file, also used by the desktop app's embedded agent. Every CLI run reads it; when it holds a legacy plugin id, the CLI rewrites it once in place (`cJs` → `lJs`, a temp file and rename). The design neither edits it nor isolates it.
  - Not covered by the overrides above (defaults seen in the bundle, not verified as used on this path): the workflow store `~/.zcode/cli/workflows` (the wrapper runs `--workflow-mode disabled`), the session mailbox `~/.zcode/mailbox` (only with `ZCODE_MESSAGE_ENABLED`; override `ZCODE_MAILBOX_ROOT`), and the model-telemetry device id `~/.zcode/v2/telemetry-state.json` (`Wnc`, telemetry only; override `ZCODE_HOME`).
- How verified:
  - Bundle `zcode.cjs` (3.15.1): the credential-path resolver `Vta` (`ZCODE_DATA_BASE_DIR`, else the home directory, joined with `.zcode/v2/credentials.json`); the credential key table (`zaiAccessToken: "oauth:zai:access_token"`); `refreshBeforeModelRequest` (around byte offset 14361400); the exchange request to `/api/auth/z/login` and its error code `project_token_login_failed` (around byte offset 4381206).
  - Bundle `zcode.cjs` (3.15.1), resolver table (read-only greps, ledger PC1-B1): `INn` (around byte offset 14332455) calls `Ig({env, userConfigPath, skipUserConfig, …})` and `JB({env})`, then `K0(config.storage.dir)` → `hU` (`<root>/cli`) and `LYo` → `vae` (`storage.sessionDbPath`); `Fm` (around 1364193) holds the defaults `storage: {dir: "~/.zcode", sessionDbPath: "~/.zcode/cli/db/db.sqlite"}`; `egn` (around 4185159) maps `ZCODE_STORAGE_DIR` / `ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB` into the Env scope (priority 40, above User 10 and Project 20); `JB` (around 4165465) takes `logDir ?? env.ZCODE_LOG_DIR ?? xGs()`; `yLe` (around 4178373) reads `userConfigPath ?? ~/.zcode/cli/config.json` and `lJs` rewrites it after the plugin-id migration; the headless entry takes `userConfigPath` / `skipUserConfig` only from injected deps, and `parseGlobalArgs` (bundle start) has no config-path flag; the CLI's env sanitizer (`C$t`) keeps all four override names.
  - Desktop app `app.asar`, `out/host/index.js`: `exchangeToken` stores the exchanged business token under the same key.
  - Live, 2026-10-14 (the Ф5 BLOCKED diagnosis): the desktop app's log `~/.zcode/v2/logs/2026-10-14.log` shows the desktop app rejecting the CLI-written token at 09:10:36; the user signed the desktop app in again at 09:10:59.
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence (plan Ф4a):
  - Every wrapper CLI run (task runner and `doctor --probe`; `login` until 0.10.0) sets `ZCODE_DATA_BASE_DIR=<ZCODE_STATE_DIR>/cli-home` (a directory the wrapper creates with mode 0700), `ZCODE_STORAGE_DIR=<cli-home>/.zcode`, `ZCODE_SESSION_DB_PATH=<cli-home>/.zcode/cli/db/db.sqlite` and `ZCODE_LOG_DIR=<cli-home>/.zcode/cli/log`, and drops an inherited `ZCODE_SESSION_DB`. The wrapper never edits the user's `~/.zcode` or the desktop app's files; the CLI's own read (and one-time migration) of `~/.zcode/cli/config.json` remains, because no override exists for it.
  - Historical (superseded in 0.10.0, see "CLI login lifetime"): the user logged the CLI in with `zcode-dispatch login`, which ran `zcode login zai` with the same allowlisted environment as task runs and re-pinned the model afterwards. 0.10.0 removed that verb, because the CLI login keeps no refresh token and lasts about an hour; the only auth is the Coding Plan API key (`zcode-dispatch api-key set`).
  - Sessions of CLI runs made before the change live in `~/.zcode/cli/db/db.sqlite` and cannot be resumed from the new session database. The CLI seeds the bundled official plugins into the new storage root itself (`Drc`, error code `ZCODE_PLUGIN_SEED_INCOMPLETE`); which plugins are enabled still comes from the merged config, including the shared user config. The U8 plugin list was read with the old storage root and is not re-verified for the new one.

## CLI login lifetime — why OAuth runs stop working, and the API-key mode (2026-10-14)
- Answer: The CLI's Z.ai OAuth login lives about one hour: measured on 2026-10-14, the server accepted it 59 min after the login and rejected it at 74 min, on an unchanged network with the desktop app closed. It cannot be renewed: the CLI keeps no refresh token, and it trades the stored login for a short-lived business token before every model request. Once the login is no longer accepted, every run fails before any model call, until the user logs in again. ZCode's own "Z.ai Coding Plan" provider template takes a Coding Plan API key instead and skips that exchange. The wrapper's `api-key` verb uses it.
  - **Observed** (cli-home of the wrapper; only file times, the CLI's log and the desktop app's log were read):
    - The user's `zcode-dispatch login` wrote `credentials.json` at 10:49:46 +07.
    - Successful model requests followed until 10:52:57 (probe, zt-0001, zt-0002).
    - Two `doctor --probe` runs at 12:05:43 and 12:06:00 failed. The CLI log shows `RuntimeHeadersRefreshError: project_token_login_failed` 4.5 s and 1.9 s after `model.request.started`, `retryable: false`, with no model call.
    - The CLI never rewrote `credentials.json` after the login.
  - **What the login stores.** `zcode login zai` (`loginZCodeCli`) polls `…/oauth/cli/poll/<flow>` (parser `Ota`). For Z.ai it saves only the raw OAuth access token, the ZCode JWT and the user info (`saveZaiLoginCredentials`). `Ota` reads an optional `refresh_token`, but only the BigModel branch stores it (`oauth:bigmodel:refresh_token`). The CLI parses no expiry for the login.
  - **No refresh path.** Nothing writes or reads `oauth:zai:refresh_token`; the key appears only in logout (`clearZaiLoginCredentials`). Nothing renews `oauth:zai:access_token`.
  - **The per-request exchange.** For a provider with `access.type === "zhipu-account"`, `refreshBeforeModelRequest` (`Coi`) runs before each model request:
    - it sends the stored token in `POST https://api.z.ai/api/auth/z/login {token}` (`fpt` with `ZaiBusinessTokenCache`);
    - then it resolves a project token.
    - The business token's expiry (JWT `exp` / `expires_in`) is cached in memory only, so every new CLI process exchanges again.
  - **One code for every exchange failure.** The resolver turns all of these into `project_token_login_failed`:
    - a non-zero `code` in the response, a missing token, or an already expired result;
    - HTTP 404;
    - network errors, the 15 s timeout, 429 and 5xx, whenever no cached business token exists — always true in a fresh CLI process.

    The code alone therefore cannot tell an expired login from a network failure.
  - **The desktop app cannot refresh a Z.ai login either.** Its `ZaiProviderAdapter` (app.asar) exchanges the OAuth token once at login and stores the resulting business token, with `expiresAt` from `expires_in`. Its `refreshToken` path throws `Z.AI OAuth 暂未提供 refresh token 交换接口，请重新登录` for adapters without a refresh method.
  - **Correlation with the desktop app on 2026-10-14.**
    - The app ran without interruption from 09:10:42 to 12:29:41 (one pid, then `app-quit`).
    - Its credential store `~/.zcode/v2/credentials.json` was last written at 09:10:59, before the CLI login (file time only).
    - Its log has no login, logout, token exchange or auth error between 10:40 and 12:10.
    - Its network worked at 12:04 and 12:06 (update checks through the system proxy). The last network trouble was 11:15–11:18 (`net::ERR_TUNNEL_CONNECTION_FAILED`, relay TLS errors).
    - So no desktop sign-in or refresh lines up with the 12:05 failure. The failures took 4.5 s and 1.9 s, not the 15 s timeout, which fits an HTTP answer better than a dropped connection.
  - **Network switches (the user's account).** The Mac's uplink moved:
    - from the iPhone hotspot to Wi-Fi shortly after 12:00, close to the first failure at 12:05:43;
    - back to the iPhone at about 13:30;
    - the iPhone link dropped at about 14:00.

    All requests went through the local proxy client's TUN interface (default route `utun7`; `api.z.ai` resolves to a 198.18.x fake IP).
  - **The 10:49 login is still rejected later.** On 14:24:57, with working internet (a neutral HTTPS host answered 200, uplink the iPhone hotspot at `172.20.10.x`), one probe on the unchanged 10:49 login failed with `project_token_login_failed` (4.4 s). A control probe through the HTTP proxy (`ZCODE_HTTP_PROXY=http://127.0.0.1:1082`) failed the same way (1.8 s). Neither cost credits.
    - So the token is not just hit by a transient network fault: the server stopped accepting it.
    - Two explanations remained. H1: a short lifetime, between 3 and 76 min. H4: the token is bound to the network or IP it was issued on, and the switch after 12:00 invalidated it. The third series decided for H1.
    - The desktop-revocation hypothesis has no supporting event.
  - **The network path matters for the OAuth mode (fresh login at 21:53:26, home Wi-Fi `192.168.1.x`, desktop app closed).**
    - 2 min after the login, a probe over the TUN path, without `ZCODE_HTTP_PROXY` as dev-orchestrator runs it, failed in 2.7 s with `project_token_invalid_response` (wrapper class `crash`). The exchange `/api/auth/z/login` had succeeded; the next step, the project token, returned a body the CLI's schema rejects.
    - The same probe through the HTTP proxy (`ZCODE_HTTP_PROXY=http://127.0.0.1:1082`) passed (20 s).
    - The desktop app logged the same code at 09:10:37, when the CLI's token sat in its store.
    - So on this network the two paths of the local proxy client reach Z.ai differently. The project-token API answers one of them with something other than its JSON contract.
    - The API-key mode is unaffected: it makes no project-token request, and its probe passed over the TUN path at 21:46.
    - The wrapper now classifies `project_token_*` as `auth` (it was `crash`), so the channel goes down at once with the remedy hint instead of one useless retry.
  - **The CLI rewrites its credential store on the first successful run after a login.** The store was written at 21:53:26 by the login and again at 21:55:38, during the first successful probe (presumably the project token it keeps in that store). The morning's `credentials.json` time 10:49:46 is likewise the first probe, not the login itself. The file time therefore marks the login only up to the first run.
  - **Lifetime measurement.** Method:
    - After the user's next `zcode-dispatch login`, a frozen copy of the v0.8.1 wrapper runs `doctor --probe` 2, 14, 29, 44, 59, 74, 89, 104 and 119 min after the `credentials.json` write, and stops at the first failure.
    - At each probe it records whether the desktop app runs, the desktop store's file time, the desktop log's auth lines, the local proxy port, the DNS answer for `api.z.ai`, the default interface, every interface's IPv4 and en0's router (`172.20.10.1` = the iPhone hotspot), so a network switch shows between probes.
    - The uplink stays unchanged during the series. A failure at a stable network and a repeatable time supports H1. A series that survives 119 min supports H4, which a deliberate switch followed by one probe then tests.
    - After a failure, one control probe runs with `ZCODE_HTTP_PROXY`.
    - The ZCode desktop app stays closed, so a revocation by the desktop app cannot occur.
    - First series (OAuth login of 10:49): not run; the login was already dead at 14:24 (see above).
    - Second series (login 21:53:26): the TUN-path probe failed at +2 min with `project_token_invalid_response`; the proxy-path control passed.
    - Third series (login 21:53:26): probes through the proxy path at +14, 29, 44, 59, 74, 89, 104 and 119 min, each preceded by a free TUN-path probe while that one kept failing. The uplink stayed on home Wi-Fi (`192.168.1.x`). The desktop app was not running, and its log had no auth line.
      - +14 min: the TUN-path probe passed, so the TUN path no longer failed and was not probed again.
      - +14, +29, +44, +59 min: the proxy-path probes passed (usage `input=14262`).
      - +74.1 min (23:07:29): the proxy-path probe failed with `project_token_login_failed` (3.3 s).
      - At 23:08 a TUN-path probe and a proxy-path probe both failed the same way. No probe after the failure cost credits.
    - **Result.** The OAuth login lasts more than 59.3 and at most 74.1 min, most likely one hour; the morning's failure at 76 min fits. Expiry, not the network switch or the desktop app, ends it. The project-token failure at +2 min was a separate path effect that did not recur.
    - Side effect, as predicted under "Design consequence": the frozen 0.8.1 copy re-pinned the OAuth selection and left the personal config at 0644, inside the 0700 state root. The next `doctor` of the new wrapper restored 0600 and the `zai-api` selection.
  - **API-key mode (the fix).**
    - ZCode's built-in config (`zcode-builtin.json` revision 31) declares the provider template `zai-api`, "Z.ai Coding Plan":
      - access `zhipu-coding-plan-api-key`, with `apiKeyManagementUrl` `https://z.ai/manage-apikey/apikey-list`;
      - API `anthropic-messages` at `https://api.z.ai/api/anthropic`;
      - `builtinModelIds` GLM-5.3 and GLM-5.3-Flash, both enabled in `templateModelRules`.
    - GLM-5.3-Flash takes the reasoning levels `low|high|max` from the model rule `.*glm-5\.3(?:-flash)?…`, whatever the provider.
    - A personal rule `{"providerId":"zai-api","templateId":"zai-api","config":{"group":"standard-personal","access":{"type":"zhipu-coding-plan-api-key","apiKey":"<key>"}}}` matches the personal schema (`GHi`): personal-only providers use the group `standard-personal`, and `account:` ids may not carry access.
    - ZCode's own provider creation derives the id `zai-api` from the template id (`aGi`). The CLI's legacy importer maps a `builtin:zai` API key to the same provider id and template.
    - The key order is the CLI's canonical one (`providers.toJSON`), so the CLI does not rewrite the file.
    - Such a provider skips the exchange: `createModel` attaches `refreshRuntimeHeadersBeforeAttempt` only for `access.type === "zhipu-account"`; otherwise the static `apiKey` is the request credential. The key is valid until the user revokes it on the key page.
    - The CLI keeps personal-provider API keys as plain text in the personal config and writes that file privately (`atomicWritePrivateTextFile`, mode 0600). There is no environment-variable indirection for a provider `apiKey`.
  - **The CLI's own manual API-key login is unreachable headless.**
    - It exists: `configureCodingPlanApiKey` stores the key encrypted under `account-provider:coding-plan:<provider>:account:<id>:api-key` with `auth-source` `manual`, and `refreshBeforeModelRequest` then uses that key directly.
    - It is wired only to the TUI command `/login zai-coding-plan-api-key <key>` (`configureApiKeyForTui`).
    - Headless `zcode login` accepts only `[zai|bigmodel] [--no-browser]`.
    - The embedded CLI ships without its TUI.
    - The bundle is an entry point that runs `main`, not a library.
  - `zcode doctor` prints version and runtime facts only; no CLI verb checks the login without a model request. A failed exchange happens before the model request and costs no quota.
  - **Verified live at 21:46–21:47 +07.** The user ran `api-key set` with the hidden prompt. Then `doctor --probe` through the new wrapper (released as 0.10.0), without `ZCODE_HTTP_PROXY`, gave:
    - `ok personal-config … pins GLM-5.3-Flash$max via zai-api`, `ok auth: Coding Plan API key …`, `doctor: ok`;
    - `model-selected: ok`, `answers: ok`, `usage: input=14256 cached=0 output=5`, `probe: ok`.

    The CLI log shows `providerId: zai-api`, `modelId: GLM-5.3-Flash`, `baseURL: https://api.z.ai/api/anthropic`, provider kind `anthropic`, one attempt, and no runtime-header refresh or project-token event, so no exchange took place. The personal config was 0600 and the state root 0700. The requested reasoning level does not appear in the CLI's JSONL log; the pin carries `max`. It was not confirmed separately for `zai-api` (U1 confirmed it for the account provider from a stream run).
  - **Open:** whether Coding Plan quota accounting, including the ZCode bonus (U9), differs between API-key and account requests. The CLI classifies `zhipu-coding-plan-api-key` as a Coding Plan access (`TUs`).
- How verified:
  - Read-only greps of the bundle `zcode.cjs` (3.15.1), byte offsets approximate:

    | Function | Offset |
    |---|---|
    | `ZaiBusinessTokenCache` | 4380492 |
    | the exchange `fpt` with `/api/auth/z/login` | 4383406 |
    | `Ota` | 4387138 |
    | `saveZaiLoginCredentials` | 4393655 |
    | the account-only `refreshRuntimeHeadersBeforeAttempt` in `createModel` | ~4150775 |
    | `Coi` / `refreshBeforeModelRequest` | 14361940 |
    | `persistStandaloneCodingPlanConnection` | 14364876 |
    | `loginZCodeCli` | 14367675 |
    | `configureCodingPlanApiKey` | 14369927 |
    | the `zcode login` usage | 15003098 |
    | `/login …-api-key` | 15041890 |
    | `configureApiKeyForTui` | 15092849 |
    | the personal schema `GHi` | ~547171 |
    | `aGi` | 570503 |
    | `atomicWritePrivateTextFile` | 522789 |

  - The app's `zcode-builtin.json`: the templates `zai-api`, `zai-standard-api`, `bigmodel-api`, plus `templateModelRules` and `modelRules`.
  - Desktop `app.asar`: `ZaiProviderAdapter` (around 280732192) and the OAuth service's `refreshToken`.
  - The CLI log `<cli-home>/.zcode/cli/log/zcode-2026-10-14.jsonl` (event names, timestamps and error messages; long token-like strings masked).
  - The desktop log `~/.zcode/v2/logs/2026-10-14.log` (auth-related lines, masked).
  - File times of both credential stores. No credential file was opened, no token decoded, no login or logout run, no Z.ai API call made.
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence (wrapper 0.10.0):
  - The OAuth login is dropped: there is no `login` verb, and the Coding Plan API key is the only auth. `PINNED_SELECTION` is `zai-api` / GLM-5.3-Flash / `max` (U1 pinned the account provider).
  - `zcode-dispatch api-key set` reads the user's key from stdin only (a pipe, or a hidden prompt where only Enter accepts and Ctrl-C / Ctrl-D cancel), never from an argument or a variable. A key consists of `A–Z a–z 0–9 . _ -`, 8–512 characters, so JSON escaping at any depth leaves it unchanged. `set` refuses when the app's built-in config lacks the `zai-api` template (`apiKeyTemplateProblem`). It writes the rule above with the pin into the wrapper's personal provider config. `api-key clear` removes the rule, which switches the channel off. Neither verb prints the key; a bad stdin is described by its shape only.
  - Only `api-key set` and `api-key clear` write the personal config, by atomic rename with mode 0600, after removing temp copies a crash may have left (they can hold a key); a failed write removes its own temp copy. Runs (task runner, probe) and `doctor` only read it, and restore the modes (state root 0700, file 0600) with `chmod`. The selection therefore cannot be lost by concurrent runs. The pin check is structural, so a reformatted file still counts as pinned.
  - A kernel lock serializes the config (`<file>.lock`): a flock(2) lock. On macOS, `open(2)` takes it atomically with `O_SHLOCK` / `O_EXLOCK` (Node passes these flags through); on Linux (0.11.0), the wrapper opens the file and `flock(1)` from util-linux locks that descriptor, passed to it as fd 3 — the lock belongs to the shared open file description and stays after `flock(1)` exits. The lock belongs to the open file description, and the kernel drops it when the last descriptor closes, also when a process dies, so it never goes stale. A run (task runner, probe) takes it shared before it reads the config and hands the descriptor to the CLI as fd 3. The CLI keeps the lock held, also during a cancel's grace period and after the runner itself was killed, and the runner keeps its own copy until the CLI's streams are closed. ZCode's tool processes do not inherit it: the CLI spawns them with three stdio descriptors (`NodeExecutionAdapterProcess.prepareChildSpawn`), and libuv passes on nothing else (macOS; on Linux checked 2026-10-20: a grandchild spawned with three stdio pipes holds only fds 0–2). Their output reaches the wrapper only through the CLI, so the key is frozen for as long as anything can still reach the wrapper's log or record. A leftover tool process can read a later key, but it cannot write to the wrapper's log any more (Astra review, round 2). `api-key set` and `api-key clear` take it exclusive (2 s wait) and otherwise refuse with exit 2, pointing at `lsof <file>.lock`. So the key the CLI reads is the one its redactor was built with, every writer is serialized, and the temp sweep cannot hit a live write. No pid is involved, so pid reuse and unreadable job state cannot weaken it (Astra review of PR #5). On any platform other than macOS and Linux, or on Linux without `flock(1)`, the lock refuses to run and `doctor` fails its `platform` check.
  - The wrapper scrubs the key from everything it keeps or prints (`keyRedactor`): CLI stdout, the parsed response, line-buffered stderr, the job log and the probe's stderr tail. As defense in depth, the redactor re-checks the file on every call and replaces every key it has seen, longest first. When the job finalizes, the wrapper closes the CLI's stdout and stderr, so a descendant that keeps them open cannot append to the job log any more. It cannot catch a transformed key, for example an encoded one. GLM's shell can read the personal config, whose path is in the CLI's environment, as it can read any file of the user; the preamble's no-credentials rule is the only guard against that.
  - Without a key, `doctor` fails `auth`, `task` refuses (exit 2), and a runner whose key was cleared after queueing finalizes the job `failed/auth` without spawning the CLI (the CLI would otherwise fall back to another model). Likewise, without the pin it is `FAIL personal-config`, exit 2, or `failed/model-not-selected`; the probe checks the file the same way under its shared lock before it spawns. The remedy is `api-key set` in every case.
  - `doctor` keeps the two `auth` failures apart:
    - `no Coding Plan API key` — the user stores one;
    - `ZCode template incompatible` — the app's built-in config lost or changed `zai-api`, a new key does not help, and the wrapper needs an update.

    The probe's auth hint names the remedy `api-key set`. `project_token_*` classifies as `auth`.
  - Job records carry `provider: zai-api`. A resume of a job recorded without it (made before 0.10.0, on the OAuth account provider, whose session keeps that provider) is refused with "dispatch --fresh".
  - Every installed wrapper copy must be at least 0.10.0 once a key is stored (observed on 2026-10-14; see "Lifetime measurement"). An older wrapper, 0.9.0 included, keeps the key rule but pins the account provider (OAuth) again and rewrites the file with the default mode (0644 under umask 022). A 0.10.0 `api-key set` restores the pin; any 0.10.0 run or `doctor` restores the modes.

## Environment — what the CLI and its tools read (added after Ф2)
- Answer:
  - **The Bash tool inherits the CLI's whole environment.** The tool's execution env (bundle `Hsn`) starts as a copy of the CLI's `process.env`. It then drops the proxy and CA keys, re-adds them from `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`, and applies the CLI's network settings (`applyNetworkEgressEnv`): `HTTP_PROXY HTTPS_PROXY ALL_PROXY` and their lower-case forms from `network.httpProxy` or `ZCODE_HTTP_PROXY`, `NO_PROXY` from `ZCODE_NO_PROXY`, and `NODE_EXTRA_CA_CERTS SSL_CERT_FILE REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO` from `ZCODE_AGENT_CA_CERT`. Last come UTF-8 locale defaults and `PYTHONIOENCODING`/`PYTHONUTF8`. Whatever the wrapper passes, GLM's shell commands see.
  - **The CLI's own HTTP client never uses `HTTP(S)_PROXY`.** At startup (`applyCliRuntimeEnvSanitization`) the CLI moves `HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO` (plus `npm_config_*`/`yarn_*`/`pnpm_*` proxy and CA keys) out of its own environment into `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`, for its tools only. Its own requests resolve a proxy from `network.httpProxy` or `ZCODE_HTTP_PROXY`. `ZCODE_HTTP_PROXY` is passed to the CLI by the wrapper's allowlist.
  - **Credentials** live in `${ZCODE_DATA_BASE_DIR ?? os.homedir()}/.zcode/v2/credentials.json` (`Vta`). The wrapper always sets `ZCODE_DATA_BASE_DIR=<ZCODE_STATE_DIR>/cli-home`; without that wrapper override, the CLI uses its home directory. The values are AES-256-GCM. The key is `ZCODE_CREDENTIAL_SECRET` when set, else `zcode-credential-fallback:<platform>:<os.homedir()>:<username>` (`resolveCredentialSecret`; the username comes from `os.userInfo()`, not from the environment). The wrapper passes `HOME` unchanged; its explicit data-base override keeps credentials in cli-home.
  - **State location:** the wrapper always sets `ZCODE_STORAGE_DIR=<cli-home>/.zcode`, `ZCODE_SESSION_DB_PATH=<cli-home>/.zcode/cli/db/db.sqlite` and `ZCODE_LOG_DIR=<cli-home>/.zcode/cli/log`. Outside the wrapper, `ZCODE_STORAGE_DIR` defaults to `~/.zcode`; `ZCODE_BETA=1` or `ZCODE_ENV=beta` switch that default to `~/.zcode-beta`. The wrapper's explicit storage root takes precedence.
  - **`.env` loading:** in a prompt run, `login` and `logout` alike, `loadCliDotenv` calls `findDotenv`, which walks from the working directory up to `/` and loads the first `.env` it finds (dotenv, `override: false`). With no `.env` in the repository, one in a parent directory (for example `~/.env`) is loaded. This is outside the wrapper's environment filter.
  - Other names the bundle reads directly: `PATH HOME SHELL XDG_CACHE_HOME XDG_DATA_HOME DEBUG NODE_ENV ZCODE_DEBUG ZCODE_GIT_BINARY TASK_MAX_OUTPUT_LENGTH`.
  - **Provider fallbacks:** the bundled AI SDK providers fall back to `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` and `OPENAI_BASE_URL` / `OPENAI_API_KEY` when a provider's settings carry no base URL or key. The live runs show the Z.ai provider sets `baseURL` (`https://api.z.ai/api/anthropic`, U1), so these were unused there. The wrapper drops `ANTHROPIC_*` and `OPENAI_*` by default; a user can explicitly opt a name back in with `ZCODE_ENV_PASSTHROUGH`.
  - Observed on this machine: the Claude Code session that wrote this section had `HTTPS_PROXY` in its environment but not `ZCODE_HTTP_PROXY`, although `launchctl getenv ZCODE_HTTP_PROXY` returned a value.
- How verified: read-only searches of the bundle `zcode.cjs` (named functions `sanitizeZCodeRuntimeEnv`, `buildZCodeToolEnvPassthroughEnv`, `applyNetworkEgressEnv`, `applyProxyEnv`, `applyCaEnv`, `resolveCredentialSecret`, `loadCliDotenv`, `findDotenv`, `applyBetaStorageDefault`; the AI SDK's `environmentVariableName` fallbacks). No CLI run; nothing under `~/.zcode` was read.
- Holds for: ZCode 3.15.1 (zcode 0.16.9)
- Design consequence: the wrapper passes an allowlist, not the caller's environment (plan C5; constants `ENV_ALLOW`, `ENV_ALLOW_PREFIXES`, `ENV_DENY`, `ENV_PASSTHROUGH_VAR`). `HOME` and `ZCODE_CREDENTIAL_SECRET` are passed so that the CLI can use its credential key, and `ZCODE_DATA_BASE_DIR` is always set to cli-home. `ZCODE_HTTP_PROXY`, `ZCODE_NO_PROXY` and `ZCODE_AGENT_CA_CERT` cover the CLI and its tools; the plain proxy/CA variables cover the tools. `ANTHROPIC_*` and `OPENAI_*` are denied by default, closing the provider fallbacks above; explicit `ZCODE_ENV_PASSTHROUGH` names opt in to additional variables. The `.env` the CLI loads is outside the wrapper's control (plan R9).
- Wrapper enforcement: `ENV_ALLOW` contains process basics, proxy/CA variables, selected CLI `ZCODE_*` settings and toolchain locations; `LC_*` and `XDG_*` pass only when `ENV_DENY` does not match. `ZCODE_ENV_PASSTHROUGH` accepts comma- or space-separated valid variable names; an invalid name refuses `task` with exit 2 and makes the `doctor env` check fail. Explicit names pass even when secret-like, and the job log records passed names without values. `doctor env` warns when an HTTP(S) / ALL proxy is present but `ZCODE_HTTP_PROXY` is not. `login` used the same filtered environment until 0.10.0 removed it; `PATH` and `HOME` remain available for Node. After filtering, the wrapper's provider, personal-config and cli-home settings override inherited or passed values. `ZCODE_SESSION_DB` is always dropped because the CLI gives that alias precedence over `ZCODE_SESSION_DB_PATH`.
- Historical wording: this allowlist supersedes the plan and spec drafts' earlier “inherited env” wording; those archived documents remain unchanged.

## Linux — install layout, version source, config lock (2026-10-20, 0.11.0)

- Releases: the GitHub releases of `zai-org/ZCode` (v3.14.3) carry only macOS and Windows assets, but Z.ai's site <https://zcode.z.ai> ("All Downloads") ships an official Linux beta: `ZCode-<ver>-linux-{x64,arm64}.{deb,rpm,AppImage}` from `https://cdn-zcode.z.ai/zcode/electron/releases/<ver>/linux-<arch>/` (3.16.2 on 2026-10-20).
- Official `.deb` 3.16.2 (arm64, package `zcode` `3.16.2-8769`, sha256 `35bc72a8b9316703eca135f336e486a39740c9a3344423ead2e2038502c17cf0`): installs into `/opt/ZCode` with `resources/glm/zcode.cjs` (CLI 0.17.0), `resources/config/provider/zcode-builtin.json` and `resources/app.asar`, i.e. the wrapper's default `ZCODE_APP`; `postinst` links `/usr/bin/zcode` to the Electron launcher `/opt/ZCode/zcode` (not the CLI). Installed with `dpkg -i --force-depends` in `node:26-bookworm`: `doctor` → `ok app: /opt/ZCode 3.16.2`, `WARN app-version` (verified 3.15.1), everything else ok except the missing key; `api-key set` accepted the `zai-api` template of 3.16.2; `doctor --probe` with a fake key reached Z.ai → `FAIL(auth)`. A real-key acceptance on 3.16.2 is still to be run before `VERIFIED_APP_VERSION` moves.
- All six official 3.16.2 Linux packages (2026-10-20), sha256: arm64 `.deb` `35bc72a8…17cf0`, arm64 `.rpm` `45fc2320…cb0b0`, x64 `.deb` `31ba7519…6abbc`, x64 `.rpm` `12394908…76422`, x64 `.AppImage` `823f3c02…fd98`, arm64 `.AppImage` `b6dcd328…58945`. Extracted without running, every package holds the same `glm/zcode.cjs` (sha256 `a055234a6ca3…`), the same `zcode-builtin.json` (`361b778f8949…`) and `app.asar` version 3.16.2. `.deb` and `.rpm` install into `/opt/ZCode/resources`; the `.AppImage` holds the same tree under `squashfs-root/resources`. Runtime checks (`check.sh`: CLI version, `doctor`, fake-key `doctor --probe`), each giving CLI 0.17.0, `ok platform`, `ok app … 3.16.2`, `WARN app-version`, and a probe that reached Z.ai → `FAIL(auth)`:
  - `.deb` arm64 on Debian 12, installed with `dpkg -i --force-depends`;
  - `.deb` x64 on Debian 12 under Docker's amd64 emulation;
  - `.rpm` arm64 on Fedora 42, installed with `rpm -i --nodeps`. The official Node binary needed `libatomic` there; that is a property of Node, not of ZCode. `flock` is in `util-linux-core`. `postinst` printed a harmless `unshare failed` from its user-namespace probe inside the container;
  - `.AppImage` arm64, `--appimage-extract` as a non-root user with no FUSE, then `ZCODE_APP=<dir>/squashfs-root`.
  - The x64 `.AppImage` could not be executed under Docker's amd64 emulation (`Exec format error`): type-2 AppImages carry `AI\x02` in the ELF header padding (bytes 8–10), which the emulator's binfmt match rejects. A native x64 kernel ignores those bytes. Its contents equal the other packages'.
- Layout: electron-builder's `extraResources` put `config/provider/zcode-builtin.json` into the resources directory on every platform (`process.resourcesPath`), beside `glm/` and `app.asar`: `Contents/Resources` in the macOS bundle, `resources/` beside the executable elsewhere. `/opt/<productName>` is the deb/rpm default, so the wrapper defaults to `ZCODE_APP=/opt/ZCode` on Linux.
- Version: `extraMetadata.version = buildMetadata.appVersion` writes the app version into `app.asar`'s `package.json`. On this Mac, reading that entry from the asar header gives `3.15.1`, the same as `CFBundleShortVersionString`. The wrapper reads it on Linux (`readAsarVersion`, no dependency; an `unpacked` entry is read from `app.asar.unpacked/`).
- The CLI is portable: `zcode.cjs` is one JavaScript bundle whose only storage dependency is Node's built-in `node:sqlite`; native binaries ship only inside optional plugins (`zcode-cua-plugin`: koffi, sharp), none of which load headless (U8).
- Earlier live check (before the official package was known) in `node:26-bookworm` (Node v26.12.0, util-linux 2.38.1, non-root), with this Mac's `glm/`, `zcode-builtin.json` and `app.asar` copied to `/opt/ZCode/resources`: `zcode.cjs --version` → `0.16.9`; `zcode-dispatch doctor` → `ok platform: linux (config lock: flock(1))`, `ok app: /opt/ZCode 3.15.1`, every other check ok except the missing key; with a syntactically valid fake key, `doctor --probe` reached `https://api.z.ai/api/anthropic`, got `{"error":{"message":"身份验证失败。","type":"1000"}}` and classified it `FAIL(auth)` with the api-key hint. The full offline suite `tests/test-zcode-dispatch.sh` passes there as well as on macOS. A PONG with a real key on Linux is still to be run.
- Config lock: Node has no flock call and Linux has no `O_SHLOCK`/`O_EXLOCK`, so the wrapper opens `<file>.lock` and runs `flock --shared|--exclusive --nonblock 3` with that descriptor as the child's fd 3. flock(2) locks belong to the open file description, so the lock stays held by the wrapper's (and later the CLI's) descriptor after `flock(1)` exits. Exit 1 means another holder (util-linux and busybox alike); any other exit or a missing `flock` is an error. A grandchild spawned by a Node child with three stdio pipes holds only fds 0–2 on Linux too, so ZCode's tool processes do not keep the lock. The lock assumes the state directory is on a local filesystem: on NFS, depending on the mount options, flock(2) locks may be local to one client, so machines sharing one state directory would not see each other's locks. `task` checks for `flock(1)` up front and refuses with exit 2 instead of starting a job that fails in the runner.
- Not supported: Windows (no flock, no process groups or POSIX signals, ACLs instead of modes) — `doctor` fails `platform`.

## GLM-5.3 as a second pin (0.14.0, 2026-11-01, not checked live)

- `zcode-dispatch task --model GLM-5.3` runs on GLM-5.3 `max` through the same `zai-api` template: its `builtinModelIds` list GLM-5.3 and GLM-5.3-Flash, and the model rule `.*glm-5\.3(?:-flash)?…` gives both the levels `low|high|max` ("CLI login lifetime").
- The CLI still has no model flag (U1), so each model gets a personal provider config of its own: `personal-provider-config.json` (GLM-5.3-Flash, unchanged) and `personal-provider-config.glm-5.3.json`, both holding the same key rule. One config lock (`personal-provider-config.json.lock`) covers both; `api-key set` / `clear` write both under it, and `api-key sync` copies a stored key into the second file. Runs only read their own model's file.
- A resume keeps the model of the job it resumes (U1: a session restores its bound selection).
- Live acceptance pending: `doctor --probe --model GLM-5.3`, then one task; the stream run should name `"modelId":"GLM-5.3"`. An invalid pin would fall back silently (U1), so the probe alone does not prove it.

## Inputs for later phases

| Key | Value | Evidence |
|---|---|---|
| VERDICT | GO | U1 |
| MODEL_MECHANISM | personal-config | U1 |
| SELECTION_PATH | config.defaultModelSelection | U1 |
| PERSONAL_CONFIG_BASE | {"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}} | U1 |
| PINNED_SELECTION | {"providerId":"zai-api","modelId":"GLM-5.3-Flash","options":{"reasoningLevel":"max"}} (0.10.0; U1 pinned the account provider `account:zai-individual-coding-plan`) | U1; CLI login lifetime |
| API_KEY_TEMPLATE_ID | zai-api | CLI login lifetime |
| API_KEY_PROVIDER_ID | zai-api | CLI login lifetime |
| API_KEY_ACCESS_TYPE | zhipu-coding-plan-api-key | CLI login lifetime |
| RESUME_KEEPS_MODEL | yes | U2 |
| REPORTED_MODEL_FIELD | none | U3 |
| USAGE_INPUT_FIELD | inputTokens | U3 |
| USAGE_CACHED_FIELD | cacheReadTokens | U3 |
| USAGE_OUTPUT_FIELD | outputTokens | U3 |
| USAGE_REASONING_FIELD | none | U3 |
| CACHED_IS_SUBSET_OF_INPUT | yes | U3 |
| PROMPT_TRANSPORT | argv | U10 |
| MAX_PROMPT_BYTES | 204800 (macOS); 122880 on Linux, whose MAX_ARG_STRLEN caps one argument at 131072 bytes including its NUL (checked 2026-10-20: 131071 ok, 131072 E2BIG) | U10, "Linux" |
| VERIFIED_APP_VERSION | 3.15.1 | header |
| VERIFIED_NODE_MAJOR | 26 | header |
| APP_VERSION_PLIST_KEY | CFBundleShortVersionString | U11 |
| DISALLOWED_TOOLS | none | U6 |
| GLM_CONCURRENCY | 2 | U5 |
| SESSION_SAVED_ON_SIGTERM | yes | U7 |
| INTERFERING_PLUGINS | none | U8 |
| PATTERN_MODEL_NOT_SELECTED | Select a model before continuing;Model creation failed | U4 |
| PATTERN_AUTH | 401;unauthorized;not logged in;login;token expired;credential;authentication failed;project_token_ | U4; CLI login lifetime |
| PATTERN_QUOTA | 429;quota;rate limit;usage limit;insufficient;balance;usage_limit_exceeded;spend_limit_exceeded;coding_plan_required | U4 |
| PATTERN_LAUNCH | ZCODE_BUILTIN_PROVIDER;provider config;Cannot find module;Cannot find package;Failed to load environment file;ZCode app factory is unavailable;Provider Registry runtime is unavailable | U4 |

## Live acceptance (2026-10-14, ZCode 3.15.1)

| Check | Result |
|---|---|
| `doctor` | ok — every check `ok` (app 3.15.1, cli, provider-config, node v26.11.0, app-version 3.15.1, git, state-dir, cli-home, personal-config pins GLM-5.3-Flash$max, kill-switch), `doctor: ok` |
| `doctor --probe` | `probe: ok`; `reported-model: unreported`; `usage: input=14347 cached=320 output=4` |
| E2E first round (zt-0001) | `DONE`; report written yes; commits after = 1 yes; node --test pass (1/1) |
| Fix round (zt-0002) | resume (`--resume-task zt-0001`); `DONE`; same sessionId yes (`sess_bff347a4-…`); `## Fix round 1` appended yes; node --test pass (2/2) |
| Baseline / second reading | 9 → 19 (measured 10 credits; 5-hour counter 0 → 10; a second reading 3 min later was identical); local time 2026-10-14 10:48–10:54 +0700 (11:48–11:54 UTC+8), Wednesday; peak / off-peak undetermined (the console does not say; an unverified third-party source gives peak = 14:00–18:00 UTC+8 weekdays, which would make this off-peak) |
| Expected credits | 30.241 (formula of spec §8.2 step 4; halved: undetermined, since off-peak status is unverified; 15.121 if halved) |
| Ratio expected / measured | 3.02 at the standard rate (inconclusive); 1.51 if off-peak (active) → inconclusive |

Usage objects: probe `usage: input=14347 cached=320 output=4`; zt-0001 `{"source":"provider","modelRequestCount":9,"inputTokens":153107,"outputTokens":2098,"totalTokens":155205,"cacheReadTokens":130304,"cacheWriteTokens":0,"reasoningTokens":0,"webFetchRequests":0,"webSearchRequests":0}`; zt-0002 `{"source":"provider","modelRequestCount":8,"inputTokens":174195,"outputTokens":2704,"totalTokens":176899,"cacheReadTokens":169280,"cacheWriteTokens":0,"reasoningTokens":0,"webFetchRequests":0,"webSearchRequests":0}`.

Notes:
- The console shows credits as integers, so measured = 10 ± about 1.
- The console's "Cumulative Tokens" rose only from 174.27K to 188.62K (+14.35K), although the three requests reported 341,649 input tokens, and the probe alone reported 14,347. That statistic does not track every billed token, or counts differently, so it was not used in the calculation.
- The Step 3 probe first failed twice with `FAIL(auth)` (`project_token_login_failed`): the desktop app had replaced the CLI's token in the shared `~/.zcode` store. Those attempts cost no credits. After Ф4a (the wrapper's own CLI home) and the user's `zcode-dispatch login`, the run above needed no `ZCODE_HTTP_PROXY`.
