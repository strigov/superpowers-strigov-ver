import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

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

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

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

function isWithinDir(filePath, dir) {
  const resolved = path.resolve(filePath);
  const resolvedDir = path.resolve(dir);
  return resolved.startsWith(resolvedDir + path.sep) || resolved === resolvedDir;
}

function cleanupSessionFiles(stateFile, session, sessionDir) {
  try { fs.unlinkSync(stateFile); } catch {}
  if (typeof session?.pidFile === "string" && isWithinDir(session.pidFile, sessionDir)) {
    try { fs.unlinkSync(session.pidFile); } catch {}
  }
  if (typeof session?.endpoint === "string") {
    try {
      const target = parseBrokerEndpoint(session.endpoint);
      if (target.kind === "unix" && isWithinDir(target.path, sessionDir)) {
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
        cleanupSessionFiles(stateFile, session, sessionDir);
        continue;
      }
      // Kill orphan and clean up.
      try { process.kill(brokerPid, "SIGTERM"); } catch {}
      killed.push({ pid: brokerPid, sessionDir, reason: "legacy-no-parentPid" });
      cleanupSessionFiles(stateFile, session, sessionDir);
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
    cleanupSessionFiles(stateFile, session, sessionDir);
  }

  return killed;
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

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

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    parentPid: process.pid
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
