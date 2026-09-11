import crypto from "node:crypto";
import { getGcalAccount, updateGcalTokens } from "./store.js";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

function getCredentials() {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing GOOGLE_CALENDAR_CLIENT_ID or GOOGLE_CALENDAR_CLIENT_SECRET in .env");
  }
  return { clientId, clientSecret };
}

function getSecretKey() {
  return process.env.JWT_SECRET || process.env.API_KEY_SECRET || "9router-gcal-fallback-secret-2026";
}

export function encodeState({ apiKeyId, actionId, redirectUri }) {
  const payload = {
    apiKeyId,
    actionId: actionId || null,
    redirectUri: redirectUri || null,
    ts: Date.now(),
  };
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  const hmac = crypto.createHmac("sha256", getSecretKey()).update(b64).digest("base64url");
  return `${b64}.${hmac}`;
}

export function decodeState(state) {
  if (!state || typeof state !== "string" || !state.includes(".")) {
    throw new Error("Invalid OAuth state format");
  }

  const [b64, hmac] = state.split(".");
  const expectedHmac = crypto.createHmac("sha256", getSecretKey()).update(b64).digest("base64url");
  const fallbackHmac = crypto.createHmac("sha256", "9router-gcal-fallback-secret-2026").update(b64).digest("base64url");

  if (hmac !== expectedHmac && hmac !== fallbackHmac) {
    throw new Error("OAuth state signature mismatch");
  }

  const json = Buffer.from(b64, "base64url").toString("utf8");
  const payload = JSON.parse(json);
  if (Date.now() - payload.ts > 30 * 60 * 1000) {
    throw new Error("OAuth state expired (30m TTL)");
  }
  return payload;
}

export function buildAuthUrl({ apiKeyId, actionId, redirectUri }) {
  const { clientId } = getCredentials();
  const state = encodeState({ apiKeyId, actionId, redirectUri });

  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", CALENDAR_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);

  return url.toString();
}

export async function exchangeCode(code, redirectUri) {
  const { clientId, clientSecret } = getCredentials();

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new Error(data?.error_description || data?.error || `Token exchange failed: HTTP ${response.status}`);
  }

  const userinfo = await fetchUserInfo(data.access_token).catch(() => ({}));

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: data.expires_in || 3600,
    scope: data.scope,
    email: userinfo.email || null,
    name: userinfo.name || null,
  };
}

export async function fetchUserInfo(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return {};
  return response.json();
}

export async function refreshGoogleToken(refreshToken) {
  const { clientId, clientSecret } = getCredentials();

  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new Error(data?.error_description || data?.error || `Token refresh failed: HTTP ${response.status}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: data.expires_in || 3600,
  };
}

export async function getValidAccessToken(apiKeyId, email = null) {
  const account = await getGcalAccount(apiKeyId, email);
  if (!account) return { account: null, accessToken: null, status: "not_found" };

  const now = Date.now();
  const expiresAtMs = account.expiresAt ? new Date(account.expiresAt).getTime() : 0;
  const isExpiringSoon = !expiresAtMs || expiresAtMs - now < 5 * 60 * 1000;

  if (!isExpiringSoon && account.accessToken) {
    return { account, accessToken: account.accessToken, status: "active" };
  }

  if (!account.refreshToken) {
    // Không có refresh token và access token đã hết hạn
    if (expiresAtMs && now > expiresAtMs) {
      return { account, accessToken: null, status: "token_expired", error: "Access token expired and no refresh token available." };
    }
    return { account, accessToken: account.accessToken, status: "active" };
  }

  try {
    const refreshed = await refreshGoogleToken(account.refreshToken);
    await updateGcalTokens(account.id, refreshed);
    return { account, accessToken: refreshed.accessToken, status: "active" };
  } catch (err) {
    console.error("[gcal][refresh] failed:", err.message);
    const isInvalidGrant = err.message.toLowerCase().includes("invalid_grant") || err.message.toLowerCase().includes("revoked");
    return {
      account,
      accessToken: null,
      status: isInvalidGrant ? "auth_revoked" : "refresh_failed",
      error: err.message,
    };
  }
}
