const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { browserDataDir } = require("./paths.cjs");
const { createStore } = require("./store.cjs");
const { createGateway } = require("./gateway.cjs");
const { createAuthService, accountFromTokens } = require("./auth.cjs");
const { normalizeUsagePayload } = require("./quota.cjs");
const { applyGatewayMode, applyAccountMode, detectCodexAuthMode } = require("./codex-cli-auth.cjs");

fs.mkdirSync(browserDataDir(), { recursive: true });
app.setPath("userData", browserDataDir());
app.setName("Codex Gateway");
app.setAppUserModelId("io.github.jadchene.codex-gateway");

let mainWindow;
let store;
let gateway;
let authService;
let tray;
let creatingTray = false;
let usageRefreshTimer = null;
const usageResetTimers = new Map();
let shuttingDown = false;

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
  store = createObservableStore(createStore());
  syncDetectedCodexAuthMode();
  authService = createAuthService(store, () => gateway.start(), refreshUsage);
  gateway = createGateway(store, authService, { refreshAllUsage, refreshAccountToken: refreshGatewayAccountToken });
  registerIpc();
  scheduleUsageRefresh("startup");
  checkStaleQuotasOnStartup();
  if (store.getSettings().auto_start_gateway === "true") {
    gateway.start().then(() => {
      store.addAppLog({ scope: "gateway", action: "auto-start", status: "success", message: "应用启动时自动启动网关" });
      updateTrayMenu();
    }).catch((error) => {
      store.addAppLog({ level: "error", scope: "gateway", action: "auto-start", status: "failed", message: error.message });
    });
  }
  await createWindow();
  syncTrayForSettings();
});

function createObservableStore(baseStore) {
  return {
    ...baseStore,
    saveAccount(account) {
      const result = baseStore.saveAccount(account);
      notifyDataChanged(["accounts"]);
      return result;
    },
    setAccountEnabled(id, enabled) {
      const result = baseStore.setAccountEnabled(id, enabled);
      notifyDataChanged(["accounts"]);
      return result;
    },
    deleteAccount(id) {
      const result = baseStore.deleteAccount(id);
      notifyDataChanged(["accounts"]);
      return result;
    },
    updateUsage(id, usage) {
      const result = baseStore.updateUsage(id, usage);
      notifyDataChanged(["accounts"]);
      return result;
    },
    addTokenLog(entry) {
      const result = baseStore.addTokenLog(entry);
      notifyDataChanged(["tokenLogs", "tokenSummary"]);
      return result;
    },
    clearTokenLogs() {
      const result = baseStore.clearTokenLogs();
      notifyDataChanged(["tokenLogs", "tokenSummary"]);
      return result;
    },
    addAppLog(entry) {
      const result = baseStore.addAppLog(entry);
      notifyDataChanged(["appLogs"]);
      return result;
    },
    clearAppLogs() {
      const result = baseStore.clearAppLogs();
      notifyDataChanged(["appLogs"]);
      return result;
    }
  };
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  requestAppExit("app-before-quit");
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
});

process.once("SIGINT", () => {
  shutdownRuntime("sigint").finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  shutdownRuntime("sigterm").finally(() => process.exit(0));
});

process.once("uncaughtException", (error) => {
  console.error(error);
  shutdownRuntime("uncaught-exception", error).finally(() => process.exit(1));
});

