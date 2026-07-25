import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const pages = [
  { id: "dashboard", label: "仪表盘" },
  { id: "accounts", label: "账号管理" },
  { id: "auth", label: "认证管理" },
  { id: "gateway", label: "网关服务" },
  { id: "logs", label: "调用记录" },
  { id: "appLogs", label: "运行日志" },
  { id: "settings", label: "应用配置" }
];

function App() {
  const api = window.codexGateway;
  const [page, setPage] = useState("dashboard");
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState({});
  const [accounts, setAccounts] = useState([]);
  const [tokenLogs, setTokenLogs] = useState({ items: [], total: 0, page: 1, pageSize: 10 });
  const [codexSessions, setCodexSessions] = useState({ items: [], total: 0, page: 1, pageSize: 10 });
  const [sessionQuery, setSessionQuery] = useState({ name: "", page: 1, pageSize: 10 });
  const [tokenSummary, setTokenSummary] = useState({ total: {}, byAccount: [] });
  const [dashboardSummary, setDashboardSummary] = useState({ total: {}, byAccount: [] });
  const [quotaSummary, setQuotaSummary] = useState({ primary: {}, secondary: {} });
  const [appLogs, setAppLogs] = useState({ items: [], total: 0, page: 1, pageSize: 10 });
  const [gateway, setGateway] = useState({ running: false, url: "" });
  const [mcpGateway, setMcpGateway] = useState({ running: false, url: "", command: "" });
  const [paths, setPaths] = useState({});
  const [message, setMessage] = useState("");
  const [loginId, setLoginId] = useState("");
  const [refreshingIds, setRefreshingIds] = useState(() => new Set());
  const [retryIds, setRetryIds] = useState(() => new Set());
  const tokenLogsRef = useRef(tokenLogs);
  const appLogsRef = useRef(appLogs);

  async function reload() {
    const data = await api.bootstrap();
    setSettings(data.settings);
    setAccounts(data.accounts);
    setTokenLogs(data.tokenLogs);
    setCodexSessions(data.codexSessions || { items: [], total: 0, page: 1, pageSize: 10 });
    setTokenSummary(data.tokenSummary || { total: {}, byAccount: [] });
    setDashboardSummary(data.tokenSummary || { total: {}, byAccount: [] });
    setQuotaSummary(data.quotaSummary || { primary: {}, secondary: {} });
    setAppLogs(data.appLogs);
    setGateway(data.gateway);
    setMcpGateway(data.mcpGateway || { running: false, url: "", command: "" });
    setPaths(data.paths);
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
    let timer = null;
    const pending = new Set();
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
            const query = {
              page: current.page || 1,
              pageSize: current.pageSize || 10,
              startAt: current.startAt,
              endAt: current.endAt
            };
            setTokenLogs(await api.listTokenLogs(query));
            setTokenSummary(await api.tokenSummary(query));
            setDashboardSummary(await api.tokenSummary());
          }
          if (next.has("appLogs")) {
            const current = appLogsRef.current || {};
            setAppLogs(await api.listAppLogs({
              page: current.page || 1,
              pageSize: current.pageSize || 10,
              startAt: current.startAt,
              endAt: current.endAt
            }));
          }
        } catch (error) {
          setMessage(`自动刷新失败：${error.message}`);
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
    let timer = null;
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
          setMessage(`查询登录状态失败：${error.message}`);
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

  const activeAccounts = useMemo(() => accounts.filter((item) => item.enabled && item.status === "active"), [accounts]);
  const gatewayBase = `${gateway.url || `http://${settings.gateway_host || "localhost"}:${settings.gateway_port || "8436"}`}/v1`;
  const mcpGatewayUrl = mcpGateway.url || mcpGatewayBaseUrl(settings);

  async function saveSettings(next) {
    try {
      setSettings(await api.saveSettings(next));
      setMessage("配置已保存");
    } catch (error) {
      setMessage(`保存配置失败：${error.message}`);
    }
  }

  async function startLogin() {
    try {
      const result = await api.startLogin();
      setLoginId(result.loginId);
      setMessage("已打开浏览器登录页面，完成授权后会自动保存账号");
    } catch (error) {
      setMessage(`启动登录失败：${error.message}`);
    }
  }

  async function importLocalCodexAccount() {
    try {
      const account = await api.importLocalCodexAccount();
      await reload();
      setMessage(`已导入账号：${account.name}`);
    } catch (error) {
      setMessage(`本地读取失败：${error.message}`);
    }
  }

  async function refreshUsage(account) {
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
      setMessage(`刷新失败：${error.message}`);
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
      setMessage(`刷新全部失败：${error.message}`);
    }
  }

  async function toggleGateway() {
    try {
      const next = gateway.running ? await api.stopGateway() : await api.startGateway();
      setGateway(next);
      setMessage(next.running ? "网关已启动" : "网关已停止");
    } catch (error) {
      setMessage(`网关操作失败：${error.message}`);
    }
  }

  async function toggleMcpGateway() {
    try {
      const next = mcpGateway.running ? await api.stopMcpGateway() : await api.startMcpGateway();
      setMcpGateway(next);
      setMessage(next.running ? "MCP 网关已启动" : "MCP 网关已停止");
    } catch (error) {
      setMessage(`MCP 网关操作失败：${error.message}`);
    }
  }

  async function saveCodexSession(session) {
    const saved = await api.saveCodexSession(session);
    setCodexSessions(await api.listCodexSessions(sessionQuery));
    setMessage(`会话已保存：${saved.name}`);
    return saved;
  }

  async function queryCodexSessions(query) {
    try {
      setSessionQuery(query);
      setCodexSessions(await api.listCodexSessions(query));
    } catch (error) {
      setMessage(`查询会话失败：${error.message}`);
    }
  }

  async function deleteCodexSession(session) {
    if (!window.confirm(`确定要删除会话“${session.name}”吗？`)) return;
    try {
      await api.deleteCodexSession(session.session_id);
      const nextQuery = { ...sessionQuery };
      setCodexSessions(await api.listCodexSessions(nextQuery));
      setMessage(`已删除会话：${session.name}`);
    } catch (error) {
      setMessage(`删除会话失败：${error.message}`);
    }
  }

  async function setAccountEnabled(account, enabled) {
    try {
      await api.setAccountEnabled(account.id, enabled);
      await reload();
      setMessage(`${account.name} 已${enabled ? "启用" : "停用"}`);
    } catch (error) {
      setMessage(`${enabled ? "启用" : "停用"}账号失败：${error.message}`);
    }
  }

  async function clearTokenLogs() {
    if (!window.confirm("确定要清空全部调用记录吗？此操作不可恢复。")) return;
    try {
      const result = await api.clearTokenLogs();
      const current = tokenLogsRef.current || {};
      const query = {
        page: 1,
        pageSize: current.pageSize || 10,
        startAt: current.startAt,
        endAt: current.endAt
      };
      setTokenLogs(await api.listTokenLogs(query));
      setTokenSummary(await api.tokenSummary(query));
      setDashboardSummary(await api.tokenSummary());
      setMessage(`已清空调用记录：${result.deleted || 0} 条`);
    } catch (error) {
      setMessage(`清空调用记录失败：${error.message}`);
    }
  }

  async function clearAppLogs() {
    if (!window.confirm("确定要清空全部运行日志吗？此操作不可恢复。")) return;
    try {
      const result = await api.clearAppLogs();
      const current = appLogsRef.current || {};
      setAppLogs(await api.listAppLogs({
        page: 1,
        pageSize: current.pageSize || 10,
        startAt: current.startAt,
        endAt: current.endAt
      }));
      setMessage(`已清空运行日志：${result.deleted || 0} 条`);
    } catch (error) {
      setMessage(`清空运行日志失败：${error.message}`);
    }
  }

  if (!ready) return <div className="boot">正在载入本地数据...</div>;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand">Codex Gateway</div>
          <div className="muted">个人 GPT 账号管理与本地网关</div>
        </div>
        <nav>
          {pages.map((item) => (
            <button key={item.id} className={page === item.id ? "nav-active" : ""} onClick={() => setPage(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="content">
        {message && <div className="toast" role="status">{message}</div>}

        {page === "dashboard" && <Dashboard accounts={accounts} gateway={gateway} mcpGateway={mcpGateway} tokenSummary={dashboardSummary} quotaSummary={quotaSummary} settings={settings} />}
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
              if (!window.confirm("确定要删除这个账号吗？删除后需要重新登录授权。")) return;
              try {
                await api.deleteAccount(id);
                await reload();
                setMessage("账号已删除");
              } catch (error) {
                setMessage(`删除账号失败：${error.message}`);
              }
            }}
          />
        )}
        {page === "auth" && (
          <AuthManagementPage
            settings={settings}
            accounts={accounts}
            gatewayBase={gatewayBase}
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
        {page === "gateway" && (
          <GatewayPage
            gateway={gateway}
            mcpGateway={mcpGateway}
            gatewayBase={gatewayBase}
            mcpGatewayUrl={mcpGatewayUrl}
            settings={settings}
            onToggle={toggleGateway}
            onToggleMcp={toggleMcpGateway}
            onMessage={setMessage}
          />
        )}
        {page === "sessions" && (
          <SessionsPage
            sessions={codexSessions}
            query={sessionQuery}
            onQuery={queryCodexSessions}
            onSave={saveCodexSession}
            onDelete={deleteCodexSession}
            onMessage={setMessage}
          />
        )}
        {page === "settings" && (
          <SettingsPage
            settings={settings}
            paths={paths}
            onSave={saveSettings}
            onMessage={setMessage}
            onClearTokenLogs={clearTokenLogs}
            onClearAppLogs={clearAppLogs}
          />
        )}
        {page === "logs" && (
          <CallRecordsPage
            pageData={tokenLogs}
            summary={tokenSummary}
            accounts={accounts}
            settings={settings}
            onSaveSession={saveCodexSession}
            onMessage={setMessage}
            onQuery={async (query) => {
              try {
                setTokenLogs(await api.listTokenLogs(query));
                setTokenSummary(await api.tokenSummary(query));
              } catch (error) {
                setMessage(`查询调用记录失败：${error.message}`);
              }
            }}
          />
        )}
        {page === "appLogs" && (
          <AppLogsPage
            pageData={appLogs}
            onMessage={setMessage}
            onQuery={async (query) => {
              try {
                setAppLogs(await api.listAppLogs(query));
              } catch (error) {
                setMessage(`查询运行日志失败：${error.message}`);
              }
            }}
          />
        )}
      </section>
    </main>
  );
}

function Dashboard({ accounts, gateway, mcpGateway, tokenSummary, quotaSummary, settings }) {
  const usable = accounts.filter((a) => isUsableAccount(a, settings)).length;
  const total = tokenSummary?.total || {};
  const billingFactors = billingFactorsFromSettings(settings);
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>运行概览</h2>
          <p className="subtle">查看账号管理、本地网关和今天的调用用量。</p>
        </div>
      </div>
      <div className="dashboard-grid">
        <Metric title="可用账号" value={`${usable}/${accounts.length}`} className="dashboard-account-metric" />
        <Metric title="Codex 网关" value={gateway.running ? "运行中" : "未启动"} className="dashboard-codex-metric" />
        <Metric title="MCP 网关" value={mcpGateway.running ? "运行中" : "未启动"} className="dashboard-mcp-metric" />
      </div>
      <div className="dashboard-grid quota-metric-grid">
        {settings.ignore_five_hour_limit !== "true" && <QuotaMetric title="5 小时剩余额度" detail={quotaSummary?.primary} />}
        <QuotaMetric title="7 天剩余额度" detail={quotaSummary?.secondary} />
      </div>
      <div className="divider-title">今日网关数据统计</div>
      <div className="dashboard-grid">
        <Metric title="调用次数" value={total.calls || 0} />
        <Metric title="总 Token" value={total.total_tokens || 0} />
        <Metric title="输入(未命中) Token" value={formatUncachedPair(total.input_tokens, total.cached_input_tokens)} hint={cachedInputTitle(total.input_tokens, total.cached_input_tokens)} />
        <Metric title="输出 Token" value={total.output_tokens || 0} />
        <Metric title="计费系数" value={formatBillingCoefficient(total, billingFactors)} />
      </div>
    </section>
  );
}

