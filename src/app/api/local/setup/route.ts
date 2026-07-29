import { NextResponse } from "next/server";
import { z } from "zod";
import { setupLocalVault } from "@/lib/local-vault";
import {
  assertLocalRequest,
  localApiError,
  localSessionCookie,
  readBoundedJson
} from "@/lib/local-request";

export const runtime = "nodejs";

const setupSchema = z.object({
  username: z.string().trim().min(3).max(80),
  password: z.string().min(14).max(256)
});

export async function POST(request: Request) {
  try {
    assertLocalRequest(request, true);
    const input = setupSchema.parse(
      await readBoundedJson(request, 4096, "SETUP_REQUEST_TOO_LARGE")
    );
    const token = await setupLocalVault(input);
    return NextResponse.json(
      { status: "configured" },
      {
        status: 201,
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": localSessionCookie(token)
        }
      }
    );
  } catch (error) {
    return localApiError(error);
  }
}
