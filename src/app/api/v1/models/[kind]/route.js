import { buildModelsList } from "../route.js";
import { getApiKeyByKey } from "@/lib/localDb";
import { extractApiKey } from "@/sse/services/auth.js";

// URL slug → service kind(s). `web` covers both webSearch and webFetch.
const KIND_SLUG_MAP = {
  "image": ["image"],
  "tts": ["tts"],
  "stt": ["stt"],
  "embedding": ["embedding"],
  "image-to-text": ["imageToText"],
  "web": ["webSearch", "webFetch"],
};

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models/{kind} - OpenAI-compatible models list filtered by capability.
 * Supported kinds: image, tts, stt, embedding, image-to-text, web.
 */
export async function GET(_request, { params }) {
  try {
    const apiKey = extractApiKey(_request);
    if (!apiKey) {
      return Response.json(
        { error: { message: "Missing API key", type: "authentication_error" } },
        { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }
    const keyObj = await getApiKeyByKey(apiKey);
    if (!keyObj || keyObj.isActive === false) {
      return Response.json(
        { error: { message: "Invalid API key", type: "authentication_error" } },
        { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const { kind } = await params;
    const kindFilter = KIND_SLUG_MAP[kind];

    if (!kindFilter) {
      return Response.json(
        {
          error: {
            message: `Unknown model kind: ${kind}. Supported: ${Object.keys(KIND_SLUG_MAP).join(", ")}`,
            type: "invalid_request_error",
          },
        },
        { status: 404, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    let data = await buildModelsList(kindFilter);

    if (Array.isArray(keyObj.models) && keyObj.models.length > 0) {
      const allowedSet = new Set(keyObj.models);
      data = data.filter((m) => allowedSet.has(m.id));
    }

    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models by kind:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
}
