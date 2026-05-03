# Codex Gateway

[中文](#中文) | [English](#english)

## 中文

Codex Gateway 是一个基于 Electron、React 和 Vite 的本地桌面应用，用于管理多个 ChatGPT/Codex 账号，并为 Codex CLI 或其它 OpenAI 兼容客户端提供本地网关。

### 功能特性

- 浏览器 OAuth 登录 ChatGPT/Codex 账号，无需手动填写 token。
- 本地 SQLite 保存账号、额度快照、认证状态和应用配置。
- 展示 5 小时和 7 天额度窗口，并支持手动或定时刷新。
- 本地 OpenAI 兼容网关，默认监听 `8436`，应用端口为 `8435`。
- 根据账号额度动态选择可用账号；遇到额度或限流错误时刷新账号信息并重试切换。
- 支持 Codex 认证管理，可在网关模式和账号模式之间切换。
- 支持写入 `~/.codex/auth.json`，并按需维护 `~/.codex/config.toml` provider。
- 记录调用 token 用量，包括输入、缓存、输出和总 token。
- 记录应用运行日志，例如启动识别认证模式、刷新账号、启停网关和认证写入。
- 记忆窗口大小和位置。

### 支持的网关入口

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/chat/completions`
- `POST /v1/messages/count_tokens`
- `POST /v1/images/generations`
- `POST /v1/images/edits`

`/v1/chat/completions` 和图片接口会被转换到 Codex Responses 链路。

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

### 安全说明

账号 token 和本地 API Key 只保存在本机。请不要提交 `data/`、`~/.codex/auth.json` 或任何包含 token 的文件。

### License

MIT

## English

Codex Gateway is a local desktop app built with Electron, React, and Vite. It manages multiple ChatGPT/Codex accounts and exposes a local OpenAI-compatible gateway for Codex CLI and other compatible clients.

### Features

- Browser-based ChatGPT/Codex OAuth login without manually entering tokens.
- Local SQLite storage for accounts, quota snapshots, authentication state, and app settings.
- 5-hour and 7-day quota windows with manual and scheduled refresh.
- Local OpenAI-compatible gateway, using app port `8435` and gateway port `8436` by default.
- Dynamic account selection based on quota availability; quota/rate-limit failures trigger refresh and failover.
- Codex authentication management with gateway mode and account mode.
- Writes `~/.codex/auth.json` and maintains the `~/.codex/config.toml` provider when needed.
- Token usage records for input, cached input, output, and total tokens.
- Application runtime logs for startup auth detection, account refresh, gateway start/stop, and auth writes.
- Window size and position persistence.

### Gateway Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/chat/completions`
- `POST /v1/messages/count_tokens`
- `POST /v1/images/generations`
- `POST /v1/images/edits`

`/v1/chat/completions` and image endpoints are adapted to the Codex Responses path.

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

### Security Notes

Account tokens and the local API key are stored only on your machine. Do not commit `data/`, `~/.codex/auth.json`, or any file containing tokens.

### License

MIT
