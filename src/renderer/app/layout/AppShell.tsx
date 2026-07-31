import {
  ApiOutlined,
  BarChartOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  FileSearchOutlined,
  KeyOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  TeamOutlined
} from "@ant-design/icons";
import { Button, Flex, Layout, Menu, Space, Tag, Typography } from "antd";
import type { MenuProps } from "antd";
import type { PropsWithChildren } from "react";
import { useEffect, useMemo, useState } from "react";

const { Header, Content, Sider } = Layout;

interface PageDefinition {
  id: string;
  label: string;
}

interface AppShellProps extends PropsWithChildren {
  activePage: string;
  appVersion?: string;
  gatewayRunning: boolean;
  initiallyCollapsed?: boolean;
  mcpGatewayRunning: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onNavigate: (page: string) => void;
  pages: PageDefinition[];
}

const navigationItems: MenuProps["items"] = [
  { key: "overview", icon: <DashboardOutlined />, label: "概览" },
  { key: "accounts", icon: <TeamOutlined />, label: "订阅账号" },
  { key: "upstreams", icon: <ApiOutlined />, label: "API 上游" },
  { key: "services", icon: <CloudServerOutlined />, label: "服务管理" },
  { key: "analytics", icon: <BarChartOutlined />, label: "调用分析" },
  { key: "runtimeLogs", icon: <FileSearchOutlined />, label: "运行日志" },
  { key: "codexIntegration", icon: <KeyOutlined />, label: "CLI 接入" },
  { key: "settings", icon: <SettingOutlined />, label: "设置中心" }
];

export const AppShell = ({
  activePage,
  appVersion = "",
  children,
  gatewayRunning,
  initiallyCollapsed = false,
  mcpGatewayRunning,
  onCollapsedChange,
  onNavigate,
  pages
}: AppShellProps) => {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const title = useMemo(
    () => pages.find((page) => page.id === activePage)?.label ?? "Codex Gateway",
    [activePage, pages]
  );

  useEffect(() => setCollapsed(initiallyCollapsed), [initiallyCollapsed]);

  const toggleCollapsed = (): void => {
    setCollapsed((value) => {
      const next = !value;
      onCollapsedChange?.(next);
      return next;
    });
  };

  return (
    <Layout className="v1-shell">
      <Sider className="v1-sider" collapsed={collapsed} collapsedWidth={72} width={232} trigger={null}>
        <div className="v1-brand">
          <div className="v1-brand-mark">CG</div>
          {!collapsed && (
            <div>
              <Typography.Text strong>Codex Gateway</Typography.Text>
              <Typography.Text type="secondary" className="v1-brand-subtitle">
                {appVersion ? `v${appVersion}` : ""}
              </Typography.Text>
            </div>
          )}
        </div>
        <Menu
          className="v1-navigation"
          items={navigationItems}
          mode="inline"
          selectedKeys={[activePage]}
          onClick={({ key }) => onNavigate(key)}
        />
      </Sider>
      <Layout className="v1-main-layout">
        <Header className="v1-header">
          <Flex align="center" justify="space-between" gap={16}>
            <Space size={12}>
              <Button
                aria-label={collapsed ? "展开导航" : "折叠导航"}
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                type="text"
                onClick={toggleCollapsed}
              />
              <div>
                <Typography.Title level={3}>{title}</Typography.Title>
                <Typography.Text type="secondary">本地 AI 网关控制台</Typography.Text>
              </div>
            </Space>
            <Space wrap>
              <Tag color={gatewayRunning ? "success" : "default"}>Gateway {gatewayRunning ? "运行中" : "已停止"}</Tag>
              <Tag color={mcpGatewayRunning ? "success" : "default"}>MCP {mcpGatewayRunning ? "运行中" : "已停止"}</Tag>
            </Space>
          </Flex>
        </Header>
        <Content className="v1-content">{children}</Content>
      </Layout>
    </Layout>
  );
};
