import Redis from "ioredis";
import axios from "axios";
import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { makeKv } from "@/lib/db/helpers/kvStore.js";
import { notifyMediaError } from "@/lib/telegramNotifier.js";
import { saveUploadedFile } from "@/lib/uploadService.js";
import { pipelineTemplate, pipelinePath, assertPipelineResultSafe, allowedPipelineEnvKeys } from "./mediaPipelineHelpers.js";
import { uploadMediaToDigen } from "@/lib/digenUpload.js";
import { submitMevideoaiVideo, pollMevideoaiTask } from "@/lib/mevideoai.js";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const QUEUE_KEY = "mcp:media:jobs:queue";
const JOB_PREFIX = "mcp:media:job:";
const MAX_CONCURRENT_JOBS = 20;
const PIPELINE_MAX_STEPS = 12;
const PIPELINE_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function getGpt2ApiBaseUrl() {
  return (
    process.env.GPT2API_BASE_URL ||
    process.env.GPT2_API_BASE_URL ||
    "https://gpt2api.sinhthanh.com"
  ).replace(/\/+$/, "");
}

function getGpt2ApiAuthToken() {
  return (
    process.env.GPT2API_AUTH_TOKEN ||
    process.env.GPT2API_TOKEN ||
    process.env.GPT2_API_KEY ||
    ""
  );
}

const mcpJobsKv = makeKv("mcpJob");
const memoryCache = new Map();
const localQueue = [];

function uploadBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "";
  }
}

async function uploadInlineMedia(
  value,
  baseUrl,
  format,
  allowRawBase64 = false,
  uploaded = new Map(),
) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    !/^data:[^;]+;base64,/i.test(trimmed) &&
    !(allowRawBase64 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed))
  )
    return value;
  if (uploaded.has(trimmed)) return uploaded.get(trimmed);
  const digenUrl = await uploadMediaToDigen(trimmed, format).catch(() => null);
  const result =
    digenUrl ||
    (await saveUploadedFile(trimmed, { format }, uploadBaseUrl(baseUrl)));
  uploaded.set(trimmed, result);
  return result;
}

async function uploadInlineMediaTree(
  value,
  baseUrl,
  format,
  key = "",
  uploaded = new Map(),
) {
  if (typeof value === "string")
    return uploadInlineMedia(
      value,
      baseUrl,
      format,
      /(?:b64_json|base64|videoData|videoBase64)$/i.test(key),
      uploaded,
    );
  if (Array.isArray(value))
    return Promise.all(
      value.map((item) =>
        uploadInlineMediaTree(item, baseUrl, format, "", uploaded),
      ),
    );
  if (!value || typeof value !== "object") return value;
  const entries = await Promise.all(
    Object.entries(value).map(async ([key, item]) => [
      key,
      await uploadInlineMediaTree(item, baseUrl, format, key, uploaded),
    ]),
  );
  return Object.fromEntries(entries);
}
let activeWorkers = 0;
let workerRunning = false;
let redisClient = null;
let isRedisReady = false;
let redisLoggedNotice = false;

function getRedisClient() {
  if (redisClient) return redisClient;
  try {
    redisClient = new Redis(REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
      retryStrategy: (times) => {
        if (times > 5) return null;
        return Math.min(times * 500, 2000);
      },
    });

    redisClient.on("connect", () => {
      console.log(`[MediaWorker] Connected to Redis at ${REDIS_URL}`);
    });

    redisClient.on("ready", () => {
      isRedisReady = true;
    });

    redisClient.on("close", () => {
      isRedisReady = false;
    });

    redisClient.on("error", (err) => {
      isRedisReady = false;
      if (!redisLoggedNotice) {
        redisLoggedNotice = true;
        console.warn(
          `[MediaWorker] Redis notice (${err.message}). Using local queue fallback if needed.`,
        );
      }
    });
  } catch (err) {
    isRedisReady = false;
    if (!redisLoggedNotice) {
      redisLoggedNotice = true;
      console.warn(
        `[MediaWorker] Redis init failed (${err.message}). Using local queue.`,
      );
    }
  }
  return redisClient;
}

// Auto-initialize Redis connection
getRedisClient();

