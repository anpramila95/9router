import { describe, it, expect } from "vitest";
import { getExecutor } from "open-sse/executors/index.js";

describe("Antigravity Image Config & Resolution", () => {
  const executor = getExecutor("antigravity");

  it("maps size: 1920x1080 to aspectRatio 16:9 in transformRequest", () => {
    const transformed = executor.transformRequest(
      "gemini-3.1-flash-image",
      {
        contents: [{ role: "user", parts: [{ text: "A cute cat" }] }],
        size: "1920x1080",
      },
      false,
      { projectId: "test-proj" }
    );

    expect(transformed.request.generationConfig.imageConfig.aspectRatio).toBe("16:9");
    expect(transformed.model).toBe("gemini-3.1-flash-image");
  });

  it("maps size: 1080x1920 to aspectRatio 9:16", () => {
    const transformed = executor.transformRequest(
      "gemini-3.1-flash-image",
      {
        contents: [{ role: "user", parts: [{ text: "A cute cat" }] }],
        size: "1080x1920",
      },
      false,
      { projectId: "test-proj" }
    );

    expect(transformed.request.generationConfig.imageConfig.aspectRatio).toBe("9:16");
  });

  it("maps aspectRatio: 16:9 directly", () => {
    const transformed = executor.transformRequest(
      "gemini-3.1-flash-image",
      {
        contents: [{ role: "user", parts: [{ text: "A cute cat" }] }],
        aspectRatio: "16:9",
      },
      false,
      { projectId: "test-proj" }
    );

    expect(transformed.request.generationConfig.imageConfig.aspectRatio).toBe("16:9");
  });

  it("extracts aspect ratio from model name suffix if size is not provided or auto", () => {
    const transformed = executor.transformRequest(
      "gemini-3.1-flash-image-16x9",
      {
        contents: [{ role: "user", parts: [{ text: "A cute cat" }] }],
        size: "auto",
      },
      false,
      { projectId: "test-proj" }
    );

    expect(transformed.request.generationConfig.imageConfig.aspectRatio).toBe("16:9");
    expect(transformed.model).toBe("gemini-3.1-flash-image");
  });

  it("maps 1024x768 to 4:3", () => {
    const transformed = executor.transformRequest(
      "gemini-3.1-flash-image",
      {
        contents: [{ role: "user", parts: [{ text: "A cute cat" }] }],
        size: "1024x768",
      },
      false,
      { projectId: "test-proj" }
    );

    expect(transformed.request.generationConfig.imageConfig.aspectRatio).toBe("4:3");
  });

  it("preserves inlineData for image editing", () => {
    const transformed = executor.transformRequest(
      "gemini-3.1-flash-image",
      {
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/png", data: "base64..." } },
              { text: "Add a hat" },
            ],
          },
        ],
      },
      false,
      { projectId: "test-proj" }
    );

    expect(transformed.request.contents[0].parts.length).toBe(2);
    expect(transformed.request.contents[0].parts[0].inlineData).toBeDefined();
    expect(transformed.request.contents[0].parts[1].text).toBe("Add a hat");
  });
});
