import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  CALENDAR_TOOLS,
  isCalendarTool,
  dispatchCalendarTool,
} from "./calendar/tools.js";
import { resolveApiKeyId } from "./calendar/store.js";
import { notifyMediaError } from "@/lib/telegramNotifier.js";
import { saveUploadedFile } from "@/lib/uploadService.js";
import {
  enqueueMediaJob,
  getJob,
  updateJob,
  waitForActiveWorkers,
  cleanErrorMessage,
} from "@/lib/mediaWorker.js";
import { pollMevideoaiTask } from "@/lib/mevideoai.js";

export { waitForActiveWorkers, cleanErrorMessage };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const mediaImageSchema = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    images: {
      type: "array",
      items: {
        type: "object",
        properties: { image_url: { type: "string" } },
        required: ["image_url"],
        additionalProperties: false,
      },
    },
    aspectRatio: { type: "string", default: "16:9", description: "Optional aspect ratio, e.g. 16:9, 1:1, 3:4 or 4:3." },
  },
  required: ["prompt"],
  additionalProperties: false,
};

export const mediaTools = [
  {
    name: "image.upload.getUrl",
    description:
      "Upload image data to get a public URL hosted on this server (retained for 30 minutes). ALWAYS call this tool first before calling image.generate or video.generate.\n" +
      "INSTRUCTION FOR AI AGENTS:\n" +
      "- Pass image content as a Base64 Data URI string in 'image' (e.g. 'data:image/png;base64,iVBORw...').\n" +
      "- Or pass an existing public HTTP/HTTPS image URL in 'image'.\n" +
      'Output example: { "url": "https://api.binhdanhocai.com/uploads/xxx.png", "urls": ["https://api.binhdanhocai.com/uploads/xxx.png"] }',
    inputSchema: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description:
            "Image content as Base64 Data URI ('data:image/png;base64,...'), raw Base64 string, or public HTTP/HTTPS URL.",
        },
        images: {
          type: "array",
          items: { type: ["string", "object"] },
          description:
            "Optional batch upload: array of Base64 Data URIs or public URLs.",
        },
        format: {
          type: "string",
          description: "Optional format/extension: png, jpg, webp, mp4, etc.",
        },
      },
      required: ["image"],
    },
  },
  {
    name: "image.generate",
    description:
      "Generate or edit images using the active media pipeline.\n" +
      "WORKFLOW / ASYNC JOB: Returns immediately with { id: jobId, status: 'pending' }. The image generates in the background. Poll 'media.status' passing id: jobId until status is 'completed' to get the final image.\n" +
      "WORKFLOW FOR REFERENCE IMAGES: When editing, call 'image.upload.getUrl' first to upload local/Base64 images, then pass the public URL in images: [{ image_url: 'https://...' }].\n" +
      'Output example: { "id": "954dfc66-4f90-4a60-9648-9112237d125e", "status": "pending" }',
    inputSchema: mediaImageSchema,
  },
  {
    name: "facebook.pages",
    description: "List Facebook Pages available to the Facebook access token.",
    inputSchema: {
      type: "object",
      properties: {
        access_token: {
          type: "string",
          description: "Facebook user access token",
        },
      },
      required: ["access_token"],
    },
  },
  {
    name: "facebook.post",
    description:
      "Publish text, multiple images, or a video to a Facebook Page or personal profile. Send media as public URL or Base64 file payload.",
    inputSchema: {
      type: "object",
      properties: {
        access_token: {
          type: "string",
          description: "Facebook user token or Page token",
        },
        page_id: {
          type: "string",
          description: "Facebook Page ID. Omit for personal profile post.",
        },
        message: { type: "string" },
        images: {
          type: "array",
          description:
            "Multiple image URLs or objects: {data: Base64, mime_type: string, filename: string}",
          items: { type: ["string", "object"] },
        },
        video: {
          description:
            "Video URL or object: {data: Base64, mime_type: string, filename: string}",
          type: ["string", "object"],
        },
      },
      required: ["access_token"],
    },
  },
  {
    name: "video.generate",
    description:
      "Generate video. With images, animate the supplied image; otherwise generate from text. Upload local images using image.upload.getUrl first. Poll media.status for the result.",
    inputSchema: mediaImageSchema,
  },
  {
    name: "media.status",
    description:
      "Poll status and get result of an image or video generation job by ID (pass 'id' returned from image.generate or video.generate).\n" +
      "Workflow: Call repeatedly with interval (e.g. 3-5s) until status is 'completed' or 'failed'.\n" +
      'Output example (in progress): { "id": "954dfc66-...", "type": "image"|"video", "status": "pending"|"processing" }\n' +
      'Output example (image done): { "id": "954dfc66-...", "type": "image", "status": "completed", "data": [{ "url": "https://...", "b_64": "...if have" }] }\n' +
      'Output example (video done): { "id": "954dfc66-...", "type": "video", "status": "completed", "video_url": "https://.../output.mp4" }\n' +
      'Output example (failed): { "id": "954dfc66-...", "status": "failed", "error": "..." }',
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The jobId returned from image.generate or video.generate",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "speech.generate",
    description:
      "Generate speech audio through Bình Dân Học AI.\n" +
      'Output example: { "audio_url": "https://...", "format": "mp3" } or binary audio payload.',
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

const tools = [...mediaTools, ...CALENDAR_TOOLS];

function auth(request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer "))
    return authorization.slice(7).trim();
  const headerKey = request.headers.get("x-api-key")?.trim();
  if (headerKey) return headerKey;
  try {
    const url = new URL(request.url);
    const queryKey =
      url.searchParams.get("apiKey") ||
      url.searchParams.get("api_key") ||
      url.searchParams.get("key") ||
      url.searchParams.get("token");
    if (queryKey) return queryKey.trim();
  } catch {}
  return "";
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

function validateMediaArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { error: "Invalid arguments" };
  if (Object.keys(args).some((key) => !["prompt", "images", "aspectRatio"].includes(key))) return { error: "Unsupported media argument" };
  if (typeof args.prompt !== "string" || !args.prompt.trim()) return { error: "prompt is required" };
  if (args.aspectRatio !== undefined && (typeof args.aspectRatio !== "string" || !args.aspectRatio.trim())) return { error: "Invalid aspectRatio" };
  if (args.images !== undefined && (!Array.isArray(args.images) || args.images.some((image) => !image || typeof image !== "object" || Array.isArray(image) || Object.keys(image).some((key) => key !== "image_url") || typeof image.image_url !== "string"))) return { error: "images must be an array of { image_url: string }" };
  const validation = validateImageInput(args.images?.length ? args.images : undefined);
  if (!validation.valid) return { error: validation.error };
  return { input: { prompt: args.prompt, aspectRatio: args.aspectRatio?.trim() || "16:9", ...(validation.images.length ? { images: validation.images } : {}) } };
}

export function validateImageInput(rawImages) {
  if (rawImages === undefined || rawImages === null) {
    return { valid: true, images: [] };
  }

  const list = Array.isArray(rawImages) ? rawImages : [rawImages];
  if (list.length === 0) {
    return {
      valid: false,
      error: "images cannot be an empty array when provided",
    };
  }

  const normalized = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    let url = "";
    if (typeof item === "string") {
      url = item.trim();
    } else if (typeof item === "object" && item !== null) {
      url = String(item.image_url || item.url || "").trim();
    } else {
      return {
        valid: false,
        error: `Invalid image at index ${i}: expected string URL or object { image_url: string }, received ${typeof item}`,
      };
    }

    if (!url) {
      return {
        valid: false,
        error: `Invalid image at index ${i}: image_url cannot be empty`,
      };
    }

    const isHttp = /^https?:\/\//i.test(url);
    const isDataUri = /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(url);
    const isRawBase64 =
      !isHttp && !isDataUri && /^[A-Za-z0-9+/=]{64,}$/.test(url);

    if (!isHttp && !isDataUri && !isRawBase64) {
      if (/^[a-zA-Z]:[\\/]|^[\\/]/.test(url) || url.includes("\\")) {
        return {
          valid: false,
          error: `Invalid image at index ${i}: '${url.slice(0, 80)}' is a local file path. You must call 'image.upload.getUrl' first to obtain a public URL.`,
        };
      }
      return {
        valid: false,
        error: `Invalid image at index ${i}: '${url.slice(0, 80)}' is not a valid HTTP/HTTPS URL or Data URI.`,
      };
    }

    const finalUrl = isRawBase64 ? `data:image/png;base64,${url}` : url;
    normalized.push({ image_url: finalUrl });
  }

  return { valid: true, images: normalized };
}

