import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    limit5h: row.limit5h != null ? Number(row.limit5h) : null,
    limit7d: row.limit7d != null ? Number(row.limit7d) : null,
    limit30d: row.limit30d != null ? Number(row.limit30d) : null,
    limitImageDaily: row.limitImageDaily != null ? Number(row.limitImageDaily) : null,
    limitVideoDaily: row.limitVideoDaily != null ? Number(row.limitVideoDaily) : null,
  };
}

function normLimit(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

const WINDOWS = {
  limit5h: { ms: 5 * 3600 * 1000, label: "5 hours" },
  limit7d: { ms: 7 * 24 * 3600 * 1000, label: "7 days" },
  limit30d: { ms: 30 * 24 * 3600 * 1000, label: "30 days" },
};

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeysWithUsage() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  const keys = rows.map(rowToKey);

  const now = Date.now();
  const cutoffToday = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const cutoff7d = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const cutoff30d = new Date(now - 30 * 24 * 3600 * 1000).toISOString();

  // Aggregate stats per apiKey
  const usageMap = {};
  const statsRows = db.all(`
    SELECT
      apiKey,
      SUM(CASE WHEN timestamp >= ? THEN promptTokens + completionTokens ELSE 0 END) AS tokensToday,
      SUM(CASE WHEN timestamp >= ? THEN promptTokens + completionTokens ELSE 0 END) AS tokens7d,
      SUM(CASE WHEN timestamp >= ? THEN promptTokens + completionTokens ELSE 0 END) AS tokens30d,
      SUM(CASE WHEN (endpoint LIKE '%images%' OR endpoint LIKE '%image%') THEN 1 ELSE 0 END) AS imagesTotal,
      SUM(CASE WHEN (endpoint LIKE '%videos%' OR endpoint LIKE '%video%') THEN 1 ELSE 0 END) AS videosTotal
    FROM usageHistory
    WHERE apiKey IS NOT NULL AND apiKey != ''
    GROUP BY apiKey
  `, [cutoffToday, cutoff7d, cutoff30d]);

  for (const r of statsRows) {
    usageMap[r.apiKey] = {
      tokensToday: Number(r.tokensToday || 0),
      tokens7d: Number(r.tokens7d || 0),
      tokens30d: Number(r.tokens30d || 0),
      imagesTotal: Number(r.imagesTotal || 0),
      videosTotal: Number(r.videosTotal || 0),
    };
  }

  return keys.map((k) => ({
    ...k,
    usage: usageMap[k.key] || {
      tokensToday: 0,
      tokens7d: 0,
      tokens30d: 0,
      imagesTotal: 0,
      videosTotal: 0,
    },
  }));
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, limits = {}, customKey = null) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  let keyToUse = (typeof customKey === "string" && customKey.trim()) ? customKey.trim() : null;
  if (!keyToUse) {
    const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
    const result = generateApiKeyWithMachine(machineId);
    keyToUse = result.key;
  }
  const apiKey = {
    id: uuidv4(),
    name,
    key: keyToUse,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    limit5h: normLimit(limits.limit5h),
    limit7d: normLimit(limits.limit7d),
    limit30d: normLimit(limits.limit30d),
    limitImageDaily: normLimit(limits.limitImageDaily),
    limitVideoDaily: normLimit(limits.limitVideoDaily),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, limit5h, limit7d, limit30d, limitImageDaily, limitVideoDaily) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, apiKey.limit5h, apiKey.limit7d, apiKey.limit30d, apiKey.limitImageDaily, apiKey.limitVideoDaily]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    if (data.limit5h !== undefined) merged.limit5h = normLimit(data.limit5h);
    if (data.limit7d !== undefined) merged.limit7d = normLimit(data.limit7d);
    if (data.limit30d !== undefined) merged.limit30d = normLimit(data.limit30d);
    if (data.limitImageDaily !== undefined) merged.limitImageDaily = normLimit(data.limitImageDaily);
    if (data.limitVideoDaily !== undefined) merged.limitVideoDaily = normLimit(data.limitVideoDaily);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, limit5h = ?, limit7d = ?, limit30d = ?, limitImageDaily = ?, limitVideoDaily = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, merged.limit5h, merged.limit7d, merged.limit30d, merged.limitImageDaily, merged.limitVideoDaily, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}

// Token-quota check against the usageHistory for this key. Returns
// { allowed: true } when no limit is set or usage is under every limit, else
// { allowed: false, limit, used, window, message } for the first hit window.
export async function getApiKeyLimitStatus(key, kind = "token") {
  const db = await getAdapter();
  const row = db.get(`SELECT limit5h, limit7d, limit30d, limitImageDaily, limitVideoDaily FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return { allowed: true };

  const now = Date.now();
  const cutoff24h = new Date(now - 24 * 3600 * 1000).toISOString();

  // Kind-specific check (Image)
  if (kind === "image" && row.limitImageDaily != null) {
    const limit = Number(row.limitImageDaily);
    const res = db.get(
      `SELECT COUNT(*) AS total FROM usageHistory WHERE apiKey = ? AND endpoint LIKE '%images%' AND timestamp >= ?`,
      [key, cutoff24h]
    );
    const used = Number(res?.total || 0);
    if (used >= limit) {
      return {
        allowed: false,
        limit,
        used,
        window: "24 hours",
        message: `Image daily limit exceeded: ${used} images generated in the last 24h (limit ${limit})`,
      };
    }
  }

  // Kind-specific check (Video)
  if (kind === "video" && row.limitVideoDaily != null) {
    const limit = Number(row.limitVideoDaily);
    const res = db.get(
      `SELECT COUNT(*) AS total FROM usageHistory WHERE apiKey = ? AND endpoint LIKE '%videos%' AND timestamp >= ?`,
      [key, cutoff24h]
    );
    const used = Number(res?.total || 0);
    if (used >= limit) {
      return {
        allowed: false,
        limit,
        used,
        window: "24 hours",
        message: `Video daily limit exceeded: ${used} videos generated in the last 24h (limit ${limit})`,
      };
    }
  }

  const limits = [
    { field: "limit5h", limit: row.limit5h },
    { field: "limit7d", limit: row.limit7d },
    { field: "limit30d", limit: row.limit30d },
  ].filter((l) => l.limit != null);

  if (limits.length === 0) return { allowed: true };

  for (const { field, limit } of limits) {
    const cutoff = new Date(now - WINDOWS[field].ms).toISOString();
    const res = db.get(
      `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS total FROM usageHistory WHERE apiKey = ? AND timestamp >= ?`,
      [key, cutoff]
    );
    const used = Number(res?.total || 0);
    if (used >= Number(limit)) {
      const label = WINDOWS[field].label;
      return {
        allowed: false,
        limit: Number(limit),
        used,
        window: label,
        message: `Token limit exceeded: ${used.toLocaleString()} tokens used in the last ${label} (limit ${Number(limit).toLocaleString()})`,
      };
    }
  }
  return { allowed: true };
}
