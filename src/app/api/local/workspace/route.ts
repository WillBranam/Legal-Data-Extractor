import { NextResponse } from "next/server";
import { z } from "zod";
import { workspaceStateSchema } from "@/lib/local-schemas";
import {
  deleteLocalWorkspace,
  readLocalWorkspaceSnapshot,
  writeLocalWorkspace
} from "@/lib/local-vault";
import {
  localApiError,
  readBoundedJson,
  requireLocalSession
} from "@/lib/local-request";

export const runtime = "nodejs";

const workspaceEnvelopeSchema = z.object({
  workspace: workspaceStateSchema,
  revision: z.string().length(64).nullable(),
  releaseLegalHold: z.boolean().default(false)
});

export async function GET(request: Request) {
  try {
    const session = await requireLocalSession(request);
    const snapshot = await readLocalWorkspaceSnapshot(session);
    return NextResponse.json(
      snapshot,
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return localApiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requireLocalSession(request, true);
    const { workspace, revision, releaseLegalHold } = workspaceEnvelopeSchema.parse(
      await readBoundedJson(request, 256 * 1024 * 1024, "WORKSPACE_TOO_LARGE")
    );
    const nextRevision = await writeLocalWorkspace(
      session,
      workspace,
      revision,
      releaseLegalHold
    );
    return NextResponse.json(
      { status: "saved", revision: nextRevision },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return localApiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireLocalSession(request, true);
    await deleteLocalWorkspace(session);
    return NextResponse.json(
      { status: "deleted" },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return localApiError(error);
  }
}
