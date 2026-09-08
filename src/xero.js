import { loadTokens as defaultLoadTokens, saveTokens as defaultSaveTokens } from "./token-store.js";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";

function getConfig() {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing XERO_CLIENT_ID or XERO_CLIENT_SECRET. Copy .env.example to .env and run `npm run auth`.");
  }
  return { clientId, clientSecret };
}

function tokenExpiry(token) {
  if (typeof token.expires_at === "number") return token.expires_at;
  if (typeof token.expires_in === "number" && typeof token.obtained_at === "number") {
    return token.obtained_at + token.expires_in * 1000;
  }
  return 0;
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function responseError(method, path, response, body) {
  const detail = typeof body === "string" ? body : JSON.stringify(body);
  return new Error(`Xero API ${method} ${path} failed (${response.status} ${response.statusText}): ${detail}`);
}

export function createXeroClient({
  fetch = globalThis.fetch,
  loadTokens = defaultLoadTokens,
  saveTokens = defaultSaveTokens,
  getConfig: config = getConfig,
  now = Date.now,
} = {}) {
  let refreshInFlight;

  async function exchangeAuthorizationCode(code, redirectUri) {
    const { clientId, clientSecret } = config();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    const response = await fetch(XERO_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const result = await readResponse(response);
    if (!response.ok) throw responseError("POST", XERO_TOKEN_URL, response, result);
    return normaliseToken(result);
  }

  function normaliseToken(token) {
    return {
      ...token,
      obtained_at: now(),
      expires_at: now() + Number(token.expires_in ?? 0) * 1000,
    };
  }

  async function refreshTokens(tokens) {
    const { clientId, clientSecret } = config();
    if (!tokens.refresh_token) {
      throw new Error("Saved Xero credentials do not include a refresh token. Run `npm run auth` again.");
    }
    const response = await fetch(XERO_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    });
    const result = await readResponse(response);
    if (!response.ok) throw responseError("POST", XERO_TOKEN_URL, response, result);

    const refreshed = { ...normaliseToken(result), tenantId: tokens.tenantId };
    await saveTokens(refreshed);
    return refreshed;
  }

  async function usableTokens() {
    let tokens = await loadTokens();
    if (!tokens) {
      throw new Error("Xero is not authorised yet. Run `npm run auth` in this project first.");
    }
    if (!tokens.tenantId) {
      throw new Error("Saved Xero credentials have no tenant ID. Run `npm run auth` again.");
    }
    if (tokenExpiry(tokens) < now() + 60_000) {
      if (!refreshInFlight) {
        refreshInFlight = refreshTokens(tokens).finally(() => {
          refreshInFlight = undefined;
        });
      }
      tokens = await refreshInFlight;
    }
    return tokens;
  }

  async function xeroRequest(method, path, { query, body } = {}) {
    const tokens = await usableTokens();
    const url = new URL(`${XERO_API_BASE}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "xero-tenant-id": tokens.tenantId,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await readResponse(response);
    if (!response.ok) throw responseError(method, `${path}${url.search}`, response, result);
    return result;
  }

  async function fetchConnections(accessToken) {
    const response = await fetch("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const result = await readResponse(response);
    if (!response.ok) throw responseError("GET", "/connections", response, result);
    return result;
  }

  return { exchangeAuthorizationCode, xeroRequest, fetchConnections };
}

export const { exchangeAuthorizationCode, xeroRequest, fetchConnections } = createXeroClient();

export function getConfiguredTenantId() {
  return process.env.XERO_TENANT_ID || null;
}
