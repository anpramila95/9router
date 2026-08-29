import { describe, it, expect, beforeEach } from "vitest";
import { createApiKey, getApiKeyLimitStatus, getApiKeys, deleteApiKey } from "../../src/lib/db/repos/apiKeysRepo.js";
import { saveRequestUsage } from "../../src/lib/db/repos/usageRepo.js";

describe("API Key Media Limits (Image / Video per day)", () => {
  let createdKey;

  beforeEach(async () => {
    createdKey = await createApiKey("Test Media Key", "mach-1", {
      limitImageDaily: 2,
      limitVideoDaily: 1,
    });
  });

  it("enforces daily image limit", async () => {
    // 0 images -> allowed
    let status = await getApiKeyLimitStatus(createdKey.key, "image");
    expect(status.allowed).toBe(true);

    // Save 1 image request
    await saveRequestUsage({
      provider: "ai2w",
      model: "banana-pro",
      apiKey: createdKey.key,
      endpoint: "/v1/images/generations",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "ok",
    });

    status = await getApiKeyLimitStatus(createdKey.key, "image");
    expect(status.allowed).toBe(true);

    // Save 2nd image request -> reaches limit of 2
    await saveRequestUsage({
      provider: "ai2w",
      model: "banana-pro",
      apiKey: createdKey.key,
      endpoint: "/v1/images/generations",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "ok",
    });

    status = await getApiKeyLimitStatus(createdKey.key, "image");
    expect(status.allowed).toBe(false);
    expect(status.message).toContain("Image daily limit exceeded");
  });

  it("enforces daily video limit", async () => {
    // 0 videos -> allowed
    let status = await getApiKeyLimitStatus(createdKey.key, "video");
    expect(status.allowed).toBe(true);

    // Save 1 video request -> reaches limit of 1
    await saveRequestUsage({
      provider: "ai2w",
      model: "veo3",
      apiKey: createdKey.key,
      endpoint: "/v1/videos/generations",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      status: "ok",
    });

    status = await getApiKeyLimitStatus(createdKey.key, "video");
    expect(status.allowed).toBe(false);
    expect(status.message).toContain("Video daily limit exceeded");
  });
});
