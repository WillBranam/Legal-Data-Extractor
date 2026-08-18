import { NextResponse } from "next/server";
import { localVaultStatus } from "@/lib/local-vault";
import { assertLocalRequest, localApiError } from "@/lib/local-request";
import { localModelStatus } from "@/lib/local-llm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const [vault, model] = await Promise.all([
      localVaultStatus(),
      localModelStatus()
    ]);
    return NextResponse.json(
      { ...vault, model },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return localApiError(error);
  }
}
