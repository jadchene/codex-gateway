const { execFile, spawn } = require("node:child_process");

const MCP_GATEWAY_COMMAND = "mcp-gateway-service";

function createMcpGatewayService(store, hooks = {}) {
  let child = null;
  let state = stoppedState();
  let stopping = false;

  async function start() {
    if (child) return state;
    const settings = store.getSettings();
    const command = buildMcpGatewayCommand(settings);
    const args = mcpGatewayArgs(settings);
    const output = [];
    stopping = false;
    child = spawn(MCP_GATEWAY_COMMAND, args, {
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk) => collectOutput(output, chunk));
    child.stderr?.on("data", (chunk) => collectOutput(output, chunk));
    state = {
      running: true,
      url: mcpGatewayUrl(settings),
      error: "",
      pid: child.pid || 0,
      command
    };
    child.once("error", (error) => {
      child = null;
      state = { ...stoppedState(settings), error: error.message };
      hooks.onStatusChanged?.(state);
    });
    child.once("exit", (code, signal) => {
      child = null;
      state = stopping ? stoppedState(settings) : { ...stoppedState(settings), error: exitMessage(code, signal, output) };
      stopping = false;
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
    const closing = child;
    child = null;
    stopping = true;
    await new Promise((resolve) => {
      closing.once("exit", resolve);
      killProcessTree(closing);
      setTimeout(resolve, 1500);
    });
    state = stoppedState(settings);
    return state;
  }

  function status() {
    const settings = store.getSettings();
    return child
      ? state
      : stoppedState(settings);
  }

  return { start, stop, status };
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
  if (settings.mcp_gateway_json_response === "true") args.push("--json-response");
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
  mcpGatewayPath
};
