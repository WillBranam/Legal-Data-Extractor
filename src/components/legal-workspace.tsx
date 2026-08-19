"use client";

import {
  AlertTriangle, Archive, Check, ChevronRight, Database, Download, FileCheck2,
  FileText, FolderLock, FolderUp, LayoutDashboard, LoaderCircle, Menu,
  MessageSquareText, Search, Settings, ShieldCheck, SlidersHorizontal, X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyAdministrativeExtraction, credibleProposalEntityName, resolveDocumentMatterMatch, resolveOccurrenceException } from "@/lib/administrative-records";
import { readCitationContext } from "@/lib/evidence";
import { queryAdministrativeInformation } from "@/lib/information-query";
import { dynamicFieldDefinition } from "@/lib/field-registry";
import {
  deleteStagedOriginalFile, downloadEncryptedBackup, downloadLocalExportFile,
  downloadOriginalFile, extractDocumentWithLocalModel, getLocalExportJob,
  getLocalRuntimeStatus,
  startCompleteLocalExport, storeOriginalFile, verifyLocalExport,
  type LocalExportJob, type LocalRuntimeStatus
} from "@/lib/local-client";
import { createLocalOcrSession } from "@/lib/ocr";
import { MAX_SOURCE_FILE_BYTES, parseLocalFile, type ParseProgress } from "@/lib/parsers";
import { clearWorkspace, loadWorkspace, saveWorkspace, type StorageMode } from "@/lib/storage";
import type { Citation, InformationQueryAnswer, WorkspaceState } from "@/lib/types";
import { createEmptyWorkspace } from "@/lib/workspace";

type View = "overview" | "documents" | "records" | "review" | "query" | "exports" | "settings";
const navItems = [
  ["overview", "Case Data", LayoutDashboard], ["documents", "Source Documents", FileText],
  ["records", "Extracted Information", Database], ["review", "Exceptions", FileCheck2],
  ["query", "Find Information", MessageSquareText], ["exports", "Download Case Package", Download],
  ["settings", "Settings", Settings]
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

// Maps server error codes to text a legal user can act on. Raw model output,
// parser exceptions, and file paths must never reach this screen.
const EXTRACTION_ERROR_MESSAGES: Record<string, string> = {
  MODEL_OUTPUT_TRUNCATED: "The local model response was incomplete. Your file and OCR results were saved; retry will resume extraction.",
  MODEL_OUTPUT_MALFORMED: "The local model returned an unreadable response. Your file and OCR results were saved; retry extraction.",
  LOCAL_MODEL_HTTP_404: "The configured Ollama model is not installed. Run npm run local:setup, then retry extraction.",
  LOCAL_MODEL_UNAVAILABLE: "The local model is unavailable. Start it with npm run local:model, then retry extraction.",
  LOCAL_MODEL_EMPTY_RESPONSE: "The local model returned nothing for this document. Retry extraction.",
  LOCAL_MODEL_DEADLINE_EXCEEDED: "The local model did not finish in time. Retry extraction after confirming Ollama is responsive.",
  CANONICAL_ARTIFACT_TOO_LARGE: "This document is too large for local extraction. Split it and add the parts separately.",
  DOCUMENT_PAGE_LIMIT_EXCEEDED: "This document has more pages than local extraction supports. Split it and add the parts separately.",
  EXTRACTION_REQUEST_TOO_LARGE: "This document's text is too large to send to local extraction in one request. Split it and add the parts separately.",
  AUDIT_CHAIN_INVALID: "The local audit log failed verification. Extraction is blocked until it is investigated.",
  LOCAL_API_ERROR: "Extraction failed for an unexpected reason. Your file and OCR results were saved; retry extraction."
};

function extractionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const mapped = EXTRACTION_ERROR_MESSAGES[message];
  if (mapped) return mapped;
  if (/timeout|timed out|deadline|abort/i.test(message)) return EXTRACTION_ERROR_MESSAGES.LOCAL_MODEL_DEADLINE_EXCEEDED;
  if (/HTTP_404/i.test(message)) return EXTRACTION_ERROR_MESSAGES.LOCAL_MODEL_HTTP_404;
  if (/unavailable|fetch failed|ECONNREFUSED/i.test(message)) return EXTRACTION_ERROR_MESSAGES.LOCAL_MODEL_UNAVAILABLE;
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(message)) return EXTRACTION_ERROR_MESSAGES.LOCAL_API_ERROR;
  return message || EXTRACTION_ERROR_MESSAGES.LOCAL_API_ERROR;
}

/**
 * Pages alone understate progress: an aborted span on page 1 of 17 reported
 * "0 of 17 pages" even when spans had succeeded and their values were kept.
 */
function describeExtractionProgress(summary: {
  pagesScanned: number;
  totalPages: number;
  spansScanned: number;
  spansTotal: number;
}): string {
  const pages = `${summary.pagesScanned} of ${summary.totalPages} pages were read`;
  if (summary.pagesScanned === 0 && summary.spansScanned > 0) {
    return `${pages}, but ${summary.spansScanned} of ${summary.spansTotal} text spans were scanned and their values were kept.`;
  }
  return `${pages}.`;
}

const WORKSPACE_SAVE_ERROR_MESSAGES: Record<string, string> = {
  WORKSPACE_CONFLICT: "This workspace was changed by another window since it was opened. Reload the page to pick up the current case index, then make the change again.",
  LEGAL_HOLD_ACTIVE: "A legal hold is active on this matter. Release the hold before changing the case index.",
  LEGAL_HOLD_PRESERVATION_REQUIRED: "A legal hold is active and this change would alter preserved documents. It was not saved.",
  AUDIT_CHAIN_INVALID: "The local audit log failed verification. Saving is blocked until it is investigated.",
  WORKSPACE_TOO_LARGE: "This case index is too large to save in one write. Split the matter across workspaces."
};

function workspaceSaveErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return WORKSPACE_SAVE_ERROR_MESSAGES[message]
    ?? "The change could not be saved to the encrypted vault and was not applied. Try again; if it keeps failing, reload the page.";
}

