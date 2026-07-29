import { NextResponse } from "next/server";
import { z } from "zod";
import { localApiError, requireLocalSession } from "@/lib/local-request";
import { appendAuditEvent } from "@/lib/local-vault";

export const runtime = "nodejs";

const auditSchema = z.object({
  action: z.enum([
    "review.approve",
    "review.reject",
    "export.csv",
    "export.xlsx",
    "export.json",
    "export.docx",
    "matter.legal-hold-enable",
    "matter.legal-hold-release"
  ]),
  resourceType: z.enum(["fact", "matter", "export"]),
  resourceId: z.string().max(100).nullable()
});

export async function POST(request: Request) {
  try {
    const session = await requireLocalSession(request, true);
    const input = auditSchema.parse(await request.json());
    await appendAuditEvent(
      session.key,
      session.username,
      input.action,
      "success",
      input.resourceType,
      input.resourceId
    );
    return NextResponse.json(
      { status: "recorded" },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return localApiError(error);
  }
}
