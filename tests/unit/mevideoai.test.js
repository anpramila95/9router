import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeRatio,
  pollMevideoaiTask,
  submitMevideoaiVideo,
  uploadAssetToMevideoai,
  _resetSessionCacheForTesting,
} from "@/lib/mevideoai.js";
import { makeKv } from "@/lib/db/helpers/kvStore.js";

const mevideoaiKv = makeKv("mevideoai");

describe("mevideoai", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    global.fetch = vi.fn();
    _resetSessionCacheForTesting();
    await mevideoaiKv.remove("session").catch(() => {});
  });
  describe("normalizeRatio", () => {
    it("maps 16:9 and landscape formats to landscape", () => {
      expect(normalizeRatio("16:9")).toBe("landscape");
      expect(normalizeRatio("16/9")).toBe("landscape");
      expect(normalizeRatio("landscape")).toBe("landscape");
      expect(normalizeRatio("1920:1080")).toBe("landscape");
      expect(normalizeRatio("4:3")).toBe("landscape");
    });

    it("maps 9:16 and portrait formats to portrait", () => {
      expect(normalizeRatio("9:16")).toBe("portrait");
      expect(normalizeRatio("9/16")).toBe("portrait");
      expect(normalizeRatio("portrait")).toBe("portrait");
      expect(normalizeRatio("1080:1920")).toBe("portrait");
      expect(normalizeRatio("3:4")).toBe("portrait");
    });

    it("defaults to portrait if empty", () => {
      expect(normalizeRatio("")).toBe("portrait");
      expect(normalizeRatio(null)).toBe("portrait");
      expect(normalizeRatio(undefined)).toBe("portrait");
    });
  });

  describe("pollMevideoaiTask parsing", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it("parses completed task response with videoUrl", async () => {
      // Mock login fetch first
      global.fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "set-cookie": "kc_session=fake-session; kc_session_exp=123",
            },
          })
        )
        // Mock poll task fetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                id: "task-123",
                status: "completed",
                videoUrl: "https://flow-content.google/video/test.mp4",
                errorMessage: null,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );

      const res = await pollMevideoaiTask("task-123");
      expect(res.status).toBe("completed");
      expect(res.videoUrl).toBe("https://flow-content.google/video/test.mp4");
    });

    it("retries on 401 by getting a new cookie and succeeds", async () => {
      global.fetch
        // Initial login succeeds
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "set-cookie": "kc_session=old-session; kc_session_exp=123",
            },
          })
        )
        // First poll gets 401
        .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
        // Refresh login call gets new cookie
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "set-cookie": "kc_session=refreshed-session; kc_session_exp=456",
            },
          })
        )
        // Retry poll succeeds
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                id: "task-401",
                status: "completed",
                videoUrl: "https://flow-content.google/video/refreshed.mp4",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );

      const res = await pollMevideoaiTask("task-401");
      expect(res.status).toBe("completed");
      expect(res.videoUrl).toBe("https://flow-content.google/video/refreshed.mp4");
      // Verified retry header had refreshed cookie
      const retryCallHeaders = global.fetch.mock.calls[3][1].headers;
      const retryCookie = typeof retryCallHeaders.get === "function"
        ? retryCallHeaders.get("Cookie")
        : retryCallHeaders.Cookie;
      expect(retryCookie).toContain("kc_session=refreshed-session");
    });
  });

  describe("submitMevideoaiVideo", () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it("submits text-to-video request", async () => {
      // Login mock
      global.fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "set-cookie": "kc_session=test-session; kc_session_exp=123",
            },
          })
        )
        // Submit mock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              success: true,
              taskWorkerId: "worker-t2v-1",
              jobId: "1001",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );

      const result = await submitMevideoaiVideo({
        prompt: "đức phật đôn hoàng",
        aspectRatio: "16:9",
      });

      expect(result.taskWorkerId).toBe("worker-t2v-1");
      const submitCall = global.fetch.mock.calls[1];
      expect(submitCall[0]).toContain("/api/proxy/v3/video/generate/text");
      const body = JSON.parse(submitCall[1].body);
      expect(body.ratio).toBe("landscape");
      expect(body.videoModel).toBe("veo3LiteLowPriority");
      expect(body.prompt).toBe("đức phật đôn hoàng");
    });

    it("submits image-to-video request with pre-uploaded library ID", async () => {
      global.fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "set-cookie": "kc_session=test-session; kc_session_exp=123",
            },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              success: true,
              taskWorkerId: "worker-i2v-1",
              jobId: "1002",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );

      const result = await submitMevideoaiVideo({
        prompt: "cozy podcast",
        mode: "i2v",
        ratio: "9:16",
        images: [{ image_url: "library:41423e49-6366-4415-bc2f-0b4196f7a763" }],
      });

      expect(result.taskWorkerId).toBe("worker-i2v-1");
      const submitCall = global.fetch.mock.calls[1];
      expect(submitCall[0]).toContain("/api/proxy/v3/video/generate/image");
      const body = JSON.parse(submitCall[1].body);
      expect(body.ratio).toBe("portrait");
      expect(body.imageBase64).toBe("library:41423e49-6366-4415-bc2f-0b4196f7a763");
    });

    it("submits reference-to-video request with library ID", async () => {
      global.fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "set-cookie": "kc_session=test-session; kc_session_exp=123",
            },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              success: true,
              taskWorkerId: "worker-r2v-1",
              jobId: "1003",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );

      const result = await submitMevideoaiVideo({
        prompt: "cozy podcast",
        mode: "r2v",
        aspectRatio: "16:9",
        images: [{ image_url: "library:41423e49-6366-4415-bc2f-0b4196f7a763" }],
      });

      expect(result.taskWorkerId).toBe("worker-r2v-1");
      const submitCall = global.fetch.mock.calls[1];
      expect(submitCall[0]).toContain("/api/proxy/v3/video/generate/reference");
      const body = JSON.parse(submitCall[1].body);
      expect(body.ratio).toBe("landscape");
      expect(body.referenceImages).toEqual([
        { imageBase64: "library:41423e49-6366-4415-bc2f-0b4196f7a763" },
      ]);
    });
  });

  describe("uploadAssetToMevideoai", () => {
    it("returns library ID directly if already in library: format", async () => {
      const res = await uploadAssetToMevideoai("library:abc-123");
      expect(res).toBe("library:abc-123");
    });

    it("uploads buffer to library assets and returns library:ID", async () => {
      global.fetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "set-cookie": "kc_session=test-session; kc_session_exp=123",
            },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: "uploaded-asset-999",
              status: "ready",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );

      const buf = Buffer.from("fake-png-content");
      const res = await uploadAssetToMevideoai(buf);
      expect(res).toBe("library:uploaded-asset-999");

      const uploadCall = global.fetch.mock.calls[1];
      expect(uploadCall[0]).toContain("/api/proxy/library/assets");
      const headers = uploadCall[1].headers;
      const cookieHeader = typeof headers.get === "function" ? headers.get("Cookie") : headers.Cookie;
      const idempotencyHeader = typeof headers.get === "function" ? headers.get("Idempotency-Key") : headers["Idempotency-Key"];
      expect(cookieHeader).toContain("kc_session=test-session");
      expect(idempotencyHeader).toBeDefined();
    });
  });
});
