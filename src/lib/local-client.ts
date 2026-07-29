"use client";

import type { EvidenceDocument, FactRecord } from "@/lib/types";
import type { LocalExtractionProposal } from "@/lib/local-llm";

export interface LocalRuntimeStatus {
  enabled: boolean;
  configured: boolean;
  authenticated: boolean;
  username: string | null;
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
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replaceAll(/[\\/]/g, "_");
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function extractDocumentWithLocalModel(
  document: EvidenceDocument
): Promise<LocalExtractionProposal[]> {
  const result = await localRequest<{ proposals: LocalExtractionProposal[] }>(
    "/api/local/extract",
    {
      method: "POST",
      body: JSON.stringify({ document })
    }
  );
  return result.proposals;
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
    | "export.csv"
    | "export.xlsx"
    | "export.json"
    | "export.docx"
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
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1] ?? "verity-encrypted-backup.zip";
  anchor.click();
  URL.revokeObjectURL(url);
}
