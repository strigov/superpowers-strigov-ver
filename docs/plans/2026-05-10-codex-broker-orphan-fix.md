---
slug: codex-broker-orphan-fix
created: 2026-05-10
status: in-progress
phases:
  - id: Ф1
    scope: "broker core changes: shutdown promise, heartbeat, remove detached:true, parentPid, scanOrphanBrokers"
    status: done
  - id: Ф2
    scope: "integration test, SKILL.md update, full test suite verification"
    status: in-progress
---

# Codex Broker Orphan Process Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dev-orchestrator (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate orphan `app-server-broker.mjs` and `codex app-server` processes that accumulate after non-graceful Claude Code termination (kill -9, OOM, lid-close).

**Architecture:** Stop detaching the broker child from its parent (drop `detached: true`; keep `child.unref()`), add a 3-second `process.ppid === 1` heartbeat inside the broker so it self-terminates when reparented to launchd/init, guard `shutdown()` against re-entry with a shared promise, and add a one-time scan-on-startup that kills already-orphaned brokers from previous plugin versions.

**Tech Stack:** Node.js (ES modules, `.mjs`), `node:child_process`, `node:net`, `node:fs`, `node:test` built-in test runner. No new dependencies.

---

## Goal

Today the codex-companion plugin spawns its broker as a detached process (`detached: true; child.unref()`) so it can outlive Claude Code restarts. In practice the survival feature is unused (the docs already steer users to `--fresh`, monitoring lives inside the Claude session, etc.) and the cost is real: after each `kill -9` of Claude, the broker plus its `codex app-server` child are reparented to launchd and live forever. Real users accumulate 30+ such processes per month, holding ~3-4 GB through compressed memory + WindowServer buffers.

This plan removes the detach (only `detached: true`; `child.unref()` is kept so the companion process can exit independently of the broker), adds a parent-liveness heartbeat that catches `kill -9` on every platform, and cleans up already-accumulated orphans on the next plugin start.

## Acceptance criteria

1. After `kill -9` of the codex-companion parent process, both the broker process and its `codex app-server` child terminate within 10 seconds, the unix socket file is removed, and the broker pid file is removed.
2. Graceful shutdown (SIGTERM to the parent) still works: broker shuts down cleanly via existing SIGTERM handler with no double-execution of `shutdown()`.
3. The `spawnBrokerProcess` function no longer passes `detached: true`. `child.unref()` is preserved.
4. The broker process records its parent PID in `broker.json` (field `parentPid`).
5. On `ensureBrokerSession` start, any `broker.json` files in the plugin state root whose recorded `parentPid` is dead (or 1) AND whose recorded broker `pid` is alive are killed and their state files removed. Legacy state files without `parentPid` are always killed if the broker pid is alive (and the state files cleaned up either way), since they cannot be from the post-fix plugin version.
6. `node --test vendor/codex-companion/tests/` passes: heartbeat unit test, scan-on-startup unit test, graceful-shutdown regression test all green; integration kill-9 test passes when `codex` binary is available, otherwise skips cleanly.
7. `skills/codex-invocation/SKILL.md` no longer claims "no documented command for restarting the shared broker" - section is updated to reflect the automatic heartbeat cleanup.

## Non-goals / deferred

- **Surviving Claude Code restarts.** The detach was originally meant to enable `--resume-last` across restarts; that workflow is already deprecated in our docs and will not be re-added. Reviewers MUST classify "preserve cross-restart broker survival" requests as `REJECTED_BY_SCOPE`.
- **Replacing the unix-socket RPC protocol** with a pipe-based death-detection channel. Heartbeat is sufficient.
- **launchd / systemd integration** for managing the broker as a system service.
- **Touching `app-server.mjs` (`codex app-server` spawn).** It already runs attached and dies with the broker; no change needed.
- **Logging / telemetry for orphan kills** beyond a single stderr line.
- **Keeping `child.unref()` removed from `spawnBrokerProcess`.** The fix removes only `detached: true`; `child.unref()` is kept so the companion process can exit without waiting for the broker. The broker remains in the companion's process group (so SIGHUP/SIGTERM cascade naturally on graceful shutdown), and the heartbeat catches the kill-9 case where no signal cascade fires.

## File Structure

**Modified files:**
- `vendor/codex-companion/scripts/lib/broker-lifecycle.mjs` - drop `detached: true` (keep `child.unref()`), add `parentPid` to saved session, add `scanOrphanBrokers()` async helper, call it from `ensureBrokerSession`.
- `vendor/codex-companion/scripts/app-server-broker.mjs` - replace `shuttingDown` boolean with `shutdownPromise` shared-promise pattern inside `shutdown(server)`, add `process.ppid === 1` heartbeat that fires after `server.listen()`.
- `skills/codex-invocation/SKILL.md` - rewrite the stale-lock paragraph to remove the "no command for restarting the shared broker" claim and note that orphan brokers are now auto-cleaned.

