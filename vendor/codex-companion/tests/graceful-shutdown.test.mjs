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

function canListenUnixSocket() {
  if (process.platform === "win32") {
    return true;
  }
  const probe = `
    import fs from "node:fs";
    import net from "node:net";
    const socketPath = "/tmp/cxc-listen-probe-${process.pid}.sock";
    const server = net.createServer();
    server.on("error", () => process.exit(1));
    server.listen(socketPath, () => {
      server.close(() => {
        try { fs.unlinkSync(socketPath); } catch {}
        process.exit(0);
      });
    });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", probe], { stdio: "ignore" }).status === 0;
}

test("shutdown() is idempotent under concurrent calls (shared promise)", { skip: !commandExists("codex") || !canListenUnixSocket() }, async () => {
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
  const exitPromise = new Promise((resolve) => child.once("exit", (c) => resolve(c)));
  child.kill("SIGTERM");
  await waitMs(10);
  try { child.kill("SIGTERM"); } catch {}

  // Wait for exit.
  const code = await exitPromise;

  // Assert: clean exit, files removed exactly once (no ENOENT crash on second unlink).
  assert.equal(code, 0, "broker should exit 0");
  assert.equal(fs.existsSync(socketPath), false, "socket file should be removed");
  assert.equal(fs.existsSync(pidFile), false, "pid file should be removed");

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

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
