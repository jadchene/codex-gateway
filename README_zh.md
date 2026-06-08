# Codex Gateway

[English README](README.md)

**免责声明**：本项目仅用于学习和本地开发测试。使用者必须遵守相关平台的服务条款。本项目只面向个人本机使用，不提供、不分发任何账号、API Key、账号服务或代理服务，也不应被用于多用户共享、商业转售、规避限制或其它违反服务条款的用途。请自行承担使用风险。

Codex Gateway 是一个本地桌面应用，用于管理个人 Codex/ChatGPT 登录状态、切换 Codex 认证模式、查看额度信息，并运行本地网关服务。应用基于 Electron、React 和 Vite 构建，数据保存在本机 SQLite。

## 功能概览

- **账号管理**：通过浏览器 OAuth 添加个人账号，也可以导入本机已有的 Codex 认证文件。
- **额度查看**：记录 5 小时和 7 天额度窗口，支持手动刷新、定时刷新和网关失败切换前刷新。
- **Codex 认证管理**：在本地网关模式和直接账号模式之间切换，并写入 `~/.codex/auth.json`、`~/.codex/config.toml`。
- **Codex 网关服务**：提供本机 OpenAI 兼容的 `/v1` 网关入口，用于 Codex 相关请求。
- **MCP 网关服务控制**：在应用内启动和停止外部 `mcp-gateway-service` 的 Streamable HTTP 模式。
- **调用记录**：保存请求路径、上游路径、账号、会话 ID、耗时、状态和 token 使用情况。
- **会话管理**：从调用记录保存 Codex 会话 ID，并维护名称、备注、查询和删除。
- **运行日志**：查看应用启动、认证写入、网关事件、额度刷新和异常信息。
- **应用配置**：配置端口、API Key、自动启动、关闭到托盘、计费系数、MCP 网关和本地日志清理。

## 界面说明

- **仪表盘**：显示可用账号数量、Codex 网关状态、MCP 网关状态、额度概览和今日 token 使用情况。
- **账号管理**：添加账号、启停账号、刷新额度、导入本机 Codex 凭据。
- **认证管理**：把网关模式或账号模式应用到本机 Codex CLI 配置。
- **网关服务**：分别控制内置 Codex 网关和外部 MCP 网关。
- **会话管理**：为 Codex 会话 ID 保存名称和备注。
- **调用记录**：按日期、账号和会话 ID 查询网关调用日志。
- **运行日志**：查看本地应用运行记录。
- **应用配置**：编辑网关、启动、刷新、计费、MCP 网关和清理相关配置。

## Codex 网关

内置 Codex 网关提供较小的本机 OpenAI 兼容接口面：

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`

网关会把请求转发到配置的 Codex 上游地址。它只替换上游调用需要的 `Authorization` 和 `ChatGPT-Account-ID` 请求头。图片接口不受支持。

默认 Codex 网关配置：

```text
主机: localhost
端口: 8436
Base URL: http://localhost:8436/v1
API Key: local-personal-token
```

API Key 和监听配置都可以在应用配置中修改。

## 账号使用模型

每次网关请求只会选择一个当前可用账号发起上游调用。如果该账号返回认证失效、额度不足或限流错误，应用会刷新本地额度信息，并为当前请求尝试下一个可用账号。

只要当前账号仍可用，应用会继续使用它。每天本地日期首次网关请求可以按 7 天剩余额度重新选择账号。

这个机制用于个人本地开发时减少手动切换账号配置的操作，不应被理解为并发调度、资源池聚合、额度叠加或绕过服务限制。

## Codex 认证接入

认证管理页面支持两种模式：

- **网关模式**：向 `~/.codex/auth.json` 写入本地 `OPENAI_API_KEY`，并确保 `~/.codex/config.toml` 中存在 `codex_gateway` provider。
- **账号模式**：把选中的本地账号 token 写入 `~/.codex/auth.json`，并移除本应用写入的网关 provider。

网关 provider 示例：

```toml
model_provider = "codex_gateway"

[model_providers.codex_gateway]
name = "OpenAI"
base_url = "http://localhost:8436/v1"
wire_api = "responses"
```

当监听主机是 `0.0.0.0` 时，生成的 provider URL 会使用 `localhost`，方便 Codex CLI 连接本机服务。

## MCP 网关控制

Codex Gateway 可以管理外部 [`mcp-gateway-service`](https://www.npmjs.com/package/@jadchene/mcp-gateway-service) 进程，并以 Streamable HTTP 模式启动。

应用内 MCP 网关默认配置：

```text
主机: 127.0.0.1
端口: 3000
路径: /mcp
```

应用会使用 `--http` 启动服务，并按配置追加可选参数：

```bash
mcp-gateway-service --http --config ./config.json --host 127.0.0.1 --port 3000 --path /mcp --json-response
```

只有已填写或已启用的选项才会传入：

- 配置路径会对应 `--config <path>`。
- 主机会对应 `--host <host>`。
- 端口会对应 `--port <port>`。
- 路径会对应 `--path <path>`。
- JSON Response 只有启用时才会传入 `--json-response`。

在 Windows 上，停止 MCP 网关时会结束进程树，避免子进程残留导致端口占用。

## 本地数据

默认本地数据路径：

```text
data/codex-gateway.sqlite
data/browser
```

SQLite 会保存：

- 账号 token 和账号元数据
- 额度快照
- 网关调用记录
- 已保存的 Codex 会话名称和备注
- 运行日志
- 应用配置

请不要提交 `data/`、`~/.codex/auth.json`、`~/.codex/config.toml` 或任何包含 token 的文件。

## 快速开始

安装依赖：

```bash
npm install
```

以开发模式运行应用：

```bash
npm run dev
```

Vite 开发服务地址：

```text
http://127.0.0.1:8435
```

## 开发

运行测试：

```bash
npm test
```

构建渲染端：

```bash
npm run build
```

运行完整验证：

```bash
npm run verify
```

## 打包

创建 Windows 未压缩构建：

```bash
npm run pack:unpacked
```

输出目录：

```text
release/win-unpacked
```

Windows 可执行文件：

```text
release/win-unpacked/Codex Gateway.exe
```

## 备注

- 应用是本地优先设计，不需要托管后端。
- 关闭窗口时可以选择退出应用或最小化到系统托盘。
- 网关和额度刷新事件会写入本地运行日志。
- 应用配置中的计费系数只影响本地使用统计的展示计算。

## License

MIT
