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

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const skipReason = !commandExists("codex")
  ? "codex binary is not in PATH"
  : !canListenUnixSocket()
    ? "sandbox disallows unix socket listen"
    : false;

test("kill -9 of intermediate parent -> broker self-terminates within 15s", { skip: skipReason }, async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-int-"));
  const socketPath = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");
  const endpoint = `unix://${socketPath}`;
  let brokerPid = null;

  const intermediate = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from "node:child_process";
    const c = spawn(${JSON.stringify(process.execPath)}, [
      ${JSON.stringify(brokerScript)}, "serve",
      "--endpoint", ${JSON.stringify(endpoint)},
      "--cwd", ${JSON.stringify(sessionDir)},
      "--pid-file", ${JSON.stringify(pidFile)}
    ], { stdio: ["ignore", 1, 2] });
    process.stdout.write("BROKER_PID=" + c.pid + "\\n");
    setInterval(() => {}, 60000);
  `], { stdio: ["ignore", "pipe", "inherit"], detached: true });
  intermediate.unref();

  try {
    let buf = "";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("never saw BROKER_PID")), 5000);
      const onData = (chunk) => {
        buf += chunk.toString("utf8");
        const m = buf.match(/BROKER_PID=(\d+)/);
        if (m) {
          brokerPid = Number(m[1]);
          clearTimeout(timer);
          intermediate.stdout.off("data", onData);
          resolve();
        }
      };
      intermediate.stdout.on("data", onData);
    });

    // Wait for socket to appear (broker fully up).
    for (let i = 0; i < 60 && !fs.existsSync(socketPath); i++) {
      await waitMs(100);
    }
    assert.ok(fs.existsSync(socketPath), "socket should exist");

    // Kill -9 the intermediate parent.
    try {
      process.kill(intermediate.pid, "SIGKILL");
    } catch {}

    // Heartbeat tick is 3s + grace 3s + shutdown latency. Allow up to 15s.
    let dead = false;
    for (let i = 0; i < 150; i++) {
      await waitMs(100);
      if (!isAlive(brokerPid)) {
        dead = true;
        break;
      }
    }

    assert.equal(dead, true, "broker should self-terminate after parent kill -9");
    assert.equal(fs.existsSync(socketPath), false, "socket should be cleaned up");
    assert.equal(fs.existsSync(pidFile), false, "pid file should be cleaned up");
  } finally {
    if (intermediate.pid && isAlive(intermediate.pid)) {
      try { process.kill(intermediate.pid, "SIGKILL"); } catch {}
    }
    if (brokerPid && isAlive(brokerPid)) {
      try { process.kill(brokerPid, "SIGKILL"); } catch {}
    }
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
