import { randomUUID } from "crypto";
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const mevideoaiKv = makeKv("mevideoai");
let inMemorySession = null;

export function _resetSessionCacheForTesting() {
  inMemorySession = null;
}

function getConfig() {
  return {
    baseUrl: (process.env.MEVIDEOAI_BASE_URL || "https://mevideoai.com").replace(/\/+$/, ""),
    email: process.env.MEVIDEOAI_EMAIL || "test.dongu7@gmail.com",
    password: process.env.MEVIDEOAI_PASSWORD || ")*Btz6H2",
    deviceId: process.env.MEVIDEOAI_DEVICE_ID || "edb5f484-ba98-4af1-b238-79db05de1268",
    deviceName: process.env.MEVIDEOAI_DEVICE_NAME || "Chrome trên Windows",
  };
}

function extractCookies(response) {
  let cookieHeaders = [];
  if (typeof response.headers?.getSetCookie === "function") {
    cookieHeaders = response.headers.getSetCookie();
  } else {
    const raw = response.headers?.get?.("set-cookie");
    if (raw) cookieHeaders = [raw];
  }

  const cookieMap = new Map();
  for (const header of cookieHeaders) {
    const parts = header.split(";");
    const pair = parts[0]?.trim();
    if (pair && pair.includes("=")) {
      const idx = pair.indexOf("=");
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      if (val) {
        cookieMap.set(key, val);
      }
    }
  }

  const pairs = [];
  for (const [key, val] of cookieMap.entries()) {
    pairs.push(`${key}=${val}`);
  }
  return pairs.join("; ");
}

export function normalizeRatio(input) {
  if (!input) return "portrait";
  const s = String(input).trim().toLowerCase();
  if (["16:9", "16/9", "landscape", "horizontal", "wide", "1920:1080", "1280:720"].includes(s)) {
    return "landscape";
  }
  if (["9:16", "9/16", "portrait", "vertical", "tall", "1080:1920", "720:1280"].includes(s)) {
    return "portrait";
  }
  if (s.includes(":") || s.includes("/")) {
    const [w, h] = s.split(/[:/]/).map(Number);
    if (w && h) {
      return w >= h ? "landscape" : "portrait";
    }
  }
  return "portrait";
}

