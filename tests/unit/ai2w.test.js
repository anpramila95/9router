import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { handleVideoProxyCore } from "../../open-sse/handlers/videoCore.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";

const originalFetch = global.fetch;

describe("AI2W (AIVideoWorkflow) provider", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("is registered in REGISTRY with alias ai2w and models", () => {
    const entry = REGISTRY.find((p) => p.id === "ai2w");
    expect(entry).toBeDefined();
    expect(entry.alias).toBe("ai2w");
    expect(entry.aliases).toContain("aivideoworkflow");
    expect(entry.models.map((m) => m.id)).toEqual(["banana-2", "banana-pro", "grok", "veo3", "grok-video"]);
  });

  it("handles image generation for banana-pro via /api/labs/generate-image", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          pollingId: "lab_img_abc123",
          media: [
            {
              url: "https://example.com/image.png",
              status: "completed",
              seed: 1001,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "A cinematic cat warrior, 16:9",
        aspectRatio: "16:9",
        images: [{ image_url: "data:image/png;base64,QUJD" }],
      },
      modelInfo: { provider: "ai2w", model: "banana-pro" },
      credentials: { apiKey: "test-token", providerSpecificData: { baseUrl: "http://localhost:3000" } },
    });

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.data[0].url).toBe("https://example.com/image.png");

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/labs/generate-image");
    expect(options.headers.Authorization).toBe("Bearer test-token");
    const sentBody = JSON.parse(options.body);
    expect(sentBody.model).toBe("banana-pro");
    expect(sentBody.prompt).toBe("A cinematic cat warrior, 16:9");
    expect(sentBody.aspectRatio).toBe("16:9");
    expect(sentBody.images).toEqual(["QUJD"]);
  });

  it("converts reference images to plain base64 array for labs", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, media: [{ url: "https://example.com/out.png" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "A cat",
        aspectRatio: "16:9",
        images: [{ image_url: "data:image/png;base64,QUJD" }, { image_url: "data:image/png;base64,REVG" }],
      },
      modelInfo: { provider: "ai2w", model: "banana-pro" },
      credentials: { apiKey: "test-token", providerSpecificData: { baseUrl: "http://localhost:3000" } },
    });

    expect(result.success).toBe(true);
    const [url, opts] = global.fetch.mock.calls[0];
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.images).toEqual(["QUJD", "REVG"]);
    expect(sentBody.aspectRatio).toBe("16:9");
  });

  it("normalizes comma-separated string images to base64 array", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, media: [{ url: "https://example.com/out.png" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "A cat",
        aspectRatio: "16:9",
        images: "QUJD, REVG",
      },
      modelInfo: { provider: "ai2w", model: "banana-pro" },
      credentials: { apiKey: "test-token", providerSpecificData: { baseUrl: "http://localhost:3000" } },
    });

    expect(result.success).toBe(true);
    const [url, opts] = global.fetch.mock.calls[0];
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.images).toEqual(["QUJD", "REVG"]);
    expect(sentBody.aspectRatio).toBe("16:9");
  });

  it("handles video creation for veo3 via /api/labs/generate-video and polling via /api/labs/poll-batch", async () => {
    // 1. Create job
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          pollingId: "lab_video_abc123",
          projectId: "project_abc123",
          operations: [
            {
              name: "operations/video_abc123",
              sceneId: "scene_001",
              workflowId: "workflow_abc123",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const createRes = await handleVideoProxyCore({
      provider: "ai2w",
      action: "generations",
      model: "veo3",
      rawBody: JSON.stringify({
        prompt: "A cinematic monkey walking through a neon city",
        aspectRatio: "16:9",
        images: [{ image_url: "base64_image_data" }],
      }),
      credentials: { apiKey: "test-token", providerSpecificData: { baseUrl: "http://localhost:3000" } },
    });

    expect(createRes.success).toBe(true);
    const createData = await createRes.response.json();
    expect(createData.pollingId).toBe("lab_video_abc123");

    const [createUrl, createOpts] = global.fetch.mock.calls[0];
    expect(createUrl).toBe("http://localhost:3000/api/labs/generate-video");
    const sentCreateBody = JSON.parse(createOpts.body);
    expect(sentCreateBody.model).toBe("veo-3.1-lite-relax-ultra");
    expect(sentCreateBody.mode).toBe("image-to-video");
    expect(sentCreateBody.images).toEqual(["base64_image_data"]);

    // 2. Poll job
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          mediaItems: [
            {
              name: "media/generated_video_abc123",
              downloadUrl: "https://example.com/video.mp4",
              status: "MEDIA_GENERATION_STATUS_SUCCESSFUL",
              accountId: "account_abc123",
              projectId: "project_abc123",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const pollRes = await handleVideoProxyCore({
      provider: "ai2w",
      requestId: "lab_video_abc123",
      credentials: { apiKey: "test-token", providerSpecificData: { baseUrl: "http://localhost:3000" } },
    });

    expect(pollRes.success).toBe(true);
    const pollData = await pollRes.response.json();
    expect(pollData.status).toBe("done");
    expect(pollData.video.url).toBe("https://example.com/video.mp4");

    const [pollUrl, pollOpts] = global.fetch.mock.calls[1];
    expect(pollUrl).toBe("http://localhost:3000/api/labs/poll-batch");
    const sentPollBody = JSON.parse(pollOpts.body);
    expect(sentPollBody.pollingId).toBe("lab_video_abc123");
  });

  it("handles video creation for grok-video directly returning videoUrl", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          videoUrl: "https://example.com/grok_video.mp4",
          videoBase64: "base64_data",
          videoDataUrl: "data:video/mp4;base64,...",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleVideoProxyCore({
      provider: "ai2w",
      action: "generations",
      model: "grok-video",
      rawBody: JSON.stringify({
        prompt: "Grok cinematic video",
        images: [{ image_url: "base64" }],
        aspectRatio: "16:9",
        videoLength: 10,
        resolutionName: "720p",
      }),
      credentials: { apiKey: "test-token", providerSpecificData: { baseUrl: "http://localhost:3000" } },
    });

    expect(result.success).toBe(true);
    const data = await result.response.json();
    expect(data.status).toBe("done");
    expect(data.video.url).toBe("https://example.com/grok_video.mp4");

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/grok/generate-video");
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.videoLength).toBe(10);
    expect(sentBody.resolutionName).toBe("720p");
    expect(sentBody.images).toEqual(["base64"]);
  });

  it("normalizes comma-separated string images for video", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, pollingId: "lab_video_xyz" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const createRes = await handleVideoProxyCore({
      provider: "ai2w",
      action: "generations",
      model: "veo3",
      rawBody: JSON.stringify({
        prompt: "A cat",
        aspectRatio: "9:16",
        mode: "image-to-video",
        images: "https://example.com/a.png, https://example.com/b.png",
      }),
      credentials: { apiKey: "test-token", providerSpecificData: { baseUrl: "http://localhost:3000" } },
    });

    expect(createRes.success).toBe(true);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/labs/generate-video");
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.mode).toBe("image-to-video");
    expect(sentBody.images).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
  });
});
