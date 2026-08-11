import { describe, expect, it } from "vitest";
import {
  createCitation,
  locateExactQuote,
  readCanonicalByteRange,
  readCitationContext,
  sha256Bytes,
  sha256Text,
  utf8ByteLength,
  verifyCitation
} from "@/lib/evidence";
import type { EvidenceDocument } from "@/lib/types";

async function documentFor(text: string): Promise<EvidenceDocument> {
  const bytes = new TextEncoder().encode(text);
  return {
    id: "document",
    name: "source.txt",
    mediaType: "text/plain",
    size: bytes.byteLength,
    originalSha256: await sha256Bytes(bytes),
    canonicalSha256: await sha256Text(text),
    canonicalText: text,
    canonicalByteLength: utf8ByteLength(text),
    parserVersion: "test",
    pageCount: 1,
    pages: [
      {
        pageNumber: 1,
        extractionMethod: "native-text",
        canonicalByteStart: 0,
        canonicalByteEnd: bytes.byteLength,
        width: null,
        height: null,
        imageSha256: null,
        ocrConfidence: null
      }
    ],
    processingDurationMs: 1,
    ocrPageCount: 0,
    ocrMeanConfidence: null,
    ingestedAt: "2025-01-01T00:00:00Z",
    processingState: "ready"
  };
}

describe("canonical byte evidence", () => {
  it("locates and reads Unicode quotations by UTF-8 bytes", () => {
    const text = "Prefix — “café evidence” — suffix";
    const quote = "“café evidence”";
    const range = locateExactQuote(text, quote);
    expect(range.byteStart).toBeGreaterThan(text.indexOf(quote));
    expect(readCanonicalByteRange(text, range.byteStart, range.byteEnd)).toBe(quote);
  });

  it("verifies hashes, range, and exact quote", async () => {
    const document = await documentFor("A precise source sentence. Another sentence.");
    const citation = await createCitation({
      id: "citation",
      document,
      exactQuote: "A precise source sentence.",
      pageNumber: 1
    });
    await expect(verifyCitation(citation, document)).resolves.toEqual({
      verified: true,
      reason: "verified",
      exactQuote: "A precise source sentence."
    });
  });

  it("builds Unicode-safe surrounding citation context", () => {
    const text = "Earlier context — café. Exact evidence. Later context — résumé.";
    const range = locateExactQuote(text, "Exact evidence.");
    expect(readCitationContext(text, range.byteStart, range.byteEnd, 10)).toEqual({
      before: "t — café. ",
      exactQuote: "Exact evidence.",
      after: " Later con"
    });
  });

  it("rejects altered quotations and artifacts", async () => {
    const document = await documentFor("Original evidence.");
    const citation = await createCitation({
      id: "citation",
      document,
      exactQuote: "Original evidence."
    });
    expect(
      await verifyCitation({ ...citation, exactQuote: "Changed evidence." }, document)
    ).toMatchObject({ verified: false, reason: "quote-mismatch" });
    expect(
      await verifyCitation(citation, { ...document, canonicalText: "Tampered evidence." })
    ).toMatchObject({ verified: false, reason: "hash-mismatch" });
  });
});
