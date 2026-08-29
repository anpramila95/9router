import { nowSec, sizeToAspectRatio } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const DEFAULT_BASE_URL = "http://localhost:3000";

function resolveBase(creds, providerId) {
  const raw = creds?.providerSpecificData?.baseUrl || creds?.baseUrl || PROVIDER_MEDIA[providerId]?.imageConfig?.baseUrl || DEFAULT_BASE_URL;
  return String(raw).replace(/\/+$/, "");
}

const ai2wAdapter = {
  buildUrl: (model, creds) => {
    const base = resolveBase(creds, "ai2w");
    const m = (model || "").toLowerCase();
    if (m === "grok") {
      return `${base}/api/grok/generate-image`;
    }
    return `${base}/api/labs/generate-image`;
  },
  buildHeaders: (creds) => {
    const headers = { "Content-Type": "application/json" };
    const key = creds?.apiKey || creds?.accessToken;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    return headers;
  },
  buildBody: (model, body) => {
    const aspectRatio = body.aspectRatio || (body.size ? sizeToAspectRatio(body.size) : "16:9");
    const images = Array.isArray(body.images)
      ? body.images.map((img) => (typeof img === "object" && img?.image_url ? img.image_url : img)).filter(Boolean)
      : body.image
      ? [body.image]
      : [];

    const m = (model || "").toLowerCase();
    if (m === "grok") {
      return {
        prompt: body.prompt,
        aspectRatio,
        images,
      };
    }

    return {
      prompt: body.prompt,
      aspectRatio,
      model: model || "banana-pro",
      images,
      threads: body.threads || body.n || 1,
    };
  },
  normalize: (responseBody, prompt) => {
    if (!responseBody) return { created: nowSec(), data: [] };
    const media = Array.isArray(responseBody.media) ? responseBody.media : [];
    const data = media.map((item) => {
      const entry = { revised_prompt: prompt };
      if (item.url) entry.url = item.url;
      if (item.b64_json || item.base64) entry.b64_json = item.b64_json || item.base64;
      return entry;
    }).filter((d) => d.url || d.b64_json);

    return {
      created: responseBody.created || nowSec(),
      data: data.length ? data : (responseBody.data || []),
    };
  },
};

export default ai2wAdapter;
