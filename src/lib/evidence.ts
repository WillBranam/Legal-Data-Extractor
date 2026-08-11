import type {
  Citation,
  EvidenceDocument,
  VerificationResult
} from "@/lib/types";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface CitationContext {
  before: string;
  exactQuote: string;
  after: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Bytes(input: ArrayBuffer | Uint8Array): Promise<string> {
  const view = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bytes = Uint8Array.from(view);
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer))
  );
}

export async function sha256Text(text: string): Promise<string> {
  return sha256Bytes(encoder.encode(text));
}

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function locateExactQuote(
  canonicalText: string,
  exactQuote: string,
  fromCharacter = 0
): { byteStart: number; byteEnd: number } {
  const characterIndex = canonicalText.indexOf(exactQuote, fromCharacter);
  if (characterIndex < 0) {
    throw new Error("The exact quote is not present in the canonical artifact.");
  }

  const byteStart = encoder.encode(canonicalText.slice(0, characterIndex)).byteLength;
  const byteEnd = byteStart + encoder.encode(exactQuote).byteLength;
  return { byteStart, byteEnd };
}

export function readCanonicalByteRange(
  canonicalText: string,
  byteStart: number,
  byteEnd: number
): string {
  const bytes = encoder.encode(canonicalText);
  if (
    !Number.isInteger(byteStart) ||
    !Number.isInteger(byteEnd) ||
    byteStart < 0 ||
    byteEnd <= byteStart ||
    byteEnd > bytes.byteLength
  ) {
    throw new RangeError("Citation byte range is outside the canonical artifact.");
  }
  return decoder.decode(bytes.slice(byteStart, byteEnd));
}

export function readCitationContext(
  canonicalText: string,
  byteStart: number,
  byteEnd: number,
  surroundingCodePoints = 220
): CitationContext {
  const bytes = encoder.encode(canonicalText);
  if (
    !Number.isInteger(byteStart) ||
    !Number.isInteger(byteEnd) ||
    byteStart < 0 ||
    byteEnd <= byteStart ||
    byteEnd > bytes.byteLength
  ) {
    throw new RangeError("Citation byte range is outside the canonical artifact.");
  }
  const windowBytes = Math.max(0, surroundingCodePoints) * 4;
  let beforeStart = Math.max(0, byteStart - windowBytes);
  while (beforeStart < byteStart && (bytes[beforeStart] & 0xc0) === 0x80) {
    beforeStart += 1;
  }
  let afterEnd = Math.min(bytes.byteLength, byteEnd + windowBytes);
  while (afterEnd > byteEnd && afterEnd < bytes.byteLength && (bytes[afterEnd] & 0xc0) === 0x80) {
    afterEnd -= 1;
  }
  const exactQuote = decoder.decode(bytes.slice(byteStart, byteEnd));
  const before = decoder.decode(bytes.slice(beforeStart, byteStart));
  const after = decoder.decode(bytes.slice(byteEnd, afterEnd));
  return {
    before: Array.from(before).slice(-surroundingCodePoints).join(""),
    exactQuote,
    after: Array.from(after).slice(0, surroundingCodePoints).join("")
  };
}

export async function verifyCitation(
  citation: Citation,
  document: EvidenceDocument | undefined
): Promise<VerificationResult> {
  if (!document || citation.documentId !== document.id) {
    return { verified: false, reason: "document-not-found" };
  }

  const currentHash = await sha256Text(document.canonicalText);
  if (
    currentHash !== citation.canonicalArtifactSha256 ||
    currentHash !== document.canonicalSha256 ||
    citation.originalFileSha256 !== document.originalSha256
  ) {
    return { verified: false, reason: "hash-mismatch" };
  }

  let exactQuote: string;
  try {
    exactQuote = readCanonicalByteRange(
      document.canonicalText,
      citation.canonicalByteStart,
      citation.canonicalByteEnd
    );
  } catch {
    return { verified: false, reason: "range-invalid" };
  }

  if (exactQuote !== citation.exactQuote) {
    return { verified: false, reason: "quote-mismatch" };
  }

  return { verified: true, reason: "verified", exactQuote };
}

export async function createCitation(input: {
  id: string;
  document: EvidenceDocument;
  exactQuote: string;
  pageNumber?: number | null;
  structuralPath?: string | null;
}): Promise<Citation> {
  const { byteStart, byteEnd } = locateExactQuote(
    input.document.canonicalText,
    input.exactQuote
  );
  return {
    id: input.id,
    documentId: input.document.id,
    originalFileSha256: input.document.originalSha256,
    canonicalArtifactSha256: input.document.canonicalSha256,
    canonicalByteStart: byteStart,
    canonicalByteEnd: byteEnd,
    exactQuote: input.exactQuote,
    pageNumber: input.pageNumber ?? null,
    structuralPath: input.structuralPath ?? null,
    parserVersion: input.document.parserVersion
  };
}
