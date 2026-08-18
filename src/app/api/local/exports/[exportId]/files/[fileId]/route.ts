import { readExportFile } from "@/lib/export-jobs";
import { localApiError, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function disposition(filename: string): string {
  const safe = filename.replaceAll(/[\r\n"\\/]/g, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ exportId: string; fileId: string }> }
) {
  try {
    const session = await requireLocalSession(request);
    const { exportId, fileId } = await context.params;
    const result = await readExportFile(session, exportId, fileId);
    return new Response(new Uint8Array(result.bytes), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": disposition(result.file.path.split("/").at(-1) ?? "download"),
        "Content-Length": String(result.bytes.length),
        "Content-Type": result.file.contentType,
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return localApiError(error);
  }
}
