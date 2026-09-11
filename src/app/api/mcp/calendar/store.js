import { getAdapter } from "@/lib/db/driver.js";
import { v4 as uuidv4 } from "uuid";

export async function resolveApiKeyId(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get("SELECT id, isActive FROM apiKeys WHERE key = ?", [key]);
  if (!row || row.isActive === 0) return null;
  return row.id;
}

export async function getGcalAccounts(apiKeyId) {
  if (!apiKeyId || apiKeyId === "default") return [];
  const db = await getAdapter();
  return db.all(
    "SELECT id, email, scope, expiresAt, isActive, createdAt, updatedAt FROM gcalAccounts WHERE apiKeyId = ? AND isActive = 1 ORDER BY createdAt ASC",
    [apiKeyId]
  );
}

export async function getGcalAccount(apiKeyId, email = null) {
  if (!apiKeyId || apiKeyId === "default") return null;
  const db = await getAdapter();
  if (email) {
    return db.get(
      "SELECT * FROM gcalAccounts WHERE apiKeyId = ? AND email = ? AND isActive = 1",
      [apiKeyId, email]
    );
  }
  return db.get(
    "SELECT * FROM gcalAccounts WHERE apiKeyId = ? AND isActive = 1 ORDER BY createdAt ASC LIMIT 1",
    [apiKeyId]
  );
}

export async function saveGcalAccount({ apiKeyId, email, accessToken, refreshToken, scope, expiresIn }) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  const existing = email
    ? db.get("SELECT id, refreshToken FROM gcalAccounts WHERE apiKeyId = ? AND email = ?", [apiKeyId, email])
    : null;

  if (existing) {
    const finalRefreshToken = refreshToken || existing.refreshToken;
    db.run(
      `UPDATE gcalAccounts
       SET accessToken = ?, refreshToken = ?, scope = ?, expiresAt = ?, isActive = 1, updatedAt = ?
       WHERE id = ?`,
      [accessToken, finalRefreshToken, scope || null, expiresAt, now, existing.id]
    );
    return { id: existing.id, email, apiKeyId };
  }

  const id = uuidv4();
  db.run(
    `INSERT INTO gcalAccounts(id, apiKeyId, email, accessToken, refreshToken, scope, expiresAt, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, apiKeyId, email || null, accessToken, refreshToken || null, scope || null, expiresAt, now, now]
  );
  return { id, email, apiKeyId };
}

export async function updateGcalTokens(id, { accessToken, refreshToken, expiresIn }) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  if (refreshToken) {
    db.run(
      "UPDATE gcalAccounts SET accessToken = ?, refreshToken = ?, expiresAt = ?, updatedAt = ? WHERE id = ?",
      [accessToken, refreshToken, expiresAt, now, id]
    );
  } else {
    db.run(
      "UPDATE gcalAccounts SET accessToken = ?, expiresAt = ?, updatedAt = ? WHERE id = ?",
      [accessToken, expiresAt, now, id]
    );
  }
}

export async function disconnectGcalAccount(apiKeyId, email = null) {
  const db = await getAdapter();
  if (email) {
    const res = db.run(
      "UPDATE gcalAccounts SET isActive = 0, updatedAt = ? WHERE apiKeyId = ? AND email = ?",
      [new Date().toISOString(), apiKeyId, email]
    );
    return (res?.changes ?? 0) > 0;
  }
  const res = db.run(
    "UPDATE gcalAccounts SET isActive = 0, updatedAt = ? WHERE apiKeyId = ?",
    [new Date().toISOString(), apiKeyId]
  );
  return (res?.changes ?? 0) > 0;
}

export async function savePendingAction({ apiKeyId, tool, args, ttlMinutes = 15 }) {
  const db = await getAdapter();
  const id = uuidv4();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMinutes * 60 * 1000).toISOString();

  db.run(
    `INSERT INTO gcalPendingActions(id, apiKeyId, tool, args, status, createdAt, expiresAt)
     VALUES(?, ?, ?, ?, 'pending', ?, ?)`,
    [id, apiKeyId, tool, JSON.stringify(args || {}), createdAt, expiresAt]
  );
  return id;
}

export async function getPendingAction(actionId) {
  const db = await getAdapter();
  const row = db.get("SELECT * FROM gcalPendingActions WHERE id = ?", [actionId]);
  if (!row) return null;
  return { ...row, args: JSON.parse(row.args || "{}") };
}

export async function markPendingExecuting(actionId) {
  const db = await getAdapter();
  const res = db.run(
    "UPDATE gcalPendingActions SET status = 'executing' WHERE id = ? AND status = 'pending'",
    [actionId]
  );
  return (res?.changes ?? 0) > 0;
}

export async function completePendingAction(actionId, { result, error }) {
  const db = await getAdapter();
  db.run(
    "UPDATE gcalPendingActions SET status = ?, result = ?, error = ? WHERE id = ?",
    [
      error ? "failed" : "completed",
      result ? JSON.stringify(result) : null,
      error ? String(error) : null,
      actionId,
    ]
  );
}

export async function getPendingActionsForApiKey(apiKeyId) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  return db.all(
    "SELECT * FROM gcalPendingActions WHERE apiKeyId = ? AND status = 'pending' AND expiresAt > ? ORDER BY createdAt ASC",
    [apiKeyId, now]
  );
}
