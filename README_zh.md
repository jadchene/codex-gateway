# Codex Gateway

[English README](README.md)

Codex Gateway 是一个 Windows 桌面应用，用于集中管理 Codex 的订阅账号和第三方模型渠道。

![Codex Gateway 概览](docs/screenshots/overview.png)

## 可以做什么

- 添加 ChatGPT 订阅账号，查看 5 小时和 7 天额度。
- 添加 DeepSeek 等兼容 Responses API 的模型渠道。
- 在 Codex 中直接选择内置模型或第三方模型。
- 为每个模型分别设置输入、缓存输入和输出费率。
- 启动和停止 Codex Gateway 与 MCP Gateway。
- 查看调用记录、Token、耗时、估算费用和运行错误。
- 使用浅色或深色主题。

## 开始使用

1. 打开 `Codex Gateway.exe`。
2. 在“订阅账号”中添加账号。
3. 如需第三方模型，在“模型渠道”中添加渠道。
4. 在“接入模式”中应用网关模式。
5. 在“服务管理”中启动 Codex Gateway。
6. 回到 Codex 选择需要使用的模型。

网关模式可以同时使用订阅账号和已配置的模型渠道。账号模式则让 Codex 直接使用一个选中的订阅账号。

## 订阅账号

可以通过浏览器登录新账号，也可以导入当前 Codex 已登录的账号。账号列表会显示可用状态、额度、刷新时间和重置次数。

账号支持启用、停用、刷新和删除。自动刷新间隔可在“设置中心 > 账号与额度”中调整。

## 模型渠道

添加第三方渠道时需要填写：

- 渠道名称、API 地址和 API Key；
- 渠道提供的 Codex `models.json` 内容；
- 渠道是否支持 Responses WebSocket；
- 可选的请求头、余额查询方式和模型费率。

所有渠道的模型 ID 必须唯一。Codex 会根据当前选择的模型确定请求渠道。

模型 JSON 还会告诉 Codex 该模型支持哪些工具、MCP 功能、输入类型和推理档位，请使用模型提供方给出的元数据。

如果渠道不支持 WebSocket，请关闭“支持 WS”。该渠道的 Codex 请求会使用 HTTP。

## MCP Gateway

应用可以管理本地 [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway)。在“设置中心 > MCP 集成”中填写配置文件和服务地址，然后到“服务管理”启动服务。

## 本地数据

正式版数据保存在应用旁边的 `data/` 目录中。“设置中心 > 存储与维护”会显示实际路径，并提供清空调用记录和运行日志的操作。

移动应用或进行较大调整前，建议备份整个 `data/` 目录。该目录包含账号和渠道配置，请不要分享。

## 开发与打包

开发环境需要 Node.js 24：

```bash
npm install
npm run dev
npm run verify
```

生成 Windows 免安装包：

```bash
npm run pack:unpacked
```

输出文件为 `release/win-unpacked/Codex Gateway.exe`。当前不包含代码签名和安装器。

## 使用说明

本项目用于个人本地开发。请使用自己的账号和 API Key，并遵守各服务提供方的条款。不要用于账号共享、商业转售或绕过服务限制。

## License

MIT. See [LICENSE](LICENSE).
