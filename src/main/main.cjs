const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { browserDataDir } = require("./paths.cjs");
const { createStore } = require("./store.cjs");
const { createGateway } = require("./gateway.cjs");
const { createAuthService } = require("./auth.cjs");
const { normalizeUsagePayload } = require("./quota.cjs");
const { applyGatewayMode, applyAccountMode, detectCodexAuthMode } = require("./codex-cli-auth.cjs");

fs.mkdirSync(browserDataDir(), { recursive: true });
app.setPath("userData", browserDataDir());

let mainWindow;
let store;
let gateway;
let authService;
let usageRefreshTimer = null;

async function createWindow() {
  const bounds = readWindowBounds();
  mainWindow = new BrowserWindow({
    width: bounds.width || 1180,
    height: bounds.height || 760,
    x: bounds.x,
    y: bounds.y,
    minWidth: 980,
    minHeight: 640,
    title: "Codex Gateway",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);
  bindWindowBoundsPersistence(mainWindow);

  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (!app.isPackaged) {
    await mainWindow.loadURL("http://127.0.0.1:8435");
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "..", "dist", "renderer", "index.html"));
  }
}

app.whenReady().then(async () => {
  store = createStore();
  syncDetectedCodexAuthMode();
  authService = createAuthService(store, () => gateway.start(), refreshUsage);
  gateway = createGateway(store, authService, { refreshAllUsage });
  registerIpc();
  scheduleUsageRefresh();
  if (store.getSettings().auto_start_gateway === "true") {
    gateway.start().catch((error) => {
      store.addAppLog({ level: "error", scope: "gateway", action: "auto-start", status: "failed", message: error.message });
    });
  }
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
});

function registerIpc() {
  ipcMain.handle("app:bootstrap", () => ({
    settings: store.getSettings(),
    accounts: store.listAccounts(),
    tokenLogs: store.listTokenLogs(),
    tokenSummary: store.tokenSummary(),
    appLogs: store.listAppLogs(),
    gateway: gateway.status(),
    paths: store.paths
  }));
  ipcMain.handle("settings:save", (_event, patch) => {
    const settings = store.saveSettings(patch);
    scheduleUsageRefresh();
    return settings;
  });
  ipcMain.handle("accounts:save", (_event, account) => store.saveAccount(account));
  ipcMain.handle("accounts:setEnabled", (_event, id, enabled) => {
    store.setAccountEnabled(id, enabled);
    return store.listAccounts();
  });
  ipcMain.handle("accounts:delete", (_event, id) => {
    store.deleteAccount(id);
    return store.listAccounts();
  });
  ipcMain.handle("accounts:list", () => store.listAccounts());
  ipcMain.handle("tokens:list", (_event, query) => store.listTokenLogs(query));
  ipcMain.handle("tokens:summary", (_event, query) => store.tokenSummary(query));
  ipcMain.handle("appLogs:list", (_event, query) => store.listAppLogs(query));
  ipcMain.handle("gateway:start", async () => {
    const status = await gateway.start();
    store.addAppLog({ scope: "gateway", action: "start", status: "success", message: "网关已启动" });
    return status;
  });
  ipcMain.handle("gateway:stop", async () => {
    const status = await gateway.stop();
    store.addAppLog({ scope: "gateway", action: "stop", status: "success", message: "网关已停止" });
    return status;
  });
  ipcMain.handle("codexAuth:applyGatewayMode", () => {
    const settings = store.getSettings();
    const result = applyGatewayMode(settings);
    store.saveSettings({ codex_auth_mode: "gateway", codex_selected_account_id: "" });
    store.addAppLog({ scope: "auth", action: "apply-gateway", status: "success", message: "已写入 Codex CLI 网关模式认证" });
    return result;
  });
  ipcMain.handle("codexAuth:applyAccountMode", (_event, accountId) => {
    const account = store.listAccounts().find((item) => item.id === accountId);
    if (!account) throw new Error("账号不存在。");
    const result = applyAccountMode(account);
    store.saveSettings({ codex_auth_mode: "account", codex_selected_account_id: account.id });
    store.addAppLog({ scope: "auth", action: "apply-account", status: "success", message: `已写入 Codex CLI 账号模式认证：${account.name}` });
    return result;
  });
  ipcMain.handle("auth:startLogin", async () => {
    const result = await authService.startLogin();
    await shell.openExternal(result.authUrl);
    return result;
  });
  ipcMain.handle("auth:status", (_event, loginId) => authService.loginStatus(loginId));
  ipcMain.handle("shell:openPath", (_event, target) => shell.openPath(target));
  ipcMain.handle("accounts:refreshUsage", async (_event, id) => {
    const result = await refreshUsage(id);
    store.addAppLog({ scope: "usage", action: "refresh-account", status: "success", message: `已刷新账号额度：${result.name}` });
    return result;
  });
  ipcMain.handle("accounts:refreshAllUsage", async () => refreshAllUsage("manual"));
}

function syncDetectedCodexAuthMode() {
  const accounts = store.listAccounts();
  const detected = detectCodexAuthMode(store.getSettings(), accounts);
  store.saveSettings({
    codex_auth_mode: detected.mode,
    codex_selected_account_id: detected.accountId || ""
  });
  const account = detected.accountId ? accounts.find((item) => item.id === detected.accountId) : null;
  const message = detected.mode === "account"
    ? `启动时识别 Codex 认证模式：账号模式${account ? `（${account.email || account.name}）` : ""}`
    : detected.mode === "gateway"
      ? "启动时识别 Codex 认证模式：网关模式"
      : "启动时识别 Codex 认证模式：未知";
  store.addAppLog({
    scope: "auth",
    action: "detect-startup",
    status: detected.mode,
    message
  });
}

