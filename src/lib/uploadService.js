import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function resolvePublicUploadsDir() {
  const candidates = [
    path.join(process.cwd(), "public", "uploads"),
    path.resolve("public/uploads"),
  ];
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) {
        fs.mkdirSync(c, { recursive: true });
      }
      return c;
    } catch {}
  }
  return path.join(process.cwd(), "public", "uploads");
}

export const UPLOADS_DIR = resolvePublicUploadsDir();

// Ensure directory exists
export function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  return UPLOADS_DIR;
}

/**
 * Detect image/media format from buffer magic bytes
 */
export function detectMediaType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;

  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  // GIF: 47 49 46 38 ("GIF8")
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { ext: "gif", mime: "image/gif" };
  }
  // WEBP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  // MP4: ....ftyp
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
    return { ext: "mp4", mime: "video/mp4" };
  }
  // SVG: <svg or <?xml
  const head = buf.slice(0, 100).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return { ext: "svg", mime: "image/svg+xml" };
  }

  return null;
}

export function getMimeByExt(ext) {
  switch (String(ext || "").toLowerCase().replace(/^\./, "")) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

/**
 * Validate and save an uploaded media file to server storage
 */
export async function saveUploadedFile(content, options = {}, baseUrl = "") {
  if (!content) {
    throw new Error("Missing upload content");
  }

  let bytes;
  let detectedExt = options.format || options.extension;

  if (Buffer.isBuffer(content)) {
    bytes = content;
  } else if (content instanceof Uint8Array || content instanceof ArrayBuffer) {
    bytes = Buffer.from(content);
  } else if (typeof content === "object" && typeof content?.arrayBuffer === "function") {
    bytes = Buffer.from(await content.arrayBuffer());
    if (content.type && !detectedExt) {
      if (content.type.includes("png")) detectedExt = "png";
      else if (content.type.includes("jpeg") || content.type.includes("jpg")) detectedExt = "jpg";
      else if (content.type.includes("webp")) detectedExt = "webp";
      else if (content.type.includes("gif")) detectedExt = "gif";
      else if (content.type.includes("mp4")) detectedExt = "mp4";
    }
  } else if (typeof content === "string") {
    const trimmed = content.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      const res = await fetch(trimmed);
      if (!res.ok) {
        throw new Error(`Failed to download input URL (${res.status}): ${trimmed}`);
      }
      const cType = res.headers.get("content-type") || "";
      if (!detectedExt) {
        if (cType.includes("png")) detectedExt = "png";
        else if (cType.includes("jpeg") || cType.includes("jpg")) detectedExt = "jpg";
        else if (cType.includes("webp")) detectedExt = "webp";
        else if (cType.includes("gif")) detectedExt = "gif";
        else if (cType.includes("mp4")) detectedExt = "mp4";
      }
      bytes = Buffer.from(await res.arrayBuffer());
    } else if (trimmed.startsWith("data:")) {
      const match = trimmed.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        const mime = match[1];
        if (!detectedExt) {
          if (mime.includes("png")) detectedExt = "png";
          else if (mime.includes("jpeg") || mime.includes("jpg")) detectedExt = "jpg";
          else if (mime.includes("webp")) detectedExt = "webp";
          else if (mime.includes("gif")) detectedExt = "gif";
          else if (mime.includes("mp4")) detectedExt = "mp4";
        }
        bytes = Buffer.from(match[2], "base64");
      } else {
        const commaIdx = trimmed.indexOf(",");
        const raw = commaIdx !== -1 ? trimmed.slice(commaIdx + 1) : trimmed;
        bytes = Buffer.from(raw, "base64");
      }
    } else if (/^[a-zA-Z]:[\\/]|^[\\/]/.test(trimmed)) {
      // Local file path
      if (!fs.existsSync(trimmed) || !fs.statSync(trimmed).isFile()) {
        throw new Error(`Local file not found on server: ${trimmed}`);
      }
      bytes = fs.readFileSync(trimmed);
      if (!detectedExt) {
        detectedExt = path.extname(trimmed).replace(".", "");
      }
    } else if (/^[A-Za-z0-9+/=]+$/.test(trimmed.replace(/\s+/g, ""))) {
      bytes = Buffer.from(trimmed, "base64");
    } else {
      bytes = Buffer.from(content);
    }
  } else if (typeof content === "object" && (content?.image_url || content?.url || content?.data)) {
    return saveUploadedFile(content.image_url || content.url || content.data, options, baseUrl);
  } else {
    throw new Error("Invalid content format for upload");
  }

  // Minimum payload validation
  if (!bytes || bytes.length < 16) {
    throw new Error("Invalid image data: payload is empty or too short");
  }

  // Detect format from bytes
  const magic = detectMediaType(bytes);
  let ext = detectedExt || (magic ? magic.ext : "png");

  // If conversion requested or needed and sharp is available
  if (options.convertToPng && ext !== "png") {
    try {
      const sharp = (await import("sharp")).default;
      bytes = await sharp(bytes).png().toBuffer();
      ext = "png";
    } catch (err) {
      console.warn(`[saveUploadedFile] sharp conversion failed: ${err.message}`);
    }
  }

  ensureUploadsDir();

  const fileId = `${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, fileId);

  fs.writeFileSync(filePath, bytes);

  const cleanBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const publicPath = `/uploads/${fileId}`;
  const fullUrl = cleanBaseUrl ? `${cleanBaseUrl}${publicPath}` : publicPath;

  return fullUrl;
}

/**
 * Delete files older than maxAgeMs (default: 30 minutes)
 */
export function cleanupUploads(maxAgeMs = 30 * 60 * 1000) {
  if (!fs.existsSync(UPLOADS_DIR)) return { deleted: 0, total: 0 };

  const now = Date.now();
  let deleted = 0;
  let total = 0;

  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    total = files.length;

    for (const file of files) {
      const filePath = path.join(UPLOADS_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile() && now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch (err) {
        console.warn(`[cleanupUploads] Failed to check/delete ${file}:`, err.message);
      }
    }
  } catch (err) {
    console.warn("[cleanupUploads] Error reading uploads directory:", err.message);
  }

  if (deleted > 0) {
    console.log(`[cleanupUploads] Cleaned up ${deleted}/${total} expired files (older than ${Math.round(maxAgeMs / 60000)}m)`);
  }

  return { deleted, total };
}

let cleanupTimer = null;

export function startUploadCleanupScheduler(intervalMs = 30 * 60 * 1000, maxAgeMs = 30 * 60 * 1000) {
  if (cleanupTimer) return;

  // Run initial cleanup
  cleanupUploads(maxAgeMs);

  cleanupTimer = setInterval(() => {
    cleanupUploads(maxAgeMs);
  }, intervalMs);

  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

export function stopUploadCleanupScheduler() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
