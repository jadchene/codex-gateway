# Codex Gateway

[English README](README.md)

**免责声明**：本项目仅用于学习和本地开发测试。使用者必须遵守相关平台的服务条款。本项目只面向个人本机使用，不提供、不分发任何账号、API Key 或代理服务，也不应被用于多用户共享、商业转售、规避限制或其它违反服务条款的用途。请自行承担使用风险。

Codex Gateway 是一个本地桌面应用，用于管理个人的 Codex/ChatGPT 登录状态、查看额度信息，并为 Codex 提供一个本机网关入口。应用基于 Electron、React 和 Vite 构建，数据保存在本机 SQLite。

### 功能

- **仪表盘**：查看网关状态、可用账号数量和今日 token 使用统计。
- **账号管理**：通过浏览器 OAuth 添加账号，查看 5 小时和 7 天额度窗口，支持手动刷新和定时刷新。
- **认证管理**：在网关模式和账号模式之间切换，并写入 `~/.codex/auth.json`、`~/.codex/config.toml`。
- **本地网关**：只暴露 Codex 常用的 `/v1/models`、`/v1/responses`、`/v1/responses/compact`。
- **调用记录**：记录请求路径、账号、会话 ID、耗时和 token 使用情况，支持按日期、会话 ID 和账号统计卡筛选。
- **运行日志**：记录应用启动、认证写入、账号刷新、网关启停和异常。
- **应用配置**：配置本地端口、API Key、刷新间隔、关闭行为，并支持清空本地调用记录和运行日志。

### 关于账号使用

网关每次请求只会选择一个当前可用的账号发起上游调用。只有当该账号返回认证失效、额度或限流等错误时，应用才会刷新本地额度信息，并按顺序尝试下一个可用账号完成当前请求。

这个机制用于个人本地开发时减少手动切换账号配置的操作，不应被理解为并发调度、资源池聚合、额度叠加或绕过服务限制。

### 网关接口

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`

网关会透传客户端请求头，并仅替换上游调用所需的 `Authorization` 和 `ChatGPT-Account-ID`。图片接口不受支持。

### 开发

```bash
npm install
npm run dev
```

开发地址：

```text
http://127.0.0.1:8435
```

### 验证

```bash
npm test
npm run build
```

### 打包

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

认证管理页面支持两种模式：

- **网关模式**：向 `~/.codex/auth.json` 写入本地 `OPENAI_API_KEY`，并在需要时写入 `codex_gateway` provider。
- **账号模式**：把选中的本地账号 token 写入 `~/.codex/auth.json`，并移除本应用写入的 `codex_gateway` provider。

手动配置示例：

```text
OPENAI_BASE_URL=http://localhost:8436/v1
OPENAI_API_KEY=local-personal-token
```

本地 API Key 可在应用配置中修改。

### 本地数据

默认数据位置：

```text
data/codex-gateway.sqlite
data/browser
```

SQLite 会保存账号信息、额度快照、调用记录、运行日志和应用配置。请不要提交 `data/`、`~/.codex/auth.json`、`~/.codex/config.toml` 或任何包含 token 的文件。

### License

MIT