process.once("unhandledRejection", (reason) => {
  console.error(reason);
  shutdownRuntime("unhandled-rejection", reason).finally(() => process.exit(1));
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
    scheduleUsageRefresh("settings-save");
    syncTrayForSettings();
    return settings;
  });
  ipcMain.handle("accounts:save", (_event, account) => store.saveAccount(account));
  ipcMain.handle("accounts:setEnabled", (_event, id, enabled) => {
    store.setAccountEnabled(id, enabled);
    if (!enabled) clearUsageResetTimer(id, "account-disabled");
    return store.listAccounts();
  });
  ipcMain.handle("accounts:delete", (_event, id) => {
    store.deleteAccount(id);
    clearUsageResetTimer(id, "account-deleted");
    return store.listAccounts();
  });
  ipcMain.handle("accounts:list", () => store.listAccounts());
  ipcMain.handle("tokens:list", (_event, query) => store.listTokenLogs(query));
  ipcMain.handle("tokens:summary", (_event, query) => store.tokenSummary(query));
  ipcMain.handle("tokens:clear", () => {
    const result = store.clearTokenLogs();
    store.addAppLog({
      scope: "logs",
      action: "clear-token-logs",
      status: "success",
      message: `已清空调用记录：${result.deleted} 条`
    });
    return result;
  });
  ipcMain.handle("appLogs:list", (_event, query) => store.listAppLogs(query));
  ipcMain.handle("appLogs:clear", () => store.clearAppLogs());
  ipcMain.handle("gateway:start", async () => {
    return startGateway("manual");
  });
  ipcMain.handle("gateway:stop", async () => {
    return stopGateway("manual");
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
  ipcMain.handle("accounts:importLocalCodex", async () => importLocalCodexAccount());
}

async function startGateway(reason = "manual") {
  const status = await gateway.start();
  store.addAppLog({
    scope: "gateway",
    action: reason === "tray" ? "tray-start" : "start",
    status: "success",
    message: reason === "tray" ? "托盘菜单启动网关" : "网关已启动"
  });
  updateTrayMenu();
  notifyGatewayStatus(status);
  return status;
}

async function stopGateway(reason = "manual") {
  const status = await gateway.stop();
  store.addAppLog({
    scope: "gateway",
    action: reason === "tray" ? "tray-stop" : "stop",
    status: "success",
    message: reason === "tray" ? "托盘菜单停止网关" : "网关已停止"
  });
  updateTrayMenu();
  notifyGatewayStatus(status);
  return status;
}

async function importLocalCodexAccount() {
  const file = path.join(os.homedir(), ".codex", "auth.json");
  if (!fs.existsSync(file)) throw new Error(`未找到 ${file}`);
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`auth.json 解析失败：${error.message}`);
  }
  const source = auth.tokens || auth;
  const tokens = {
    id_token: String(source.id_token || ""),
    access_token: String(source.access_token || ""),
    refresh_token: String(source.refresh_token || ""),
    account_id: String(source.account_id || "")
  };
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("auth.json 不是有效的 Codex 账号模式认证，缺少 access_token 或 refresh_token。");
  }
  if (auth.OPENAI_API_KEY && !auth.auth_mode && !auth.tokens) {
    throw new Error("当前 auth.json 是 API Key 网关模式，不是 Codex 账号模式。");
  }
  const account = {
    ...accountFromTokens(tokens),
    last_refresh: auth.last_refresh || new Date().toISOString(),
    note: "local codex auth.json"
  };
  if (tokens.account_id && !account.account_id) {
    account.account_id = tokens.account_id;
    account.workspace_id = tokens.account_id;
  }
  const saved = store.saveAccount(account);
  store.addAppLog({
    scope: "auth",
    action: "import-local-codex",
    status: "success",
    message: `已从 ~/.codex/auth.json 导入账号：${saved.name}`
  });
  try {
    const refreshed = await refreshUsage(saved.id);
    store.addAppLog({
      scope: "usage",
      action: "refresh-account",
      status: "success",
      message: `导入本地账号后已刷新额度：${refreshed.name}`
    });
    return refreshed;
  } catch (error) {
    store.addAppLog({
      level: "error",
      scope: "usage",
      action: "refresh-account",
      status: "failed",
      message: `导入本地账号后刷新额度失败：${saved.name}: ${compactError(error.message)}`
    });
    return saved;
  }
}

function notifyGatewayStatus(status = gateway?.status()) {
  if (!status || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("gateway:status-changed", status);
}

function notifyDataChanged(types) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("app:data-changed", Array.from(new Set(types)));
}

async function createTray() {
  if (tray || creatingTray) return tray;
  creatingTray = true;
  const image = await loadAppIcon();
  if (tray) {
    creatingTray = false;
    return tray;
  }
  tray = new Tray(image);
  tray.setToolTip("Codex Gateway");
  tray.on("double-click", showMainWindow);
  updateTrayMenu();
  creatingTray = false;
  return tray;
}

async function loadAppIcon() {
  try {
    const image = await app.getFileIcon(process.execPath, { size: "normal" });
    if (image && !image.isEmpty()) return image.resize({ width: 16, height: 16, quality: "best" });
  } catch (error) {
    if (store) {
      store.addAppLog({ scope: "app", action: "tray-icon", status: "failed", message: `读取应用图标失败：${error.message}` });
    }
  }
  return nativeImage.createEmpty();
}

function syncTrayForSettings() {
  if (!store) return;
  if (store.getSettings().close_behavior === "tray") {
    void createTray();
  } else if (tray) {
    tray.destroy();
    tray = null;
  }
}

