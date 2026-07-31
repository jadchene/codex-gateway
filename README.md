# Codex Gateway

[中文文档](README_zh.md)

Codex Gateway is a local desktop gateway for personal Codex development. It manages ChatGPT subscription accounts, Responses API model channels, Codex CLI integration, a local MCP Gateway process, analytics, and runtime logs.

The app uses Electron 43, React 19, TypeScript, Ant Design 6, Vite, and local SQLite. Account tokens, API keys, and OAuth PKCE verifiers remain in the main process and are encrypted through Electron `safeStorage`; the renderer only receives redacted status and fingerprints.

![Codex Gateway overview](docs/screenshots/overview.png)

## Features

- Add ChatGPT subscription accounts through browser OAuth or local Codex auth import.
- Track five-hour and seven-day quota windows and reset credits.
- Configure multiple Responses API-compatible model channels with unique model ownership.
- Merge bundled Codex model metadata with third-party model metadata so models can be selected directly in Codex.
- Configure independent input, cached-input, and output rates for every model with one global currency.
- Proxy HTTP/SSE and native Responses WebSocket without a WS-to-HTTP adapter.
- Manage Codex Gateway and `mcp-gateway-service`, including settings-controlled startup auto-launch.
- Inspect channel, model, token, latency, status, and estimated-cost data in responsive tables with fixed action columns.
- Use Ant Design components, local fonts, light/dark themes, and collapsible navigation.
- Keep production and development profiles under single-instance coordination.

## Workflow

1. Sign in or import a subscription account.
2. Add a model channel with its base URL, API key, and Codex model JSON.
3. Configure three rates per model and declare native WebSocket support.
4. Apply Gateway mode under Codex Integration.
5. Select a bundled or third-party model directly in Codex. The exact model ID determines its only channel.

There are no model aliases, cross-channel priorities, or cross-channel fallbacks. A third-party model ID cannot collide with a bundled model or another configured channel.

## Model Catalog

Gateway mode uses two generated files under the actual data directory:

```text
data/codex-bundled-models.json
data/models.json
```

The first caches `codex debug models --bundled`. The second combines bundled models with enabled third-party models and is referenced by Codex through `model_catalog_json`; the absolute path is generated from the runtime data directory rather than a hard-coded user path.

- App startup refreshes bundled metadata once and may use the existing cache if Codex debug fails.
- Channel changes rebuild the combined catalog from the cache.
- Gateway restart validates and rebuilds the catalog without rerunning Codex debug.
- The built-in account pool provides a manual bundled-model refresh action.
- A first run without a usable cache reports a clear error when bundled discovery fails.

Third-party channels must provide complete Codex model metadata, not only model names:

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

Shell, freeform `apply_patch`, parallel tool calls, MCP, and reasoning levels are described by each model object. The app preserves those fields, overwrites `prefer_websockets` from the channel setting, and mirrors the value to the compatibility field `supports_websockets` so Codex can choose HTTP when that model has no native WS support.

## Channels and Billing

Each Responses API channel has a name, base URL, Bearer API key, enabled state, native WebSocket flag, public and encrypted secret headers, complete Codex model JSON, per-model rates, and an optional balance method.

Connectivity Check reads the standard `/models` endpoint without creating a Responses request. Invocation Test sends a minimal request and has a separate billing confirmation. Secrets are not read back into the renderer or written to logs and Codex configuration.

The built-in balance method follows DeepSeek's official `GET /user/balance` response. Other channels may disable balance lookup. The subscription pool displays usable/total account counts and aggregate reset credits.

Only currency is global. There are no global or channel-level cost factors; estimates use the three rates stored on the actual request model.

## Request Selection and WebSocket

HTTP/SSE reads `model` from the request body. An enabled third-party owner is called directly; all other model IDs use the built-in ChatGPT subscription pool. Account availability, quota, priority, and session/turn affinity remain internal to that pool.

Third-party channels do not receive client OpenAI, ChatGPT, Codex, session, or subscription-account headers, and equivalent upstream response headers are not forwarded. The gateway only synthesizes fully available five-hour and seven-day quota windows so Codex does not mistake an API channel for an exhausted subscription pool. The subscription-pool quota-header setting controls only blocking or aggregate rewriting for the built-in pool.

`WS /v1/responses` accepts the local connection, waits for the first `response.create`, opens the exact upstream selected by its model ID, and binds that connection to the initial model and channel. A channel without WS support writes `prefer_websockets: false` into the combined model catalog so Codex should use HTTP directly. If the client still opens WS, or changes model/channel on an established connection, the gateway closes the local connection with code 1012 before forwarding so Codex can reconnect using the current catalog. The gateway does not translate WS to HTTP or forward the request to the old channel.

## Codex CLI Integration

Gateway mode writes the local key, `codex_gateway` provider, and combined catalog path. Account mode writes the selected subscription credential and removes app-managed gateway/catalog settings.

```toml
model_provider = "codex_gateway"
model_catalog_json = "<data-dir>/models.json"

[model_providers.codex_gateway]
name = "OpenAI"
base_url = "http://localhost:8436/v1"
wire_api = "responses"
supports_websockets = true
```

`auth.json` and `config.toml` are written transactionally and rolled back together if verification fails.

## Local Gateway API

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `POST /v1/memories/trace_summarize`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/realtime/calls`
- `WS /v1/responses`
- `WS /v1/realtime`

The production default is `http://localhost:8436/v1`, protected by a generated local API key.

## MCP Gateway

The app manages external [`mcp-gateway-service`](https://github.com/jadchene/mcp-gateway) in Streamable HTTP mode:

```text
mcp-gateway-service --http --config ./config.json --host 127.0.0.1 --port 3000 --path /mcp
```

The process is launched without a command shell. Windows npm shims are resolved to their Node.js entry points, and stop operations terminate the process tree.

## Data and Upgrades

```text
data/codex-gateway.sqlite
data/codex-bundled-models.json
data/models.json
data/browser
data/backups
```

SQLite schema v3 stores accounts, quotas, channels, per-model rates, request history, runtime logs, and settings. Upgrades checkpoint WAL, create a consistent `VACUUM INTO` backup, and run integrity checks before migration.

Never commit `data/`, Codex configuration, tokens, or API keys.

## Development and Packaging

Node.js 24 is required.

```bash
npm install
npm run verify
npm run pack:unpacked
```

The isolated development profile uses `.runtime/v1-dev` and separate ports while retaining single-instance coordination and settings-controlled Gateway/MCP auto-start. It does not read production data or live Codex credentials.

The unpacked output is:

```text
release/win-unpacked/Codex Gateway.exe
```

The build is not code-signed and does not include an installer.

## Safety and Terms

This project is for learning and personal local development. Users must follow applicable platform terms. It does not provide accounts, API keys, accounts-as-a-service, or proxy services and must not be used for multi-user sharing, resale, or restriction bypasses.

## License

MIT. See [LICENSE](LICENSE).
