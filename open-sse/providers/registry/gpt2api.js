export default {
  id: "gpt2api",
  priority: 25,
  alias: "gpt2api",
  aliases: [
    "g2a",
  ],
  uiAlias: "g2a",
  display: {
    name: "GPT2API",
    icon: "smart_toy",
    color: "#10A37F",
    textIcon: "G2A",
    website: "http://localhost:3000",
  },
  category: "apikey",
  authType: "apikey",
  hasProviderSpecificData: true,
  transport: {
    baseUrl: "http://localhost:3000/v1/chat/completions",
  },
  models: [
    { id: "gpt-image-2", name: "GPT Image 2", params: ["n", "size", "quality", "response_format"], kind: "image" },
    { id: "tts-hd", name: "TTS HD", params: ["voice", "response_format", "speed"], kind: "tts" },
  ],
  serviceKinds: ["image", "tts"],
  imageConfig: { baseUrl: "http://localhost:3000/v1/images/generations" },
  ttsConfig: {
    baseUrl: "http://localhost:3000/v1/audio/speech",
    defaultModel: "tts-hd",
    authType: "apikey",
    format: "gpt2api",
  },
};
