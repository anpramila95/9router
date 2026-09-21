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
    if (m === "grok" || m === "grok-image" || m.includes("grok")) {
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
    if (m === "grok" || m === "grok-image" || m.includes("grok")) {
      const grokPayload = {
        prompt: body.prompt,
        aspectRatio,
      };
      if (images.length) {
        grokPayload.images = images;
      }
      return grokPayload;
    }

    return {
      prompt: body.prompt,
      aspectRatio,
      model: model || "banana-pro",
      images,
      threads: body.threads || body.n || 1,
    };
  },
  normalize: async (responseBody, prompt) => {
    if (!responseBody) return { created: nowSec(), data: [] };

    // Format 1: responseBody.images = ["http://...", ...] or [{ url: "...", base64Image: "..." }, ...]
    if (Array.isArray(responseBody.images)) {
      const data = await Promise.all(
        responseBody.images.map(async (img) => {
          const entry = { revised_prompt: prompt };
          if (typeof img === "string") {
            if (img.startsWith("data:") || !/^https?:\/\//i.test(img)) {
              entry.b64_json = img.startsWith("data:") ? img.split(",")[1] : img;
            } else {
              entry.url = img;
            }
          } else if (typeof img === "object" && img) {
            const rawBase64 = img.base64Image || img.b64_json || img.base64;
            const targetUrl = img.url;

            if (targetUrl) {
              let urlOk = false;
              try {
                const headRes = await fetch(targetUrl, {
                  method: "HEAD",
                  signal: AbortSignal.timeout(3000),
                });
                urlOk = headRes.ok;
              } catch {
                urlOk = false;
              }

              if (urlOk) {
                entry.url = targetUrl;
              } else if (rawBase64) {
                entry.b64_json = rawBase64.startsWith("data:")
                  ? rawBase64.split(",")[1]
                  : rawBase64;
              } else {
                entry.url = targetUrl;
              }
            } else if (rawBase64) {
              entry.b64_json = rawBase64.startsWith("data:")
                ? rawBase64.split(",")[1]
                : rawBase64;
            }
          }
          return entry;
        })
      );

      const filtered = data.filter((d) => d.url || d.b64_json);
      if (filtered.length) {
        return { created: responseBody.created || nowSec(), data: filtered };
      }
    }

    // Format 2: responseBody.media = [{ url, b64_json, base64Image }]
    const media = Array.isArray(responseBody.media) ? responseBody.media : [];
    const data = await Promise.all(
      media.map(async (item) => {
        const entry = { revised_prompt: prompt };
        const rawBase64 = item.base64Image || item.b64_json || item.base64;
        const targetUrl = item.url;

        if (targetUrl) {
          let urlOk = false;
          try {
            const headRes = await fetch(targetUrl, {
              method: "HEAD",
              signal: AbortSignal.timeout(3000),
            });
            urlOk = headRes.ok;
          } catch {
            urlOk = false;
          }

          if (urlOk) {
            entry.url = targetUrl;
          } else if (rawBase64) {
            entry.b64_json = rawBase64.startsWith("data:")
              ? rawBase64.split(",")[1]
              : rawBase64;
          } else {
            entry.url = targetUrl;
          }
        } else if (rawBase64) {
          entry.b64_json = rawBase64.startsWith("data:")
            ? rawBase64.split(",")[1]
            : rawBase64;
        }
        return entry;
      })
    );
    const filtered = data.filter((d) => d.url || d.b64_json);

    return {
      created: responseBody.created || nowSec(),
      data: filtered.length ? filtered : (responseBody.data || []),
    };
  },
};

export default ai2wAdapter;
