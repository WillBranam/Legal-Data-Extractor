import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveDocumentMatterMatch } from "@/lib/administrative-records";
import { localApiError, readBoundedJson, requireLocalSession } from "@/lib/local-request";
import { appendAuditEvent, readLocalWorkspaceSnapshot, writeLocalWorkspace } from "@/lib/local-vault";

export const runtime = "nodejs";
const schema = z.object({ decision: z.enum(["attach", "exclude"]) });
export async function POST(request: Request, context: { params: Promise<{ matterId: string; exceptionId: string }> }) { try { const session = await requireLocalSession(request, true); const { matterId, exceptionId: documentId } = await context.params; const snapshot = await readLocalWorkspaceSnapshot(session); if (!snapshot.workspace || snapshot.workspace.matter.id !== matterId) throw new Error("MATTER_NOT_FOUND"); if (!snapshot.workspace.documents.some((item) => item.id === documentId)) throw new Error("DOCUMENT_NOT_FOUND"); const { decision } = schema.parse(await readBoundedJson(request, 1024, "DECISION_TOO_LARGE")); const next = resolveDocumentMatterMatch(snapshot.workspace, documentId, decision); await writeLocalWorkspace(session, next, snapshot.revision); await appendAuditEvent(session.key, session.username, `document.${decision}`, "success", "document", documentId); return NextResponse.json({ document: next.documents.find((item) => item.id === documentId) }); } catch (error) { return localApiError(error); } }
