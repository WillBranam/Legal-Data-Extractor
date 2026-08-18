import { NextResponse } from "next/server";
import {
  localOnlyModeEnabled,
  osAccountLocalSession,
  verifyAuditChain
} from "@/lib/local-vault";

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

export async function requireLocalSession(request: Request, mutation = false) {
  assertLocalRequest(request, mutation);
  const session = await osAccountLocalSession();
  if (mutation && !(await verifyAuditChain(session)).valid) {
    throw new Error("AUDIT_CHAIN_INVALID");
  }
  return session;
}

// Only these codes are echoed to the client. Anything else — a JSON
// SyntaxError, a filesystem path, a model response — is replaced with a generic
// code so internal detail and any document-derived text stay inside the server.
const DISCLOSABLE_ERROR_CODES = new Set([
  "LOCAL_MODE_DISABLED",
  "LOOPBACK_REQUIRED",
  "ORIGIN_MISMATCH",
  "WORKSPACE_CONFLICT",
  "AUDIT_CHAIN_INVALID",
  "MODEL_OUTPUT_TRUNCATED",
  "MODEL_OUTPUT_MALFORMED",
  "LOCAL_MODEL_UNAVAILABLE",
  "LOCAL_MODEL_EMPTY_RESPONSE",
  "LOCAL_MODEL_DEADLINE_EXCEEDED",
  "LOCAL_MODEL_MUST_USE_LOOPBACK",
  "LOCAL_MODEL_NAME_REQUIRED",
  "LOCAL_VISUAL_MODEL_NAME_REQUIRED",
  "INVALID_LOCAL_MODEL_URL",
  "CANONICAL_ARTIFACT_TOO_LARGE",
  "DOCUMENT_PAGE_LIMIT_EXCEEDED",
  "EXTRACTION_REQUEST_TOO_LARGE",
  "WORKSPACE_TOO_LARGE",
  "REVIEW_PAGE_NOT_FOUND"
]);

export function disclosableErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (DISCLOSABLE_ERROR_CODES.has(raw)) return raw;
  if (/^LOCAL_(MODEL|VISUAL_MODEL|API)_HTTP_\d{3}$/.test(raw)) return raw;
  return "LOCAL_API_ERROR";
}

export function localApiError(error: unknown): NextResponse {
  const code = disclosableErrorCode(error);
  const status =
    code === "LOCAL_MODE_DISABLED" || code === "LOOPBACK_REQUIRED"
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
