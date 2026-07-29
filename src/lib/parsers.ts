import { sha256Bytes, sha256Text, utf8ByteLength } from "@/lib/evidence";
import type { EvidenceDocument } from "@/lib/types";

function normalizedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

async function parsePdf(buffer: ArrayBuffer): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false
  }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(`[Page ${pageNumber}]\n${text}`);
  }
  return { text: normalizedText(pages.join("\n\n")), pages: document.numPages };
}

async function parseDocx(buffer: ArrayBuffer): Promise<{ text: string; pages: number }> {
  const mammoth = await import("mammoth/mammoth.browser");
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return { text: normalizedText(result.value), pages: 1 };
}

export async function parseLocalFile(file: File): Promise<EvidenceDocument> {
  const buffer = await file.arrayBuffer();
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  let canonicalText = "";
  let pageCount = 1;
  let processingState: EvidenceDocument["processingState"] = "ready";
  let parserVersion = "verity-text-parser@0.1.0";

  if (["txt", "eml", "msg"].includes(extension)) {
    canonicalText = normalizedText(new TextDecoder("utf-8").decode(buffer));
  } else if (extension === "docx") {
    const parsed = await parseDocx(buffer);
    canonicalText = parsed.text;
    pageCount = parsed.pages;
    parserVersion = "mammoth-browser";
  } else if (extension === "pdf") {
    const parsed = await parsePdf(buffer);
    canonicalText = parsed.text;
    pageCount = parsed.pages;
    parserVersion = "pdfjs-local";
    if (canonicalText.replace(/\[Page \d+\]/g, "").trim().length < 20) {
      processingState = "needs-ocr";
    }
  } else if (["png", "jpg", "jpeg", "tif", "tiff"].includes(extension)) {
    canonicalText = "";
    processingState = "needs-ocr";
    parserVersion = "ocr-required";
  } else {
    processingState = "unsupported";
  }

  return {
    id: crypto.randomUUID(),
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    size: file.size,
    originalSha256: await sha256Bytes(buffer),
    canonicalSha256: await sha256Text(canonicalText),
    canonicalText,
    canonicalByteLength: utf8ByteLength(canonicalText),
    parserVersion,
    pageCount,
    ingestedAt: new Date().toISOString(),
    processingState
  };
}
