import { NextResponse } from "next/server";
import { z } from "zod";
import { extractWithLocalModel } from "@/lib/local-llm";
import { evidenceDocumentSchema, fieldDefinitionSchema } from "@/lib/local-schemas";
import {
  localApiError,
  readBoundedJson,
  requireLocalSession
} from "@/lib/local-request";
import { appendAuditEvent } from "@/lib/local-vault";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  document: evidenceDocumentSchema,
  fieldDefinitions: z.array(fieldDefinitionSchema).max(10_000).default([])
});

export async function POST(request: Request) {
  try {
    const session = await requireLocalSession(request, true);
    const { document: evidenceDocument, fieldDefinitions } = requestSchema.parse(
      await readBoundedJson(
        request,
        20 * 1024 * 1024,
        "EXTRACTION_REQUEST_TOO_LARGE"
      )
    );
    const result = await extractWithLocalModel(evidenceDocument, fieldDefinitions);
    await appendAuditEvent(
      session.key,
      session.username,
      "model.extract-review-consensus",
      "success",
      "document",
      evidenceDocument.id
    );
    return NextResponse.json(
      result,
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return localApiError(error);
  }
}
