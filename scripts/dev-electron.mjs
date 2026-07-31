import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronExecutable = require("electron");
const mainOutput = path.join(projectRoot, "dist", "main", "main.mjs");
const preloadOutput = path.join(projectRoot, "dist", "preload", "index.cjs");
const childProcesses = new Set();
let electronProcess = null;
let restartTimer = null;
let restartPending = false;
let shuttingDown = false;

const startTool = (script, args) => {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit"
  });
  childProcesses.add(child);
  child.once("exit", (code) => {
    childProcesses.delete(child);
    if (!shuttingDown) shutdown(code ?? 1);
  });
  return child;
};

const startElectron = () => {
  if (shuttingDown || electronProcess) return;
  electronProcess = spawn(electronExecutable, [".", "--isolated-dev"], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit"
  });
  electronProcess.once("exit", (code) => {
    electronProcess = null;
    if (shuttingDown) return;
    if (restartPending) {
      restartPending = false;
      startElectron();
    } else {
      shutdown(code ?? 0);
    }
  });
};

const scheduleElectronRestart = () => {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!electronProcess) {
      startElectron();
      return;
    }
    restartPending = true;
    electronProcess.kill();
  }, 250);
};

const waitForFile = async (file, deadline) => {
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`等待构建产物超时：${file}`);
    await delay(100);
  }
};

const waitForPort = async (port, deadline) => {
  while (Date.now() <= deadline) {
    if (await canConnect(port)) return;
    await delay(100);
  }
  throw new Error(`等待 Vite 端口超时：${port}`);
};

const canConnect = (port) => new Promise((resolve) => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const done = (connected) => {
    socket.removeAllListeners();
    socket.destroy();
    resolve(connected);
  };
  socket.setTimeout(250, () => done(false));
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const shutdown = (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  fs.unwatchFile(mainOutput);
  fs.unwatchFile(preloadOutput);
  electronProcess?.kill();
  for (const child of childProcesses) child.kill();
  setTimeout(() => process.exit(exitCode), 100).unref();
};

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

const tsupCli = path.join(projectRoot, "node_modules", "tsup", "dist", "cli-default.js");
const viteCli = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
startTool(tsupCli, ["--config", "tsup.main.config.ts", "--watch"]);
startTool(tsupCli, ["--config", "tsup.preload.config.ts", "--watch"]);
startTool(viteCli, ["--host", "127.0.0.1"]);

try {
  const deadline = Date.now() + 30_000;
  await Promise.all([
    waitForFile(mainOutput, deadline),
    waitForFile(preloadOutput, deadline),
    waitForPort(18435, deadline)
  ]);
  fs.watchFile(mainOutput, { interval: 150 }, scheduleElectronRestart);
  fs.watchFile(preloadOutput, { interval: 150 }, scheduleElectronRestart);
  startElectron();
} catch (error) {
  console.error(error);
  shutdown(1);
}
