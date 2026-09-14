import { NextResponse } from "next/server";
import { decodeState, exchangeCode } from "@/app/api/mcp/calendar/auth.js";
import {
  saveGcalAccount,
  getGcalAccount,
  getPendingAction,
  markPendingExecuting,
  completePendingAction,
  getPendingActionsForApiKey,
} from "@/app/api/mcp/calendar/store.js";
import { executeCalendarToolDirect } from "@/app/api/mcp/calendar/tools.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function htmlResponse(title, message, isSuccess = true, details = null) {
  const color = isSuccess ? "#10b981" : "#ef4444";
  const icon = isSuccess ? "✓" : "✕";
  const detailsHtml = details
    ? `<pre style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;text-align:left;max-height:200px;">${escapeHtml(
        JSON.stringify(details, null, 2)
      )}</pre>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; max-width: 480px; width: 100%; padding: 32px 24px; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    .icon { width: 56px; height: 56px; border-radius: 50%; background: ${color}22; color: ${color}; display: flex; align-items: center; justify-content: center; font-size: 28px; margin: 0 auto 16px; font-weight: bold; }
    h1 { font-size: 20px; margin: 0 0 8px; color: #f8fafc; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin: 0 0 16px; }
    .close-hint { font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${detailsHtml}
    <div class="close-hint">Bạn có thể đóng tab này và quay lại ứng dụng.</div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: isSuccess ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const errorParam = searchParams.get("error");
  const errorDesc = searchParams.get("error_description");

  if (errorParam) {
    return htmlResponse(
      "Ủy quyền bị từ chối",
      `Google trả về lỗi: ${errorParam} - ${errorDesc || ""}`,
      false
    );
  }

  if (!code) {
    return htmlResponse(
      "Thiếu authorization code",
      "Google không trả về mã ủy quyền.",
      false
    );
  }

  if (!state) {
    return htmlResponse(
      "Thiếu OAuth state",
      "Request không chứa thông tin định danh API key (state). Vui lòng sử dụng liên kết cấp quyền được tạo từ hệ thống.",
      false
    );
  }

  let statePayload;
  try {
    statePayload = decodeState(state);
  } catch (err) {
    return htmlResponse("State không hợp lệ", err.message, false);
  }

  const { apiKeyId, actionId, redirectUri } = statePayload;
  if (!apiKeyId || apiKeyId === "default") {
    return htmlResponse(
      "API key không hợp lệ",
      "Không tìm thấy thông tin API key hợp lệ trong liên kết ủy quyền.",
      false
    );
  }

  const host = request.headers.get("host") || "localhost:20127";
  const proto = request.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const effectiveRedirectUri = redirectUri || `${proto}://${host}/mcp/calendar/callback`;

  let tokenData;
  try {
    tokenData = await exchangeCode(code, effectiveRedirectUri);
  } catch (err) {
    return htmlResponse("Đổi token thất bại", err.message, false);
  }

  let savedAccount;
  try {
    savedAccount = await saveGcalAccount({
      apiKeyId,
      email: tokenData.email,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      scope: tokenData.scope,
      expiresIn: tokenData.expiresIn,
    });
  } catch (err) {
    return htmlResponse("Lưu tài khoản thất bại", err.message, false);
  }

  const executedResults = [];
  try {
    const fullAccount = await getGcalAccount(apiKeyId, tokenData.email);
    const actionsToRun = [];

    if (actionId) {
      const pending = await getPendingAction(actionId);
      if (pending && pending.status === "pending") {
        actionsToRun.push(pending);
      }
    } else {
      const allPending = await getPendingActionsForApiKey(apiKeyId);
      actionsToRun.push(...allPending);
    }

    for (const action of actionsToRun) {
      const claimed = await markPendingExecuting(action.id);
      if (!claimed) continue;

      try {
        const result = await executeCalendarToolDirect(fullAccount, action.tool, action.args);
        await completePendingAction(action.id, { result, error: null });
        executedResults.push({ tool: action.tool, status: "success", result });
      } catch (err) {
        console.error(`[gcal][auto-exec] ${action.tool} failed:`, err.message);
        await completePendingAction(action.id, { result: null, error: err.message });
        executedResults.push({ tool: action.tool, status: "error", error: err.message });
      }
    }
  } catch (err) {
    console.error("[gcal][auto-exec] error:", err.message);
  }

  const emailDisplay = tokenData.email ? `(${tokenData.email})` : "";
  const autoExecMsg = executedResults.length > 0
    ? ` Đã tự động hoàn tất ${executedResults.length} tác vụ đang chờ.`
    : "";

  return htmlResponse(
    "Kết nối Google Calendar thành công!",
    `Tài khoản Google ${emailDisplay} đã được liên kết với API key của bạn.${autoExecMsg}`,
    true,
    executedResults.length > 0 ? { executed: executedResults } : null
  );
}
