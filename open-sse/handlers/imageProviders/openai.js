// OpenAI-compatible adapter (used by openai, minimax, openrouter, recraft)
import { PROVIDER_MEDIA } from "../../providers/index.js";

const imageCfg = (id) => PROVIDER_MEDIA[id]?.imageConfig || {};
const imageUrl = (id) => imageCfg(id).baseUrl;

// Canonical aspect ratio → pixel size for upstreams that want a `size` field
const ASPECT_TO_SIZE = {
  "1:1": "1024x1024",
  "16:9": "1920x1080",
  "9:16": "1080x1920",
  "4:3": "1024x768",
  "3:4": "768x1024",
};

export default function createOpenAIAdapter(providerId) {
  const cfg = imageCfg(providerId);
  return {
    buildUrl: (model, creds) => {
      const raw = creds?.providerSpecificData?.baseUrl || creds?.baseUrl;
      if (raw) {
        const base = String(raw).replace(/\/+$/, "");
        if (base.endsWith("/v1/images/generations") || base.endsWith("/images/generations")) {
          return base;
        }
        if (base.endsWith("/v1")) {
          return `${base}/images/generations`;
        }
        return `${base}/v1/images/generations`;
      }
      return imageUrl(providerId);
    },
    buildHeaders: (creds) => {
      const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
      const key = creds?.apiKey || creds?.accessToken;
      if (key) headers["Authorization"] = `Bearer ${key}`;
      return headers;
    },
    buildBody: (model, body) => {
      const { prompt, n = 1, size, aspectRatio, quality, style, response_format, images } = body;
      const full = { model, prompt, n };
      if (size) full.size = size;
      if (aspectRatio) full.size = ASPECT_TO_SIZE[aspectRatio] || size || "1024x1024";
      else if (!size) full.size = "1024x1024";
      if (quality) full.quality = quality;
      if (style) full.style = style;
      if (response_format) full.response_format = response_format;
      if (images) {
        if (Array.isArray(images)) {
          full.images = images.map((img) => typeof img === "string" ? { image_url: img } : img);
        } else if (typeof images === "string") {
          full.images = images.split(",").map((s) => s.trim()).filter(Boolean).map((url) => ({ image_url: url }));
        }
      }
      // bodyFields whitelist (e.g. xAI accepts only model/prompt/n/response_format)
      if (Array.isArray(cfg.bodyFields)) {
        const req = {};
        for (const f of cfg.bodyFields) if (full[f] !== undefined) req[f] = full[f];
        return req;
      }
      return full;
    },
    normalize: (responseBody) => responseBody,
  };
}
