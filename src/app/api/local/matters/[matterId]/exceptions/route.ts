import { NextResponse } from "next/server";
import { readLocalWorkspace } from "@/lib/local-vault";
import { localApiError, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ matterId: string }> }) {
  try {
    const session = await requireLocalSession(request, true);
    const { matterId } = await context.params;
    const workspace = await readLocalWorkspace(session);
    if (!workspace) return NextResponse.json({ error: "WORKSPACE_NOT_FOUND" }, { status: 404 });
    if (workspace.matter.id !== matterId) return NextResponse.json({ error: "MATTER_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ occurrences: (workspace.fieldOccurrences ?? []).filter((item) => item.status === "exception"), signatures: (workspace.signatures ?? []).filter((item) => item.reviewStatus === "exception"), documents: workspace.documents.filter((item) => item.matterMatchStatus === "quarantined" || item.matterMatchStatus === "review") }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return localApiError(error); }
}
