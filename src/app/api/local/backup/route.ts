import { createEncryptedLocalBackup } from "@/lib/local-vault";
import { localApiError, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const session = await requireLocalSession(request, true);
    const backup = await createEncryptedLocalBackup(session);
    return new Response(new Uint8Array(backup), {
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
