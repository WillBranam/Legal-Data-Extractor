export type ReviewStatus = "approved" | "pending" | "rejected";
export type InformationStatus = "verified" | "exception" | "withheld";
export type FieldCategory =
  | "matter"
  | "client"
  | "party"
  | "organization"
  | "representative"
  | "identifier"
  | "contact"
  | "date"
  | "signature"
  | "document"
  | "administrative"
  | "relationship"
  | "other";
export type FieldValueType =
  | "text"
  | "name"
  | "identifier"
  | "phone"
  | "email"
  | "address"
  | "date"
  | "datetime"
  | "money"
  | "number"
  | "boolean";
export type EntityType = "person" | "organization" | "firm" | "court" | "unknown";
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
  documentType?: string;
  detectedLanguage?: "en" | "es" | "unknown";
  matterMatchStatus?: "matched" | "review" | "quarantined" | "excluded";
  matterMatchReason?: string | null;
  extractionState?: "not-started" | "processing" | "complete" | "failed";
  extractionError?: string | null;
  extractedAt?: string | null;
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

export interface FieldDefinition {
  id: string;
  canonicalKey: string;
  displayLabel: string;
  category: FieldCategory;
  valueType: FieldValueType;
  repeatable: boolean;
  subjectType: "matter" | "person" | "organization" | "document" | "any";
  sensitivity: "standard" | "confidential" | "restricted-identifier";
  normalizationRule: string;
  sourceLabels: string[];
  schemaVersion: 2;
  enabled: boolean;
  dynamic: boolean;
}

export interface FieldOccurrence {
  id: string;
  fieldDefinitionId: string;
  subjectEntityId: string | null;
  documentId: string;
  rawValue: string;
  normalizedValue: string;
  valueType: FieldValueType;
  language: "en" | "es" | "unknown";
  citationIds: string[];
  pageNumber: number | null;
  boundingBox: string | null;
  extractionConfidence: number;
  normalizationConfidence: number;
  status: InformationStatus;
  exceptionReason: string | null;
  sourceLabel: string;
}

export interface CanonicalValue {
  id: string;
  fieldDefinitionId: string;
  subjectEntityId: string | null;
  normalizedValue: string;
  occurrenceIds: string[];
  resolutionStatus: "verified" | "conflict" | "withheld";
  conflictGroupId: string | null;
}

export interface Entity {
  id: string;
  type: EntityType;
  canonicalName: string;
  nameVariants: string[];
}

export interface Relationship {
  id: string;
  sourceEntityId: string;
  relationshipType: string;
  targetEntityId: string;
  occurrenceIds: string[];
  status: InformationStatus;
}

export interface SignatureObservation {
  id: string;
  documentId: string;
  status: "signature-mark-detected" | "unsigned" | "unclear";
  signerEntityId: string | null;
  rawSignerName: string | null;
  capacity: string | null;
  signatureDate: string | null;
  signatureType: "handwritten-mark" | "electronic" | "typed" | "initials" | "unknown";
  pageNumber: number;
  boundingBox: string | null;
  pageImageSha256: string | null;
  regionSha256: string | null;
  nearbyTextCitationIds: string[];
  detectorVersion: string;
  confidence: number;
  reviewStatus: InformationStatus;
}

export interface ExtractionSpecification {
  version: 2;
  fieldDefinitionIds: string[];
  customInstructions: string;
  detectedDocumentTypes: string[];
  detectedLanguages: Array<"en" | "es" | "unknown">;
  confirmedAt: string | null;
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
  schemaVersion?: 1 | 2;
  matter: Matter;
  documents: EvidenceDocument[];
  citations: Citation[];
  facts: FactRecord[];
  reviewDecisions: ReviewDecision[];
  fieldDefinitions?: FieldDefinition[];
  fieldOccurrences?: FieldOccurrence[];
  canonicalValues?: CanonicalValue[];
  entities?: Entity[];
  relationships?: Relationship[];
  signatures?: SignatureObservation[];
  extractionSpecification?: ExtractionSpecification | null;
  legacyFacts?: FactRecord[];
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

export interface InformationAnswerItem {
  occurrenceId: string;
  label: string;
  normalizedValue: string;
  rawValue: string;
  subject: string | null;
  category: FieldCategory;
  documentId: string;
  citationIds: string[];
  score: number;
}

export interface InformationQueryAnswer {
  status: "verified" | "partial" | "insufficient_information";
  question: string;
  items: InformationAnswerItem[];
}
