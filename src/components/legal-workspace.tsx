"use client";

import {
  Archive,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Database,
  Download,
  FileCheck2,
  FileText,
  FileUp,
  FolderLock,
  FolderUp,
  Gauge,
  Gavel,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  MessageSquareText,
  PanelRightClose,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Upload,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  createCitation,
  readCanonicalByteRange,
  readCitationContext,
  verifyCitation
} from "@/lib/evidence";
import {
  exportCsv,
  exportDocx,
  exportJson,
  exportXlsx
} from "@/lib/exports";
import { createLocalOcrSession } from "@/lib/ocr";
import {
  MAX_SOURCE_FILE_BYTES,
  parseLocalFile,
  type ParseProgress
} from "@/lib/parsers";
import { queryApprovedFacts } from "@/lib/query";
import {
  clearWorkspace,
  loadWorkspace,
  saveWorkspace,
  type StorageMode
} from "@/lib/storage";
import { createEmptyWorkspace } from "@/lib/workspace";
import {
  extractDocumentWithLocalModel,
  downloadEncryptedBackup,
  deleteStagedOriginalFile,
  downloadOriginalFile,
  getLocalRuntimeStatus,
  loginLocalRuntime,
  logoutLocalRuntime,
  recordLocalAuditEvent,
  selectFactsWithLocalModel,
  setupLocalRuntime,
  storeOriginalFile,
  type LocalRuntimeStatus
} from "@/lib/local-client";
import type {
  Citation,
  FactRecord,
  QueryAnswer,
  WorkspaceState
} from "@/lib/types";

type View = "overview" | "documents" | "review" | "query" | "exports" | "settings";

const CONSENSUS_REVIEWER = "3-pass local model consensus";

const navItems: Array<{
  id: View;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { id: "overview", label: "Home", icon: LayoutDashboard },
  { id: "documents", label: "Documents", icon: FileText },
  { id: "review", label: "Verification", icon: FileCheck2 },
  { id: "query", label: "Ask the case", icon: MessageSquareText },
  { id: "exports", label: "Export", icon: Download },
  { id: "settings", label: "Settings", icon: Settings }
];

const viewLabels: Record<View, string> = {
  overview: "Home",
  documents: "Documents",
  review: "Verification",
  query: "Ask the case",
  exports: "Export",
  settings: "Settings"
};

