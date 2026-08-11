"use client";

import type { EvidenceDocument, FactRecord } from "@/lib/types";
import type { LocalExtractionResult } from "@/lib/local-llm";

export interface LocalRuntimeStatus {
  enabled: boolean;
  configured: boolean;
  authenticated: boolean;
  username: string | null;
  accessMode: "macos-keychain" | "legacy-password";
  storage: "encrypted-local-vault";
  networkBoundary: "loopback-only";
  audit: {
    valid: boolean;
    records: number;
  } | null;
  model: {
    provider: "ollama";
    model: string;
    reachable: boolean;
    installed: boolean;
    boundary: "loopback-only";
  };
}

async function localRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `LOCAL_API_HTTP_${response.status}`);
  return body;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replaceAll(/[\\/]/g, "_");
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function getLocalRuntimeStatus(): Promise<LocalRuntimeStatus> {
  return localRequest<LocalRuntimeStatus>("/api/local/status");
}

export async function setupLocalRuntime(input: {
  username: string;
  password: string;
}): Promise<void> {
  await localRequest("/api/local/setup", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function loginLocalRuntime(input: {
  username: string;
  password: string;
}): Promise<void> {
  await localRequest("/api/local/session", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function logoutLocalRuntime(): Promise<void> {
  await localRequest("/api/local/session", { method: "DELETE" });
}

export async function storeOriginalFile(documentId: string, file: File): Promise<void> {
  const response = await fetch(`/api/local/documents/${encodeURIComponent(documentId)}`, {
    method: "PUT",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": file.type || "application/octet-stream"
    },
    body: file
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `LOCAL_API_HTTP_${response.status}`);
  }
}

export async function deleteStagedOriginalFile(documentId: string): Promise<void> {
  const response = await fetch(
    `/api/local/documents/${encodeURIComponent(documentId)}`,
    { method: "DELETE", credentials: "same-origin", cache: "no-store" }
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `LOCAL_API_HTTP_${response.status}`);
  }
}

export async function downloadOriginalFile(
  documentId: string,
  filename: string
): Promise<void> {
  const response = await fetch(`/api/local/documents/${encodeURIComponent(documentId)}`, {
    credentials: "same-origin",
    cache: "no-store"
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `LOCAL_API_HTTP_${response.status}`);
  }
  downloadBlob(await response.blob(), filename);
}

export async function extractDocumentWithLocalModel(
  document: EvidenceDocument
): Promise<LocalExtractionResult> {
  const body = JSON.stringify({ document });
  if (new TextEncoder().encode(body).byteLength > 20 * 1024 * 1024) {
    throw new Error("EXTRACTION_REQUEST_TOO_LARGE");
  }
  return localRequest<LocalExtractionResult>(
    "/api/local/extract",
    {
      method: "POST",
      body
    }
  );
}

export async function selectFactsWithLocalModel(input: {
  matterId: string;
  question: string;
  facts: FactRecord[];
}): Promise<string[]> {
  const result = await localRequest<{ factIds: string[] }>("/api/local/query", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return result.factIds;
}

export async function recordLocalAuditEvent(input: {
  action:
    | "review.approve"
    | "review.reject"
    | "export.csv.attempt"
    | "export.xlsx.attempt"
    | "export.json.attempt"
    | "export.docx.attempt"
    | "matter.legal-hold-enable"
    | "matter.legal-hold-release";
  resourceType: "fact" | "matter" | "export";
  resourceId: string | null;
}): Promise<void> {
  await localRequest("/api/local/audit", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function downloadEncryptedBackup(): Promise<void> {
  const response = await fetch("/api/local/backup", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store"
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `LOCAL_API_HTTP_${response.status}`);
  }
  const filename =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1] ?? "verity-encrypted-backup.zip";
  downloadBlob(await response.blob(), filename);
}
