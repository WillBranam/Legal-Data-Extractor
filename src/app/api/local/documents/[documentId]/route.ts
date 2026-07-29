import { NextResponse } from "next/server";
import { localApiError, requireLocalSession } from "@/lib/local-request";
import { readOriginalDocument, storeOriginalDocument } from "@/lib/local-vault";

export const runtime = "nodejs";

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;

export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> }
) {
  try {
    const session = await requireLocalSession(request);
    const { documentId } = await context.params;
    const bytes = await readOriginalDocument(session, documentId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": "attachment",
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return localApiError(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ documentId: string }> }
) {
  try {
    const session = await requireLocalSession(request, true);
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_SOURCE_BYTES) throw new Error("SOURCE_FILE_TOO_LARGE");
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error("SOURCE_FILE_TOO_LARGE");
    const { documentId } = await context.params;
    await storeOriginalDocument(session, documentId, bytes);
    bytes.fill(0);
    return NextResponse.json(
      { status: "stored" },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return localApiError(error);
  }
}
