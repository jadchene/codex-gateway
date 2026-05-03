# Codex Gateway

[中文文档](README_zh.md)

**Disclaimer**: This project is for learning and local development only. Users must comply with the Terms of Service of the relevant platforms. It is intended for personal local use and does not provide or distribute accounts, API keys, or proxy services. It must not be used for multi-user sharing, commercial resale, bypassing limits, or any other activity that violates service terms. Use it at your own risk.

Codex Gateway is a local desktop app for managing personal Codex/ChatGPT login state, viewing quota information, and exposing a local `/v1/responses` gateway for Codex. It is built with Electron, React, and Vite, with local data stored in SQLite.

### Features

- **Dashboard**: View gateway status, available account count, and today's token usage statistics.
- **Accounts**: Add accounts through browser OAuth, view 5-hour and 7-day quota windows, and refresh usage manually or on a schedule.
- **Auth Management**: Switch between gateway mode and account mode, writing `~/.codex/auth.json` and `~/.codex/config.toml` as needed.
- **Local Gateway**: Exposes only the Codex-oriented `/v1/models`, `/v1/responses`, and `/v1/responses/compact` routes.
- **Call Records**: Records request path, account, session ID, duration, and token usage, with filtering by date, session ID, and account summary cards.
- **App Logs**: Tracks startup, auth writes, account refreshes, gateway start/stop events, and failures.
- **Settings**: Configure the local port, API key, refresh interval, close behavior, and clear local call/runtime logs.

### Account Usage Model

For each request, the gateway uses one currently available account for the upstream call. If that account returns an authentication, quota, or rate-limit error, the app refreshes local usage information and then tries the next available account in sequence for that request.

This behavior is intended to reduce manual account-configuration switching during personal local development. It should not be interpreted as concurrent scheduling, resource pooling, quota aggregation, or a way to bypass service restrictions.

### Gateway Endpoints

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`

The gateway passes through client headers and only replaces the upstream `Authorization` and `ChatGPT-Account-ID` headers. Image endpoints are not supported.

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

### Codex Integration

The Auth Management page supports two modes:

- **Gateway mode**: writes a local `OPENAI_API_KEY` to `~/.codex/auth.json` and adds the `codex_gateway` provider when needed.
- **Account mode**: writes the selected local account token to `~/.codex/auth.json` and removes the `codex_gateway` provider written by this app.

Manual configuration example:

```text
OPENAI_BASE_URL=http://localhost:8436/v1
OPENAI_API_KEY=local-personal-token
```

The local API key can be changed in app settings.

### Local Data

Default data paths:

```text
data/codex-gateway.sqlite
data/browser
```

SQLite stores account data, quota snapshots, call records, runtime logs, and app settings. Do not commit `data/`, `~/.codex/auth.json`, `~/.codex/config.toml`, or any file containing tokens.

### License

MIT
