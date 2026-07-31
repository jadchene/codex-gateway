# Codex Gateway

[English README](README.md)

Codex Gateway 是面向个人本地开发的 Codex 桌面网关，用于统一管理 ChatGPT 订阅账号、Responses API 模型渠道、Codex CLI 接入、本地 MCP Gateway、调用分析与运行日志。

应用基于 Electron 43、React 19、TypeScript、Ant Design 6、Vite 和本地 SQLite。账号 Token、API Key 与 OAuth PKCE verifier 只在主进程中处理，并通过 Electron `safeStorage` 加密；渲染进程只能读取脱敏状态和指纹。

![Codex Gateway 概览](docs/screenshots/overview.png)

## 主要能力

- 通过浏览器 OAuth 添加 ChatGPT 订阅账号，或导入本机 Codex 认证。
- 展示 5 小时、7 天额度窗口和 reset credits，支持手动、定时与启动刷新。
- 配置多个 Responses API 兼容渠道，每个模型 ID 唯一归属一个渠道。
- 合并 Codex 内置模型元数据与第三方模型元数据，让用户直接在 Codex 中选择模型。
- 为每个模型独立配置 input、cached input、output 三项每百万 Token 费率，并统一选择计费币种。
- 同时代理 HTTP/SSE 与原生 Responses WebSocket，不实现 WS-to-HTTP 转换。
- 启停 Codex Gateway 与外部 `mcp-gateway-service`，并按设置在应用启动时自动拉起。
- 查看渠道、模型、Token、耗时、状态和估算费用；调用日志行点击即可查看详情。
- 使用 Ant Design 组件、响应式表格、固定操作列、浅色/深色主题和可折叠菜单。
- 默认启用单实例协调，防止重复启动同一应用实例。

## 使用流程

1. 在“订阅账号”中登录或导入账号。
2. 如需第三方模型，在“模型渠道”中填写 Base URL、API Key 和该渠道的 Codex 模型 JSON。
3. 为 JSON 中的每个模型设置三项费率，声明该渠道是否原生支持 WebSocket，然后保存。
4. 在“接入模式”中应用网关模式。
5. 在 Codex 中直接选择内置或第三方模型。请求中的模型 ID 决定唯一渠道。

网关不做模型别名映射、渠道优先级或跨渠道 fallback。第三方模型 ID 不能与 Codex 内置模型或其他已配置渠道重复；冲突会在保存或目录重建时明确报错。

## 模型目录

网关模式会在数据目录生成：

```text
data/codex-bundled-models.json
data/models.json
```

`codex-bundled-models.json` 是 `codex debug models --bundled` 的本地缓存；`models.json` 是内置模型与所有已启用第三方模型的组合目录。Codex 的 `config.toml` 会通过 `model_catalog_json` 指向 `data/models.json`，路径按实际数据目录生成，不是写死的用户目录。

刷新规则：

- 应用启动时运行一次 `codex debug models --bundled` 并更新缓存；失败时可使用已有缓存继续启动。
- 新增、修改、启用、停用或删除模型渠道时，直接基于缓存重建组合目录。
- Gateway 重启只校验并重建组合目录，不重复运行 Codex debug。
- 内置账号池提供“刷新内置模型”操作，用于手动获取最新 Codex 目录。
- 首次运行且没有可用缓存时，内置目录获取失败会明确报错。

第三方渠道必须提供完整的 Codex 模型元数据，而不是只填写模型名称。最小结构为：

```json
{
  "models": [
    {
      "slug": "provider-model-id",
      "display_name": "Provider Model",
      "supported_reasoning_levels": [
        { "effort": "high", "description": "High reasoning" }
      ]
    }
  ]
}
```

shell、freeform `apply_patch`、并行工具调用、MCP 和推理档位等能力由每个模型的 JSON 元数据声明。应用保留这些字段，并用渠道的“支持 WebSocket”设置覆盖模型的 `prefer_websockets`，同时写入兼容字段 `supports_websockets`，让 Codex 在模型不支持 WS 时直接使用 HTTP。

## 模型渠道与计费

每个 Responses API 渠道可以配置：

- 名称、Base URL、Bearer API Key、启用状态；
- 是否原生支持 Responses WebSocket；
- 普通请求头与加密机密请求头；
- 完整 Codex 模型 JSON；
- JSON 中每个模型独立的 input、cached input、output 费率；
- 可选余额查询方式。

“连接检查”读取标准 `/models` 端点，不发送 Responses 请求。“调用测试”会向指定模型发送最小 Responses 请求，可能产生费用，因此会单独确认。API Key 与机密请求头保存后不回显，也不会写入日志或 Codex 配置。

