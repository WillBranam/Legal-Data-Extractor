import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      phiMode: process.env.PHI_MODE === "enabled" ? "enabled" : "disabled",
      storageBoundary: "browser-local",
      outboundModelAccess: false
    },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