export async function getJob(id) {
  if (!id) return null;

  // Redis is shared across worker/API processes and receives every update.
  // Prefer it over sql.js snapshots, which can be stale in another process.
  if (isRedisReady && redisClient) {
    try {
      const raw = await redisClient.get(`${JOB_PREFIX}${id}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        memoryCache.set(id, parsed);
        return parsed;
      }
    } catch {}
  }

  try {
    const fromKv = await mcpJobsKv.get(id);
    if (fromKv) {
      memoryCache.set(id, fromKv);
      return fromKv;
    }
  } catch {}

  return memoryCache.get(id) || null;
}

export async function updateJob(id, updates) {
  const current = (await getJob(id)) || {
    id,
    createdAt: new Date().toISOString(),
  };
  const updated = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  memoryCache.set(id, updated);

  if (isRedisReady && redisClient) {
    try {
      await redisClient.set(
        `${JOB_PREFIX}${id}`,
        JSON.stringify(updated),
        "EX",
        86400 * 3,
      );
    } catch (error) {
      console.warn(`[MediaWorker] Redis save failed for job ${id}: ${error.message}`);
    }
  }

  try {
    await mcpJobsKv.set(id, updated);
  } catch (error) {
    console.warn(`[MediaWorker] DB save failed for job ${id}: ${error.message}`);
    if (!isRedisReady) throw error;
  }
  return updated;
}

export async function enqueueMediaJob(job) {
  await updateJob(job.id, job);

  let queuedInRedis = false;
  if (isRedisReady && redisClient) {
    try {
      await redisClient.rpush(QUEUE_KEY, job.id);
      queuedInRedis = true;
      console.log(`[MediaWorker][Redis] Enqueued ${job.type} job: ${job.id}`);
    } catch (err) {
      console.warn(
        `[MediaWorker] Failed to push to Redis queue, using local queue: ${err.message}`,
      );
    }
  }

  if (!queuedInRedis) {
    localQueue.push(job.id);
    console.log(`[MediaWorker][Local] Enqueued ${job.type} job: ${job.id}`);
  }

  startMediaWorker();
}

async function popNextJobId() {
  if (isRedisReady && redisClient) {
    try {
      const id = await redisClient.lpop(QUEUE_KEY);
      if (id) return id;
    } catch {}
  }
  return localQueue.shift() || null;
}

export function startMediaWorker() {
  if (workerRunning) return;
  workerRunning = true;
  runWorkerLoop().catch((err) =>
    console.error("[MediaWorker] Worker loop crashed:", err),
  );
}

export function stopMediaWorker() {
  workerRunning = false;
}

async function runWorkerLoop() {
  cleanupStalePendingJobs();

  while (workerRunning) {
    if (activeWorkers >= MAX_CONCURRENT_JOBS) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    const jobId = await popNextJobId();
    if (!jobId) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    activeWorkers++;
    executeJob(jobId).finally(() => {
      activeWorkers--;
    });
  }
}

const activeRunningJobs = new Set();
let recoveryDone = false;

function cleanupStalePendingJobs() {
  if (recoveryDone) return;
  recoveryDone = true;
  // Mark zombie jobs from previous server sessions as failed if older than 5m
  mcpJobsKv
    .getAll()
    .then((all) => {
      for (const [id, job] of Object.entries(all || {})) {
        if (job && (job.status === "pending" || job.status === "processing")) {
          const ageMs = Date.now() - new Date(job.createdAt || 0).getTime();
          if (ageMs > 5 * 60 * 1000) {
            console.log(
              `[MediaWorker] Cleaning up stale zombie job from DB: ${id} (${job.type})`,
            );
            updateJob(id, {
              status: "failed",
              error: "Job interrupted by server restart",
            }).catch(() => {});
          }
        }
      }
    })
    .catch(() => {});
}

export function cleanErrorMessage(raw) {
  if (!raw) return "Unknown error";
  let msg =
    typeof raw === "string"
      ? raw
      : raw.message || raw.error || JSON.stringify(raw);

  // Recursively parse JSON strings if msg is stringified JSON
  for (let i = 0; i < 5; i++) {
    const trimmed = String(msg).trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null) {
          msg =
            parsed.error?.message ??
            parsed.message ??
            parsed.error ??
            parsed.detail?.error ??
            parsed.detail ??
            msg;
          continue;
        }
      } catch {}
    }
    break;
  }

  msg = String(msg).trim();

  // Strip provider tag if present: e.g. "[ai2w] ..."
  const match = msg.match(/^\[[a-zA-Z0-9_-]+\]\s*(.+)$/s);
  if (match) {
    const content = match[1].trim();
    if (content.startsWith("{") && content.endsWith("}")) {
      try {
        const parsed = JSON.parse(content);
        msg =
          parsed.error?.message ??
          parsed.message ??
          parsed.error ??
          parsed.detail?.error ??
          parsed.detail ??
          content;
      } catch {
        const errMatch = content.match(/"(?:error|message)":\s*"([^"]+)"/);
        if (errMatch) {
          msg = errMatch[1];
        }
      }
    } else {
      msg = content;
    }
  }

  // If error has Google response raw dump: "Không tạo được video từ Google Labs: Google response: )]}'..."
  // Simplify to readable headline + error code if present
  if (typeof msg === "string" && msg.includes("Google response:")) {
    const parts = msg.split("Google response:");
    const headline = parts[0].trim().replace(/[:\-,\s]+$/, "");
    const codeMatch = msg.match(/PUBLIC_ERROR_[A-Z0-9_]+/);
    if (headline) {
      msg = codeMatch ? `${headline} (${codeMatch[0]})` : headline;
    }
  }

  return String(msg).trim() || "Unknown error";
}

async function executeJob(jobId) {
  if (activeRunningJobs.has(jobId)) {
    console.log(
      `[MediaWorker] Job ${jobId} is already running, skipping duplicate dispatch.`,
    );
    return;
  }
  activeRunningJobs.add(jobId);

  try {
    const job = await getJob(jobId);
    if (!job || job.status === "completed" || job.status === "failed") return;

    console.log(`[MediaWorker] Starting job ${jobId} (type: ${job.type})...`);
    await updateJob(jobId, { status: "processing" });

    try {
      if (job.type === "image") {
        await processImageJob(job);
      } else if (job.type === "video") {
        await processVideoJob(job);
      } else {
        throw new Error(`Unknown job type: ${job.type}`);
      }
      console.log(`[MediaWorker] Finished job ${jobId} successfully.`);
    } catch (err) {
      const cleaned = cleanErrorMessage(err);
      console.error(`[MediaWorker] Job ${jobId} failed:`, cleaned);
      await updateJob(jobId, { status: "failed", error: cleaned });
      notifyMediaError({
        type: job.type || "media",
        model:
          job.payload?.body?.model ||
          job.payload?.requestBody?.model ||
          job.type,
        error: cleaned,
        prompt: job.payload?.body?.prompt || job.payload?.requestBody?.prompt,
      }).catch(() => {});
    }
  } finally {
    activeRunningJobs.delete(jobId);
  }
}

export async function executeApiCall(
  baseUrl,
  token,
  path,
  method,
  body,
  customTimeout = null,
) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
  const url = new URL(`/api/v1${path}`, baseUrl).toString();
  const timeoutMs =
    customTimeout || (path.startsWith("/videos") ? 360 * 1000 : 120 * 1000);

  try {
    const response = await axios({
      url,
      method,
      headers,
      data: method === "GET" ? undefined : body,
      timeout: timeoutMs,
      responseType: "arraybuffer",
      validateStatus: () => true,
    });

    const contentType = response.headers?.["content-type"] || "";
    if (response.status >= 400) {
      const errText = Buffer.from(response.data).toString("utf8");
      throw new Error(errText.slice(0, 1000) || `HTTP ${response.status}`);
    }

    if (contentType.includes("application/json")) {
      const text = Buffer.from(response.data).toString("utf8");
      return JSON.parse(text);
    }

    return {
      data: Buffer.from(response.data).toString("base64"),
      mime_type: contentType || "application/octet-stream",
    };
  } catch (err) {
    if (err.code === "ECONNABORTED" || err.message?.includes("timeout")) {
      const sec = Math.round(timeoutMs / 1000);
      throw new Error(`API call to ${path} timed out after ${sec}s`);
    }
    throw err;
  }
}

async function callCodexImage(body) {
  const gpt2ApiBase = getGpt2ApiBaseUrl();
  const response = await fetch(`${gpt2ApiBase}/v1/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-access-token": body.access_token,
      authorization: `Bearer ${getGpt2ApiAuthToken()}`,
    },
    body: JSON.stringify(
      Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== "access_token"),
      ),
    ),
  });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    throw new Error(
      (await response.text()).slice(0, 1000) || `HTTP ${response.status}`,
    );
  }
  return contentType.includes("application/json")
    ? response.json()
    : {
        data: Buffer.from(await response.arrayBuffer()).toString("base64"),
        mime_type: contentType || "application/octet-stream",
      };
}

