import { CopyOutlined, SearchOutlined, SettingOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Input,
  Pagination,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography
} from "antd";
import type { TableColumnsType } from "antd";
import type { ReactElement } from "react";
import { useState } from "react";
import type { PublicAccount } from "../../../shared/contracts/accounts";
import type { RequestLog, RequestLogPage, TokenSummary } from "../../../shared/contracts/logs";
import type { Settings } from "../../../shared/contracts/settings";
import {
  cacheHitRate,
  formatTime,
  formatTokenNumber
} from "../../lib/formatters";
import { todayLogFilters, toLogQuery, type LogFilterValues } from "../../lib/log-query";

interface RequestAnalyticsPageProps {
  pageData: RequestLogPage;
  summary: TokenSummary;
  accounts: PublicAccount[];
  settings: Settings;
  onMessage: (message: string) => void;
  onQuery: (query: ReturnType<typeof toLogQuery>) => Promise<void>;
}

const ANALYTICS_COLUMN_OPTIONS = [
  { label: "时间", value: "time" },
  { label: "目标", value: "target" },
  { label: "模型", value: "model" },
  { label: "路径", value: "path" },
  { label: "状态", value: "status" },
  { label: "耗时", value: "duration" },
  { label: "Token", value: "tokens" },
  { label: "估算", value: "cost" }
] as const;
const DEFAULT_ANALYTICS_COLUMN_KEYS = ANALYTICS_COLUMN_OPTIONS
  .filter((item) => item.value !== "path")
  .map((item) => item.value);