function updateTrayMenu() {
  if (!tray || !gateway) return;
  const running = gateway.status().running;
  const menu = Menu.buildFromTemplate([
    {
      label: running ? "停止网关" : "启动网关",
      click: () => {
        const task = running ? stopGateway("tray") : startGateway("tray");
        task.catch((error) => {
          store.addAppLog({
            level: "error",
            scope: "gateway",
            action: running ? "tray-stop" : "tray-start",
            status: "failed",
            message: error.message
          });
          updateTrayMenu();
        });
      }
    },
    { label: "退出", click: () => requestAppExit("tray-exit") }
  ]);
  tray.setContextMenu(menu);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow().catch((error) => {
      store?.addAppLog({ level: "error", scope: "app", action: "show-window", status: "failed", message: error.message });
    });
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function requestAppExit(reason) {
  shutdownRuntime(reason).finally(() => app.exit(0));
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

async function shutdownRuntime(reason, error) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (usageRefreshTimer) {
    clearInterval(usageRefreshTimer);
    usageRefreshTimer = null;
    if (store) {
      store.addAppLog({
        scope: "usage",
        action: "timer-stop",
        status: reason,
        message: `退出时停止账号额度定时刷新任务：${reason}`
      });
    }
  }
  clearAllUsageResetTimers(reason);
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (store) {
    store.addAppLog({
      level: error ? "error" : "info",
      scope: "app",
      action: "shutdown",
      status: reason,
      message: error ? `应用退出清理：${reason}；${String(error?.message || error)}` : `应用退出清理：${reason}`
    });
  }
  if (authService?.stop) {
    try {
      await authService.stop();
    } catch (stopError) {
      if (store) {
        store.addAppLog({
          level: "error",
          scope: "auth",
          action: "login-server-stop",
          status: "failed",
          message: `退出时关闭登录回调服务失败：${stopError.message}`
        });
      }
    }
  }
  if (gateway) {
    try {
      const wasRunning = gateway.status().running;
      await gateway.stop();
      if (store && wasRunning) {
        store.addAppLog({
          scope: "gateway",
          action: "stop",
          status: reason,
          message: `退出时停止网关：${reason}`
        });
      }
    } catch (stopError) {
      if (store) {
        store.addAppLog({
          level: "error",
          scope: "gateway",
          action: "stop",
          status: "failed",
          message: `退出时关闭网关失败：${stopError.message}`
        });
      }
    }
  }
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
  win.on("close", (event) => {
    if (timer) clearTimeout(timer);
    if (!store || win.isDestroyed()) return;
    const bounds = win.getBounds();
    store.saveSettings({
      window_x: String(bounds.x),
      window_y: String(bounds.y),
      window_width: String(bounds.width),
      window_height: String(bounds.height)
    });
    if (!shuttingDown && store.getSettings().close_behavior === "tray") {
      event.preventDefault();
      void createTray();
      win.hide();
      store.addAppLog({
        scope: "app",
        action: "close-window",
        status: "tray",
        message: "关闭窗口时最小化到托盘"
      });
    }
  });
}

function scheduleUsageRefresh(reason = "settings-save") {
  if (usageRefreshTimer) {
    clearInterval(usageRefreshTimer);
    usageRefreshTimer = null;
    store.addAppLog({
      scope: "usage",
      action: "timer-stop",
      status: reason,
      message: `停止账号额度定时刷新任务：${reason}`
    });
  }
  const settings = store.getSettings();
  const intervalSecs = Number(settings.usage_refresh_interval_secs || 900);
  if (!Number.isFinite(intervalSecs) || intervalSecs <= 0) {
    store.addAppLog({
      scope: "usage",
      action: "timer-disabled",
      status: reason,
      message: `账号额度定时刷新任务未启动：间隔为 ${settings.usage_refresh_interval_secs || 0}`
    });
    return;
  }
  const effectiveIntervalSecs = Math.max(60, intervalSecs);
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
  }, effectiveIntervalSecs * 1000);
  store.addAppLog({
    scope: "usage",
    action: "timer-start",
    status: reason,
    message: `启动账号额度定时刷新任务：每 ${effectiveIntervalSecs} 秒`
  });
}

