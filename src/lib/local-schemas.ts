import { z } from "zod";

const factTypeSchema = z.enum([
  "Event",
  "Entity",
  "Communication",
  "Allegation",
  "Evidence",
  "Damages"
]);
const informationStatusSchema = z.enum(["verified", "exception", "withheld"]);
const fieldCategorySchema = z.enum(["matter", "client", "party", "organization", "representative", "identifier", "contact", "date", "signature", "document", "administrative", "relationship", "other"]);
const fieldValueTypeSchema = z.enum(["text", "name", "identifier", "phone", "email", "address", "date", "datetime", "money", "number", "boolean"]);

const evidencePageSchema = z.object({
  pageNumber: z.number().int().positive(),
  extractionMethod: z.enum(["native-text", "ocr"]),
  canonicalByteStart: z.number().int().nonnegative(),
  canonicalByteEnd: z.number().int().nonnegative(),
  width: z.number().nonnegative().nullable(),
  height: z.number().nonnegative().nullable(),
  imageSha256: z.string().nullable(),
  ocrConfidence: z.number().min(0).max(100).nullable()
});

export const evidenceDocumentSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(1024),
  mediaType: z.string().max(255),
  size: z.number().int().nonnegative(),
  originalSha256: z.string().length(64),
  canonicalSha256: z.string().length(64),
  canonicalText: z.string(),
  canonicalByteLength: z.number().int().nonnegative(),
  parserVersion: z.string().min(1).max(255),
  pageCount: z.number().int().nonnegative(),
  pages: z.array(evidencePageSchema).max(10_000),
  processingDurationMs: z.number().nonnegative(),
  ocrPageCount: z.number().int().nonnegative(),
  ocrMeanConfidence: z.number().min(0).max(100).nullable(),
  ingestedAt: z.string().min(1).max(64),
  processingState: z.enum(["ready", "needs-ocr", "ocr-failed", "unsupported"]),
  documentType: z.string().max(255).optional(),
  detectedLanguage: z.enum(["en", "es", "unknown"]).optional(),
  matterMatchStatus: z.enum(["matched", "review", "quarantined", "excluded"]).optional(),
  matterMatchReason: z.string().max(2000).nullable().optional(),
  extractionState: z.enum(["not-started", "processing", "complete", "failed"]).optional(),
  extractionError: z.string().max(2000).nullable().optional(),
  extractedAt: z.string().max(64).nullable().optional()
});

const citationSchema = z.object({
  id: z.string().min(1).max(100),
  documentId: z.string().min(1).max(100),
  originalFileSha256: z.string().length(64),
  canonicalArtifactSha256: z.string().length(64),
  canonicalByteStart: z.number().int().nonnegative(),
  canonicalByteEnd: z.number().int().nonnegative(),
  exactQuote: z.string(),
  pageNumber: z.number().int().positive().nullable(),
  structuralPath: z.string().max(1024).nullable(),
  parserVersion: z.string().min(1).max(255)
});

export const factRecordSchema = z.object({
  id: z.string().min(1).max(100),
  matterId: z.string().min(1).max(100),
  type: factTypeSchema,
  statement: z.string().min(1).max(5000),
  eventDate: z.string().max(64).nullable(),
  confidence: z.number().min(0).max(1),
  status: z.enum(["approved", "pending", "rejected"]),
  citationIds: z.array(z.string().min(1).max(100)).max(100),
  reviewer: z.string().max(80).nullable(),
  reviewedAt: z.string().max(64).nullable()
});

export const fieldDefinitionSchema = z.object({
  id: z.string().min(1).max(100), canonicalKey: z.string().min(1).max(200), displayLabel: z.string().min(1).max(255),
  category: fieldCategorySchema, valueType: fieldValueTypeSchema, repeatable: z.boolean(),
  subjectType: z.enum(["matter", "person", "organization", "document", "any"]),
  sensitivity: z.enum(["standard", "confidential", "restricted-identifier"]), normalizationRule: z.string().max(100),
  sourceLabels: z.array(z.string().max(255)).max(100), schemaVersion: z.literal(2), enabled: z.boolean(), dynamic: z.boolean()
});

