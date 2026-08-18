"use client";

import type { EvidenceDocument, FactRecord, FieldDefinition, InformationQueryAnswer } from "@/lib/types";
import type { LocalExtractionResult } from "@/lib/local-llm";

export interface LocalRuntimeStatus {
  enabled: boolean;
  configured: boolean;
  username: string | null;
  legacyVaultArchived: boolean;
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
    visualModel: string;
    visualInstalled: boolean;
    boundary: "loopback-only";
  };
}

export interface LocalExportFile {
  id: string;
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface LocalExportJob {
  id: string;
  matterId: string;
  status: "queued" | "running" | "ready" | "failed";
  phase: "queued" | "snapshot" | "sqlite" | "xlsx" | "docx" | "pdf" | "evidence" | "verify" | "hash" | "ready";
  progress: number;
  message: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string;
  packageName: string | null;
  packageFileId: string | null;
  files: LocalExportFile[];
  verification: { verified: boolean; checkedAt: string; failures: string[] } | null;
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
  document: EvidenceDocument,
  fieldDefinitions: FieldDefinition[] = []
): Promise<LocalExtractionResult> {
  const body = JSON.stringify({ document, fieldDefinitions });
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

export function queryCaseInformation(matterId: string, question: string): Promise<InformationQueryAnswer> {
  return localRequest<InformationQueryAnswer>(`/api/local/matters/${encodeURIComponent(matterId)}/query`, {
    method: "POST",
    body: JSON.stringify({ question })
  });
}

export async function resolveInformationException(matterId: string, occurrenceId: string, decision: "verify" | "withhold"): Promise<void> {
  await localRequest(`/api/local/matters/${encodeURIComponent(matterId)}/exceptions/${encodeURIComponent(occurrenceId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({ decision })
  });
}

export async function resolveDocumentException(matterId: string, documentId: string, decision: "attach" | "exclude"): Promise<void> {
  await localRequest(`/api/local/matters/${encodeURIComponent(matterId)}/exceptions/${encodeURIComponent(documentId)}/document`, { method: "POST", body: JSON.stringify({ decision }) });
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

export function startCompleteLocalExport(status: "final" | "partial" = "final"): Promise<LocalExportJob> {
  return localRequest<LocalExportJob>("/api/local/exports", {
    method: "POST",
    body: JSON.stringify({
      status,
      includeOriginals: true,
      includeCanonicalArtifacts: true,
      includePageImages: true,
      formats: ["sqlite", "docx", "xlsx", "pdf", "csv", "jsonl"],
      sensitiveDataAcknowledged: true
    })
  });
}

export function getLocalExportJob(exportId: string): Promise<LocalExportJob> {
  return localRequest<LocalExportJob>(`/api/local/exports/${encodeURIComponent(exportId)}`);
}

export async function downloadLocalExportFile(
  exportId: string,
  file: LocalExportFile
): Promise<void> {
  const response = await fetch(
    `/api/local/exports/${encodeURIComponent(exportId)}/files/${encodeURIComponent(file.id)}`,
    { credentials: "same-origin", cache: "no-store" }
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `LOCAL_API_HTTP_${response.status}`);
  }
  downloadBlob(await response.blob(), file.path.split("/").at(-1) ?? "verity-export");
}

export function verifyLocalExport(exportId: string): Promise<{
  verified: boolean;
  checkedAt: string;
  failures: string[];
}> {
  return localRequest(`/api/local/exports/${encodeURIComponent(exportId)}/verify`);
}
