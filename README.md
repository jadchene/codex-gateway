# Codex Gateway

[中文文档](README_zh.md)

## What This Project Is

Codex Gateway is a Windows desktop app for using ChatGPT subscription accounts and third-party model channels from Codex in one place.

![Codex Gateway overview](docs/screenshots/overview.png)

## Why Use It

- Switch between subscription and third-party models from the Codex model picker.
- View account quotas, channel balances, request usage, latency, and estimated cost.
- Keep account and channel configuration in a local `data/` directory beside the app.
- Manage Codex Gateway and an optional MCP Gateway from one interface.

## Quick Start

1. Open `Codex Gateway.exe`.
2. Add a ChatGPT subscription account, a model channel, or both.
3. Open **Access Mode** and apply Gateway mode.
4. Start Codex Gateway from **Services**.
5. Return to Codex and select a model.

Gateway mode makes subscription and third-party models available together. Account mode connects Codex directly to one selected subscription account.

## Reference

### Subscription Accounts

Sign in through the browser or import the account currently used by Codex. You can view quota and reset-credit status, refresh an account, enable or disable it, use an available reset credit, or remove the account.

### Model Channels

Each Responses API channel supports the following settings:

- Channel name, API address, API key, and enabled state.
- Provider-supplied Codex `models.json`; model IDs must be unique across channels.
- WebSocket support. Leave it off when the provider supports HTTP only.
- Remote compaction adaptation. Keep it enabled unless the provider explicitly supports native Codex compaction.
- Optional balance lookup, public or encrypted request headers, and per-model input, cached-input, and output prices.

You can inspect the imported model catalog and test a channel before using it in Codex.

### Services and MCP Gateway

The **Services** page starts and stops Codex Gateway and the optional [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway). Configure the MCP Gateway file path and address before starting it.

### Settings

| Area | Available settings |
| --- | --- |
| General | Launch with Windows, window-close behavior, and whether account selection ignores the five-hour quota window. |
| Appearance | Light, dark, or system theme and comfortable or compact density. |
| Codex Gateway | Listening address, port, local API key, automatic service start, and Codex connection method. |
| Accounts and quotas | Refresh interval, refresh timeout, quota cooldown, quota display, and an optional third-party fallback model for auto review. |
| Logs and billing | Request-log retention, runtime-log retention, and billing currency. |
| MCP Gateway | Automatic start, configuration file path, host, port, and HTTP path. |
| Storage | Current data location and controls for clearing request or runtime logs. |
| Advanced network | Connection and idle timeouts, request timeout, shutdown grace period, HTTP and WebSocket limits, payload and buffer limits, and automatic HTTP fallback for HTTP-only models. Defaults are suitable for normal use. |

Some service settings take effect after the corresponding service is restarted.

### Data and Backup

Packaged application data is stored in `data/` beside the app. Back up this directory before moving or replacing the application. Do not share it because it contains account and channel configuration.

This project is intended for personal local use. Use your own accounts and API keys, and follow each provider's terms.

## Development

Node.js 24 or newer is required.

```bash
npm install
npm run dev
npm run verify
```

Create the Windows unpacked build with:

```bash
npm run pack:unpacked
```

The output is `release/win-unpacked/Codex Gateway.exe`. It is not code-signed and does not include an installer.

## License

MIT. See [LICENSE](LICENSE).
