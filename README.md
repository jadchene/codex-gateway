# Codex Gateway

Personal Codex account manager and transparent local gateway.

[中文](#中文) | [English](#english)

## 中文

Codex Gateway 是一个基于 Electron、React 和 Vite 的本地桌面应用，用于管理多个 ChatGPT/Codex 账号，并为 Codex CLI 或其它 OpenAI 兼容客户端提供尽量透明的本地网关。它面向个人本机使用场景：账号登录、额度刷新、认证写入、请求转发和 token 用量记录都在一个桌面应用里完成。

### 功能特性

- 浏览器 OAuth 登录 ChatGPT/Codex 账号，无需手动填写 token；也支持从本机 `~/.codex/auth.json` 读取账号模式认证。
- 本地 SQLite 保存账号、额度快照、认证状态和应用配置。
- 展示 5 小时和 7 天额度窗口，并支持手动、定时和额度重置后的自动刷新。
- 本地 OpenAI 兼容网关，默认监听 `8436`，应用端口为 `8435`。
- 根据账号启用状态、套餐有效期和额度动态选择可用账号；遇到额度或限流错误时刷新账号信息并重试切换。
- 支持 Codex 认证管理，可在网关模式和账号模式之间切换。
- 支持写入 `~/.codex/auth.json`，并按需维护 `~/.codex/config.toml` provider。
- 记录调用 token 用量，包括输入、缓存输入、实际输入提示、输出和总 token。
- 调用记录支持按时间范围、会话 ID 和账号统计卡筛选，账号和会话 ID 可点击复制。
- 记录应用运行日志，例如启动识别认证模式、刷新账号、启停网关、认证写入和异常。
- 应用配置支持清空调用记录和运行日志。
- 支持关闭窗口时退出应用或最小化到托盘；托盘菜单支持启停网关和退出应用。
- 记忆窗口大小和位置，支持启动时自动启动网关。

### 支持的网关入口

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/chat/completions`
- `POST /v1/messages/count_tokens`
- `POST /v1/images/generations`
- `POST /v1/images/edits`

网关会透传客户端请求头，并仅替换上游调用所需的 `Authorization` 和 `ChatGPT-Account-ID`。`/v1/chat/completions` 和图片接口会被转换到 Codex Responses 链路；`count_tokens` 直接转发到上游，失败则按上游结果返回。

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

### Codex CLI 接入

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

### Project Status

该项目仍在快速迭代，网关兼容逻辑会跟随 Codex CLI 和上游接口变化调整。建议升级后先用非关键任务验证认证写入、额度刷新和常用请求路径。

### License

MIT

## English

Codex Gateway is a local desktop app built with Electron, React, and Vite. It manages multiple ChatGPT/Codex accounts and exposes a transparent local OpenAI-compatible gateway for Codex CLI and other compatible clients. It is designed for personal local usage: account login, quota refresh, Codex auth writes, request forwarding, and token usage records live in one desktop app.

### Features

- Browser-based ChatGPT/Codex OAuth login without manually entering tokens; local import from `~/.codex/auth.json` is also supported for account-mode auth.
- Local SQLite storage for accounts, quota snapshots, authentication state, and app settings.
- 5-hour and 7-day quota windows with manual, scheduled, and quota-reset refresh.
- Local OpenAI-compatible gateway, using app port `8435` and gateway port `8436` by default.
- Dynamic account selection based on enablement, subscription validity, and quota availability; quota/rate-limit failures trigger refresh and failover.
- Codex authentication management with gateway mode and account mode.
- Writes `~/.codex/auth.json` and maintains the `~/.codex/config.toml` provider when needed.
- Token usage records for input, cached input, actual-input hover hints, output, and total tokens.
- Call records support date range, session ID, and account-stat-card filters; account names and session IDs can be clicked to copy.
- Application runtime logs for startup auth detection, account refresh, gateway start/stop, auth writes, and failures.
- App settings include clearing call records and runtime logs.
- Close-to-tray support with tray actions for starting/stopping the gateway and exiting the app.
- Window size and position persistence, plus optional gateway auto-start.

### Gateway Endpoints

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/chat/completions`
- `POST /v1/messages/count_tokens`
- `POST /v1/images/generations`
- `POST /v1/images/edits`

The gateway passes through client headers and only replaces the upstream `Authorization` and `ChatGPT-Account-ID` headers. `/v1/chat/completions` and image endpoints are adapted to the Codex Responses path; `count_tokens` is forwarded upstream and upstream failures are returned as-is.

### Development

```bash
npm install
npm run dev
```

Development URL:

```text
http://127.0.0.1:8435
```

### Verification

```bash
npm test
npm run build
```

### Packaging

Create an unpacked package:

```bash
npm run pack:unpacked
```

Output directory:

```text
release/win-unpacked
```

Windows executable:

```text
release/win-unpacked/Codex Gateway.exe
```

### Codex CLI Integration

The `Auth Management` page supports two modes:

- Gateway mode: writes `OPENAI_API_KEY` to `~/.codex/auth.json` and adds the provider config to `~/.codex/config.toml` when missing.
- Account mode: writes the selected local account token to `~/.codex/auth.json` and removes the `codex_gateway` provider written by this app.

Manual client configuration:

```text
OPENAI_BASE_URL=http://localhost:8436/v1
OPENAI_API_KEY=local-personal-token
```

The local API key can be changed in app settings.

### Data Directory

Default local data:

```text
data/codex-gateway.sqlite
data/browser
```

SQLite stores accounts, quota snapshots, call records, runtime logs, and app settings. The actual data directory and database path are shown in the app settings page.

### Security Notes

Account tokens and the local API key are stored only on your machine. Do not commit `data/`, `~/.codex/auth.json`, `~/.codex/config.toml`, or any file containing tokens. This project targets personal local usage and does not provide multi-tenant isolation beyond the local gateway API key.

### Project Status

This project is still moving quickly. Gateway compatibility may change with Codex CLI and upstream API behavior. After upgrading, verify auth writes, quota refresh, and your common request paths before relying on it for critical work.

### License

MIT
