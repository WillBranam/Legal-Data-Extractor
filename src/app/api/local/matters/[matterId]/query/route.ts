import { NextResponse } from "next/server";
import { z } from "zod";
import { queryAdministrativeInformation } from "@/lib/information-query";
import { readLocalWorkspace } from "@/lib/local-vault";
import { localApiError, readBoundedJson, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";
const schema = z.object({ question: z.string().trim().min(2).max(2000) });

export async function POST(request: Request, context: { params: Promise<{ matterId: string }> }) {
  try {
    const session = await requireLocalSession(request, true);
    const { matterId } = await context.params;
    const workspace = await readLocalWorkspace(session);
    if (!workspace) return NextResponse.json({ error: "WORKSPACE_NOT_FOUND" }, { status: 404 });
    if (workspace.matter.id !== matterId) return NextResponse.json({ error: "MATTER_NOT_FOUND" }, { status: 404 });
    const { question } = schema.parse(await readBoundedJson(request, 16_384, "QUERY_TOO_LARGE"));
    return NextResponse.json(queryAdministrativeInformation(question, workspace), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return localApiError(error); }
}
