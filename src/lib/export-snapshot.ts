import { createHash } from "node:crypto";
import { readCanonicalByteRange, readCitationContext } from "@/lib/evidence";
import type {
  Citation, Entity, EvidenceDocument, FieldDefinition, FieldOccurrence,
  Relationship, SignatureObservation, WorkspaceState
} from "@/lib/types";

export type ExportStatus = "final" | "partial";
export interface SnapshotDocument extends Omit<EvidenceDocument, "pages"> {
  versionId: string; sourceRelativePath: string; canonicalRelativePath: string;
}
export interface SnapshotCitation extends Citation {
  displayId: string; documentName: string; sourceRelativePath: string;
  contextBefore: string; contextAfter: string; extractionMethod: "native-text" | "ocr" | "unknown";
  ocrConfidence: number | null; verificationStatus: "exact-byte-match";
}
export interface SnapshotOccurrence extends FieldOccurrence {
  fieldKey: string; fieldLabel: string; category: FieldDefinition["category"];
  sensitivity: FieldDefinition["sensitivity"]; subjectName: string | null;
  documentName: string; sourceRelativePath: string; citationDisplayIds: string[];
}
export interface SnapshotException { id: string; category: "document" | "field" | "signature" | "citation"; resourceId: string; status: string; reason: string; }
export interface ExportSnapshot {
  id: string; schemaVersion: 2; generatedAt: string; status: ExportStatus;
  matter: WorkspaceState["matter"]; documents: SnapshotDocument[];
  fieldDefinitions: FieldDefinition[]; occurrences: SnapshotOccurrence[];
  canonicalValues: NonNullable<WorkspaceState["canonicalValues"]>;
  entities: Entity[]; relationships: Relationship[]; signatures: SignatureObservation[];
  citations: SnapshotCitation[]; exceptions: SnapshotException[];
  coverage: { totalDocuments: number; readyDocuments: number; quarantinedDocuments: number; failedDocuments: number; totalPages: number; ocrPages: number; verifiedValues: number; exceptionValues: number; withheldValues: number; };
  contentSha256: string;
}