async function processGptImage2Task(job) {
  const { baseUrl = "", token = "", body = {} } = job.payload || {};
  const clientTaskId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-0`;

  let images = [];
  if (Array.isArray(body.images)) {
    images = body.images
      .map((img) => {
        if (typeof img === "object" && img?.image_url) {
          return { image_url: String(img.image_url).trim() };
        }
        if (typeof img === "string" && img.trim()) {
          return { image_url: img.trim() };
        }
        return null;
      })
      .filter(Boolean);
  } else if (body.image) {
    images = [{ image_url: String(body.image).trim() }];
  }

  const aspectRatio = body.aspectRatio || "16:9";

  // Codex accepts only these sizes; preserve other ratios in the request, without silently making them square.
  const sizes = { "1:1": "1024x1024", "16:9": "1920x1080", "9:16": "1080x1920", "4:3": "1024x768", "3:4": "768x1024" };
  const size = sizes[aspectRatio];

  let payload = {
    client_task_id: clientTaskId,
    prompt: body.prompt,
    model: "gpt-image-2",
    ...(size ? { size } : {}),
    aspectRatio,
    quality: body.quality && body.quality !== "auto" ? body.quality : "medium",
  };

  if (images.length > 0) {
    payload.images = images;
  }

  const gpt2ApiBase = getGpt2ApiBaseUrl();
  const envAuthToken = getGpt2ApiAuthToken();
  const accessToken = body?.access_token;
  const authToken = envAuthToken || accessToken || token;

  const headers = {
    "content-type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
  if (authToken) {
    headers["authorization"] = `Bearer ${authToken}`;
  }
  if (accessToken) {
    headers["x-access-token"] = accessToken;
  }

  console.log(
    `[MediaWorker] Submitting gpt-image-2 task (client_task_id: ${clientTaskId})...`,
  );

  console.log(`[MediaWorker] Job ${job.id} image request:`, { model: payload.model, size: payload.size, aspectRatio, quality: payload.quality, imageCount: images.length, promptLength: typeof payload.prompt === "string" ? payload.prompt.length : 0 });

  const createRes = await fetch(
    `${gpt2ApiBase}/api/image-tasks/${images.length ? "edits" : "generations"}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  );

  console.log(`[MediaWorker] Job ${job.id} image task create response: HTTP ${createRes.status}`);
  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => "");
    throw new Error(
      `Failed to create image task (HTTP ${createRes.status}): ${errText.slice(0, 1000)}`,
    );
  }

  const createData = await createRes.json();
  const taskId = createData?.id || clientTaskId;
  await updateJob(job.id, {
    status: "processing",
    taskId,
    upstreamTask: createData,
  });

  console.log(
    `[MediaWorker] gpt-image-2 task accepted (id: ${taskId}), polling every 5s...`,
  );

  const startTime = Date.now();
  const maxPollMs = 15 * 60 * 1000;
  while (Date.now() - startTime < maxPollMs) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const pollUrl = `${gpt2ApiBase}/api/image-tasks?ids=${encodeURIComponent(taskId)}&_t=${Date.now()}`;
      const pollRes = await fetch(pollUrl, {
        method: "GET",
        headers,
      });

      if (!pollRes.ok) {
        console.warn(`[MediaWorker] Job ${job.id} image task poll: HTTP ${pollRes.status}`);
        continue;
      }

      const pollData = await pollRes.json();
      const item = pollData?.items?.[0];
      if (!item) continue;

      const status = String(item.status || "").toLowerCase();
      console.log(`[MediaWorker] Job ${job.id} image task poll status: ${status || "unknown"}`);
      if (status === "success" || status === "completed" || status === "done") {
        let finalData = item.data;
        const m = String(body?.model || "").toLowerCase();
        if (
          Array.isArray(finalData) &&
          finalData.length > 1 &&
          (m.includes("grok") || m.includes("ai2w"))
        ) {
          finalData = [finalData[finalData.length - 1]];
        }

        const uploaded = new Map();
        finalData = await uploadInlineMediaTree(finalData, baseUrl, "png", "", uploaded);
        const uploadedResult = await uploadInlineMediaTree(item, baseUrl, "png", "", uploaded);
        await updateJob(job.id, {
          status: "completed",
          data: finalData,
          result: uploadedResult,
          usage: item.usage,
        });
        console.log(
          `[MediaWorker] gpt-image-2 task ${job.id} completed successfully.`,
        );
        return;
      }

      if (status === "failed" || status === "error") {
        const cleaned = cleanErrorMessage(
          item.error || "Image task failed upstream",
        );
        await updateJob(job.id, {
          status: "failed",
          error: cleaned,
          result: item,
        });
        console.warn(
          `[MediaWorker] gpt-image-2 task ${job.id} failed:`,
          cleaned,
        );
        return;
      }
    } catch (pollErr) {
      console.warn(
        `[MediaWorker] Polling error for task ${taskId}:`,
        pollErr.message,
      );
    }
  }

  await updateJob(job.id, {
    status: "failed",
    error: "Image task timed out after 15 minutes",
  });
}

