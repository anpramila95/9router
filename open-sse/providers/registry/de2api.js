const de2apiProvider = {
  id: "de2api",
  priority: 25,
  alias: "de2api",
  aliases: [
    "de2",
  ],
  uiAlias: "de2",
  display: {
    name: "DE2API",
    icon: "smart_toy",
    color: "#2563EB",
    textIcon: "DE2",
    website: "http://localhost:3000",
  },
  category: "apikey",
  authType: "apikey",
  hasProviderSpecificData: true,
  transport: {
    baseUrl: "http://localhost:3000/v1/chat/completions",
  },
  models: [
    { id: "gpt-4o", name: "GPT-4o", kind: "llm" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", kind: "llm" },
    { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", kind: "llm" },
    { id: "tts-hd", name: "TTS HD", params: ["voice", "response_format", "speed"], kind: "tts" },
  ],
  serviceKinds: ["llm", "tts"],
  ttsConfig: {
    baseUrl: "http://localhost:3000/v1/audio/speech",
    defaultModel: "tts-hd",
    authType: "apikey",
    format: "de2api",
  },
};

export default de2apiProvider;
