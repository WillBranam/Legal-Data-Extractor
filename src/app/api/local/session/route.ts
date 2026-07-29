import { NextResponse } from "next/server";
import { z } from "zod";
import { loginLocalVault, logoutLocalVault } from "@/lib/local-vault";
import {
  assertLocalRequest,
  clearLocalSessionCookie,
  LOCAL_SESSION_COOKIE,
  localApiError,
  localSessionCookie,
  readCookie
} from "@/lib/local-request";

export const runtime = "nodejs";

const loginSchema = z.object({
  username: z.string().trim().min(3).max(80),
  password: z.string().min(1).max(256)
});

const attempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(request: Request): void {
  const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "loopback";
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return;
  }
  if (current.count >= 5) throw new Error("LOGIN_RATE_LIMITED");
  current.count += 1;
}

export async function POST(request: Request) {
  try {
    assertLocalRequest(request, true);
    checkRateLimit(request);
    const input = loginSchema.parse(await request.json());
    const token = await loginLocalVault(input);
    if (!token) {
      return NextResponse.json(
        { error: "INVALID_CREDENTIALS" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
    attempts.clear();
    return NextResponse.json(
      { status: "authenticated" },
      {
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

export async function DELETE(request: Request) {
  try {
    assertLocalRequest(request, true);
    await logoutLocalVault(readCookie(request, LOCAL_SESSION_COOKIE));
    return NextResponse.json(
      { status: "signed_out" },
      {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": clearLocalSessionCookie()
        }
      }
    );
  } catch (error) {
    return localApiError(error);
  }
}
