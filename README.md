# Codex Gateway

[中文文档](README_zh.md)

Codex Gateway is a Windows desktop app for managing Codex accounts and model channels in one place.

![Codex Gateway overview](docs/screenshots/overview.png)

## What You Can Do

- Add ChatGPT subscription accounts and view their five-hour and seven-day quotas.
- Add Responses API model channels such as DeepSeek-compatible services.
- Use bundled Codex models and third-party models from the Codex model picker.
- Set input, cached-input, and output prices for each model.
- Start and stop Codex Gateway and MCP Gateway.
- Review requests, token usage, latency, estimated cost, and runtime errors.
- Switch between light and dark themes.

## Get Started

1. Open `Codex Gateway.exe`.
2. Add a subscription account from **Subscription Accounts**.
3. Add any third-party service from **Model Channels**.
4. Open **Access Mode** and apply Gateway mode.
5. Start Codex Gateway from **Services**.
6. Select the model you want in Codex.

Gateway mode lets Codex use both subscription accounts and configured model channels. Account mode connects Codex directly to one selected subscription account.

## Subscription Accounts

You can sign in through the browser or import the account currently used by Codex. The account list shows availability, quota windows, refresh time, and reset credits.

Accounts can be enabled, disabled, refreshed, or removed. Automatic quota refresh is configured under **Settings > Accounts and Quotas**.

In the account detail's **Reset credits** list, every available reset credit has a **Use** button: it consumes the selected credit through `rate-limit-reset-credits/consume`, then re-fetches quota and reset credits from the server after a successful reset.

Scheduled refresh also updates the balance of API channels that have a balance query configured; channels without one are skipped automatically.

## Model Channels

Each third-party channel requires:

- A name, API address, and API key.
- The channel's Codex `models.json` content.
- Whether the channel supports Responses WebSocket.
- Whether remote compaction adaptation is enabled (enabled by default).
- Optional custom headers, balance lookup, and per-model prices.

Model IDs must be unique across all channels. Codex uses the selected model ID to choose its channel.

The model JSON also tells Codex which tools, MCP features, input types, and reasoning levels the model supports. Use the metadata supplied by the model provider.

If a channel does not support WebSocket, leave **Supports WS** disabled. Codex requests for that channel will use HTTP.

**Remote compaction adaptation** solves the issue of third-party models that may not support remote compaction. Channels with native compaction support can turn this switch off.

Codex auto review always sends the fixed `codex-auto-review` model ID. Under **Settings > Accounts and Quotas**, you can select a third-party channel model for it: when the subscription account pool has no usable quota, the gateway routes the auto review request to that channel model. Leave it empty to fail the request when the pool is unavailable.

By default, when the model currently selected in Codex only supports HTTP, the gateway returns 426 while the new WebSocket connection is being created so Codex falls back to HTTP immediately instead of waiting for the first request. You can disable this under **Settings > Network** with **Reject HTTP-only models on WebSocket handshake**.

## MCP Gateway

Codex Gateway can manage a local [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway). Configure its file path and address under **Settings > MCP Integration**, then start it from **Services**.

## Data

Application data is stored beside the packaged app in `data/`. The **Settings > Storage and Maintenance** page shows the exact location and provides controls for clearing request and runtime logs.

Back up the `data/` directory before moving the app or making major changes. Do not share it because it contains account and channel configuration.

## Development

Node.js 24 is required.

```bash
npm install
npm run dev
npm run verify
```

Create the Windows unpacked build with:

```bash
npm run pack:unpacked
```

The output is `release/win-unpacked/Codex Gateway.exe`. The app is not code-signed and no installer is included.

## Usage Notice

This project is intended for personal local development. Use your own accounts and API keys, and follow the terms of each service provider. Do not use it for account sharing, resale, or bypassing service restrictions.

## License

MIT. See [LICENSE](LICENSE).
