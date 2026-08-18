import { NextResponse } from "next/server";
import { z } from "zod";
import { defaultFieldDefinitions } from "@/lib/field-registry";
import { readLocalWorkspaceSnapshot } from "@/lib/local-vault";
import { localApiError, readBoundedJson, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";
const requestSchema = z.object({ description: z.string().trim().max(4000).default("") });

export async function POST(request: Request, context: { params: Promise<{ matterId: string }> }) {
  try {
    const session = await requireLocalSession(request, true); const { matterId } = await context.params;
    const { workspace } = await readLocalWorkspaceSnapshot(session); if (!workspace || workspace.matter.id !== matterId) throw new Error("MATTER_NOT_FOUND");
    const { description } = requestSchema.parse(await readBoundedJson(request, 16 * 1024, "SCHEMA_REQUEST_TOO_LARGE"));
    const fields = workspace.fieldDefinitions?.length ? workspace.fieldDefinitions : defaultFieldDefinitions();
    return NextResponse.json({ matterId, version: 2, sourceRequest: description, documentTypes: [...new Set(workspace.documents.map((item) => item.documentType ?? "unclassified"))], languages: [...new Set(workspace.documents.map((item) => item.detectedLanguage ?? "unknown"))], fieldDefinitions: fields, otherImportantFieldsEnabled: true, narrativeFactsEnabled: false, status: "ready-for-confirmation" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return localApiError(error); }
}