export function safeExportName(value: string): string {
  return value.normalize("NFKC").replaceAll(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replaceAll(/\s+/g, " ").trim().replaceAll(/^\.+|\.+$/g, "").slice(0, 160) || "document";
}
function sourcePath(document: EvidenceDocument): string { return `sources/${document.id}-${safeExportName(document.name)}`; }
function canonicalPath(document: EvidenceDocument): string { return `canonical/${document.id}.txt`; }

function verifyCitation(citation: Citation, document: EvidenceDocument, displayId: string): SnapshotCitation | null {
  if (citation.originalFileSha256 !== document.originalSha256 || citation.canonicalArtifactSha256 !== document.canonicalSha256) return null;
  let exact: string;
  try { exact = readCanonicalByteRange(document.canonicalText, citation.canonicalByteStart, citation.canonicalByteEnd); } catch { return null; }
  if (exact !== citation.exactQuote) return null;
  const context = readCitationContext(document.canonicalText, citation.canonicalByteStart, citation.canonicalByteEnd, 320);
  const page = document.pages.find((item) => item.pageNumber === citation.pageNumber);
  return { ...citation, displayId, documentName: document.name, sourceRelativePath: sourcePath(document), contextBefore: context.before, contextAfter: context.after, extractionMethod: page?.extractionMethod ?? "unknown", ocrConfidence: page?.ocrConfidence ?? null, verificationStatus: "exact-byte-match" };
}

export function createExportSnapshot(workspace: WorkspaceState, status: ExportStatus = "final", now = new Date()): ExportSnapshot {
  if (status === "final" && workspace.documents.some((item) => item.processingState === "needs-ocr")) {
    throw new Error("FINAL_EXPORT_REQUIRES_TERMINAL_DOCUMENT_STATES");
  }
  const documentMap = new Map(workspace.documents.map((item) => [item.id, item]));
  const definitions = new Map((workspace.fieldDefinitions ?? []).map((item) => [item.id, item]));
  const entities = new Map((workspace.entities ?? []).map((item) => [item.id, item]));
  const exceptions: SnapshotException[] = [];
  const addException = (entry: Omit<SnapshotException, "id">) => exceptions.push({ id: `EXC-${String(exceptions.length + 1).padStart(5, "0")}`, ...entry });
  const citations: SnapshotCitation[] = [];
  const citationMap = new Map<string, SnapshotCitation>();
  [...workspace.citations].sort((a, b) => a.id.localeCompare(b.id)).forEach((citation, index) => {
    const document = documentMap.get(citation.documentId);
    const verified = document ? verifyCitation(citation, document, `CIT-${String(index + 1).padStart(5, "0")}`) : null;
    if (verified) { citations.push(verified); citationMap.set(verified.id, verified); }
    else addException({ category: "citation", resourceId: citation.id, status: "excluded", reason: document ? "Citation failed hash or exact UTF-8 byte verification." : "Source document is missing." });
  });
  const occurrences: SnapshotOccurrence[] = [];
  for (const occurrence of workspace.fieldOccurrences ?? []) {
    const definition = definitions.get(occurrence.fieldDefinitionId);
    const document = documentMap.get(occurrence.documentId);
    if (!definition || !document) { addException({ category: "field", resourceId: occurrence.id, status: "excluded", reason: "Field definition or source document is missing." }); continue; }
    if (document.matterMatchStatus === "quarantined" || document.matterMatchStatus === "excluded") continue;
    if (occurrence.status !== "verified") { addException({ category: "field", resourceId: occurrence.id, status: occurrence.status, reason: occurrence.exceptionReason ?? "Value is unresolved or withheld." }); continue; }
    const verifiedIds = occurrence.citationIds.filter((id) => citationMap.has(id));
    if (!verifiedIds.length) { addException({ category: "field", resourceId: occurrence.id, status: "excluded", reason: "Published value has no verified exact-source citation." }); continue; }
    occurrences.push({ ...occurrence, fieldKey: definition.canonicalKey, fieldLabel: definition.displayLabel, category: definition.category, sensitivity: definition.sensitivity, subjectName: occurrence.subjectEntityId ? entities.get(occurrence.subjectEntityId)?.canonicalName ?? null : null, documentName: document.name, sourceRelativePath: sourcePath(document), citationDisplayIds: verifiedIds.map((id) => citationMap.get(id)!.displayId) });
  }
  for (const document of workspace.documents) if (document.matterMatchStatus === "quarantined" || document.matterMatchStatus === "excluded" || document.matterMatchStatus === "review") addException({ category: "document", resourceId: document.id, status: document.matterMatchStatus, reason: document.matterMatchReason ?? "Document matter membership requires review." });
  for (const signature of workspace.signatures ?? []) if (signature.reviewStatus !== "verified") addException({ category: "signature", resourceId: signature.id, status: signature.reviewStatus, reason: "Signature presence or signer details require review. No authenticity determination was made." });
  const documents = workspace.documents.map((document): SnapshotDocument => {
    const { pages: _pages, ...withoutPages } = document;
    void _pages;
    return { ...withoutPages, versionId: `${document.id}:${document.originalSha256.slice(0, 12)}`, sourceRelativePath: sourcePath(document), canonicalRelativePath: canonicalPath(document) };
  });
  const base = { id: "", schemaVersion: 2 as const, generatedAt: now.toISOString(), status, matter: workspace.matter, documents, fieldDefinitions: workspace.fieldDefinitions ?? [], occurrences, canonicalValues: (workspace.canonicalValues ?? []).filter((item) => item.resolutionStatus === "verified"), entities: workspace.entities ?? [], relationships: (workspace.relationships ?? []).filter((item) => item.status === "verified"), signatures: (workspace.signatures ?? []).filter((item) => item.reviewStatus === "verified"), citations, exceptions, coverage: { totalDocuments: workspace.documents.length, readyDocuments: workspace.documents.filter((item) => item.processingState === "ready").length, quarantinedDocuments: workspace.documents.filter((item) => item.matterMatchStatus === "quarantined").length, failedDocuments: workspace.documents.filter((item) => item.processingState === "ocr-failed" || item.processingState === "unsupported").length, totalPages: workspace.documents.reduce((sum, item) => sum + item.pageCount, 0), ocrPages: workspace.documents.reduce((sum, item) => sum + item.ocrPageCount, 0), verifiedValues: occurrences.length, exceptionValues: (workspace.fieldOccurrences ?? []).filter((item) => item.status === "exception").length, withheldValues: (workspace.fieldOccurrences ?? []).filter((item) => item.status === "withheld").length }, contentSha256: "" };
  const contentSha256 = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  return { ...base, id: `SNAP-${contentSha256.slice(0, 20).toUpperCase()}`, contentSha256 };
}

export function snapshotOccurrenceCounts(snapshot: ExportSnapshot): Record<string, number> {
  return snapshot.occurrences.reduce<Record<string, number>>((counts, item) => { counts[item.category] = (counts[item.category] ?? 0) + 1; return counts; }, {});
}
