# Codex Gateway

[English README](README.md)

## 项目介绍

Codex Gateway 是一个 Windows 桌面应用，用于在 Codex 中集中使用 ChatGPT 订阅账号和第三方模型渠道。

![Codex Gateway 概览](docs/screenshots/overview.png)

## 为什么使用

- 直接在 Codex 的模型列表中切换订阅模型和第三方模型。
- 集中查看账号额度、渠道余额、调用量、耗时和估算费用。
- 账号与渠道配置保存在应用旁边的本地 `data/` 目录中。
- 在一个界面中管理 Codex Gateway 和可选的 MCP Gateway。

## 快速开始

1. 打开 `Codex Gateway.exe`。
2. 添加 ChatGPT 订阅账号、模型渠道，或同时添加两者。
3. 打开“接入模式”并应用网关模式。
4. 在“服务管理”中启动 Codex Gateway。
5. 回到 Codex 选择模型。

网关模式可以同时使用订阅模型和第三方模型；账号模式则让 Codex 直接连接一个选中的订阅账号。

## 功能与设置

### 订阅账号

可以通过浏览器登录，也可以导入 Codex 当前使用的账号。应用支持查看额度和重置次数、刷新账号、启用或停用账号、使用可用的重置次数，以及删除账号。

### 模型渠道

每个 Responses API 渠道支持以下设置：

- 渠道名称、API 地址、API Key 和启用状态。
- 渠道提供的 Codex `models.json`；不同渠道的模型 ID 不能重复。
- WebSocket 支持；仅支持 HTTP 的渠道应保持关闭。
- 远程压缩适配；除非渠道明确支持 Codex 原生压缩，否则建议保持开启。
- 可选的余额查询、普通或加密请求头，以及各模型的输入、缓存输入和输出费率。

使用渠道前，可以查看导入的模型目录并运行调用测试。

### 服务与 MCP Gateway

“服务管理”用于启动和停止 Codex Gateway，以及可选的 [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway)。启动 MCP Gateway 前，需要先配置文件路径和服务地址。

### 设置

| 区域 | 可配置内容 |
| --- | --- |
| 常规 | 开机自启、关闭窗口时的行为，以及账号选择是否忽略 5 小时额度窗口。 |
| 外观 | 浅色、深色或跟随系统主题，以及舒适或紧凑的界面密度。 |
| Codex Gateway | 监听地址、端口、本地 API Key、服务自动启动和 Codex 连接方式。 |
| 账号与额度 | 自动刷新间隔、刷新超时、额度冷却、额度显示，以及自动审查使用的可选第三方回退模型。 |
| 日志与计费 | 调用记录保留时间、运行日志保留时间和计费币种。 |
| MCP Gateway | 自动启动、配置文件路径、主机、端口和 HTTP 路径。 |
| 存储 | 当前数据位置，以及清空调用记录或运行日志。 |
| 高级网络 | 连接和空闲超时、请求超时、停机宽限、HTTP 与 WebSocket 数量限制、请求与缓冲区大小限制，以及仅支持 HTTP 的模型自动回退。日常使用建议保持默认值。 |

部分服务设置需要重启对应服务后生效。

### 数据与备份

正式版数据保存在应用旁边的 `data/` 目录中。移动或替换应用前请备份该目录。目录中包含账号和渠道配置，请勿分享。

本项目用于个人本地使用。请使用自己的账号和 API Key，并遵守各服务提供方的条款。

## 开发

需要 Node.js 24 或更高版本。

```bash
npm install
npm run dev
npm run verify
```

生成 Windows 免安装包：

```bash
npm run pack:unpacked
```

输出文件为 `release/win-unpacked/Codex Gateway.exe`。该程序未进行代码签名，也不包含安装器。

## License

MIT. See [LICENSE](LICENSE).
