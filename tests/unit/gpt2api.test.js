import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";

const originalFetch = global.fetch;

describe("GPT2API provider", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("is registered in REGISTRY with alias g2a and correct models", () => {
    const entry = REGISTRY.find((p) => p.id === "gpt2api");
    expect(entry).toBeDefined();
    expect(entry.alias).toBe("gpt2api");
    expect(entry.aliases).toContain("g2a");
    expect(entry.models.map((m) => m.id)).toEqual(["gpt-image-2", "tts-hd"]);
  });

  it("handles image generation for gpt-image-2", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1700000000,
          data: [
            {
              b64_json: "dGVzdC1iYXNlNjQtaW1hZ2U=",
              revised_prompt: "Mèo phi hành gia trôi dạt trong vũ trụ...",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 1000, total_tokens: 1012 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await handleImageGenerationCore({
      body: {
        prompt: "Mèo phi hành gia",
        size: "1024x1024",
        quality: "auto",
        response_format: "b64_json",
        images: [{ image_url: "https://example.com/input.png" }],
      },
      modelInfo: { provider: "gpt2api", model: "gpt-image-2" },
      credentials: { apiKey: "test-token" },
    });

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.data[0].b64_json).toBe("dGVzdC1iYXNlNjQtaW1hZ2U=");

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("http://localhost:3000/v1/images/generations");
    expect(options.headers.Authorization).toBe("Bearer test-token");
    const sentBody = JSON.parse(options.body);
    expect(sentBody.model).toBe("gpt-image-2");
    expect(sentBody.prompt).toBe("Mèo phi hành gia");
    expect(sentBody.images).toEqual([{ image_url: "https://example.com/input.png" }]);
  });

  it("handles custom dynamic baseUrl for image and audio", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          created: 1700000000,
          data: [{ b64_json: "custom-img" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await handleImageGenerationCore({
      body: { prompt: "test custom endpoint" },
      modelInfo: { provider: "gpt2api", model: "gpt-image-2" },
      credentials: { apiKey: "test-token", providerSpecificData: { baseUrl: "https://my-custom-gpt2api.com" } },
    });

    expect(global.fetch.mock.calls[0][0]).toBe("https://my-custom-gpt2api.com/v1/images/generations");

    global.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "speech-123",
          audio: "custom-audio",
          format: "mp3",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await handleTtsCore({
      provider: "gpt2api",
      model: "tts-hd",
      input: "test custom tts",
      credentials: { apiKey: "test-token", providerSpecificData: { baseUrl: "https://my-custom-gpt2api.com/v1" } },
      responseFormat: "json",
    });

    expect(global.fetch.mock.calls[1][0]).toBe("https://my-custom-gpt2api.com/v1/audio/speech");
  });
});
