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
  const intermediate = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from "node:child_process";
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