function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 100 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
  }
  // Reject IPv6 until all special-use and embedded IPv4 ranges are classified.
  return false;
}

async function pipelineUrl(raw, base) {
  const url = new URL(raw, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Pipeline URL rejected");
  const addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) throw new Error("Pipeline URL resolves to a non-public address");
  url._pipelineAddresses = addresses.map(({ address }) => address);
  return url;
}

export async function pipelineRequest(step, context, timeoutMs = 120000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request = pipelineTemplate(step.request || {}, context);
    if (step.request?.url === "gateway://images/generations") {
      if ((request.method || "POST").toUpperCase() !== "POST" || Object.keys(request.headers || {}).length) throw new Error("Invalid gateway request");
      const { handleImageGeneration } = await import("@/sse/handlers/imageGeneration.js");
      // ponytail: Codex supports only square, landscape and portrait sizes; update when exact ratios are supported.
      const ratios = { "1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536", "4:3": "1536x1024", "3:4": "1024x1536" };
      if (!request.body?.size && ratios[request.body?.aspectRatio]) request.body.size = ratios[request.body.aspectRatio];
      const headers = { "content-type": "application/json" };
      if (context.gatewayToken) headers.authorization = `Bearer ${context.gatewayToken}`;
      const payload = request.body || {};
      console.log(`[MediaWorker] Job ${context.jobId} gateway image request:`, { model: payload.model, size: payload.size, aspectRatio: payload.aspectRatio, quality: payload.quality, imageCount: Array.isArray(payload.images) ? payload.images.length : 0, promptLength: typeof payload.prompt === "string" ? payload.prompt.length : 0 });
      const response = await handleImageGeneration(new Request("http://localhost/v1/images/generations", { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal }));
      console.log(`[MediaWorker] Job ${context.jobId} gateway image response: HTTP ${response.status}`);
      if (!response.ok) throw new Error("Gateway request failed");
      const text = await response.text();
      console.log(`[MediaWorker] Job ${context.jobId} gateway response bytes: ${Buffer.byteLength(text)}`);
      if (Buffer.byteLength(text) > PIPELINE_MAX_RESPONSE_BYTES) throw new Error("Pipeline response too large");
      const parsed = JSON.parse(text);
      assertPipelineResultSafe(parsed, [...context.allowedEnv]);
      return parsed;
    }
    const url = await Promise.race([pipelineUrl(request.url, context.base_url), new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }))]);
    const body = (request.method || "POST").toUpperCase() === "GET" ? undefined : JSON.stringify(request.body || {});
    const transport = url.protocol === "https:" ? https : http;
    const result = await new Promise((resolve, reject) => {
      const req = transport.request(url, { method: request.method || "POST", headers: request.headers || {}, signal: controller.signal, lookup: (_host, _opts, callback) => callback(null, url._pipelineAddresses[0], net.isIP(url._pipelineAddresses[0])) }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); reject(new Error("Pipeline redirects rejected")); return; }
        const chunks = []; let size = 0;
        res.on("data", (chunk) => { size += chunk.length; if (size > PIPELINE_MAX_RESPONSE_BYTES) req.destroy(new Error("Pipeline response too large")); else chunks.push(chunk); });
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
    let parsed; try { parsed = JSON.parse(result.text); } catch { parsed = result.text; }
    if (result.status < 200 || result.status >= 300) throw new Error(`Pipeline request failed (HTTP ${result.status})`);
    assertPipelineResultSafe(parsed, [...context.allowedEnv]);
    return parsed;
  } catch (error) {
    console.error(`[MediaWorker] Job ${context.jobId || "unknown"} pipeline request failed:`, controller.signal.aborted ? "timeout" : ["Gateway request failed", "Pipeline response too large", "Pipeline redirects rejected", "Invalid gateway request"].includes(error?.message) || /^Pipeline request failed \(HTTP \d+\)$/.test(error?.message || "") ? error.message : "request or response error");
    throw new Error("Media pipeline request failed");
  } finally { clearTimeout(timeout); }
}