function repairLoadedWorkspace(saved: WorkspaceState): { state: WorkspaceState; changed: boolean } {
  let changed = false;
  const entities = new Map((saved.entities ?? []).map((entity) => [entity.id, entity]));
  const definitions = new Map((saved.fieldDefinitions ?? []).map((definition) => [definition.id, definition]));
  const invalidOccurrenceIds = new Set<string>();
  const fieldOccurrences = (saved.fieldOccurrences ?? []).map((occurrence) => {
    if (!occurrence.subjectEntityId) return occurrence;
    const subjectName = entities.get(occurrence.subjectEntityId)?.canonicalName ?? null;
    const definition = definitions.get(occurrence.fieldDefinitionId);
    if (credibleProposalEntityName(subjectName, occurrence.rawValue, occurrence.valueType, definition?.category ?? "other")) return occurrence;
    changed = true;
    invalidOccurrenceIds.add(occurrence.id);
    return { ...occurrence, subjectEntityId: null };
  });
  const relationships = (saved.relationships ?? []).filter((relationship) => {
    const keep = relationship.sourceEntityId !== relationship.targetEntityId && !relationship.occurrenceIds.every((id) => invalidOccurrenceIds.has(id));
    if (!keep) changed = true;
    return keep;
  });
  const documents = saved.documents.map((document) => {
    if (document.extractionState !== "processing") return document;
    changed = true;
    return { ...document, extractionState: "failed" as const, extractionError: "The previous extraction was interrupted. Retry extraction to continue." };
  });
  return { state: { ...saved, documents, fieldOccurrences, relationships }, changed };
}

interface ProcessingStatus { fileName: string; fileNumber: number; totalFiles: number; message: string; progress: number | null }

// Must stay in sync with the extension branches in parseLocalFile.
const SUPPORTED_SOURCE_EXTENSIONS = ["pdf", "docx", "txt", "eml", "msg", "jpg", "jpeg", "png", "tif", "tiff"];
const SOURCE_FILE_ACCEPT = [
  ".pdf", ".docx", ".txt", ".eml", ".msg", ".jpg", ".jpeg", ".png", ".tif", ".tiff",
  // MIME types as well: extension-only accept lists cause macOS pickers to grey
  // out otherwise-valid documents served from cloud storage providers.
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain", "message/rfc822", "application/vnd.ms-outlook",
  "image/jpeg", "image/png", "image/tiff"
].join(",");

function isSupportedSourceFile(file: File): boolean {
  return SUPPORTED_SOURCE_EXTENSIONS.includes(file.name.toLowerCase().split(".").pop() ?? "");
}

