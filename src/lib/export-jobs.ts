import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExportStatus } from "@/lib/export-snapshot";
import { createExportSnapshot } from "@/lib/export-snapshot";
import {
  buildExportPackage,
  type BuiltExportPackage,
  type ExportBuildOptions,
  type ExportBuildProgress
} from "@/lib/export-package";
import {
  appendAuditEvent,
  localDataDirectory,
  readLocalWorkspaceSnapshot,
  readOriginalDocument,
  type Session
} from "@/lib/local-vault";

const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExportFileDescriptor {
  id: string;
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface ExportJobStatus {
  id: string;
  matterId: string;
  status: "queued" | "running" | "ready" | "failed";
  phase: ExportBuildProgress["phase"] | "queued";
  progress: number;
  message: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string;
  packageName: string | null;
  packageFileId: string | null;
  files: ExportFileDescriptor[];
  verification: {
    verified: boolean;
    checkedAt: string;
    failures: string[];
  } | null;
}

interface ExportJob extends ExportJobStatus {
  actor: string;
  directory: string;
  diskFiles: Map<string, string>;
}

declare global {
  var __verityExportJobs: Map<string, ExportJob> | undefined;
}

function jobs(): Map<string, ExportJob> {
  globalThis.__verityExportJobs ??= new Map<string, ExportJob>();
  return globalThis.__verityExportJobs;
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".zip")) return "application/zip";
  if (filePath.endsWith(".sqlite")) return "application/vnd.sqlite3";
  if (filePath.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (filePath.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (filePath.endsWith(".pdf")) return "application/pdf";
  if (filePath.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (filePath.endsWith(".json") || filePath.endsWith(".jsonl")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function fileId(filePath: string): string {
  return Buffer.from(filePath, "utf8").toString("base64url");
}

function publicStatus(job: ExportJob): ExportJobStatus {
  return structuredClone({
    id: job.id,
    matterId: job.matterId,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    message: job.message,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    expiresAt: job.expiresAt,
    packageName: job.packageName,
    packageFileId: job.packageFileId,
    files: job.files,
    verification: job.verification
  });
}

async function cleanupExpiredJobs(): Promise<void> {
  const now = Date.now();
  for (const [id, job] of jobs()) {
    if (Date.parse(job.expiresAt) > now) continue;
    jobs().delete(id);
    await rm(job.directory, { recursive: true, force: true });
  }
}

async function persistBuiltPackage(job: ExportJob, built: BuiltExportPackage): Promise<void> {
  await mkdir(job.directory, { recursive: true, mode: 0o700 });
  await chmod(job.directory, 0o700);
  const descriptors: ExportFileDescriptor[] = [];
  for (const [relativePath, bytes] of built.files) {
    const id = fileId(relativePath);
    const diskPath = path.join(job.directory, id);
    await writeFile(diskPath, bytes, { mode: 0o600 });
    job.diskFiles.set(id, diskPath);
    descriptors.push({ id, path: relativePath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: contentType(relativePath) });
  }
  const zipName = `${built.packageName}.zip`;
  const zipId = fileId(zipName);
  const zipPath = path.join(job.directory, zipId);
  await writeFile(zipPath, built.zip, { mode: 0o600 });
  job.diskFiles.set(zipId, zipPath);
  descriptors.unshift({ id: zipId, path: zipName, size: built.zip.length, sha256: createHash("sha256").update(built.zip).digest("hex"), contentType: "application/zip" });
  job.packageName = zipName;
  job.packageFileId = zipId;
  job.files = descriptors;
}

export async function startExportJob(
  session: Session,
  input: ExportBuildOptions & { exportStatus: ExportStatus }
): Promise<ExportJobStatus> {
  await cleanupExpiredJobs();
  const { workspace } = await readLocalWorkspaceSnapshot(session);
  if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");
  const id = `JOB-${randomUUID()}`;
  const createdAt = new Date();
  const directory = path.join(localDataDirectory(), "exports", id);
  const job: ExportJob = {
    id,
    matterId: workspace.matter.id,
    actor: session.username,
    status: "queued",
    phase: "queued",
    progress: 0,
    message: "Export queued",
    error: null,
    createdAt: createdAt.toISOString(),
    completedAt: null,
    expiresAt: new Date(createdAt.getTime() + EXPORT_TTL_MS).toISOString(),
    packageName: null,
    packageFileId: null,
    files: [],
    verification: null,
    directory,
    diskFiles: new Map()
  };
  jobs().set(id, job);
  await appendAuditEvent(session.key, session.username, "export.package.attempt", "success", "export", workspace.matter.id);
  const exportSession: Session = {
    username: session.username,
    key: Buffer.from(session.key),
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt
  };
  void (async () => {
    try {
      job.status = "running";
      const snapshot = createExportSnapshot(workspace, input.exportStatus);
      const built = await buildExportPackage(
        snapshot,
        input,
        (documentId) => readOriginalDocument(exportSession, documentId),
        (progress) => {
          job.phase = progress.phase;
          job.progress = progress.progress;
          job.message = progress.message;
        }
      );
      await persistBuiltPackage(job, built);
      job.status = "ready";
      job.phase = "ready";
      job.progress = 1;
      job.message = "Verified package is ready to download";
      job.completedAt = new Date().toISOString();
      job.verification = await verifyExportJob(exportSession, id);
      await appendAuditEvent(exportSession.key, exportSession.username, "export.package.ready", "success", "export", workspace.matter.id);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "EXPORT_FAILED";
      job.message = "The package could not be created";
      job.completedAt = new Date().toISOString();
      await appendAuditEvent(exportSession.key, exportSession.username, "export.package.failed", "failure", "export", workspace.matter.id).catch(() => undefined);
    } finally {
      exportSession.key.fill(0);
    }
  })();
  return publicStatus(job);
}

export async function getExportJob(session: Session, id: string): Promise<ExportJobStatus> {
  await cleanupExpiredJobs();
  const job = jobs().get(id);
  if (!job || job.actor !== session.username) throw new Error("EXPORT_NOT_FOUND");
  return publicStatus(job);
}

export async function readExportFile(
  session: Session,
  id: string,
  requestedFileId: string
): Promise<{ bytes: Buffer; file: ExportFileDescriptor }> {
  const job = jobs().get(id);
  if (!job || job.actor !== session.username || job.status !== "ready") throw new Error("EXPORT_NOT_READY");
  const diskPath = job.diskFiles.get(requestedFileId);
  const file = job.files.find((item) => item.id === requestedFileId);
  if (!diskPath || !file) throw new Error("EXPORT_FILE_NOT_FOUND");
  const bytes = await readFile(diskPath);
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("EXPORT_FILE_HASH_MISMATCH");
  await appendAuditEvent(session.key, session.username, "export.file.download", "success", "export", `${job.matterId}:${file.path}`);
  return { bytes, file };
}

export async function verifyExportJob(
  session: Session,
  id: string
): Promise<{ verified: boolean; checkedAt: string; failures: string[] }> {
  const job = jobs().get(id);
  if (!job || job.actor !== session.username) throw new Error("EXPORT_NOT_FOUND");
  const failures: string[] = [];
  for (const file of job.files) {
    const diskPath = job.diskFiles.get(file.id);
    if (!diskPath) {
      failures.push(`${file.path}: missing`);
      continue;
    }
    const bytes = await readFile(diskPath).catch(() => null);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) failures.push(`${file.path}: hash mismatch`);
  }
  const result = { verified: failures.length === 0, checkedAt: new Date().toISOString(), failures };
  job.verification = result;
  return result;
}