async function processConfiguredPipeline(job, type) {
  const { getSettings } = await import("@/lib/db/index.js");
  const settings = await getSettings();
  if (settings.mediaPipelinesEnabled !== true) return false;
  const pipelines = Array.isArray(settings.mediaPipelines) ? settings.mediaPipelines : [];
  const types = type === "video" ? ["video", "text_to_video", "image_to_video", "two_step_pipeline"] : ["image", "text_to_image", "image_to_image", "image_generation"];
  const pipeline = pipelines.find((p) => types.includes(p?.type) && p.is_default === true);
  if (!pipeline) return false;
  if (!Array.isArray(pipeline.steps) || !pipeline.steps.length || pipeline.steps.length > PIPELINE_MAX_STEPS) throw new Error("Invalid media pipeline steps");
  const envKeys = Array.isArray(pipeline.required_env_keys) ? pipeline.required_env_keys : [];
  const allowedEnv = allowedPipelineEnvKeys();
  if (envKeys.some((key) => typeof key !== "string" || !allowedEnv.has(key) || !process.env[key])) throw new Error("Required media pipeline environment key unavailable");
  const inputBody = job.payload?.pipelineInput || job.payload?.requestBody || job.payload?.body || {};
  const images = inputBody.images || [];
  const imageUrl = images[0]?.image_url || images[0] || inputBody.image_url || inputBody.image;
  const imageUrls = (Array.isArray(images) && images.length ? images : imageUrl ? [imageUrl] : []).map((image) => typeof image === "string" ? image : image?.image_url).filter(Boolean);
  const context = { jobId: job.id, variables: pipeline.variables || {}, inputs: { prompt: inputBody.prompt, images, aspectRatio: inputBody.aspectRatio ?? "16:9", image_url: imageUrl, image_urls: imageUrls }, base_url: getGpt2ApiBaseUrl(), allowedEnv: new Set(envKeys), gatewayToken: job.payload?.token || "" };
  console.log(`[MediaWorker] Job ${job.id} selected ${type} pipeline "${pipeline.name || "unnamed"}" (${pipeline.steps.length} steps)`);
  for (const step of pipeline.steps) {
    if (!step || !["async_task", "request"].includes(step.type)) throw new Error("Invalid media pipeline step");
    console.log(`[MediaWorker] Job ${job.id} pipeline step ${step.id} (${step.type}) started`);
    const initial = await pipelineRequest(step, context);
    console.log(`[MediaWorker] Job ${job.id} pipeline step ${step.id} completed`);
    let finalResponse = initial;
    if (step.type === "async_task") {
      const taskId = pipelinePath(initial, step.request?.task_id_path);
      if (!taskId || !step.polling) throw new Error("Pipeline task ID missing");
      const poll = pipelineTemplate(step.polling, { ...context, [step.id]: { response: initial, task_id: taskId } });
      const deadline = Date.now() + Math.min(1800, Math.max(1, Number(poll.timeout_seconds) || 300)) * 1000;
      while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(remainingMs, Math.max(1, Number(poll.interval_seconds) || 3) * 1000)));
        if (Date.now() >= deadline) break;
        const response = await pipelineRequest({ request: { method: poll.method, url: poll.url, headers: poll.headers, body: poll.body } }, { ...context, [step.id]: { response: initial, task_id: taskId } }, Math.min(30000, deadline - Date.now()));
        const status = pipelinePath(response, poll.conditions?.success_path);
        console.log(`[MediaWorker] Job ${job.id} pipeline step ${step.id} poll status:`, status);
        if (status === poll.conditions?.success_value) { finalResponse = response; break; }
        if ((poll.conditions?.failed_value || []).includes(status)) throw new Error("Media pipeline task failed");
        finalResponse = response;
      }
      if (Date.now() >= deadline) throw new Error("Media pipeline polling timed out");
    }
    const outputs = Object.fromEntries(Object.entries(step.outputs || {}).map(([key, path]) => [key, pipelinePath(finalResponse, path)]));
    context[step.id] = { response: initial, outputs, task_id: context[step.id]?.task_id };
  }
  const result = pipelineTemplate(pipeline.final_response || {}, context);
  assertPipelineResultSafe(result, envKeys);
  await updateJob(job.id, { status: "completed", result, ...(Array.isArray(result.data) ? { data: result.data } : {}), ...(result.video_result ? { video_url: result.video_result } : {}) });
  return true;
}

