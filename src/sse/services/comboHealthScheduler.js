import { getSettings } from "@/lib/localDb";
import { getCombos, updateCombo } from "@/lib/db/repos/combosRepo.js";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";

let timer = null;
let running = false;
const DEFAULT_INTERVAL = 15;

async function checkInactiveModels() {
  if (running) return;
  running = true;
  try {
    const settings = await getSettings();
    if (settings.comboHealthCheckEnabled === false) return;
    const combos = await getCombos();
    const keys = await getApiKeys();
    const apiKey = keys[0]?.key;
    if (!apiKey) return;
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 20127}`;

    for (const combo of combos) {
      let changed = false;
      const models = [...(combo.models || [])];
      for (let i = 0; i < models.length; i++) {
        const item = typeof models[i] === "string" ? { model: models[i] } : { ...models[i] };
        if (item.active !== false) continue;
        try {
          const response = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: item.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
            signal: AbortSignal.timeout(30000),
          });
          if (response.ok) {
            models[i] = { ...item, active: true, errorCount: 0, lastError: null };
            changed = true;
          }
        } catch {
          // Health check is best effort; retain inactive state.
        }
      }
      if (changed) await updateCombo(combo.id, { models });
    }
  } catch (error) {
    console.warn("[ComboHealth] check failed:", error.message);
  } finally {
    running = false;
  }
}

export function startComboHealthScheduler() {
  if (timer) return;
  const schedule = async () => {
    const settings = await getSettings().catch(() => ({}));
    const minutes = Math.max(1, Number(settings.comboHealthCheckIntervalMinutes) || DEFAULT_INTERVAL);
    timer = setTimeout(async () => {
      timer = null;
      await checkInactiveModels();
      schedule();
    }, minutes * 60 * 1000);
  };
  schedule();
}

export function stopComboHealthScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}
