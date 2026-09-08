import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tools = [
  {
    name: "image.generate",
    description:
      "Generate image through Bình Dân Học AI. Default model: g2a/gpt-image-2.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", default: "g2a/gpt-image-2" },
        prompt: { type: "string" },

        aspectRatio: {
          type: "string",
          description: "Image aspect ratio, for example 1:1 or 16:9",
        },
        quality: { type: "string", default: "auto", enum: ["auto"] },
        response_format: { type: "string", default: "b64", enum: ["b64"] },
        access_token: {
          type: "string",
          description:
            "Optional Codex access token; routes request to Codex when present",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "video.generate",
    description:
      "Generate video through Bình Dân Học AI. Default model: ai2w/veo3; ai2w/veo3 returns a polling id. t2v: text to video; r2v: components to video; i2v: start/end frames to video. r2v and i2v require images.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", default: "ai2w/veo3" },
        prompt: { type: "string" },
        mode: { type: "string", default: "t2v", enum: ["t2v", "r2v", "i2v"] },
        aspectRatio: { type: "string", description: "For example 16:9" },
        videoLength: {
          type: "number",
          default: 10,
          description: "Video duration in seconds",
        },
        resolutionName: {
          type: "string",
          default: "720p",
          description: "Video resolution",
        },
        images: {
          type: "array",
          items: { type: "string", description: "Base64 image" },
        },
        seconds: { type: ["string", "number"] },
        size: { type: "string" },
        image_url: { type: "string" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "video.status",
    description: "Get video generation job status.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "speech.generate",
    description: "Generate speech audio through Bình Dân Học AI.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        input: { type: "string" },
        voice: { type: "string" },
        response_format: { type: "string" },
        speed: { type: "number" },
      },
      required: ["input", "voice"],
    },
  },
];

function auth(request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer "))
    return authorization.slice(7).trim();
  return request.headers.get("x-api-key")?.trim() || "";
}

function jsonRpc(id, result) {
  return NextResponse.json({ jsonrpc: "2.0", id, result });
}

function error(id, code, message) {
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status: 400 },
  );
}

async function callCodexImage(request, body) {
  const response = await fetch(
    "https://gpt2api.binhdanhocai.com/v1/images/generations",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acccess-token": body.access_token,
      },
      body: JSON.stringify(
        Object.fromEntries(
          Object.entries(body).filter(([key]) => key !== "access_token"),
        ),
      ),
    },
  );
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok)
    throw new Error(
      (await response.text()).slice(0, 1000) || `HTTP ${response.status}`,
    );
  return contentType.includes("application/json")
    ? response.json()
    : {
        data: Buffer.from(await response.arrayBuffer()).toString("base64"),
        mime_type: contentType || "application/octet-stream",
      };
}

async function callApi(request, path, method, body) {
  const headers = {
    authorization: `Bearer ${auth(request)}`,
    "content-type": "application/json",
  };
  const url = new URL(`/api/v1${path}`, request.url);
  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok)
    throw new Error(
      (await response.text()).slice(0, 1000) || `HTTP ${response.status}`,
    );
  if (contentType.includes("application/json")) return response.json();
  return {
    data: Buffer.from(await response.arrayBuffer()).toString("base64"),
    mime_type: contentType || "application/octet-stream",
  };
}

async function handle(request) {
  let message;
  try {
    message = await request.json();
  } catch {
    return error(null, -32700, "Invalid JSON");
  }
  const { id = null, method, params = {} } = message;
  if (method === "notifications/initialized")
    return new Response(null, { status: 202 });
  if (method === "initialize")
    return jsonRpc(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "binhdanhocai-media", version: "1.0.0" },
    });
  if (method === "tools/list") return jsonRpc(id, { tools });
  if (method !== "tools/call")
    return error(id, -32601, `Method not found: ${method}`);
  const name = params.name;
  const args = params.arguments || {};
  try {
    let result;
    if (name === "image.generate") {
      const body = {
        model: "g2a/gpt-image-2",
        quality: "auto",
        response_format: "b64",
        ...args,
      };
      result = body.access_token
        ? await callCodexImage(request, body)
        : await callApi(request, "/images/generations", "POST", body);
    } else if (name === "image.generate.codex") {
      if (!args.access_token)
        return error(id, -32602, "access_token is required");
      result = await callCodexImage(request, {
        model: "gpt-image-2",
        quality: "auto",
        response_format: "b64",
        ...args,
      });
    } else if (name === "video.generate") {
      const mode = args.mode || "t2v";
      if (!["t2v", "r2v", "i2v"].includes(mode))
        return error(id, -32602, `Invalid video mode: ${mode}`);
      if (
        (mode === "r2v" || mode === "i2v") &&
        (!Array.isArray(args.images) || args.images.length === 0)
      )
        return error(id, -32602, `${mode} requires images`);
      result = await callApi(request, "/videos/generations", "POST", {
        model: "ai2w/veo3",
        mode,
        videoLength: 10,
        resolutionName: "720p",
        ...args,
      });
    } else if (name === "video.status")
      result = await callApi(
        request,
        `/videos/${encodeURIComponent(args.id)}`,
        "GET",
      );
    else if (name === "speech.generate")
      result = await callApi(request, "/audio/speech", "POST", args);
    else return error(id, -32602, `Unknown tool: ${name}`);
    return jsonRpc(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    });
  } catch (e) {
    return jsonRpc(id, {
      content: [{ type: "text", text: e.message }],
      isError: true,
    });
  }
}

export async function POST(request) {
  return handle(request);
}
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
