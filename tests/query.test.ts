import { describe, expect, it } from "vitest";
import {
  createCitation,
  sha256Bytes,
  sha256Text,
  utf8ByteLength
} from "@/lib/evidence";
import { queryApprovedFacts } from "@/lib/query";
import type {
  EvidenceDocument,
  FactRecord,
  WorkspaceState
} from "@/lib/types";

async function testWorkspace(): Promise<WorkspaceState> {
  const canonicalText = [
    "[Page 1]",
    "The approved event occurred on March 1, 2025.",
    "",
    "A separate unapproved event occurred on March 4, 2025."
  ].join("\n");
  const bytes = new TextEncoder().encode(canonicalText);
  const document: EvidenceDocument = {
    id: "test-document",
    name: "test-source.txt",
    mediaType: "text/plain",
    size: bytes.byteLength,
    originalSha256: await sha256Bytes(bytes),
    canonicalSha256: await sha256Text(canonicalText),
    canonicalText,
    canonicalByteLength: utf8ByteLength(canonicalText),
    parserVersion: "test",
    pageCount: 1,
    pages: [],
    processingDurationMs: 1,
    ocrPageCount: 0,
    ocrMeanConfidence: null,
    ingestedAt: "2025-01-01T00:00:00Z",
    processingState: "ready"
  };
  const approvedCitation = await createCitation({
    id: "approved-citation",
    document,
    exactQuote: "The approved event occurred on March 1, 2025.",
    pageNumber: 1
  });
  const pendingCitation = await createCitation({
    id: "pending-citation",
    document,
    exactQuote: "A separate unapproved event occurred on March 4, 2025.",
    pageNumber: 1
  });
  const facts: FactRecord[] = [
    {
      id: "approved-fact",
      matterId: "test-matter",
      type: "Event",
      statement: "The approved event occurred on March 1, 2025.",
      eventDate: "2025-03-01",
      confidence: 0.98,
      status: "approved",
      citationIds: [approvedCitation.id],
      reviewer: "Test reviewer",
      reviewedAt: "2025-01-01T00:00:00Z"
    },
    {
      id: "pending-fact",
      matterId: "test-matter",
      type: "Event",
      statement: "A separate unapproved event occurred on March 4, 2025.",
      eventDate: "2025-03-04",
      confidence: 0.9,
      status: "pending",
      citationIds: [pendingCitation.id],
      reviewer: null,
      reviewedAt: null
    }
  ];
  return {
    matter: {
      id: "test-matter",
      name: "Test matter",
      court: "Test court",
      jurisdiction: "Test jurisdiction",
      updatedAt: "2025-01-01T00:00:00Z",
      legalHold: false,
      retentionPolicy: {
        mode: "manual",
        retainUntil: null
      }
    },
    documents: [document],
    citations: [approvedCitation, pendingCitation],
    facts,
    reviewDecisions: []
  };
}

describe("approved-only natural-language query", () => {
  it("returns only approved facts with verified citations", async () => {
    const workspace = await testWorkspace();
    const answer = await queryApprovedFacts({
      question: "What event occurred in March 2025?",
      facts: workspace.facts,
      citations: workspace.citations,
      documents: workspace.documents
    });
    expect(answer.status).toBe("verified");
    expect(answer.claims).toHaveLength(1);
    expect(answer.claims[0].factId).toBe("approved-fact");
  });

  it("abstains when no approved evidence matches", async () => {
    const workspace = await testWorkspace();
    const answer = await queryApprovedFacts({
      question: "What did the witness say about a red vehicle in 2038?",
      facts: workspace.facts,
      citations: workspace.citations,
      documents: workspace.documents
    });
    expect(answer.status).toBe("insufficient_evidence");
    expect(answer.claims).toEqual([]);
  });
});
