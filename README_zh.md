# Codex Gateway

**免责声明**：本项目仅供学习与开发目的使用。使用者必须严格遵守相关平台的服务条款。本项目设计为仅供个人本地使用，严禁将服务暴露给多人使用或用于任何形式的商业转售。本人不提供或分发任何账号、API Key 或代理服务，也不对本软件的具体使用方式承担任何责任。请勿使用本项目尝试绕过速率限制或其他服务限制。

Codex Gateway 是一个基于 Electron、React 和 Vite 的本地桌面应用，用于管理多个 ChatGPT/Codex 账号，并为 Codex 提供尽量透明的本地网关。它面向个人本机使用场景：账号登录、额度刷新、认证写入、请求转发和 token 用量记录都在一个桌面应用里完成。

### 功能特性

- **仪表盘**：查看运行概览、可用账号比例、网关状态以及今日 token 用量统计。
- **账号管理**：通过浏览器 OAuth 登录 ChatGPT 账号，直观展示 5 小时和 7 天额度窗口，并支持账号停用、手动刷新以及过期额度自动刷新。
- **认证管理**：支持一键将网关配置或选中的本地账号 Token 写入 `~/.codex/auth.json`，在网关模式和账号直连模式之间无缝切换。
- **网关服务**：提供原生的 Codex `/v1/responses` 兼容网关，支持多账号根据存活状态与剩余额度进行自动路由和故障转移。
- **调用记录**：详细记录并可根据账号或会话查询历次请求的 Input/Output Token 用量和耗时。
- **运行日志**：记录应用的生命周期事件、认证写入、额度刷新失败等关键后台运行信息。
- **应用配置**：修改本地网关端口和 API Key，设置额度定时刷新频率，或清空本地数据。

### 支持的网关入口

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`

网关会透传客户端请求头，并仅替换上游调用所需的 `Authorization` 和 `ChatGPT-Account-ID`。

### 开发

```bash
npm install
npm run dev
```

开发服务地址：

```text
http://127.0.0.1:8435
```

### 验证

```bash
npm test
npm run build
```

### 打包

生成 unpacked 包：

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

### Codex 接入

应用内 `认证管理` 页面支持两种模式：

- 网关模式：写入 `~/.codex/auth.json` 的 `OPENAI_API_KEY`，并在缺少 provider 时补充 `~/.codex/config.toml`。
- 账号模式：将选中的本地账号 token 写入 `~/.codex/auth.json`，并移除本应用写入的 `codex_gateway` provider。

手动接入时，客户端可使用：

```text
OPENAI_BASE_URL=http://localhost:8436/v1
OPENAI_API_KEY=local-personal-token
```

本地 API Key 可在应用配置中修改。

### 数据目录

默认本地数据：

```text
data/codex-gateway.sqlite
data/browser
```

其中 SQLite 会保存账号、额度快照、调用记录、运行日志和应用配置。可以在应用配置页面查看实际数据目录和数据库路径。

### 安全说明

账号 token 和本地 API Key 只保存在本机。请不要提交 `data/`、`~/.codex/auth.json`、`~/.codex/config.toml` 或任何包含 token 的文件。本项目面向个人本地使用，默认不提供远程访问鉴权以外的多租户隔离能力。

### License

MIT
