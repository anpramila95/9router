export default {
  id: "ai2w",
  priority: 26,
  alias: "ai2w",
  aliases: [
    "aivideoworkflow",
  ],
  uiAlias: "ai2w",
  display: {
    name: "AIVideoWorkflow",
    icon: "movie_edit",
    color: "#8B5CF6",
    textIcon: "2W",
    website: "http://localhost:3000",
  },
  category: "apikey",
  authType: "apikey",
  hasProviderSpecificData: true,
  transport: {
    baseUrl: "http://localhost:3000/api/labs/generate-image",
  },
  models: [
    { id: "banana-2", name: "Banana 2", params: ["aspectRatio", "images"], kind: "image" },
    { id: "banana-pro", name: "Banana Pro", params: ["aspectRatio", "images"], kind: "image" },
    { id: "grok", name: "Grok Image", params: ["aspectRatio", "images"], kind: "image" },
    { id: "veo3", name: "Veo 3 Video", params: ["aspectRatio", "mode", "images"], kind: "video" },
    { id: "grok-video", name: "Grok Video", params: ["aspectRatio", "videoLength", "resolutionName", "images"], kind: "video" },
  ],
  serviceKinds: ["image", "video"],
  imageConfig: { baseUrl: "http://localhost:3000" },
  videoConfig: { baseUrl: "http://localhost:3000" },
};