**New files:**
- `vendor/codex-companion/tests/heartbeat.test.mjs` - unit test for the heartbeat self-termination logic via fork-and-orphan helper subprocess.
- `vendor/codex-companion/tests/scan-orphans.test.mjs` - unit test for `scanOrphanBrokers()` using fake state dirs and synthetic `broker.json` files.
- `vendor/codex-companion/tests/graceful-shutdown.test.mjs` - regression test that SIGTERM-to-parent still cleans up cleanly with no double shutdown.
- `vendor/codex-companion/tests/integration-kill9.test.mjs` - integration test that survives only when `codex` binary is in `PATH`, else `t.skip()`.
- `vendor/codex-companion/tests/helpers/heartbeat-harness.mjs` - small subprocess that wires up the same heartbeat code as the broker for the unit test.

---

## Task list

### Task 1: Replace `shuttingDown` boolean with `shutdownPromise` shared-promise pattern in broker `shutdown()`

**Files:**
- Modify: `vendor/codex-companion/scripts/app-server-broker.mjs:48-114`

This must land before the heartbeat: heartbeat + SIGTERM may race, and the existing `shutdown()` is not idempotent (it would unlink already-removed files and call `appClient.close()` twice). A boolean guard is not await-safe - a second concurrent caller would see the flag set, return immediately, and could call `process.exit(0)` before the first caller's async cleanup completes. We use a shared promise so all concurrent callers await the *same* cleanup.

- [ ] **Step 1: Write the failing test**

Create `vendor/codex-companion/tests/graceful-shutdown.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokerScript = path.resolve(here, "../scripts/app-server-broker.mjs");

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandExists(cmd) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [cmd]).status === 0;
}

test("shutdown() is idempotent under concurrent calls (shared promise)", { skip: !commandExists("codex") }, async () => {
  // Arrange: spawn broker with a unix socket in a temp dir.
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-test-"));
  const socketPath = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");
  const endpoint = `unix://${socketPath}`;
  const child = spawn(process.execPath, [brokerScript, "serve", "--endpoint", endpoint, "--cwd", sessionDir, "--pid-file", pidFile], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  // Wait for socket to appear.
  for (let i = 0; i < 40 && !fs.existsSync(socketPath); i++) await waitMs(50);
  assert.ok(fs.existsSync(socketPath), "socket should exist after broker startup");

  // Act: SIGTERM the broker, then SIGTERM again 10ms later (simulates heartbeat racing SIGTERM).
  // With shared-promise pattern, both calls await the same cleanup; cleanup runs exactly once.
  child.kill("SIGTERM");
  await waitMs(10);
  try { child.kill("SIGTERM"); } catch {}

  // Wait for exit.
  const code = await new Promise((resolve) => child.once("exit", (c) => resolve(c)));

  // Assert: clean exit, files removed exactly once (no ENOENT crash on second unlink).
  assert.equal(code, 0, "broker should exit 0");
  assert.equal(fs.existsSync(socketPath), false, "socket file should be removed");
  assert.equal(fs.existsSync(pidFile), false, "pid file should be removed");

  fs.rmSync(sessionDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails (or skips cleanly without codex)**

Run: `node --test vendor/codex-companion/tests/graceful-shutdown.test.mjs`

Expected without guard, when `codex` is present: test may pass by luck OR fail with stack trace from `appClient.close()` called twice / `fs.unlinkSync` ENOENT. The shared-promise guard makes it deterministic.

If `codex` binary not present, expect: `# SKIP`. That is acceptable - proceed.

- [ ] **Step 3: Add the `shutdownPromise` shared-promise guard**

Edit `vendor/codex-companion/scripts/app-server-broker.mjs`. Replace the block from `async function shutdown(server) {` through `  }` (lines 102-114) with:

```javascript
  let shutdownPromise = null;

  async function shutdown(server) {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      for (const socket of sockets) {
        socket.end();
      }
      await appClient.close().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
      if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
        fs.unlinkSync(listenTarget.path);
      }
      if (pidFile && fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    })();
    return shutdownPromise;
  }
```

The `let shutdownPromise = null;` line goes immediately above `async function shutdown(server) {` so the closure captures it. All callers (SIGTERM, SIGINT, heartbeat, broker/shutdown RPC handler) must do `await shutdown(server); process.exit(0);` - the existing RPC handler pattern already does this; ensure SIGTERM/SIGINT handlers in the file follow the same shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test vendor/codex-companion/tests/graceful-shutdown.test.mjs`
Expected: PASS (or SKIP if `codex` not available - both acceptable).

- [ ] **Step 5: Commit**

```bash
git add vendor/codex-companion/scripts/app-server-broker.mjs vendor/codex-companion/tests/graceful-shutdown.test.mjs
git commit -m "fix(codex-broker): make shutdown() concurrent-safe via shared promise"
```

---

### Task 2: Add `process.ppid` heartbeat to broker

**Files:**
- Modify: `vendor/codex-companion/scripts/app-server-broker.mjs:236-247` (insert after `server.listen`)
- Create: `vendor/codex-companion/tests/heartbeat.test.mjs`
- Create: `vendor/codex-companion/tests/helpers/heartbeat-harness.mjs`

- [ ] **Step 1: Write the helper subprocess**

Create `vendor/codex-companion/tests/helpers/heartbeat-harness.mjs`. This standalone script reproduces the exact heartbeat logic so we can test it in isolation without needing a real `codex` binary. The `HEARTBEAT_MS` env var lets tests override the interval for speed:

```javascript
#!/usr/bin/env node
// Test harness: mimics broker heartbeat. Exits 0 when ppid becomes 1.
// stdout emits one line "ALIVE <ppid>" every tick so the test can observe behaviour.
// HEARTBEAT_MS env var overrides interval (default 200ms for fast tests).

import process from "node:process";

let shutdownPromise = null;

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    process.stdout.write(`SHUTDOWN ppid=${process.ppid}\n`);
  })();
  await shutdownPromise;
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown(); });

