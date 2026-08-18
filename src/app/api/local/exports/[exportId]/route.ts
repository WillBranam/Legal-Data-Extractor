import { NextResponse } from "next/server";
import { getExportJob } from "@/lib/export-jobs";
import { localApiError, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ exportId: string }> }) {
  try {
    const session = await requireLocalSession(request);
    const { exportId } = await context.params;
    return NextResponse.json(await getExportJob(session, exportId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return localApiError(error);
  }
}
