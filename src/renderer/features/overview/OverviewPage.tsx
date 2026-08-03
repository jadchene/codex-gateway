import {
  ApiOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  ReloadOutlined,
  TeamOutlined
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Col, Flex, List, Progress, Row, Space, Statistic, Typography } from "antd";
import type { ReactNode } from "react";
import type { AppLog, TokenSummary } from "../../../shared/contracts/logs";
import { cacheHitRate } from "../../lib/formatters";

type SettingsRecord = Record<string, string>;

interface AccountSummary {
  enabled?: boolean;
  status?: string;
  has_access_token?: boolean;
  quota_5h_used_percent?: number;
  quota_5h_reset_at?: number;
  quota_7d_used_percent?: number;
  quota_7d_reset_at?: number;
}

interface OverviewPageProps {
  accounts: AccountSummary[];
  gateway: { running?: boolean; url?: string; activeHttpRequests?: number; activeWebSockets?: number };
  mcpGateway: { running?: boolean; url?: string };
  tokenSummary: TokenSummary;
  quotaSummary: {
    primary?: QuotaDetail;
    secondary?: QuotaDetail;
  };
  settings: SettingsRecord;
  recentLogs?: AppLog[];
  onToggleGateway?: () => Promise<void>;
  onRefreshAccounts?: () => Promise<void>;
}

interface QuotaDetail {
  remaining_percent?: number;
  reset_at?: number;
}

export const OverviewPage = ({
  accounts,
  gateway,
  mcpGateway,
  tokenSummary,
  quotaSummary,
  settings,
  recentLogs = [],
  onToggleGateway,
  onRefreshAccounts
}: OverviewPageProps) => {
  const upstreamQuery = useQuery({
    queryKey: ["upstreams", "overview"],
    queryFn: () => window.codexGateway.listUpstreams()
  });
  const usableAccounts = accounts.filter((account) => isUsableAccount(account, settings)).length;
  const total = tokenSummary?.total || {};
  const apiUpstreams = Array.isArray(upstreamQuery.data)
    ? upstreamQuery.data.filter((upstream) => upstream.kind === "responses_api")
    : [];
  const healthyApiUpstreams = apiUpstreams.filter((upstream) => upstream.enabled && upstream.healthStatus === "healthy").length;
  const unhealthyApiUpstreams = apiUpstreams.filter((upstream) => upstream.enabled && upstream.healthStatus === "unhealthy");
  const modelCount = (upstreamQuery.data ?? []).reduce((total, upstream) => total + upstream.modelCount, 0);
  const errorLogs = recentLogs.filter((log) => log.level === "error" || log.status === "failed").slice(0, 5);

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <div className="v1-page-card">
        <Flex className="v1-page-heading" align="flex-start" justify="space-between" gap={16} wrap>
          <div>
            <Typography.Title level={4}>运行概览</Typography.Title>
            <Typography.Text type="secondary">快速查看服务状态、账号额度和今日调用。</Typography.Text>
          </div>
        </Flex>
        <Flex gap={8} wrap className="v1-table-toolbar">
          <Button type="primary" onClick={() => void onToggleGateway?.()}>{gateway.running ? "停止网关" : "启动网关"}</Button>
          <Button icon={<ReloadOutlined />} onClick={() => void onRefreshAccounts?.()}>刷新订阅额度</Button>
        </Flex>
        <Row gutter={[16, 16]}>
          <MetricCard icon={<TeamOutlined />} title="可用订阅账号" value={`${usableAccounts}/${accounts.length}`} />
          <MetricCard icon={<ApiOutlined />} title="可用第三方渠道" value={`${healthyApiUpstreams}/${apiUpstreams.length}`} loading={upstreamQuery.isLoading} />
          <MetricCard icon={<DashboardOutlined />} title="可选模型" value={modelCount} loading={upstreamQuery.isLoading} />
          <MetricCard icon={<CloudServerOutlined />} title="今日调用" value={total.calls || 0} />
        </Row>
      </div>

      <Card title="服务地址" className="v1-overview-card">
        <Row gutter={[16, 12]}>
          <Col xs={24} lg={12}><Typography.Text type="secondary">Codex Gateway</Typography.Text><Typography.Text className="v1-block v1-mono">{gateway.url || "未启动"}</Typography.Text></Col>
          <Col xs={24} lg={12}><Typography.Text type="secondary">MCP Gateway</Typography.Text><Typography.Text className="v1-block v1-mono">{mcpGateway.url || "未启动"}</Typography.Text></Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]}>
        {settings.ignore_five_hour_limit !== "true" && (
          <Col xs={24} xl={12}><QuotaCard title="5 小时剩余额度" detail={quotaSummary.primary} /></Col>
        )}
        <Col xs={24} xl={settings.ignore_five_hour_limit === "true" ? 24 : 12}>
          <QuotaCard title="7 天剩余额度" detail={quotaSummary.secondary} />
        </Col>
      </Row>

      <Card title="今日调用统计" className="v1-overview-card">
        <Row gutter={[16, 20]}>
          <StatisticColumn title="总 Token" value={total.total_tokens || 0} />
          <StatisticColumn title="输入（未命中）" value={Math.max(0, Number(total.input_tokens || 0) - Number(total.cached_input_tokens || 0))} />
          <StatisticColumn title="缓存输入" value={total.cached_input_tokens || 0} />
          <StatisticColumn title="输出 Token" value={total.output_tokens || 0} />
          <StatisticColumn title="缓存命中率" value={cacheHitRate(total.input_tokens, total.cached_input_tokens)} precision={1} suffix="%" />
          <StatisticColumn title={`估算成本（${settings.billing_currency || "USD"}）`} value={Number(total.estimated_cost || 0)} precision={4} />
          <StatisticColumn title="错误" value={Number(total.errors || 0)} />
        </Row>
      </Card>

      <Card title="需要关注" className="v1-overview-card">
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          {unhealthyApiUpstreams.map((upstream) => <Alert key={upstream.id} showIcon type="warning" title={`${upstream.name} 健康检查失败`} description={upstream.healthMessage || "请检查地址、认证和网络。"} />)}
          {errorLogs.length === 0 && unhealthyApiUpstreams.length === 0
            ? <Alert showIcon type="success" title="当前运行正常" />
            : <List size="small" dataSource={errorLogs} renderItem={(log) => <List.Item><Typography.Text type="danger">{log.scope || "system"} · {log.message || log.status || "未知错误"}</Typography.Text></List.Item>} />}
        </Space>
      </Card>
    </Space>
  );
};