function checkStaleQuotasOnStartup() {
  const now = Math.floor(Date.now() / 1000);
  const accounts = store.listAccounts().filter((account) => account.enabled && account.access_token);
  for (const account of accounts) {
    const fiveHourUsed = Number(account.quota_5h_used_percent || 0);
    const sevenDayUsed = Number(account.quota_7d_used_percent || 0);
    const fiveHourResetAt = Number(account.quota_5h_reset_at || 0);
    const sevenDayResetAt = Number(account.quota_7d_reset_at || 0);

    const fiveHourStale = fiveHourUsed >= 100 && fiveHourResetAt > 0 && fiveHourResetAt < now;
    const sevenDayStale = sevenDayUsed >= 100 && sevenDayResetAt > 0 && sevenDayResetAt < now;

    if (fiveHourStale || sevenDayStale) {
      store.addAppLog({
        scope: "usage",
        action: "startup-stale-refresh",
        status: "start",
        message: `启动时检测到账号额度已过重置时间，开始自动刷新：${account.email || account.name || account.id}`
      });
      refreshUsage(account.id).catch((error) => {
        store.addAppLog({
          level: "error",
          scope: "usage",
          action: "startup-stale-refresh",
          status: "failed",
          message: `启动时自动刷新过期账号额度失败：${account.email || account.name || account.id}: ${compactError(error.message)}`
        });
      });
    }
  }
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
        const refreshed = store.listAccounts().find((item) => item.id === id);
        scheduleUsageResetRefresh(refreshed, "usage-refresh");
        return refreshed;
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

function scheduleUsageResetRefresh(account, reason = "usage-refresh") {
  if (!account?.id) return;
  const label = account.email || account.name || account.id;
  const fiveHourUsed = Number(account.quota_5h_used_percent || 0);
  const sevenDayUsed = Number(account.quota_7d_used_percent || 0);
  const resetAt = Number(account.quota_5h_reset_at || 0);
  if (!(fiveHourUsed >= 100 && sevenDayUsed < 100 && resetAt > 0 && account.enabled)) {
    clearUsageResetTimer(account.id, "quota-available");
    return;
  }
  const existing = usageResetTimers.get(account.id);
  if (existing?.resetAt === resetAt) return;
  if (existing) {
    clearTimeout(existing.timer);
    usageResetTimers.delete(account.id);
    store.addAppLog({
      scope: "usage",
      action: "reset-refresh-reschedule",
      status: reason,
      message: `账号 5 小时额度重置刷新任务已重新计划：${label}，${formatTime(resetAt)} 后 1 分钟`
    });
  }
  const delayMs = Math.max(1000, resetAt * 1000 + 60_000 - Date.now());
  const timer = setTimeout(() => {
    usageResetTimers.delete(account.id);
    store.addAppLog({
      scope: "usage",
      action: "reset-refresh-run",
      status: "start",
      message: `开始执行 5 小时额度重置后账号刷新：${label}`
    });
    refreshUsage(account.id)
      .then((refreshed) => {
        store.addAppLog({
          scope: "usage",
          action: "reset-refresh-run",
          status: "success",
          message: `已执行 5 小时额度重置后账号刷新：${refreshed.email || refreshed.name || refreshed.id}`
        });
      })
      .catch((error) => {
        store.addAppLog({
          level: "error",
          scope: "usage",
          action: "reset-refresh-run",
          status: "failed",
          message: `5 小时额度重置后账号刷新失败：${label}: ${compactError(error.message)}`
        });
      });
  }, delayMs);
  usageResetTimers.set(account.id, { timer, resetAt });
  store.addAppLog({
    scope: "usage",
    action: "reset-refresh-schedule",
    status: reason,
    message: `账号 5 小时额度已用满，已计划在重置时间后 1 分钟自动刷新：${label}，${formatTime(resetAt)}`
  });
}

function clearUsageResetTimer(accountId, reason = "clear") {
  const existing = usageResetTimers.get(accountId);
  if (!existing) return;
  clearTimeout(existing.timer);
  usageResetTimers.delete(accountId);
  if (store) {
    store.addAppLog({
      scope: "usage",
      action: "reset-refresh-stop",
      status: reason,
      message: `停止账号 5 小时额度重置刷新任务：${accountId}，${reason}`
    });
  }
}

function clearAllUsageResetTimers(reason = "shutdown") {
  const count = usageResetTimers.size;
  for (const { timer } of usageResetTimers.values()) clearTimeout(timer);
  usageResetTimers.clear();
  if (store && count > 0) {
    store.addAppLog({
      scope: "usage",
      action: "reset-refresh-stop-all",
      status: reason,
      message: `停止全部账号 5 小时额度重置刷新任务：${count} 个，${reason}`
    });
  }
}

function formatTime(epochSeconds) {
  return new Date(Number(epochSeconds) * 1000).toLocaleString("zh-CN", { hour12: false });
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

async function refreshGatewayAccountToken(accountId) {
  const account = store.listAccounts().find((item) => item.id === accountId);
  if (!account) throw new Error("Account not found.");
  if (!account.refresh_token) throw new Error("Account has no refresh token.");
  const refreshed = await refreshAccessToken(account);
  const saved = store.saveAccount({ ...account, ...refreshed });
  store.addAppLog({
    scope: "gateway",
    action: "refresh-token",
    status: "success",
    message: `网关请求前刷新账号 token：${saved.email || saved.name || saved.id}`
  });
  return saved;
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
