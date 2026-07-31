import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "./app/layout/AppShell";
import { applyAppearancePreferences, appearanceFromSettings } from "./app/appearance";
import type { PublicAccount } from "../shared/contracts/accounts";
import type { BootstrapData } from "../shared/contracts/bootstrap";
import type { AppLogPage, LogQuery, RequestLogPage, TokenSummary } from "../shared/contracts/logs";
import type { RuntimePaths, ServiceStatus, Settings } from "../shared/contracts/settings";

const UpstreamsPage = React.lazy(() => import("./features/upstreams/UpstreamsPage").then((module) => ({ default: module.UpstreamsPage })));
const SettingsPage = React.lazy(() => import("./features/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const ServicesPage = React.lazy(() => import("./features/services/ServicesPage").then((module) => ({ default: module.ServicesPage })));
const OverviewPage = React.lazy(() => import("./features/overview/OverviewPage").then((module) => ({ default: module.OverviewPage })));
const AccountsPage = React.lazy(() => import("./features/accounts/AccountsPage").then((module) => ({ default: module.AccountsPage })));
const CodexIntegrationPage = React.lazy(() => import("./features/codex-integration/CodexIntegrationPage").then((module) => ({ default: module.CodexIntegrationPage })));
const RequestAnalyticsPage = React.lazy(() => import("./features/request-analytics/RequestAnalyticsPage").then((module) => ({ default: module.RequestAnalyticsPage })));
const RuntimeLogsPage = React.lazy(() => import("./features/runtime-logs/RuntimeLogsPage").then((module) => ({ default: module.RuntimeLogsPage })));

const pages = [
  { id: "overview", label: "概览" },
  { id: "accounts", label: "订阅账号" },
  { id: "upstreams", label: "API 上游" },
  { id: "services", label: "服务管理" },
  { id: "analytics", label: "调用分析" },
  { id: "runtimeLogs", label: "运行日志" },
  { id: "codexIntegration", label: "CLI 接入" },
  { id: "settings", label: "设置中心" }
];

function App() {
  const api = window.codexGateway;
  const location = useLocation();
  const navigate = useNavigate();
  const page = location.pathname.replace(/^\//, "") || "overview";
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>({});
  const [accounts, setAccounts] = useState<PublicAccount[]>([]);
  const [tokenLogs, setTokenLogs] = useState<RequestLogPage>({ items: [], total: 0, page: 1, pageSize: 10 });
  const [tokenSummary, setTokenSummary] = useState<TokenSummary>({ total: {}, byAccount: [] });
  const [dashboardSummary, setDashboardSummary] = useState<TokenSummary>({ total: {}, byAccount: [] });
  const [quotaSummary, setQuotaSummary] = useState<BootstrapData["quotaSummary"]>({ primary: {}, secondary: {} });
  const [appLogs, setAppLogs] = useState<AppLogPage>({ items: [], total: 0, page: 1, pageSize: 10 });
  const [gateway, setGateway] = useState<ServiceStatus>({ running: false, url: "" });
  const [mcpGateway, setMcpGateway] = useState<ServiceStatus>({ running: false, url: "", command: "" });
  const [paths, setPaths] = useState<RuntimePaths>({ dataDir: "", dbPath: "" });
  const [appVersion, setAppVersion] = useState("");
  const [message, setMessage] = useState("");
  const [loginId, setLoginId] = useState("");
  const [refreshingIds, setRefreshingIds] = useState(() => new Set<string>());
  const [retryIds, setRetryIds] = useState(() => new Set<string>());
  const tokenLogsRef = useRef(tokenLogs);
  const appLogsRef = useRef(appLogs);
  const appLogsPausedRef = useRef(false);
  const [appLogsPaused, setAppLogsPaused] = useState(false);
  const [pendingAppLogBatches, setPendingAppLogBatches] = useState(0);

  async function reload() {
    const data = await api.bootstrap();
    setAppVersion(data.app?.version || "");
    setSettings(data.settings);
    setAccounts(data.accounts);
    setTokenLogs(data.tokenLogs);
    setTokenSummary(data.tokenSummary || { total: {}, byAccount: [] });
    setDashboardSummary(data.tokenSummary || { total: {}, byAccount: [] });
    setQuotaSummary(data.quotaSummary || { primary: {}, secondary: {} });
    setAppLogs(data.appLogs);
    setGateway(data.gateway);
    setMcpGateway(data.mcpGateway || { running: false, url: "", command: "" });
    setPaths(data.paths);
    applyAppearancePreferences(appearanceFromSettings(data.settings));
    setReady(true);
  }

  useEffect(() => {
    reload().catch((error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    tokenLogsRef.current = tokenLogs;
  }, [tokenLogs]);

  useEffect(() => {
    appLogsRef.current = appLogs;
  }, [appLogs]);

  useEffect(() => {
    if (!api.onGatewayStatusChanged) return undefined;
    return api.onGatewayStatusChanged((status) => {
      setGateway(status);
    });
  }, []);

  useEffect(() => {
    if (!api.onMcpGatewayStatusChanged) return undefined;
    return api.onMcpGatewayStatusChanged((status) => {
      setMcpGateway(status);
    });
  }, []);

  useEffect(() => {
    if (!api.onDataChanged) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<string>();
    const unsubscribe = api.onDataChanged((types) => {
      for (const type of types || []) pending.add(type);
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const next = new Set(pending);
        pending.clear();
        try {
          if (next.has("accounts")) {
            setAccounts(await api.listAccounts());
            setQuotaSummary(await api.quotaSummary());
          }
          if (next.has("tokenLogs") || next.has("tokenSummary")) {
            const current = tokenLogsRef.current || {};
            const query = currentLogQuery(current);
            setTokenLogs(await api.listTokenLogs(query));
            setTokenSummary(await api.tokenSummary(query));
            setDashboardSummary(await api.tokenSummary());
          }
          if (next.has("appLogs")) {
            if (appLogsPausedRef.current) {
              setPendingAppLogBatches((count) => count + 1);
            } else {
              const current = appLogsRef.current || {};
              setAppLogs(await api.listAppLogs(currentLogQuery(current)));
            }
          }
        } catch (error) {
          setMessage(`自动刷新失败：${errorMessage(error)}`);
        }
      }, 150);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => setMessage(""), 2000);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!loginId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const status = await api.loginStatus(loginId);
        if (cancelled) return;
        if (status.status === "success") {
          setLoginId("");
          await reload();
          setMessage("登录成功，账号已保存");
          return;
        }
        if (status.status === "failed") {
          setLoginId("");
          setMessage(`登录失败：${status.error || "未知错误"}`);
          return;
        }
        timer = setTimeout(poll, 1800);
      } catch (error) {
        if (!cancelled) {
          setMessage(`查询登录状态失败：${errorMessage(error)}`);
          timer = setTimeout(poll, 3000);
        }
      }
    };
    timer = setTimeout(poll, 300);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [loginId]);

  const gatewayBase = `${gateway.url || `http://${settings.gateway_host || "localhost"}:${settings.gateway_port || "8436"}`}/v1`;
  const mcpGatewayUrl = mcpGateway.url || mcpGatewayBaseUrl(settings);

  async function saveSettings(next: Settings): Promise<Settings> {
    try {
      const saved = await api.saveSettings(next);
      setSettings(saved);
      applyAppearancePreferences(appearanceFromSettings(saved));
      setMessage("配置已保存");
      return saved;
    } catch (error) {
      setMessage(`保存配置失败：${errorMessage(error)}`);
      throw error;
    }
  }

  async function startLogin() {
    try {
      const result = await api.startLogin();
      setLoginId(result.loginId);
      setMessage("已打开浏览器登录页面，完成授权后会自动保存账号");
    } catch (error) {
      setMessage(`启动登录失败：${errorMessage(error)}`);
    }
  }

  async function importLocalCodexAccount() {
    try {
      const account = await api.importLocalCodexAccount();
      await reload();
      setMessage(`已导入账号：${account.name}`);
    } catch (error) {
      setMessage(`本地读取失败：${errorMessage(error)}`);
    }
  }

  async function refreshUsage(account: PublicAccount): Promise<void> {
    setRefreshingIds((prev) => new Set(prev).add(account.id));
    try {
      await api.refreshUsage(account.id);
      setRetryIds((prev) => {
        const next = new Set(prev);
        next.delete(account.id);
        return next;
      });
      await reload();
      setMessage(`${account.name} 额度已刷新`);
    } catch (error) {
      setRetryIds((prev) => new Set(prev).add(account.id));
      setMessage(`刷新失败：${errorMessage(error)}`);
    } finally {
      setRefreshingIds((prev) => {
        const next = new Set(prev);
        next.delete(account.id);
        return next;
      });
    }
  }

  async function refreshAllUsage() {
    setMessage("正在刷新所有账号额度...");
    try {
      const results = await api.refreshAllUsage();
      await reload();
      const okCount = results.filter((item) => item.ok).length;
      const failCount = results.length - okCount;
      if (results.length === 0) {
        setMessage("没有可刷新的启用账号");
      } else if (failCount === 0) {
        setMessage("所有账号额度刷新完成");
      } else if (okCount === 0) {
        setMessage(`刷新全部失败：${failCount}/${results.length} 个账号失败`);
      } else {
        setMessage(`部分账号刷新成功：${okCount}/${results.length}，失败 ${failCount} 个`);
      }
    } catch (error) {
      setMessage(`刷新全部失败：${errorMessage(error)}`);
    }
  }

  async function toggleGateway() {
    try {
      const next = gateway.running ? await api.stopGateway() : await api.startGateway();
      setGateway(next);
      setMessage(next.running ? "网关已启动" : "网关已停止");
    } catch (error) {
      setMessage(`网关操作失败：${errorMessage(error)}`);
    }
  }

  async function toggleMcpGateway() {
    try {
      const next = mcpGateway.running ? await api.stopMcpGateway() : await api.startMcpGateway();
      setMcpGateway(next);
      setMessage(next.running ? "MCP 网关已启动" : "MCP 网关已停止");
    } catch (error) {
      setMessage(`MCP 网关操作失败：${errorMessage(error)}`);
    }
  }

  async function restartGateway() {
    try {
      await api.stopGateway();
      const next = await api.startGateway();
      setGateway(next);
      setMessage("网关已重启");
    } catch (error) {
      setMessage(`网关重启失败：${errorMessage(error)}`);
    }
  }

  async function restartMcpGateway() {
    try {
      await api.stopMcpGateway();
      const next = await api.startMcpGateway();
      setMcpGateway(next);
      setMessage("MCP 网关已重启");
    } catch (error) {
      setMessage(`MCP 网关重启失败：${errorMessage(error)}`);
    }
  }

  async function setAccountEnabled(account: PublicAccount, enabled: boolean): Promise<void> {
    try {
      await api.setAccountEnabled(account.id, enabled);
      await reload();
      setMessage(`${account.name} 已${enabled ? "启用" : "停用"}`);
    } catch (error) {
      setMessage(`${enabled ? "启用" : "停用"}账号失败：${errorMessage(error)}`);
    }
  }

  async function clearTokenLogs() {
    try {
      const result = await api.clearTokenLogs();
      const current = tokenLogsRef.current || {};
      const query = currentLogQuery(current, 1);
      setTokenLogs(await api.listTokenLogs(query));
      setTokenSummary(await api.tokenSummary(query));
      setDashboardSummary(await api.tokenSummary());
      setMessage(`已清空调用记录：${result.deleted || 0} 条`);
    } catch (error) {
      setMessage(`清空调用记录失败：${errorMessage(error)}`);
    }
  }

  async function clearAppLogs() {
    try {
      const result = await api.clearAppLogs();
      const current = appLogsRef.current || {};
      setAppLogs(await api.listAppLogs(currentLogQuery(current, 1)));
      setMessage(`已清空运行日志：${result.deleted || 0} 条`);
    } catch (error) {
      setMessage(`清空运行日志失败：${errorMessage(error)}`);
    }
  }

  if (!ready) return <div className="boot">正在载入本地数据...</div>;

  return (
    <AppShell
      activePage={page}
      appVersion={appVersion}
      gatewayRunning={gateway.running}
      initiallyCollapsed={settings.navigation_collapsed === "true"}
      mcpGatewayRunning={mcpGateway.running}
      onCollapsedChange={(collapsed) => {
        api.saveSettings({ navigation_collapsed: collapsed ? "true" : "false" })
          .then((saved) => setSettings(saved))
          .catch((error) => setMessage(`保存导航状态失败：${errorMessage(error)}`));
      }}
      onNavigate={(nextPage) => navigate(`/${nextPage}`)}
      pages={pages}
    >
      <section className="v1-app-content">
        {message && <div className="toast" role="status">{message}</div>}
        <React.Suspense fallback={<div className="boot">正在载入页面...</div>}>
        {page === "overview" && <OverviewPage
          accounts={accounts}
          gateway={gateway}
          mcpGateway={mcpGateway}
          tokenSummary={dashboardSummary}
          quotaSummary={quotaSummary}
          settings={settings}
          recentLogs={appLogs.items}
          onToggleGateway={toggleGateway}
          onRefreshAccounts={refreshAllUsage}
        />}
        {page === "accounts" && (
          <AccountsPage
            accounts={accounts}
            loginId={loginId}
            settings={settings}
            onStartLogin={startLogin}
            onImportLocal={importLocalCodexAccount}
            onCancelLogin={() => {
              setLoginId("");
              setMessage("已取消等待授权");
            }}
            onRefreshUsage={refreshUsage}
            onRefreshAll={refreshAllUsage}
            onSetEnabled={setAccountEnabled}
            refreshingIds={refreshingIds}
            retryIds={retryIds}
            onDelete={async (id) => {
              try {
                await api.deleteAccount(id);
                await reload();
                setMessage("账号已删除");
              } catch (error) {
                setMessage(`删除账号失败：${errorMessage(error)}`);
              }
            }}
          />
        )}
        {page === "codexIntegration" && (
          <CodexIntegrationPage
            settings={settings}
            accounts={accounts}
            gatewayBase={gatewayBase}
            modelCatalogPath={`${paths.dataDir.replace(/[\\/]+$/, "")}/models.json`}
            onMessage={setMessage}
            onApplyGateway={async () => {
              const result = await api.applyGatewayAuth();
              await reload();
              setMessage(result.providerChanged ? "已写入网关认证，并补充 Codex provider" : "已写入网关认证");
            }}
            onApplyAccount={async (accountId) => {
              const result = await api.applyAccountAuth(accountId);
              await reload();
              setMessage(result.providerRemoved ? "已写入账号模式认证，并移除网关 provider" : "已写入账号模式认证");
            }}
          />
        )}
        {page === "services" && (
          <ServicesPage
            gateway={gateway}
            mcpGateway={mcpGateway}
            gatewayBase={gatewayBase}
            mcpGatewayUrl={mcpGatewayUrl}
            mcpGatewayCommand={mcpGateway.command || mcpGatewayCommand(settings)}
            onToggleGateway={toggleGateway}
            onToggleMcpGateway={toggleMcpGateway}
            onRestartGateway={restartGateway}
            onRestartMcpGateway={restartMcpGateway}
            onMessage={setMessage}
          />
        )}
        {page === "settings" && (
          <SettingsPage
            settings={settings}
            paths={paths}
            gatewayRunning={gateway.running}
            mcpGatewayRunning={mcpGateway.running}
            onSave={saveSettings}
            onMessage={setMessage}
            onClearTokenLogs={clearTokenLogs}
            onClearAppLogs={clearAppLogs}
          />
        )}
        {page === "analytics" && (
          <RequestAnalyticsPage
            pageData={tokenLogs}
            summary={tokenSummary}
            accounts={accounts}
            settings={settings}
            onMessage={setMessage}
            onQuery={async (query) => {
              try {
                setTokenLogs(await api.listTokenLogs(query));
                setTokenSummary(await api.tokenSummary(query));
              } catch (error) {
                setMessage(`查询调用记录失败：${errorMessage(error)}`);
              }
            }}
          />
        )}
        {page === "runtimeLogs" && (
          <RuntimeLogsPage
            pageData={appLogs}
            paused={appLogsPaused}
            newLogCount={pendingAppLogBatches}
            onPausedChange={(paused) => {
              appLogsPausedRef.current = paused;
              setAppLogsPaused(paused);
              if (!paused) {
                setPendingAppLogBatches(0);
                void api.listAppLogs(currentLogQuery(appLogsRef.current || {}))
                  .then(setAppLogs)
                  .catch((error) => setMessage(`恢复日志刷新失败：${errorMessage(error)}`));
              }
            }}
            onMessage={setMessage}
            onQuery={async (query) => {
              try {
                setAppLogs(await api.listAppLogs(query));
              } catch (error) {
                setMessage(`查询运行日志失败：${errorMessage(error)}`);
              }
            }}
          />
        )}
        {page === "upstreams" && <UpstreamsPage />}
        </React.Suspense>
      </section>
    </AppShell>
  );
}

function mcpGatewayBaseUrl(settings: Settings = {}): string {
  const host = cleanMcpGatewayText(settings.mcp_gateway_host);
  const port = cleanMcpGatewayPort(settings.mcp_gateway_port);
  if (!host || !port) return "";
  return `http://${host}:${port}${cleanMcpGatewayPath(settings.mcp_gateway_path)}`;
}

function mcpGatewayCommand(settings: Settings = {}): string {
  const args = ["mcp-gateway-service", "--http"];
  appendOptionalMcpArg(args, "--config", settings.mcp_gateway_config_path);
  appendOptionalMcpArg(args, "--host", settings.mcp_gateway_host);
  appendOptionalMcpArg(args, "--port", cleanMcpGatewayPort(settings.mcp_gateway_port));
  appendOptionalMcpArg(args, "--path", cleanMcpGatewayPath(settings.mcp_gateway_path));
  return args.map(quoteCommandArg).join(" ");
}

function appendOptionalMcpArg(args: string[], name: string, value: unknown): void {
  const text = cleanMcpGatewayText(value);
  if (!text) return;
  args.push(name, text);
}

function cleanMcpGatewayText(value: unknown): string {
  return String(value || "").trim();
}

function cleanMcpGatewayPort(value: unknown): string {
  const text = cleanMcpGatewayText(value);
  if (!text) return "";
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? String(Math.trunc(number)) : "";
}

function cleanMcpGatewayPath(value: unknown): string {
  const text = cleanMcpGatewayText(value);
  if (!text) return "";
  return text.startsWith("/") ? text : `/${text}`;
}

function quoteCommandArg(value: unknown): string {
  const text = String(value);
  return /[\s"]/g.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function currentLogQuery(pageData: RequestLogPage | AppLogPage, page = pageData.page): LogQuery {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    page,
    pageSize: pageData.pageSize || 10,
    startAt: pageData.startAt ?? Math.floor(start.getTime() / 1000),
    endAt: pageData.endAt ?? Math.floor(end.getTime() / 1000)
  };
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export default App;
