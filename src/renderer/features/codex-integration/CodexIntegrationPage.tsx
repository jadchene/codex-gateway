import { CheckCircleOutlined, KeyOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Flex, Radio, Select, Space, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { PublicAccount } from "../../../shared/contracts/accounts";
import type { Settings } from "../../../shared/contracts/settings";
import { isUsableAccount } from "../../lib/formatters";

type AuthMode = "gateway" | "account" | "";

interface CodexIntegrationPageProps {
  settings: Settings;
  accounts: PublicAccount[];
  gatewayBase: string;
  modelCatalogPath: string;
  onMessage: (message: string) => void;
  onApplyGateway: () => Promise<void>;
  onApplyAccount: (accountId: string) => Promise<void>;
}

export const CodexIntegrationPage = ({
  settings,
  accounts,
  gatewayBase,
  modelCatalogPath,
  onMessage,
  onApplyGateway,
  onApplyAccount
}: CodexIntegrationPageProps) => {
  const [mode, setMode] = useState<AuthMode>(normalizeAuthMode(settings.codex_auth_mode));
  const [accountId, setAccountId] = useState(settings.codex_auth_mode === "account" ? settings.codex_selected_account_id || "" : "");
  const [busy, setBusy] = useState(false);
  const usableAccounts = useMemo(() => accounts.filter((account) => isUsableAccount(account, settings)), [accounts, settings]);
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const alreadyApplied = mode === "gateway"
    ? settings.codex_auth_mode === "gateway"
    : mode === "account" && settings.codex_auth_mode === "account" && settings.codex_selected_account_id === accountId;

  useEffect(() => {
    setMode(normalizeAuthMode(settings.codex_auth_mode));
    setAccountId(settings.codex_auth_mode === "account" ? settings.codex_selected_account_id || "" : "");
  }, [settings]);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      if (mode === "gateway") await onApplyGateway();
      else if (mode === "account") await onApplyAccount(accountId);
    } catch (error) {
      onMessage(`写入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="v1-page-card" variant="borderless">
      <Flex className="v1-page-heading" align="flex-start" justify="space-between" gap={16} wrap>
        <div>
          <Typography.Title level={4}>接入模式</Typography.Title>
          <Typography.Text type="secondary">Codex 可以固定使用本地统一网关，也可以临时切换为某个订阅账号直连。</Typography.Text>
        </div>
        {settings.codex_auth_mode && <Tag color="success" icon={<CheckCircleOutlined />}>当前：{settings.codex_auth_mode === "gateway" ? "网关模式" : "账号模式"}</Tag>}
      </Flex>

      <Radio.Group value={mode} onChange={(event) => setMode(event.target.value as AuthMode)} className="v1-auth-mode-group">
        <Radio.Button value="gateway">
          <Space><SafetyCertificateOutlined /><span>网关模式</span></Space>
        </Radio.Button>
        <Radio.Button value="account">
          <Space><KeyOutlined /><span>账号模式</span></Space>
        </Radio.Button>
      </Radio.Group>

      {!mode && <Alert showIcon type="info" title="当前 Codex 认证状态未知，请选择一种模式。" />}

      {mode === "gateway" && (
        <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            showIcon
            type="success"
            title="推荐模式"
            description="应用时会同时写入本地网关 Key、provider 和组合模型目录；第三方 Responses API 模型由目录声明 shell、tool、MCP 与推理能力。模型渠道变更后目录会自动重建。"
          />
          <div className="v1-auth-preview-grid">
            <CodePreview title="auth.json" value={JSON.stringify({ OPENAI_API_KEY: maskedGatewayKey(settings) }, null, 2)} />
            <CodePreview title="config.toml" value={providerToml(settings, gatewayBase, modelCatalogPath)} />
          </div>
        </Space>
      )}

      {mode === "account" && (
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Alert
            showIcon
            type="warning"
            title="账号直连会把选中账号的认证写入 Codex"
            description="这会移除 Codex Gateway provider 配置；需要恢复统一路由时重新应用网关模式。"
          />
          <Select
            showSearch
            value={accountId || null}
            placeholder="选择一个可用订阅账号"
            optionFilterProp="label"
            options={accounts.map((account) => ({
              value: account.id,
              label: `${account.name || "未命名账号"}${account.email ? ` · ${account.email}` : ""}`,
              disabled: !isUsableAccount(account, settings)
            }))}
            onChange={setAccountId}
          />
          {accounts.length > 0 && usableAccounts.length === 0 && <Alert showIcon type="error" title="当前没有可用账号，请先刷新额度或重新登录。" />}
        </Space>
      )}

      <Flex justify="flex-end" className="v1-auth-actions">
        <Button
          type="primary"
          loading={busy}
          disabled={!mode || (mode === "account" && (alreadyApplied || !accountId || !isUsableAccount(selectedAccount, settings)))}
          onClick={apply}
        >
          {alreadyApplied && mode === "gateway" ? "重新应用到 Codex" : alreadyApplied ? "已应用" : "应用到 Codex"}
        </Button>
      </Flex>
    </Card>
  );
};

const CodePreview = ({ title, value }: { title: string; value: string }) => (
  <Card size="small" title={title}>
    <Typography.Paragraph copyable={{ text: value }} className="v1-code-preview">
      <pre>{value}</pre>
    </Typography.Paragraph>
  </Card>
);

const normalizeAuthMode = (value: unknown): AuthMode => (
  value === "gateway" || value === "account" ? value : ""
);

const maskedGatewayKey = (settings: Settings): string => settings.gateway_api_key_configured === "true"
  ? `•••••••• (${settings.gateway_api_key_fingerprint || "configured"})`
  : "未配置";

const providerToml = (settings: Settings, gatewayBase: string, modelCatalogPath: string): string => {
  const baseUrl = gatewayBase || `http://${gatewayProviderHost(settings.gateway_host)}:${settings.gateway_port || "8436"}/v1`;
  return [
    'model_provider = "codex_gateway"',
    `model_catalog_json = "${modelCatalogPath.replaceAll("\\", "/")}"`,
    "",
    "[model_providers.codex_gateway]",
    'name = "OpenAI"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    "supports_websockets = true"
  ].join("\n");
};

const gatewayProviderHost = (host: unknown): string => {
  const value = String(host || "").trim();
  return !value || value === "0.0.0.0" ? "localhost" : value;
};
