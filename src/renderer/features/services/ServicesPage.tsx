import { CopyOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { Alert, Badge, Button, Card, Descriptions, Flex, Space, Typography } from "antd";
import { useState } from "react";
import type { ReactNode } from "react";

interface ServiceStatus {
  running: boolean;
  command?: string;
  error?: string;
  activeHttpRequests?: number;
  activeWebSockets?: number;
}

interface ServicesPageProps {
  gateway: ServiceStatus;
  mcpGateway: ServiceStatus;
  gatewayBase: string;
  mcpGatewayUrl: string;
  mcpGatewayCommand: string;
  onToggleGateway: () => Promise<void>;
  onToggleMcpGateway: () => Promise<void>;
  onRestartGateway: () => Promise<void>;
  onRestartMcpGateway: () => Promise<void>;
  onMessage: (message: string) => void;
}

export const ServicesPage = ({
  gateway,
  mcpGateway,
  gatewayBase,
  mcpGatewayUrl,
  mcpGatewayCommand,
  onToggleGateway,
  onToggleMcpGateway,
  onRestartGateway,
  onRestartMcpGateway,
  onMessage
}: ServicesPageProps) => {
  const [busyService, setBusyService] = useState<"gateway" | "mcp" | null>(null);

  const toggle = async (service: "gateway" | "mcp"): Promise<void> => {
    setBusyService(service);
    try {
      await (service === "gateway" ? onToggleGateway() : onToggleMcpGateway());
    } finally {
      setBusyService(null);
    }
  };

  const restart = async (service: "gateway" | "mcp"): Promise<void> => {
    setBusyService(service);
    try {
      await (service === "gateway" ? onRestartGateway() : onRestartMcpGateway());
    } finally {
      setBusyService(null);
    }
  };

  const copy = async (label: string, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      onMessage(`${label}已复制`);
    } catch (error) {
      onMessage(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="v1-page-card">
      <Flex className="v1-page-heading" align="flex-start" justify="space-between" gap={16} wrap>
        <div>
          <Typography.Title level={4}>服务管理</Typography.Title>
          <Typography.Text type="secondary">独立查看和控制 Codex Gateway 与 MCP Gateway，不把运行状态混入系统设置。</Typography.Text>
        </div>
      </Flex>
      <div className="v1-service-grid">
        <ServiceCard
          title="Codex Gateway"
          running={gateway.running}
          loading={busyService === "gateway"}
          onToggle={() => toggle("gateway")}
          onRestart={() => restart("gateway")}
        >
          <Descriptions column={1} size="small" items={[
            { key: "base", label: "Base URL", children: <CopyableValue value={gatewayBase} onCopy={() => copy("Base URL", gatewayBase)} /> }
          ]} />
          {gateway.error && <Alert showIcon type="error" title="最近错误" description={gateway.error} />}
        </ServiceCard>
        <ServiceCard
          title="MCP Gateway"
          running={mcpGateway.running}
          loading={busyService === "mcp"}
          onToggle={() => toggle("mcp")}
          onRestart={() => restart("mcp")}
        >
          <Descriptions column={1} size="small" items={[
            { key: "url", label: "服务地址", children: <CopyableValue value={mcpGatewayUrl || "-"} onCopy={() => copy("MCP 地址", mcpGatewayUrl)} /> },
            { key: "command", label: "启动命令", children: <CopyableValue value={mcpGateway.command || mcpGatewayCommand || "-"} onCopy={() => copy("MCP 命令", mcpGateway.command || mcpGatewayCommand)} /> }
          ]} />
          {mcpGateway.error && <Alert showIcon type="error" title="最近错误" description={mcpGateway.error} />}
        </ServiceCard>
      </div>
    </div>
  );
};

const ServiceCard = ({
  title,
  running,
  loading,
  onToggle,
  onRestart,
  children
}: {
  title: string;
  running: boolean;
  loading: boolean;
  onToggle: () => void;
  onRestart: () => void;
  children: ReactNode;
}) => (
  <Card
    title={(
      <Space><Typography.Text strong>{title}</Typography.Text><Badge status={running ? "success" : "default"} text={running ? "运行中" : "已停止"} /></Space>
    )}
    extra={(
      <Space>
      {running && <Button loading={loading} icon={<ReloadOutlined />} onClick={onRestart}>重启</Button>}
      <Button
        danger={running}
        loading={loading}
        type={running ? "default" : "primary"}
        icon={running ? <StopOutlined /> : <PlayCircleOutlined />}
        onClick={onToggle}
      >
        {running ? "停止" : "启动"}
      </Button>
      </Space>
    )}
  >
    {children}
  </Card>
);

const CopyableValue = ({ value, onCopy }: { value: string; onCopy: () => void }) => (
  <Flex align="center" gap={8}>
    <Typography.Text className="v1-mono">{value || "-"}</Typography.Text>
    {value && value !== "-" && <Button aria-label={`复制 ${value}`} icon={<CopyOutlined />} size="small" type="text" onClick={onCopy} />}
  </Flex>
);
