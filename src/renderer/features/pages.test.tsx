import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexGatewayBridge } from "../../preload";
import type { UpstreamKind, UpstreamSummary } from "../../shared/contracts/upstreams";
import { AppShell } from "../app/layout/AppShell";
import { AccountsPage } from "./accounts/AccountsPage";
import { CodexIntegrationPage } from "./codex-integration/CodexIntegrationPage";
import { OverviewPage } from "./overview/OverviewPage";
import { RequestAnalyticsPage } from "./request-analytics/RequestAnalyticsPage";
import { RuntimeLogsPage } from "./runtime-logs/RuntimeLogsPage";
import { ServicesPage } from "./services/ServicesPage";
import { UpstreamsPage } from "./upstreams/UpstreamsPage";

const emptyRequestPage = { items: [], total: 0, page: 1, pageSize: 10 };
const emptyLogPage = { items: [], total: 0, page: 1, pageSize: 10 };
const emptySummary = { total: {}, byAccount: [] };

describe("Ant Design pages", () => {
  beforeEach(() => {
    window.codexGateway = createBridge();
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });
  afterEach(() => cleanup());

  it("uses the page definitions for navigation and the current page title", () => {
    render(
      <AppShell
        activePage="upstreams"
        gatewayRunning={false}
        mcpGatewayRunning={false}
        onNavigate={vi.fn()}
        pages={[
          { id: "upstreams", label: "模型渠道" },
          { id: "codexIntegration", label: "接入模式" }
        ]}
      >
        <div>页面内容</div>
      </AppShell>
    );
    expect(screen.getAllByText("模型渠道")).toHaveLength(2);
    expect(screen.getByText("接入模式")).toBeTruthy();
  });

  it("renders overview model channel metrics", async () => {
    renderWithQueries(<OverviewPage accounts={[]} gateway={{ running: false }} mcpGateway={{ running: false }} tokenSummary={emptySummary} quotaSummary={{ primary: {}, secondary: {} }} settings={{}} />);
    expect(screen.getByRole("heading", { name: "运行概览" })).toBeTruthy();
    await waitFor(() => expect(window.codexGateway.listUpstreams).toHaveBeenCalled());
    expect(await screen.findByText("可选模型")).toBeTruthy();
    expect(screen.getByText("缓存命中率")).toBeTruthy();
  });

  it("opens account browser login", async () => {
    const user = userEvent.setup();
    const onStartLogin = vi.fn().mockResolvedValue(undefined);
    render(<AccountsPage accounts={[]} loginId="" refreshingIds={new Set()} retryIds={new Set()} settings={{}}
      onStartLogin={onStartLogin} onImportLocal={vi.fn()} onCancelLogin={vi.fn()} onRefreshUsage={vi.fn()}
      onRefreshAll={vi.fn()} onSetEnabled={vi.fn()} onDelete={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /添加账号/ }));
    await user.click(screen.getByRole("button", { name: /浏览器认证/ }));
    expect(onStartLogin).toHaveBeenCalledOnce();
  });

  it("requires Codex model JSON when adding an API upstream", async () => {
    const user = userEvent.setup();
    renderWithQueries(<UpstreamsPage />);
    expect(screen.getByRole("heading", { name: "模型渠道" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /新增 API 上游/ }));
    expect(screen.getByText("Codex 模型 JSON")).toBeTruthy();
    expect(screen.getByText(/工具、推理程度、输入模态和 WS/)).toBeTruthy();
    expect((document.querySelector("textarea.v1-code-editor") as HTMLTextAreaElement | null)?.value).toBe("");
    expect(screen.queryByText("模型映射")).toBeNull();
  });

  it("hides the delete action for the built-in account channel", async () => {
    vi.mocked(window.codexGateway.listUpstreams).mockResolvedValue([
      createUpstream("builtin", "内置账号渠道", "chatgpt_subscription_pool"),
      createUpstream("api", "第三方渠道", "responses_api")
    ]);
    renderWithQueries(<UpstreamsPage />);
    expect(await screen.findByText("内置账号渠道")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
  });

  it("starts the gateway from service management", async () => {
    const user = userEvent.setup();
    const onToggleGateway = vi.fn().mockResolvedValue(undefined);
    render(<ServicesPage gateway={{ running: false }} mcpGateway={{ running: false }} gatewayBase="http://localhost:8436/v1"
      mcpGatewayUrl="http://127.0.0.1:3000/mcp" mcpGatewayCommand="mcp-gateway-service --http"
      onToggleGateway={onToggleGateway}
      onToggleMcpGateway={vi.fn()} onRestartGateway={vi.fn()} onRestartMcpGateway={vi.fn()} onMessage={vi.fn()} />);
    await user.click(screen.getAllByRole("button", { name: /启动/ })[0]!);
    expect(onToggleGateway).toHaveBeenCalledOnce();
  });

  it("queries request analytics", async () => {
    const user = userEvent.setup();
    const onQuery = vi.fn().mockResolvedValue(undefined);
    const pageData = {
      ...emptyRequestPage,
      total: 1,
      items: [{
        id: 1,
        created_at: 1,
        session_id: "session-only-in-detail",
        input_tokens: 1234,
        cached_input_tokens: 234,
        output_tokens: 56,
        estimated_cost: 0.1234
      }]
    };
    const summary = {
      total: { total_tokens: 1524, input_tokens: 1000, cached_input_tokens: 400, output_tokens: 524 },
      byAccount: [{ account_id: null, account_name: "未关联账号", total_tokens: 555, input_tokens: 400, cached_input_tokens: 100, output_tokens: 155 }]
    };
    renderWithQueries(<RequestAnalyticsPage pageData={pageData} summary={summary} accounts={[]} settings={{ billing_currency: "CNY" }} onMessage={vi.fn()} onQuery={onQuery} />);
    expect(screen.getAllByText("估算成本（CNY）").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Token（输入 / 缓存输入 / 输出）").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("1,234 / 234 / 56")).toBeTruthy();
    expect(screen.queryByText("session-only-in-detail")).toBeNull();
    expect(screen.getByText("非账号渠道")).toBeTruthy();
    await user.hover(screen.getByText("1,524"));
    expect(await screen.findByText("缓存命中率：40.0%")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /查询/ }));
    expect(onQuery).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: /重置/ }));
    expect(onQuery).toHaveBeenCalledTimes(2);
    expect(onQuery.mock.calls[1]?.[0]).not.toHaveProperty("accountId");
  });

  it("pauses runtime logs", async () => {
    const user = userEvent.setup();
    const onPausedChange = vi.fn();
    const onQuery = vi.fn().mockResolvedValue(undefined);
    render(<RuntimeLogsPage pageData={emptyLogPage} paused={false} newLogCount={0} onPausedChange={onPausedChange} onMessage={vi.fn()} onQuery={onQuery} />);
    await user.click(screen.getByRole("button", { name: /暂停自动刷新/ }));
    expect(onPausedChange).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("button", { name: /重置/ }));
    expect(onQuery).toHaveBeenCalledOnce();
    expect(onQuery.mock.calls[0]?.[0]).not.toHaveProperty("keyword");
  });

  it("applies Codex gateway mode", async () => {
    const user = userEvent.setup();
    const onApplyGateway = vi.fn().mockResolvedValue(undefined);
    render(<CodexIntegrationPage settings={{ codex_auth_mode: "" }} accounts={[]} gatewayBase="http://localhost:8436/v1" modelCatalogPath="D:/data/models.json"
      onMessage={vi.fn()} onApplyGateway={onApplyGateway} onApplyAccount={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "接入模式" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /网关模式/ }));
    expect(screen.getByText(/model_catalog_json = "D:\/data\/models\.json"/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /应用到 Codex/ }));
    expect(onApplyGateway).toHaveBeenCalledOnce();
  });
});