async function processImageJob(job) {
  if (await processConfiguredPipeline(job, "image")) return;
  const { baseUrl = "", token = "", body = {} } = job.payload || {};
  const m = String(body?.model || "").toLowerCase();

  //tạm thời cho gpt 1 luồng riêng
  if (m === "gpt-image-2" || m.includes("gpt-image-2")) {
    return processGptImage2Task(job);
  }

  let result;
  const accessToken = body?.access_token;
  if (accessToken) {
    let codexSuccess = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await callCodexImage({
          ...body,
          access_token: accessToken,
        });
        codexSuccess = true;
        break;
      } catch {}
    }
    if (!codexSuccess) {
      const { access_token, ...fallbackBody } = body;
      result = await executeApiCall(
        baseUrl,
        token,
        "/images/generations",
        "POST",
        fallbackBody,
      );
    }
  } else {
    const { access_token, ...fallbackBody } = body;
    result = await executeApiCall(
      baseUrl,
      token,
      "/images/generations",
      "POST",
      fallbackBody,
    );
  }
  let finalData = result?.data || result;
  if (
    Array.isArray(finalData) &&
    finalData.length > 1 &&
    (m.includes("grok") || m.includes("ai2w"))
  ) {
    finalData = [finalData[finalData.length - 1]];
  }

  const uploaded = new Map();
  const uploadedData = await uploadInlineMediaTree(
    finalData,
    baseUrl,
    "png",
    "",
    uploaded,
  );
  const uploadedResult = await uploadInlineMediaTree(
    result,
    baseUrl,
    "png",
    "",
    uploaded,
  );
  await updateJob(job.id, {
    status: "completed",
    result: uploadedResult,
    data: uploadedData,
  });
}

