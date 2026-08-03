import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { CodexGatewayBridge } from "../preload";
import App from "./App";

afterEach(() => cleanup());

it("refreshes the quota summary after the five-hour limit setting changes", async () => {
  const user = userEvent.setup();
  const settings = { ignore_five_hour_limit: "true" };
  const quotaSummary = vi.fn().mockResolvedValue({
    capacity_percent: 200,
    primary: { remaining_percent: 170 },
    secondary: { remaining_percent: 150 }
  });
  window.codexGateway = {
    bootstrap: vi.fn().mockResolvedValue({
      app: { version: "1.0.0" },
      settings,
      accounts: [],
      tokenLogs: { items: [], total: 0, page: 1, pageSize: 10 },
      tokenSummary: { total: {}, byAccount: [] },
      quotaSummary: {
        capacity_percent: 200,
        primary: { remaining_percent: 150 },
        secondary: { remaining_percent: 150 }
      },
      appLogs: { items: [], total: 0, page: 1, pageSize: 10 },
      gateway: { running: false },
      mcpGateway: { running: false },
      paths: { dataDir: "", dbPath: "" }
    }),
    saveSettings: vi.fn().mockResolvedValue({ ignore_five_hour_limit: "false" }),
    quotaSummary,
    listUpstreams: vi.fn().mockResolvedValue([])
  } as unknown as CodexGatewayBridge;

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <QueryClientProvider client={queryClient}>
        <AntApp><App /></AntApp>
      </QueryClientProvider>
    </MemoryRouter>
  );

  await screen.findByText("忽略 5 小时限制");
  await user.click(screen.getByRole("switch"));
  await user.click(screen.getByRole("button", { name: /保存设置/ }));
  await waitFor(() => expect(quotaSummary).toHaveBeenCalledOnce());

  await user.click(screen.getByText("概览"));
  expect(await screen.findByText("170.0%")).toBeTruthy();
  expect(screen.getByText("150.0%")).toBeTruthy();
});
