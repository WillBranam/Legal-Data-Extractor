import { describe, expect, it } from "vitest";
import { readCanonicalByteRange } from "@/lib/evidence";
import {
  buildCanonicalArtifact,
  needsOcr,
  normalizedText,
  pdfTextItemsToText,
  readRasterDimensions
} from "@/lib/parsers";

describe("local parser evidence artifacts", () => {
  it("preserves PDF line endings for transcripts and table rows", () => {
    expect(
      pdfTextItemsToText([
        { str: "6 A. It looked green,", hasEOL: false },
        { str: "but my view was blocked.", hasEOL: true },
        { str: "7 Q. Could you see continuously?", hasEOL: true }
      ])
    ).toBe(
      "6 A. It looked green, but my view was blocked.\n7 Q. Could you see continuously?"
    );
  });

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

  it("reads image dimensions from bounded PNG headers before decoding", () => {
    const header = new Uint8Array(24);
    header.set([0x89, 0x50, 0x4e, 0x47], 0);
    const view = new DataView(header.buffer);
    view.setUint32(16, 1800);
    view.setUint32(20, 2300);
    expect(readRasterDimensions(header)).toEqual({ width: 1800, height: 2300 });
  });
});
