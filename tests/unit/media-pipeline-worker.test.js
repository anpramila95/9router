import { afterEach, describe, expect, it } from "vitest";
import { allowedPipelineEnvKeys, assertPipelineResultSafe, pipelinePath, pipelineTemplate } from "../../src/lib/mediaPipelineHelpers.js";

afterEach(() => { delete process.env.PIPELINE_TEST_SECRET; });

describe("media pipeline helpers", () => {
  it("uses the server allowlist and preserves arrays", () => {
    process.env.MCP_MEDIA_ALLOWED_ENV_KEYS = "MEDIA_KEY, invalid-key";
    expect([...allowedPipelineEnvKeys()]).toEqual(["MEDIA_KEY"]);
    delete process.env.MCP_MEDIA_ALLOWED_ENV_KEYS;
    expect(pipelineTemplate("{{image.response.data}}", { image: { response: { data: [{ url: "x" }] } }, allowedEnv: new Set() })).toEqual([{ url: "x" }]);
  });

  it("keeps shared images and aspect ratio intact while exposing Codex image URLs", () => {
    const images = [{ image_url: "data:image/png;base64,abc" }];
    const inputs = { prompt: "edit", images, aspectRatio: "16:9", model: "shared-model", mode: "edit" };
    const codexBody = pipelineTemplate({ prompt: "{{inputs.prompt}}", images: "{{inputs.image_urls}}", aspectRatio: "{{inputs.aspectRatio}}" }, { inputs: { prompt: inputs.prompt, images: inputs.images, aspectRatio: inputs.aspectRatio, image_urls: inputs.images.map((image) => image.image_url) }, allowedEnv: new Set() });
    expect(inputs).toMatchObject({ images, aspectRatio: "16:9", model: "shared-model", mode: "edit" });
    expect(codexBody).toEqual({ prompt: "edit", images: ["data:image/png;base64,abc"], aspectRatio: "16:9" });
  });

  it("reads nested array paths", () => {
    expect(pipelinePath({ data: { task_result: { videos: [{ url: "https://cdn.example/video.mp4" }] } } }, "data.task_result.videos[0].url")).toBe("https://cdn.example/video.mp4");
  });

  it("interpolates configured values and only allowed env keys", () => {
    process.env.PIPELINE_TEST_SECRET = "secret-value";
    const context = { variables: { base_url: "https://api.example" }, inputs: { prompt: "hello" }, allowedEnv: new Set(["PIPELINE_TEST_SECRET"]) };
    expect(pipelineTemplate("{{variables.base_url}}/{{inputs.prompt}}/{{env.PIPELINE_TEST_SECRET}}", context)).toBe("https://api.example/hello/secret-value");
    expect(() => pipelineTemplate("{{env.PATH}}", context)).toThrow("Pipeline template value unavailable");
  });

  it("rejects secret-bearing results and never discloses a server message", () => {
    process.env.PIPELINE_TEST_SECRET = "secret-value";
    expect(() => assertPipelineResultSafe({ error: "secret-value" }, ["PIPELINE_TEST_SECRET"])).toThrow("Pipeline result contains a secret");
    expect(pipelinePath({}, "constructor.prototype.secret")).toBeUndefined();
  });
});
