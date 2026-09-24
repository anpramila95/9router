import Redis from "ioredis";
import axios from "axios";
import { makeKv } from "@/lib/db/helpers/kvStore.js";
import { notifyMediaError } from "@/lib/telegramNotifier.js";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const QUEUE_KEY = "mcp:media:jobs:queue";
const JOB_PREFIX = "mcp:media:job:";
const MAX_CONCURRENT_JOBS = 20;

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
  if (memoryCache.has(id)) return memoryCache.get(id);

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
  return null;
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
    } catch {}
  }

  await mcpJobsKv.set(id, updated);
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
    customTimeout ||
    (path.startsWith("/videos") ? 360 * 1000 : 120 * 1000);

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
  const { token = "", body = {} } = job.payload || {};
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

  let payload = {
    client_task_id: clientTaskId,
    prompt: body.prompt,
    model: "gpt-image-2",
    size: body.size || "1024x1024",
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

  console.log(
    `[MediaWorker] images: ${images.length ? "edits" : "generations"}`,
    payload,
  );

  const createRes = await fetch(
    `${gpt2ApiBase}/api/image-tasks/${images.length ? "edits" : "generations"}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  );

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

      if (!pollRes.ok) continue;

      const pollData = await pollRes.json();
      const item = pollData?.items?.[0];
      if (!item) continue;

      const status = String(item.status || "").toLowerCase();
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

        await updateJob(job.id, {
          status: "completed",
          data: finalData,
          result: item,
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

async function processImageJob(job) {
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

  await updateJob(job.id, {
    status: "completed",
    result,
    data: finalData,
  });
}

async function processVideoJob(job) {
  const { baseUrl = "", token = "", requestBody = {} } = job.payload || {};
  const createRes = await executeApiCall(
    baseUrl,
    token,
    "/videos/generations",
    "POST",
    requestBody,
  );

  // Grok may return its completed payload directly or under `data`.
  const videoResult = createRes?.data && typeof createRes.data === "object"
    ? createRes.data
    : createRes;
  const directVideoUrl =
    videoResult?.video_url ||
    videoResult?.videoUrl ||
    videoResult?.video?.url ||
    (typeof videoResult?.video === "string" ? videoResult.video : null) ||
    (videoResult?.status === "done" &&
      (videoResult?.video?.url || videoResult?.videoUrl || videoResult?.video)) ||
    videoResult?.url;

  if (directVideoUrl) {
    const finalUrl =
      typeof directVideoUrl === "string" ? directVideoUrl : directVideoUrl.url;
    console.log(
      `[MediaWorker] Video job ${job.id} (Grok) completed immediately with URL: ${finalUrl.slice(0, 100)}`,
    );
    await updateJob(job.id, {
      status: "completed",
      video_url: finalUrl,
      result: createRes,
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
        await updateJob(job.id, {
          status: "completed",
          video_url: videoUrl,
          result: pollRes,
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
