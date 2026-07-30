const fs = require("node:fs");
const path = require("node:path");
const { execFile, execFileSync, spawn } = require("node:child_process");

const MCP_GATEWAY_COMMAND = "mcp-gateway-service";

function createMcpGatewayService(store, hooks = {}) {
  let child = null;
  let state = stoppedState();
  let stopPromise = null;
  const expectedStops = new WeakSet();

  async function start() {
    if (stopPromise) await stopPromise;
    if (child) return state;
    const settings = store.getSettings();
    const launch = hooks.resolveLaunch?.() || resolveMcpGatewayLaunch();
    const args = mcpGatewayArgs(settings);
    const command = buildMcpGatewayCommand(settings);
    const output = [];
    const spawned = (hooks.spawnProcess || spawn)(launch.executable, [...launch.prefixArgs, ...args], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child = spawned;
    spawned.stdout?.on("data", (chunk) => collectOutput(output, chunk));
    spawned.stderr?.on("data", (chunk) => collectOutput(output, chunk));
    state = {
      running: true,
      url: mcpGatewayUrl(settings),
      error: "",
      pid: spawned.pid || 0,
      command
    };
    spawned.once("error", (error) => {
      if (child !== spawned) return;
      child = null;
      state = expectedStops.has(spawned)
        ? stoppedState(settings)
        : { ...stoppedState(settings), error: error.message };
      hooks.onStatusChanged?.(state);
    });
    spawned.once("exit", (code, signal) => {
      if (child !== spawned) return;
      child = null;
      state = expectedStops.has(spawned)
        ? stoppedState(settings)
        : { ...stoppedState(settings), error: exitMessage(code, signal, output) };
      hooks.onStatusChanged?.(state);
    });
    return state;
  }

  async function stop() {
    const settings = store.getSettings();
    if (!child) {
      state = stoppedState(settings);
      return state;
    }
    if (stopPromise) return stopPromise;
    const closing = child;
    expectedStops.add(closing);
    stopPromise = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (child === closing) child = null;
        if (!child) state = stoppedState(settings);
        resolve(state);
      };
      closing.once("exit", finish);
      closing.once("error", finish);
      (hooks.killProcess || killProcessTree)(closing);
      setTimeout(finish, Number(hooks.stopTimeoutMs || 3000));
    }).finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  function status() {
    const settings = store.getSettings();
    return child
      ? state
      : { ...state, running: false, url: "", pid: 0, command: buildMcpGatewayCommand(settings) };
  }

  return { start, stop, status };
}

function resolveMcpGatewayLaunch() {
  if (process.platform !== "win32") {
    return { executable: MCP_GATEWAY_COMMAND, prefixArgs: [] };
  }
  const matches = whereWindows(MCP_GATEWAY_COMMAND);
  const native = matches.find((item) => /\.exe$/i.test(item));
  if (native) return { executable: native, prefixArgs: [] };
  const shim = matches.find((item) => /\.cmd$/i.test(item));
  if (!shim) throw new Error("未找到 mcp-gateway-service 可执行文件。");
  const nodeExecutable = whereWindows("node.exe").find((item) => /node\.exe$/i.test(item));
  if (!nodeExecutable) throw new Error("未找到用于运行 mcp-gateway-service 的 Node.js。");
  return resolveWindowsNpmShim(shim, nodeExecutable);
}

function resolveWindowsNpmShim(shim, nodeExecutable) {
  const base = path.dirname(shim);
  const content = fs.readFileSync(shim, "utf8");
  const matches = Array.from(content.matchAll(/"%dp0%\\([^"\r\n]+\.js)"/gi));
  const relativeScript = matches.at(-1)?.[1];
  if (!relativeScript) throw new Error(`无法解析 npm 命令入口：${shim}`);
  const script = path.resolve(base, relativeScript.replace(/\\/g, path.sep));
  const relative = path.relative(base, script);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(script)) {
    throw new Error(`mcp-gateway-service 入口不存在或超出 npm 全局目录：${script}`);
  }
  return { executable: nodeExecutable, prefixArgs: [script] };
}

function whereWindows(command) {
  return execFileSync("where.exe", [command], {
    encoding: "utf8",
    windowsHide: true
  }).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function stoppedState(settings = {}) {
  return {
    running: false,
    url: "",
    error: "",
    pid: 0,
    command: buildMcpGatewayCommand(settings)
  };
}

function buildMcpGatewayCommand(settings = {}) {
  return [MCP_GATEWAY_COMMAND, ...mcpGatewayArgs(settings).map(quoteArg)].join(" ");
}

function mcpGatewayArgs(settings = {}) {
  const args = ["--http"];
  appendOptionalArg(args, "--config", settings.mcp_gateway_config_path);
  appendOptionalArg(args, "--host", settings.mcp_gateway_host);
  appendOptionalArg(args, "--port", cleanMcpGatewayPort(settings.mcp_gateway_port));
  appendOptionalArg(args, "--path", cleanMcpGatewayPath(settings.mcp_gateway_path));
  return args;
}

function mcpGatewayUrl(settings = {}) {
  const host = cleanMcpGatewayText(settings.mcp_gateway_host);
  const port = cleanMcpGatewayPort(settings.mcp_gateway_port);
  if (!host || !port) return "";
  return `http://${host}:${port}${cleanMcpGatewayPath(settings.mcp_gateway_path) || ""}`;
}

function appendOptionalArg(args, name, value) {
  const text = cleanMcpGatewayText(value);
  if (!text) return;
  args.push(name, text);
}

function cleanMcpGatewayText(value) {
  return String(value || "").trim();
}

function cleanMcpGatewayPort(value) {
  const text = cleanMcpGatewayText(value);
  if (!text) return "";
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? String(Math.trunc(number)) : "";
}

function cleanMcpGatewayPath(value) {
  const text = cleanMcpGatewayText(value);
  if (!text) return "";
  return text.startsWith("/") ? text : `/${text}`;
}

function mcpGatewayPath(settings = {}) {
  return cleanMcpGatewayPath(settings.mcp_gateway_path);
}

function killProcessTree(processHandle) {
  if (!processHandle?.pid) return;
  if (process.platform !== "win32") {
    processHandle.kill();
    return;
  }
  execFile("taskkill.exe", ["/pid", String(processHandle.pid), "/t", "/f"], { windowsHide: true }, () => {});
}

function quoteArg(value) {
  const text = String(value);
  return /[\s"]/g.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function collectOutput(output, chunk) {
  output.push(String(chunk || "").replace(/\s+/g, " ").trim());
  while (output.join(" ").length > 800 && output.length > 1) output.shift();
}

function exitMessage(code, signal, output = []) {
  const detail = output.filter(Boolean).join(" ").slice(0, 500);
  if (signal) return detail ? `进程已退出：${signal}；${detail}` : `进程已退出：${signal}`;
  if (typeof code === "number" && code !== 0) return detail ? `进程已退出：${code}；${detail}` : `进程已退出：${code}`;
  return "";
}

module.exports = {
  createMcpGatewayService,
  buildMcpGatewayCommand,
  mcpGatewayUrl,
  mcpGatewayPath,
  resolveWindowsNpmShim
};
