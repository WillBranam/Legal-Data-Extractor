"use client";

import {
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Database,
  Download,
  FileCheck2,
  FileText,
  FolderLock,
  Gauge,
  Gavel,
  LayoutDashboard,
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
import { buildDemoWorkspace } from "@/lib/demo";
import { createCitation, verifyCitation } from "@/lib/evidence";
import {
  exportCsv,
  exportDocx,
  exportJson,
  exportXlsx
} from "@/lib/exports";
import { parseLocalFile } from "@/lib/parsers";
import { queryApprovedFacts } from "@/lib/query";
import { clearWorkspace, loadWorkspace, saveWorkspace } from "@/lib/storage";
import type {
  Citation,
  FactRecord,
  QueryAnswer,
  WorkspaceState
} from "@/lib/types";

type View = "overview" | "documents" | "review" | "query" | "exports" | "settings";

const navItems: Array<{
  id: View;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { id: "overview", label: "Matter overview", icon: LayoutDashboard },
  { id: "documents", label: "Documents", icon: FileText },
  { id: "review", label: "Review queue", icon: FileCheck2 },
  { id: "query", label: "Ask the case", icon: MessageSquareText },
  { id: "exports", label: "Exports", icon: Download },
  { id: "settings", label: "Settings", icon: Settings }
];

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

function initialQuestion() {
  return "What happened between January and March 2025?";
}

export function LegalWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [view, setView] = useState<View>("overview");
  const [question, setQuestion] = useState(initialQuestion);
  const [answer, setAnswer] = useState<QueryAnswer | null>(null);
  const [selectedCitationId, setSelectedCitationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    async function initialize() {
      const saved = await loadWorkspace();
      const state = saved ?? (await buildDemoWorkspace());
      if (!saved) await saveWorkspace(state);
      if (!active) return;
      setWorkspace(state);
      setSelectedCitationId(state.citations[0]?.id ?? null);
      setAnswer(
        await queryApprovedFacts({
          question: initialQuestion(),
          facts: state.facts,
          citations: state.citations,
          documents: state.documents
        })
      );
    }
    void initialize();
    return () => {
      active = false;
    };
  }, []);

  const updateWorkspace = useCallback(async (state: WorkspaceState) => {
    setWorkspace(state);
    await saveWorkspace(state);
  }, []);

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

  async function runQuery() {
    if (!workspace || question.trim().length === 0) return;
    const result = await queryApprovedFacts({
      question,
      facts: workspace.facts,
      citations: workspace.citations,
      documents: workspace.documents
    });
    setAnswer(result);
    setView("query");
    if (result.claims[0]?.citationIds[0]) {
      setSelectedCitationId(result.claims[0].citationIds[0]);
    }
  }

  async function reviewFact(factId: string, status: "approved" | "rejected") {
    if (!workspace) return;
    const next: WorkspaceState = {
      ...workspace,
      facts: workspace.facts.map((fact) =>
        fact.id === factId
          ? {
              ...fact,
              status,
              reviewer: "Alex Morgan",
              reviewedAt: new Date().toISOString()
            }
          : fact
      ),
      matter: { ...workspace.matter, updatedAt: new Date().toISOString() }
    };
    await updateWorkspace(next);
    setNotice(status === "approved" ? "Fact approved and queryable." : "Fact rejected.");
  }

  async function importFiles(files: FileList | null) {
    if (!workspace || !files || files.length === 0) return;
    setImporting(true);
    setNotice(null);
    const documents = [...workspace.documents];
    const citations = [...workspace.citations];
    const facts = [...workspace.facts];
    for (const file of Array.from(files)) {
      try {
        const document = await parseLocalFile(file);
        documents.push(document);
        if (document.processingState === "ready" && document.canonicalText.length > 0) {
          const candidate =
            document.canonicalText
              .split(/(?<=[.!?])\s+/)
              .find((sentence) => sentence.trim().length >= 30)
              ?.trim() ?? document.canonicalText.slice(0, 240).trim();
          if (candidate) {
            const citation = await createCitation({
              id: crypto.randomUUID(),
              document,
              exactQuote: candidate,
              pageNumber: document.pageCount === 1 ? 1 : null,
              structuralPath: "local-import/first-evidence-span"
            });
            citations.push(citation);
            facts.push({
              id: crypto.randomUUID(),
              matterId: workspace.matter.id,
              type: "Evidence",
              statement: candidate,
              eventDate: null,
              confidence: 0.65,
              status: "pending",
              citationIds: [citation.id],
              reviewer: null,
              reviewedAt: null
            });
          }
        }
      } catch {
        setNotice(`Could not parse ${file.name}. The original file was not transmitted.`);
      }
    }
    await updateWorkspace({
      ...workspace,
      documents,
      citations,
      facts,
      matter: { ...workspace.matter, updatedAt: new Date().toISOString() }
    });
    setImporting(false);
    setView("documents");
    setNotice(`${files.length} file${files.length === 1 ? "" : "s"} processed locally.`);
    if (folderInputRef.current) folderInputRef.current.value = "";
  }

  async function resetDemo() {
    await clearWorkspace();
    const state = await buildDemoWorkspace();
    await saveWorkspace(state);
    setWorkspace(state);
    setSelectedCitationId(state.citations[0].id);
    setQuestion(initialQuestion());
    setAnswer(
      await queryApprovedFacts({
        question: initialQuestion(),
        facts: state.facts,
        citations: state.citations,
        documents: state.documents
      })
    );
    setNotice("Local pilot data reset.");
  }

  if (!workspace) {
    return (
      <main className="loading-screen">
        <div className="brand-mark">VC</div>
        <p>Opening the private matter workspace…</p>
      </main>
    );
  }

  const citationsById = new Map(
    workspace.citations.map((citation) => [citation.id, citation])
  );
  const documentsById = new Map(
    workspace.documents.map((document) => [document.id, document])
  );

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
              onClick={() => {
                setView(id);
                setSidebarOpen(false);
              }}
            >
              <Icon size={19} strokeWidth={1.7} />
              <span>{label}</span>
              {id === "review" && pendingFacts.length > 0 ? (
                <span className="nav-count">{pendingFacts.length}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="matter-brief">
          <span className="small-label">Matter</span>
          <strong>{workspace.matter.name}</strong>
          <dl>
            <div>
              <dt>Matter ID</dt>
              <dd>{workspace.matter.id}</dd>
            </div>
            <div>
              <dt>Court</dt>
              <dd>{workspace.matter.court}</dd>
            </div>
            <div>
              <dt>Jurisdiction</dt>
              <dd>{workspace.matter.jurisdiction}</dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>{formatDate(workspace.matter.updatedAt)}</dd>
            </div>
          </dl>
        </div>
        <div className="local-boundary">
          <FolderLock size={16} />
          <span>Local evidence mode</span>
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
          <button className="matter-selector">
            {workspace.matter.name}
            <ChevronDown size={16} />
          </button>
          <div className="topbar-actions">
            <button className="icon-button" aria-label="Help">
              <CircleHelp size={19} />
            </button>
            <div className="user-block">
              <strong>Alex Morgan</strong>
              <span>Counsel</span>
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

        <div className={`content-frame ${selectedCitation ? "with-inspector" : ""}`}>
          <main className="main-content">
            {view === "overview" || view === "query" ? (
              <>
                <section className="metrics" aria-label="Matter status">
                  <Metric
                    icon={FileText}
                    label="Imported documents"
                    value={String(workspace.documents.length)}
                    detail="Stored in this browser"
                  />
                  <Metric
                    icon={ShieldCheck}
                    label="Approved facts"
                    value={String(approvedCount)}
                    detail="Queryable records"
                    tone="green"
                  />
                  <Metric
                    icon={FileCheck2}
                    label="Pending review"
                    value={String(pendingFacts.length)}
                    detail="Requires attention"
                    tone="copper"
                  />
                  <Metric
                    icon={Database}
                    label="Evidence boundary"
                    value="Local"
                    detail="Zero document egress"
                    tone="green"
                  />
                </section>

                <section className="query-panel">
                  <div className="section-title">
                    <div>
                      <span className="small-label">Ask the case</span>
                      <h1>Query only approved evidence</h1>
                    </div>
                    <span className="privacy-note">
                      <FolderLock size={14} /> Runs on this device
                    </span>
                  </div>
                  <form
                    className="query-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void runQuery();
                    }}
                  >
                    <Search size={19} aria-hidden />
                    <input
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      aria-label="Ask a question about the matter"
                    />
                    <button type="submit">Ask</button>
                  </form>
                  <p className="query-help">
                    Answers are assembled from approved records. Unsupported questions
                    return insufficient evidence.
                  </p>

                  <div className="answer-header">
                    <span className="small-label">Verified answer</span>
                    <span
                      className={`answer-status ${
                        answer?.status === "verified" ? "verified" : ""
                      }`}
                    >
                      {answer?.status === "verified" ? (
                        <>
                          <CheckCircle2 size={15} /> Evidence checks passed
                        </>
                      ) : (
                        "Insufficient evidence"
                      )}
                    </span>
                  </div>
                  {answer?.claims.length ? (
                    <div className="claim-list">
                      {answer.claims.map((claim, index) => {
                        const citation = citationsById.get(claim.citationIds[0]);
                        const document = citation
                          ? documentsById.get(citation.documentId)
                          : undefined;
                        return citation && document ? (
                          <button
                            key={claim.factId}
                            className={`claim ${
                              selectedCitationId === citation.id ? "selected" : ""
                            }`}
                            onClick={() => setSelectedCitationId(citation.id)}
                          >
                            <span className="claim-number">{index + 1}</span>
                            <span className="claim-body">
                              <span className="claim-statement">{claim.statement}</span>
                              <span className="quote">“{citation.exactQuote}”</span>
                              <span className="claim-source">
                                <span>
                                  {document.name}
                                  {citation.pageNumber
                                    ? ` · page ${citation.pageNumber}`
                                    : ""}
                                </span>
                                <span>
                                  UTF-8 bytes {citation.canonicalByteStart}–
                                  {citation.canonicalByteEnd}
                                </span>
                              </span>
                            </span>
                            <span className="byte-verified">
                              <CheckCircle2 size={16} /> Byte verified
                            </span>
                          </button>
                        ) : null;
                      })}
                    </div>
                  ) : (
                    <div className="empty-answer">
                      <ShieldCheck size={24} />
                      <strong>No verified answer is available.</strong>
                      <p>Try a narrower question or approve relevant draft facts.</p>
                    </div>
                  )}
                </section>

                <ReviewTable
                  facts={pendingFacts}
                  citations={workspace.citations}
                  documents={workspace.documents}
                  onReview={reviewFact}
                  onSelectCitation={setSelectedCitationId}
                />
              </>
            ) : null}

            {view === "documents" ? (
              <DocumentsView
                workspace={workspace}
                importing={importing}
                inputRef={folderInputRef}
                onImport={importFiles}
              />
            ) : null}

            {view === "review" ? (
              <section className="page-section">
                <div className="page-heading">
                  <div>
                    <span className="small-label">Human review gate</span>
                    <h1>Review queue</h1>
                    <p>
                      Drafts remain excluded from natural-language answers until approved.
                    </p>
                  </div>
                </div>
                <ReviewTable
                  facts={pendingFacts}
                  citations={workspace.citations}
                  documents={workspace.documents}
                  onReview={reviewFact}
                  onSelectCitation={setSelectedCitationId}
                  expanded
                />
              </section>
            ) : null}

            {view === "exports" ? (
              <ExportsView workspace={workspace} />
            ) : null}

            {view === "settings" ? (
              <SettingsView onReset={resetDemo} />
            ) : null}
          </main>

          {selectedCitation ? (
            <EvidenceInspector
              citation={selectedCitation}
              document={selectedDocument}
              fact={selectedFact}
              onClose={() => setSelectedCitationId(null)}
            />
          ) : null}
        </div>
      </section>
    </div>
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
          <span className="small-label">Review queue</span>
          <strong>{facts.length} draft {facts.length === 1 ? "fact" : "facts"}</strong>
        </div>
      </div>
      {facts.length === 0 ? (
        <div className="table-empty">
          <CheckCircle2 size={20} />
          All draft facts have been reviewed.
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Fact</th>
                <th>Type</th>
                <th>Source</th>
                <th>Confidence</th>
                <th>Review action</th>
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
                      <div className="confidence">
                        <span>{Math.round(fact.confidence * 100)}%</span>
                        <div>
                          <i style={{ width: `${fact.confidence * 100}%` }} />
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="review-actions">
                        <button onClick={() => void onReview(fact.id, "approved")}>
                          Approve
                        </button>
                        <button
                          className="reject"
                          onClick={() => void onReview(fact.id, "rejected")}
                          aria-label={`Reject ${fact.statement}`}
                        >
                          <X size={15} />
                        </button>
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
  inputRef,
  onImport
}: {
  workspace: WorkspaceState;
  importing: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onImport: (files: FileList | null) => Promise<void>;
}) {
  return (
    <section className="page-section">
      <div className="page-heading">
        <div>
          <span className="small-label">Private evidence storage</span>
          <h1>Documents</h1>
          <p>
            Files are parsed and stored in this browser. No file upload request is
            made to Vercel or an LLM.
          </p>
        </div>
        <button
          className="primary-button"
          onClick={() => inputRef.current?.click()}
          disabled={importing}
        >
          <Upload size={17} />
          {importing ? "Processing locally…" : "Add folder or files"}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="visually-hidden"
          onChange={(event) => void onImport(event.target.files)}
          // React does not type the non-standard directory picker attribute.
          {...({ webkitdirectory: "" } as Record<string, string>)}
        />
      </div>
      <div className="privacy-banner">
        <FolderLock size={22} />
        <div>
          <strong>Zero document egress is enforced by design.</strong>
          <p>
            Native PDF, DOCX, TXT, EML, and MSG parsing runs locally. Image-only
            files are marked as needing protected OCR.
          </p>
        </div>
      </div>
      <div className="document-list">
        <div className="document-list-head">
          <span>Document</span>
          <span>Evidence state</span>
          <span>Canonical artifact</span>
          <span>Ingested</span>
        </div>
        {workspace.documents.map((document) => (
          <article className="document-row" key={document.id}>
            <div className="document-name">
              <FileText size={19} />
              <div>
                <strong>{document.name}</strong>
                <span>
                  {(document.size / 1024).toFixed(1)} KB · {document.pageCount}{" "}
                  {document.pageCount === 1 ? "page" : "pages"}
                </span>
              </div>
            </div>
            <span className={`state ${document.processingState}`}>
              {document.processingState === "ready"
                ? "Ready"
                : document.processingState === "needs-ocr"
                  ? "Protected OCR required"
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

function ExportsView({ workspace }: { workspace: WorkspaceState }) {
  const args = [workspace.facts, workspace.citations, workspace.documents] as const;
  const formats = [
    {
      label: "CSV",
      description: "Flat, source-linked table for review and analysis.",
      action: () => exportCsv(...args)
    },
    {
      label: "XLSX",
      description: "Approved facts in an Excel-compatible workbook.",
      action: () => void exportXlsx(...args)
    },
    {
      label: "JSON",
      description: "Structured records with exact citation metadata.",
      action: () => exportJson(...args)
    },
    {
      label: "DOCX",
      description: "Cited narrative list for legal work product.",
      action: () => void exportDocx(...args)
    }
  ];
  return (
    <section className="page-section">
      <div className="page-heading">
        <div>
          <span className="small-label">Approved records only</span>
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
            <button onClick={format.action}>
              <Download size={16} /> Download
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function SettingsView({ onReset }: { onReset: () => Promise<void> }) {
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
          value="Browser-local IndexedDB"
          detail="Source bytes and canonical artifacts never leave this device."
        />
        <SettingRow
          icon={ShieldCheck}
          title="Natural-language query"
          value="Deterministic local retrieval"
          detail="Only approved facts with verified citations can be returned."
        />
        <SettingRow
          icon={Gavel}
          title="Protected PHI mode"
          value="Disabled"
          detail="Requires executed BAAs and a separately reviewed production environment."
        />
      </div>
      <button className="secondary-button reset-button" onClick={() => void onReset()}>
        <RotateCcw size={16} /> Reset local pilot data
      </button>
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
  onClose
}: {
  citation: Citation;
  document: WorkspaceState["documents"][number] | null;
  fact: FactRecord | null;
  onClose: () => void;
}) {
  const [verification, setVerification] = useState<"checking" | "verified" | "failed">(
    "checking"
  );
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
      <div className="inspector-quote">“{citation.exactQuote}”</div>
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
      <InspectorField label="Parser version" value={citation.parserVersion} />
      <InspectorField
        label="Reviewer"
        value={fact?.reviewer ?? "Pending human review"}
        supporting={
          fact?.reviewedAt ? `Reviewed ${formatDate(fact.reviewedAt)}` : undefined
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
              ? "Exact match to immutable canonical bytes"
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