export async function loginMevideoai() {
  const config = getConfig();
  const res = await fetch(`${config.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: config.email,
      password: config.password,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`mevideoai login failed (${res.status}): ${errText.slice(0, 500)}`);
  }

  const cookie = extractCookies(res);
  if (!cookie || !cookie.includes("kc_session")) {
    throw new Error("mevideoai login succeeded but no kc_session cookie returned");
  }

  inMemorySession = cookie;
  await mevideoaiKv.set("session", cookie).catch(() => {});
  return cookie;
}

export async function getMevideoaiSession(forceRefresh = false) {
  if (!forceRefresh && inMemorySession) {
    return inMemorySession;
  }

  if (!forceRefresh) {
    try {
      const cached = await mevideoaiKv.get("session");
      if (cached) {
        inMemorySession = typeof cached === "string" ? cached : cached.cookie;
        if (inMemorySession) return inMemorySession;
      }
    } catch {}
  }

  inMemorySession = null;
  await mevideoaiKv.remove("session").catch(() => {});
  return await loginMevideoai();
}

/**
 * Wrapper for all mevideoai calls: handles cookie header + 401 re-login & retry.
 */
export async function mevideoaiFetch(endpointOrUrl, options = {}) {
  const config = getConfig();
  const url = endpointOrUrl.startsWith("http")
    ? endpointOrUrl
    : `${config.baseUrl}${endpointOrUrl}`;

  let cookie = await getMevideoaiSession();
  const headers = new Headers(options.headers || {});
  headers.set("Cookie", cookie);

  let res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    // Cookie expired: re-login, update cache, and retry once
    cookie = await getMevideoaiSession(true);
    const retryHeaders = new Headers(options.headers || {});
    retryHeaders.set("Cookie", cookie);
    res = await fetch(url, { ...options, headers: retryHeaders });
  }

  return res;
}

export async function uploadAssetToMevideoai(imageInput) {
  if (!imageInput) throw new Error("imageInput is required for upload");
  if (typeof imageInput === "string" && imageInput.startsWith("library:")) {
    return imageInput;
  }

  let buffer;
  let mimeType = "image/png";

  if (typeof imageInput === "string") {
    const trimmed = imageInput.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const res = await fetch(trimmed);
      if (!res.ok) {
        throw new Error(`Failed to fetch image from URL: ${trimmed} (${res.status})`);
      }
      buffer = Buffer.from(await res.arrayBuffer());
      mimeType = res.headers.get("content-type") || "image/png";
    } else if (trimmed.startsWith("data:")) {
      const match = trimmed.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        mimeType = match[1];
        buffer = Buffer.from(match[2], "base64");
      } else {
        buffer = Buffer.from(trimmed, "base64");
      }
    } else {
      buffer = Buffer.from(trimmed, "base64");
    }
  } else if (Buffer.isBuffer(imageInput)) {
    buffer = imageInput;
  } else if (imageInput instanceof Uint8Array) {
    buffer = Buffer.from(imageInput);
  } else {
    throw new Error("Unsupported image input type");
  }

  const ext = mimeType.split("/")[1] || "png";
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([buffer], { type: mimeType }),
    `asset-${Date.now()}.${ext}`,
  );

  const uploadRes = await mevideoaiFetch("/api/proxy/library/assets", {
    method: "POST",
    headers: {
      "Idempotency-Key": randomUUID(),
    },
    body: formData,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => "");
    throw new Error(`Upload asset to mevideoai failed (${uploadRes.status}): ${errText.slice(0, 500)}`);
  }

  const json = await uploadRes.json();
  if (!json?.id) {
    throw new Error("No asset ID returned from mevideoai library upload");
  }

  return `library:${json.id}`;
}

export async function submitMevideoaiVideo(requestBody = {}) {
  const config = getConfig();
  const prompt = requestBody.prompt;
  if (!prompt) throw new Error("prompt is required");

  const ratio = normalizeRatio(requestBody.ratio || requestBody.aspectRatio);
  const videoModel = "veo3LiteLowPriority";

  let mode = requestBody.mode;
  const rawImages = requestBody.images || (requestBody.image ? [requestBody.image] : []) || [];
  const images = Array.isArray(rawImages) ? rawImages : [rawImages];

  if (!mode) {
    mode = images.length > 0 ? "i2v" : "t2v";
  }

  let endpoint = "/api/proxy/v3/video/generate/text";
  let payload = {
    prompt,
    ratio,
    videoModel,
    count: 1,
  };

  if (mode === "r2v") {
    if (images.length === 0) {
      throw new Error("r2v requires reference images");
    }
    const uploaded = await Promise.all(
      images.map(async (img) => {
        const url = typeof img === "object" ? img.image_url || img.url : img;
        const libId = await uploadAssetToMevideoai(url);
        return { imageBase64: libId };
      }),
    );
    payload.referenceImages = uploaded;
    endpoint = "/api/proxy/v3/video/generate/reference";
  } else if (mode === "i2v") {
    if (images.length === 0) {
      throw new Error("i2v requires at least one image");
    }
    const firstUrl = typeof images[0] === "object" ? images[0].image_url || images[0].url : images[0];
    payload.imageBase64 = await uploadAssetToMevideoai(firstUrl);
    if (images.length > 1) {
      const secondUrl = typeof images[1] === "object" ? images[1].image_url || images[1].url : images[1];
      payload.endImageBase64 = await uploadAssetToMevideoai(secondUrl);
    }
    endpoint = "/api/proxy/v3/video/generate/image";
  }

  const res = await mevideoaiFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Mevideoai generate video failed (${res.status}): ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const taskWorkerId = data.taskWorkerId || data.id;
  if (!taskWorkerId) {
    throw new Error(data.message || data.error || "No taskWorkerId returned from mevideoai");
  }

  return {
    taskWorkerId,
    jobId: data.jobId,
    raw: data,
  };
}

export async function pollMevideoaiTask(taskWorkerId) {
  if (!taskWorkerId) throw new Error("taskWorkerId is required");

  const res = await mevideoaiFetch(
    `/api/proxy/task-workers/${encodeURIComponent(taskWorkerId)}`,
    {
      method: "GET",
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Poll mevideoai task failed (${res.status}): ${errText.slice(0, 500)}`);
  }

  const json = await res.json();
  const data = json?.data || json;
  const status = String(data.status || "").toLowerCase();

  const videoUrl =
    data.videoUrl ||
    data.response?.videoUrls?.[0] ||
    data.response?.media?.[0]?.mediaUrl ||
    data.url ||
    null;

  const errorMessage =
    data.errorMessage ||
    (Array.isArray(data.response?.errors) && data.response.errors.length > 0
      ? data.response.errors.join("; ")
      : null) ||
    data.error ||
    null;

  if (
    status === "completed" ||
    status === "success" ||
    status === "done" ||
    status === "succeeded"
  ) {
    if (!videoUrl) {
      throw new Error("Task marked completed but videoUrl is missing");
    }
    return {
      status: "completed",
      videoUrl,
      raw: data,
    };
  }

  if (
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "rejected" ||
    status === "timeout" ||
    status.includes("fail") ||
    status.includes("err")
  ) {
    return {
      status: "failed",
      error: errorMessage || "Mevideoai task failed",
      raw: data,
    };
  }

  return {
    status: "processing",
    raw: data,
  };
}