function readWindowBounds() {
  if (!store) return {};
  const settings = store.getSettings();
  const width = Number(settings.window_width);
  const height = Number(settings.window_height);
  const x = Number(settings.window_x);
  const y = Number(settings.window_y);
  return {
    width: Number.isFinite(width) && width >= 980 ? width : undefined,
    height: Number.isFinite(height) && height >= 640 ? height : undefined,
    x: Number.isFinite(x) ? x : undefined,
    y: Number.isFinite(y) ? y : undefined
  };
}

function bindWindowBoundsPersistence(win) {
  let timer = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!store || win.isDestroyed()) return;
      const bounds = win.getBounds();
      store.saveSettings({
        window_x: String(bounds.x),
        window_y: String(bounds.y),
        window_width: String(bounds.width),
        window_height: String(bounds.height)
      });
    }, 350);
  };
  win.on("resize", save);
  win.on("move", save);
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    if (!store || win.isDestroyed()) return;
    const bounds = win.getBounds();
    store.saveSettings({
      window_x: String(bounds.x),
      window_y: String(bounds.y),
      window_width: String(bounds.width),
      window_height: String(bounds.height)
    });
  });
}

function scheduleUsageRefresh() {
  if (usageRefreshTimer) {
    clearInterval(usageRefreshTimer);
    usageRefreshTimer = null;
  }
  const settings = store.getSettings();
  const intervalSecs = Number(settings.usage_refresh_interval_secs || 900);
  if (!Number.isFinite(intervalSecs) || intervalSecs <= 0) return;
  usageRefreshTimer = setInterval(() => {
    refreshAllUsage("timer").catch((error) => {
      store.addAppLog({
        level: "error",
        scope: "usage",
        action: "timer-refresh",
        status: "failed",
        message: error.message
      });
    });
  }, Math.max(60, intervalSecs) * 1000);
}

async function refreshUsage(id) {
  let account = store.listAccounts().find((item) => item.id === id);
  if (!account) throw new Error("Account not found.");
  const endpoints = [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/codex/usage"
  ];
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const endpoint of endpoints) {
      try {
        const payload = await requestUsage(endpoint, account);
        const usage = normalizeUsagePayload(payload);
        store.updateUsage(id, usage);
        return store.listAccounts().find((item) => item.id === id);
      } catch (error) {
        lastError = error;
      }
    }
    if (!shouldRefreshForUsageError(lastError) || !account.refresh_token) break;
    try {
      const refreshed = await refreshAccessToken(account);
      account = store.saveAccount({ ...account, ...refreshed });
    } catch (refreshError) {
      throw new Error(`刷新 token 失败：${refreshError.message}`);
    }
  }
  throw lastError || new Error("Usage refresh failed.");
}

async function refreshAllUsage(reason = "manual") {
  const accounts = store.listAccounts().filter((account) => account.enabled && account.access_token);
  const results = [];
  for (const account of accounts) {
    try {
      await refreshUsage(account.id);
      results.push({ id: account.id, label: account.email || account.name || account.id, ok: true });
    } catch (error) {
      results.push({ id: account.id, label: account.email || account.name || account.id, ok: false, message: error.message });
    }
  }
  const okCount = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok);
  const detail = failed.length > 0
    ? `；失败：${failed.map((item) => `${item.label}: ${compactError(item.message)}`).join(" | ")}`
    : "";
  store.addAppLog({
    scope: "usage",
    action: "refresh-all",
    status: results.some((item) => item.ok) ? "success" : "failed",
    message: `${reason}: ${okCount}/${results.length} refreshed${detail}`
  });
  return results;
}

function compactError(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 360);
}

async function requestUsage(endpoint, account) {
  const resp = await fetch(endpoint, {
    headers: {
      authorization: `Bearer ${account.access_token}`,
      "ChatGPT-Account-Id": account.account_id || account.workspace_id || "",
      accept: "application/json",
      "user-agent": "codex_cli_rs/0.1.0",
      origin: "https://chatgpt.com",
      referer: "https://chatgpt.com/"
    }
  });
  const text = await resp.text();
  if (!resp.ok) {
    const hint = looksLikeHtml(text) ? "HTML response, possible Cloudflare/auth challenge" : text.slice(0, 240);
    const error = new Error(`${resp.status} ${hint}`);
    error.status = resp.status;
    throw error;
  }
  return JSON.parse(text);
}

async function refreshAccessToken(account) {
  const body = new URLSearchParams({
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    grant_type: "refresh_token",
    refresh_token: account.refresh_token
  });
  const resp = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status} ${text.slice(0, 240)}`);
  const data = JSON.parse(text);
  return {
    access_token: data.access_token || account.access_token,
    refresh_token: data.refresh_token || account.refresh_token,
    id_token: data.id_token || account.id_token,
    last_refresh: new Date().toISOString()
  };
}

function shouldRefreshForUsageError(error) {
  return error?.status === 401 || error?.status === 403 || /^(401|403)\b/.test(String(error?.message || ""));
}

function looksLikeHtml(value) {
  return /^\s*<!doctype html|^\s*<html/i.test(String(value || ""));
}
