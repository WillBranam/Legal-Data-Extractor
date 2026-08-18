import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveOccurrenceException } from "@/lib/administrative-records";
import { localApiError, readBoundedJson, requireLocalSession } from "@/lib/local-request";
import { appendAuditEvent, readLocalWorkspaceSnapshot, writeLocalWorkspace } from "@/lib/local-vault";

export const runtime = "nodejs";
const schema = z.object({ decision: z.enum(["verify", "withhold"]) });

export async function POST(request: Request, context: { params: Promise<{ matterId: string; exceptionId: string }> }) {
  try {
    const session = await requireLocalSession(request, true);
    const { matterId, exceptionId } = await context.params;
    const snapshot = await readLocalWorkspaceSnapshot(session);
    const workspace = snapshot.workspace;
    if (!workspace) return NextResponse.json({ error: "WORKSPACE_NOT_FOUND" }, { status: 404 });
    if (workspace.matter.id !== matterId) return NextResponse.json({ error: "MATTER_NOT_FOUND" }, { status: 404 });
    if (!(workspace.fieldOccurrences ?? []).some((item) => item.id === exceptionId)) return NextResponse.json({ error: "EXCEPTION_NOT_FOUND" }, { status: 404 });
    const { decision } = schema.parse(await readBoundedJson(request, 1024, "DECISION_TOO_LARGE"));
    const next = resolveOccurrenceException(workspace, exceptionId, decision);
    await writeLocalWorkspace(session, next, snapshot.revision);
    await appendAuditEvent(session.key, session.username, `exception.${decision}`, "success", "field-occurrence", exceptionId);
    return NextResponse.json({ occurrence: next.fieldOccurrences?.find((item) => item.id === exceptionId) });
  } catch (error) { return localApiError(error); }
}
