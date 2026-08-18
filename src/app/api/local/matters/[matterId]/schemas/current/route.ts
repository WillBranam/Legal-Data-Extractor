import { NextResponse } from "next/server";
import { z } from "zod";
import { fieldDefinitionSchema } from "@/lib/local-schemas";
import { localApiError, readBoundedJson, requireLocalSession } from "@/lib/local-request";
import { readLocalWorkspaceSnapshot, writeLocalWorkspace } from "@/lib/local-vault";

export const runtime = "nodejs";
const schema = z.object({ fieldDefinitions: z.array(fieldDefinitionSchema).max(10_000), customInstructions: z.string().max(10_000).default("") });
export async function PATCH(request: Request, context: { params: Promise<{ matterId: string }> }) {
  try { const session = await requireLocalSession(request, true); const { matterId } = await context.params; const snapshot = await readLocalWorkspaceSnapshot(session); if (!snapshot.workspace || snapshot.workspace.matter.id !== matterId) throw new Error("MATTER_NOT_FOUND"); const input = schema.parse(await readBoundedJson(request, 2 * 1024 * 1024, "SCHEMA_REQUEST_TOO_LARGE")); const workspace = { ...snapshot.workspace, fieldDefinitions: input.fieldDefinitions, extractionSpecification: { version: 2 as const, fieldDefinitionIds: input.fieldDefinitions.filter((item) => item.enabled).map((item) => item.id), customInstructions: input.customInstructions, detectedDocumentTypes: [...new Set(snapshot.workspace.documents.map((item) => item.documentType ?? "unclassified"))], detectedLanguages: [...new Set(snapshot.workspace.documents.map((item) => item.detectedLanguage ?? "unknown"))], confirmedAt: new Date().toISOString() } }; await writeLocalWorkspace(session, workspace, snapshot.revision); return NextResponse.json({ specification: workspace.extractionSpecification }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return localApiError(error); }
}
