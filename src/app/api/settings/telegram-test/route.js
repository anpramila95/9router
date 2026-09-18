import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();

    const token = (body.telegramBotToken || settings.telegramBotToken || "").trim();
    const chatId = (body.telegramChatId || settings.telegramChatId || "").trim();
    const proxyEnabled = body.telegramProxyEnabled !== undefined ? body.telegramProxyEnabled : settings.telegramProxyEnabled;
    const proxyUrl = (body.telegramProxyUrl || settings.telegramProxyUrl || "").trim();

    if (!token) return NextResponse.json({ error: "Missing Bot Token" }, { status: 400 });
    if (!chatId) return NextResponse.json({ error: "Missing Chat ID" }, { status: 400 });

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text: `✅ <b>[9Router]</b> Telegram test notification connected successfully!`,
      parse_mode: "HTML",
    };

    let fetchOptions = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };

    if (proxyEnabled && proxyUrl) {
      const { ProxyAgent } = await import("undici");
      fetchOptions.dispatcher = new ProxyAgent({ uri: proxyUrl });
    }

    const res = await fetch(url, fetchOptions);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return NextResponse.json({ error: `Telegram error (${res.status}): ${errText}` }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: "Test message sent to Telegram successfully!" });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
