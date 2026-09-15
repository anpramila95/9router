import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApiKey, updateApiKey, getApiKeyById, getApiKeyByKey, deleteApiKey } from "../../src/lib/db/repos/apiKeysRepo.js";
import { GET as getModels } from "../../src/app/api/v1/models/route.js";

describe("API Key Allowed Models", () => {
  let createdKey;

  afterEach(async () => {
    if (createdKey?.id) {
      try { await deleteApiKey(createdKey.id); } catch {}
    }
  });

  it("stores and normalizes allowed models on creation and update", async () => {
    createdKey = await createApiKey("Restricted Key", "mach-1", {
      models: ["openai/gpt-4o", "claude-3-5-sonnet", ""],
    });

    expect(createdKey.models).toEqual(["openai/gpt-4o", "claude-3-5-sonnet"]);

    const fromDb = await getApiKeyById(createdKey.id);
    expect(fromDb.models).toEqual(["openai/gpt-4o", "claude-3-5-sonnet"]);

    const fromDbByKey = await getApiKeyByKey(createdKey.key);
    expect(fromDbByKey.models).toEqual(["openai/gpt-4o", "claude-3-5-sonnet"]);

    // Update models
    const updated = await updateApiKey(createdKey.id, { models: ["claude-3-5-sonnet"] });
    expect(updated.models).toEqual(["claude-3-5-sonnet"]);

    // Clear models (empty array or null -> null, allowing all models)
    const cleared = await updateApiKey(createdKey.id, { models: [] });
    expect(cleared.models).toBeNull();
  });

  it("filters /v1/models by key allowed models and enforces auth", async () => {
    createdKey = await createApiKey("Filter Key", "mach-1", {
      models: ["gpt-4o"],
    });

    // Unauthenticated request -> 401 Missing API key
    const unauthReq = new Request("http://localhost:20128/v1/models");
    const unauthRes = await getModels(unauthReq);
    expect(unauthRes.status).toBe(401);
    const unauthData = await unauthRes.json();
    expect(unauthData.error?.message).toBe("Missing API key");

    // Invalid key request -> 401 Invalid API key
    const invalidReq = new Request("http://localhost:20128/v1/models", {
      headers: { Authorization: "Bearer sk-invalid-key" },
    });
    const invalidRes = await getModels(invalidReq);
    expect(invalidRes.status).toBe(401);
    const invalidData = await invalidRes.json();
    expect(invalidData.error?.message).toBe("Invalid API key");

    // Authenticated request with restricted key -> 200 and filtered
    const authReq = new Request("http://localhost:20128/v1/models", {
      headers: { Authorization: `Bearer ${createdKey.key}` },
    });
    const authRes = await getModels(authReq);
    expect(authRes.status).toBe(200);
    const authData = await authRes.json();
    expect(Array.isArray(authData.data)).toBe(true);
    for (const m of authData.data) {
      expect(m.id).toBe("gpt-4o");
    }

    // Unrestricted key -> 200 and all models
    const allModelsKey = await createApiKey("All Models Key", "mach-1");
    try {
      const allRes = await getModels(new Request("http://localhost:20128/v1/models", {
        headers: { Authorization: `Bearer ${allModelsKey.key}` },
      }));
      expect(allRes.status).toBe(200);
      const allData = await allRes.json();
      expect(Array.isArray(allData.data)).toBe(true);
    } finally {
      await deleteApiKey(allModelsKey.id);
    }
  });
});
