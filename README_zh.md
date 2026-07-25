# Codex Gateway

[English README](README.md)

Codex Gateway 是一个本地桌面应用，用于管理个人 Codex/ChatGPT 登录状态、切换本机 Codex CLI 认证模式、查看额度信息，并运行本地网关服务。

项目基于 Electron、React、Vite 和本地 SQLite 存储构建。它面向个人本地开发场景，把账号、网关状态、Codex CLI 认证文件、请求记录和本地 MCP 网关进程控制集中到一个应用里。

## 功能

- 通过浏览器 OAuth 添加个人账号，或导入已有的本地 Codex auth 文件。
- 查看 5 小时和 7 天额度窗口，支持手动、定时、启动时刷新，并在网关准备返回不可用前透明补刷。
- 在本机 Codex CLI 的网关模式和直接账号模式之间切换。
- 运行面向 Codex 请求的本地 OpenAI-compatible `/v1` 网关。
- 以 Streamable HTTP 模式启动和停止外部 `mcp-gateway-service` 进程。
- 保存网关调用记录，包括路径、上游路径、账号、session ID、耗时、状态和 token 用量。
- 从调用记录中保存、命名、搜索和删除 Codex session ID。
- 查看认证写入、网关事件、用量刷新和失败信息等本地运行日志。
- 配置端口、本地 API key、自启动、托盘行为、显示用计费系数和日志清理。
- 桌面应用仅运行一个实例；再次启动时会唤醒并聚焦已有窗口。

## 为什么使用它

- 不需要手工编辑 `~/.codex/auth.json` 和 `~/.codex/config.toml`，Codex 相关本地状态集中管理。
- 当某个账号出现认证、额度或限流错误时，网关可以尝试下一个可用账号，减少个人开发中的手动切换。
- 请求历史、session 名称、额度快照和运行日志都保存在本地 SQLite。
- Codex 网关和 MCP 网关进程可以在同一个界面里分别控制。

## 快速开始

安装依赖并启动桌面应用：

```bash
npm install
npm run dev
```

渲染进程开发服务器地址：

```text
http://127.0.0.1:8435
```

首次使用流程：

1. 打开应用，在 Accounts 页面添加个人账号。
2. 在 Gateway Services 页面启动 Codex gateway。
3. 在 Auth Management 页面应用 Gateway mode。
4. 正常使用 Codex CLI；它会调用应用写入的本地网关 provider。
5. 需要时在应用里查看额度、调用记录、session 和日志。

## Codex Gateway API

内置网关暴露一组小型 OpenAI-compatible 本地接口：

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/memories/trace_summarize`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/realtime/calls`
- `WS /v1/responses`
- `WS /v1/realtime`（包括携带 `call_id` 的 Realtime sideband 连接）

默认本地配置：

```text
host: localhost
port: 8436
base URL: http://localhost:8436/v1
API key: 首次运行时随机生成
```

API key、监听 host、端口、HTTP 并发/请求体限制、独立的 WebSocket 连接/消息/缓冲限制，以及连接/流式/普通请求/WebSocket 响应空闲超时都可以在应用设置中修改。空闲的 WebSocket 预热连接不会占用 HTTP 请求并发。网关会把请求转发到配置的上游 Codex 后端，替换上游 `Authorization` 和 `ChatGPT-Account-ID`，保留 Codex 应用元数据，并移除逐跳、Cookie 和客户端凭据请求头。

账号路由采用 Session 软亲和与 Turn 强亲和。同一 Codex session 的多个 turn 会优先使用原账号；账号额度耗尽或临时不可用后，下一个尚未绑定的 turn 或新的 WebSocket 握手可以切换账号，并更新该 session 的首选账号。已经携带 `x-codex-turn-state` 的进行中 turn，以及已经建立的 WebSocket 连接，都不会在中途切换账号。客户端断开时会取消上游请求或连接；网关停机时会先取消活动流量，并在配置的宽限期结束后强制关闭残留连接。

额度批量刷新采用 single-flight，最多并行刷新 3 个账号，只有全部启用账号刷新成功后才更新全局刷新时间。冷启动发现额度过期时，应用会先等待补刷，再自动启动网关。如果 HTTP 请求或 WebSocket 握手仍然选不到可用账号，同一个客户端操作会强制刷新并重新选择一次，不需要用户重启应用或手工重新连接。

