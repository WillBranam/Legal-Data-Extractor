import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  const localMode = process.env.LOCAL_ONLY_MODE === "enabled";
  return NextResponse.json(
    {
      status: "ok",
      phiMode:
        localMode && process.env.PHI_MODE === "enabled" ? "local-technical-profile" : "disabled",
      localMode,
      storageBoundary: localMode ? "encrypted-local-vault" : "browser-local",
      outboundModelAccess: false,
      localModelAccess: localMode ? "loopback-only" : "disabled"
    },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
