import { NextResponse } from "next/server";
import {
  authenticateLocalSession,
  localOnlyModeEnabled,
  osAccountLocalSession,
  verifyAuditChain
} from "@/lib/local-vault";

export const LOCAL_SESSION_COOKIE = "verity_local_session";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export async function readBoundedBody(
  request: Request,
  maximumBytes: number,
  errorCode: string
): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(errorCode);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel(errorCode);
        throw new Error(errorCode);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function readBoundedJson(
  request: Request,
  maximumBytes: number,
  errorCode: string
): Promise<unknown> {
  const bytes = await readBoundedBody(request, maximumBytes, errorCode);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } finally {
    bytes.fill(0);
  }
}

export function assertLocalRequest(request: Request, mutation = false): void {
  if (!localOnlyModeEnabled()) throw new Error("LOCAL_MODE_DISABLED");
  const url = new URL(request.url);
  const hostHeader = request.headers.get("host") ?? "";
  const headerHostname = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : hostHeader.split(":")[0];
  if (
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !LOOPBACK_HOSTS.has(headerHostname)
  ) {
    throw new Error("LOOPBACK_REQUIRED");
  }
  if (mutation) {
    const origin = request.headers.get("origin");
    const allowedOrigins = new Set([url.origin, `http://${hostHeader}`]);
    if (!origin || !allowedOrigins.has(origin)) throw new Error("ORIGIN_MISMATCH");
  }
}

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const entry of cookie.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export async function requireLocalSession(request: Request, mutation = false) {
  assertLocalRequest(request, mutation);
  const session =
    (await authenticateLocalSession(readCookie(request, LOCAL_SESSION_COOKIE))) ??
    (await osAccountLocalSession());
  if (!session) throw new Error("AUTHENTICATION_REQUIRED");
  if (mutation && !(await verifyAuditChain(session)).valid) {
    throw new Error("AUDIT_CHAIN_INVALID");
  }
  return session;
}

export function localSessionCookie(token: string): string {
  return `${LOCAL_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`;
}

export function clearLocalSessionCookie(): string {
  return `${LOCAL_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function localApiError(error: unknown): NextResponse {
  const code = error instanceof Error ? error.message : "LOCAL_API_ERROR";
  const status =
    code === "AUTHENTICATION_REQUIRED"
      ? 401
      : code === "LOCAL_MODE_DISABLED" || code === "LOOPBACK_REQUIRED"
        ? 404
        : code === "ORIGIN_MISMATCH"
          ? 403
          : code === "WORKSPACE_CONFLICT"
            ? 409
          : 400;
  return NextResponse.json(
    { error: code },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}
