import { NextResponse } from "next/server";
import { z } from "zod";
import { extractWithLocalModel } from "@/lib/local-llm";
import { evidenceDocumentSchema } from "@/lib/local-schemas";
import {
  localApiError,
  readBoundedJson,
  requireLocalSession
} from "@/lib/local-request";
import { appendAuditEvent } from "@/lib/local-vault";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  document: evidenceDocumentSchema
});

export async function POST(request: Request) {
  try {
    const session = await requireLocalSession(request, true);
    const { document: evidenceDocument } = requestSchema.parse(
      await readBoundedJson(
        request,
        20 * 1024 * 1024,
        "EXTRACTION_REQUEST_TOO_LARGE"
      )
    );
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
