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
