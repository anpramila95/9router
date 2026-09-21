import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  saveUploadedFile,
  cleanupUploads,
  detectMediaType,
  UPLOADS_DIR,
} from "@/lib/uploadService.js";
import { POST } from "@/app/api/mcp/route.js";
import { GET as getUploadFile } from "@/app/api/uploads/[filename]/route.js";

describe("uploadService", () => {
  const sample1x1Png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

  it("detects PNG magic bytes", () => {
    const type = detectMediaType(sample1x1Png);
    expect(type).not.toBeNull();
    expect(type?.ext).toBe("png");
    expect(type?.mime).toBe("image/png");
  });

  it("saves base64 data URI and returns public URL", async () => {
    const dataUri = `data:image/png;base64,${sample1x1Png.toString("base64")}`;
    const url = await saveUploadedFile(dataUri, {}, "http://localhost:20128");

    expect(url).toMatch(/^http:\/\/localhost:20128\/uploads\/[0-9a-f-]+\.png$/);
    const filename = url.split("/").pop();
    const filePath = path.join(UPLOADS_DIR, filename);

    expect(fs.existsSync(filePath)).toBe(true);
    const readBuf = fs.readFileSync(filePath);
    expect(readBuf.length).toBe(sample1x1Png.length);

    // Cleanup
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  it("saves raw Base64 string", async () => {
    const rawBase64 = sample1x1Png.toString("base64");
    const url = await saveUploadedFile(rawBase64, { format: "png" });

    expect(url).toMatch(/^\/uploads\/[0-9a-f-]+\.png$/);
    const filename = url.split("/").pop();
    const filePath = path.join(UPLOADS_DIR, filename);

    expect(fs.existsSync(filePath)).toBe(true);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  it("rejects empty or invalid payload", async () => {
    await expect(saveUploadedFile("")).rejects.toThrow("Missing upload content");
    await expect(saveUploadedFile("abc")).rejects.toThrow("Invalid image data");
  });

  it("cleans up expired files", () => {
    const testFile = path.join(UPLOADS_DIR, `test-expired-${Date.now()}.png`);
    fs.writeFileSync(testFile, sample1x1Png);

    // Backdate mtime by 31 minutes
    const pastTime = (Date.now() - 31 * 60 * 1000) / 1000;
    fs.utimesSync(testFile, pastTime, pastTime);

    const res = cleanupUploads(30 * 60 * 1000);
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(testFile)).toBe(false);
  });

  it("handles MCP tools/call image.upload.getUrl and serves uploaded file", async () => {
    const dataUri = `data:image/png;base64,${sample1x1Png.toString("base64")}`;
    const req = new Request("http://localhost:20128/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "image.upload.getUrl",
          arguments: {
            image: dataUri,
          },
        },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBeDefined();

    const parsedContent = JSON.parse(body.result.content[0].text);
    expect(parsedContent.url).toMatch(/^http:\/\/localhost:20128\/uploads\/[0-9a-f-]+\.png$/);

    const filename = parsedContent.url.split("/").pop();
    const fileReq = new Request(`http://localhost:20128/uploads/${filename}`);
    const fileRes = await getUploadFile(fileReq, { params: Promise.resolve({ filename }) });
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("content-type")).toBe("image/png");

    const fileBuf = Buffer.from(await fileRes.arrayBuffer());
    expect(fileBuf.length).toBe(sample1x1Png.length);
  });
});
