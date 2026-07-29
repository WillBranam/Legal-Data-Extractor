import { Readable } from "node:stream";
import { createEncryptedLocalBackupStream } from "@/lib/local-vault";
import { localApiError, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const session = await requireLocalSession(request, true);
    const backup = await createEncryptedLocalBackupStream(session);
    return new Response(Readable.toWeb(backup) as ReadableStream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="verity-encrypted-backup-${new Date()
          .toISOString()
          .slice(0, 10)}.zip"`,
        "Content-Type": "application/zip",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return localApiError(error);
  }
}
