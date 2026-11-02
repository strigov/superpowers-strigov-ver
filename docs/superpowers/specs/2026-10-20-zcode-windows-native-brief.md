# Native Windows support for zcode-dispatch — brief for a session on a Windows PC

Status: done in 0.16.0 (2026-11-03): see "Windows" in `docs/zcode-cli-findings.md`. It differs from this brief in two ways. The config lock needs no reader emulation, because a plain open is already a shared holder under share modes. Processes reuse agent-dispatch's process helper (a Job Object per run) instead of `taskkill /T`. Prerequisite: 0.11.0 (Linux support, branch `feat/zcode-linux`). Written on macOS on 2026-10-20 from source reading only. Nothing here was checked on Windows: every "verify" item has to be run on the Windows machine before code depends on it.

## Goal

`zcode-dispatch doctor` passes on native Windows (not WSL), with the official `ZCode-<ver>-win-x64.exe` installed. `task / status / result / cancel / release-stale / api-key` keep the guarantees they have on macOS and Linux, and `tests/test-zcode-dispatch.sh` passes under Git Bash, which is the shell Claude Code uses on Windows. When a guarantee cannot hold on Windows, refuse with a clear message rather than weaken it silently.

## What carries over unchanged

- **The CLI.** `zcode.cjs` is plain JavaScript and uses Node's built-in `node:sqlite`. Native binaries ship only inside optional plugins, and none of those load headless (findings U8, and "Linux").
- **The resources layout.** electron-builder puts `glm/`, `config/provider/zcode-builtin.json` and `app.asar` into `resources/` on every platform. `zcodePaths()` already uses `<ZCODE_APP>/resources` off macOS.
- **The version source.** `readAsarVersion(<resources>/app.asar)` works on any OS, so a `win32` entry in `DEFAULT_APP` is enough.
- **The bash shim** `bin/zcode-dispatch`. Git Bash has `ls`, `sort -V` and `dirname`. Verify `sort -rV` on the Git Bash in use.
- **Job records, reservations (link/rename), env allowlist, redaction.** These are pure Node fs. Verify that the `linkSync` claim (`finalizeRecord`) works on NTFS. Hard links should work on NTFS.

## What must change (by risk)

0. **Where to get it.** Z.ai's site <https://zcode.z.ai> ("All Downloads") ships `ZCode-<ver>-win-{x64,arm64}.exe` (3.16.2 on 2026-10-20). The GitHub releases lag behind (v3.14.3).
1. **The default install path.** It is probably `%LOCALAPPDATA%\Programs\ZCode` (electron-builder NSIS per-user default). ZCode patches its NSIS install section (`packages/desktop/scripts/patch-nsis-install-section.mjs`), so read that script and confirm on the machine. Look for `resources\glm\zcode.cjs`, `resources\config\provider\zcode-builtin.json` and `resources\app.asar`.
2. **The prompt transport. This is the biggest functional gap.** The CLI's `-p` is a plain string and does not read stdin (U10). Windows limits a command line to 32,767 UTF-16 characters, while `MAX_PROMPT_BYTES` is 200 KiB today. Options:
   - (a) Set a win32 `MAX_PROMPT_BYTES` of about 30 000 characters, measured as UTF-16 length, not bytes. The existing dev-orchestrator rule then moves larger prompts to Luna fresh, announced.
   - (b) An indirection: a short `-p` that tells GLM to read the full prompt from a file in the job dir. This changes what GLM sees and needs a live check that the headless preamble is still honoured.
   - Recommend (a) first. Measure the real limit with `node` spawning `node` and no shell.
3. **The config lock.** Windows has no flock and no `O_SHLOCK`/`O_EXLOCK`. Node opens files with full sharing. libuv honours `UV_FS_O_EXLOCK` (`0x10000000`) on Windows by opening with share mode 0, but that gives an exclusive lock only. Shared readers have to be emulated. Proposal:
   - **Run:** create `<lock>.d/<run-id>` and open it with `UV_FS_O_EXLOCK`. Hand that descriptor to the CLI as fd 3. libuv passes extra stdio fds on Windows through the CRT `lpReserved2` block; verify that the CLI really holds the handle after the runner dies. Then check that no writer gate file exists.
   - **api-key set / clear:** create the writer gate exclusively (`wx`). Then try to delete every `<lock>.d/*` entry. A file opened with share mode 0 cannot be deleted, so any failure means a live holder: remove the gate and refuse. Afterwards write the config and remove the gate.
   - The ordering (reader announces before it checks the gate; writer takes the gate before it checks the readers) gives mutual exclusion without pids. A stale gate left by a crashed writer needs a recovery path, for example a gate opened with `UV_FS_O_EXLOCK` and held for the writer's lifetime, so that "cannot delete" means "alive".
   - Verify: kill the runner with `taskkill /F` and confirm the CLI still blocks `api-key set`. Confirm that a grandchild started by the CLI does not inherit the handle.
4. **Process groups and signals.** Windows has no `kill(-pgid)` and no SIGTERM: Node's `kill()` is `TerminateProcess`.
   - `killGroup` becomes `taskkill /PID <pid> /T /F`. It needs a tree, so the CLI's descendants must still be attached; check what `detached: true` does on Windows (a new console, not a new group).
   - `groupAlive` becomes a pid liveness check, plus a tree check through `tasklist` or `wmic`/CIM, whichever is available without extra installs.
   - Cancel is always a hard kill. The session-save-on-SIGTERM behaviour (U7) does not apply, and a cancelled job is never resumed anyway.
   - `TIMEOUT_KILL_GRACE_MS` / `CANCEL_GRACE_MS` lose meaning: keep them, and document that they are a no-op on Windows.
5. **The boot id.** Read `BootId` (a counter incremented on each boot) from `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters` with `reg query`. Verify that it exists on the target Windows build and that a normal user can read it. Without it the boot stays `unknown`, which the code already handles safely: nothing is signalled by a stored pid.
6. **File modes.** `chmod 0600/0700` is a no-op on Windows. The state root lives under `%USERPROFILE%\.claude\…`, whose inherited ACL already limits access to the user, SYSTEM and Administrators. Confirm with `icacls`. Keep the chmod calls. Skip the mode assertions on win32 in the tests and replace them with an `icacls` check that no other principal has access.
7. **The `doctor` platform check.** Report `ok platform: win32 (config lock: exclusive handles)` once items 3–5 work. Until then, keep the current `FAIL platform: win32: zcode-dispatch supports darwin and linux only`.
8. **The test suite.** It uses `kill`, `pkill`, `sleep`, process groups, `umask`-based modes and `/proc`. Expect a win32 branch for signal-, group- and mode-based assertions. Add Windows-only tests for the lock emulation (item 3) and the argv limit (item 2).

## Do not

- Do not fall back to WSL silently. WSL already works as Linux, so document it as the alternative instead.
- Do not add a pid-based lock. The design rejects pids for the config lock (Astra review of PR #5).
- Do not install third-party ZCode CLI builds (for example the npm package `zcode-app-cli`). Only Z.ai's own app counts.

## Live acceptance on Windows

Run `doctor`, then `doctor --probe` with the user's real key (it spends one PONG of quota), then one E2E task and one fix round with `--resume-task`, as in "Live acceptance" in `docs/zcode-cli-findings.md`. Record the results in a new "Windows" section of that file.