const intervalMs = Number(process.env.HEARTBEAT_MS ?? 200);
let heartbeatGrace = 1;
const heartbeat = setInterval(async () => {
  process.stdout.write(`TICK ppid=${process.ppid}\n`);
  if (heartbeatGrace > 0) {
    heartbeatGrace -= 1;
    return;
  }
  if (process.ppid === 1) {
    clearInterval(heartbeat);
    await shutdown();
  }
}, intervalMs);
heartbeat.unref();

// Keep the event loop alive for the test duration.
const keepAlive = setInterval(() => {}, 60000);
keepAlive.unref();
process.stdout.write(`READY ppid=${process.ppid}\n`);

// Without a ref'd handle the process would exit immediately. Hold a ref via stdin.
process.stdin.resume();
```

- [ ] **Step 2: Write the test**

Create `vendor/codex-companion/tests/heartbeat.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const harness = path.resolve(here, "helpers/heartbeat-harness.mjs");

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("heartbeat self-terminates when parent dies (ppid becomes 1)", async () => {
  // We need a chain: test -> intermediate parent -> harness.
  // Killing the intermediate parent reparents the harness to launchd/init (ppid=1).

  const intermediate = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, [${JSON.stringify(harness)}], {
      stdio: ["ignore", 1, 2],
      env: { ...process.env, HEARTBEAT_MS: "200" }
    });
    process.stdout.write("CHILD_PID=" + child.pid + "\\n");
    setInterval(() => {}, 60000);
  `], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  intermediate.unref();

  // Read CHILD_PID line.
  let buf = "";
  let childPid = null;
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const m = buf.match(/CHILD_PID=(\d+)/);
      if (m) {
        childPid = Number(m[1]);
        intermediate.stdout.off("data", onData);
        resolve();
      }
    };
    intermediate.stdout.on("data", onData);
    setTimeout(() => reject(new Error("never saw CHILD_PID")), 3000);
  });

  assert.ok(childPid, "must have child pid");
  // Wait for harness to print READY.
  await waitMs(300);

  // Kill the intermediate parent with SIGKILL - child must be reparented to ppid=1.
  intermediate.kill("SIGKILL");

  // Poll: child should exit within 1 second (heartbeat tick is 200ms).
  let alive = true;
  for (let i = 0; i < 20; i++) {
    await waitMs(100);
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
      break;
    }
  }

  assert.equal(alive, false, "harness child should self-terminate after parent dies");
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test vendor/codex-companion/tests/heartbeat.test.mjs`

Expected: **PASS** - the harness already contains the heartbeat logic, so this test verifies the mechanism works before wiring it into the broker. If it FAILS, the harness has a bug - fix it before continuing.

- [ ] **Step 4: Add the heartbeat to the actual broker**

Edit `vendor/codex-companion/scripts/app-server-broker.mjs`. **Locate the existing `server.listen(listenTarget.path);` line (around line 246, last line of `main()` before its closing brace). Insert the following block immediately AFTER that existing line - do not add another `server.listen()` call:**

```javascript
  // Parent liveness heartbeat.
  // After kill -9 of the parent (Claude Code or codex-companion.mjs), this broker
  // is reparented to launchd (macOS) or init (Linux), making process.ppid === 1.
  // SIGTERM/SIGINT handlers cannot fire on kill -9, so we poll instead.
  // Ticks every 3s, with a grace period of 1 tick (3s) to avoid any startup race
  // where ppid could theoretically read 1 before the parent fully attaches.
  // Worst-case detection latency: 3s grace + 3s tick = 6s; AC1 budgets 10s.
  const intervalMs = 3000;
  let heartbeatGrace = 1;
  const heartbeat = setInterval(async () => {
    if (heartbeatGrace > 0) {
      heartbeatGrace -= 1;
      return;
    }
    if (process.ppid === 1) {
      clearInterval(heartbeat);
      await shutdown(server);
      process.exit(0);
    }
  }, intervalMs);
  heartbeat.unref();
```

- [ ] **Step 5: Run harness test again to confirm no regression**

Run: `node --test vendor/codex-companion/tests/heartbeat.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vendor/codex-companion/scripts/app-server-broker.mjs vendor/codex-companion/tests/heartbeat.test.mjs vendor/codex-companion/tests/helpers/heartbeat-harness.mjs
git commit -m "feat(codex-broker): self-terminate when parent dies via ppid heartbeat"
```

---

### Task 3: Remove `detached: true` from `spawnBrokerProcess`

**Files:**
- Modify: `vendor/codex-companion/scripts/lib/broker-lifecycle.mjs:59-70`

We remove only `detached: true`. `child.unref()` is **kept**: without it, the companion process holds a ref to the broker child handle and cannot exit (it would wait for the long-running broker). With `detached: true` removed but `unref()` kept, the broker stays in the companion's process group (so SIGHUP/SIGTERM cascade naturally on graceful shutdown) while the companion is free to exit when its own work is done. The kill-9 case is covered by the broker's heartbeat (Task 2).

- [ ] **Step 1: Write the failing test**

Append to `vendor/codex-companion/tests/graceful-shutdown.test.mjs` (file from Task 1):

```javascript
test("spawnBrokerProcess does not detach the child but keeps unref()", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const src = fs.readFileSync(
    path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../scripts/lib/broker-lifecycle.mjs"),
    "utf8"
  );
  const fnMatch = src.match(/export function spawnBrokerProcess\([^]*?\n\}/);
  assert.ok(fnMatch, "spawnBrokerProcess must exist");
  const fnBody = fnMatch[0];
  assert.ok(!/detached\s*:\s*true/.test(fnBody), "spawnBrokerProcess must not pass detached:true");
  assert.ok(/\.unref\(\)/.test(fnBody), "spawnBrokerProcess must keep child.unref() to avoid holding parent event loop");
});

test("spawnBrokerProcess has exactly one caller (ensureBrokerSession in broker-lifecycle.mjs)", async () => {
  // Sanity: keep visibility on callers of the broker spawn helper.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");

  const repoRoot = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)),
    "../../.."
  );
  const searchRoot = path.join(repoRoot, "vendor/codex-companion/scripts");

  // Recursively walk searchRoot and grep .mjs/.js files for "spawnBrokerProcess".
  function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(full, out);
      } else if (e.isFile() && (e.name.endsWith(".mjs") || e.name.endsWith(".js"))) {
        out.push(full);
      }
    }
    return out;
  }

  const files = walk(searchRoot);
  const referencingFiles = files.filter((f) =>
    fs.readFileSync(f, "utf8").includes("spawnBrokerProcess")
  );

  // Acceptable references: only inside scripts/lib/broker-lifecycle.mjs.
  for (const f of referencingFiles) {
    assert.ok(
      f.endsWith(path.join("scripts", "lib", "broker-lifecycle.mjs")),
      `unexpected caller of spawnBrokerProcess: ${f}`
    );
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test vendor/codex-companion/tests/graceful-shutdown.test.mjs`
Expected: FAIL with "spawnBrokerProcess must not pass detached:true". (The single-caller test should already pass at HEAD.)

- [ ] **Step 3: Apply the change**

Edit `vendor/codex-companion/scripts/lib/broker-lifecycle.mjs`. Replace lines 59-70 (`spawnBrokerProcess`) with:

```javascript
export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();   // parent can exit without waiting for broker; broker self-terminates via heartbeat
  fs.closeSync(logFd);
  return child;
}
```

Note: `child.unref()` is kept. Only `detached: true` is removed.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test vendor/codex-companion/tests/graceful-shutdown.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vendor/codex-companion/scripts/lib/broker-lifecycle.mjs vendor/codex-companion/tests/graceful-shutdown.test.mjs
git commit -m "fix(codex-broker): stop detaching broker child from parent"
```

---

### Task 4: Record `parentPid` in `broker.json`

**Files:**
- Modify: `vendor/codex-companion/scripts/lib/broker-lifecycle.mjs:162-168` (the `session` literal in `ensureBrokerSession`)

- [ ] **Step 1: Write the failing test**

Append to `vendor/codex-companion/tests/graceful-shutdown.test.mjs`:

```javascript
test("ensureBrokerSession saves parentPid in broker.json", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const src = fs.readFileSync(
    path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../scripts/lib/broker-lifecycle.mjs"),
    "utf8"
  );
  const ensureFn = src.match(/export async function ensureBrokerSession[^]*?\n\}/);
  assert.ok(ensureFn, "ensureBrokerSession must exist");
  assert.ok(/parentPid\s*:\s*process\.pid/.test(ensureFn[0]), "session must include parentPid: process.pid");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test vendor/codex-companion/tests/graceful-shutdown.test.mjs`
Expected: FAIL with "session must include parentPid: process.pid".

- [ ] **Step 3: Apply the change**

Edit `vendor/codex-companion/scripts/lib/broker-lifecycle.mjs`. Replace the `session` literal block (lines 162-168) with:

```javascript
  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    parentPid: process.pid
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test vendor/codex-companion/tests/graceful-shutdown.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vendor/codex-companion/scripts/lib/broker-lifecycle.mjs vendor/codex-companion/tests/graceful-shutdown.test.mjs
git commit -m "feat(codex-broker): record parentPid in broker.json"
```

---

### Task 5: Implement async `scanOrphanBrokers()` and call it from `ensureBrokerSession`

**Files:**
- Modify: `vendor/codex-companion/scripts/lib/broker-lifecycle.mjs` (add new exported async function + await call)
- Create: `vendor/codex-companion/tests/scan-orphans.test.mjs`

`scanOrphanBrokers` is `async` for forward-compatibility (other call sites may evolve and `ensureBrokerSession` is already async). The current implementation has no awaits inside the legacy path — legacy state files are killed unconditionally if the broker pid is alive — but the function signature stays `async` so future paths can probe asynchronously without a churny signature change.

- [ ] **Step 1: Write the failing test**

Create `vendor/codex-companion/tests/scan-orphans.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { scanOrphanBrokers } from "../scripts/lib/broker-lifecycle.mjs";

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("scanOrphanBrokers kills broker whose parent is dead", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-scan-"));

  const fakeBroker = spawn(process.execPath, ["-e", "setInterval(()=>{},60000)"], { stdio: "ignore" });
  const deadProc = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((resolve) => deadProc.once("exit", resolve));
  const deadPid = deadProc.pid;

  const dir = path.join(stateRoot, "ws-aaaaaaaaaaaaaaaa");
  fs.mkdirSync(dir, { recursive: true });
  const brokerJson = {
    endpoint: `unix://${path.join(dir, "broker.sock")}`,
    pidFile: path.join(dir, "broker.pid"),
    logFile: path.join(dir, "broker.log"),
    sessionDir: dir,
    pid: fakeBroker.pid,
    parentPid: deadPid
  };
  fs.writeFileSync(path.join(dir, "broker.json"), JSON.stringify(brokerJson));
  fs.writeFileSync(brokerJson.pidFile, String(fakeBroker.pid));

  const killed = await scanOrphanBrokers({ stateRoot });

  await waitMs(200);

  assert.equal(killed.length, 1, "should report one kill");
  assert.equal(isAlive(fakeBroker.pid), false, "fake broker should be dead");
  assert.equal(fs.existsSync(path.join(dir, "broker.json")), false, "broker.json should be removed");

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("scanOrphanBrokers leaves healthy broker alone", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-scan-"));

  const fakeBroker = spawn(process.execPath, ["-e", "setInterval(()=>{},60000)"], { stdio: "ignore" });
  const dir = path.join(stateRoot, "ws-bbbbbbbbbbbbbbbb");
  fs.mkdirSync(dir, { recursive: true });
  const brokerJson = {
    endpoint: `unix://${path.join(dir, "broker.sock")}`,
    pidFile: path.join(dir, "broker.pid"),
    logFile: path.join(dir, "broker.log"),
    sessionDir: dir,
    pid: fakeBroker.pid,
    parentPid: process.pid // current test process is alive
  };
  fs.writeFileSync(path.join(dir, "broker.json"), JSON.stringify(brokerJson));

  const killed = await scanOrphanBrokers({ stateRoot });

  assert.equal(killed.length, 0, "should not kill anything");
  assert.equal(isAlive(fakeBroker.pid), true, "fake broker should still be alive");
  assert.equal(fs.existsSync(path.join(dir, "broker.json")), true, "broker.json should remain");

  fakeBroker.kill("SIGKILL");
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("scanOrphanBrokers tolerates missing fields and unreadable JSON", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-scan-"));

  const dirB = path.join(stateRoot, "ws-dddddddddddddddd");
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirB, "broker.json"), "{not valid");

  const killed = await scanOrphanBrokers({ stateRoot });
  assert.equal(killed.length, 0);

  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("scanOrphanBrokers kills legacy broker without parentPid even when socket is reachable", async () => {
  // Legacy state files (no parentPid) come from the old detached-broker plugin
  // version. Even if the socket is reachable (broker still serving), we kill it:
  // reachability does not imply a healthy parent. If a live Claude Code session
  // is using it, the next ensureBrokerSession call will recreate a fresh broker.
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-scan-"));

  const dir = path.join(stateRoot, "ws-ffffffffffffffff");
  fs.mkdirSync(dir, { recursive: true });
  const socketPath = path.join(dir, "broker.sock");

  // Stand up a mock server bound to the unix socket so the endpoint is "reachable".
  const mockServer = net.createServer((socket) => { socket.end(); });
  await new Promise((resolve) => mockServer.listen(socketPath, resolve));

  const fakeBroker = spawn(process.execPath, ["-e", "setInterval(()=>{},60000)"], { stdio: "ignore" });
  const brokerJson = {
    endpoint: `unix://${socketPath}`,
    pidFile: path.join(dir, "broker.pid"),
    logFile: path.join(dir, "broker.log"),
    sessionDir: dir,
    pid: fakeBroker.pid
    // intentionally no parentPid (legacy)
  };
  fs.writeFileSync(path.join(dir, "broker.json"), JSON.stringify(brokerJson));
  fs.writeFileSync(brokerJson.pidFile, String(fakeBroker.pid));

  const killed = await scanOrphanBrokers({ stateRoot });
  await waitMs(200);

  assert.equal(killed.length, 1, "legacy alive broker (even reachable) must be killed");
  assert.equal(isAlive(fakeBroker.pid), false, "fake broker should be dead");
  assert.equal(fs.existsSync(path.join(dir, "broker.json")), false, "broker.json should be removed");

  await new Promise((resolve) => mockServer.close(resolve));
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("scanOrphanBrokers (legacy state, no parentPid) - broker pid not alive -> cleanup state files only", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-scan-"));

  const deadProc = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((resolve) => deadProc.once("exit", resolve));
  const deadPid = deadProc.pid;

  const dir = path.join(stateRoot, "ws-gggggggggggggggg");
  fs.mkdirSync(dir, { recursive: true });
  const brokerJson = {
    endpoint: `unix://${path.join(dir, "broker.sock")}`,
    pidFile: path.join(dir, "broker.pid"),
    logFile: path.join(dir, "broker.log"),
    sessionDir: dir,
    pid: deadPid
  };
  fs.writeFileSync(path.join(dir, "broker.json"), JSON.stringify(brokerJson));

  const killed = await scanOrphanBrokers({ stateRoot });
  // No kill (pid already dead) but state file should be cleaned up.
  assert.equal(killed.length, 0);
  assert.equal(fs.existsSync(path.join(dir, "broker.json")), false, "stale state file should be removed");

  fs.rmSync(stateRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test vendor/codex-companion/tests/scan-orphans.test.mjs`
Expected: FAIL with `SyntaxError: The requested module ... does not provide an export named 'scanOrphanBrokers'`.

- [ ] **Step 3: Implement `scanOrphanBrokers` (async) and wire it in**

Edit `vendor/codex-companion/scripts/lib/broker-lifecycle.mjs`. Add this function after `clearBrokerSession` (after line 100). The legacy path no longer needs `waitForBrokerEndpoint` — if you're not using it elsewhere in `scanOrphanBrokers` you can drop the local reference.

```javascript
function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we cannot signal.
    return err.code === "EPERM";
  }
}

function defaultStateRoot() {
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  return pluginDataDir
    ? path.join(pluginDataDir, "state")
    : path.join(os.tmpdir(), "codex-companion");
}

function cleanupSessionFiles(stateFile, session) {
  try { fs.unlinkSync(stateFile); } catch {}
  if (typeof session?.pidFile === "string") {
    try { fs.unlinkSync(session.pidFile); } catch {}
  }
  if (typeof session?.endpoint === "string") {
    try {
      const target = parseBrokerEndpoint(session.endpoint);
      if (target.kind === "unix") {
        try { fs.unlinkSync(target.path); } catch {}
      }
    } catch {}
  }
}

export async function scanOrphanBrokers({ stateRoot = defaultStateRoot() } = {}) {
  const killed = [];
  if (!fs.existsSync(stateRoot)) {
    return killed;
  }

  let entries;
  try {
    entries = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return killed;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sessionDir = path.join(stateRoot, entry.name);
    const stateFile = path.join(sessionDir, BROKER_STATE_FILE);
    if (!fs.existsSync(stateFile)) {
      continue;
    }

    let session;
    try {
      session = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      continue;
    }

    const brokerPid = Number(session?.pid);
    const parentPidRaw = session?.parentPid;
    const hasParentPid = Number.isFinite(Number(parentPidRaw));
    const parentPid = hasParentPid ? Number(parentPidRaw) : null;

    if (!Number.isFinite(brokerPid)) {
      continue;
    }

    // Legacy state (no parentPid): from old detached-broker plugin version.
    // Cannot determine parent liveness without parentPid. Kill if alive.
    if (!hasParentPid) {
      if (!isProcessAlive(brokerPid)) {
        // Already dead; just clean up files.
        cleanupSessionFiles(stateFile, session);
        continue;
      }
      // Kill orphan and clean up.
      try { process.kill(brokerPid, "SIGTERM"); } catch {}
      killed.push({ pid: brokerPid, sessionDir, reason: "legacy-no-parentPid" });
      cleanupSessionFiles(stateFile, session);
      continue;
    }

    // Modern state files with parentPid.
    if (!isProcessAlive(brokerPid)) {
      continue;
    }
    if (parentPid !== 1 && isProcessAlive(parentPid)) {
      continue;
    }

    // Orphan: broker alive, parent dead. Kill it.
    try {
      process.kill(brokerPid, "SIGTERM");
    } catch {
      // already gone; fall through to cleanup
    }
    killed.push({ pid: brokerPid, sessionDir });
    cleanupSessionFiles(stateFile, session);
  }

  return killed;
}
```

The function remains `export async function` for forward-compatibility even though the current body has no `await`. (Async has no downside and other call sites may evolve to add probes later.)

Also add the call inside `ensureBrokerSession`. Edit lines 113-117 (the start of `ensureBrokerSession`) so the function begins with:

```javascript
export async function ensureBrokerSession(cwd, options = {}) {
  // One-time sweep of orphan brokers from prior sessions / older plugin versions.
  try {
    await scanOrphanBrokers();
  } catch {
    // never block normal startup on cleanup failure
  }

  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test vendor/codex-companion/tests/scan-orphans.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add vendor/codex-companion/scripts/lib/broker-lifecycle.mjs vendor/codex-companion/tests/scan-orphans.test.mjs
git commit -m "feat(codex-broker): scan and reap orphan brokers (incl. legacy) on startup"
```

---

### Task 6: Integration test - kill -9 the parent, verify broker dies

**Files:**
- Create: `vendor/codex-companion/tests/integration-kill9.test.mjs`

This test only runs when the `codex` binary is in `PATH` (it spawns a real broker). Otherwise it skips.

- [ ] **Step 1: Write the test**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const brokerScript = path.resolve(here, "../scripts/app-server-broker.mjs");

function commandExists(cmd) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [cmd]).status === 0;
}

function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test("kill -9 of intermediate parent -> broker self-terminates within 15s", { skip: !commandExists("codex") }, async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-int-"));
  const socketPath = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");
  const endpoint = `unix://${socketPath}`;

  const intermediate = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const c = spawn(${JSON.stringify(process.execPath)}, [
      ${JSON.stringify(brokerScript)}, "serve",
      "--endpoint", ${JSON.stringify(endpoint)},
      "--cwd", ${JSON.stringify(sessionDir)},
      "--pid-file", ${JSON.stringify(pidFile)}
    ], { stdio: ["ignore", 1, 2] });
    process.stdout.write("BROKER_PID=" + c.pid + "\\n");
    setInterval(()=>{}, 60000);
  `], { stdio: ["ignore", "pipe", "inherit"], detached: true });
  intermediate.unref();

  let buf = "";
  let brokerPid = null;
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/BROKER_PID=(\d+)/);
      if (m) { brokerPid = Number(m[1]); resolve(); }
    };
    intermediate.stdout.on("data", onData);
    setTimeout(() => reject(new Error("never saw BROKER_PID")), 5000);
  });

  // Wait for socket to appear (broker fully up).
  for (let i = 0; i < 60 && !fs.existsSync(socketPath); i++) await waitMs(100);
  assert.ok(fs.existsSync(socketPath), "socket should exist");

  // Kill -9 the intermediate parent.
  try { process.kill(intermediate.pid, "SIGKILL"); } catch {}

  // Heartbeat tick is 3s + grace 3s + shutdown latency. Allow up to 15s.
  let dead = false;
  for (let i = 0; i < 150; i++) {
    await waitMs(100);
    if (!isAlive(brokerPid)) { dead = true; break; }
  }

  assert.equal(dead, true, "broker should self-terminate after parent kill -9");
  assert.equal(fs.existsSync(socketPath), false, "socket should be cleaned up");
  assert.equal(fs.existsSync(pidFile), false, "pid file should be cleaned up");

  fs.rmSync(sessionDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test (will skip if codex not installed)**

Run: `node --test vendor/codex-companion/tests/integration-kill9.test.mjs`
Expected: PASS if `codex` binary present, otherwise `# SKIP`.

- [ ] **Step 3: Commit**

```bash
git add vendor/codex-companion/tests/integration-kill9.test.mjs
git commit -m "test(codex-broker): integration test for kill-9 orphan cleanup"
```

---

### Task 7: Update `skills/codex-invocation/SKILL.md` stale-lock section

**Files:**
- Modify: `skills/codex-invocation/SKILL.md:108-110`

- [ ] **Step 1: Apply the change**

Edit `skills/codex-invocation/SKILL.md`. Replace the line:

```
**Workaround**: submit a fresh task with `--fresh` instead of `--resume-last`. Codex re-reads project context; new jobs start fine. Proper fix would be restarting the shared broker, but no documented command for that yet.
```

with:

```
**Workaround**: submit a fresh task with `--fresh` instead of `--resume-last`. Codex re-reads project context; new jobs start fine.

Note: orphan broker processes from prior crashed Claude Code sessions are now cleaned up automatically - the broker self-terminates within ~6 s of its parent dying (heartbeat in `app-server-broker.mjs`), and `ensureBrokerSession` reaps any leftover orphans (including legacy state files without `parentPid`) on startup. The `--fresh` workaround above addresses a different symptom: stale in-memory job state inside a still-alive broker after an interrupted task.
```

- [ ] **Step 2: Verify the file still parses**

Run: `node -e "console.log(require('node:fs').readFileSync('skills/codex-invocation/SKILL.md','utf8').length)"`
Expected: prints a number > 0 (sanity check the file wasn't corrupted).

- [ ] **Step 3: Commit**

```bash
git add skills/codex-invocation/SKILL.md
git commit -m "docs(codex-invocation): note auto-cleanup of orphan brokers"
```

---

### Task 8: Run full test suite

- [ ] **Step 1: Run all broker tests**

Run: `node --test vendor/codex-companion/tests/`
Expected: PASS for all unit + scan tests; integration test PASSes if `codex` is installed, else SKIPs.

- [ ] **Step 2: Manual smoke check**

```bash
# Spawn a fake broker via codex-companion as usual, then kill -9 its parent.
# Confirm via `ps` after 10 seconds that no orphan broker / app-server remains.
ps aux | grep -E "app-server-broker|codex app-server" | grep -v grep
```

Expected: no leftover processes.

- [ ] **Step 3: Final commit (if anything else changed)**

If the suite revealed a fix needed, commit it. Otherwise this task is just verification.

---

## Self-Review

Spec coverage check:
- Remove `detached: true` (keep `child.unref()`) -> Task 3.
- Add heartbeat in broker -> Task 2.
- Add shutdown guard (shared promise, await-safe) -> Task 1.
- Add scan-on-startup (async; legacy = always kill if alive) -> Task 5.
- Add `parentPid` to broker.json -> Task 4.
- Update SKILL.md stale-lock section -> Task 7.
- Tests: heartbeat unit -> Task 2 (via harness).
- Tests: integration kill -9 -> Task 6.
- Tests: graceful shutdown regression -> Task 1 (idempotent shutdown test) + Task 8 (suite run).

Placeholder scan: no "TBD"/"TODO"/"implement later"/"add appropriate"/"similar to Task N" remain.

Type/name consistency:
- `shutdownPromise` (shared promise) is used consistently throughout Task 1 (broker code), Task 2 (heartbeat callback awaits `shutdown(server)`), and the harness mirrors the same pattern.
- `scanOrphanBrokers` is `async` everywhere it is declared, called, and tested. The current legacy path has no `await` but the function signature stays `async` for forward-compatibility (other call sites may evolve to add async probes).
- `parentPid` field, `BROKER_STATE_FILE` constant, `parseBrokerEndpoint` - all consistent across tasks.
- Heartbeat uses the existing `server` const captured by closure (declared at line 118, heartbeat declared after `server.listen()` at line 246) - no second `server.listen()` call.
- Task 3 implementation snippet keeps `child.unref()`; Task 3 test asserts both `!detached:true` AND that `.unref()` is present — the two match.
- ESM imports only in `graceful-shutdown.test.mjs` (`spawn, spawnSync` from `node:child_process` at top of file); no `require()` calls in `.mjs` test files. Skip condition is purely `{ skip: !commandExists("codex") }` — no `RUN_BROKER_TESTS` env. Documented run command is `node --test vendor/codex-companion/tests/graceful-shutdown.test.mjs`.
- `scan-orphans.test.mjs` updated: the "legacy reachable -> leave alone" case is removed; replaced with "kills legacy alive broker even when reachable". Total: 5 tests.

Acceptance-criteria coverage:
- AC 1 (kill -9 -> cleanup within 10 seconds): heartbeat = 3s tick + 1-tick grace = 6s worst case; integration test in Task 6 polls for up to 15s. Comfortably under the 10s budget for the parent-death detection itself; the extra margin in the test absorbs shutdown latency.
- AC 2 (graceful shutdown still works): observed in Task 1 idempotent-shutdown test (concurrent SIGTERM under shared-promise pattern).
- AC 3 (no `detached: true`; `child.unref()` preserved): observed in Task 3 source-grep test (both assertions), plus single-caller invariant test.
- AC 4 (parentPid in broker.json): observed in Task 4 source-grep test.
- AC 5 (orphan reaping, including legacy = always kill if alive): observed in Task 5 scan-orphans tests (modern path + 2 legacy-state cases: alive-even-if-reachable -> kill, dead-pid -> cleanup files only).
- AC 6 (test suite green): Task 8.
- AC 7 (SKILL.md updated): Task 7.

Round-2 ledger items (B1-R2, B2-R2, B3-R2) addressed in this revision:
1. **B1-R2** - Task 3 now removes only `detached: true` and explicitly keeps `child.unref()`. Implementation snippet, test assertions, AC3, Non-goals, and the architecture summary all reflect this. Without `child.unref()`, the companion would hang on the ref'd broker child handle when commands complete; with it kept (and `detached: true` removed), the broker still inherits the companion's process group for SIGHUP/SIGTERM cascade, while the heartbeat handles kill-9.
2. **B2-R2** - `graceful-shutdown.test.mjs` skip condition is now purely `{ skip: !commandExists("codex") }`. All references to `RUN_BROKER_TESTS` are removed from the test code, the documented run command, and expected outputs in Task 1 Steps 1, 2, and 4.
3. **B3-R2** - Legacy state files (no `parentPid`) are now ALWAYS killed if the broker pid is alive — reachability check removed. Test "legacy reachable -> leave alone" is replaced with "kills legacy alive broker even when reachable" (mock unix socket listening at the endpoint to prove the kill happens regardless of reachability). The `await waitForBrokerEndpoint(...)` call is removed from the legacy branch in `scanOrphanBrokers`; function remains `export async function` for forward-compatibility.

All items checked, 3 issues found and fixed.
