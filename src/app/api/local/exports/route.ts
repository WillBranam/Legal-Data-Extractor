import { NextResponse } from "next/server";
import { z } from "zod";
import { startExportJob } from "@/lib/export-jobs";
import { localApiError, readBoundedJson, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exportRequestSchema = z.object({
  status: z.enum(["final", "partial"]).default("final"),
  includeOriginals: z.boolean().default(true),
  includeCanonicalArtifacts: z.boolean().default(true),
  includePageImages: z.boolean().default(true),
  formats: z.array(z.enum(["sqlite", "docx", "xlsx", "pdf", "csv", "jsonl"])).min(1).max(6).default(["sqlite", "docx", "xlsx", "pdf", "csv", "jsonl"]),
  sensitiveDataAcknowledged: z.literal(true)
});

export async function POST(request: Request) {
  try {
    const session = await requireLocalSession(request, true);
    const input = exportRequestSchema.parse(await readBoundedJson(request, 16 * 1024, "EXPORT_REQUEST_TOO_LARGE"));
    const job = await startExportJob(session, {
      exportStatus: input.status,
      includeOriginals: input.includeOriginals,
      includeCanonicalArtifacts: input.includeCanonicalArtifacts,
      includePageImages: input.includePageImages,
      formats: input.formats
    });
    return NextResponse.json(job, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return localApiError(error);
  }
}
