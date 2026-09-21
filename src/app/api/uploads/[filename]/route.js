import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { UPLOADS_DIR, getMimeByExt } from "@/lib/uploadService.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sanitizeFilename(filename) {
  const safe = path.basename(filename || "");
  if (!safe || !/^[a-zA-Z0-9_.-]+$/.test(safe)) return null;
  return safe;
}

export async function GET(request, { params }) {
  const resolvedParams = await params;
  const rawFilename = resolvedParams?.filename;
  const filename = sanitizeFilename(rawFilename);

  if (!filename) {
    return new NextResponse("Invalid filename", { status: 400 });
  }

  const filePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return new NextResponse("File not found or expired", { status: 404 });
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return new NextResponse("Not a file", { status: 400 });
    }

    const ext = path.extname(filename).replace(".", "");
    const mimeType = getMimeByExt(ext);
    const fileBuffer = fs.readFileSync(filePath);

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(fileBuffer.length),
        "Cache-Control": "public, max-age=1800, stale-while-revalidate=60",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new NextResponse(`Error reading file: ${err.message}`, { status: 500 });
  }
}

export async function HEAD(request, { params }) {
  const resolvedParams = await params;
  const rawFilename = resolvedParams?.filename;
  const filename = sanitizeFilename(rawFilename);

  if (!filename) {
    return new NextResponse(null, { status: 400 });
  }

  const filePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return new NextResponse(null, { status: 404 });
  }

  const ext = path.extname(filename).replace(".", "");
  const mimeType = getMimeByExt(ext);
  const stat = fs.statSync(filePath);

  return new NextResponse(null, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(stat.size),
      "Cache-Control": "public, max-age=1800, stale-while-revalidate=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