function isUsableAccount(account, settings = {}) {
  if (!account) return false;
  if (!account.enabled || account.status === "disabled" || !account.has_access_token) return false;
  const now = Math.floor(Date.now() / 1000);
  const windows = [[account.quota_7d_used_percent, account.quota_7d_reset_at]];
  if (settings.ignore_five_hour_limit !== "true") windows.push([account.quota_5h_used_percent, account.quota_5h_reset_at]);
  return !windows.some(([usedValue, resetValue]) => {
    const used = Number(usedValue);
    if (!Number.isFinite(used) || used < 99.9) return false;
    const resetAt = Number(resetValue);
    return !Number.isFinite(resetAt) || resetAt <= 0 || resetAt > now;
  });
}

function AccountsPage({ accounts, loginId, refreshingIds, retryIds, settings, onStartLogin, onImportLocal, onCancelLogin, onRefreshUsage, onRefreshAll, onSetEnabled, onDelete }) {
  const [showAddOptions, setShowAddOptions] = useState(false);
  const [resetCreditsAccount, setResetCreditsAccount] = useState(null);
  const resetCredits = parseResetCredits(resetCreditsAccount);
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>GPT 账号</h2>
          <p className="subtle">通过浏览器授权登录，应用使用系统安全存储加密 Token 后保存到本地 SQLite。</p>
        </div>
        <div className="actions-inline">
          <button className="primary" onClick={() => setShowAddOptions(true)} disabled={Boolean(loginId)}>
            {loginId ? "等待授权..." : "添加账号"}
          </button>
          {loginId && <button onClick={onCancelLogin}>取消</button>}
          <button onClick={onRefreshAll}>刷新全部</button>
        </div>
      </div>
      {showAddOptions && !loginId && (
        <div className="modal-backdrop" onClick={() => setShowAddOptions(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-account-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3 id="add-account-title">添加账号</h3>
              <button className="modal-close" type="button" aria-label="关闭" onClick={() => setShowAddOptions(false)}>×</button>
            </div>
            <div className="modal-actions">
              <button
                className="primary"
                onClick={() => {
                  setShowAddOptions(false);
                  onStartLogin();
                }}
              >
                浏览器认证
              </button>
              <button
                onClick={() => {
                  setShowAddOptions(false);
                  onImportLocal();
                }}
              >
                本地读取
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="account-grid">
        {accounts.map((account) => (
          <article className="account-card" key={account.id}>
            <div className="account-head">
              <div>
                <h3>{account.name}</h3>
              </div>
              <span className={account.enabled ? "pill ok" : "pill"}>{account.enabled ? "启用" : "停用"}</span>
            </div>
            {settings.ignore_five_hour_limit !== "true" && <Quota label="5 小时" value={account.quota_5h_used_percent} resetAt={account.quota_5h_reset_at} />}
            <Quota label="7 天" value={account.quota_7d_used_percent} resetAt={account.quota_7d_reset_at} />
            <div className="meta-row"><span>套餐</span><b>{account.subscription_plan || "未知"}</b></div>
            <div className="meta-row"><span>订阅期限</span><b>{formatTime(account.subscription_expires_at)}</b></div>
            <div className="meta-row"><span>重置</span><b>{formatResetCreditsSummary(account)}</b></div>
            <div className="card-actions">
              <button onClick={() => onSetEnabled(account, !account.enabled)}>
                {account.enabled ? "停用" : "启用"}
              </button>
              <button onClick={() => onRefreshUsage(account)} disabled={refreshingIds.has(account.id)}>
                {refreshingIds.has(account.id) ? "刷新中..." : retryIds.has(account.id) ? "重试刷新" : "刷新"}
              </button>
              <button onClick={() => setResetCreditsAccount(account)}>重置</button>
              <button className="danger ghost" onClick={() => onDelete(account.id)}>删除</button>
            </div>
          </article>
        ))}
        {accounts.length === 0 && <div className="empty">还没有账号。点击“添加账号”完成 ChatGPT/Codex 授权。</div>}
      </div>
      {resetCreditsAccount && (
        <div className="modal-backdrop" onClick={() => setResetCreditsAccount(null)}>
          <div className="modal reset-credits-modal" role="dialog" aria-modal="true" aria-labelledby="reset-credits-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3 id="reset-credits-title">重置次数</h3>
                <p className="subtle">{resetCreditsAccount.name} · 可用 {resetCredits.availableCount} 次</p>
              </div>
              <button className="modal-close" type="button" aria-label="关闭" onClick={() => setResetCreditsAccount(null)}>×</button>
            </div>
            <div className="table-wrap reset-credits-table-wrap">
              <table className="reset-credits-table">
                <thead><tr><th>状态</th><th>重置类型</th><th>有效期开始</th><th>有效期结束</th></tr></thead>
                <tbody>
                  {resetCredits.credits.map((credit, index) => (
                    <tr key={`${credit.title}-${credit.granted_at}-${credit.expires_at}-${index}`}>
                      <td>{resetCreditStatusLabel(credit.status)}</td>
                      <td>{credit.title || "-"}</td>
                      <td>{formatTime(credit.granted_at)}</td>
                      <td>{formatTime(credit.expires_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {resetCredits.credits.length === 0 && <div className="empty">暂无重置次数数据，请先刷新账号额度。</div>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function AuthManagementPage({ settings, accounts, gatewayBase, onMessage, onApplyGateway, onApplyAccount }) {
  const savedAccountId = settings.codex_auth_mode === "account" ? settings.codex_selected_account_id || "" : "";
  const [mode, setMode] = useState(normalizeAuthMode(settings.codex_auth_mode));
  const [accountId, setAccountId] = useState(savedAccountId);
  const [busy, setBusy] = useState(false);
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const alreadyApplied = mode === "gateway"
    ? settings.codex_auth_mode === "gateway"
    : mode === "account" && settings.codex_auth_mode === "account" && settings.codex_selected_account_id === accountId;

  useEffect(() => {
    setMode(normalizeAuthMode(settings.codex_auth_mode));
    setAccountId(settings.codex_auth_mode === "account" ? settings.codex_selected_account_id || "" : "");
  }, [settings]);

  async function apply() {
    setBusy(true);
    try {
      if (mode === "gateway") await onApplyGateway();
      else if (mode === "account") await onApplyAccount(accountId);
    } catch (error) {
      onMessage(`写入失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel form-panel">
      <div className="section-title">
        <div>
          <h2>认证管理</h2>
          <p className="subtle">选择 Codex 使用本地网关，或直接切换为某个已登录账号。</p>
        </div>
      </div>
      <div className="mode-grid">
        <button type="button" className={`mode-card${mode === "gateway" ? " active" : ""}${settings.codex_auth_mode === "gateway" ? " current" : ""}`} onClick={() => setMode("gateway")}>
          {settings.codex_auth_mode === "gateway" && <em>当前</em>}
          <strong>网关模式</strong>
          <span>写入本地 API Key，并在缺少 provider 时补充 Codex Gateway 配置。</span>
        </button>
        <button type="button" className={`mode-card${mode === "account" ? " active" : ""}${settings.codex_auth_mode === "account" ? " current" : ""}`} onClick={() => setMode("account")}>
          {settings.codex_auth_mode === "account" && <em>当前</em>}
          <strong>账号模式</strong>
          <span>把选中的 ChatGPT 账号 token 写入 Codex 认证文件。</span>
        </button>
      </div>
      {!mode && <div className="empty">当前 Codex 认证状态未知，请选择一种模式后应用。</div>}
      {mode === "gateway" && (
        <div className="auth-preview-grid">
          <CodePreview title="auth.json" value={JSON.stringify({ OPENAI_API_KEY: maskSecret(settings.gateway_api_key) }, null, 2)} />
          <CodePreview title="config.toml" value={providerToml(settings)} />
        </div>
      )}
      {mode === "account" && (
        <div className="account-picker">
          {accounts.map((account) => {
            const usable = isUsableAccount(account, settings);
            return (
              <button
                type="button"
                key={account.id}
                className={`${accountId === account.id ? "picker-option active" : "picker-option"}${settings.codex_auth_mode === "account" && settings.codex_selected_account_id === account.id ? " current" : ""}${usable ? "" : " unavailable"}`}
                onClick={() => setAccountId(account.id)}
                disabled={!usable}
              >
                {settings.codex_auth_mode === "account" && settings.codex_selected_account_id === account.id && <small>当前</small>}
                <strong>{account.name || "未命名账号"}</strong>
                <span className="account-option-meta">
                  <em className="account-state">{usable ? "可用" : "不可用"}</em>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {mode === "account" && accounts.length === 0 && <div className="empty">还没有账号，请先到账号管理完成浏览器登录。</div>}
      {!alreadyApplied && (
        <div className="actions-inline">
          <button className="primary" type="button" onClick={apply} disabled={busy || !mode || (mode === "account" && (!accountId || !isUsableAccount(selectedAccount, settings)))}>
            {busy ? "写入中..." : "应用到 Codex"}
          </button>
        </div>
      )}
    </section>
  );
}

function GatewayPage({ gateway, mcpGateway, gatewayBase, mcpGatewayUrl, settings, onToggle, onToggleMcp, onMessage }) {
  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value || "");
      onMessage("复制成功");
    } catch (error) {
      onMessage(`复制失败：${error.message}`);
    }
  }

  return (
    <section className="panel form-panel">
      <h2>网关服务</h2>
      <div className="gateway-service-grid">
        <section className="gateway-box">
          <div className="gateway-service-head">
            <div>
              <h3>Codex 网关</h3>
            </div>
            <div className="gateway-head-actions">
              <div className="gateway-status">
                <span className={gateway.running ? "status-dot on" : "status-dot"} />
                <strong>{gateway.running ? "运行中" : "已停止"}</strong>
              </div>
              <button className={gateway.running ? "danger compact" : "primary compact"} onClick={onToggle}>{gateway.running ? "停止" : "启动"}</button>
            </div>
          </div>
          <div className="info-box">
            <InfoRow label="Base URL" value={gatewayBase} />
            <InfoRow label="API Key" value={maskSecret(settings.gateway_api_key)} />
            <InfoRow label="上游地址" value={settings.upstream_base_url} />
          </div>
        </section>
        <section className="gateway-box">
          <div className="gateway-service-head">
            <div>
              <h3>MCP 网关</h3>
            </div>
            <div className="gateway-head-actions">
              <div className="gateway-status">
                <span className={mcpGateway.running ? "status-dot on" : "status-dot"} />
                <strong>{mcpGateway.running ? "运行中" : "已停止"}</strong>
              </div>
              <button className={mcpGateway.running ? "danger compact" : "primary compact"} onClick={onToggleMcp}>{mcpGateway.running ? "停止" : "启动"}</button>
            </div>
          </div>
          <div className="info-box">
            <InfoRow label="地址" value={mcpGatewayUrl || "-"} />
            <InfoRow label="命令" value={mcpGateway.command || mcpGatewayCommand(settings)} />
          </div>
        </section>
      </div>
    </section>
  );
}

function SettingsPage({ settings, paths, onSave, onMessage, onClearTokenLogs, onClearAppLogs }) {
  const [draft, setDraft] = useState(settings);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  function setField(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    await onSave(draft);
  }

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(draft.gateway_api_key || "");
      onMessage("复制成功");
    } catch (error) {
      onMessage(`复制失败：${error.message}`);
    }
  }

  return (
    <form className="panel form-panel" onSubmit={submit}>
      <h2>应用配置</h2>
      <div className="split">
        <ControlledField name="gateway_host" label="监听地址" value={draft.gateway_host} onChange={setField} />
        <ControlledField name="gateway_port" label="端口" value={draft.gateway_port} type="number" onChange={setField} />
      </div>
      {!isLoopbackHost(draft.gateway_host) && (
        <div className="muted">当前监听地址会向本机外部开放账号代理能力。请使用随机 API Key，并确认防火墙访问范围。</div>
      )}
      <label className="field">
        <span>本地 API Key</span>
        <div className="input-actions">
          <input
            name="gateway_api_key"
            value={draft.gateway_api_key || ""}
            type={showKey ? "text" : "password"}
            onChange={(event) => setField("gateway_api_key", event.target.value)}
          />
          <button type="button" onClick={() => setField("gateway_api_key", generateApiKey())}>重新生成</button>
          <button type="button" onClick={() => setShowKey((value) => !value)}>{showKey ? "隐藏" : "查看"}</button>
          <button type="button" onClick={copyKey}>复制</button>
        </div>
      </label>
      <ControlledField name="upstream_base_url" label="上游地址" value={draft.upstream_base_url} onChange={setField} />
      <div className="split split-three">
        <ControlledField name="gateway_connect_timeout_ms" label="上游连接超时 ms" value={draft.gateway_connect_timeout_ms} type="number" onChange={setField} />
        <ControlledField name="gateway_stream_idle_timeout_ms" label="流式空闲超时 ms" value={draft.gateway_stream_idle_timeout_ms} type="number" onChange={setField} />
        <ControlledField name="gateway_unary_timeout_ms" label="普通请求总超时 ms" value={draft.gateway_unary_timeout_ms} type="number" onChange={setField} />
      </div>
      <div className="split split-three">
        <ControlledField name="gateway_request_body_limit_bytes" label="请求体上限 bytes" value={draft.gateway_request_body_limit_bytes} type="number" onChange={setField} />
        <ControlledField name="gateway_error_body_limit_bytes" label="错误响应上限 bytes" value={draft.gateway_error_body_limit_bytes} type="number" onChange={setField} />
        <ControlledField name="gateway_max_concurrent_requests" label="HTTP 最大并发请求数" value={draft.gateway_max_concurrent_requests} type="number" onChange={setField} />
      </div>
      <div className="split split-three">
        <ControlledField name="gateway_websocket_max_connections" label="WS 最大连接数" value={draft.gateway_websocket_max_connections} type="number" onChange={setField} />
        <ControlledField name="gateway_websocket_max_payload_bytes" label="WS 单消息上限 bytes" value={draft.gateway_websocket_max_payload_bytes} type="number" onChange={setField} />
        <ControlledField name="gateway_websocket_buffer_high_water_bytes" label="WS 转发缓冲高水位 bytes" value={draft.gateway_websocket_buffer_high_water_bytes} type="number" onChange={setField} />
      </div>
      <div className="split split-three">
        <ControlledField name="gateway_websocket_idle_timeout_ms" label="WS 响应空闲超时 ms" value={draft.gateway_websocket_idle_timeout_ms} type="number" onChange={setField} />
        <ControlledField name="gateway_quota_cooldown_ms" label="未知额度冷却 ms" value={draft.gateway_quota_cooldown_ms} type="number" onChange={setField} />
        <ControlledField name="gateway_shutdown_grace_ms" label="网关停机宽限 ms" value={draft.gateway_shutdown_grace_ms} type="number" onChange={setField} />
      </div>
      <ControlledField name="usage_refresh_interval_secs" label="账号额度定时刷新间隔（秒，0 为关闭）" value={draft.usage_refresh_interval_secs} type="number" onChange={setField} />
      <ControlledField name="usage_refresh_timeout_ms" label="单次额度请求超时 ms" value={draft.usage_refresh_timeout_ms} type="number" onChange={setField} />
      <div className="split">
        <ControlledField name="request_log_retention_days" label="调用记录保留天数" value={draft.request_log_retention_days} type="number" onChange={setField} />
        <ControlledField name="app_log_retention_days" label="运行日志保留天数" value={draft.app_log_retention_days} type="number" onChange={setField} />
      </div>
      <div className="split split-three">
        <ControlledField name="billing_uncached_input_factor" label="输入(未命中)计费系数" value={draft.billing_uncached_input_factor} type="number" step="any" onChange={setField} />
        <ControlledField name="billing_cached_input_factor" label="输入(缓存)计费系数" value={draft.billing_cached_input_factor} type="number" step="any" onChange={setField} />
        <ControlledField name="billing_output_factor" label="输出计费系数" value={draft.billing_output_factor} type="number" step="any" onChange={setField} />
      </div>
      <div className="field">
        <span>额度响应头</span>
        <div className="segmented">
          <button type="button" className={(draft.codex_quota_headers_mode || "block") === "block" ? "active" : ""} onClick={() => setField("codex_quota_headers_mode", "block")}>屏蔽</button>
          <button type="button" className={draft.codex_quota_headers_mode === "rewrite" ? "active" : ""} onClick={() => setField("codex_quota_headers_mode", "rewrite")}>重写</button>
        </div>
      </div>
      <div className="field">
        <span>忽略 5 小时限制</span>
        <small className="subtle">启用后账号管理页面和仪表盘不显示 5 小时额度，网关服务仅依据 7 天额度选择账号和返回额度信息。</small>
        <div className="segmented">
          <button type="button" className={draft.ignore_five_hour_limit !== "true" ? "active" : ""} onClick={() => setField("ignore_five_hour_limit", "false")}>关闭</button>
          <button type="button" className={draft.ignore_five_hour_limit === "true" ? "active" : ""} onClick={() => setField("ignore_five_hour_limit", "true")}>启用</button>
        </div>
      </div>
      <div className="field">
        <span>开机自启</span>
        <div className="segmented segmented-three">
          <button type="button" className={(draft.startup_launch || "disabled") === "disabled" ? "active" : ""} onClick={() => setField("startup_launch", "disabled")}>关闭</button>
          <button type="button" className={draft.startup_launch === "auto" ? "active" : ""} onClick={() => setField("startup_launch", "auto")}>自动</button>
          <button type="button" className={draft.startup_launch === "delayed" ? "active" : ""} onClick={() => setField("startup_launch", "delayed")}>自动(延迟)</button>
        </div>
      </div>
      <div className="field">
        <span>自动启动网关</span>
        <div className="segmented">
          <button type="button" className={draft.auto_start_gateway === "true" ? "active" : ""} onClick={() => setField("auto_start_gateway", "true")}>开启</button>
          <button type="button" className={draft.auto_start_gateway !== "true" ? "active" : ""} onClick={() => setField("auto_start_gateway", "false")}>关闭</button>
        </div>
      </div>
      <div className="divider-title">MCP 网关</div>
      <div className="field">
        <span>自动启动</span>
        <div className="segmented">
          <button type="button" className={draft.auto_start_mcp_gateway === "true" ? "active" : ""} onClick={() => setField("auto_start_mcp_gateway", "true")}>开启</button>
          <button type="button" className={draft.auto_start_mcp_gateway !== "true" ? "active" : ""} onClick={() => setField("auto_start_mcp_gateway", "false")}>关闭</button>
        </div>
      </div>
      <ControlledField name="mcp_gateway_config_path" label="配置路径" value={draft.mcp_gateway_config_path} onChange={setField} />
      <div className="split split-three">
        <ControlledField name="mcp_gateway_host" label="主机" value={draft.mcp_gateway_host} onChange={setField} />
        <ControlledField name="mcp_gateway_port" label="端口" value={draft.mcp_gateway_port} type="number" onChange={setField} />
        <ControlledField name="mcp_gateway_path" label="路径" value={draft.mcp_gateway_path} onChange={setField} />
      </div>
      <div className="field">
        <span>JSON Response</span>
        <div className="segmented">
          <button type="button" className={draft.mcp_gateway_json_response === "true" ? "active" : ""} onClick={() => setField("mcp_gateway_json_response", "true")}>启用</button>
          <button type="button" className={draft.mcp_gateway_json_response !== "true" ? "active" : ""} onClick={() => setField("mcp_gateway_json_response", "")}>禁用</button>
        </div>
      </div>
      <div className="field">
        <span>关闭窗口时</span>
        <div className="segmented">
          <button type="button" className={(draft.close_behavior || "exit") === "exit" ? "active" : ""} onClick={() => setField("close_behavior", "exit")}>退出应用</button>
          <button type="button" className={draft.close_behavior === "tray" ? "active" : ""} onClick={() => setField("close_behavior", "tray")}>最小化到托盘</button>
        </div>
      </div>
      <div>
        <button className="primary" type="submit">保存配置</button>
      </div>
      <div className="info-box">
        <InfoRow label="数据目录" value={paths.dataDir} />
        <InfoRow label="SQLite" value={paths.dbPath} />
      </div>
      <div className="danger-zone">
        <div>
          <strong>数据清理</strong>
          <span>清空本地记录数据，不会删除账号或应用配置。</span>
        </div>
        <div className="actions-inline">
          <button type="button" className="danger ghost" onClick={onClearTokenLogs}>清空调用记录</button>
          <button type="button" className="danger ghost" onClick={onClearAppLogs}>清空运行日志</button>
        </div>
      </div>
    </form>
  );
}

function InfoRow({ label, value, onCopy, onToggleVisibility, visible }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <code>{value || "-"}</code>
      {onToggleVisibility && <button type="button" onClick={onToggleVisibility}>{visible ? "隐藏" : "查看"}</button>}
      {onCopy && <button type="button" onClick={onCopy}>复制</button>}
    </div>
  );
}

const maskSecret = (value) => {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "••••••••";
  return `${text.slice(0, 4)}${"•".repeat(Math.min(16, text.length - 8))}${text.slice(-4)}`;
};

function CodePreview({ title, value }) {
  return (
    <div className="code-preview">
      <div>{title}</div>
      <pre>{value}</pre>
    </div>
  );
}

function SessionsPage({ sessions, query, onQuery, onSave, onDelete, onMessage }) {
  const [editing, setEditing] = useState(null);
  const [nameDraft, setNameDraft] = useState(query.name || "");
  const [pageSizeDraft, setPageSizeDraft] = useState(sessions.pageSize || query.pageSize || 10);
  const items = sessions.items || [];
  const draft = editing || { session_id: "", name: "", note: "" };
  useEffect(() => {
    setNameDraft(query.name || "");
  }, [query.name]);
  useEffect(() => {
    setPageSizeDraft(sessions.pageSize || query.pageSize || 10);
  }, [sessions.pageSize, query.pageSize]);
  async function copyResumeCommand(sessionId) {
    const command = `codex resume ${sessionId}`;
    try {
      await navigator.clipboard.writeText(command);
      onMessage(`已复制：${command}`);
    } catch (error) {
      onMessage(`复制失败：${error.message}`);
    }
  }
  async function submit(event) {
    event.preventDefault();
    try {
      await onSave(draft);
      setEditing(null);
    } catch (error) {
      onMessage(`保存会话失败：${error.message}`);
    }
  }
  async function search(event) {
    event.preventDefault();
    await onQuery({ name: nameDraft, page: 1, pageSize: Number(pageSizeDraft || 10) });
  }
  async function nextPage() {
    await onQuery({
      name: query.name || "",
      page: (sessions.page || 1) + 1,
      pageSize: sessions.pageSize || Number(pageSizeDraft || 10)
    });
  }
  async function prevPage() {
    await onQuery({
      name: query.name || "",
      page: Math.max(1, (sessions.page || 1) - 1),
      pageSize: sessions.pageSize || Number(pageSizeDraft || 10)
    });
  }
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>会话管理</h2>
          <p className="subtle">维护 Codex 会话 ID 和名称，恢复时复制 resume 命令。</p>
        </div>
        <button type="button" className="primary" onClick={() => setEditing({ session_id: "", name: "", note: "" })}>新建</button>
      </div>
      <form className="filter-row session-filter-row" onSubmit={search}>
        <label className="field">
          <span>会话名称</span>
          <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} />
        </label>
        <div className="filter-action">
          <span>操作</span>
          <button type="submit" className="primary">查询</button>
        </div>
      </form>
      <div className="table-wrap">
        <table className="sessions-table">
          <thead><tr><th className="session-name-col">会话名称</th><th className="session-id-col">会话 ID</th><th>备注</th><th className="time-col">创建时间</th><th className="time-col">更新时间</th><th className="session-actions-col">操作</th></tr></thead>
          <tbody>
            {items.map((session) => (
              <tr key={session.session_id}>
                <td className="name-cell">{session.name}</td>
                <td className="session-id-cell" title={session.session_id}>{session.session_id}</td>
                <td className="note-cell" title={session.note || ""}>{session.note || "-"}</td>
                <td className="time-col">{formatTime(session.created_at)}</td>
                <td className="time-col">{formatTime(session.updated_at)}</td>
                <td className="session-actions-col">
                  <div className="session-action-buttons">
                    <button type="button" className="compact" onClick={() => copyResumeCommand(session.session_id)}>恢复</button>
                    <button type="button" className="compact" onClick={() => setEditing(session)}>编辑</button>
                    <button type="button" className="compact danger ghost" onClick={() => onDelete(session)}>删除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <div className="empty">还没有保存的会话。</div>}
      </div>
      <Pager pageData={sessions} pageSize={pageSizeDraft} onPageSize={setPageSizeDraft} onPrev={prevPage} onNext={nextPage} />
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <form className="modal session-modal" role="dialog" aria-modal="true" aria-labelledby="session-modal-title" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3 id="session-modal-title">{draft.session_id ? "编辑会话" : "新建会话"}</h3>
              <button className="modal-close" type="button" aria-label="关闭" onClick={() => setEditing(null)}>×</button>
            </div>
            <label className="field">
              <span>会话 ID</span>
              <input
                value={draft.session_id}
                onChange={(event) => setEditing((prev) => ({ ...prev, session_id: event.target.value }))}
                disabled={Boolean(draft.created_at)}
                required
              />
            </label>
            <label className="field">
              <span>会话名称</span>
              <input
                value={draft.name}
                onChange={(event) => setEditing((prev) => ({ ...prev, name: event.target.value }))}
                required
              />
            </label>
            <label className="field">
              <span>备注</span>
              <textarea
                rows="4"
                value={draft.note || ""}
                onChange={(event) => setEditing((prev) => ({ ...prev, note: event.target.value }))}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setEditing(null)}>取消</button>
              <button type="submit" className="primary">保存</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

function CallRecordsPage({ pageData, summary, accounts, settings, onSaveSession, onMessage, onQuery }) {
  const { query, pageSizeDraft, setField, search, runWithPatch, setPageSizeDraft, nextPage, prevPage } = usePagedQuery(onQuery, pageData);
  const pageTotals = sumCallRecords(pageData.items);
  const billingFactors = billingFactorsFromSettings(settings);
  const [rowMenu, setRowMenu] = useState(null);
  const [sessionDraft, setSessionDraft] = useState(null);
  useEffect(() => {
    if (!rowMenu) return undefined;
    const close = () => setRowMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [rowMenu]);
  async function copyValue(value) {
    const text = String(value || "").trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onMessage("复制成功");
    } catch (error) {
      onMessage(`复制失败：${error.message}`);
    }
  }
  async function toggleAccountFilter(accountId) {
    if (!accountId) return;
    await runWithPatch({ accountId: query.accountId === accountId ? "" : accountId }, 1);
  }
  async function saveSessionFromLog(log) {
    const sessionId = String(log.session_id || "").trim();
    if (!sessionId) {
      onMessage("这条调用记录没有会话 ID");
      return;
    }
    setSessionDraft({ session_id: sessionId, name: "", note: "" });
  }
  async function submitSessionDraft(event) {
    event.preventDefault();
    try {
      await onSaveSession(sessionDraft);
      setSessionDraft(null);
    } catch (error) {
      onMessage(`保存会话失败：${error.message}`);
    }
  }
  function openRowMenu(event, log) {
    event.preventDefault();
    event.stopPropagation();
    setRowMenu({
      log,
      x: event.clientX,
      y: event.clientY
    });
  }
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>调用记录</h2>
          <p className="subtle">只记录网关调用产生的 token 使用情况，默认查询今天。</p>
        </div>
      </div>
      <LogFilters query={query} setField={setField} onSearch={search} showTokenFilters />
      {summary?.byAccount?.length > 0 && (
        <div className="summary-list">
          {summary.byAccount.map((item) => (
            <button
              type="button"
              className={`summary-row summary-button${query.accountId === item.account_id ? " active" : ""}`}
              key={item.account_id || "none"}
              onClick={() => toggleAccountFilter(item.account_id)}
              disabled={!item.account_id}
            >
              <div className="summary-main">
                <strong>{item.account_name}</strong>
                <b title={`总计：${formatTokenNumber(item.total_tokens)}`}>总计: {formatCompactNumber(item.total_tokens)}</b>
              </div>
              <small title={cachedInputTitle(item.input_tokens, item.cached_input_tokens)}>
                输入<span title={`输入：${formatTokenNumber(item.input_tokens)}`}>{formatCompactNumber(item.input_tokens)}</span>
                (未命中<span title={`未命中：${formatUncachedInput(item.input_tokens, item.cached_input_tokens)}`}>{formatCompactUncachedInput(item.input_tokens, item.cached_input_tokens)}</span>)
                /输出<span title={`输出：${formatTokenNumber(item.output_tokens)}`}>{formatCompactNumber(item.output_tokens)}</span>
                /计费系数<span title={billingCoefficientTitle(item, billingFactors)}>{formatBillingCoefficient(item, billingFactors)}</span>
              </small>
            </button>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th className="time-col">时间</th><th className="account-col">账号</th><th>会话 ID</th><th>客户端路径</th><th className="call-status-col">状态</th><th>耗时</th><th>输入(未命中)</th><th className="output-col">输出</th><th>总计</th><th>计费系数</th></tr></thead>
          <tbody>
            {pageData.items.map((log) => (
              <tr
                key={log.id}
                onContextMenu={(event) => openRowMenu(event, log)}
                title={log.session_id ? "右键保存会话" : ""}
              >
                <td className="time-col">{formatTime(log.created_at)}</td>
                <td className="account-col">
                  <button
                    type="button"
                    className="text-copy"
                    title={log.account_name || log.account_id || ""}
                    onClick={(event) => {
                      event.stopPropagation();
                      copyValue(log.account_name || log.account_id);
                    }}
                    disabled={!log.account_name && !log.account_id}
                  >
                    {log.account_name || log.account_id || "-"}
                  </button>
                </td>
                <td className="session-cell" title={log.session_id || ""}>
                  <button
                    type="button"
                    className="text-copy"
                    onClick={(event) => {
                      event.stopPropagation();
                      copyValue(log.session_id);
                    }}
                    disabled={!log.session_id}
                  >
                    {log.session_id || "-"}
                  </button>
                </td>
                <td className="url-cell" title={log.request_path || ""}>{log.request_path || "-"}</td>
                <td className="call-status-col">{log.status || "-"}</td>
                <td>{log.duration_ms ? `${log.duration_ms} ms` : "-"}</td>
                <td title={cachedInputTitle(log.input_tokens, log.cached_input_tokens)}>{formatUncachedPair(log.input_tokens, log.cached_input_tokens)}</td>
                <td className="output-col">{formatTokenNumber(log.output_tokens)}</td>
                <td>{formatTokenNumber(log.total_tokens)}</td>
                <td>{formatBillingCoefficient(log, billingFactors)}</td>
              </tr>
            ))}
          </tbody>
          {pageData.items.length > 0 && (
            <tfoot>
              <tr className="total-row">
                <td>合计</td>
                <td colSpan={4}></td>
                <td>{formatDurationTotal(pageTotals.duration_ms)}</td>
                <td title={cachedInputTitle(pageTotals.input_tokens, pageTotals.cached_input_tokens)}>{formatUncachedPair(pageTotals.input_tokens, pageTotals.cached_input_tokens)}</td>
                <td className="output-col">{formatTokenNumber(pageTotals.output_tokens)}</td>
                <td>{formatTokenNumber(pageTotals.total_tokens)}</td>
                <td>{formatBillingCoefficient(pageTotals, billingFactors)}</td>
              </tr>
            </tfoot>
          )}
        </table>
        {rowMenu && (
          <div
            className="context-menu"
            style={{ left: rowMenu.x, top: rowMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                const log = rowMenu.log;
                setRowMenu(null);
                saveSessionFromLog(log);
              }}
            >
              保存会话
            </button>
          </div>
        )}
      </div>
      {sessionDraft && (
        <div className="modal-backdrop" onClick={() => setSessionDraft(null)}>
          <form className="modal session-modal" role="dialog" aria-modal="true" aria-labelledby="call-session-modal-title" onSubmit={submitSessionDraft} onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3 id="call-session-modal-title">保存会话</h3>
              <button className="modal-close" type="button" aria-label="关闭" onClick={() => setSessionDraft(null)}>×</button>
            </div>
            <label className="field">
              <span>会话 ID</span>
              <input value={sessionDraft.session_id} disabled />
            </label>
            <label className="field">
              <span>会话名称</span>
              <input
                value={sessionDraft.name}
                onChange={(event) => setSessionDraft((prev) => ({ ...prev, name: event.target.value }))}
                required
              />
            </label>
            <label className="field">
              <span>备注</span>
              <textarea
                rows="4"
                value={sessionDraft.note}
                onChange={(event) => setSessionDraft((prev) => ({ ...prev, note: event.target.value }))}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setSessionDraft(null)}>取消</button>
              <button type="submit" className="primary">保存</button>
            </div>
          </form>
        </div>
      )}
      <Pager pageData={pageData} pageSize={pageSizeDraft} onPageSize={setPageSizeDraft} onPrev={prevPage} onNext={nextPage} />
    </section>
  );
}

function AppLogsPage({ pageData, onMessage, onQuery }) {
  const { query, pageSizeDraft, setField, search, setPageSizeDraft, nextPage, prevPage } = usePagedQuery(onQuery, pageData);
  async function copyRowAsJson(log) {
    await copyJson(log, onMessage);
  }
  return (
    <section className="panel">
      <div className="section-title">
        <div>
          <h2>运行日志</h2>
          <p className="subtle">记录应用运行情况，例如刷新账号、启停网关、认证写入和异常。</p>
        </div>
      </div>
      <LogFilters query={query} setField={setField} onSearch={search} />
      <div className="table-wrap">
        <table className="app-log-table">
          <thead><tr><th className="time-col">时间</th><th className="level-col">级别</th><th className="scope-col">模块</th><th>动作</th><th className="status-col">状态</th><th>消息</th></tr></thead>
          <tbody>
            {pageData.items.map((log) => (
              <tr key={log.id} className="copy-row" title="点击复制 JSON" onClick={() => copyRowAsJson(log)}>
                <td className="time-col">{formatTime(log.created_at)}</td>
                <td className="level-col">{log.level}</td>
                <td className="scope-col">{log.scope || "-"}</td>
                <td>{log.action || "-"}</td>
                <td className="status-col">{log.status || "-"}</td>
                <td className="message-cell" title={log.message || ""}>{log.message || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager pageData={pageData} pageSize={pageSizeDraft} onPageSize={setPageSizeDraft} onPrev={prevPage} onNext={nextPage} />
    </section>
  );
}

async function copyJson(value, onMessage) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
    onMessage("复制成功");
  } catch (error) {
    onMessage(`复制失败：${error.message}`);
  }
}

function sumCallRecords(items = []) {
  return items.reduce((total, item) => ({
    duration_ms: total.duration_ms + Number(item.duration_ms || 0),
    input_tokens: total.input_tokens + Number(item.input_tokens || 0),
    cached_input_tokens: total.cached_input_tokens + Number(item.cached_input_tokens || 0),
    output_tokens: total.output_tokens + Number(item.output_tokens || 0),
    total_tokens: total.total_tokens + Number(item.total_tokens || 0)
  }), {
    duration_ms: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0
  });
}

function formatDurationTotal(value) {
  return value ? `${formatTokenNumber(value)} ms` : "-";
}

function LogFilters({ query, setField, onSearch, showTokenFilters = false }) {
  return (
    <div className={showTokenFilters ? "filter-row token-filter-row" : "filter-row"}>
      <label className="field">
        <span>开始日期</span>
        <input type="date" value={query.startDate} onChange={(event) => setField("startDate", event.target.value)} />
      </label>
      <label className="field">
        <span>结束日期</span>
        <input type="date" value={query.endDate} onChange={(event) => setField("endDate", event.target.value)} />
      </label>
      {showTokenFilters && (
        <label className="field">
          <span>会话 ID</span>
          <input value={query.sessionId || ""} onChange={(event) => setField("sessionId", event.target.value)} />
        </label>
      )}
      <div className="filter-action">
        <span>操作</span>
        <button type="button" className="primary" onClick={onSearch}>查询</button>
      </div>
    </div>
  );
}

function Pager({ pageData, pageSize, onPageSize, onPrev, onNext }) {
  const totalPages = Math.max(1, Math.ceil((pageData.total || 0) / (pageData.pageSize || 10)));
  return (
    <div className="pager">
      <span>共 {pageData.total || 0} 条，第 {pageData.page || 1}/{totalPages} 页</span>
      <div className="actions-inline">
        <label className="page-size">
          <span>每页</span>
          <input type="number" min="5" max="200" value={pageSize} onChange={(event) => onPageSize(event.target.value)} />
        </label>
        <button onClick={onPrev} disabled={(pageData.page || 1) <= 1}>上一页</button>
        <button onClick={onNext} disabled={(pageData.page || 1) >= totalPages}>下一页</button>
      </div>
    </div>
  );
}

function usePagedQuery(onQuery, pageData) {
  const [query, setQuery] = useState(() => todayQuery(pageData.pageSize || 10));
  const [pageSizeDraft, setPageSizeDraft] = useState(pageData.pageSize || 10);
  function setField(key, value) {
    setQuery((prev) => ({ ...prev, [key]: value }));
  }
  async function run(page = 1) {
    const next = { ...query, page };
    setQuery(next);
    await onQuery(toLogQuery(next));
  }
  async function search() {
    const next = { ...query, page: 1, pageSize: pageSizeDraft };
    setQuery(next);
    await onQuery(toLogQuery(next));
  }
  async function runWithPatch(patch, page = 1) {
    const next = { ...query, ...patch, page };
    setQuery(next);
    await onQuery(toLogQuery(next));
  }
  return {
    query,
    pageSizeDraft,
    setField,
    search,
    runWithPatch,
    setPageSizeDraft,
    nextPage: () => run((pageData.page || 1) + 1),
    prevPage: () => run(Math.max(1, (pageData.page || 1) - 1))
  };
}

function Metric({ title, value, hint, className = "" }) {
  const isPlainNumber = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value));
  const displayValue = isPlainNumber
    ? formatTokenNumber(value)
    : value;
  const titleText = hint || "";
  return <article className={`panel metric ${className}`.trim()} title={titleText}><span>{title}</span><strong>{displayValue}</strong></article>;
}

function QuotaMetric({ title, detail }) {
  const remaining = Math.max(0, Math.min(100, Number(detail?.remaining_percent || 0)));
  const resetAt = Number(detail?.reset_at || 0);
  return (
    <article className="panel metric quota-summary-metric">
      <span>{title}</span>
      <strong>{remaining.toFixed(1)}%</strong>
      <small>重置：{formatTime(resetAt)}</small>
    </article>
  );
}

function Field({ label, name, value, type = "text", secret }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} defaultValue={value ?? ""} type={secret ? "password" : type} />
    </label>
  );
}

function ControlledField({ label, name, value, type = "text", step, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} value={value ?? ""} type={type} step={step} onChange={(event) => onChange(name, event.target.value)} />
    </label>
  );
}

function Quota({ label, value, resetAt }) {
  const usedPercent = Math.max(0, Math.min(100, Number(value || 0)));
  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));
  return (
    <div className="quota">
      <div><span>{label}</span><b>剩余 {remainingPercent.toFixed(1)}%</b></div>
      <div className="bar"><span style={{ width: `${remainingPercent}%` }} /></div>
      <small>已用 {usedPercent.toFixed(1)}% · 重置：{formatTime(resetAt)}</small>
    </div>
  );
}

function parseResetCredits(account) {
  let parsed = {};
  try {
    parsed = account?.reset_credits_json ? JSON.parse(account.reset_credits_json) : {};
  } catch {
    parsed = {};
  }
  const credits = Array.isArray(parsed.credits) ? parsed.credits : [];
  const availableCount = Number(account?.reset_credits_available_count ?? parsed.available_count ?? 0);
  return {
    availableCount: Number.isFinite(availableCount) ? Math.max(0, Math.trunc(availableCount)) : 0,
    credits
  };
}

function formatResetCreditsSummary(account) {
  const count = Number(account?.reset_credits_available_count || 0);
  const expiresAt = Number(account?.reset_credits_next_expires_at || 0);
  return `${Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0} 次，${expiresAt ? formatTime(expiresAt) : "暂无到期时间"}`;
}

function resetCreditStatusLabel(status) {
  const value = String(status || "").toLowerCase();
  if (value === "available") return "可用";
  if (value === "used") return "已使用";
  if (value === "expired") return "已过期";
  return status || "-";
}

function formatTime(value) {
  if (!value) return "未填写";
  if (typeof value === "string" && Number.isNaN(Number(value))) return value;
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return "未填写";
  return date.toLocaleString();
}

function formatUncachedPair(input, cached) {
  return `${formatTokenNumber(input)}(${formatUncachedInput(input, cached)})`;
}

function formatUncachedInput(input, cached) {
  return formatTokenNumber(Math.max(0, Number(input || 0) - Number(cached || 0)));
}

function formatCompactUncachedInput(input, cached) {
  return formatCompactNumber(Math.max(0, Number(input || 0) - Number(cached || 0)));
}

function cachedInputTitle(input, cached) {
  return `缓存：${formatTokenNumber(cached)}；命中率：${formatCacheHitRate(input, cached)}`;
}

function formatCacheHitRate(input, cached) {
  const inputTokens = Number(input || 0);
  if (inputTokens <= 0) return "0.00%";
  return `${((Number(cached || 0) / inputTokens) * 100).toFixed(2)}%`;
}

function billingFactorsFromSettings(settings = {}) {
  return {
    uncachedInput: numberOrDefault(settings.billing_uncached_input_factor, 125),
    cachedInput: numberOrDefault(settings.billing_cached_input_factor, 12.5),
    output: numberOrDefault(settings.billing_output_factor, 750)
  };
}

function formatBillingCoefficient(item, factors) {
  return billingCoefficient(item, factors).toFixed(2);
}

function billingCoefficientTitle(item, factors) {
  const input = Number(item?.input_tokens || 0);
  const cached = Number(item?.cached_input_tokens || 0);
  const uncached = Math.max(0, input - cached);
  const output = Number(item?.output_tokens || 0);
  return [
    `输入(未命中)：${formatTokenNumber(uncached)} × ${factors.uncachedInput}`,
    `输入(缓存)：${formatTokenNumber(cached)} × ${factors.cachedInput}`,
    `输出：${formatTokenNumber(output)} × ${factors.output}`
  ].join("；");
}

function billingCoefficient(item, factors) {
  const input = Number(item?.input_tokens || 0);
  const cached = Number(item?.cached_input_tokens || 0);
  const uncached = Math.max(0, input - cached);
  const output = Number(item?.output_tokens || 0);
  return ((factors.uncachedInput * uncached) + (factors.cachedInput * cached) + (factors.output * output)) / 1_000_000;
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatTokenNumber(value) {
  return String(Number(value || 0)).replace(/\B(?=(\d{4})+(?!\d))/g, ",");
}

function formatCompactNumber(value) {
  const number = Number(value || 0);
  const abs = Math.abs(number);
  if (abs >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}G`;
  if (abs >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(number / 1_000).toFixed(2)}K`;
  return formatTokenNumber(number);
}

function generateApiKey() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return `sk-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

function normalizeAuthMode(value) {
  return value === "gateway" || value === "account" ? value : "";
}

function providerToml(settings) {
  const host = gatewayProviderBaseHost(settings.gateway_host);
  const port = settings.gateway_port || "8436";
  return [
    'model_provider = "codex_gateway"',
    "",
    "[model_providers.codex_gateway]",
    'name = "OpenAI"',
    `base_url = "http://${host}:${port}/v1"`,
    'wire_api = "responses"',
    "supports_websockets = true"
  ].join("\n");
}

function gatewayProviderBaseHost(host) {
  const value = String(host || "").trim();
  if (!value || value === "0.0.0.0") return "localhost";
  return value;
}

function isLoopbackHost(host) {
  const value = String(host || "").trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

function mcpGatewayBaseUrl(settings = {}) {
  const host = cleanMcpGatewayText(settings.mcp_gateway_host);
  const port = cleanMcpGatewayPort(settings.mcp_gateway_port);
  if (!host || !port) return "";
  return `http://${host}:${port}${cleanMcpGatewayPath(settings.mcp_gateway_path)}`;
}

function mcpGatewayCommand(settings = {}) {
  const args = ["mcp-gateway-service", "--http"];
  appendOptionalMcpArg(args, "--config", settings.mcp_gateway_config_path);
  appendOptionalMcpArg(args, "--host", settings.mcp_gateway_host);
  appendOptionalMcpArg(args, "--port", cleanMcpGatewayPort(settings.mcp_gateway_port));
  appendOptionalMcpArg(args, "--path", cleanMcpGatewayPath(settings.mcp_gateway_path));
  if (settings.mcp_gateway_json_response === "true") args.push("--json-response");
  return args.map(quoteCommandArg).join(" ");
}

function appendOptionalMcpArg(args, name, value) {
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

function quoteCommandArg(value) {
  const text = String(value);
  return /[\s"]/g.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function todayQuery(pageSize = 10) {
  const today = new Date();
  const value = toDateInput(today);
  return { startDate: value, endDate: value, page: 1, pageSize };
}

function toLogQuery(query) {
  const start = new Date(`${query.startDate}T00:00:00`);
  const end = new Date(`${query.endDate || query.startDate}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return {
    page: Number(query.page || 1),
    pageSize: Number(query.pageSize || 10),
    startAt: Math.floor(start.getTime() / 1000),
    endAt: Math.floor(end.getTime() / 1000),
    accountId: String(query.accountId || "").trim(),
    sessionId: String(query.sessionId || "").trim()
  };
}

function toDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

createRoot(document.getElementById("root")).render(<App />);
