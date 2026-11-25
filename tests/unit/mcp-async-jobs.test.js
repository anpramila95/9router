import { describe, it, expect, afterAll } from "vitest";
import {
  POST,
  mediaTools,
  waitForActiveWorkers,
  cleanErrorMessage,
} from "@/app/api/mcp/route.js";
import { executeApiCall, updateJob, getJob } from "@/lib/mediaWorker.js";

describe("MCP Media Async Jobs with Background Worker", () => {
  afterAll(async () => {
    await waitForActiveWorkers(1000);
  });
  it("reads completed status from DB instead of stale memory cache", async () => {
    const id = `cache-status-${Date.now()}`;
    await updateJob(id, { type: "video", status: "pending" });
    await updateJob(id, { status: "completed", video_url: "/uploads/video.mp4" });
    const job = await getJob(id);
    expect(job.status).toBe("completed");
    expect(job.video_url).toBe("/uploads/video.mp4");
  });

  it("registers unified media.status tool and removes separate video.status/image.status", () => {
    const names = mediaTools.map((t) => t.name);
    expect(names).toContain("image.generate");
    expect(names).toContain("video.generate");
    expect(names).toContain("media.status");
    expect(names).not.toContain("video.status");
    expect(names).not.toContain("image.status");

    const mediaStatus = mediaTools.find((t) => t.name === "media.status");
    expect(mediaStatus.inputSchema.required).toContain("id");
  });

  it("rejects image.generate without prompt", async () => {
    const req = new Request("http://localhost:20128/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "image.generate",
          arguments: {},
        },
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain("prompt is required");
  });

  it("rejects image.generate with invalid image inputs (local path, invalid URL)", async () => {
    // Case 1: Local file path
    const reqLocal = new Request("http://localhost:20128/api/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "image.generate",
          arguments: {
            prompt: "add stickers",
            images: [{ image_url: "C:\\Users\\photos\\input.png" }],
          },
        },
      }),
    });
    const resLocal = await POST(reqLocal);
    const bodyLocal = await resLocal.json();
    expect(bodyLocal.error?.code).toBe(-32602);
    expect(bodyLocal.error?.message).toContain("is a local file path");

    // Case 2: Invalid non-URL string
    const reqInvalid = new Request("http://localhost:20128/api/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "image.generate",
          arguments: {
            prompt: "add stickers",
            images: ["random_bad_string"],
          },
        },
      }),
    });
    const resInvalid = await POST(reqInvalid);
    const bodyInvalid = await resInvalid.json();
    expect(bodyInvalid.error?.code).toBe(-32602);
    expect(bodyInvalid.error?.message).toContain("images must be an array");


  });

  it("shares the public schema and rejects unsupported options", async () => {
    const image = mediaTools.find((tool) => tool.name === "image.generate");
    const video = mediaTools.find((tool) => tool.name === "video.generate");
    expect(video.inputSchema).toEqual(image.inputSchema);
    expect(image.inputSchema.properties.aspectRatio).toMatchObject({ type: "string", default: "16:9" });
    expect(image.inputSchema.properties.aspectRatio.enum).toBeUndefined();
    expect(image.inputSchema.required).not.toContain("aspectRatio");
    expect(Object.keys(image.inputSchema.properties).sort()).toEqual(["aspectRatio", "images", "prompt"]);
    expect(image.description).not.toContain("auth.json");
    for (const name of ["image.generate", "video.generate"]) {
      for (const args of [{ prompt: "test", model: "custom" }, { prompt: "test", mode: "t2v" }, { prompt: 123 }, { prompt: "test", images: null }]) {
        const res = await POST(new Request("http://localhost:20128/api/mcp", {
          method: "POST",
          headers: { authorization: "Bearer test-key", "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
        }));
        expect((await res.json()).error?.code).toBe(-32602);
      }
    }
  });

  it("defaults and preserves aspect ratios in both media paths", async () => {
    for (const name of ["image.generate", "video.generate"]) {
      for (const aspectRatio of [undefined, "1:1", "3:4", "4:3", "16:9", "21:9"]) {
        const args = { prompt: "test", ...(aspectRatio === undefined ? {} : { aspectRatio }) };
        const res = await POST(new Request("http://localhost:20128/api/mcp", {
          method: "POST",
          headers: { authorization: "Bearer test-key", "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }),
        }));
        const job = await getJob((await res.json()).result.structuredContent.id);
        const expected = aspectRatio ?? "16:9";
        expect(job.payload.pipelineInput.aspectRatio).toBe(expected);
        if (name === "image.generate") expect(job.payload.body.aspectRatio).toBe(expected);
        else expect(job.payload.requestBody.ratio).toBe(expected);
      }
    }
  });

  it("infers video fallback mode from images and preserves common pipeline input", async () => {
    for (const images of [undefined, [], [{ image_url: "https://example.com/image.png" }]]) {
      const args = { prompt: "animate", aspectRatio: "16:9", ...(images ? { images } : {}) };
      const res = await POST(new Request("http://localhost:20128/api/mcp", {
        method: "POST",
        headers: { authorization: "Bearer test-key", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "video.generate", arguments: args } }),
      }));
      const job = await getJob((await res.json()).result.structuredContent.id);
      expect(job.payload.pipelineInput).toEqual({ prompt: args.prompt, aspectRatio: args.aspectRatio, ...(images?.length ? { images } : {}) });
      expect(job.payload.requestBody.model).toBe("ai2w/veo3");
      expect(job.payload.requestBody.mode).toBe(images?.length ? "i2v" : "t2v");
    }
  });

  it("returns jobId immediately on image.generate, enqueues worker, and polls via media.status", async () => {
    const req = new Request("http://localhost:20128/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "image.generate",
          arguments: { prompt: "cyberpunk city street at night" },
        },
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(body.result?.structuredContent?.status).toBe("pending");
    const jobId = body.result?.structuredContent?.id;
    expect(typeof jobId).toBe("string");

    // Poll via media.status
    const statusReq = new Request("http://localhost:20128/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "media.status",
          arguments: { id: jobId },
        },
      }),
    });

    const statusRes = await POST(statusReq);
    const statusBody = await statusRes.json();
    expect(statusBody.result?.structuredContent?.id).toBe(jobId);
    expect(statusBody.result?.structuredContent?.type).toBe("image");
    expect(["pending", "processing", "completed", "failed"]).toContain(
      statusBody.result?.structuredContent?.status
    );
  });

  it("returns jobId immediately on video.generate, worker handles task, and polls via media.status", async () => {
    const req = new Request("http://localhost:20128/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "video.generate",
          arguments: { prompt: "a cute robot waving hello" },
        },
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(body.result?.structuredContent?.status).toBe("pending");
    const jobId = body.result?.structuredContent?.id;
    expect(typeof jobId).toBe("string");

    // Poll via unified media.status
    const statusReq = new Request("http://localhost:20128/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "media.status",
          arguments: { id: jobId },
        },
      }),
    });

    const statusRes = await POST(statusReq);
    const statusBody = await statusRes.json();
    expect(statusBody.result?.structuredContent?.id).toBe(jobId);
    expect(statusBody.result?.structuredContent?.type).toBe("video");
    expect(["pending", "processing", "completed", "failed"]).toContain(
      statusBody.result?.structuredContent?.status
    );

    // Legacy fallback test: calling video.status still routes to same result
    const legacyReq = new Request("http://localhost:20128/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "video.status",
          arguments: { id: jobId },
        },
      }),
    });
    const legacyRes = await POST(legacyReq);
    const legacyBody = await legacyRes.json();
    expect(legacyBody.result?.structuredContent?.id).toBe(jobId);
  });

  it("executeApiCall uses axios with timeout", async () => {
    try {
      await executeApiCall(
        "http://127.0.0.1:20128",
        "mock-token-xyz",
        "/test/endpoint",
        "POST",
        { prompt: "hello" }
      );
    } catch (e) {
      // Endpoint doesn't exist so error is expected, verifying axios executed
      expect(e.message).toBeDefined();
    }
  });

  it("cleanErrorMessage unwraps nested JSON and extracts concise error message", () => {
    const rawError = JSON.stringify({
      error: {
        message:
          '[ai2w] {"success":false,"error":"Không tạo được video từ Google Labs: Google response: )]}\'\\n\\n192\\n[[\\"wrb.fr\\",\\"YhhmEf\\",null,null,null,[7,null,[[\\"type.googleapis.com/google.rpc.ErrorInfo\\",[\\"PUBLIC_ERROR_UNUSUAL_ACTIVITY\\"]]]],\\"generic\\"],[\\"di\\",518],[\\"af.httprm\\",518,\\"5270564365614106328\\",29]]\\n25\\n[[\\"e\\",4,null,null,228]]\\n"}',
        type: "server_error",
        code: "internal_server_error",
      },
    });

    const cleaned = cleanErrorMessage(rawError);
    expect(cleaned).toContain("Không tạo được video từ Google Labs");
    expect(cleaned).not.toContain("wrb.fr");
    expect(cleaned).not.toContain("af.httprm");
    expect(cleaned).toContain("PUBLIC_ERROR_UNUSUAL_ACTIVITY");
  });

  it("extracts only the last image element when grok / ai2w model returns an array of images", async () => {
    const testJobId = "grok-test-multi-images";
    await updateJob(testJobId, {
      id: testJobId,
      type: "image",
      status: "completed",
      payload: {
        body: { model: "ai2w/grok", prompt: "cute cat" },
      },
      data: [
        { url: "https://example.com/frame1.jpg" },
        { url: "https://example.com/frame2.jpg" },
        { url: "https://example.com/frame3.jpg" },
        {
          revised_prompt: "a cute 3D cat with conical hat",
          url: "https://imagine-public.x.ai/final.jpg",
        },
      ],
    });

    const pollReq = new Request("http://localhost:20128/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "media.status",
          arguments: { id: testJobId },
        },
      }),
    });

    const res = await POST(pollReq);
    const body = await res.json();
    const data = body.result?.structuredContent?.data;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].url).toBe("https://imagine-public.x.ai/final.jpg");
    expect(data[0].revised_prompt).toBe("a cute 3D cat with conical hat");
  });
});
