import { NextResponse } from "next/server";
import { assertLocalRequest } from "@/lib/local-request";

export const runtime = "nodejs";

export async function POST(request: Request) {
  assertLocalRequest(request);
  return NextResponse.json(
    { error: "LEGACY_NARRATIVE_QUERY_RETIRED", replacement: "/api/local/matters/{matterId}/query" },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}
