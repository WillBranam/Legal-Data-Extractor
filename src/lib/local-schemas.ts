import { z } from "zod";

const factTypeSchema = z.enum([
  "Event",
  "Entity",
  "Communication",
  "Allegation",
  "Evidence",
  "Damages"
]);

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
  pages: z.array(evidencePageSchema).max(500),
  processingDurationMs: z.number().nonnegative(),
  ocrPageCount: z.number().int().nonnegative(),
  ocrMeanConfidence: z.number().min(0).max(100).nullable(),
  ingestedAt: z.string().min(1).max(64),
  processingState: z.enum(["ready", "needs-ocr", "ocr-failed", "unsupported"])
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

export const workspaceStateSchema = z.object({
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
  documents: z.array(evidenceDocumentSchema).max(200),
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
  ).max(100_000)
});
