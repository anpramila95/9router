import { NextResponse } from "next/server";
import { createProviderConnection, getProviderConnections } from "@/models";
import { normalizeProviderId } from "@/lib/providerNormalization";

export const dynamic = "force-dynamic";

// POST /api/providers/import - Bulk import provider connections (API Key / OAuth)
export async function POST(request) {
  try {
    const body = await request.json();
    const connections = Array.isArray(body)
      ? body
      : Array.isArray(body?.connections)
      ? body.connections
      : [];

    if (!connections.length) {
      return NextResponse.json({ error: "No connections provided" }, { status: 400 });
    }

    const existing = await getProviderConnections();
    let imported = 0;
    let failed = 0;

    for (const item of connections) {
      if (!item || typeof item !== "object") {
        failed++;
        continue;
      }

      const provider = normalizeProviderId(item.provider) || item.provider;
      if (!provider) {
        failed++;
        continue;
      }

      // Preserve all fields dynamically from JSON export
      const { id, createdAt, updatedAt, ...rest } = item;
      const authType = rest.authType || (rest.accessToken || rest.refreshToken ? "oauth" : "apikey");
      const name = rest.name || rest.email || rest.displayName || `${provider} connection`;

      try {
        await createProviderConnection({
          ...rest,
          provider,
          authType,
          name,
          testStatus: rest.testStatus || "active",
          isActive: rest.isActive !== false,
        });
        imported++;
      } catch (err) {
        console.error("Import connection error:", err);
        failed++;
      }
    }

    return NextResponse.json({ success: true, imported, failed, total: connections.length });
  } catch (error) {
    console.error("Bulk connection import error:", error);
    return NextResponse.json({ error: "Failed to import connections" }, { status: 500 });
  }
}
