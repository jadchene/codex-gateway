# Codex Gateway

**Disclaimer**: This project is strictly for learning and development purposes. Users must comply with the Terms of Service of the respective platforms. This project is designed for personal, local use only. Exposing the service to multiple users or engaging in any form of commercial resale is strictly prohibited. I do not provide or distribute any accounts, API Keys, or proxy services, nor do I assume any responsibility for how this software is utilized. Please do not use this project to bypass rate limits or other service restrictions.

Personal Codex account manager and transparent local gateway.

Codex Gateway is a local desktop app built with Electron, React, and Vite. It manages multiple ChatGPT/Codex accounts and exposes a transparent local OpenAI-compatible gateway for Codex CLI and other compatible clients. It is designed for personal local usage: account login, quota refresh, Codex auth writes, request forwarding, and token usage records live in one desktop app.

### Features

- Browser-based ChatGPT/Codex OAuth login without manually entering tokens; local import from `~/.codex/auth.json` is also supported for account-mode auth.
- Local SQLite storage for accounts, quota snapshots, authentication state, and app settings.
- 5-hour and 7-day quota windows with manual, scheduled, and quota-reset refresh.
- Local OpenAI-compatible gateway, using app port `8435` and gateway port `8436` by default.
- Dynamic account selection based on enablement, subscription validity, and quota availability; quota/rate-limit failures trigger refresh and failover.
- Codex authentication management with gateway mode and account mode.
- Writes `~/.codex/auth.json` and maintains the `~/.codex/config.toml` provider when needed.
- Token usage records for input, cached input, actual-input hover hints, output, and total tokens.
- Call records support date range, session ID, and account-stat-card filters; account names and session IDs can be clicked to copy.
- Application runtime logs for startup auth detection, account refresh, gateway start/stop, auth writes, and failures.
- App settings include clearing call records and runtime logs.
- Close-to-tray support with tray actions for starting/stopping the gateway and exiting the app.
- Window size and position persistence, plus optional gateway auto-start.

### Gateway Endpoints

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`

The gateway passes through client headers and only replaces the upstream `Authorization` and `ChatGPT-Account-ID` headers.

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

Windows executable:

```text
release/win-unpacked/Codex Gateway.exe
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

SQLite stores accounts, quota snapshots, call records, runtime logs, and app settings. The actual data directory and database path are shown in the app settings page.

### Security Notes

Account tokens and the local API key are stored only on your machine. Do not commit `data/`, `~/.codex/auth.json`, `~/.codex/config.toml`, or any file containing tokens. This project targets personal local usage and does not provide multi-tenant isolation beyond the local gateway API key.

### Project Status

This project is still moving quickly. Gateway compatibility may change with Codex CLI and upstream API behavior. After upgrading, verify auth writes, quota refresh, and your common request paths before relying on it for critical work.

### License

MIT
