import { NextResponse } from "next/server";
import { z } from "zod";
import type { WorkspaceState } from "@/lib/types";
import {
  deleteLocalWorkspace,
  readLocalWorkspace,
  writeLocalWorkspace
} from "@/lib/local-vault";
import { localApiError, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";

const workspaceEnvelopeSchema = z.object({
  workspace: z.unknown()
});

export async function GET(request: Request) {
  try {
    const session = await requireLocalSession(request);
    return NextResponse.json(
      { workspace: await readLocalWorkspace(session) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return localApiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requireLocalSession(request, true);
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > 64 * 1024 * 1024) throw new Error("WORKSPACE_TOO_LARGE");
    const { workspace } = workspaceEnvelopeSchema.parse(await request.json());
    await writeLocalWorkspace(session, workspace as WorkspaceState);
    return NextResponse.json(
      { status: "saved" },
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
