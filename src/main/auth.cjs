const http = require("node:http");
const crypto = require("node:crypto");

const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_ORIGINATOR = "codex_cli_rs";
const LOGIN_HOST = "localhost";
const LOGIN_PORT = 1455;

function createAuthService(store, ensureGatewayStarted, refreshAccountUsage) {
  let loginServer = null;

  async function startLogin() {
    const redirectUri = await ensureLoginServer();
    const pkce = generatePkce();
    const state = generateState();
    store.saveLoginSession({
      id: state,
      code_verifier: pkce.codeVerifier,
      redirect_uri: redirectUri,
      status: "pending"
    });
    return {
      loginId: state,
      authUrl: buildAuthorizeUrl({
        issuer: DEFAULT_ISSUER,
        clientId: DEFAULT_CLIENT_ID,
        redirectUri,
        codeChallenge: pkce.codeChallenge,
        state
      })
    };
  }

  async function ensureLoginServer() {
    if (loginServer) return loginRedirectUri();
    loginServer = http.createServer((req, res) => handleLoginServerRequest(req, res));
    try {
      await new Promise((resolve, reject) => {
        loginServer.once("error", reject);
        loginServer.listen(LOGIN_PORT, LOGIN_HOST, resolve);
      });
    } catch (error) {
      loginServer = null;
      throw new Error(`启动登录回调服务失败（${loginRedirectUri()}）：${error.message}`);
    }
    return loginRedirectUri();
  }

  async function handleLoginServerRequest(req, res) {
    const parsedUrl = new URL(req.url || "/", loginRedirectUri());
    if (req.method !== "GET" || parsedUrl.pathname !== "/auth/callback") {
      return sendHtml(res, 404, "Codex Gateway", "未找到登录回调地址。");
    }
    try {
      await completeCallback(parsedUrl.searchParams);
      return sendHtml(res, 200, "登录成功", "账号已保存，可以关闭这个浏览器页面并回到 Codex Gateway。");
    } catch (error) {
      return sendHtml(res, 500, "登录失败", String(error?.message || error));
    }
  }

  async function completeCallback(params) {
    const state = String(params.get("state") || "").trim();
    const code = String(params.get("code") || "").trim();
    const oauthError = String(params.get("error") || "").trim();
    const session = state ? store.getLoginSession(state) : null;
    if (oauthError) {
      const message = String(params.get("error_description") || oauthError);
      if (session) store.updateLoginSession(state, "failed", message);
      throw new Error(message);
    }
    if (!state || !code || !session) throw new Error("登录回调已过期或 state 不匹配");
    try {
      const tokens = await exchangeCodeForTokens({
        issuer: DEFAULT_ISSUER,
        clientId: DEFAULT_CLIENT_ID,
        redirectUri: session.redirect_uri,
        codeVerifier: session.code_verifier,
        code
      });
      const account = accountFromTokens(tokens);
      const saved = store.saveAccount(account);
      if (refreshAccountUsage) {
        try {
          const refreshed = await refreshAccountUsage(saved.id);
          store.addAppLog({
            scope: "usage",
            action: "refresh-account",
            status: "success",
            message: `浏览器认证后已刷新额度：${refreshed.name}`
          });
        } catch (error) {
          store.addAppLog({
            level: "error",
            scope: "usage",
            action: "refresh-account",
            status: "failed",
            message: `浏览器认证后刷新额度失败：${saved.name}: ${error.message}`
          });
        }
      }
      store.updateLoginSession(state, "success", null);
      return store.listAccounts().find((item) => item.id === saved.id) || saved;
    } catch (error) {
      store.updateLoginSession(state, "failed", error.message);
      throw error;
    }
  }

  function loginStatus(loginId) {
    return store.getLoginSession(loginId) || { status: "unknown", error: null };
  }

  async function stop() {
    if (!loginServer) return;
    const closing = loginServer;
    loginServer = null;
    await new Promise((resolve) => closing.close(resolve));
  }

  return { startLogin, completeCallback, loginStatus, stop };
}

function loginRedirectUri() {
  return `http://${LOGIN_HOST}:${LOGIN_PORT}/auth/callback`;
}

function generatePkce() {
  const codeVerifier = base64Url(crypto.randomBytes(64));
  const digest = crypto.createHash("sha256").update(codeVerifier).digest();
  return { codeVerifier, codeChallenge: base64Url(digest) };
}

function generateState() {
  return base64Url(crypto.randomBytes(32));
}

function buildAuthorizeUrl({ issuer, clientId, redirectUri, codeChallenge, state }) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: DEFAULT_ORIGINATOR
  });
  return `${issuer}/oauth/authorize?${query.toString()}`;
}

function sendHtml(res, status, title, message) {
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:Arial,sans-serif;padding:32px"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></body>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

async function exchangeCodeForTokens({ issuer, clientId, redirectUri, codeVerifier, code }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier
  });
  const resp = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`token exchange failed: ${resp.status} ${text.slice(0, 240)}`);
  return JSON.parse(text);
}

function accountFromTokens(tokens) {
  const claims = decodeJwtPayload(tokens.id_token || tokens.access_token) || {};
  const auth = claims["https://api.openai.com/auth"] || {};
  const chatgptAccountId = normalizeScopedId(auth.chatgpt_account_id || claims.chatgpt_account_id, "cgpt=");
  const workspaceId = normalizeScopedId(claims.workspace_id || auth.workspace_id, "ws=") || chatgptAccountId;
  const subject = claims.sub || chatgptAccountId || workspaceId || claims.email || crypto.randomUUID();
  return {
    id: stableId([subject, chatgptAccountId, workspaceId].filter(Boolean).join("|")),
    name: claims.email || subject,
    email: claims.email || "",
    access_token: tokens.access_token || "",
    refresh_token: tokens.refresh_token || "",
    id_token: tokens.id_token || "",
    last_refresh: new Date().toISOString(),
    account_id: chatgptAccountId || "",
    workspace_id: workspaceId || "",
    status: "active",
    enabled: true,
    priority: 100,
    subscription_plan: auth.chatgpt_plan_type || "",
    subscription_expires_at: toEpoch(auth.chatgpt_subscription_active_until),
    note: "browser login"
  };
}

function decodeJwtPayload(token) {
  if (!token || !token.includes(".")) return null;
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function normalizeScopedId(value, marker) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const suffix = raw.includes("::") ? raw.split("::").pop() : raw;
  const part = suffix.split("|").find((item) => item.startsWith(marker));
  if (part) return part.slice(marker.length).trim();
  if (raw.includes("::") || raw.includes("|") || raw.includes("=")) return "";
  return raw;
}

function toEpoch(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function stableId(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

module.exports = {
  createAuthService,
  buildAuthorizeUrl,
  loginRedirectUri,
  accountFromTokens
};