export const RequestAnalyticsPage = ({
  pageData,
  summary,
  accounts,
  settings,
  onMessage,
  onQuery
}: RequestAnalyticsPageProps) => {
  const [filters, setFilters] = useState<LogFilterValues>(todayLogFilters);
  const [selectedLog, setSelectedLog] = useState<RequestLog | null>(null);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<string[]>(() => [...DEFAULT_ANALYTICS_COLUMN_KEYS]);
  const upstreamQuery = useQuery({
    queryKey: ["upstreams", "analytics"],
    queryFn: () => window.codexGateway.listUpstreams()
  });

  const runQuery = async (page = 1, pageSize = pageData.pageSize, nextFilters = filters): Promise<void> => {
    setFilters(nextFilters);
    await onQuery(toLogQuery(nextFilters, page, pageSize));
  };

  const copyValue = async (value: unknown): Promise<void> => {
    const text = String(value || "").trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onMessage("复制成功");
    } catch (error) {
      onMessage(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const currency = settings.billing_currency || "USD";
  const allColumns: TableColumnsType<RequestLog> = [
    { key: "time", title: "时间", dataIndex: "created_at", width: 160, render: (value) => formatTime(value) },
    {
      title: "目标",
      key: "target",
      width: 200,
      render: (_, log) => (
        <Typography.Text strong ellipsis={{ tooltip: log.upstream_name || log.account_name || log.upstream_id || "订阅账号池" }}>
          {log.upstream_name || log.account_name || log.upstream_id || "订阅账号池"}
        </Typography.Text>
      )
    },
    {
      title: "模型",
      key: "model",
      width: 170,
      render: (_, log) => {
        const route = log.upstream_model && log.upstream_model !== log.client_model
          ? `${log.client_model || "-"} → ${log.upstream_model}`
          : log.client_model || log.upstream_model || "-";
        return <Typography.Text ellipsis={{ tooltip: route }} className="v1-mono v1-nowrap">{route}</Typography.Text>;
      }
    },
    { key: "path", title: "路径", dataIndex: "request_path", width: 140, ellipsis: true, render: (value) => value || "-" },
    {
      title: "状态",
      key: "status",
      dataIndex: "status",
      width: 76,
      render: (value) => <Tag color={Number(value) >= 200 && Number(value) < 300 ? "success" : "error"}>{value || "-"}</Tag>
    },
    { key: "duration", title: "耗时", dataIndex: "duration_ms", width: 110, render: (value) => value ? `${formatTokenNumber(value)} ms` : "-" },
    {
      title: "Token（输入 / 缓存输入 / 输出）",
      key: "tokens",
      width: 260,
      render: (_, log) => (
        <Typography.Text className="v1-nowrap" title={`缓存命中率 ${cacheHitRate(log.input_tokens, log.cached_input_tokens).toFixed(2)}%`}>
          {formatTokenNumber(log.input_tokens)} / {formatTokenNumber(log.cached_input_tokens)} / {formatTokenNumber(log.output_tokens)}
        </Typography.Text>
      )
    },
    {
      title: `估算成本（${currency}）`,
      key: "cost",
      width: 145,
      render: (_, log) => log.estimated_cost !== null && log.estimated_cost !== undefined
        ? Number(log.estimated_cost).toFixed(4)
        : "-"
    }
  ];
  const columns = allColumns.filter((column) => visibleColumnKeys.includes(String(column.key)));

  return (
    <section className="v1-page-card v1-page-fill v1-analytics-page">
        <Flex className="v1-page-heading" align="flex-start" justify="space-between" gap={16} wrap>
          <div>
            <Typography.Title level={4}>调用分析</Typography.Title>
            <Typography.Text type="secondary">展示实际模型渠道、Token、耗时和统一币种成本。</Typography.Text>
          </div>
          <Dropdown
            trigger={["click"]}
            popupRender={() => (
              <Card size="small" title="显示列" style={{ width: 220 }}>
                <Checkbox.Group
                  options={[...ANALYTICS_COLUMN_OPTIONS]}
                  value={visibleColumnKeys}
                  onChange={(values) => setVisibleColumnKeys(values.map(String))}
                />
              </Card>
            )}
          >
            <Button icon={<SettingOutlined />}>列设置</Button>
          </Dropdown>
        </Flex>

        <Flex className="v1-table-toolbar" gap={8} wrap align="flex-end">
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">日期范围</Typography.Text>
            <DatePicker.RangePicker
              allowClear={false}
              value={filters.range}
              onChange={(range) => range?.[0] && range[1] && setFilters((current) => ({ ...current, range: [range[0]!, range[1]!] }))}
            />
          </div>
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">账号</Typography.Text>
            <Select
              allowClear
              value={filters.accountId || undefined}
              placeholder="全部账号"
              style={{ width: 200 }}
              options={accounts.map((account) => ({ value: account.id, label: account.name || account.email || account.id }))}
              onChange={(value) => setFilters((current) => ({ ...current, accountId: value || "" }))}
            />
          </div>
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">上游</Typography.Text>
            <Select
              allowClear
              value={filters.upstreamId || undefined}
              placeholder="全部上游"
              style={{ width: 190 }}
              options={(upstreamQuery.data || []).map((upstream) => ({ value: upstream.id, label: upstream.name }))}
              onChange={(value) => setFilters((current) => ({ ...current, upstreamId: value || "" }))}
            />
          </div>
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">Codex 模型</Typography.Text>
            <Input value={filters.clientModel} placeholder="模糊匹配" style={{ width: 170 }} onChange={(event) => setFilters((current) => ({ ...current, clientModel: event.target.value }))} />
          </div>
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">上游模型</Typography.Text>
            <Input value={filters.upstreamModel} placeholder="模糊匹配" style={{ width: 170 }} onChange={(event) => setFilters((current) => ({ ...current, upstreamModel: event.target.value }))} />
          </div>
          <div>
            <Typography.Text type="secondary" className="v1-filter-label">状态</Typography.Text>
            <Select
              allowClear
              value={filters.status || undefined}
              placeholder="全部状态"
              style={{ width: 140 }}
              options={["200", "400", "401", "403", "422", "426", "429", "500", "502", "503"].map((value) => ({ value, label: value }))}
              onChange={(value) => setFilters((current) => ({ ...current, status: value || "" }))}
            />
          </div>
          <Button type="primary" icon={<SearchOutlined />} onClick={() => runQuery(1)}>查询</Button>
        </Flex>

        <div className="v1-metric-grid">
          <Card size="small"><Statistic title="调用" value={summary.total.calls || 0} /></Card>
          <TokenUsageTooltip usage={summary.total}>
            <Card size="small"><Statistic title="总 Token" value={summary.total.total_tokens || 0} /></Card>
          </TokenUsageTooltip>
          <Card size="small"><Statistic title="缓存命中" value={cacheHitRate(summary.total.input_tokens, summary.total.cached_input_tokens)} precision={1} suffix="%" /></Card>
          <Card size="small"><Statistic title="平均耗时" value={summary.total.average_duration_ms || 0} precision={0} suffix="ms" /></Card>
          <Card size="small"><Statistic title="错误" value={summary.total.errors || 0} /></Card>
          <Card size="small"><Statistic title={`估算成本（${currency}）`} value={summary.total.estimated_cost || 0} precision={4} /></Card>
        </div>

        {summary.byAccount.length > 0 && (
          <div className="v1-breakdown-grid">
            {summary.byAccount.map((item) => (
              <TokenUsageTooltip usage={item} key={item.account_id || "none"}>
                <Card
                  hoverable={Boolean(item.account_id)}
                  size="small"
                  className={filters.accountId === item.account_id ? "v1-summary-card active" : "v1-summary-card"}
                  onClick={() => item.account_id && runQuery(1, pageData.pageSize, { ...filters, accountId: filters.accountId === item.account_id ? "" : item.account_id })}
                >
                  <Statistic title={item.account_id ? item.account_name || item.account_id : "非账号渠道"} value={item.total_tokens || 0} formatter={(value) => formatTokenNumber(Number(value || 0))} suffix="Token" />
                </Card>
              </TokenUsageTooltip>
            ))}
          </div>
        )}

        <Table
          rowKey="id"
          columns={columns}
          dataSource={pageData.items}
          pagination={false}
          scroll={{ x: "max-content" }}
          tableLayout="fixed"
          sticky
          onRow={(log) => ({ onClick: () => setSelectedLog(log) })}
          locale={{ emptyText: <Empty description="当前筛选范围内没有调用记录。" /> }}
        />
        <Flex justify="flex-end" className="v1-pagination">
          <Pagination
            current={pageData.page}
            pageSize={pageData.pageSize}
            total={pageData.total}
            showSizeChanger
            pageSizeOptions={[10, 20, 50, 100, 200]}
            showTotal={(total) => `共 ${total} 条`}
            onChange={(page, pageSize) => runQuery(page, pageSize)}
          />
        </Flex>
      <Drawer title="调用详情" open={Boolean(selectedLog)} size={680} extra={selectedLog && <Button icon={<CopyOutlined />} onClick={() => copyValue(JSON.stringify(selectedLog, null, 2))}>复制 JSON</Button>} onClose={() => setSelectedLog(null)}>
        {selectedLog && <Descriptions bordered column={1} size="small" items={requestLogDetails(selectedLog)} />}
      </Drawer>

    </section>
  );
};

const TokenUsageTooltip = ({
  usage,
  children
}: {
  usage: TokenSummary["total"];
  children: ReactElement;
}) => (
  <Tooltip
    title={(
      <div className="v1-token-tooltip">
        <div>输入：{formatTokenNumber(usage.input_tokens)}</div>
        <div>缓存输入：{formatTokenNumber(usage.cached_input_tokens)}</div>
        <div>输出：{formatTokenNumber(usage.output_tokens)}</div>
        <div>缓存命中率：{cacheHitRate(usage.input_tokens, usage.cached_input_tokens).toFixed(1)}%</div>
      </div>
    )}
  >
    {children}
  </Tooltip>
);

const requestLogDetails = (log: RequestLog) => Object.entries({
  时间: formatTime(log.created_at),
  目标: log.upstream_name || log.upstream_id || log.account_name || "-",
  目标类型: log.upstream_kind || "-",
  客户端模型: log.client_model || "-",
  上游模型: log.upstream_model || "-",
  会话: log.session_id || "-",
  客户端路径: log.request_path || "-",
  上游路径: log.upstream_path || "-",
  状态: log.status || "-",
  耗时: log.duration_ms ? `${log.duration_ms} ms` : "-",
  输入Token: log.input_tokens || 0,
  缓存输入: log.cached_input_tokens || 0,
  输出Token: log.output_tokens || 0,
  总Token: log.total_tokens || 0,
  消息: log.message || "-"
}).map(([key, value]) => ({ key, label: key, children: String(value) }));
