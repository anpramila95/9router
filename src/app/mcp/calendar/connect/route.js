import { NextResponse } from "next/server";
import { buildAuthUrl } from "@/app/api/mcp/calendar/auth.js";
import { resolveApiKeyId } from "@/app/api/mcp/calendar/store.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const rawKey =
    searchParams.get("apiKey") ||
    searchParams.get("api_key") ||
    searchParams.get("key") ||
    searchParams.get("k");

  if (!rawKey) {
    return new Response(
      "Missing API key. Use: /mcp/calendar/connect?apiKey=YOUR_API_KEY",
      { status: 400 },
    );
  }

  const resolved = await resolveApiKeyId(rawKey);
  const apiKeyId = resolved || (rawKey ? `raw_${rawKey.slice(0, 32)}` : "default");

  const host = request.headers.get("host") || "localhost:20127";
  const proto =
    request.headers.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  const redirectUri = `${proto}://${host}/mcp/calendar/callback`;

  try {
    const googleAuthUrl = buildAuthUrl({ apiKeyId, redirectUri });
    return NextResponse.redirect(googleAuthUrl);
  } catch (err) {
    return new Response(err.message, { status: 500 });
  }
}