export const workspaceStateSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  matter: z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(1000),
    court: z.string().max(1000),
    jurisdiction: z.string().max(1000),
    updatedAt: z.string().min(1).max(64),
    legalHold: z.boolean(),
    retentionPolicy: z.object({
      mode: z.enum(["manual", "retain-until"]),
      retainUntil: z.string().max(64).nullable()
    })
  }),
  documents: z.array(evidenceDocumentSchema).max(10_000),
  citations: z.array(citationSchema).max(100_000),
  facts: z.array(factRecordSchema).max(100_000),
  reviewDecisions: z.array(
    z.object({
      id: z.string().min(1).max(100),
      factId: z.string().min(1).max(100),
      reviewer: z.string().min(1).max(80),
      decision: z.enum(["approved", "rejected"]),
      priorStatus: z.enum(["approved", "pending", "rejected"]),
      occurredAt: z.string().min(1).max(64)
    })
  ).max(100_000),
  fieldDefinitions: z.array(fieldDefinitionSchema).max(10_000).optional(),
  fieldOccurrences: z.array(z.object({
    id: z.string().min(1).max(100), fieldDefinitionId: z.string().min(1).max(100), subjectEntityId: z.string().max(100).nullable(),
    documentId: z.string().min(1).max(100), rawValue: z.string().max(10_000), normalizedValue: z.string().max(10_000), valueType: fieldValueTypeSchema,
    language: z.enum(["en", "es", "unknown"]), citationIds: z.array(z.string().max(100)).max(100), pageNumber: z.number().int().positive().nullable(),
    boundingBox: z.string().max(1024).nullable(), extractionConfidence: z.number().min(0).max(1), normalizationConfidence: z.number().min(0).max(1),
    status: informationStatusSchema, exceptionReason: z.string().max(5000).nullable(), sourceLabel: z.string().max(500), decidedByUser: z.boolean().optional()
  })).max(500_000).optional(),
  canonicalValues: z.array(z.object({
    id: z.string().min(1).max(100), fieldDefinitionId: z.string().min(1).max(100), subjectEntityId: z.string().max(100).nullable(),
    normalizedValue: z.string().max(10_000), occurrenceIds: z.array(z.string().max(100)).max(10_000),
    resolutionStatus: z.enum(["verified", "conflict", "withheld"]), conflictGroupId: z.string().max(100).nullable()
  })).max(500_000).optional(),
  entities: z.array(z.object({ id: z.string().min(1).max(100), type: z.enum(["person", "organization", "firm", "court", "unknown"]), canonicalName: z.string().max(1000), nameVariants: z.array(z.string().max(1000)).max(1000) })).max(200_000).optional(),
  relationships: z.array(z.object({ id: z.string().min(1).max(100), sourceEntityId: z.string().min(1).max(100), relationshipType: z.string().max(255), targetEntityId: z.string().min(1).max(100), occurrenceIds: z.array(z.string().max(100)).max(10_000), status: informationStatusSchema })).max(200_000).optional(),
  signatures: z.array(z.object({
    id: z.string().min(1).max(100), documentId: z.string().min(1).max(100), status: z.enum(["signature-mark-detected", "unsigned", "unclear"]), signerEntityId: z.string().max(100).nullable(), rawSignerName: z.string().max(1000).nullable(), capacity: z.string().max(1000).nullable(), signatureDate: z.string().max(100).nullable(), signatureType: z.enum(["handwritten-mark", "electronic", "typed", "initials", "unknown"]), pageNumber: z.number().int().positive(), boundingBox: z.string().max(1024).nullable(), pageImageSha256: z.string().length(64).nullable(), regionSha256: z.string().length(64).nullable(), nearbyTextCitationIds: z.array(z.string().max(100)).max(100), detectorVersion: z.string().max(255), confidence: z.number().min(0).max(1), reviewStatus: informationStatusSchema
  })).max(100_000).optional(),
  extractionSpecification: z.object({ version: z.literal(2), fieldDefinitionIds: z.array(z.string().max(100)).max(10_000), customInstructions: z.string().max(10_000), detectedDocumentTypes: z.array(z.string().max(255)).max(1000), detectedLanguages: z.array(z.enum(["en", "es", "unknown"])).max(1000), confirmedAt: z.string().max(64).nullable() }).nullable().optional(),
  legacyFacts: z.array(factRecordSchema).max(100_000).optional()
});