function shortHash(hash: string): string {
  return `${hash.slice(0, 16)}…${hash.slice(-12)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function citationContext(citation: Citation, document: WorkspaceState["documents"][number]) {
  try {
    return readCitationContext(
      document.canonicalText,
      citation.canonicalByteStart,
      citation.canonicalByteEnd
    );
  } catch {
    return { before: "", exactQuote: citation.exactQuote, after: "" };
  }
}

interface ImportPerformance {
  files: number;
  bytes: number;
  pages: number;
  ocrPages: number;
  durationMs: number;
}

interface ProcessingStatus {
  phase: "parsing" | "agent-review" | "verifying" | "saving";
  fileName: string;
  fileNumber: number;
  totalFiles: number;
  message: string;
  progress: number | null;
}

export function LegalWorkspace({ localMode = false }: { localMode?: boolean }) {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalRuntimeStatus | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<QueryAnswer | null>(null);
  const [selectedCitationId, setSelectedCitationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [importProgress, setImportProgress] = useState<ParseProgress | null>(null);
  const [processingStatus, setProcessingStatus] =
    useState<ProcessingStatus | null>(null);
  const [importPerformance, setImportPerformance] =
    useState<ImportPerformance | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const storageMode: StorageMode = localMode
    ? "encrypted-local-vault"
    : "browser-local";

  const initializeWorkspace = useCallback(async () => {
    const saved = await loadWorkspace(storageMode);
    const state = saved ?? createEmptyWorkspace();
    if (!saved) await saveWorkspace(state, storageMode);
    setWorkspace(state);
    setSelectedCitationId(null);
  }, [storageMode]);

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        if (localMode) {
          const status = await getLocalRuntimeStatus();
          if (!active) return;
          setLocalStatus(status);
          if (!status.authenticated) return;
        }
        await initializeWorkspace();
      } catch (error) {
        if (active) {
          setAccessError(
            error instanceof Error ? error.message : "Could not open the local workspace."
          );
        }
      }
    }
    void initialize();
    return () => {
      active = false;
    };
  }, [initializeWorkspace, localMode]);

  const updateWorkspace = useCallback(async (state: WorkspaceState) => {
    await saveWorkspace(state, storageMode);
    setWorkspace(state);
  }, [storageMode]);

  async function completeLocalAccess(input: {
    username: string;
    password: string;
    setup: boolean;
  }) {
    setAccessError(null);
    try {
      if (input.setup) {
        await setupLocalRuntime(input);
      } else {
        await loginLocalRuntime(input);
      }
      const status = await getLocalRuntimeStatus();
      setLocalStatus(status);
      await initializeWorkspace();
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : "Local access failed.");
    }
  }

  async function signOutLocal() {
    await logoutLocalRuntime();
    setWorkspace(null);
    setLocalStatus(await getLocalRuntimeStatus());
  }

  const selectedCitation = useMemo(
    () => workspace?.citations.find((item) => item.id === selectedCitationId) ?? null,
    [selectedCitationId, workspace]
  );
  const selectedDocument = useMemo(
    () =>
      workspace?.documents.find((item) => item.id === selectedCitation?.documentId) ??
      null,
    [selectedCitation, workspace]
  );
  const selectedFact = useMemo(
    () =>
      workspace?.facts.find((fact) =>
        selectedCitation ? fact.citationIds.includes(selectedCitation.id) : false
      ) ?? null,
    [selectedCitation, workspace]
  );

  const approvedCount =
    workspace?.facts.filter((fact) => fact.status === "approved").length ?? 0;
  const pendingFacts =
    workspace?.facts.filter((fact) => fact.status === "pending") ?? [];
  const reviewRegisterCount = workspace?.facts.length ?? 0;

  async function runQuery() {
    if (!workspace || question.trim().length === 0 || importing || querying) return;
    setQuerying(true);
    setNotice(null);
    try {
      let queryFacts = workspace.facts;
      if (localMode) {
        if (!localStatus?.model.reachable || !localStatus.model.installed) {
          const unavailable: QueryAnswer = {
            status: "insufficient_evidence",
            question,
            claims: []
          };
          setAnswer(unavailable);
          setNotice("The verified record was not queried because the local model is unavailable.");
          setView("query");
          return;
        }
        const selectedIds = new Set(
          await selectFactsWithLocalModel({
            matterId: workspace.matter.id,
            question,
            facts: workspace.facts
          })
        );
        queryFacts = workspace.facts.filter((fact) => selectedIds.has(fact.id));
      }
      const result = await queryApprovedFacts({
        question,
        facts: queryFacts,
        citations: workspace.citations,
        documents: workspace.documents,
        selectAllApproved: localMode,
        ...(localMode ? { limit: queryFacts.length } : {})
      });
      setAnswer(result);
      setView("query");
      if (result.claims[0]?.citationIds[0]) {
        setSelectedCitationId(result.claims[0].citationIds[0]);
      }
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "The verified record could not be queried."
      );
    } finally {
      setQuerying(false);
    }
  }

  async function reviewFact(factId: string, status: "approved" | "rejected") {
    if (!workspace) return;
    const currentFact = workspace.facts.find((fact) => fact.id === factId);
    if (!currentFact) return;
    const reviewer = localStatus?.username ?? "Local reviewer";
    const reviewedAt = new Date().toISOString();
    const next: WorkspaceState = {
      ...workspace,
      facts: workspace.facts.map((fact) =>
        fact.id === factId
          ? {
              ...fact,
              status,
              reviewer,
              reviewedAt
            }
          : fact
      ),
      reviewDecisions: [
        ...workspace.reviewDecisions,
        {
          id: crypto.randomUUID(),
          factId,
          reviewer,
          decision: status,
          priorStatus: currentFact.status,
          occurredAt: reviewedAt
        }
      ],
      matter: { ...workspace.matter, updatedAt: new Date().toISOString() }
    };
    try {
      if (localMode) {
        await recordLocalAuditEvent({
          action: status === "approved" ? "review.approve" : "review.reject",
          resourceType: "fact",
          resourceId: factId
        });
      }
      await updateWorkspace(next);
      setNotice(status === "approved" ? "Fact verified and queryable." : "Fact withheld.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The review could not be saved.");
    }
  }

  async function importFiles(files: FileList | null) {
    if (!workspace || !files || files.length === 0) return;
    const selectedFiles = Array.from(files);
    const totalBytes = selectedFiles.reduce((total, file) => total + file.size, 0);
    if (
      selectedFiles.length > 200 ||
      totalBytes > 500 * 1024 * 1024 ||
      selectedFiles.some((file) => file.size > MAX_SOURCE_FILE_BYTES)
    ) {
      setNotice(
        "Import rejected: use at most 200 files, 500 MB per batch, and 100 MB per file."
      );
      return;
    }
    setImporting(true);
    setAnswer(null);
    setProcessingStatus({
      phase: "parsing",
      fileName: selectedFiles[0].name,
      fileNumber: 1,
      totalFiles: selectedFiles.length,
      message: `Preparing ${selectedFiles[0].name}`,
      progress: 0
    });
    setNotice(null);
    setImportPerformance(null);
    const startedAt = performance.now();
    const ocrSession = createLocalOcrSession();
    const documents = [...workspace.documents];
    const citations = [...workspace.citations];
    const facts = [...workspace.facts];
    const reviewDecisions = [...workspace.reviewDecisions];
    const importedDocuments: WorkspaceState["documents"] = [];
    const errors: string[] = [];
    const extractionErrors: string[] = [];
    const stagedOriginalIds: string[] = [];
    let consensusApproved = 0;
    let withheldByReview = 0;
    let withheldByVerification = 0;
    try {
      for (const [fileIndex, file] of selectedFiles.entries()) {
        try {
          const document = await parseLocalFile(file, {
            ocrSession,
            onProgress: (progress) => {
              setImportProgress(progress);
              setProcessingStatus({
                phase: "parsing",
                fileName: file.name,
                fileNumber: fileIndex + 1,
                totalFiles: selectedFiles.length,
                message: progress.message,
                progress:
                  (fileIndex + progress.progress * 0.55) / selectedFiles.length
              });
            }
          });
          if (localMode) {
            stagedOriginalIds.push(document.id);
            await storeOriginalFile(document.id, file);
          }
          importedDocuments.push(document);
          documents.push(document);
          if (
            document.processingState === "ready" &&
            document.canonicalText.length > 0
          ) {
            if (localMode) {
              try {
                setProcessingStatus({
                  phase: "agent-review",
                  fileName: file.name,
                  fileNumber: fileIndex + 1,
                  totalFiles: selectedFiles.length,
                  message:
                    "Extracting facts and running two separate evidence reviews",
                  progress: null
                });
                const extraction = await extractDocumentWithLocalModel(document);
                withheldByReview += extraction.reviewSummary.withheld;
                setProcessingStatus({
                  phase: "verifying",
                  fileName: file.name,
                  fileNumber: fileIndex + 1,
                  totalFiles: selectedFiles.length,
                  message: `Byte-verifying ${extraction.proposals.length} consensus facts`,
                  progress:
                    (fileIndex + 0.9) / selectedFiles.length
                });
                for (const proposal of extraction.proposals) {
                  const citation: Citation = {
                    id: crypto.randomUUID(),
                    documentId: document.id,
                    originalFileSha256: document.originalSha256,
                    canonicalArtifactSha256: document.canonicalSha256,
                    canonicalByteStart: proposal.canonicalByteStart,
                    canonicalByteEnd: proposal.canonicalByteEnd,
                    exactQuote: proposal.exactQuote,
                    pageNumber: proposal.pageNumber,
                    structuralPath: `local-llm/page-${proposal.pageNumber}`,
                    parserVersion: document.parserVersion
                  };
                  if (!(await verifyCitation(citation, document)).verified) {
                    withheldByVerification += 1;
                    continue;
                  }
                  consensusApproved += 1;
                  const factId = crypto.randomUUID();
                  const reviewedAt = new Date().toISOString();
                  citations.push(citation);
                  facts.push({
                    id: factId,
                    matterId: workspace.matter.id,
                    type: proposal.type,
                    // Only the deterministic, byte-matched source span becomes
                    // an authoritative claim. Model summaries stay untrusted.
                    statement: proposal.exactQuote,
                    eventDate: proposal.eventDate,
                    confidence: proposal.confidence,
                    status: "approved",
                    citationIds: [citation.id],
                    reviewer: CONSENSUS_REVIEWER,
                    reviewedAt
                  });
                  reviewDecisions.push({
                    id: crypto.randomUUID(),
                    factId,
                    reviewer: CONSENSUS_REVIEWER,
                    decision: "approved",
                    priorStatus: "pending",
                    occurredAt: reviewedAt
                  });
                }
              } catch {
                extractionErrors.push(file.name);
              }
              continue;
            }
            const sourcePage = document.pages.find(
              (page) => page.canonicalByteEnd > page.canonicalByteStart
            );
            const pageText = sourcePage
              ? readCanonicalByteRange(
                  document.canonicalText,
                  sourcePage.canonicalByteStart,
                  sourcePage.canonicalByteEnd
                )
              : "";
            const candidate =
              pageText
                .split(/(?<=[.!?])\s+/)
                .find((sentence) => sentence.trim().length >= 30)
                ?.trim() ?? pageText.slice(0, 240).trim();
            if (candidate) {
              const citation = await createCitation({
                id: crypto.randomUUID(),
                document,
                exactQuote: candidate,
                pageNumber: sourcePage?.pageNumber ?? null,
                structuralPath: sourcePage
                  ? `local-import/page-${sourcePage.pageNumber}/first-evidence-span`
                  : "local-import/first-evidence-span"
              });
              citations.push(citation);
              facts.push({
                id: crypto.randomUUID(),
                matterId: workspace.matter.id,
                type: "Evidence",
                statement: candidate,
                eventDate: null,
                confidence: Math.min(
                  0.8,
                  document.ocrMeanConfidence === null
                    ? 0.7
                    : document.ocrMeanConfidence
                ),
                status: "pending",
                citationIds: [citation.id],
                reviewer: null,
                reviewedAt: null
              });
            }
          }
        } catch (error) {
          errors.push(
            `${file.name}: ${
              error instanceof Error ? error.message : "unknown processing error"
            }`
          );
        }
      }
    } finally {
      await ocrSession.terminate().catch(() => undefined);
    }
    try {
      setProcessingStatus({
        phase: "saving",
        fileName: selectedFiles.at(-1)?.name ?? "Matter",
        fileNumber: selectedFiles.length,
        totalFiles: selectedFiles.length,
        message: "Encrypting and committing the verified record",
        progress: 0.98
      });
      await updateWorkspace({
        ...workspace,
        documents,
        citations,
        facts,
        reviewDecisions,
        matter: { ...workspace.matter, updatedAt: new Date().toISOString() }
      });
      setView("documents");
      setImportPerformance({
        files: importedDocuments.length,
        bytes: importedDocuments.reduce((total, document) => total + document.size, 0),
        pages: importedDocuments.reduce(
          (total, document) => total + document.pageCount,
          0
        ),
        ocrPages: importedDocuments.reduce(
          (total, document) => total + document.ocrPageCount,
          0
        ),
        durationMs: performance.now() - startedAt
      });
      setNotice(
        [
          `${importedDocuments.length} file${importedDocuments.length === 1 ? "" : "s"} processed locally.`,
          errors.length > 0
            ? `${errors.length} could not be read (${errors.join("; ")}).`
            : "",
          extractionErrors.length > 0
            ? `${extractionErrors.length} could not be extracted by the local model; the encrypted source remains available for retry.`
            : "",
          localMode
            ? `${consensusApproved} facts passed both model reviews and exact byte verification; ${withheldByReview} were withheld because the agents did not agree; ${withheldByVerification} failed deterministic citation verification.`
            : "",
          "No source file was transmitted outside this workstation."
        ].filter(Boolean).join(" ")
      );
    } catch (error) {
      if (localMode) {
        await Promise.allSettled(
          stagedOriginalIds.map((documentId) => deleteStagedOriginalFile(documentId))
        );
      }
      setNotice(
        error instanceof Error
          ? error.message
          : "The verified record could not be saved."
      );
    } finally {
      setImporting(false);
      setImportProgress(null);
      setProcessingStatus(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  }

  async function clearLocalMatter() {
    if (workspace?.matter.legalHold) {
      setNotice("Matter deletion is blocked while the legal hold is active.");
      return;
    }
    await clearWorkspace(storageMode);
    const state = createEmptyWorkspace();
    await saveWorkspace(state, storageMode);
    setWorkspace(state);
    setSelectedCitationId(null);
    setQuestion("");
    setAnswer(null);
    setImportPerformance(null);
    setNotice("Local matter data cleared.");
  }

  async function setLegalHold(enabled: boolean) {
    if (!workspace) return;
    try {
      await updateWorkspace({
        ...workspace,
        matter: {
          ...workspace.matter,
          legalHold: enabled,
          updatedAt: new Date().toISOString()
        }
      });
      setNotice(enabled ? "Legal hold enabled." : "Legal hold released.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The legal hold could not be changed.");
    }
  }

  if (localMode && localStatus && !localStatus.authenticated) {
    return (
      <LocalAccessScreen
        configured={localStatus.configured}
        error={accessError}
        onSubmit={completeLocalAccess}
      />
    );
  }

  if (!workspace) {
    return (
      <main className="loading-screen">
        <div className="brand-mark">VC</div>
        <LoaderCircle className="spinner" size={22} aria-hidden />
        <p>{accessError ?? "Opening the private matter workspace…"}</p>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">VC</div>
          <span>Verity Caseworks</span>
          <button
            className="mobile-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <X size={20} />
          </button>
        </div>
        <nav aria-label="Matter navigation">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "active" : ""}`}
              disabled={importing && (id === "query" || id === "exports")}
              onClick={() => {
                if (importing && (id === "query" || id === "exports")) return;
                setView(id);
                setSidebarOpen(false);
              }}
            >
              <Icon size={19} strokeWidth={1.7} />
              <span>{label}</span>
              {id === "review" && reviewRegisterCount > 0 ? (
                <span className="nav-count">{reviewRegisterCount}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="matter-brief">
          <span className="small-label">Open matter</span>
          <strong>{workspace.matter.name}</strong>
          <dl>
            <div>
              <dt>Matter ID</dt>
              <dd>{workspace.matter.id}</dd>
            </div>
            <div>
              <dt>Documents</dt>
              <dd>{workspace.documents.length}</dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>{formatDate(workspace.matter.updatedAt)}</dd>
            </div>
          </dl>
        </div>
        <div className="local-boundary">
          <span className="boundary-dot" aria-hidden />
          <span>Files stay on this device</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button
            className="mobile-menu"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <Menu size={22} />
          </button>
          <div className="breadcrumbs" aria-label="Current location">
            <span>{workspace.matter.name}</span>
            <ChevronRight size={14} />
            <strong>{viewLabels[view]}</strong>
          </div>
          <div className="topbar-actions">
            <div className="custody-status">
              <ShieldCheck size={16} />
              <span>
                <strong>Private workspace</strong>
                Original files do not leave this device
              </span>
            </div>
          </div>
        </header>

        {notice ? (
          <div className="notice" role="status">
            <Check size={16} />
            {notice}
            <button onClick={() => setNotice(null)} aria-label="Dismiss">
              <X size={15} />
            </button>
          </div>
        ) : null}

        {processingStatus ? (
          <ProcessingRail status={processingStatus} />
        ) : null}

        <div
          className={`content-frame ${selectedCitation ? "with-inspector" : ""}`}
          aria-busy={importing || querying}
        >
          <main className="main-content">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="visually-hidden"
              onChange={(event) => void importFiles(event.target.files)}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              className="visually-hidden"
              onChange={(event) => void importFiles(event.target.files)}
              {...({ webkitdirectory: "" } as Record<string, string>)}
            />

            {view === "overview" ? (
              <OverviewView
                workspace={workspace}
                encryptedStorage={localMode}
                pendingCount={pendingFacts.length}
                approvedCount={approvedCount}
                importing={importing}
                importProgress={importProgress}
                processingStatus={processingStatus}
                onAddFiles={() => fileInputRef.current?.click()}
                onAddFolder={() => folderInputRef.current?.click()}
                onNavigate={setView}
              />
            ) : null}

            {view === "query" ? (
              <QueryView
                workspace={workspace}
                approvedCount={approvedCount}
                question={question}
                answer={answer}
                processing={importing}
                querying={querying}
                automaticReview={localMode}
                selectedCitationId={selectedCitationId}
                onQuestionChange={setQuestion}
                onRunQuery={runQuery}
                onSelectCitation={setSelectedCitationId}
                onNavigate={setView}
              />
            ) : null}

            {view === "documents" ? (
              <DocumentsView
                workspace={workspace}
                importing={importing}
                importProgress={importProgress}
                processingStatus={processingStatus}
                importPerformance={importPerformance}
                fileInputRef={fileInputRef}
                folderInputRef={folderInputRef}
              />
            ) : null}

            {view === "review" ? (
              <section className="page-section">
                <div className="page-heading">
                  <div>
                    <span className="small-label">
                      {localMode ? "Automatic verification log" : "Verification log"}
                    </span>
                    <h1>Verified facts</h1>
                    <p>
                      {localMode
                        ? "Local extraction uses three role-separated model passes. Only unanimous, byte-matched facts enter the queryable record."
                        : "This browser-only pilot has no model endpoint. Facts require a local reviewer and an exact byte match before they become queryable."}
                    </p>
                  </div>
                </div>
                <ReviewTable
                  facts={workspace.facts}
                  citations={workspace.citations}
                  documents={workspace.documents}
                  onReview={reviewFact}
                  onSelectCitation={setSelectedCitationId}
                  expanded
                />
              </section>
            ) : null}

            {view === "exports" ? (
              <ExportsView
                workspace={workspace}
                auditExports={localMode}
                disabled={importing}
                onError={setNotice}
              />
            ) : null}

            {view === "settings" ? (
              <SettingsView
                onReset={clearLocalMatter}
                localStatus={localStatus}
                onSignOut={
                  localMode && localStatus?.accessMode === "legacy-password"
                    ? signOutLocal
                    : undefined
                }
                legalHold={workspace.matter.legalHold}
                onLegalHoldChange={setLegalHold}
              />
            ) : null}
          </main>

          {selectedCitation ? (
            <EvidenceInspector
              citation={selectedCitation}
              document={selectedDocument}
              fact={selectedFact}
              onClose={() => setSelectedCitationId(null)}
              onOpenOriginal={
                localMode && selectedDocument
                  ? async () => {
                      try {
                        await downloadOriginalFile(
                          selectedDocument.id,
                          selectedDocument.name
                        );
                      } catch (error) {
                        setNotice(
                          error instanceof Error
                            ? error.message
                            : "The original source could not be downloaded."
                        );
                      }
                    }
                  : undefined
              }
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function LocalAccessScreen({
  configured,
  error,
  onSubmit
}: {
  configured: boolean;
  error: string | null;
  onSubmit: (input: {
    username: string;
    password: string;
    setup: boolean;
  }) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);

  return (
    <main className="local-access-page">
      <section className="local-access-card">
        <div className="brand-mark">VC</div>
        <span className="small-label">Offline local appliance</span>
        <h1>{configured ? "Unlock the legacy evidence vault" : "Configure this workstation"}</h1>
        <p>
          This screen appears only for a password vault created by an earlier
          version. New local workspaces open through the signed-in macOS account.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setWorking(true);
            void onSubmit({ username, password, setup: !configured }).finally(() =>
              setWorking(false)
            );
          }}
        >
          <label>
            Reviewer name
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
              minLength={3}
            />
          </label>
          <label>
            Vault password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={configured ? "current-password" : "new-password"}
              required
              minLength={configured ? 1 : 14}
            />
          </label>
          {!configured ? (
            <small>
              Use at least 14 characters. Losing this password makes the encrypted
              evidence unrecoverable.
            </small>
          ) : null}
          {error ? (
            <div className="access-error" role="alert">
              {error.replaceAll("_", " ")}
            </div>
          ) : null}
          <button className="primary-button" type="submit" disabled={working}>
            {working ? (
              <LoaderCircle className="spinner" size={17} />
            ) : (
              <FolderLock size={17} />
            )}
            {working ? "Opening vault…" : configured ? "Unlock legacy vault" : "Create vault"}
          </button>
        </form>
        <div className="local-access-boundary">
          <ShieldCheck size={18} />
          <span>
            <strong>Loopback only</strong>
            Do not expose this service to a LAN or public interface.
          </span>
        </div>
      </section>
    </main>
  );
}

function ProcessingRail({ status }: { status: ProcessingStatus }) {
  const phaseLabels: Record<ProcessingStatus["phase"], string> = {
    parsing: "Reading and OCR",
    "agent-review": "Three-pass agent review",
    verifying: "Deterministic citation check",
    saving: "Encrypted record commit"
  };
  return (
    <section className="processing-rail">
      <LoaderCircle className="spinner" size={20} aria-hidden />
      <div className="processing-rail-copy">
        <span className="small-label" role="status" aria-live="polite">
          {phaseLabels[status.phase]}
        </span>
        <strong aria-live="off">{status.message}</strong>
        <span aria-live="off">
          File {status.fileNumber} of {status.totalFiles}: {status.fileName}
        </span>
      </div>
      <div className="processing-rail-progress">
        <span>Query and export locked until verification finishes</span>
        {status.progress === null ? (
          <progress aria-label="Processing" />
        ) : (
          <progress
            aria-label="Processing"
            max={1}
            value={status.progress}
          />
        )}
      </div>
    </section>
  );
}

function OverviewView({
  workspace,
  encryptedStorage,
  pendingCount,
  approvedCount,
  importing,
  importProgress,
  processingStatus,
  onAddFiles,
  onAddFolder,
  onNavigate
}: {
  workspace: WorkspaceState;
  encryptedStorage: boolean;
  pendingCount: number;
  approvedCount: number;
  importing: boolean;
  importProgress: ParseProgress | null;
  processingStatus: ProcessingStatus | null;
  onAddFiles: () => void;
  onAddFolder: () => void;
  onNavigate: (view: View) => void;
}) {
  const hasDocuments = workspace.documents.length > 0;
  const hasExtractedFacts = workspace.facts.length > 0;
  const reviewComplete =
    hasExtractedFacts && pendingCount === 0 && approvedCount > 0;

  const nextAction = importing
    ? {
        eyebrow: "Record preparation in progress",
        title: processingStatus?.message ?? "Processing the case file",
        description:
          "Query and export stay locked until extraction, separate model review passes, byte verification, and encrypted save all finish.",
        action: () => undefined,
        actionLabel: "Processing locally…",
        secondaryAction: () => onNavigate("documents"),
        secondaryLabel: "View processing details"
      }
    : !hasDocuments
    ? {
        eyebrow: "Start here",
        title: "Add the case file",
        description:
          "Choose a folder or select individual documents. Text extraction and OCR happen in this browser.",
        action: onAddFolder,
        actionLabel: "Choose a case folder",
        secondaryAction: onAddFiles,
        secondaryLabel: "Select files instead"
      }
    : pendingCount > 0
      ? {
          eyebrow: "Next step",
          title: `Resolve ${pendingCount} legacy ${pendingCount === 1 ? "draft" : "drafts"}`,
          description:
            "These records predate automatic consensus review and remain withheld until resolved.",
          action: () => onNavigate("review"),
          actionLabel: "Open verification register",
          secondaryAction: () => onNavigate("documents"),
          secondaryLabel: "View documents"
        }
      : approvedCount > 0
        ? {
            eyebrow: "Matter ready",
            title: "Ask a question about the record",
            description:
              "Answers use consensus-verified facts only. Every claim opens to a byte-matched source quotation.",
            action: () => onNavigate("query"),
            actionLabel: "Ask the case",
            secondaryAction: () => onNavigate("exports"),
            secondaryLabel: "Export verified facts"
          }
        : {
            eyebrow: "Check the record",
            title: "Review imported documents",
            description:
              "The documents are processed, but no reviewable facts are available yet. Check their evidence state.",
            action: () => onNavigate("documents"),
            actionLabel: "View documents",
            secondaryAction: onAddFiles,
            secondaryLabel: "Add more files"
          };

  return (
    <section className="overview-page">
      <header className="matter-heading">
        <div>
          <span className="small-label">Matter workspace</span>
          <h1>{workspace.matter.name}</h1>
          <p>
            Build a verified, source-linked record before relying on any extracted
            information.
          </p>
        </div>
        <dl className="matter-meta">
          <div>
            <dt>Matter ID</dt>
            <dd>{workspace.matter.id}</dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>{formatDate(workspace.matter.updatedAt)}</dd>
          </div>
        </dl>
      </header>

      <ol className="case-path" aria-label="Matter preparation progress">
        <CaseStep
          number="1"
          label="Add documents"
          detail={`${workspace.documents.length} in matter`}
          state={hasDocuments ? "complete" : "current"}
        />
        <CaseStep
          number="2"
          label="Extract evidence"
          detail={hasExtractedFacts ? `${workspace.facts.length} proposed facts` : "Not started"}
          state={
            importing
              ? "current"
              : hasExtractedFacts
                ? "complete"
                : hasDocuments
                  ? "current"
                  : "upcoming"
          }
        />
        <CaseStep
          number="3"
          label="Verify facts"
          detail={
            importing
              ? "Agents reviewing"
              : pendingCount > 0
              ? `${pendingCount} waiting`
              : reviewComplete
                ? "Consensus complete"
                : "Not started"
          }
          state={
            importing
              ? "current"
              : reviewComplete
              ? "complete"
              : pendingCount > 0
                ? "current"
                : "upcoming"
          }
        />
        <CaseStep
          number="4"
          label="Ask or export"
          detail={
            importing
              ? "Locked during processing"
              : approvedCount > 0
                ? `${approvedCount} verified facts`
                : "Requires verified facts"
          }
          state={!importing && approvedCount > 0 ? "current" : "upcoming"}
        />
      </ol>

      <div className="overview-grid">
        <section className="next-action-panel">
          <div>
            <span className="small-label">{nextAction.eyebrow}</span>
            <h2>{nextAction.title}</h2>
            <p>{nextAction.description}</p>
          </div>
          <div className="next-action-buttons">
            <button
              className="primary-button"
              onClick={nextAction.action}
              disabled={importing}
            >
              {importing ? "Processing locally…" : nextAction.actionLabel}
              {!importing ? <ArrowRight size={16} /> : null}
            </button>
            <button
              className="text-button"
              onClick={nextAction.secondaryAction}
              disabled={importing}
            >
              {nextAction.secondaryLabel}
            </button>
          </div>
          {importing && (processingStatus || importProgress) ? (
            <div className="inline-progress" role="status" aria-live="polite">
              <span>
                {processingStatus?.message ?? importProgress?.message}
              </span>
              {processingStatus?.progress === null ? (
                <progress />
              ) : (
                <progress
                  max={1}
                  value={processingStatus?.progress ?? importProgress?.progress ?? 0}
                />
              )}
            </div>
          ) : null}
        </section>

        <aside className="handling-note">
          <FolderLock size={20} />
          <div>
            <span className="small-label">How files are handled</span>
            <strong>Your source documents stay on this device.</strong>
            <p>
              The app reads files and runs OCR in your browser. It stores a local
              evidence copy with cryptographic hashes for citation checks.
            </p>
            <button onClick={() => onNavigate("settings")}>View privacy settings</button>
          </div>
        </aside>
      </div>

      <section className="matter-summary" aria-label="Matter summary">
        <div className="summary-heading">
          <div>
            <span className="small-label">Matter record</span>
            <h2>What is available now</h2>
          </div>
          <button className="text-button" onClick={() => onNavigate("documents")}>
            Open document list <ArrowRight size={14} />
          </button>
        </div>
        <div className="metrics">
          <Metric
            icon={FileText}
            label="Documents"
            value={String(workspace.documents.length)}
            detail={encryptedStorage ? "Encrypted on this Mac" : "Stored in this browser"}
          />
          <Metric
            icon={FileCheck2}
            label="Awaiting verification"
            value={String(pendingCount)}
            detail={importing ? "Verification in progress" : "Withheld from queries"}
            tone={pendingCount > 0 ? "copper" : "blue"}
          />
          <Metric
            icon={ShieldCheck}
            label="Verified facts"
            value={String(approvedCount)}
            detail={importing ? "Locked while processing" : "Available for answers"}
            tone="green"
          />
          <Metric
            icon={Database}
            label="Citation rule"
            value="Exact"
            detail="UTF-8 byte matched"
            tone="green"
          />
        </div>
      </section>
    </section>
  );
}

function CaseStep({
  number,
  label,
  detail,
  state
}: {
  number: string;
  label: string;
  detail: string;
  state: "complete" | "current" | "upcoming";
}) {
  return (
    <li className={`case-step ${state}`}>
      <span className="step-marker">
        {state === "complete" ? <Check size={15} /> : number}
      </span>
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </li>
  );
}

function QueryView({
  workspace,
  approvedCount,
  question,
  answer,
  processing,
  querying,
  automaticReview,
  selectedCitationId,
  onQuestionChange,
  onRunQuery,
  onSelectCitation,
  onNavigate
}: {
  workspace: WorkspaceState;
  approvedCount: number;
  question: string;
  answer: QueryAnswer | null;
  processing: boolean;
  querying: boolean;
  automaticReview: boolean;
  selectedCitationId: string | null;
  onQuestionChange: (value: string) => void;
  onRunQuery: () => Promise<void>;
  onSelectCitation: (id: string) => void;
  onNavigate: (view: View) => void;
}) {
  const citationsById = new Map(
    workspace.citations.map((citation) => [citation.id, citation])
  );
  const documentsById = new Map(
    workspace.documents.map((document) => [document.id, document])
  );
  const factsById = new Map(workspace.facts.map((fact) => [fact.id, fact]));
  const renderableClaims = (answer?.claims ?? []).flatMap((claim) => {
    const evidence = claim.citationIds.flatMap((citationId) => {
      const citation = citationsById.get(citationId);
      const document = citation ? documentsById.get(citation.documentId) : undefined;
      return citation && document ? [{ citation, document }] : [];
    });
    return evidence.length > 0 ? [{ claim, evidence }] : [];
  });
  const canQuery = approvedCount > 0 && !processing;
  const resultDocumentCount = answer
    ? new Set(
        renderableClaims.flatMap(({ evidence }) =>
          evidence.map(({ document }) => document.id)
        )
      ).size
    : 0;

  return (
    <section className="query-page">
      <header className="page-heading query-heading">
        <div>
          <span className="small-label">Verified record only</span>
          <h1>Ask the case</h1>
          <p>
            Ask in plain language. Answers are limited to{" "}
            {automaticReview ? "consensus-reviewed" : "reviewer-approved"} facts
            and show the exact location and surrounding source context.
          </p>
        </div>
        <span className="record-count">
          <strong>{approvedCount}</strong> verified {approvedCount === 1 ? "fact" : "facts"}
        </span>
      </header>

      {processing ? (
        <div className="query-locked processing">
          <LoaderCircle className="spinner" size={24} />
          <div>
            <strong>The case record is still being verified</strong>
            <p>
              Search remains locked until parsing, local-agent consensus, exact
              citation checks, and encrypted storage have all completed.
            </p>
          </div>
          <button className="primary-button" onClick={() => onNavigate("documents")}>
            View processing status
            <ArrowRight size={16} />
          </button>
        </div>
      ) : !canQuery ? (
        <div className="query-locked">
          <FileCheck2 size={24} />
          <div>
            <strong>Add evidence before asking questions</strong>
            <p>
              The queryable record opens automatically after the local agents reach
              consensus and every citation passes deterministic byte verification.
            </p>
          </div>
          <button
            className="primary-button"
            onClick={() =>
              onNavigate("documents")
            }
          >
            {workspace.documents.length > 0 ? "View documents" : "Add documents"}
            <ArrowRight size={16} />
          </button>
        </div>
      ) : (
        <section className="query-panel">
          <form
            className={`query-form ${querying ? "querying" : ""}`}
            aria-busy={querying}
            onSubmit={(event) => {
              event.preventDefault();
              void onRunQuery();
            }}
          >
            <Search size={19} aria-hidden />
            <input
              value={question}
              onChange={(event) => onQuestionChange(event.target.value)}
              aria-label="Ask a question about the matter"
              placeholder="For example: What happened before the March 12 meeting?"
              disabled={querying}
            />
            <button
              type="submit"
              disabled={question.trim().length === 0 || querying}
            >
              {querying ? (
                <>
                  <LoaderCircle className="spinner" size={16} />
                  Checking record…
                </>
              ) : (
                "Search record"
              )}
            </button>
          </form>
          <div className="query-rules">
            <span>
              <CheckCircle2 size={14} />{" "}
              {automaticReview ? "Consensus-reviewed" : "Reviewer-approved"} facts only
            </span>
            <span><CheckCircle2 size={14} /> Exact source quotations</span>
            <span><CheckCircle2 size={14} /> Unsupported claims withheld</span>
          </div>

          {answer ? (
            <>
              <div className="answer-header">
                <div>
                  <span className="small-label">Answer from the record</span>
                  {renderableClaims.length > 0 ? (
                    <strong>
                      {renderableClaims.length} verified{" "}
                      {renderableClaims.length === 1 ? "finding" : "findings"} from{" "}
                      {resultDocumentCount}{" "}
                      {resultDocumentCount === 1 ? "document" : "documents"}
                    </strong>
                  ) : null}
                </div>
                <span
                  className={`answer-status ${
                    answer.status === "verified" ? "verified" : ""
                  }`}
                >
                  {answer.status === "verified" ? (
                    <>
                      <CheckCircle2 size={15} /> Citations verified
                    </>
                  ) : (
                    "Insufficient evidence"
                  )}
                </span>
              </div>
              {renderableClaims.length ? (
                <div className="claim-list">
                  {renderableClaims.map(({ claim, evidence }, index) => {
                    const fact = factsById.get(claim.factId);
                    return (
                      <article key={claim.factId} className="claim">
                        <span className="claim-number">{index + 1}</span>
                        <span className="claim-body">
                          <span className="claim-statement">{claim.statement}</span>
                          <span className="claim-fact-meta">
                            <span>{fact?.type ?? "Fact"}</span>
                            {fact?.eventDate ? <span>Date: {fact.eventDate}</span> : null}
                            {fact ? (
                              <span>
                                Extraction confidence{" "}
                                {Math.round(fact.confidence * 100)}%
                              </span>
                            ) : null}
                            <span>
                              {fact?.reviewer === CONSENSUS_REVIEWER
                                ? "Three-pass consensus"
                                : "Human verification"}
                            </span>
                          </span>
                        </span>
                        <span className="byte-verified">
                          <CheckCircle2 size={16} /> Verified
                        </span>
                        <div className="claim-evidence-list">
                          {evidence.map(({ citation, document }) => {
                            const context = citationContext(citation, document);
                            const page = document.pages.find(
                              (item) => item.pageNumber === citation.pageNumber
                            );
                            return (
                              <button
                                key={citation.id}
                                className={`claim-evidence ${
                                  selectedCitationId === citation.id ? "selected" : ""
                                }`}
                                onClick={() => onSelectCitation(citation.id)}
                              >
                                <span className="evidence-heading">
                                  <strong>{document.name}</strong>
                                  <span>
                                    {citation.pageNumber
                                      ? `Page ${citation.pageNumber} of ${document.pageCount}`
                                      : "Structural text span"}
                                    {page
                                      ? ` · ${
                                          page.extractionMethod === "ocr"
                                            ? "local OCR"
                                            : "native text"
                                        }`
                                      : ""}
                                  </span>
                                </span>
                                <span className="context-label">
                                  Surrounding source context
                                </span>
                                <span className="source-context">
                                  {context.before ? `…${context.before}` : ""}
                                  <mark>{context.exactQuote}</mark>
                                  {context.after ? `${context.after}…` : ""}
                                </span>
                                <span className="claim-source">
                                  <span>
                                    {citation.structuralPath ??
                                      `page-${citation.pageNumber ?? "unknown"}`}
                                  </span>
                                  <span>
                                    UTF-8 bytes {citation.canonicalByteStart}–
                                    {citation.canonicalByteEnd} · artifact{" "}
                                    {shortHash(citation.canonicalArtifactSha256)}
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-answer">
                  <ShieldCheck size={24} />
                  <strong>The verified record does not support an answer.</strong>
                  <p>Try a narrower question or review additional source material.</p>
                </div>
              )}
            </>
          ) : (
            <div className="query-empty">
              <MessageSquareText size={22} />
              <strong>Ask about dates, people, events, or supporting evidence.</strong>
              <p>
                The app will abstain when the verified record cannot support a
                response.
              </p>
            </div>
          )}
        </section>
      )}
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  tone = "blue"
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  detail: string;
  tone?: "blue" | "green" | "copper";
}) {
  return (
    <article className="metric">
      <div className={`metric-icon ${tone}`}>
        <Icon size={20} strokeWidth={1.7} />
      </div>
      <div>
        <span className="small-label">{label}</span>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function ReviewTable({
  facts,
  citations,
  documents,
  onReview,
  onSelectCitation,
  expanded = false
}: {
  facts: FactRecord[];
  citations: Citation[];
  documents: WorkspaceState["documents"];
  onReview: (id: string, status: "approved" | "rejected") => Promise<void>;
  onSelectCitation: (id: string) => void;
  expanded?: boolean;
}) {
  const citationMap = new Map(citations.map((citation) => [citation.id, citation]));
  const documentMap = new Map(documents.map((document) => [document.id, document]));
  return (
    <section className={`review-panel ${expanded ? "expanded" : ""}`}>
      <div className="review-title">
        <div>
          <span className="small-label">Verification register</span>
          <strong>
            {facts.length} {facts.length === 1 ? "fact" : "facts"} in register
          </strong>
        </div>
      </div>
      {facts.length === 0 ? (
        <div className="table-empty">
          <CheckCircle2 size={20} />
          No verified facts are available yet.
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fact</th>
                <th>Type</th>
                <th>Source</th>
                <th>Verification</th>
                <th>Override</th>
              </tr>
            </thead>
            <tbody>
              {facts.map((fact) => {
                const citation = citationMap.get(fact.citationIds[0]);
                const document = citation
                  ? documentMap.get(citation.documentId)
                  : undefined;
                return (
                  <tr key={fact.id}>
                    <td>{fact.statement}</td>
                    <td>{fact.type}</td>
                    <td>
                      <button
                        className="source-link"
                        disabled={!citation}
                        onClick={() => citation && onSelectCitation(citation.id)}
                      >
                        {document?.name ?? "Unavailable"}
                        {citation?.pageNumber ? ` · p. ${citation.pageNumber}` : ""}
                      </button>
                    </td>
                    <td>
                      <div className="verification-method">
                        <strong>
                          {fact.status === "approved"
                            ? fact.reviewer === CONSENSUS_REVIEWER
                              ? "Consensus + byte match"
                              : "Reviewer + byte match"
                            : fact.status === "rejected"
                              ? "Withheld"
                              : "Awaiting decision"}
                        </strong>
                        <span>{fact.reviewer ?? "Not reviewed"}</span>
                      </div>
                    </td>
                    <td>
                      <div className="review-actions">
                        {fact.status === "pending" ? (
                          <button onClick={() => void onReview(fact.id, "approved")}>
                            Approve
                          </button>
                        ) : null}
                        {fact.status === "rejected" ? (
                          <button onClick={() => void onReview(fact.id, "approved")}>
                            Restore
                          </button>
                        ) : (
                          <button
                            className={fact.status === "approved" ? "withdraw" : "reject"}
                            onClick={() => void onReview(fact.id, "rejected")}
                            aria-label={`Withhold ${fact.statement} from queries`}
                          >
                            {fact.status === "approved" ? "Withhold" : <X size={15} />}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DocumentsView({
  workspace,
  importing,
  importProgress,
  processingStatus,
  importPerformance,
  fileInputRef,
  folderInputRef
}: {
  workspace: WorkspaceState;
  importing: boolean;
  importProgress: ParseProgress | null;
  processingStatus: ProcessingStatus | null;
  importPerformance: ImportPerformance | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  folderInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <section className="page-section">
      <div className="page-heading">
        <div>
          <span className="small-label">Private evidence storage</span>
          <h1>Documents</h1>
          <p>
            Files are parsed in this browser; only canonical evidence records are
            stored locally. No file upload request is made to Vercel or an LLM.
          </p>
        </div>
        <div className="import-actions">
          <button
            className="secondary-button"
            onClick={() => folderInputRef.current?.click()}
            disabled={importing}
          >
            <FolderUp size={17} />
            Add folder
          </button>
          <button
            className="primary-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            <FileUp size={17} />
            {importing ? "Processing locally…" : "Add files"}
          </button>
        </div>
      </div>
      <div className="privacy-banner">
        <FolderLock size={22} />
        <div>
          <strong>Zero document egress is enforced by design.</strong>
          <p>
            Native text extraction and bundled OCR run inside this browser. OCR
            workers, WebAssembly, and English language data are served by this app;
            document bytes and page images are never uploaded.
          </p>
        </div>
      </div>
      {importing && processingStatus ? (
        <div className="ocr-progress" role="status" aria-live="polite">
          {processingStatus.phase === "parsing" ? (
            <Cpu size={20} />
          ) : (
            <LoaderCircle className="spinner" size={20} />
          )}
          <div>
            <strong>{processingStatus.message}</strong>
            <span>
              {processingStatus.phase === "parsing" &&
              importProgress?.pageNumber &&
              importProgress.totalPages
                ? `Page ${importProgress.pageNumber} of ${importProgress.totalPages}`
                : processingStatus.phase === "agent-review"
                  ? "Extractor → evidence-support reviewer → adversarial reviewer"
                  : processingStatus.phase === "verifying"
                    ? "Checking file hash, canonical hash, byte bounds, and exact text"
                    : "Saving the complete verified record atomically"}
            </span>
            {processingStatus.progress === null ? (
              <progress />
            ) : (
              <progress max={1} value={processingStatus.progress} />
            )}
          </div>
        </div>
      ) : null}
      {importPerformance ? (
        <div className="performance-summary" aria-label="Last import performance">
          <span className="small-label">Last local import</span>
          <strong>{formatDuration(importPerformance.durationMs)}</strong>
          <span>{importPerformance.files} files</span>
          <span>{importPerformance.pages} pages</span>
          <span>{importPerformance.ocrPages} OCR pages</span>
          <span>{formatBytes(importPerformance.bytes)}</span>
          <span>
            {importPerformance.pages > 0
              ? `${(
                  importPerformance.durationMs / importPerformance.pages / 1000
                ).toFixed(2)} s/page`
              : "No pages"}
          </span>
        </div>
      ) : null}
      <div className="document-list">
        <div className="document-list-head">
          <span>Document</span>
          <span>Evidence state</span>
          <span>Canonical artifact</span>
          <span>Ingested</span>
        </div>
        {workspace.documents.length === 0 ? (
          <div className="document-empty">
            <Upload size={22} />
            <strong>No evidence imported</strong>
            <span>Add scanned PDFs, images, or native documents to begin.</span>
          </div>
        ) : workspace.documents.map((document) => (
          <article className="document-row" key={document.id}>
            <div className="document-name">
              <FileText size={19} />
              <div>
                <strong>{document.name}</strong>
                <span>
                  {(document.size / 1024).toFixed(1)} KB · {document.pageCount}{" "}
                  {document.pageCount === 1 ? "page" : "pages"} ·{" "}
                  {formatDuration(document.processingDurationMs)}
                </span>
              </div>
            </div>
            <span className={`state ${document.processingState}`}>
              {document.processingState === "ready"
                ? document.ocrPageCount > 0
                  ? `Ready · ${document.ocrPageCount} OCR`
                  : "Ready · native text"
                : document.processingState === "needs-ocr"
                  ? "Awaiting local OCR"
                  : document.processingState === "ocr-failed"
                    ? "OCR review required"
                  : "Unsupported"}
            </span>
            <div className="hash-cell">
              <span>{document.canonicalByteLength.toLocaleString()} UTF-8 bytes</span>
              <code>{shortHash(document.canonicalSha256)}</code>
            </div>
            <span>{formatDate(document.ingestedAt)}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function ExportsView({
  workspace,
  auditExports,
  disabled,
  onError
}: {
  workspace: WorkspaceState;
  auditExports: boolean;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const args = [workspace.facts, workspace.citations, workspace.documents] as const;
  const runExport = async (
    format: "csv" | "xlsx" | "json" | "docx",
    action: () => void | Promise<void>
  ) => {
    try {
      if (auditExports) {
        await recordLocalAuditEvent({
          action: `export.${format}.attempt`,
          resourceType: "export",
          resourceId: workspace.matter.id
        });
      }
      await action();
    } catch (error) {
      onError(error instanceof Error ? error.message : "The export could not be created.");
    }
  };
  const formats = [
    {
      label: "CSV",
      description: "Flat, source-linked table for review and analysis.",
      action: () => runExport("csv", () => exportCsv(...args))
    },
    {
      label: "XLSX",
      description: "Approved facts in an Excel-compatible workbook.",
      action: () => runExport("xlsx", () => exportXlsx(...args))
    },
    {
      label: "JSON",
      description: "Structured records with exact citation metadata.",
      action: () => runExport("json", () => exportJson(...args))
    },
    {
      label: "DOCX",
      description: "Cited narrative list for legal work product.",
      action: () => runExport("docx", () => exportDocx(...args))
    }
  ];
  return (
    <section className="page-section">
      <div className="page-heading">
        <div>
          <span className="small-label">Verified records only</span>
          <h1>Exports</h1>
          <p>Every exported fact retains its exact quotation and byte range.</p>
        </div>
      </div>
      <div className="export-list">
        {formats.map((format) => (
          <article key={format.label}>
            <div className="format-mark">{format.label}</div>
            <div>
              <strong>{format.label} export</strong>
              <p>{format.description}</p>
            </div>
            <button
              onClick={() => void format.action()}
              disabled={disabled}
            >
              {disabled ? (
                <>
                  <LoaderCircle className="spinner" size={16} /> Record processing
                </>
              ) : (
                <>
                  <Download size={16} /> Download
                </>
              )}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function SettingsView({
  onReset,
  localStatus,
  onSignOut,
  legalHold,
  onLegalHoldChange
}: {
  onReset: () => Promise<void>;
  localStatus: LocalRuntimeStatus | null;
  onSignOut?: () => Promise<void>;
  legalHold: boolean;
  onLegalHoldChange: (enabled: boolean) => Promise<void>;
}) {
  return (
    <section className="page-section">
      <div className="page-heading">
        <div>
          <span className="small-label">Security posture</span>
          <h1>Settings</h1>
          <p>Protected cloud processing remains locked in this pilot deployment.</p>
        </div>
      </div>
      <div className="settings-list">
        <SettingRow
          icon={FolderLock}
          title="Evidence storage"
          value={localStatus ? "AES-256-GCM local vault" : "Browser-local IndexedDB"}
          detail={
            localStatus
              ? `Original files, canonical evidence, and review state are encrypted with a key protected by the signed-in macOS account (${localStatus.username ?? "local user"}).`
              : "Source bytes and canonical artifacts never leave this device."
          }
        />
        <SettingRow
          icon={Gavel}
          title="Legal hold"
          value={legalHold ? "Active" : "Not active"}
          detail={
            legalHold
              ? "Matter deletion is blocked until an authorized reviewer releases the hold."
              : "Enable a hold before preservation duties require deletion to be suspended."
          }
        />
        <SettingRow
          icon={Cpu}
          title="On-device OCR"
          value="Bundled and enabled"
          detail="Self-hosted Tesseract WebAssembly and language data process scans locally."
        />
        <SettingRow
          icon={ShieldCheck}
          title="Natural-language query"
          value={localStatus ? `Local ${localStatus.model.model}` : "Deterministic local retrieval"}
          detail={
            localStatus
              ? "The loopback-only model selects consensus-reviewed fact IDs; deterministic code verifies citations before display."
              : "Only verified facts with exact citations can be returned."
          }
        />
        {localStatus?.audit ? (
          <SettingRow
            icon={FileCheck2}
            title="Audit chain"
            value={localStatus.audit.valid ? "Verified" : "Verification failed"}
            detail={`${localStatus.audit.records} tamper-evident local audit events recorded.`}
          />
        ) : null}
        <SettingRow
          icon={Gavel}
          title="Protected PHI mode"
          value={localStatus ? "Local technical profile" : "Disabled"}
          detail={
            localStatus
              ? "Technical safeguards are enabled locally; organizational, physical, and legal controls remain the firm's responsibility."
              : "Requires executed BAAs and a separately reviewed production environment."
          }
        />
      </div>
      <div className="settings-actions">
        <button
          className="secondary-button"
          onClick={() => {
            if (
              legalHold &&
              !window.confirm(
                "Release this legal hold? Matter deletion will become available."
              )
            ) {
              return;
            }
            void onLegalHoldChange(!legalHold);
          }}
        >
          {legalHold ? "Release legal hold" : "Enable legal hold"}
        </button>
        <button className="secondary-button reset-button" onClick={() => void onReset()}>
          <RotateCcw size={16} /> Clear local matter data
        </button>
        {localStatus ? (
          <button
            className="secondary-button"
            onClick={() => void downloadEncryptedBackup()}
          >
            <Archive size={16} /> Download encrypted backup
          </button>
        ) : null}
        {onSignOut ? (
          <button className="secondary-button" onClick={() => void onSignOut()}>
            Sign out and lock vault
          </button>
        ) : null}
      </div>
    </section>
  );
}

function SettingRow({
  icon: Icon,
  title,
  value,
  detail
}: {
  icon: typeof Archive;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <article>
      <Icon size={21} />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <span>{value}</span>
    </article>
  );
}

function EvidenceInspector({
  citation,
  document,
  fact,
  onClose,
  onOpenOriginal
}: {
  citation: Citation;
  document: WorkspaceState["documents"][number] | null;
  fact: FactRecord | null;
  onClose: () => void;
  onOpenOriginal?: () => Promise<void>;
}) {
  const [verification, setVerification] = useState<"checking" | "verified" | "failed">(
    "checking"
  );
  const page = document?.pages.find(
    (item) => item.pageNumber === citation.pageNumber
  );
  const context = document ? citationContext(citation, document) : null;
  useEffect(() => {
    let active = true;
    void verifyCitation(citation, document ?? undefined).then((result) => {
      if (active) setVerification(result.verified ? "verified" : "failed");
    });
    return () => {
      active = false;
    };
  }, [citation, document]);

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <div>
          <span className="small-label">Evidence inspector</span>
          <strong>{document?.name ?? "Source unavailable"}</strong>
          <span>{citation.pageNumber ? `Page ${citation.pageNumber}` : "Structural span"}</span>
        </div>
        <button onClick={onClose} aria-label="Close evidence inspector">
          <PanelRightClose size={19} />
        </button>
      </div>
      <div className="inspector-context">
        <span className="small-label">Surrounding source context</span>
        <p>
          {context?.before ? `…${context.before}` : ""}
          <mark>{context?.exactQuote ?? citation.exactQuote}</mark>
          {context?.after ? `${context.after}…` : ""}
        </p>
      </div>
      {onOpenOriginal ? (
        <button className="secondary-button inspector-source-button" onClick={() => void onOpenOriginal()}>
          <FileText size={16} /> Download original source
        </button>
      ) : null}
      <InspectorField
        label="Immutable file hash (SHA-256)"
        value={citation.originalFileSha256}
        mono
      />
      <InspectorField
        label="Canonical hash (SHA-256)"
        value={citation.canonicalArtifactSha256}
        mono
      />
      <InspectorField
        label="UTF-8 byte range"
        value={`${citation.canonicalByteStart}–${citation.canonicalByteEnd} (${citation.canonicalByteEnd - citation.canonicalByteStart} bytes)`}
      />
      <InspectorField
        label="Document location"
        value={
          citation.pageNumber
            ? `Page ${citation.pageNumber} of ${document?.pageCount ?? "unknown"}`
            : "Structural text span"
        }
        supporting={citation.structuralPath ?? undefined}
      />
      {page ? (
        <InspectorField
          label="Text source"
          value={
            page.extractionMethod === "ocr"
              ? "Bundled local OCR"
              : "Native document text"
          }
          supporting={
            page.ocrConfidence === null
              ? undefined
              : `OCR confidence ${page.ocrConfidence.toFixed(1)}%${
                  page.imageSha256 ? ` · page image ${shortHash(page.imageSha256)}` : ""
                }`
          }
        />
      ) : null}
      <InspectorField label="Parser version" value={citation.parserVersion} />
      <InspectorField
        label="Verification decision"
        value={fact?.reviewer ?? "Not yet verified"}
        supporting={
          fact?.reviewedAt ? `Completed ${formatDate(fact.reviewedAt)}` : undefined
        }
      />
      <div className={`verification-box ${verification}`}>
        {verification === "verified" ? (
          <CheckCircle2 size={18} />
        ) : verification === "failed" ? (
          <X size={18} />
        ) : (
          <Gauge size={18} />
        )}
        <div>
          <strong>
            {verification === "verified"
              ? "Byte verified"
              : verification === "failed"
                ? "Verification failed"
                : "Checking evidence"}
          </strong>
          <span>
            {verification === "verified"
              ? "File hashes, canonical artifact, byte bounds, and exact source text all match"
              : "This claim cannot be represented as verified"}
          </span>
        </div>
      </div>
    </aside>
  );
}

function InspectorField({
  label,
  value,
  supporting,
  mono = false
}: {
  label: string;
  value: string;
  supporting?: string;
  mono?: boolean;
}) {
  return (
    <div className="inspector-field">
      <span className="small-label">{label}</span>
      <strong className={mono ? "mono" : ""}>{value}</strong>
      {supporting ? <span>{supporting}</span> : null}
    </div>
  );
}
