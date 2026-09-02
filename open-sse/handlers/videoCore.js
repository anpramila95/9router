import { createErrorResult } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { refreshTokenByProvider } from "../services/tokenRefresh.js";
import { PROVIDER_MEDIA } from "../providers/index.js";

// Upstream fetch deadline for video job submission/polling (the job itself is
// async upstream — this only bounds the HTTP round-trip, not video rendering).
const VIDEO_FETCH_TIMEOUT_MS = Number(process.env.VIDEO_FETCH_TIMEOUT_MS || 120000);

// POST /videos/* creates a billable upstream job. A network error after the
// request left the socket may still have created the job, so creation is NEVER
// auto-retried (the only re-send is the auth retry after a 401/403 refresh,
// which upstream rejects before job creation).
export const VIDEO_ACTIONS = new Set(["generations", "edits", "extensions"]);

export function getVideoConfig(provider) {
  return PROVIDER_MEDIA[provider]?.videoConfig || null;
}

/** Strip bearer tokens / obvious secrets from text destined for clients or logs. */
export function sanitizeSecrets(text, credentials = null) {
  if (!text) return text;
  let out = String(text).replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  for (const key of ["accessToken", "refreshToken", "apiKey"]) {
    const secret = credentials?.[key];
    if (typeof secret === "string" && secret.length >= 8) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

function resolveBase(credentials, config) {
  const raw = credentials?.providerSpecificData?.baseUrl || credentials?.baseUrl || config?.baseUrl || "http://localhost:3000";
  return String(raw).replace(/\/+$/, "");
}

function buildUpstreamUrl(config, action, requestId, provider, model, credentials) {
  const base = resolveBase(credentials, config);
  if (provider === "ai2w" || provider === "aivideoworkflow") {
    if (requestId) {
      return `${base}/api/labs/poll-batch`;
    }
    const m = (model || "").toLowerCase();
    if (m === "grok" || m === "grok-video") {
      return `${base}/api/grok/generate-video`;
    }
    return `${base}/api/labs/generate-video`;
  }
  return requestId ? `${base}/${encodeURIComponent(requestId)}` : `${base}/${action}`;
}

function buildAi2wRequestBody(action, requestId, rawBody, model) {
  if (requestId) {
    return JSON.stringify({ pollingId: requestId });
  }
  let parsed = {};
  if (typeof rawBody === "string") {
    try { parsed = JSON.parse(rawBody); } catch {}
  } else if (rawBody && typeof rawBody === "object") {
    parsed = rawBody;
  }
  const m = (model || parsed.model || "").toLowerCase();
  const aspectRatio = parsed.aspectRatio || parsed.aspect_ratio || "16:9";
  // ai2w labs expects a plain string array (base64/URL), not [{image_url}]
  const images = Array.isArray(parsed.images)
    ? parsed.images.map((img) => (typeof img === "object" ? (img.image_url ?? img.url ?? "") : img)).filter(Boolean)
    : typeof parsed.images === "string" && parsed.images.trim()
    ? parsed.images.split(",").map((s) => s.trim()).filter(Boolean)
    : parsed.image ? [parsed.image] : [];

  if (m === "grok" || m === "grok-video") {
    return JSON.stringify({
      prompt: parsed.prompt,
      images,
      aspectRatio,
      videoLength: parsed.videoLength || parsed.duration || 10,
      resolutionName: parsed.resolutionName || parsed.resolution || "720p",
    });
  }

  // veo3 / default labs video
  return JSON.stringify({
    prompt: parsed.prompt,
    aspectRatio,
    mode: parsed.mode || (images.length ? "image-to-video" : "text-to-video"),
    images,
    model: "veo-3.1-lite-relax-ultra",
  });
}

function buildHeaders({ token, contentType, idempotencyKey }) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (contentType) headers["Content-Type"] = contentType;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return headers;
}

function combineSignals(signal, timeoutMs) {
  const timeoutSignal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : null;
  if (signal && timeoutSignal && typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return signal || timeoutSignal || undefined;
}

/**
 * Transparent proxy for async video jobs (xAI Grok Imagine shape).
 *
 * - Forwards the raw body byte-for-byte (JSON or multipart) — no reshaping.
 * - Passes upstream JSON (request_id, status, video.url, error) back verbatim.
 * - 401/403 with a refresh token: refresh ONCE, retry ONCE. No other retry.
 * - Upstream error text is sanitized before it reaches the client.
 *
 * @param {object} options
 * @param {string} options.provider - Provider id (must have registry videoConfig)
 * @param {"generations"|"edits"|"extensions"|null} options.action - Creation action (POST)
 * @param {string|null} [options.requestId] - Poll target (GET /videos/{id})
 * @param {Buffer|string|null} [options.rawBody] - Exact body to forward
 * @param {string|null} [options.contentType] - Original Content-Type header
 * @param {string|null} [options.idempotencyKey] - Forwarded Idempotency-Key
 * @param {object} options.credentials - { accessToken?, apiKey?, refreshToken?, authType? }
 * @param {AbortSignal} [options.signal] - Client cancellation signal
 * @param {number} [options.timeoutMs]
 * @param {object} [options.log]
 * @param {function} [options.onCredentialsRefreshed]
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleVideoProxyCore({
  provider,
  action = null,
  requestId = null,
  rawBody = null,
  model = null,
  contentType = null,
  idempotencyKey = null,
  credentials,
  signal,
  timeoutMs = VIDEO_FETCH_TIMEOUT_MS,
  log,
  onCredentialsRefreshed,
}) {
  const config = getVideoConfig(provider);
  if (!config) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support video generation`);
  }
  if (!requestId && !VIDEO_ACTIONS.has(action)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Unknown video action: ${action}`);
  }

  const isAi2w = provider === "ai2w" || provider === "aivideoworkflow";
  const method = isAi2w ? "POST" : (requestId ? "GET" : "POST");
  const url = buildUpstreamUrl(config, action, requestId, provider, model, credentials);
  const fetchSignal = combineSignals(signal, timeoutMs);
  const forwardBody = isAi2w ? buildAi2wRequestBody(action, requestId, rawBody, model) : rawBody;
  const sendContentType = isAi2w ? "application/json" : contentType;

  const doFetch = (token) =>
    fetch(url, {
      method,
      headers: buildHeaders({ token, contentType: sendContentType, idempotencyKey: method === "POST" ? idempotencyKey : null }),
      body: method === "POST" ? forwardBody : undefined,
      signal: fetchSignal,
    });

  let upstream;
  try {
    upstream = await doFetch(credentials?.accessToken || credentials?.apiKey);
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      return createErrorResult(HTTP_STATUS.REQUEST_TIMEOUT, `[${provider}] video ${method} aborted: ${error.message}`);
    }
    // Never re-send a creation POST on network error — the job may already exist upstream.
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, sanitizeSecrets(`[${provider}] video upstream fetch failed: ${error.message}`, credentials));
  }

  // 401/403 → refresh once → retry once (OAuth accounts only; API keys can't refresh)
  if (
    (upstream.status === HTTP_STATUS.UNAUTHORIZED || upstream.status === HTTP_STATUS.FORBIDDEN) &&
    credentials?.refreshToken
  ) {
    let refreshed = null;
    try {
      refreshed = await refreshTokenByProvider(provider, credentials, log);
    } catch (error) {
      log?.warn?.("TOKEN", `${provider} | video refresh error: ${sanitizeSecrets(error.message, credentials)}`);
    }
    if (refreshed?.accessToken) {
      log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for video ${method}`);
      Object.assign(credentials, refreshed);
      if (onCredentialsRefreshed) await onCredentialsRefreshed(refreshed);
      try {
        await upstream.body?.cancel?.();
      } catch { /* noop */ }
      try {
        upstream = await doFetch(credentials.accessToken || credentials.apiKey);
      } catch (error) {
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, sanitizeSecrets(`[${provider}] video retry after refresh failed: ${error.message}`, credentials));
      }
    } else {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | video refresh failed — account needs re-auth`);
    }
  }

  const bodyText = await upstream.text().catch(() => "");

  if (!upstream.ok) {
    const message = sanitizeSecrets(bodyText || `HTTP ${upstream.status}`, credentials);
    return createErrorResult(upstream.status, `[${provider}] ${message.slice(0, 2000)}`);
  }

  // Normalize response for ai2w
  if (isAi2w) {
    try {
      const data = JSON.parse(bodyText);
      // Poll response: { success, mediaItems: [{ name, downloadUrl, status, ... }] }
      if (requestId) {
        const item = data.mediaItems?.[0] || {};
        const status = item.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL"
          ? "done"
          : item.status === "MEDIA_GENERATION_STATUS_FAILED"
          ? "failed"
          : "pending";
        const normalized = {
          status,
          video: item.downloadUrl ? { url: item.downloadUrl } : undefined,
          mediaItems: data.mediaItems,
        };
        return {
          success: true,
          response: new Response(JSON.stringify(normalized), {
            status: upstream.status,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          }),
        };
      }

      // Generation response
      const m = (model || "").toLowerCase();
      // Grok direct video
      if (m === "grok" || m === "grok-video" || data.videoUrl || data.videoBase64) {
        const normalized = {
          status: "done",
          video: {
            url: data.videoUrl || data.videoDataUrl || "",
            base64: data.videoBase64,
          },
          videoUrl: data.videoUrl,
          videoBase64: data.videoBase64,
          videoDataUrl: data.videoDataUrl,
        };
        return {
          success: true,
          response: new Response(JSON.stringify(normalized), {
            status: upstream.status,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          }),
        };
      }

      // Veo3 creation: { pollingId, projectId, operations, ... }
      const normalized = {
        request_id: data.pollingId || data.id,
        pollingId: data.pollingId,
        projectId: data.projectId,
        operations: data.operations,
        status: "pending",
      };
      return {
        success: true,
        response: new Response(JSON.stringify(normalized), {
          status: upstream.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }),
      };
    } catch {}
  }

  // Success: pass the upstream JSON through untouched (request_id / status / video.url).
  return {
    success: true,
    response: new Response(bodyText, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
