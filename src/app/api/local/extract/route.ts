import { NextResponse } from "next/server";
import { z } from "zod";
import type { EvidenceDocument } from "@/lib/types";
import { extractWithLocalModel } from "@/lib/local-llm";
import { localApiError, requireLocalSession } from "@/lib/local-request";
import { appendAuditEvent } from "@/lib/local-vault";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  document: z.unknown()
});

export async function POST(request: Request) {
  try {
    const session = await requireLocalSession(request, true);
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > 20 * 1024 * 1024) throw new Error("EXTRACTION_REQUEST_TOO_LARGE");
    const { document } = requestSchema.parse(await request.json());
    const evidenceDocument = document as EvidenceDocument;
    const proposals = await extractWithLocalModel(evidenceDocument);
    await appendAuditEvent(
      session.key,
      session.username,
      "model.extract",
      "success",
      "document",
      evidenceDocument.id
    );
    return NextResponse.json(
      { proposals },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return localApiError(error);
  }
}