async function processMevideoaiVideoJob(job) {
  const { baseUrl = "", requestBody = {} } = job.payload || {};
  console.log(`[MediaWorker] Submitting video job ${job.id} to Mevideoai...`);

  const { taskWorkerId, raw } = await submitMevideoaiVideo(requestBody);
  await updateJob(job.id, {
    upstreamId: taskWorkerId,
    taskId: taskWorkerId,
    status: "processing",
    upstreamTask: raw,
  });

  console.log(
    `[MediaWorker] Mevideoai job ${job.id} queued (taskWorkerId: ${taskWorkerId}), polling every 10s (max 180s)...`,
  );

  const startTime = Date.now();
  const maxPollMs = 180 * 1000;
  while (Date.now() - startTime < maxPollMs) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const pollResult = await pollMevideoaiTask(taskWorkerId);
      if (pollResult.status === "completed") {
        console.log(
          `[MediaWorker] Mevideoai job ${job.id} completed: ${pollResult.videoUrl}`,
        );
        const uploaded = new Map();
        const uploadedUrl = await uploadInlineMedia(
          pollResult.videoUrl,
          baseUrl,
          "mp4",
          true,
          uploaded,
        );
        await updateJob(job.id, {
          status: "completed",
          video_url: uploadedUrl,
          result: pollResult.raw,
        });
        return;
      }
      if (pollResult.status === "failed") {
        const cleaned = cleanErrorMessage(
          pollResult.error || "Video generation failed upstream",
        );
        console.warn(`[MediaWorker] Mevideoai job ${job.id} failed, stopping polling immediately:`, cleaned);
        await updateJob(job.id, {
          status: "failed",
          error: cleaned,
          result: pollResult.raw,
        });
        return;
      }
    } catch (pollErr) {
      console.warn(
        `[MediaWorker] Polling error for Mevideoai task ${taskWorkerId}:`,
        pollErr.message,
      );
    }
  }

  await updateJob(job.id, {
    status: "failed",
    error: "Video generation timed out after 180s",
  });
}

