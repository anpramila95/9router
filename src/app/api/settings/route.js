import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import { allowedPipelineEnvKeys } from "@/lib/mediaPipelineHelpers.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

function containsLiteralSecrets(value, requiredKeys, key = "") {
  if (Array.isArray(value)) return value.some((item) => containsLiteralSecrets(item, requiredKeys, key));
  if (value && typeof value === "object") return Object.entries(value).some(([name, item]) => containsLiteralSecrets(item, requiredKeys, name));
  if (typeof value !== "string") return false;
  if (/authorization|api[-_]?key|secret|token|password|cookie/i.test(key) && key !== "required_env_keys") {
    const match = value.match(/^(?:Bearer\s+)?\{\{env\.([A-Z_][A-Z0-9_]*)\}\}$/i);
    return !match || !requiredKeys.includes(match[1]);
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return true;
      return [...url.searchParams.keys()].some((name) => /key|token|secret|password/i.test(name));
    } catch { return true; }
  }
  return false;
}

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Settings must be a JSON object" }, { status: 400 });
    }

    if (Object.prototype.hasOwnProperty.call(body, "mediaPipelinesEnabled") && typeof body.mediaPipelinesEnabled !== "boolean") return NextResponse.json({ error: "mediaPipelinesEnabled must be boolean" }, { status: 400 });
    if (Object.prototype.hasOwnProperty.call(body, "mediaPipelines")) {
      const pipelines = body.mediaPipelines;
      const allowedEnvKeys = allowedPipelineEnvKeys();
      if (!Array.isArray(pipelines) || pipelines.some((pipeline) =>
        !pipeline || typeof pipeline !== "object" || Array.isArray(pipeline) ||
        !["text_to_image", "image_to_image", "image_to_video", "two_step_pipeline", "text_to_video"].includes(pipeline.type) ||
        typeof pipeline.is_default !== "boolean" ||
        typeof pipeline.name !== "string" || !pipeline.name.trim() ||
        !Array.isArray(pipeline.steps) || !pipeline.steps.length || pipeline.steps.length > 12 || pipeline.steps.some((step) =>
          !step || typeof step !== "object" || Array.isArray(step) ||
          typeof step.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(step.id) ||
          !["async_task", "request"].includes(step.type) ||
          !step.request || typeof step.request !== "object" || Array.isArray(step.request) ||
          typeof step.request.url !== "string" || !step.request.url.trim() ||
          (step.type === "async_task" && (!step.polling || typeof step.polling !== "object" || Array.isArray(step.polling) || typeof step.polling.url !== "string" || !step.polling.url.trim() || typeof step.request.task_id_path !== "string" || !step.request.task_id_path.trim() || !step.polling.conditions || typeof step.polling.conditions.success_path !== "string" || !("success_value" in step.polling.conditions)))
        ) ||
        new Set(pipeline.steps.map((step) => step.id)).size !== pipeline.steps.length ||
        !pipeline.final_response || typeof pipeline.final_response !== "object" || Array.isArray(pipeline.final_response) ||
        !Array.isArray(pipeline.required_env_keys || []) ||
        (pipeline.required_env_keys || []).some((key) => typeof key !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(key) || !allowedEnvKeys.has(key)) ||
        containsLiteralSecrets(pipeline, pipeline.required_env_keys || [])
      )) {
        return NextResponse.json({ error: "Invalid mediaPipelines; secrets must use environment references listed in required_env_keys" }, { status: 400 });
      }
      const defaults = pipelines.filter((pipeline) => pipeline.is_default).map((pipeline) =>
        ["text_to_image", "image_to_image"].includes(pipeline.type) ? "image" : "video"
      );
      if (new Set(defaults).size !== defaults.length) {
        return NextResponse.json({ error: "Only one default pipeline per media category is allowed" }, { status: 400 });
      }
    }

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
