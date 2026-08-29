// Image provider adapter registry
import createOpenAIAdapter from "./openai.js";
import gemini from "./gemini.js";
import codex from "./codex.js";
import sdwebui from "./sdwebui.js";
import comfyui from "./comfyui.js";
import huggingface from "./huggingface.js";
import nanobanana from "./nanobanana.js";
import falAi from "./falAi.js";
import stabilityAi from "./stabilityAi.js";
import blackForestLabs from "./blackForestLabs.js";
import runwayml from "./runwayml.js";
import cloudflareAi from "./cloudflareAi.js";
import antigravity from "./antigravity.js";
import ai2w from "./ai2w.js";

const ADAPTERS = {
  openai: createOpenAIAdapter("openai"),
  minimax: createOpenAIAdapter("minimax"),
  openrouter: createOpenAIAdapter("openrouter"),
  recraft: createOpenAIAdapter("recraft"),
  "vercel-ai-gateway": createOpenAIAdapter("vercel-ai-gateway"),
  xai: createOpenAIAdapter("xai"),
  gpt2api: createOpenAIAdapter("gpt2api"),
  g2a: createOpenAIAdapter("gpt2api"),
  ai2w,
  aivideoworkflow: ai2w,
  gemini,
  codex,
  sdwebui,
  comfyui,
  huggingface,
  nanobanana,
  antigravity,
  "fal-ai": falAi,
  "stability-ai": stabilityAi,
  "black-forest-labs": blackForestLabs,
  runwayml,
  "cloudflare-ai": cloudflareAi,
};

export function getImageAdapter(provider) {
  return ADAPTERS[provider] || null;
}

export function isImageProvider(provider) {
  return provider in ADAPTERS;
}
