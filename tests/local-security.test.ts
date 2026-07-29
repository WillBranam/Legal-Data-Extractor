import { describe, expect, it } from "vitest";
import { buildApprovedExportRows, spreadsheetSafeText } from "@/lib/exports";
import {
  validatedLocalModelEndpoint,
  validatedLocalModelName
} from "@/lib/local-llm";
import { createEmptyWorkspace } from "@/lib/workspace";

describe("offline security boundaries", () => {
  it("accepts only HTTP loopback model endpoints", () => {
    expect(validatedLocalModelEndpoint("http://127.0.0.1:11434").origin).toBe(
      "http://127.0.0.1:11434"
    );
    expect(validatedLocalModelEndpoint("http://localhost:11434").hostname).toBe(
      "localhost"
    );
    expect(() =>
      validatedLocalModelEndpoint("https://api.example.com")
    ).toThrow("LOCAL_MODEL_MUST_USE_LOOPBACK");
    expect(() =>
      validatedLocalModelEndpoint("http://192.168.1.20:11434")
    ).toThrow("LOCAL_MODEL_MUST_USE_LOOPBACK");
  });

  it("rejects cloud-capable or malformed model identifiers", () => {
    expect(validatedLocalModelName("qwen3:8b")).toBe("qwen3:8b");
    expect(() => validatedLocalModelName("gpt-oss:cloud")).toThrow(
      "LOCAL_MODEL_NAME_REQUIRED"
    );
    expect(() => validatedLocalModelName("https://provider.example/model")).toThrow(
      "LOCAL_MODEL_NAME_REQUIRED"
    );
  });

  it("neutralizes spreadsheet formulas while preserving ordinary evidence", () => {
    expect(spreadsheetSafeText("=HYPERLINK(\"https://example.test\")")).toBe(
      "'=HYPERLINK(\"https://example.test\")"
    );
    expect(spreadsheetSafeText("  +1+1")).toBe("'  +1+1");
    expect(spreadsheetSafeText("\t@SUM(A1:A2)")).toBe("'\t@SUM(A1:A2)");
    expect(spreadsheetSafeText("Ordinary source text")).toBe("Ordinary source text");
  });

  it("excludes approved exports whose citation integrity is tampered", () => {
    const workspace = createEmptyWorkspace(new Date("2026-01-01T00:00:00Z"));
    const document = {
      id: "document-123456",
      name: "Evidence.txt",
      mediaType: "text/plain",
      size: 8,
      originalSha256: "a".repeat(64),
      canonicalSha256: "b".repeat(64),
      canonicalText: "Evidence",
      canonicalByteLength: 8,
      parserVersion: "test",
      pageCount: 1,
      pages: [],
      processingDurationMs: 1,
      ocrPageCount: 0,
      ocrMeanConfidence: null,
      ingestedAt: "2026-01-01T00:00:00Z",
      processingState: "ready" as const
    };
    const citation = {
      id: "citation-123456",
      documentId: document.id,
      originalFileSha256: document.originalSha256,
      canonicalArtifactSha256: "c".repeat(64),
      canonicalByteStart: 0,
      canonicalByteEnd: 8,
      exactQuote: "Evidence",
      pageNumber: 1,
      structuralPath: null,
      parserVersion: "test"
    };
    const fact = {
      id: "fact-123456",
      matterId: workspace.matter.id,
      type: "Evidence" as const,
      statement: "Evidence",
      eventDate: null,
      confidence: 1,
      status: "approved" as const,
      citationIds: [citation.id],
      reviewer: "Reviewer",
      reviewedAt: "2026-01-01T00:00:00Z"
    };
    expect(buildApprovedExportRows([fact], [citation], [document])).toEqual([]);
  });
});
