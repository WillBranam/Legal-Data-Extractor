import { NextResponse } from "next/server";
import { z } from "zod";
import { localApiError, readBoundedJson, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";

const requestSchema = z.object({
  customReports: z.array(z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(2000) })).max(12).default([])
});

export async function POST(request: Request, context: { params: Promise<{ matterId: string }> }) {
  try {
    await requireLocalSession(request, true);
    const { matterId } = await context.params;
    const input = requestSchema.parse(await readBoundedJson(request, 32 * 1024, "REPORT_REQUEST_TOO_LARGE"));
    return NextResponse.json({ matterId, version: 2, standardReports: ["case_information_summary", "document_register"], narrativeSummaryEnabled: false, customReports: input.customReports.map((report, index) => ({ id: `custom-${index + 1}`, ...report, outputContract: "Table-based report using verified typed values and exact-source citations only." })), status: "ready-for-confirmation" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return localApiError(error);
  }
}
