import { describe, it, expect } from "vitest";
import { encodeState, decodeState } from "@/app/api/mcp/calendar/auth.js";
import { isCalendarTool, CALENDAR_TOOLS } from "@/app/api/mcp/calendar/tools.js";

describe("Google Calendar MCP", () => {
  it("encodes and decodes OAuth state with HMAC", () => {
    process.env.JWT_SECRET = "test-secret-key-12345";
    const state = encodeState({
      apiKeyId: "key_test_123",
      actionId: "act_456",
      redirectUri: "http://localhost:20127/mcp/calendar/callback",
    });

    expect(typeof state).toBe("string");
    expect(state.includes(".")).toBe(true);

    const decoded = decodeState(state);
    expect(decoded.apiKeyId).toBe("key_test_123");
    expect(decoded.actionId).toBe("act_456");
    expect(decoded.redirectUri).toBe("http://localhost:20127/mcp/calendar/callback");

    expect(() => decodeState("tampered.fakehmac")).toThrow();
  });

  it("registers all expected calendar tools", () => {
    expect(isCalendarTool("calendar.events.create")).toBe(true);
    expect(isCalendarTool("calendar.accounts.disconnect")).toBe(true);
    expect(isCalendarTool("image.generate")).toBe(false);

    const names = CALENDAR_TOOLS.map((t) => t.name);
    expect(names).toContain("calendar.events.list");
    expect(names).toContain("calendar.events.create");
    expect(names).toContain("calendar.events.get");
    expect(names).toContain("calendar.events.update");
    expect(names).toContain("calendar.events.delete");
    expect(names).toContain("calendar.freebusy.query");
    expect(names).toContain("calendar.accounts.list");
    expect(names).toContain("calendar.accounts.add");
    expect(names).toContain("calendar.accounts.disconnect");
    expect(names).toContain("calendar.pending.status");
    expect(CALENDAR_TOOLS.length).toBe(10);
  });
});
