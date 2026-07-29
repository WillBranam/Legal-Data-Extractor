import { NextResponse } from "next/server";
import { localVaultStatus } from "@/lib/local-vault";
import {
  assertLocalRequest,
  LOCAL_SESSION_COOKIE,
  localApiError,
  readCookie
} from "@/lib/local-request";
import { localModelStatus } from "@/lib/local-llm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    const [vault, model] = await Promise.all([
      localVaultStatus(readCookie(request, LOCAL_SESSION_COOKIE)),
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
