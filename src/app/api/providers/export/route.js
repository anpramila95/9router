import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";
import { normalizeProviderId } from "@/lib/providerNormalization";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";

export const dynamic = "force-dynamic";

const PASSWORD_HEADER = "x-9r-password";

// GET /api/providers/export?provider=[providerId]
// Returns raw connections including credentials/tokens for export/migration.
export async function GET(request) {
  try {
    const passHeader = request.headers.get(PASSWORD_HEADER);
    if (passHeader && !(await verifyDashboardPassword(passHeader))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const providerParam = searchParams.get("provider");
    const provider = providerParam ? normalizeProviderId(providerParam) : null;

    const filter = provider ? { provider } : {};
    const connections = await getProviderConnections(filter);

    // Keep all credentials (accessToken, refreshToken, apiKey, idToken, etc.)
    // Only strip transient runtime status/counters.
    const cleanConnections = connections.map((c) => {
      const {
        lastTested,
        lastError,
        lastErrorAt,
        consecutiveUseCount,
        rateLimitedUntil,
        ...rest
      } = c;
      return rest;
    });

    return NextResponse.json({
      version: 1,
      provider: provider || "all",
      exportedAt: new Date().toISOString(),
      connections: cleanConnections,
    });
  } catch (error) {
    console.error("Provider export error:", error);
    return NextResponse.json({ error: "Failed to export connections" }, { status: 500 });
  }
}
