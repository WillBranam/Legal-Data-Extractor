import { describe, expect, it } from "vitest";
import { readCanonicalByteRange } from "@/lib/evidence";
import {
  buildCanonicalArtifact,
  needsOcr,
  normalizedText
} from "@/lib/parsers";

describe("local parser evidence artifacts", () => {
  it("detects pages that need OCR without OCRing normal native text", () => {
    expect(needsOcr("")).toBe(true);
    expect(needsOcr("  page 1  ")).toBe(true);
    expect(
      needsOcr("This native PDF page contains enough text for direct extraction.")
    ).toBe(false);
  });

  it("normalizes line endings without changing internal source text", () => {
    expect(normalizedText("Evidence  \r\nSecond line\t\r\n")).toBe(
      "Evidence\nSecond line"
    );
  });

  it("constructs reproducible UTF-8 page ranges for OCR text", () => {
    const artifact = buildCanonicalArtifact([
      {
        pageNumber: 1,
        text: "First page — café.",
        extractionMethod: "ocr",
        width: 1200,
        height: 1600,
        imageSha256: "image-hash",
        ocrConfidence: 0.94
      },
      {
        pageNumber: 2,
        text: "Second page evidence.",
        extractionMethod: "native-text",
        width: 600,
        height: 800,
        imageSha256: null,
        ocrConfidence: null
      }
    ]);

    expect(
      readCanonicalByteRange(
        artifact.canonicalText,
        artifact.pageArtifacts[0].canonicalByteStart,
        artifact.pageArtifacts[0].canonicalByteEnd
      )
    ).toBe("First page — café.");
    expect(
      readCanonicalByteRange(
        artifact.canonicalText,
        artifact.pageArtifacts[1].canonicalByteStart,
        artifact.pageArtifacts[1].canonicalByteEnd
      )
    ).toBe("Second page evidence.");
  });
});
