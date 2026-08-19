import { NextResponse } from "next/server";
import { z } from "zod";
import { readLocalWorkspaceSnapshot } from "@/lib/local-vault";
import { localApiError, readBoundedJson, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";
const schema = z.object({ documentIds: z.array(z.string().max(100)).max(10_000).default([]) });
export async function POST(request: Request, context: { params: Promise<{ matterId: string }> }) { try { const session = await requireLocalSession(request, true); const { matterId } = await context.params; const { workspace } = await readLocalWorkspaceSnapshot(session); if (!workspace || workspace.matter.id !== matterId) throw new Error("MATTER_NOT_FOUND"); const { documentIds } = schema.parse(await readBoundedJson(request, 1024 * 1024, "IMPORT_REQUEST_TOO_LARGE")); const selected = documentIds.length ? workspace.documents.filter((item) => documentIds.includes(item.id)) : workspace.documents; return NextResponse.json({ matterId, status: "ready", resumable: true, documents: selected.map((item) => ({ documentId: item.id, processingState: item.processingState, requiresExtraction: !(workspace.fieldOccurrences ?? []).some((value) => value.documentId === item.id) })), fieldDefinitionIds: workspace.extractionSpecification?.fieldDefinitionIds ?? workspace.fieldDefinitions?.filter((item) => item.enabled).map((item) => item.id) ?? [] }, { status: 202, headers: { "Cache-Control": "no-store" } }); } catch (error) { return localApiError(error); } }
