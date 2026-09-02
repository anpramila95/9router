import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const SCOPE = "videoJob";

export async function saveVideoJob(requestId, { connectionId, provider }) {
  if (!requestId || !connectionId) return;
  const db = await getAdapter();
  db.run(
    `INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)`,
    [SCOPE, requestId, stringifyJson({ connectionId, provider, createdAt: new Date().toISOString() })]
  );
}

export async function getVideoJob(requestId) {
  if (!requestId) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, requestId]);
  return row ? parseJson(row.value, null) : null;
}