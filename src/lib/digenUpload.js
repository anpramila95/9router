import axios from "axios";
import { randomUUID } from "node:crypto";

const DIGEN_API = "https://api.digen.ai/v1";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const VIDEO_RETRIES = 3;
let cachedToken = null;
let tokenExpiresAt = 0;

function mimeFor(extension) {
  return (
    {
      webp: "image/webp",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      mp3: "audio/mpeg",
      m4a: "audio/mpeg",
      wav: "audio/mpeg",
      mp4: "video/mp4",
    }[extension] || "application/octet-stream"
  );
}

function asBytes(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  const value = String(content).trim();
  const match = value.match(/^data:[^;]+;base64,(.+)$/s);
  return Buffer.from(match ? match[1] : value, "base64");
}

async function login() {
  const {
    DIGEN_EMAIL: email,
    DIGEN_PASSWORD: password,
    DIGEN_INVITE_CODE: inviteCode,
  } = process.env;
  if (!email || !password) return null;
  const response = await axios.post(
    `${DIGEN_API}/user/login`,
    {
      email,
      password,
      invite_code: inviteCode || null,
    },
    {
      headers: {
        "digen-sessionid": randomUUID(),
        "digen-deviceid": randomUUID(),
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      },
    },
  );
  return response.data?.data?.token || null;
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  cachedToken = await login();
  tokenExpiresAt = cachedToken ? Date.now() + TOKEN_TTL_MS : 0;
  return cachedToken;
}

export async function uploadMediaToDigen(content, extension) {
  const token = await getToken();
  if (!token) return null;
  const format = String(extension || "bin").toLowerCase();
  const bytes = asBytes(content);
  const attempts = format === "mp4" ? VIDEO_RETRIES : 1;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
        "digen-sessionid": randomUUID(),
        "digen-token": token,
        "digen-language": "en-US",
      };
      const presign = await axios.get(
        `${DIGEN_API}/element/priv/presign?format=${encodeURIComponent(format)}`,
        { headers },
      );
      const endpoint = presign.data?.data?.url;
      if (!endpoint) throw new Error("Digen presign URL missing");
      await axios.put(endpoint, bytes, {
        headers: {
          "Content-Type": mimeFor(format),
          "Content-Length": bytes.length,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return String(endpoint).split("?")[0];
    } catch (error) {
      console.warn(
        `[DigenUpload] ${format} attempt ${attempt}/${attempts} failed: ${error.message}`,
      );
      if (attempt < attempts)
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  return null;
}
