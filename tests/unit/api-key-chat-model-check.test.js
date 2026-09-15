import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApiKey, deleteApiKey } from "../../src/lib/db/repos/apiKeysRepo.js";
import { handleChat } from "../../src/sse/handlers/chat.js";

describe("API Key Model Restriction on Chat Completions", () => {
  let restrictedKey;
  let unrestrictedKey;

  beforeEach(async () => {
    restrictedKey = await createApiKey("Restricted Chat Key", "mach-1", {
      models: ["openai/gpt-4o", "claude-3-5-sonnet"],
    });
    unrestrictedKey = await createApiKey("Unrestricted Chat Key", "mach-1");
  });

  afterEach(async () => {
    if (restrictedKey?.id) {
      try { await deleteApiKey(restrictedKey.id); } catch {}
    }
    if (unrestrictedKey?.id) {
      try { await deleteApiKey(unrestrictedKey.id); } catch {}
    }
  });

  it("blocks requests with 403 when model is not in key's allowed models list", async () => {
    const req = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${restrictedKey.key}`,
      },
      body: JSON.stringify({
        model: "gemini/gemini-2.0-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const res = await handleChat(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error?.message).toContain("not allowed for this API key");
  });

  it("passes model check when model is in key's allowed models list", async () => {
    const req = new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${restrictedKey.key}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const res = await handleChat(req);
    // Not 403 forbidden (may fail upstream/credentials with 503 or 400, but auth/model check passes)
    expect(res.status).not.toBe(403);
  });
});