export function LegalWorkspace({ localMode = false }: { localMode?: boolean }) {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalRuntimeStatus | null>(null);
  const [view, setView] = useState<View>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<ProcessingStatus | null>(null);
  const [importProgress, setImportProgress] = useState<ParseProgress | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<InformationQueryAnswer | null>(null);
  const [querying, setQuerying] = useState(false);
  const [selectedCitationId, setSelectedCitationId] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<LocalExportJob | null>(null);
  const [exportAcknowledged, setExportAcknowledged] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fieldSearch, setFieldSearch] = useState("");
  const [newFieldLabel, setNewFieldLabel] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const storageMode: StorageMode = localMode ? "encrypted-local-vault" : "browser-local";

  const initializeWorkspace = useCallback(async () => {
    const saved = await loadWorkspace(storageMode);
    const repaired = saved ? repairLoadedWorkspace(saved) : null;
    const state = repaired?.state ?? createEmptyWorkspace();
    if (!saved || repaired?.changed) await saveWorkspace(state, storageMode);
    setWorkspace(state);
  }, [storageMode]);

  const refreshLocalStatus = useCallback(async (): Promise<LocalRuntimeStatus | null> => {
    if (!localMode) return null;
    const status = await getLocalRuntimeStatus();
    setLocalStatus(status);
    return status;
  }, [localMode]);

  // React re-invokes mount effects in development. Opening the workspace twice
  // ran two loads and two repair writes against the same vault revision, which
  // left the second one conflicting and the cached revision stale for the rest
  // of the session.
  const openedRef = useRef(false);

  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    let active = true;
    (async () => {
      try {
        if (localMode) {
          const status = await refreshLocalStatus();
          if (!active) return;
          if (status?.legacyVaultArchived) {
            setNotice("An earlier locked workspace was preserved in the local data folder. A fresh password-free workspace is ready.");
          }
        }
        await initializeWorkspace();
      } catch (error) {
        openedRef.current = false;
        if (active) setAccessError(error instanceof Error ? error.message : "Could not open the workspace.");
      }
    })();
    return () => { active = false; };
  }, [initializeWorkspace, localMode, refreshLocalStatus]);

  useEffect(() => {
    if (!localMode) return;
    const timer = window.setInterval(() => { void refreshLocalStatus().catch(() => undefined); }, 5000);
    return () => window.clearInterval(timer);
  }, [localMode, refreshLocalStatus]);

  useEffect(() => {
    if (!exportJob || !["queued", "running"].includes(exportJob.status)) return;
    const timer = window.setInterval(async () => {
      try { setExportJob(await getLocalExportJob(exportJob.id)); } catch { /* retain last progress */ }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [exportJob]);

  async function updateWorkspace(next: WorkspaceState): Promise<void> {
    await saveWorkspace(next, storageMode);
    setWorkspace(next);
  }

  // Save failures must surface as an explained notice, never as an uncaught
  // runtime error. Returns false when the change was not persisted, so callers
  // never report success for work the vault rejected.
  async function commitWorkspace(next: WorkspaceState): Promise<boolean> {
    try {
      await updateWorkspace(next);
      return true;
    } catch (error) {
      setNotice(workspaceSaveErrorMessage(error));
      return false;
    }
  }

  // Accepts a live FileList (file picker), or a plain array (drop and paste).
  // The caller's FileList must be snapshotted before the first await because
  // the input clears its value as soon as the change handler returns.
  async function importFiles(files: FileList | File[] | null): Promise<void> {
    if (!workspace || processing) return;
    const offered = files ? Array.from(files) : [];
    if (offered.length === 0) {
      setNotice("No files were added. Choose supported case files, or drop or paste them onto this window.");
      return;
    }
    const selected = offered.filter(isSupportedSourceFile);
    const unsupported = offered.filter((file) => !isSupportedSourceFile(file));
    if (selected.length === 0) {
      setNotice(`No supported files were added. Verity reads PDF, DOCX, TXT, EML, MSG, JPEG, PNG, and TIFF. Skipped: ${unsupported.map((file) => file.name).join(", ")}`);
      return;
    }
    const total = selected.reduce((sum, file) => sum + file.size, 0);
    if (selected.length > 200 || total > 500 * 1024 * 1024 || selected.some((file) => file.size > MAX_SOURCE_FILE_BYTES)) {
      setNotice("Use at most 200 files, 500 MB per batch, and 100 MB per file."); return;
    }
    // Readiness no longer blocks ingestion. Files are always parsed, hashed, and
    // stored; extraction is held as a retryable queued state when the model is
    // down, so a stopped Ollama can never cause a document to be lost.
    let modelReady = !localMode;
    if (localMode) {
      const status = await refreshLocalStatus().catch(() => null);
      modelReady = Boolean(status?.model.reachable && status.model.installed);
    }
    setNotice(null); setAnswer(null);
    let queued = 0;
    const partial: string[] = [];
    let next = { ...workspace, documents: [...workspace.documents] };
    const staged: string[] = [];
    const errors: string[] = [];
    let verified = 0; let exceptions = 0; let duplicates = 0;
    const ocr = createLocalOcrSession();
    try {
      for (const [index, file] of selected.entries()) {
        let currentDocumentId: string | null = null;
        try {
          setProcessing({ fileName: file.name, fileNumber: index + 1, totalFiles: selected.length, message: "Reading text and document structure", progress: index / selected.length });
          const document = await parseLocalFile(file, { ocrSession: ocr, onProgress: (progress) => { setImportProgress(progress); setProcessing({ fileName: file.name, fileNumber: index + 1, totalFiles: selected.length, message: progress.message, progress: (index + progress.progress * 0.45) / selected.length }); } });
          if (next.documents.some((item) => item.originalSha256 === document.originalSha256)) { duplicates += 1; continue; }
          currentDocumentId = document.id;
          if (localMode) { await storeOriginalFile(document.id, file); staged.push(document.id); }
          const extractable = localMode && document.processingState === "ready" && Boolean(document.canonicalText);
          const queuedDocument = {
            ...document,
            extractionState: extractable && modelReady ? "processing" as const : "not-started" as const,
            extractionError: extractable && !modelReady
              ? "The local text model was not running when this file was added. Run npm run local:model, then retry extraction."
              : null
          };
          next = { ...next, documents: [...next.documents, queuedDocument] };
          if (extractable && !modelReady) queued += 1;
          if (extractable && modelReady) {
            setProcessing({ fileName: file.name, fileNumber: index + 1, totalFiles: selected.length, message: "Extracting names, identifiers, dates, signatures, contacts, and labeled fields", progress: null });
            const result = await extractDocumentWithLocalModel(queuedDocument, next.fieldDefinitions ?? []);
            setProcessing({ fileName: file.name, fileNumber: index + 1, totalFiles: selected.length, message: "Reconciling values and verifying exact source bytes", progress: (index + 0.92) / selected.length });
            next = applyAdministrativeExtraction(next, queuedDocument, result);
            if (result.reviewSummary.coverage === "partial") {
              partial.push(`${file.name} (${result.reviewSummary.pagesScanned} of ${result.reviewSummary.totalPages} pages)`);
              next = { ...next, documents: next.documents.map((item) => item.id === document.id ? { ...item, extractionState: "failed" as const, extractionError: `${result.reviewSummary.coverageReason ?? "This document was not scanned end to end."} ${describeExtractionProgress(result.reviewSummary)} Retry extraction to finish it.` } : item) };
            }
            verified += (next.fieldOccurrences ?? []).filter((item) => item.documentId === document.id && item.status === "verified").length;
            exceptions += (next.fieldOccurrences ?? []).filter((item) => item.documentId === document.id && item.status === "exception").length;
          }
          next = { ...next, matter: { ...next.matter, updatedAt: new Date().toISOString() } };
          await updateWorkspace(next);
        } catch (error) {
          const message = extractionErrorMessage(error);
          if (currentDocumentId) {
            next = { ...next, documents: next.documents.map((item) => item.id === currentDocumentId ? { ...item, extractionState: "failed" as const, extractionError: message } : item) };
            await updateWorkspace(next);
          }
          errors.push(`${file.name}: ${message}`);
        }
      }
      setProcessing({ fileName: "Matter workspace", fileNumber: selected.length, totalFiles: selected.length, message: "Encrypting and saving the updated case index", progress: 0.98 });
      next = { ...next, matter: { ...next.matter, updatedAt: new Date().toISOString() } };
      await updateWorkspace(next);
      setView("records");
      const processedCount = selected.length - errors.length - duplicates;
      setNotice([
        `${processedCount} document${processedCount === 1 ? "" : "s"} processed.`,
        `${verified} values published automatically; ${exceptions} need exception review.`,
        queued ? `${queued} document${queued === 1 ? " is" : "s are"} stored and waiting for the local text model. Start it, then use Retry extraction.` : "",
        partial.length ? `Incomplete — not every page was read: ${partial.join("; ")}. Retry extraction to finish.` : "",
        duplicates ? `${duplicates} exact duplicate${duplicates === 1 ? " was" : "s were"} skipped.` : "",
        unsupported.length ? `${unsupported.length} unsupported file${unsupported.length === 1 ? " was" : "s were"} skipped: ${unsupported.map((file) => file.name).join(", ")}.` : "",
        errors.length ? `${errors.length} failed: ${errors.join("; ")}` : ""
      ].filter(Boolean).join(" "));
    } catch (error) {
      if (localMode) await Promise.allSettled(staged.map(deleteStagedOriginalFile));
      setNotice(error instanceof Error ? error.message : "Import failed.");
    } finally { await ocr.terminate().catch(() => undefined); setProcessing(null); setImportProgress(null); }
  }

  // Files can arrive three ways. Only the picker existed before, which meant a
  // dragged file triggered the browser default and navigated away from the
  // workspace, and a pasted file did nothing at all.
  // Paste is a window listener, so it needs the latest importFiles without
  // re-subscribing on every render. Drag and drop are JSX handlers and close
  // over the current render directly.
  const importFilesRef = useRef(importFiles);
  useEffect(() => { importFilesRef.current = importFiles; });

  useEffect(() => {
    function onPaste(event: ClipboardEvent): void {
      const pasted = Array.from(event.clipboardData?.files ?? []);
      if (pasted.length === 0) return;
      event.preventDefault();
      void importFilesRef.current(pasted);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  function onDragOver(event: React.DragEvent): void {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    // Without preventDefault the browser opens the dropped file and discards
    // the workspace. This must run even while processing is locked.
    event.preventDefault();
    event.dataTransfer.dropEffect = processing ? "none" : "copy";
    if (!processing) setDragging(true);
  }

  function onDragLeave(event: React.DragEvent): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  }

  function onDrop(event: React.DragEvent): void {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    setDragging(false);
    void importFiles(Array.from(event.dataTransfer.files));
  }

  async function retryDocumentExtraction(documentId: string): Promise<void> {
    if (!workspace || processing) return;
    const document = workspace.documents.find((item) => item.id === documentId);
    if (!document?.canonicalText || document.processingState !== "ready") {
      setNotice("This document does not have extractable canonical text. Resolve its OCR or parsing issue first.");
      return;
    }
    const status = await refreshLocalStatus().catch(() => null);
    if (!status?.model.reachable || !status.model.installed) {
      setNotice("The local text model is unavailable. Run npm run local:model in another Terminal, then retry.");
      return;
    }
    const queuedDocument = { ...document, extractionState: "processing" as const, extractionError: null };
    let next = { ...workspace, documents: workspace.documents.map((item) => item.id === documentId ? queuedDocument : item) };
    await updateWorkspace(next);
    setProcessing({ fileName: document.name, fileNumber: 1, totalFiles: 1, message: "Retrying administrative field extraction", progress: null });
    setAnswer(null);
    try {
      const result = await extractDocumentWithLocalModel(queuedDocument, next.fieldDefinitions ?? []);
      setProcessing({ fileName: document.name, fileNumber: 1, totalFiles: 1, message: "Reconciling values and verifying exact source bytes", progress: 0.92 });
      next = applyAdministrativeExtraction(next, queuedDocument, result);
      await updateWorkspace({ ...next, matter: { ...next.matter, updatedAt: new Date().toISOString() } });
      const count = (next.fieldOccurrences ?? []).filter((item) => item.documentId === documentId && item.status === "verified").length;
      setNotice(`Extraction completed with ${count} verified value${count === 1 ? "" : "s"}.`);
      setView("records");
    } catch (error) {
      const message = extractionErrorMessage(error);
      next = { ...next, documents: next.documents.map((item) => item.id === documentId ? { ...item, extractionState: "failed" as const, extractionError: message } : item) };
      await updateWorkspace(next);
      setNotice(message);
    } finally {
      setProcessing(null);
    }
  }

  async function askQuestion(): Promise<void> {
    if (!workspace || !question.trim() || processing || querying) return;
    setQuerying(true);
    try { setAnswer(queryAdministrativeInformation(question, workspace)); }
    finally { setQuerying(false); }
  }

  async function resolveException(id: string, decision: "verify" | "withhold"): Promise<void> {
    if (!workspace) return;
    const next = resolveOccurrenceException(workspace, id, decision);
    if (!await commitWorkspace(next)) return;
    setNotice(decision === "verify" ? "Value added to the verified case index." : "Value withheld from verified outputs.");
  }

  async function resolveDocument(id: string, decision: "attach" | "exclude"): Promise<void> {
    if (!workspace) return;
    const next = resolveDocumentMatterMatch(workspace, id, decision);
    if (!await commitWorkspace(next)) return;
    setNotice(decision === "attach" ? "Document released into this matter. Its previously verified values are available." : "Document excluded from this matter and all of its values withheld.");
  }

  async function toggleField(id: string): Promise<void> {
    if (!workspace) return;
    const definitions = (workspace.fieldDefinitions ?? []).map((item) => item.id === id ? { ...item, enabled: !item.enabled } : item);
    await commitWorkspace({ ...workspace, fieldDefinitions: definitions, extractionSpecification: { version: 2, fieldDefinitionIds: definitions.filter((item) => item.enabled).map((item) => item.id), customInstructions: workspace.extractionSpecification?.customInstructions ?? "", detectedDocumentTypes: workspace.extractionSpecification?.detectedDocumentTypes ?? [], detectedLanguages: workspace.extractionSpecification?.detectedLanguages ?? [], confirmedAt: new Date().toISOString() } });
  }

  async function addCustomField(): Promise<void> {
    if (!workspace || !newFieldLabel.trim()) return;
    const field = dynamicFieldDefinition({ documentType: "custom", label: newFieldLabel.trim(), valueType: "text" });
    const definitions = [...(workspace.fieldDefinitions ?? []).filter((item) => item.id !== field.id), field];
    if (!await commitWorkspace({ ...workspace, fieldDefinitions: definitions })) return;
    setNewFieldLabel(""); setNotice(`Added “${field.displayLabel}” to the extraction field set.`);
  }

  async function beginExport(): Promise<void> {
    if (!exportAcknowledged || processing) return;
    try { setExportJob(await startCompleteLocalExport("final")); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Export could not start."); }
  }

  if (!workspace && accessError) return <div className="workspace-loading"><AlertTriangle /> Could not open the local workspace: {accessError}</div>;
  if (!workspace) return <div className="workspace-loading"><LoaderCircle className="spin" /> Opening the encrypted local workspace…</div>;

  const documents = new Map(workspace.documents.map((item) => [item.id, item]));
  const verified = (workspace.fieldOccurrences ?? []).filter((item) => item.status === "verified" && !["quarantined", "excluded"].includes(documents.get(item.documentId)?.matterMatchStatus ?? "matched"));
  const exceptions = (workspace.fieldOccurrences ?? []).filter((item) => item.status === "exception");
  const matterExceptions = workspace.documents.filter((item) => item.matterMatchStatus === "quarantined" || item.matterMatchStatus === "review").length;
  const selectedCitation = workspace.citations.find((item) => item.id === selectedCitationId) ?? null;
  const selectedDocument = selectedCitation ? documents.get(selectedCitation.documentId) ?? null : null;
  const textModelReady = !localMode || Boolean(localStatus?.model.reachable && localStatus.model.installed);
  // Adding files never depends on the model — documents are stored either way.
  // Only retrying extraction does.
  const uploadDisabled = Boolean(processing);
  const actionsDisabled = Boolean(processing) || !textModelReady;

  return <div className={`app-shell ${dragging ? "dragging" : ""}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    {dragging ? <div className="drop-overlay" role="status"><FolderUp size={34} /><strong>Drop case files to add them</strong><span>PDF, DOCX, TXT, EML, MSG, JPEG, PNG, TIFF &middot; files stay on this workstation</span></div> : null}
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="brand"><span className="brand-mark">VC</span><span>Verity Caseworks</span><button className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <nav>{navItems.map(([id, label, Icon]) => <button key={id} className={`nav-item ${view === id ? "active" : ""}`} onClick={() => { setView(id); setSidebarOpen(false); }}><Icon size={17} /><span>{label}</span>{id === "review" && exceptions.length + matterExceptions > 0 ? <b className="nav-count">{exceptions.length + matterExceptions}</b> : null}</button>)}</nav>
      <div className="sidebar-footer"><ShieldCheck size={16} /><div><strong>{localMode ? "Local-only mode" : "Browser-local preview"}</strong><span>{localMode ? "Loopback model · encrypted vault" : "No cloud file storage"}</span></div></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu /></button><div><span className="eyebrow">Matter workspace</span><h1>{workspace.matter.name}</h1></div><div className="topbar-status">{processing ? <><LoaderCircle className="spin" size={16} /> Processing locked</> : !textModelReady ? <><AlertTriangle size={16} /> Text model unavailable</> : <><ShieldCheck size={16} /> Ready</>}</div></header>
      {processing ? <div className="processing-banner" role="status"><LoaderCircle className="spin" /><div><strong>{processing.message}</strong><span>{processing.fileName} · {processing.fileNumber} of {processing.totalFiles}{importProgress ? ` · ${Math.round(importProgress.progress * 100)}% of file` : ""}</span></div><div className="progress-track"><span style={{ width: `${Math.round((processing.progress ?? 0.5) * 100)}%` }} /></div></div> : null}
      {localMode && !textModelReady && !processing ? <div className="runtime-warning" role="alert"><AlertTriangle size={18} /><span><strong>Local extraction is paused.</strong> Start Ollama with <code>npm run local:model</code>. Upload and retry controls will unlock when {localStatus?.model.model ?? "the configured model"} is available.</span></div> : null}
      {notice ? <div className="notice-bar"><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss"><X size={16} /></button></div> : null}
      <section className="content-area">
        {view === "overview" ? <CaseData workspace={workspace} verifiedCount={verified.length} exceptionCount={exceptions.length + matterExceptions} disabled={uploadDisabled} onUpload={() => fileInputRef.current?.click()} onFolder={() => folderInputRef.current?.click()} onView={setView} onToggleField={toggleField} fieldSearch={fieldSearch} onFieldSearch={setFieldSearch} newFieldLabel={newFieldLabel} onNewFieldLabel={setNewFieldLabel} onAddField={addCustomField} /> : null}
        {view === "documents" ? <SourceDocuments workspace={workspace} disabled={uploadDisabled} retryDisabled={actionsDisabled} onUpload={() => fileInputRef.current?.click()} onDownload={localMode ? downloadOriginalFile : undefined} onRetry={localMode ? retryDocumentExtraction : undefined} /> : null}
        {view === "records" ? <ExtractedInformation workspace={workspace} onCitation={setSelectedCitationId} /> : null}
        {view === "review" ? <Exceptions workspace={workspace} disabled={!!processing} onResolve={resolveException} onResolveDocument={resolveDocument} onCitation={setSelectedCitationId} /> : null}
        {view === "query" ? <FindInformation workspace={workspace} question={question} answer={answer} disabled={!!processing || querying} querying={querying} onQuestion={setQuestion} onSubmit={askQuestion} onCitation={setSelectedCitationId} /> : null}
        {view === "exports" ? <DownloadPackage workspace={workspace} job={exportJob} acknowledged={exportAcknowledged} disabled={!!processing} onAcknowledged={setExportAcknowledged} onStart={beginExport} onDownload={downloadLocalExportFile} onVerify={async (id) => setNotice((await verifyLocalExport(id)).verified ? "Package integrity and citation verification passed." : "Package verification found a problem; review the export status.")} /> : null}
        {view === "settings" ? <SettingsView workspace={workspace} localStatus={localStatus} onBackup={downloadEncryptedBackup} onReset={async () => { if (!confirm("Delete this workspace? This cannot be undone unless you have a backup.")) return; await clearWorkspace(storageMode); await initializeWorkspace(); }} /> : null}
      </section>
      <input ref={fileInputRef} className="sr-only" type="file" multiple accept={SOURCE_FILE_ACCEPT} onChange={(event) => { void importFiles(event.target.files); event.target.value = ""; }} />
      <input ref={folderInputRef} className="sr-only" type="file" multiple accept={SOURCE_FILE_ACCEPT} {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)} onChange={(event) => { void importFiles(event.target.files); event.target.value = ""; }} />
    </main>
    {selectedCitation && selectedDocument ? <CitationDrawer citation={selectedCitation} document={selectedDocument} onClose={() => setSelectedCitationId(null)} /> : null}
  </div>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{action}</div>;
}

function CaseData({ workspace, verifiedCount, exceptionCount, disabled, onUpload, onFolder, onView, onToggleField, fieldSearch, onFieldSearch, newFieldLabel, onNewFieldLabel, onAddField }: { workspace: WorkspaceState; verifiedCount: number; exceptionCount: number; disabled: boolean; onUpload: () => void; onFolder: () => void; onView: (view: View) => void; onToggleField: (id: string) => void; fieldSearch: string; onFieldSearch: (value: string) => void; newFieldLabel: string; onNewFieldLabel: (value: string) => void; onAddField: () => Promise<void> }) {
  const fields = (workspace.fieldDefinitions ?? []).filter((item) => `${item.displayLabel} ${item.category} ${item.sourceLabels.join(" ")}`.toLowerCase().includes(fieldSearch.toLowerCase()));
  return <>
    <PageHeading eyebrow="Case information index" title="Digitize the details your team repeatedly looks up" description="Add a matter folder. Verity identifies labeled names, numbers, contacts, dates, parties, signatures, and document-specific fields, then builds a consistent case index." action={<div className="heading-actions"><button className="secondary-button" disabled={disabled} onClick={onUpload}><FileText size={16} /> Add files</button><button className="primary-button" disabled={disabled} onClick={onFolder}><FolderUp size={16} /> Add matter folder</button></div>} />
    <div className="metric-grid"><Metric label="Source documents" value={workspace.documents.length} note={`${workspace.documents.reduce((sum, item) => sum + item.pageCount, 0)} pages inventoried`} /><Metric label="Verified information" value={verifiedCount} note="Available in lookup and exports" /><Metric label="Exceptions" value={exceptionCount} note={exceptionCount ? "Only these need attention" : "No unresolved values"} tone={exceptionCount ? "warn" : "good"} /><Metric label="Enabled fields" value={(workspace.fieldDefinitions ?? []).filter((item) => item.enabled).length} note="Standard and discovered fields" /></div>
    <div className="workflow-card"><div><span>1</span><strong>Add documents</strong><small>Files stay on this workstation</small></div><ChevronRight /><div><span>2</span><strong>Automatic extraction</strong><small>Multi-pass review + exact source matching</small></div><ChevronRight /><div><span>3</span><strong>Resolve exceptions</strong><small>No routine approval queue</small></div><ChevronRight /><div><span>4</span><strong>Download package</strong><small>Excel, Word, PDF, SQLite, CSV, JSONL</small></div></div>
    <div className="split-grid"><section className="panel"><div className="panel-header"><div><h3>What Verity will capture</h3><p>The field set is editable. Unknown labeled values are retained as “Other Important Fields.”</p></div><SlidersHorizontal size={18} /></div><div className="filter-row"><Search size={16} /><input value={fieldSearch} onChange={(event) => onFieldSearch(event.target.value)} placeholder="Find a field or label" /></div><form className="add-field-row" onSubmit={(event) => { event.preventDefault(); void onAddField(); }}><input value={newFieldLabel} onChange={(event) => onNewFieldLabel(event.target.value)} placeholder="Add a field, e.g. Notary commission number" /><button className="secondary-button" disabled={!newFieldLabel.trim()}>Add field</button></form><div className="field-list">{fields.slice(0, 80).map((field) => <label key={field.id} className="field-toggle"><input type="checkbox" checked={field.enabled} onChange={() => void onToggleField(field.id)} /><span><strong>{field.displayLabel}</strong><small>{field.category} · {field.valueType}{field.dynamic ? " · custom/discovered" : ""}</small></span></label>)}</div></section>
      <section className="panel next-actions"><h3>Workspace readiness</h3><ActionRow done={workspace.documents.length > 0} title="Source documents added" detail={workspace.documents.length ? `${workspace.documents.length} documents indexed` : "Add the first folder to begin"} onClick={() => onView("documents")} /><ActionRow done={verifiedCount > 0} title="Information extracted" detail={verifiedCount ? `${verifiedCount} verified values` : "Runs automatically after import"} onClick={() => onView("records")} /><ActionRow done={exceptionCount === 0 && verifiedCount > 0} title="Exceptions resolved" detail={exceptionCount ? `${exceptionCount} require a decision` : verifiedCount ? "No unresolved exceptions" : "Not started"} onClick={() => onView("review")} /><ActionRow done={false} title="Case package downloaded" detail="Create the portable case index" onClick={() => onView("exports")} /></section></div>
  </>;
}

function Metric({ label, value, note, tone }: { label: string; value: number; note: string; tone?: "warn" | "good" }) { return <div className={`metric-card ${tone ?? ""}`}><span>{label}</span><strong>{value.toLocaleString()}</strong><small>{note}</small></div>; }
function ActionRow({ done, title, detail, onClick }: { done: boolean; title: string; detail: string; onClick: () => void }) { return <button className="action-row" onClick={onClick}><span className={done ? "done" : ""}>{done ? <Check size={15} /> : null}</span><div><strong>{title}</strong><small>{detail}</small></div><ChevronRight size={17} /></button>; }

function SourceDocuments({ workspace, disabled, retryDisabled, onUpload, onDownload, onRetry }: { workspace: WorkspaceState; disabled: boolean; retryDisabled: boolean; onUpload: () => void; onDownload?: (id: string, name: string) => Promise<void>; onRetry?: (id: string) => Promise<void> }) {
  const extractedDocumentIds = new Set((workspace.fieldOccurrences ?? []).map((item) => item.documentId));
  return <><PageHeading eyebrow="Immutable source inventory" title="Source Documents" description="Each version is hashed, parsed locally, and mapped to an immutable canonical text artifact." action={<button className="primary-button" disabled={disabled} onClick={onUpload}><FolderUp size={16} /> Add documents</button>} /><div className="panel table-panel"><table><thead><tr><th>Document</th><th>Type / language</th><th>Pages</th><th>Text / OCR</th><th>Extraction</th><th>Matter match</th><th>Added</th><th /></tr></thead><tbody>{workspace.documents.map((document) => {
    const extractionState = document.extractionState ?? (extractedDocumentIds.has(document.id) ? "complete" : "not-started");
    return <tr key={document.id}><td><strong>{document.name}</strong><small>{formatBytes(document.size)} · {document.originalSha256.slice(0, 12)}…</small>{document.extractionError ? <small className="error-text">{document.extractionError}</small> : null}</td><td>{document.documentType ?? "Classification pending"}<small>{document.detectedLanguage === "es" ? "Spanish" : document.detectedLanguage === "en" ? "English" : "Language not set"}</small></td><td>{document.pageCount}</td><td><Status value={document.processingState} /></td><td><Status value={extractionState} /></td><td><Status value={document.matterMatchStatus ?? "review"} /></td><td>{formatDate(document.ingestedAt)}</td><td><div className="document-actions">{onRetry && extractionState !== "complete" && document.processingState === "ready" && document.canonicalText ? <button className="secondary-button compact-button" disabled={retryDisabled} onClick={() => void onRetry(document.id)}>Retry extraction</button> : null}{onDownload ? <button className="icon-button" title="Download original" onClick={() => void onDownload(document.id, document.name)}><Download size={16} /></button> : null}</div></td></tr>;
  })}</tbody></table>{workspace.documents.length === 0 ? <Empty title="No source documents" text="Add individual files or an entire matter folder." /> : null}</div></>;
}

function ExtractedInformation({ workspace, onCitation }: { workspace: WorkspaceState; onCitation: (id: string) => void }) {
  const definitions = new Map((workspace.fieldDefinitions ?? []).map((item) => [item.id, item])); const docs = new Map(workspace.documents.map((item) => [item.id, item])); const entities = new Map((workspace.entities ?? []).map((item) => [item.id, item]));
  const rows = (workspace.fieldOccurrences ?? []).filter((item) => item.status === "verified" && !["quarantined", "excluded"].includes(docs.get(item.documentId)?.matterMatchStatus ?? "matched"));
  return <><PageHeading eyebrow="Normalized case index" title="Extracted Information" description="Normalized values make lookup consistent; exact source values remain beside them for verification." /><div className="confidential-warning"><FolderLock size={18} /><span><strong>Confidential data.</strong> This index may include full SSNs, account numbers, medical identifiers, contact details, and other sensitive information.</span></div><div className="panel table-panel"><table><thead><tr><th>Field</th><th>Subject</th><th>Normalized value</th><th>Exact source value</th><th>Source</th><th>Confidence</th></tr></thead><tbody>{rows.map((item) => <tr key={item.id}><td><strong>{definitions.get(item.fieldDefinitionId)?.displayLabel ?? item.sourceLabel}</strong><small>{definitions.get(item.fieldDefinitionId)?.category}</small></td><td>{item.subjectEntityId ? entities.get(item.subjectEntityId)?.canonicalName ?? "—" : "Matter / document"}</td><td className="value-cell">{item.normalizedValue}</td><td className="raw-cell">{item.rawValue}</td><td><button className="citation-link" onClick={() => onCitation(item.citationIds[0])}>{docs.get(item.documentId)?.name ?? item.documentId}<span>page {item.pageNumber ?? "—"}</span></button></td><td>{Math.round(Math.min(item.extractionConfidence, item.normalizationConfidence) * 100)}%</td></tr>)}</tbody></table>{rows.length === 0 ? <Empty title="No verified information yet" text="Add source documents to build the case index." /> : null}</div></>;
}

function Exceptions({ workspace, disabled, onResolve, onResolveDocument, onCitation }: { workspace: WorkspaceState; disabled: boolean; onResolve: (id: string, decision: "verify" | "withhold") => Promise<void>; onResolveDocument: (id: string, decision: "attach" | "exclude") => Promise<void>; onCitation: (id: string) => void }) {
  const definitions = new Map((workspace.fieldDefinitions ?? []).map((item) => [item.id, item])); const docs = new Map(workspace.documents.map((item) => [item.id, item]));
  const rows = (workspace.fieldOccurrences ?? []).filter((item) => item.status === "exception");
  const documentRows = workspace.documents.filter((item) => item.matterMatchStatus === "quarantined" || item.matterMatchStatus === "review");
  return <><PageHeading eyebrow="Review only what automation could not settle" title="Exceptions" description="Conflicts, ambiguous dates, uncertain handwriting, sensitive identifiers, and matter mismatches appear here. Clear fields never require routine approval." /><div className="panel exception-list">{documentRows.map((document) => <article key={document.id} className="exception-card"><div className="exception-icon"><AlertTriangle size={18} /></div><div><span className="eyebrow">Matter isolation</span><h3>{document.name}</h3><p>{document.matterMatchReason ?? "The document's parties or matter fingerprint require confirmation."}</p><Status value={document.matterMatchStatus ?? "review"} /></div><div className="exception-actions"><button className="secondary-button" disabled={disabled} onClick={() => void onResolveDocument(document.id, "exclude")}>Exclude document</button><button className="primary-button" disabled={disabled} onClick={() => void onResolveDocument(document.id, "attach")}>Attach to this matter</button></div></article>)}{rows.map((item) => <article key={item.id} className="exception-card"><div className="exception-icon"><AlertTriangle size={18} /></div><div><span className="eyebrow">{definitions.get(item.fieldDefinitionId)?.category ?? "field"}</span><h3>{definitions.get(item.fieldDefinitionId)?.displayLabel ?? item.sourceLabel}</h3><div className="value-comparison"><span><small>Normalized</small>{item.normalizedValue}</span><span><small>Exact source</small>{item.rawValue}</span></div><p>{item.exceptionReason}</p><button className="citation-link" onClick={() => onCitation(item.citationIds[0])}>{docs.get(item.documentId)?.name ?? item.documentId} · page {item.pageNumber ?? "—"}</button></div><div className="exception-actions"><button className="secondary-button" disabled={disabled} onClick={() => void onResolve(item.id, "withhold")}>Withhold</button><button className="primary-button" disabled={disabled} onClick={() => void onResolve(item.id, "verify")}>Use this value</button></div></article>)}{rows.length === 0 && documentRows.length === 0 ? <Empty title="No unresolved exceptions" text="All published values passed the automatic checks. New uncertainty will appear here." /> : null}</div></>;
}

function FindInformation({ workspace, question, answer, disabled, querying, onQuestion, onSubmit, onCitation }: { workspace: WorkspaceState; question: string; answer: InformationQueryAnswer | null; disabled: boolean; querying: boolean; onQuestion: (value: string) => void; onSubmit: () => Promise<void>; onCitation: (id: string) => void }) {
  const docs = new Map(workspace.documents.map((item) => [item.id, item]));
  return <><PageHeading eyebrow="Administrative lookup" title="Find Information" description="Ask for clients, parties, identifiers, contacts, counsel, dates, signatures, document status, or other extracted fields. Search uses verified typed data only." /><form className="query-box" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}><Search size={20} /><input value={question} onChange={(event) => onQuestion(event.target.value)} disabled={disabled} placeholder="Example: Show all phone numbers associated with Maria Sanchez" /><button className="primary-button" disabled={disabled || !question.trim()}>{querying ? <LoaderCircle className="spin" size={16} /> : null} Find</button></form><div className="example-queries">{["What is the client's SSN?", "Which documents are unsigned?", "Which firm represents the plaintiff?", "What dates are connected to service?"].map((value) => <button key={value} disabled={disabled} onClick={() => onQuestion(value)}>{value}</button>)}</div>{answer ? <div className="panel results-panel"><div className="results-header"><h3>{answer.items.length ? `${answer.items.length} verified result${answer.items.length === 1 ? "" : "s"}` : "No verified information found"}</h3><Status value={answer.status} /></div>{answer.items.map((item) => <article key={item.occurrenceId} className="query-result"><div><span className="eyebrow">{item.category}</span><h3>{item.label}</h3><strong className="result-value">{item.normalizedValue}</strong>{item.rawValue !== item.normalizedValue ? <p>Source form: <span className="raw-cell">{item.rawValue}</span></p> : null}{item.subject ? <p>Associated with {item.subject}</p> : null}</div><button className="citation-button" onClick={() => onCitation(item.citationIds[0])}><ShieldCheck size={16} /><span>Verified source<strong>{docs.get(item.documentId)?.name ?? item.documentId}</strong></span><ChevronRight size={16} /></button></article>)}{answer.items.length === 0 ? <Empty title="Insufficient information" text="The verified administrative index does not contain a supported answer. Narrative document text is intentionally not used." /> : null}</div> : null}</>;
}

function DownloadPackage({ workspace, job, acknowledged, disabled, onAcknowledged, onStart, onDownload, onVerify }: { workspace: WorkspaceState; job: LocalExportJob | null; acknowledged: boolean; disabled: boolean; onAcknowledged: (value: boolean) => void; onStart: () => Promise<void>; onDownload: typeof downloadLocalExportFile; onVerify: (id: string) => Promise<void> }) {
  const unresolved = (workspace.fieldOccurrences ?? []).filter((item) => item.status === "exception").length;
  return <><PageHeading eyebrow="Portable deliverable" title="Download Case Package" description="Every format is rendered from one verified snapshot so the spreadsheet, reference documents, and database agree." /><div className="package-grid"><section className="panel package-contents"><h3>Case information package</h3><p>Designed for independent use without Verity.</p>{["Case_Information.xlsx", "Case_Information_Summary.docx and .pdf", "Document_Register.docx and .pdf", "case.sqlite with searchable views", "CSV and JSONL table folders", "Data dictionary, exceptions, sources, hashes"].map((item) => <div key={item}><FileCheck2 size={16} />{item}</div>)}</section><section className="panel export-control"><div className="confidential-warning"><FolderLock size={18} /><span><strong>Full sensitive values are included.</strong> Save and transfer this package only through encrypted, access-controlled systems.</span></div><label className="acknowledgement"><input type="checkbox" checked={acknowledged} onChange={(event) => onAcknowledged(event.target.checked)} /> I understand this package may contain full PII/PHI, including SSNs and similar identifiers.</label><div className="export-summary"><span>{workspace.documents.length} documents</span><span>{(workspace.fieldOccurrences ?? []).filter((item) => item.status === "verified").length} verified values</span><span>{unresolved} exceptions</span></div><button className="primary-button wide" disabled={disabled || !acknowledged || job?.status === "running" || job?.status === "queued"} onClick={() => void onStart()}>{job?.status === "running" || job?.status === "queued" ? <LoaderCircle className="spin" size={17} /> : <Archive size={17} />} Build complete package</button>{job ? <div className="export-progress"><div><strong>{job.message}</strong><span>{job.progress}% · {job.phase}</span></div><div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div>{job.status === "ready" ? <><div className="export-files">{job.files.map((file) => <button key={file.id} onClick={() => void onDownload(job.id, file)}><Download size={15} /><span>{file.path}<small>{formatBytes(file.size)}</small></span></button>)}</div><button className="secondary-button" onClick={() => void onVerify(job.id)}><ShieldCheck size={16} /> Verify package integrity</button></> : null}{job.status === "failed" ? <p className="error-text">{job.error}</p> : null}</div> : null}</section></div></>;
}

function SettingsView({ workspace, localStatus, onBackup, onReset }: { workspace: WorkspaceState; localStatus: LocalRuntimeStatus | null; onBackup: () => Promise<void>; onReset: () => Promise<void> }) { return <><PageHeading eyebrow="Local operation" title="Settings" description="Review the workstation boundary, encrypted vault, model, backups, and matter controls." /><div className="settings-grid"><section className="panel"><h3>Processing boundary</h3><dl><dt>Files</dt><dd>Encrypted local vault</dd><dt>Local access</dt><dd>{localStatus ? "No app sign-in · macOS Keychain protected" : "No app sign-in · browser-local storage"}</dd><dt>Model</dt><dd>{localStatus?.model.model ?? "Browser-local preview"}</dd><dt>Endpoint</dt><dd>{localStatus?.model.boundary ?? "No model configured"}</dd><dt>Workspace schema</dt><dd>Version {workspace.schemaVersion ?? 1}</dd><dt>Legal hold</dt><dd>{workspace.matter.legalHold ? "Active" : "Not active"}</dd></dl></section><section className="panel settings-actions"><button className="secondary-button" onClick={() => void onBackup()}><Archive size={16} /> Download encrypted backup</button><button className="danger-button" onClick={() => void onReset()}>Delete local workspace</button></section></div></>; }

function CitationDrawer({ citation, document, onClose }: { citation: Citation; document: WorkspaceState["documents"][number]; onClose: () => void }) {
  const context = readCitationContext(document.canonicalText, citation.canonicalByteStart, citation.canonicalByteEnd, 260);
  return <aside className="citation-drawer"><div className="drawer-header"><div><span className="eyebrow">Verified source</span><h2>{document.name}</h2></div><button className="icon-button" onClick={onClose}><X /></button></div><div className="drawer-body"><dl><dt>Page</dt><dd>{citation.pageNumber ?? "—"}</dd><dt>Canonical bytes</dt><dd>{citation.canonicalByteStart}–{citation.canonicalByteEnd}</dd><dt>Parser / OCR</dt><dd>{citation.parserVersion}</dd><dt>Canonical hash</dt><dd className="hash-value">{citation.canonicalArtifactSha256}</dd></dl><div className="quote-context"><span>{context.before}</span><mark>{context.exactQuote}</mark><span>{context.after}</span></div><div className="verified-badge"><ShieldCheck size={17} /> Exact UTF-8 byte match</div><p className="drawer-note">The quotation is retrieved from immutable canonical bytes. It was not rewritten by the model.</p></div></aside>;
}

function Status({ value }: { value: string }) { return <span className={`status-pill status-${value.replaceAll("_", "-")}`}>{value.replaceAll("-", " ")}</span>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty-state"><Database size={26} /><h3>{title}</h3><p>{text}</p></div>; }
