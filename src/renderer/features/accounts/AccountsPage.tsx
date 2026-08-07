import {
  DeleteOutlined,
  ImportOutlined,
  LoginOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import {
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography
} from "antd";
import type { MenuProps, TableColumnsType } from "antd";
import { useMemo, useState } from "react";
import type { ConsumeResetCreditResult, PublicAccount, ResetCredit } from "../../../shared/contracts/accounts";
import type { Settings } from "../../../shared/contracts/settings";
import { formatTime, parseResetCredits, resetCreditStatusLabel } from "../../lib/formatters";

interface AccountsPageProps {
  accounts: PublicAccount[];
  loginId: string;
  refreshingIds: Set<string>;
  retryIds: Set<string>;
  settings: Settings;
  onStartLogin: () => Promise<void>;
  onImportLocal: () => Promise<void>;
  onCancelLogin: () => void;
  onRefreshUsage: (account: PublicAccount) => Promise<void>;
  onRefreshAll: () => Promise<void>;
  onConsumeResetCredit: (account: PublicAccount, creditId?: string) => Promise<ConsumeResetCreditResult | void>;
  consumingResetIds: Set<string>;
  onSetEnabled: (account: PublicAccount, enabled: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export const AccountsPage = ({
  accounts,
  loginId,
  refreshingIds,
  retryIds,
  settings,
  onStartLogin,
  onImportLocal,
  onCancelLogin,
  onRefreshUsage,
  onRefreshAll,
  onConsumeResetCredit,
  consumingResetIds,
  onSetEnabled,
  onDelete
}: AccountsPageProps) => {
  const [addOpen, setAddOpen] = useState(false);
  const [detailAccount, setDetailAccount] = useState<PublicAccount | null>(null);
  const resetCredits = useMemo(() => parseResetCredits(detailAccount), [detailAccount]);
  const enabledAccounts = accounts.filter((account) => account.enabled && account.status !== "disabled");
  const totalRemaining = enabledAccounts.reduce((total, account) => total + Math.max(0, 100 - Number(account.quota_7d_used_percent || 0)), 0);
  const latestRefresh = accounts.reduce<string | null>((latest, account) => {
    const value = account.last_refresh || null;
    return value && (!latest || new Date(value).getTime() > new Date(latest).getTime()) ? value : latest;
  }, null);

  const runAddAction = async (action: () => Promise<void>): Promise<void> => {
    setAddOpen(false);
    await action();
  };

  const accountActions = (account: PublicAccount): MenuProps["items"] => [
    {
      key: "refresh",
      label: retryIds.has(account.id) ? "重试刷新" : "刷新额度",
      disabled: refreshingIds.has(account.id),
      onClick: () => onRefreshUsage(account)
    },
    {
      key: "toggle",
      label: account.enabled ? "停用账号" : "启用账号",
      onClick: () => onSetEnabled(account, !account.enabled)
    },
    {
      key: "details",
      label: "查看详情",
      onClick: () => setDetailAccount(account)
    }
  ];

  const columns: TableColumnsType<PublicAccount> = [
    {
      title: "账号",
      key: "account",
      width: 240,
      render: (_, account) => (
        <div>
          <Typography.Text strong ellipsis={{ tooltip: account.name || "未命名账号" }}>{account.name || "未命名账号"}</Typography.Text>
          <Typography.Text ellipsis={{ tooltip: account.email || account.id }} type="secondary" className="v1-block">{account.email || account.id}</Typography.Text>
        </div>
      )
    },
    {
      title: "状态",
      key: "status",
      width: 100,
      render: (_, account) => (
        <Tag color={account.enabled && account.status !== "disabled" ? "success" : "default"}>
          {account.enabled ? "启用" : "停用"}
        </Tag>
      )
    },
    ...(settings.ignore_five_hour_limit === "true"
      ? []
      : [quotaColumn("5 小时额度", "quota_5h_used_percent", "quota_5h_reset_at")]),
    quotaColumn("7 天额度", "quota_7d_used_percent", "quota_7d_reset_at"),
    {
      title: "最近刷新",
      dataIndex: "last_refresh",
      width: 160,
      render: (value) => value ? new Date(value).toLocaleString() : "暂无"
    },
    {
      title: "套餐",
      dataIndex: "subscription_plan",
      width: 110,
      render: (value: string | undefined) => value || "未知"
    },
    {
      title: "重置次数",
      key: "resetCredits",
      width: 150,
      render: (_, account) => (
        <Button type="link" size="small" onClick={() => setDetailAccount(account)}>
          {Math.max(0, Number(account.reset_credits_available_count || 0))} 次
          {account.reset_credits_next_expires_at ? ` · ${formatTime(account.reset_credits_next_expires_at)}` : ""}
        </Button>
      )
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 124,
      render: (_, account) => (
        <Space size={4}>
          <Popconfirm
            title="删除这个账号？"
            description="删除后需要重新完成浏览器授权。"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(account.id)}
          >
            <Button aria-label="删除账号" danger icon={<DeleteOutlined />} />
          </Popconfirm>
          <Dropdown menu={{ items: accountActions(account) ?? [] }} trigger={["click"]}>
            <Button aria-label="更多账号操作" icon={<MoreOutlined />} />
          </Dropdown>
        </Space>
      )
    }
  ];

  return (
    <Card className="v1-page-card v1-page-fill" variant="borderless">
      <Flex className="v1-page-actions" justify="flex-end" gap={16} wrap>
        <Space wrap>
          {loginId && <Button onClick={onCancelLogin}>取消等待授权</Button>}
          <Button icon={<ReloadOutlined />} onClick={onRefreshAll}>刷新全部</Button>
          <Button type="primary" icon={<PlusOutlined />} disabled={Boolean(loginId)} onClick={() => setAddOpen(true)}>
            {loginId ? "等待授权" : "添加账号"}
          </Button>
        </Space>
      </Flex>

      <Row gutter={[12, 12]} className="v1-summary-cards">
        <Col xs={24} md={8}><Card size="small"><Statistic title="可用账号" value={enabledAccounts.length} suffix={`/ ${accounts.length}`} /></Card></Col>
        <Col xs={24} md={8}><Card size="small"><Statistic title="7 天总剩余额度" value={totalRemaining} precision={1} suffix="%" /></Card></Col>
        <Col xs={24} md={8}><Card size="small"><Statistic title="最近刷新" value={latestRefresh ? new Date(latestRefresh).toLocaleString() : "暂无"} /></Card></Col>
      </Row>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={accounts}
        pagination={false}
        scroll={{ x: "max-content" }}
        tableLayout="fixed"
        locale={{ emptyText: <Empty description="还没有账号，请先完成 ChatGPT/Codex 授权。" /> }}
      />

      <Modal title="添加订阅账号" open={addOpen} footer={null} onCancel={() => setAddOpen(false)}>
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Button block type="primary" icon={<LoginOutlined />} onClick={() => runAddAction(onStartLogin)}>
            浏览器认证
          </Button>
          <Button block icon={<ImportOutlined />} onClick={() => runAddAction(onImportLocal)}>
            从本机 Codex 读取
          </Button>
          <Typography.Text type="secondary">登录新账号请选择浏览器认证；也可以导入当前 Codex 已登录的账号。</Typography.Text>
        </Space>
      </Modal>

      <Drawer
        title={detailAccount ? `${detailAccount.name} · 账号详情` : "账号详情"}
        open={Boolean(detailAccount)}
        size={720}
        onClose={() => setDetailAccount(null)}
      >
        {detailAccount && <Descriptions bordered column={1} size="small" items={[
          { key: "identity", label: "账号", children: detailAccount.email || detailAccount.id },
          { key: "plan", label: "套餐", children: detailAccount.subscription_plan || "未知" },
          { key: "state", label: "状态", children: detailAccount.enabled ? "启用" : "停用" },
          { key: "refresh", label: "最近刷新", children: detailAccount.last_refresh ? new Date(detailAccount.last_refresh).toLocaleString() : "暂无" },
          {
            key: "token",
            label: "登录状态",
            children: !detailAccount.has_access_token
              ? "需要重新登录"
              : detailAccount.has_refresh_token ? "正常，可自动续期" : "已登录，过期后需重新登录"
          }
        ]} />}
        <Typography.Title level={5} style={{ marginTop: 20 }}>重置次数</Typography.Title>
        <Typography.Paragraph type="secondary">当前可用 {resetCredits.availableCount} 次。</Typography.Paragraph>
        <Table<ResetCredit>
          rowKey={(credit, index) => `${credit.title || "credit"}-${credit.granted_at || 0}-${index}`}
          pagination={false}
          dataSource={resetCredits.credits}
          columns={[
            { title: "状态", dataIndex: "status", width: 90, render: (value) => <Tag>{resetCreditStatusLabel(value)}</Tag> },
            { title: "重置类型", dataIndex: "title", width: 150, ellipsis: true, render: (value) => value || "-" },
            { title: "有效期开始", dataIndex: "granted_at", width: 160, render: (value) => formatTime(value) },
            { title: "有效期结束", dataIndex: "expires_at", width: 160, render: (value) => formatTime(value) },
            {
              title: "操作",
              key: "actions",
              width: 90,
              render: (_, credit) => {
                const busy = Boolean(detailAccount && consumingResetIds.has(detailAccount.id));
                const disabled = busy || String(credit.status || "").toLowerCase() !== "available";
                return (
                  <Popconfirm
                    title="使用这张重置卡？"
                    description="将消耗一次重置机会，并以服务器返回的数据为准刷新额度。"
                    okText="使用"
                    okButtonProps={{ danger: true }}
                    disabled={disabled}
                    onConfirm={async () => {
                      if (!detailAccount) return;
                      const result = await onConsumeResetCredit(detailAccount, credit.id);
                      if (result?.account) setDetailAccount(result.account);
                    }}
                  >
                    <Button size="small" type="link" loading={busy} disabled={disabled}>
                      使用
                    </Button>
                  </Popconfirm>
                );
              }
            }
          ]}
          scroll={{ x: 660 }}
          tableLayout="fixed"
          locale={{ emptyText: <Empty description="暂无重置次数数据，请先刷新账号额度。" /> }}
        />
      </Drawer>
    </Card>
  );
};

const quotaColumn = (
  title: string,
  usedField: "quota_5h_used_percent" | "quota_7d_used_percent",
  resetField: "quota_5h_reset_at" | "quota_7d_reset_at"
): TableColumnsType<PublicAccount>[number] => ({
  title,
  key: usedField,
  width: 190,
  render: (_, account) => {
    const used = Math.max(0, Math.min(100, Number(account[usedField] || 0)));
    const remaining = Math.max(0, 100 - used);
    return (
      <div>
        <Progress percent={remaining} size="small" {...(remaining < 20 ? { strokeColor: "#dc2626" } : {})} />
        <Typography.Text type="secondary" className="v1-block">重置：{formatTime(account[resetField])}</Typography.Text>
      </div>
    );
  }
});