Responses WebSocket 与 Realtime/sideband WebSocket 均可代理。网关会在客户端侧和上游侧分别协商压缩，保留 Codex 应用请求头与握手元数据，带背压地双向转发文本和二进制消息，传递关闭语义，并记录 WebSocket 响应事件中的 token 用量。

## Codex CLI 认证模式

Auth Management 支持两种模式：

- Gateway mode：向 `~/.codex/auth.json` 写入本地 `OPENAI_API_KEY`，选中 `codex_gateway`，并确保 `~/.codex/config.toml` 中存在该 provider，同时保留其他 provider 块。
- Account mode：把选中的本地账号 token 写入 `~/.codex/auth.json`，并移除本应用写入的 gateway provider。

Gateway provider 示例：

```toml
model_provider = "codex_gateway"

[model_providers.codex_gateway]
name = "OpenAI"
base_url = "http://localhost:8436/v1"
wire_api = "responses"
supports_websockets = true
```

当监听 host 是 `0.0.0.0` 时，生成的 provider URL 仍使用 `localhost`，方便 Codex CLI 连接本地服务。

生成的 provider 默认启用 Responses WebSocket。手工设置 `supports_websockets = false` 后，现有 HTTP/SSE Responses、compact、models、图片和 Realtime call HTTP 路由仍然可用；它只会阻止 Codex CLI 为该 provider 选择 Responses-over-WebSocket。

认证模式切换会先暂存两个文件，写入后校验最终模式；任一写入或校验失败都会同时回滚两个文件。启动时的模式识别是只读操作，不会再隐式修改 Codex 配置。

当 API Key 少于 24 个字符或仍是旧默认值时，应用会拒绝把网关启动到 `0.0.0.0` 或其他非回环地址。非回环监听会让允许访问该网络的设备获得账号代理模型的能力；启用前还应限制主机防火墙的访问范围。

## MCP Gateway 控制

Codex Gateway 可以管理外部 [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway) 进程，并以 Streamable HTTP 模式启动。

默认 MCP gateway 配置：

```text
host: 127.0.0.1
port: 3000
path: /mcp
```

应用生成的命令示例：

```bash
mcp-gateway-service --http --config ./config.json --host 127.0.0.1 --port 3000 --path /mcp --json-response
```

只有填写或启用的选项会被传入。进程启动不经过命令 shell；Windows 下会把 npm 可执行入口解析为对应的 Node.js 脚本。停止 MCP gateway 时会终止进程树，旧进程延迟到达的退出事件也不会覆盖重启后的新进程状态。

## 本地数据

默认本地数据路径：

```text
data/codex-gateway.sqlite
```

SQLite 保持在应用目录旁。Electron 浏览器运行数据使用系统应用数据目录中的 `Codex Gateway` 目录，使从不同安装目录启动的程序共享同一个单实例锁。SQLite 保存账号元数据、额度快照、网关调用记录、session 名称和备注、运行日志以及应用设置。账号 Token 和 OAuth PKCE verifier 在写入前会通过 Electron `safeStorage` 加密。升级后首次启动会迁移已有明文数据，并执行 WAL checkpoint 和数据库压缩。Token 只保留在主进程，不会通过账号 IPC 接口返回给渲染进程。

调用记录默认保留 30 天，运行日志默认保留 14 天，均可配置；过期登录会话保留 7 天。手工清空日志时会压缩数据库，每日自动清理则执行轻量 WAL checkpoint。

不要提交 `data/`、`~/.codex/auth.json`、`~/.codex/config.toml` 或任何包含 token 的文件。

## 开发

运行测试：

```bash
npm test
```

构建渲染端：

```bash
npm run build
```

运行完整校验：

```bash
npm run verify
```

`npm run verify` 会检查 Node 源码语法、执行完整测试并构建渲染端。开发环境要求 Node.js `^20.19.0` 或 `>=22.12.0`。

## 打包

创建 Windows unpacked 构建：

```bash
npm run pack:unpacked
```

输出：

```text
release/win-unpacked/Codex Gateway.exe
```

unpacked 产物只包含最小运行目录和必需的 `ws` 生产依赖，面向个人本地使用，不包含代码签名，也不是安装包。

## 安全与条款

本项目仅用于学习和个人本地开发。用户必须遵守相关平台的服务条款。

项目不提供或分发账号、API key、账号即服务或代理服务。不要将它用于多人共享、商业转售、绕过平台限制，或任何违反服务条款的活动。

## License

MIT. See [LICENSE](LICENSE).
