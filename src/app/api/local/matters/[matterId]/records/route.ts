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
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const category = url.searchParams.get("category");
    const definitions = new Map((workspace.fieldDefinitions ?? []).map((item) => [item.id, item]));
    const occurrences = (workspace.fieldOccurrences ?? []).filter((item) => (!status || item.status === status) && (!category || definitions.get(item.fieldDefinitionId)?.category === category));
    return NextResponse.json({ fieldDefinitions: workspace.fieldDefinitions ?? [], occurrences, canonicalValues: workspace.canonicalValues ?? [], entities: workspace.entities ?? [], relationships: workspace.relationships ?? [], signatures: workspace.signatures ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return localApiError(error); }
}