const MetricCard = ({
  icon,
  title,
  value,
  loading = false
}: {
  icon: ReactNode;
  title: string;
  value: string | number;
  loading?: boolean;
}) => (
  <Col xs={24} sm={12} xl={6}>
    <Card loading={loading} className="v1-overview-card">
      <Flex align="center" gap={14}>
        <div className="v1-overview-icon">{icon}</div>
        <Statistic title={title} value={value} />
      </Flex>
    </Card>
  </Col>
);

const QuotaCard = ({ title, detail }: { title: string; detail: QuotaDetail | undefined }) => {
  const remaining = Math.max(0, Math.min(100, Number(detail?.remaining_percent || 0)));
  return (
    <Card className="v1-overview-card">
      <Flex align="center" justify="space-between" gap={16}>
        <div>
          <Typography.Text type="secondary">{title}</Typography.Text>
          <Typography.Title level={3}>{remaining.toFixed(1)}%</Typography.Title>
          <Typography.Text type="secondary">重置：{formatTime(detail?.reset_at)}</Typography.Text>
        </div>
        <Progress type="dashboard" percent={remaining} size={92} strokeColor={remaining < 20 ? "#dc2626" : "#2563eb"} />
      </Flex>
    </Card>
  );
};

const StatisticColumn = ({
  title,
  value,
  precision,
  suffix
}: {
  title: string;
  value: number;
  precision?: number;
  suffix?: string;
}) => (
  <Col xs={12} lg={8} xl={6}>
    <Statistic title={title} value={value} {...(precision === undefined ? {} : { precision })} {...(suffix === undefined ? {} : { suffix })} />
  </Col>
);

const isUsableAccount = (account: AccountSummary, settings: SettingsRecord): boolean => {
  if (!account.enabled || account.status === "disabled" || !account.has_access_token) return false;
  const now = Math.floor(Date.now() / 1000);
  const windows: Array<[number | undefined, number | undefined]> = [
    [account.quota_7d_used_percent, account.quota_7d_reset_at]
  ];
  if (settings.ignore_five_hour_limit !== "true") {
    windows.push([account.quota_5h_used_percent, account.quota_5h_reset_at]);
  }
  return !windows.some(([usedValue, resetValue]) => {
    const used = Number(usedValue);
    if (!Number.isFinite(used) || used < 99.9) return false;
    const resetAt = Number(resetValue);
    return !Number.isFinite(resetAt) || resetAt <= 0 || resetAt > now;
  });
};

const formatTime = (value: number | undefined): string => {
  const timestamp = Number(value || 0);
  if (!timestamp) return "暂无";
  return new Date(timestamp * 1000).toLocaleString();
};
