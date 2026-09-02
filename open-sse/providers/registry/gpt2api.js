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
    { id: "gpt-image-2", name: "GPT Image 2", params: ["n", "aspectRatio", "response_format", "images"], kind: "image" },
    { id: "tts-hd", name: "TTS HD", params: ["voice", "response_format", "speed"], kind: "tts" },
  ],
  serviceKinds: ["image", "tts"],
  imageConfig: {
    baseUrl: "http://localhost:3000/v1/images/generations",
    // Only these fields forwarded upstream — strips quality/style/background/image_detail
    // aspectRatio (canonical input) is converted to a pixel `size` by the adapter
    bodyFields: ["model", "prompt", "n", "size", "response_format", "images"],
  },
  ttsConfig: {
    baseUrl: "http://localhost:3000/v1/audio/speech",
    defaultModel: "tts-hd",
    authType: "apikey",
    format: "gpt2api",
  },
};
