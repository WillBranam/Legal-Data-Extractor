import { NextResponse } from "next/server";
import { z } from "zod";
import { selectApprovedFactsWithLocalModel } from "@/lib/local-llm";
import { factRecordSchema } from "@/lib/local-schemas";
import {
  localApiError,
  readBoundedJson,
  requireLocalSession
} from "@/lib/local-request";
import { appendAuditEvent } from "@/lib/local-vault";

export const runtime = "nodejs";

const requestSchema = z.object({
  matterId: z.string().min(1).max(100),
  question: z.string().trim().min(1).max(2000),
  facts: z.array(factRecordSchema).max(1000)
});

export async function POST(request: Request) {
  try {
    const session = await requireLocalSession(request, true);
    const input = requestSchema.parse(
      await readBoundedJson(request, 8 * 1024 * 1024, "QUERY_REQUEST_TOO_LARGE")
    );
    const factIds = await selectApprovedFactsWithLocalModel({
      question: input.question,
      facts: input.facts
    });
    await appendAuditEvent(
      session.key,
      session.username,
      "model.query-plan",
      "success",
      "matter",
      input.matterId
    );
    return NextResponse.json(
      { factIds },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return localApiError(error);
  }
}
