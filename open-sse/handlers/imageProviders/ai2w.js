import { nowSec, sizeToAspectRatio, urlToBase64 } from "./_base.js";
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
  buildBody: async (model, body) => {
    const aspectRatio = body.aspectRatio || (body.size ? sizeToAspectRatio(body.size) : "16:9");

    // Normalize to array of image references (URL or base64)
    let refs = [];
    if (Array.isArray(body.images)) {
      refs = body.images.map((img) => typeof img === "object" ? (img.image_url ?? img.url ?? "") : img).filter(Boolean);
    } else if (typeof body.images === "string" && body.images.trim()) {
      refs = body.images.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (body.image) {
      refs = [body.image];
    }

    // ai2w labs expects plain base64 string array, not [{image_url}]
    const images = [];
    for (const ref of refs) {
      if (ref.startsWith("data:")) {
        const comma = ref.indexOf(",");
        images.push(comma !== -1 ? ref.slice(comma + 1) : ref);
      } else if (ref.startsWith("http://") || ref.startsWith("https://")) {
        try { images.push(await urlToBase64(ref)); } catch { /* skip unfetchable refs */ }
      } else {
        images.push(ref); // raw base64
      }
    }

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
