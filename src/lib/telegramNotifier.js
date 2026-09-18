import { getSettings } from "@/lib/localDb";

/**
 * Send notification message to configured Telegram bot
 * @param {string} text
 */
export async function sendTelegramNotification(text) {
  try {
    const settings = await getSettings();
    if (!settings.telegramEnabled) return false;

    const token = (settings.telegramBotToken || "").trim();
    const chatId = (settings.telegramChatId || "").trim();
    if (!token || !chatId) return false;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
    };

    let fetchOptions = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };

    // Proxy support if enabled
    if (settings.telegramProxyEnabled && settings.telegramProxyUrl) {
      const { ProxyAgent } = await import("undici");
      fetchOptions.dispatcher = new ProxyAgent({ uri: settings.telegramProxyUrl.trim() });
    }

    const res = await fetch(url, fetchOptions);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[Telegram] Send failed (${res.status}): ${errText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[Telegram] Notification error: ${err.message}`);
    return false;
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Notify error for media generation (image, video, speech)
 */
export async function notifyMediaError({ type, model, provider, status, error, prompt, detail }) {
  const timeStr = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  let msg = `⚠️ <b>[9Router Alert] ${escapeHtml(type || "media").toUpperCase()} Failed</b>\n`;
  msg += `⏰ <b>Time:</b> ${escapeHtml(timeStr)}\n`;
  if (provider) msg += `🏢 <b>Provider:</b> <code>${escapeHtml(provider)}</code>\n`;
  if (model) msg += `🤖 <b>Model:</b> <code>${escapeHtml(model)}</code>\n`;
  if (status) msg += `📊 <b>Status:</b> <code>${escapeHtml(status)}</code>\n`;
  if (error) msg += `❌ <b>Error:</b> <code>${escapeHtml(String(error).slice(0, 500))}</code>\n`;
  if (prompt) msg += `📝 <b>Prompt:</b> <code>${escapeHtml(String(prompt).slice(0, 150))}...</code>\n`;
  if (detail) msg += `🔍 <b>Detail:</b> <code>${escapeHtml(String(detail).slice(0, 200))}</code>\n`;

  return sendTelegramNotification(msg);
}