async function processVideoJob(job) {
  if (await processConfiguredPipeline(job, "video")) return;
  const { baseUrl = "", token = "", requestBody = {} } = job.payload || {};
  const model = String(requestBody.model || "").toLowerCase();

  if (model.includes("veo3")) {
    return processMevideoaiVideoJob(job);
  }

  const createRes = await executeApiCall(
    baseUrl,
    token,
    "/videos/generations",
    "POST",
    requestBody,
  );

  // Grok may return its completed payload directly or under `data`.
  const videoResult =
    createRes?.data && typeof createRes.data === "object"
      ? createRes.data
      : createRes;
  const directVideoUrl =
    videoResult?.video_url ||
    videoResult?.videoBase64 ||
    videoResult?.videoDataUrl ||
    videoResult?.videoUrl ||
    videoResult?.video?.url ||
    (typeof videoResult?.video === "string" ? videoResult.video : null) ||
    (videoResult?.status === "done" &&
      (videoResult?.video?.url ||
        videoResult?.videoUrl ||
        videoResult?.video)) ||
    videoResult?.url;

  if (directVideoUrl) {
    const finalUrl =
      typeof directVideoUrl === "string" ? directVideoUrl : directVideoUrl.url;
    console.log(
      `[MediaWorker] Video job ${job.id} (Grok) completed immediately with URL: ${finalUrl.slice(0, 100)}`,
    );
    const uploaded = new Map();
    const uploadedUrl = await uploadInlineMedia(
      finalUrl,
      baseUrl,
      "mp4",
      true,
      uploaded,
    );
    const uploadedResult = await uploadInlineMediaTree(
      createRes,
      baseUrl,
      "mp4",
      "",
      uploaded,
    );
    await updateJob(job.id, {
      status: "completed",
      video_url: uploadedUrl,
      result: uploadedResult,
    });
    return;
  }

  // Veo3 returns pollingId (or request_id), worker polls in background
  const upstreamId =
    createRes?.request_id || createRes?.pollingId || createRes?.id;
  if (!upstreamId) {
    throw new Error(createRes?.error || "No upstream job ID returned");
  }

  await updateJob(job.id, { upstreamId, status: "processing" });
  console.log(
    `[MediaWorker] Video job ${job.id} (Veo3) created upstream (${upstreamId}), worker polling background every 5s...`,
  );

  const startTime = Date.now();
  const maxPollMs = 15 * 60 * 1000;
  while (Date.now() - startTime < maxPollMs) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const pollRes = await executeApiCall(
        baseUrl,
        token,
        `/videos/${encodeURIComponent(upstreamId)}`,
        "GET",
      );
      const status = String(pollRes?.status || "").toLowerCase();
      if (
        status === "done" ||
        status === "completed" ||
        status === "succeeded"
      ) {
        const videoUrl =
          pollRes?.video?.url || pollRes?.videoUrl || pollRes?.url;
        const uploaded = new Map();
        const uploadedUrl = await uploadInlineMedia(
          videoUrl,
          baseUrl,
          "mp4",
          true,
          uploaded,
        );
        const uploadedResult = await uploadInlineMediaTree(
          pollRes,
          baseUrl,
          "mp4",
          "",
          uploaded,
        );
        await updateJob(job.id, {
          status: "completed",
          video_url: uploadedUrl,
          result: uploadedResult,
        });
        console.log(
          `[MediaWorker] Video job ${job.id} completed with URL: ${videoUrl}`,
        );
        return;
      }
      if (status === "failed" || status === "error") {
        const cleaned = cleanErrorMessage(
          pollRes?.error || "Video generation failed upstream",
        );
        await updateJob(job.id, {
          status: "failed",
          error: cleaned,
          result: pollRes,
        });
        return;
      }
    } catch (pollErr) {
      console.warn(
        `[MediaWorker] Polling error for job ${job.id}:`,
        pollErr.message,
      );
    }
  }
  await updateJob(job.id, {
    status: "failed",
    error: "Job timed out after 15 minutes",
  });
}

export async function waitForActiveWorkers(timeoutMs = 1500) {
  const start = Date.now();
  while (activeWorkers > 0 || localQueue.length > 0) {
    if (Date.now() - start > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 50));
  }
}
