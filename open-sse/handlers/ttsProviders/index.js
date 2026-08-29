// TTS provider registry
import googleTts from "./googleTts.js";
import edgeTts, { fetchEdgeTtsVoices } from "./edgeTts.js";
import localDevice, { fetchLocalDeviceVoices } from "./localDevice.js";
import elevenlabs, { fetchElevenLabsVoices } from "./elevenlabs.js";
import openai from "./openai.js";
import openrouter from "./openrouter.js";
import gemini, { fetchGeminiVoices } from "./gemini.js";
import xiaomiMimo from "./xiaomi-mimo.js";
import selfhostedTts from "./selfhostedTts.js";
import { FORMAT_HANDLERS } from "./genericFormats.js";
import { parseModelVoice } from "./_base.js";

// Special providers with custom synthesize() logic
const SPECIAL_ADAPTERS = {
  "google-tts": googleTts,
  "edge-tts": edgeTts,
  "local-device": localDevice,
  elevenlabs,
  openai,
  openrouter,
  gemini,
  "xiaomi-mimo": xiaomiMimo,
  "selfhosted-tts": selfhostedTts,
};

export function getTtsAdapter(provider) {
  return SPECIAL_ADAPTERS[provider] || null;
}

// Generic config-driven dispatcher (uses ttsConfig.format)
export async function synthesizeViaConfig(provider, text, model, credentials, responseFormat = "mp3") {
  const { AI_PROVIDERS } = await import("@/shared/constants/providers");
  const cfg = AI_PROVIDERS[provider]?.ttsConfig;
  if (!cfg) return null;
  const handler = FORMAT_HANDLERS[cfg.format];
  if (!handler) return null;
  const apiKey = credentials?.apiKey;
  if (cfg.authType !== "none" && !apiKey) throw new Error(`${provider} API key required`);
  const { PROVIDER_MODELS } = await import("open-sse/config/providerModels.js");
  const ttsModels = (PROVIDER_MODELS[provider] || []).filter(m => (m.kind || m.type) === "tts");
  const defaultModel = ttsModels[0]?.id || "";
  const { modelId, voiceId } = parseModelVoice(model, defaultModel, "", ttsModels);
  const rawUrl = credentials?.providerSpecificData?.baseUrl || credentials?.baseUrl || cfg.baseUrl;
  let resolvedBaseUrl = rawUrl;
  if (rawUrl && (cfg.format === "gpt2api" || cfg.format === "openai")) {
    const base = String(rawUrl).replace(/\/+$/, "");
    if (base.endsWith("/v1/audio/speech") || base.endsWith("/audio/speech")) {
      resolvedBaseUrl = base;
    } else if (base.endsWith("/v1")) {
      resolvedBaseUrl = `${base}/audio/speech`;
    } else {
      resolvedBaseUrl = `${base}/v1/audio/speech`;
    }
  }
  return handler({ baseUrl: resolvedBaseUrl, apiKey, text, modelId, voiceId, responseFormat });
}

// Voice fetchers (used by /api/media-providers/tts/voices route)
export const VOICE_FETCHERS = {
  "edge-tts": fetchEdgeTtsVoices,
  "local-device": fetchLocalDeviceVoices,
  elevenlabs: fetchElevenLabsVoices,
  gemini: fetchGeminiVoices,
};

// Re-export for backward compat
export { fetchEdgeTtsVoices, fetchLocalDeviceVoices, fetchElevenLabsVoices, fetchGeminiVoices };
