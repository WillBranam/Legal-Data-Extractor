export type ReviewStatus = "approved" | "pending" | "rejected";
export type FactType =
  | "Event"
  | "Entity"
  | "Communication"
  | "Allegation"
  | "Evidence"
  | "Damages";

export interface Matter {
  id: string;
  name: string;
  court: string;
  jurisdiction: string;
  updatedAt: string;
  legalHold: boolean;
  retentionPolicy: {
    mode: "manual" | "retain-until";
    retainUntil: string | null;
  };
}

export interface EvidenceDocument {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  originalSha256: string;
  canonicalSha256: string;
  canonicalText: string;
  canonicalByteLength: number;
  parserVersion: string;
  pageCount: number;
  pages: EvidencePageArtifact[];
  processingDurationMs: number;
  ocrPageCount: number;
  ocrMeanConfidence: number | null;
  ingestedAt: string;
  processingState: "ready" | "needs-ocr" | "ocr-failed" | "unsupported";
}

export interface EvidencePageArtifact {
  pageNumber: number;
  extractionMethod: "native-text" | "ocr";
  canonicalByteStart: number;
  canonicalByteEnd: number;
  width: number | null;
  height: number | null;
  imageSha256: string | null;
  ocrConfidence: number | null;
}

export interface Citation {
  id: string;
  documentId: string;
  originalFileSha256: string;
  canonicalArtifactSha256: string;
  canonicalByteStart: number;
  canonicalByteEnd: number;
  exactQuote: string;
  pageNumber: number | null;
  structuralPath: string | null;
  parserVersion: string;
}

export interface FactRecord {
  id: string;
  matterId: string;
  type: FactType;
  statement: string;
  eventDate: string | null;
  confidence: number;
  status: ReviewStatus;
  citationIds: string[];
  reviewer: string | null;
  reviewedAt: string | null;
}

export interface ReviewDecision {
  id: string;
  factId: string;
  reviewer: string;
  decision: "approved" | "rejected";
  priorStatus: ReviewStatus;
  occurredAt: string;
}

export interface WorkspaceState {
  matter: Matter;
  documents: EvidenceDocument[];
  citations: Citation[];
  facts: FactRecord[];
  reviewDecisions: ReviewDecision[];
}

export interface VerificationResult {
  verified: boolean;
  reason:
    | "verified"
    | "document-not-found"
    | "hash-mismatch"
    | "range-invalid"
    | "quote-mismatch";
  exactQuote?: string;
}

export interface AnswerClaim {
  factId: string;
  statement: string;
  citationIds: string[];
  score: number;
}

export interface QueryAnswer {
  status: "verified" | "partial" | "insufficient_evidence";
  question: string;
  claims: AnswerClaim[];
}
