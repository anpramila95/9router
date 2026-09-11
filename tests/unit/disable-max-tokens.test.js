import { describe, it, expect, vi } from "vitest";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { getExecutor } from "open-sse/executors/index.js";

describe("disableMaxTokens setting", () => {
  it("strips max_tokens and related fields when disableMaxTokens is true", async () => {
    let capturedBody = null;
    const executor = getExecutor("openai");
    const originalExecute = executor.execute.bind(executor);
    executor.execute = async (options) => {
      capturedBody = options.body;
      return {
        response: new Response(JSON.stringify({ choices: [] })),
        url: "http://example.com",
        headers: {},
        transformedBody: options.body
      };
    };

    try {
      await handleChatCore({
        body: {
          model: "openai/gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 1000,
          max_completion_tokens: 1000,
          max_output_tokens: 1000,
        },
        modelInfo: { provider: "openai", model: "gpt-4o" },
        credentials: { apiKey: "test" },
        disableMaxTokens: true,
      });

      expect(capturedBody).toBeDefined();
      expect(capturedBody.max_tokens).toBeUndefined();
      expect(capturedBody.max_completion_tokens).toBeUndefined();
      expect(capturedBody.max_output_tokens).toBeUndefined();
    } finally {
      executor.execute = originalExecute;
    }
  });

  it("preserves max_tokens when disableMaxTokens is false", async () => {
    let capturedBody = null;
    const executor = getExecutor("openai");
    const originalExecute = executor.execute.bind(executor);
    executor.execute = async (options) => {
      capturedBody = options.body;
      return {
        response: new Response(JSON.stringify({ choices: [] })),
        url: "http://example.com",
        headers: {},
        transformedBody: options.body
      };
    };

    try {
      await handleChatCore({
        body: {
          model: "openai/gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 1000,
        },
        modelInfo: { provider: "openai", model: "gpt-4o" },
        credentials: { apiKey: "test" },
        disableMaxTokens: false,
      });

      expect(capturedBody).toBeDefined();
      expect(capturedBody.max_tokens).toBeDefined();
    } finally {
      executor.execute = originalExecute;
    }
  });
});
