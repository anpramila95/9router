import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";
const DEFAULT_MEDIA_VIDEO_PIPELINE = {
  name: "Video template (inactive; configure endpoint)",
  type: "text_to_video",
  is_default: false,
  required_env_keys: [],
  steps: [{ id: "video", type: "request", request: { url: "{{variables.video_endpoint}}", method: "POST", body: {} } }],
  final_response: {},
};

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  mediaPipelinesEnabled: false,
  mediaPipelineDefaultsVersion: 2,
  mediaPipelines: [
    {
      name: "Codex image generation",
      type: "text_to_image",
      is_default: false,
      required_env_keys: [],
      steps: [{ id: "image", type: "request", request: { url: "gateway://images/generations", method: "POST", body: { model: "cx/gpt-image-2.5", prompt: "{{inputs.prompt}}", images: "{{inputs.image_urls}}", aspectRatio: "{{inputs.aspectRatio}}" } } }],
      final_response: { data: "{{image.response.data}}" },
    },
    DEFAULT_MEDIA_VIDEO_PIPELINE,
  ],
  comboHealthCheckEnabled: true,
  comboHealthCheckIntervalMinutes: 15,
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  ssoType: "oidc",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:9router:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  disableMaxTokens: false,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  if (merged.capacityAdapter && typeof merged.capacityAdapter === "object") {
    for (const capKey of Object.keys(merged.capacityAdapter)) {
      const entry = merged.capacityAdapter[capKey];
      if (Array.isArray(entry?.models)) {
        entry.models = entry.models.map((m) =>
          m === "oc/mimo-v2.5-free" ? "oc/mimo-v2.6-flash-free" : m
        );
      }
    }
  }
  if ((raw?.mediaPipelineDefaultsVersion ?? 0) < 2 && Array.isArray(merged.mediaPipelines)) {
    if (!merged.mediaPipelines.some((pipeline) => pipeline?.type === "text_to_video")) {
      merged.mediaPipelines = [...merged.mediaPipelines, DEFAULT_MEDIA_VIDEO_PIPELINE];
    }
    merged.mediaPipelineDefaultsVersion = 2;
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  if ((raw.mediaPipelineDefaultsVersion ?? 0) >= 2) return mergeWithDefaults(raw);
  const db = await getAdapter();
  let current;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    current = row ? parseJson(row.data, {}) : {};
    if ((current.mediaPipelineDefaultsVersion ?? 0) < 2) {
      const merged = mergeWithDefaults(current);
      current = { ...current, mediaPipelines: merged.mediaPipelines, mediaPipelineDefaultsVersion: 2 };
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(current)]);
    }
  });
  return mergeWithDefaults(current);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    const migrated = (current.mediaPipelineDefaultsVersion ?? 0) < 2 ? mergeWithDefaults(current) : current;
    next = { ...current, mediaPipelines: migrated.mediaPipelines, mediaPipelineDefaultsVersion: 2, ...updates };
    if (Object.hasOwn(updates, "mediaPipelines")) next.mediaPipelineDefaultsVersion = 2;
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