function renderWithQueries(element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><AntApp>{element}</AntApp></QueryClientProvider>);
}

function createBridge(): CodexGatewayBridge {
  return {
    listUpstreams: vi.fn().mockResolvedValue([]),
    listUpstreamModels: vi.fn().mockResolvedValue([]),
    bootstrap: vi.fn().mockResolvedValue({ settings: { billing_currency: "USD" } })
  } as unknown as CodexGatewayBridge;
}

const createUpstream = (id: string, name: string, kind: UpstreamKind): UpstreamSummary => ({
  id,
  name,
  kind,
  enabled: true,
  baseUrl: "http://localhost:8436/v1",
  hasApiKey: kind === "responses_api",
  apiKeyFingerprint: null,
  supportsWebSocket: true,
  publicHeaders: {},
  secretHeaders: [],
  balanceQueryType: "none",
  balance: {
    available: true,
    infos: [],
    summary: null,
    checkedAt: null,
    error: null,
    subscriptionPool: kind === "chatgpt_subscription_pool"
      ? {
        totalAccounts: 1,
        enabledAccounts: 1,
        availableAccounts: 1,
        quotaCapacityPercent: 100,
        fiveHourRemainingPercent: 100,
        sevenDayRemainingPercent: 100,
        resetCredits: 0
      }
      : null
  },
  healthStatus: "unknown",
  healthCheckedAt: null,
  healthLatencyMs: null,
  healthMessage: null,
  modelCount: 1,
  lastSyncedAt: null
});