function getBaseUrl(request) {
  const envUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
  if (
    envUrl &&
    typeof envUrl === "string" &&
    envUrl.trim() &&
    envUrl.trim() !== "/"
  ) {
    return envUrl.trim().replace(/\/+$/, "");
  }
  if (request?.url) {
    try {
      const url = new URL(request.url);
      if (url.origin && url.origin !== "null") return url.origin;
      if (url.protocol && url.host) return `${url.protocol}//${url.host}`;
    } catch {}
  }
  const host =
    request?.headers?.get?.("x-forwarded-host") ||
    request?.headers?.get?.("host") ||
    `localhost:${process.env.PORT || 20128}`;
  const proto = request?.headers?.get?.("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

const FACEBOOK_GRAPH_VERSION =
  process.env.FACEBOOK_GRAPH_API_VERSION || "v22.0";

async function facebookRequest(path, accessToken, init = {}) {
  const url = new URL(
    `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${path}`,
  );
  if (init.query)
    for (const [key, value] of Object.entries(init.query))
      url.searchParams.set(key, value);
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${accessToken}`,
    },
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok)
    throw new Error(data?.error?.message || `Facebook HTTP ${response.status}`);
  return data;
}

function facebookFile(value, defaultName, defaultType) {
  if (typeof value === "string" && /^https?:\/\//i.test(value))
    return { url: value };
  if (typeof value === "object" && value?.url) return { url: value.url };
  if (typeof value === "object" && value?.image_url) {
    const raw = String(value.image_url).replace(/^data:[^;]+;base64,/, "");
    return {
      blob: Buffer.from(raw, "base64"),
      filename: value?.filename || defaultName,
      mimeType: value?.mime_type || defaultType,
    };
  }
  const data = typeof value === "string" ? value : value?.data;
  if (!data)
    throw new Error(`${defaultName} must be URL or Base64 file payload`);
  const raw = data.replace(/^data:[^;]+;base64,/, "");
  return {
    blob: Buffer.from(raw, "base64"),
    filename: value?.filename || defaultName,
    mimeType: value?.mime_type || defaultType,
  };
}

async function facebookPost(args) {
  const {
    access_token: token,
    page_id: pageId,
    message = "",
    images = [],
    video,
  } = args;
  if (!message && !images.length && !video)
    throw new Error("message, images, or video is required");
  const target = pageId || "me";
  if (video) {
    const file = facebookFile(video, "video.mp4", "video/mp4");
    if (file.url)
      return facebookRequest(`${target}/videos`, token, {
        method: "POST",
        query: { file_url: file.url, description: message },
      });
    const form = new FormData();
    form.set(
      "source",
      new Blob([file.blob], { type: file.mimeType }),
      file.filename,
    );
    form.set("description", message);
    return facebookRequest(`${target}/videos`, token, {
      method: "POST",
      body: form,
    });
  }
  if (images.length > 1 || images.length === 1) {
    const attached = [];
    for (const image of images) {
      const file = facebookFile(image, "image.jpg", "image/jpeg");
      if (file.url)
        attached.push({
          media_fbid: (
            await facebookRequest(`${target}/photos`, token, {
              method: "POST",
              query: { url: file.url, published: "false" },
            })
          ).id,
        });
      else {
        const form = new FormData();
        form.set(
          "source",
          new Blob([file.blob], { type: file.mimeType }),
          file.filename,
        );
        form.set("published", "false");
        attached.push({
          media_fbid: (
            await facebookRequest(`${target}/photos`, token, {
              method: "POST",
              body: form,
            })
          ).id,
        });
      }
    }
    return facebookRequest(`${target}/feed`, token, {
      method: "POST",
      query: { message, attached_media: JSON.stringify(attached) },
    });
  }
  return facebookRequest(`${target}/feed`, token, {
    method: "POST",
    query: { message },
  });
}

async function callApi(request, path, method, body) {
  const headers = {
    authorization: `Bearer ${auth(request)}`,
    "content-type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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
  if (!auth(request)) return error(null, -32001, "Missing API key");
  let message;
  const contentType = request.headers.get("content-type") || "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const fileEntries = [
        ...form.getAll("images[]"),
        ...form.getAll("images"),
        ...form.getAll("image"),
        ...form.getAll("file"),
      ].filter(
        (val) =>
          typeof val === "object" &&
          typeof val.arrayBuffer === "function" &&
          val.size > 0,
      );

      const convertedFiles = await Promise.all(
        fileEntries.map(async (file) => {
          const buffer = Buffer.from(await file.arrayBuffer());
          const mime = file.type || "image/jpeg";
          return {
            image_url: `data:${mime};base64,${buffer.toString("base64")}`,
          };
        }),
      );

      if (form.has("message")) {
        message = JSON.parse(form.get("message"));
      } else {
        let params = {};
        if (form.has("params")) {
          const rawParams = form.get("params");
          params =
            typeof rawParams === "string" ? JSON.parse(rawParams) : rawParams;
        } else if (form.has("arguments")) {
          const rawArgs = form.get("arguments");
          params = {
            name: form.get("name") || "image.generate",
            arguments:
              typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs,
          };
        } else {
          const name = form.get("name") || "image.generate";
          const flatArgs = {};
          for (const [key, value] of form.entries()) {
            if (
              ![
                "jsonrpc",
                "id",
                "method",
                "name",
                "images",
                "images[]",
                "image",
                "file",
              ].includes(key) &&
              typeof value === "string"
            ) {
              flatArgs[key] = value;
            }
          }
          params = { name, arguments: flatArgs };
        }

        message = {
          jsonrpc: form.get("jsonrpc") || "2.0",
          id: form.get("id") || Date.now(),
          method: form.get("method") || "tools/call",
          params,
        };
      }

      if (convertedFiles.length > 0) {
        if (!message.params) message.params = {};
        if (!message.params.arguments) message.params.arguments = {};
        const existingImages = Array.isArray(message.params.arguments.images)
          ? message.params.arguments.images
          : [];
        message.params.arguments.images = [
          ...existingImages,
          ...convertedFiles,
        ];
      }
    } else {
      message = await request.json();
    }
  } catch {
    return error(null, -32700, "Invalid JSON or Form Data");
  }
  const { id = null, method, params = {} } = message;
  if (method === "notifications/initialized")
    return new Response(null, { status: 200 });
  if (method === "initialize") {
    const clientVersion = params?.protocolVersion || "2024-11-05";
    return jsonRpc(id, {
      protocolVersion: clientVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: {},
        prompts: {},
        logging: {},
      },
      serverInfo: { name: "binhdanhocai-media", version: "1.0.0" },
    });
  }
  if (method === "tools/list") return jsonRpc(id, { tools });
  if (method === "resources/list") return jsonRpc(id, { resources: [] });
  if (method === "prompts/list") return jsonRpc(id, { prompts: [] });
  if (method === "ping") return jsonRpc(id, {});
  if (method !== "tools/call")
    return error(id, -32601, `Method not found: ${method}`);
  const name = params.name;
  const args = params.arguments || {};
  try {
    let result;
    if (isCalendarTool(name)) {
      const apiKeyString = auth(request);
      const resolved = await resolveApiKeyId(apiKeyString);
      const apiKeyId =
        resolved ||
        (apiKeyString ? `raw_${apiKeyString.slice(0, 32)}` : "default");
      result = await dispatchCalendarTool({ apiKeyId, name, args, request });
    } else if (name === "facebook.pages") {
      result = await facebookRequest("me/accounts", args.access_token, {
        query: { fields: "id,name,access_token,category,link" },
      });
    } else if (name === "facebook.post") {
      result = await facebookPost(args);
    } else if (name === "image.upload.getUrl") {
      const singleImage = args.image || args.file || args.url;
      const imagesList = Array.isArray(args.images)
        ? args.images.filter(Boolean)
        : [];
      if (imagesList.length === 0 && !singleImage) {
        return error(
          id,
          -32602,
          "image or images parameter is required (Base64 data URI, raw Base64, or public URL)",
        );
      }

      const baseUrl = getBaseUrl(request);
      const targets = imagesList.length > 0 ? imagesList : [singleImage];
      const urls = await Promise.all(
        targets.map((item) =>
          saveUploadedFile(item, { format: args.format }, baseUrl),
        ),
      );
      result = { url: urls[0], urls };
    } else if (name === "image.generate") {
      const validation = validateMediaArgs(args);
      if (validation.error) return error(id, -32602, validation.error);
      const body = {
        model: "g2a/gpt-image-2",
        quality: "auto",
        response_format: "url",
        ...validation.input,
      };

      const jobId = randomUUID();
      const job = {
        id: jobId,
        type: "image",
        status: "pending",
        payload: {
          baseUrl: request.url,
          token: auth(request),
          body,
          pipelineInput: validation.input,
        },
        createdAt: new Date().toISOString(),
      };
      await enqueueMediaJob(job);

      result = {
        id: jobId,
        jobId,
        status: "pending",
      };
    } else if (name === "image.generate.codex") {
      if (!args.access_token)
        return error(id, -32602, "access_token is required");
      if (!args.prompt || !String(args.prompt).trim())
        return error(id, -32602, "prompt is required");

      const rawImages = args.images ?? args.image ?? args.image_url ?? null;
      const imageValidation = validateImageInput(rawImages);
      if (!imageValidation.valid) {
        return error(id, -32602, imageValidation.error);
      }

      const jobId = randomUUID();
      const job = {
        id: jobId,
        type: "image",
        status: "pending",
        payload: {
          baseUrl: request.url,
          token: auth(request),
          body: {
            model: "gpt-image-2",
            quality: "auto",
            response_format: "url",
            ...args,
            ...(imageValidation.images.length > 0
              ? { images: imageValidation.images }
              : {}),
          },
        },
        createdAt: new Date().toISOString(),
      };
      await enqueueMediaJob(job);

      result = {
        id: jobId,
        jobId,
        status: "pending",
      };
    } else if (
      name === "media.status" ||
      name === "image.status" ||
      name === "video.status"
    ) {
      if (!args.id) return error(id, -32602, "id is required");
      const job = await getJob(args.id);
      if (job) {
        let finalData = job.data || job.result?.data;
        const modelStr = String(
          job.payload?.body?.model || job.payload?.requestBody?.model || "",
        ).toLowerCase();
        if (
          Array.isArray(finalData) &&
          finalData.length > 1 &&
          (modelStr.includes("grok") || modelStr.includes("ai2w"))
        ) {
          finalData = [finalData[finalData.length - 1]];
        }

        result = {
          id: job.id,
          type: job.type,
          status: job.status,
          ...(job.status === "completed"
            ? {
                video_url: job.video_url,
                data: finalData,
                result: job.result,
              }
            : {}),
          ...(job.status === "failed"
            ? { error: cleanErrorMessage(job.error) }
            : {}),
        };
      } else {
        // Fallback: in case an upstream video pollingId / taskWorkerId was passed directly
        try {
          const mevideo = await pollMevideoaiTask(args.id);
          result = {
            id: args.id,
            type: "video",
            status: mevideo.status,
            ...(mevideo.status === "completed"
              ? {
                  video_url: mevideo.videoUrl,
                  result: mevideo.raw,
                }
              : {}),
            ...(mevideo.status === "failed"
              ? { error: cleanErrorMessage(mevideo.error) }
              : {}),
          };
        } catch {
          try {
            const direct = await callApi(
              request,
              `/videos/${encodeURIComponent(args.id)}`,
              "GET",
            );
            result = direct;
          } catch {
            return error(id, -32602, `Job not found: ${args.id}`);
          }
        }
      }
    } else if (name === "video.generate") {
      const validation = validateMediaArgs(args);
      if (validation.error) return error(id, -32602, validation.error);
      const requestBody = {
        model: "ai2w/veo3",
        resolutionName: "720p",
        ...validation.input,
        mode: validation.input.images ? "i2v" : "t2v",
        ...(validation.input.aspectRatio ? { ratio: validation.input.aspectRatio } : {}),
      };

      const jobId = randomUUID();
      const job = {
        id: jobId,
        type: "video",
        status: "pending",
        payload: {
          baseUrl: request.url,
          token: auth(request),
          requestBody,
          pipelineInput: validation.input,
        },
        createdAt: new Date().toISOString(),
      };
      await enqueueMediaJob(job);

      result = {
        id: jobId,
        jobId,
        status: "pending",
      };
    } else if (name === "speech.generate")
      result = await callApi(request, "/audio/speech", "POST", args);
    else return error(id, -32602, `Unknown tool: ${name}`);
    return jsonRpc(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    });
  } catch (e) {
    if (
      name === "image.generate" ||
      name === "image.generate.codex" ||
      name === "video.generate" ||
      name === "speech.generate"
    ) {
      notifyMediaError({
        type: name.split(".")[0],
        model: args?.model || name,
        error: e.message,
        prompt: args?.prompt || args?.input,
      }).catch(() => {});
    }
    return jsonRpc(id, {
      content: [{ type: "text", text: e.message }],
      isError: true,
    });
  }
}

export async function GET(request) {
  if (!auth(request)) {
    return error(null, -32001, "Missing API key");
  }

  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/event-stream")) {
    const encoder = new TextEncoder();
    const sessionId = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`,
          ),
        );
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return NextResponse.json({
    status: "ok",
    name: "binhdanhocai-media",
    version: "1.0.0",
    toolsCount: tools.length,
  });
}

export async function POST(request) {
  return handle(request);
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