当前内置余额方法使用 DeepSeek 官方 `GET /user/balance` 协议。其他渠道可选择“不查询”。内置订阅账号池展示可用账号数、总账号数与 reset credits 汇总。

全局只配置币种，不配置全局或渠道级计费系数。所有模型均保存三项独立费率，调用分析按实际请求模型估算费用。

## 请求选择与 WebSocket

HTTP/SSE 请求从请求体读取 `model`：属于已启用第三方渠道时直接调用该渠道，否则进入内置 ChatGPT 订阅账号池。订阅账号池内部仍遵守账号可用性、额度、优先级和会话/Turn 亲和规则。

第三方渠道不会收到客户端携带的 OpenAI、ChatGPT、Codex、会话或账号池请求头，也不会把上游返回的同类响应头透传给客户端。为避免 Codex 将第三方 API 误判为账号池额度不足，网关只合成 5 小时和 7 天均剩余 100% 的额度信息；“订阅账号池额度响应头”设置仅控制账号池真实额度的屏蔽或汇总重写。

`WS /v1/responses` 在本地握手成功后等待首个 `response.create`，再按其中的精确模型 ID 建立对应上游连接，并将该连接绑定到首个模型和渠道。第三方渠道未声明 WebSocket 支持时，组合模型目录会把 `prefer_websockets` 设为 `false`，Codex 应直接选择 HTTP；若客户端仍发起 WS，或者同一连接后续更换模型或渠道，网关会在转发前以 1012 关闭本地连接，让 Codex 按当前模型目录重新连接。网关不做 WS-to-HTTP 转换，也不会把请求发往旧渠道。

## 本地 Gateway API

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/memories/trace_summarize`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/realtime/calls`
- `WS /v1/responses`
- `WS /v1/realtime`

生产默认地址为 `http://localhost:8436/v1`。首次运行会生成随机本地 API Key；非回环监听要求至少 24 个字符的强 Key，并应限制主机防火墙范围。

## 接入模式

“接入模式”支持：

- 网关模式：写入本地 `OPENAI_API_KEY`、`codex_gateway` provider 和组合模型目录路径。
- 账号模式：写入选中订阅账号的认证，并移除本应用管理的 gateway provider 与模型目录配置。

核心网关配置如下：

```toml
model_provider = "codex_gateway"
model_catalog_json = "<data-dir>/models.json"

[model_providers.codex_gateway]
name = "OpenAI"
base_url = "http://localhost:8436/v1"
wire_api = "responses"
supports_websockets = true
```

`auth.json` 与 `config.toml` 使用同一事务写入，最终验证失败时一起回滚；页面预览和检测结果均经过脱敏。

## MCP Gateway

应用以 Streamable HTTP 模式管理外部 [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway)：

```text
mcp-gateway-service --http --config ./config.json --host 127.0.0.1 --port 3000 --path /mcp
```

进程不经过命令 shell 启动。Windows 下会解析 npm shim，并在停止时终止进程树。

## 本地数据与升级

正式版默认数据目录：

```text
data/codex-gateway.sqlite
data/codex-bundled-models.json
data/models.json
data/browser
data/backups
```

SQLite 保存账号、额度、模型渠道、模型费率、调用记录、运行日志与设置。当前 schema 为 v3。旧数据库升级前会 checkpoint WAL、通过 `VACUUM INTO` 创建一致性备份并执行完整性检查；失败时回滚并保留原库与备份。

不要提交 `data/`、Codex 配置或任何包含 Token/API Key 的文件。

## 开发与验证

开发环境要求 Node.js 24：

```bash
npm install
npm run dev
```

隔离开发模式使用 `.runtime/v1-dev` 数据和独立端口，但仍保留单实例协调以及按设置自动启动 Gateway/MCP。它不会读取正式版数据或当前用户的 Codex 凭据。

```bash
npm run verify
npm run pack:unpacked
npm run smoke:unpacked
npm run smoke:unpacked:upgrade
```

`verify` 包含源码规则、TypeScript 检查、Vitest 和 main/preload/renderer 构建。`zod` 打入 main bundle，构建审计会检查运行时依赖边界。

## 打包

```bash
npm run pack:unpacked
```

输出：

```text
release/win-unpacked/Codex Gateway.exe
```

产物默认启用单实例协调；当 `auto_start_gateway` 或 `auto_start_mcp_gateway` 设置为启用时，应用启动会自动拉起对应服务。本项目不包含代码签名或安装器。

## 安全与条款

本项目仅用于学习和个人本地开发。用户必须遵守相关平台服务条款。项目不提供或分发账号、API Key、账号即服务或代理服务；不要用于多人共享、商业转售、绕过平台限制或其他违规用途。

## License

MIT. See [LICENSE](LICENSE).
