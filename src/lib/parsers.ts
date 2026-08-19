import { sha256Bytes, sha256Text, utf8ByteLength } from "@/lib/evidence";
import {
  createLocalOcrSession,
  localOcrVersion,
  type LocalOcrSession
} from "@/lib/ocr";
import type {
  EvidenceDocument,
  EvidencePageArtifact
} from "@/lib/types";

const MIN_NATIVE_TEXT_CHARACTERS = 20;
// PP-OCRv5 runs as one process per page, so several pages recognize in
// parallel on a multi-core machine. Measured on an M3 Pro: four pages took 19s
// in parallel against 37s sequentially. Above four the CPU saturates, since
// PaddleOCR is already multi-threaded inside each process.
const OCR_PAGE_CONCURRENCY = 4;
const PDF_OCR_SCALE = 2;
const MAX_IMAGE_OCR_DIMENSION = 3000;
export const MAX_SOURCE_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_PAGES = 500;
const MAX_DECODED_IMAGE_PIXELS = 50_000_000;
const MAX_PDF_RENDER_PIXELS = 40_000_000;
const MAX_DOCX_ENTRIES = 512;
const MAX_DOCX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_DOCX_COMPRESSION_RATIO = 100;
const MAX_EXTRACTED_TEXT_CHARACTERS = 8_000_000;

export interface ParseProgress {
  fileName: string;
  phase: "reading" | "parsing" | "ocr-loading" | "ocr" | "finalizing";
  pageNumber: number | null;
  totalPages: number | null;
  progress: number;
  message: string;
}

export interface ParseLocalFileOptions {
  ocrSession?: LocalOcrSession;
  onProgress?: (progress: ParseProgress) => void;
}

interface ParsedPage {
  pageNumber: number;
  text: string;
  extractionMethod: EvidencePageArtifact["extractionMethod"];
  width: number | null;
  height: number | null;
  imageSha256: string | null;
  ocrConfidence: number | null;
}

interface ParsedContent {
  pages: ParsedPage[];
  parserVersion: string;
  processingState: EvidenceDocument["processingState"];
}

const encoder = new TextEncoder();

export function normalizedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

export function needsOcr(nativeText: string): boolean {
  return normalizedText(nativeText).replace(/\s+/g, "").length <
    MIN_NATIVE_TEXT_CHARACTERS;
}

export function readRasterDimensions(
  bytes: Uint8Array
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a &&
    view.getUint32(8) === 13 &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
  ) {
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const startOfFrame = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
    ]);
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (startOfFrame.has(marker)) {
        return {
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7)
        };
      }
      offset += 2 + length;
    }
    return null;
  }
  if (
    bytes.length >= 16 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d))
  ) {
    const littleEndian = bytes[0] === 0x49;
    if (view.getUint16(2, littleEndian) !== 42) return null;
    const ifdOffset = view.getUint32(4, littleEndian);
    if (ifdOffset + 2 > bytes.length) return null;
    const entryCount = view.getUint16(ifdOffset, littleEndian);
    let width: number | null = null;
    let height: number | null = null;
    for (let index = 0; index < entryCount; index += 1) {
      const offset = ifdOffset + 2 + index * 12;
      if (offset + 12 > bytes.length) break;
      const tag = view.getUint16(offset, littleEndian);
      if (tag !== 256 && tag !== 257) continue;
      const type = view.getUint16(offset + 2, littleEndian);
      const count = view.getUint32(offset + 4, littleEndian);
      if (count !== 1 || ![3, 4].includes(type)) continue;
      const value =
        type === 3
          ? view.getUint16(offset + 8, littleEndian)
          : view.getUint32(offset + 8, littleEndian);
      if (tag === 256) width = value;
      if (tag === 257) height = value;
    }
    return width && height ? { width, height } : null;
  }
  return null;
}

export function buildCanonicalArtifact(pages: ParsedPage[]): {
  canonicalText: string;
  pageArtifacts: EvidencePageArtifact[];
} {
  const chunks: string[] = [];
  const pageArtifacts: EvidencePageArtifact[] = [];
  let currentByteOffset = 0;

  for (const page of pages) {
    const marker = `[Page ${page.pageNumber}]\n`;
    const text = normalizedText(page.text);
    const chunk = `${marker}${text}`;
    const bodyByteStart = currentByteOffset + encoder.encode(marker).byteLength;
    const bodyByteEnd = bodyByteStart + encoder.encode(text).byteLength;

    chunks.push(chunk);
    pageArtifacts.push({
      pageNumber: page.pageNumber,
      extractionMethod: page.extractionMethod,
      canonicalByteStart: bodyByteStart,
      canonicalByteEnd: bodyByteEnd,
      width: page.width,
      height: page.height,
      imageSha256: page.imageSha256,
      ocrConfidence: page.ocrConfidence
    });
    currentByteOffset += encoder.encode(chunk).byteLength + 2;
  }

  return {
    canonicalText: chunks.join("\n\n"),
    pageArtifacts
  };
}

function report(
  file: File,
  options: ParseLocalFileOptions,
  update: Omit<ParseProgress, "fileName">
): void {
  options.onProgress?.({ fileName: file.name, ...update });
}

function canvasPixelBytes(canvas: HTMLCanvasElement): Uint8Array {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not read the local OCR canvas.");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return new Uint8Array(
    pixels.buffer,
    pixels.byteOffset,
    pixels.byteLength
  );
}

async function recognizeCanvas(input: {
  canvas: HTMLCanvasElement;
  file: File;
  pageNumber: number;
  totalPages: number;
  session: LocalOcrSession;
  options: ParseLocalFileOptions;
}): Promise<ParsedPage> {
  const { canvas, file, pageNumber, totalPages, session, options } = input;
  report(file, options, {
    phase: "ocr-loading",
    pageNumber,
    totalPages,
    progress: (pageNumber - 1) / totalPages,
    message: `Preparing on-device OCR for page ${pageNumber} of ${totalPages}`
  });
  const imageSha256 = await sha256Bytes(canvasPixelBytes(canvas));
  const result = await session.recognize(canvas, (ocrProgress) => {
    const overallProgress = (pageNumber - 1 + ocrProgress.progress) / totalPages;
    report(file, options, {
      phase: "ocr",
      pageNumber,
      totalPages,
      progress: overallProgress,
      message: `OCR page ${pageNumber} of ${totalPages}: ${ocrProgress.status}`
    });
  });
  return {
    pageNumber,
    text: result.text,
    extractionMethod: "ocr",
    width: canvas.width,
    height: canvas.height,
    imageSha256,
    ocrConfidence: result.confidence
  };
}

export function pdfTextItemsToText(
  items: Array<{ str?: string; hasEOL?: boolean }>
): string {
  return items
    .map((item) => `${item.str ?? ""}${item.hasEOL ? "\n" : " "}`)
    .join("")
    .replaceAll(/[ \t]+\n/g, "\n")
    .replaceAll(/[ \t]{2,}/g, " ")
    .trim();
}

async function parsePdf(
  buffer: ArrayBuffer,
  file: File,
  session: LocalOcrSession,
  options: ParseLocalFileOptions
): Promise<ParsedContent> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/ocr/pdf.worker.min.mjs";
  const document = await pdfjs.getDocument({
    // PDF.js transfers its input to the worker. Send a copy so the original
    // bytes remain available for the immutable source hash and encrypted vault.
    data: new Uint8Array(buffer).slice(),
    useWorkerFetch: false,
    isEvalSupported: false
  }).promise;
  if (document.numPages > MAX_PDF_PAGES) {
    await document.destroy();
    throw new Error(`PDF exceeds the ${MAX_PDF_PAGES}-page processing limit.`);
  }
  const pageResults: Array<ParsedPage | Promise<ParsedPage>> = [];
  const active = new Set<Promise<ParsedPage>>();
  let ocrFailed = false;

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      report(file, options, {
        phase: "parsing",
        pageNumber,
        totalPages: document.numPages,
        progress: (pageNumber - 1) / document.numPages,
        message: `Reading page ${pageNumber} of ${document.numPages}`
      });
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const nativeText = pdfTextItemsToText(
        content.items.map((item) => ({
          str: "str" in item ? item.str : "",
          hasEOL: "hasEOL" in item ? item.hasEOL : false
        }))
      );
      const viewport = page.getViewport({ scale: PDF_OCR_SCALE });

      if (!needsOcr(nativeText)) {
        pageResults.push({
          pageNumber,
          text: nativeText,
          extractionMethod: "native-text",
          width: Math.round(viewport.width / PDF_OCR_SCALE),
          height: Math.round(viewport.height / PDF_OCR_SCALE),
          imageSha256: null,
          ocrConfidence: null
        });
        continue;
      }
      if (viewport.width * viewport.height > MAX_PDF_RENDER_PIXELS) {
        throw new Error("PDF page exceeds the local rendering pixel limit.");
      }

      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Could not create a local PDF rendering canvas.");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      // OCR is far slower than rendering, so pages are recognized concurrently
      // while rendering continues. Only OCR_CONCURRENCY canvases are alive at
      // once, which keeps a several-hundred-page document within memory.
      const pending = (async () => {
        try {
          return await recognizeCanvas({
            canvas,
            file,
            pageNumber,
            totalPages: document.numPages,
            session,
            options
          });
        } catch {
          ocrFailed = true;
          return {
            pageNumber,
            text: "",
            extractionMethod: "ocr" as const,
            width: canvas.width,
            height: canvas.height,
            imageSha256: await sha256Bytes(canvasPixelBytes(canvas)),
            ocrConfidence: 0
          };
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      })();
      pageResults.push(pending);
      const tracked = pending.catch(() => undefined) as Promise<ParsedPage>;
      active.add(tracked);
      void tracked.finally(() => active.delete(tracked));
      // Back-pressure: never hold more than OCR_PAGE_CONCURRENCY pages in
      // flight, so memory stays bounded no matter how long the document is.
      if (active.size >= OCR_PAGE_CONCURRENCY) await Promise.race(active);
    }
  } finally {
    await document.destroy();
  }

  const pages = await Promise.all(pageResults);

  return {
    pages,
    parserVersion: `pdfjs-local+tesseract-local:${localOcrVersion()}`,
    processingState: ocrFailed ? "ocr-failed" : "ready"
  };
}

async function parseImage(
  file: File,
  session: LocalOcrSession,
  options: ParseLocalFileOptions
): Promise<ParsedContent> {
  const header = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const dimensions = readRasterDimensions(header);
  if (!dimensions) throw new Error("Image dimensions could not be safely verified.");
  if (dimensions.width * dimensions.height > MAX_DECODED_IMAGE_PIXELS) {
    throw new Error("Image exceeds the local decoded-pixel limit.");
  }
  const bitmap = await createImageBitmap(file);
  if (bitmap.width * bitmap.height > MAX_DECODED_IMAGE_PIXELS) {
    bitmap.close();
    throw new Error("Image exceeds the local decoded-pixel limit.");
  }
  const canvas = window.document.createElement("canvas");
  const scale = Math.min(
    1,
    MAX_IMAGE_OCR_DIMENSION / Math.max(bitmap.width, bitmap.height)
  );
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Could not create a local image OCR canvas.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  try {
    const page = await recognizeCanvas({
      canvas,
      file,
      pageNumber: 1,
      totalPages: 1,
      session,
      options
    });
    return {
      pages: [page],
      parserVersion: `image-local+tesseract-local:${localOcrVersion()}`,
      processingState: "ready"
    };
  } catch {
    return {
      pages: [
        {
          pageNumber: 1,
          text: "",
          extractionMethod: "ocr",
          width: canvas.width,
          height: canvas.height,
          imageSha256: await sha256Bytes(canvasPixelBytes(canvas)),
          ocrConfidence: 0
        }
      ],
      parserVersion: `image-local+tesseract-local:${localOcrVersion()}`,
      processingState: "ocr-failed"
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function parseDocx(buffer: ArrayBuffer): Promise<ParsedContent> {
  const { default: JSZip } = await import("jszip");
  const archive = await JSZip.loadAsync(buffer, { checkCRC32: false });
  const entries = Object.values(archive.files) as Array<{
    dir: boolean;
    _data?: { compressedSize?: number; uncompressedSize?: number };
  }>;
  if (entries.length > MAX_DOCX_ENTRIES) throw new Error("DOCX_ENTRY_LIMIT_EXCEEDED");
  let expandedBytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const compressed = entry._data?.compressedSize ?? 0;
    const uncompressed = entry._data?.uncompressedSize ?? 0;
    expandedBytes += uncompressed;
    if (
      expandedBytes > MAX_DOCX_EXPANDED_BYTES ||
      (compressed > 0 && uncompressed / compressed > MAX_DOCX_COMPRESSION_RATIO)
    ) {
      throw new Error("DOCX_EXPANSION_LIMIT_EXCEEDED");
    }
  }
  const mammoth = await import("mammoth/mammoth.browser");
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  if (result.value.length > MAX_EXTRACTED_TEXT_CHARACTERS) {
    throw new Error("EXTRACTED_TEXT_LIMIT_EXCEEDED");
  }
  return {
    pages: [
      {
        pageNumber: 1,
        text: result.value,
        extractionMethod: "native-text",
        width: null,
        height: null,
        imageSha256: null,
        ocrConfidence: null
      }
    ],
    parserVersion: "mammoth-browser",
    processingState: "ready"
  };
}

function parsePlainText(buffer: ArrayBuffer): ParsedContent {
  return {
    pages: [
      {
        pageNumber: 1,
        text: new TextDecoder("utf-8").decode(buffer),
        extractionMethod: "native-text",
        width: null,
        height: null,
        imageSha256: null,
        ocrConfidence: null
      }
    ],
    parserVersion: "verity-text-parser@0.2.0",
    processingState: "ready"
  };
}

export async function parseLocalFile(
  file: File,
  options: ParseLocalFileOptions = {}
): Promise<EvidenceDocument> {
  const startedAt = performance.now();
  report(file, options, {
    phase: "reading",
    pageNumber: null,
    totalPages: null,
    progress: 0,
    message: `Reading ${file.name} locally`
  });
  if (file.size > MAX_SOURCE_FILE_BYTES) {
    throw new Error(
      `File exceeds the ${Math.round(MAX_SOURCE_FILE_BYTES / 1024 / 1024)} MB local processing limit.`
    );
  }
  const buffer = await file.arrayBuffer();
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const ownedOcrSession = options.ocrSession ? null : createLocalOcrSession();
  const ocrSession = options.ocrSession ?? ownedOcrSession!;
  let parsed: ParsedContent;

  try {
    if (["txt", "eml", "msg"].includes(extension)) {
      parsed = parsePlainText(buffer);
    } else if (extension === "docx") {
      parsed = await parseDocx(buffer);
    } else if (extension === "pdf") {
      parsed = await parsePdf(buffer, file, ocrSession, options);
    } else if (["png", "jpg", "jpeg", "tif", "tiff"].includes(extension)) {
      parsed = await parseImage(file, ocrSession, options);
    } else {
      parsed = {
        pages: [],
        parserVersion: "unsupported",
        processingState: "unsupported"
      };
    }
  } finally {
    await ownedOcrSession?.terminate();
  }

  report(file, options, {
    phase: "finalizing",
    pageNumber: null,
    totalPages: parsed.pages.length,
    progress: 0.98,
    message: `Hashing the canonical artifact for ${file.name}`
  });
  const { canonicalText, pageArtifacts } = buildCanonicalArtifact(parsed.pages);
  const ocrConfidences = parsed.pages.flatMap((page) =>
    page.ocrConfidence === null ? [] : [page.ocrConfidence]
  );
  const processingDurationMs = performance.now() - startedAt;

  return {
    id: crypto.randomUUID(),
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    size: file.size,
    originalSha256: await sha256Bytes(buffer),
    canonicalSha256: await sha256Text(canonicalText),
    canonicalText,
    canonicalByteLength: utf8ByteLength(canonicalText),
    parserVersion: parsed.parserVersion,
    pageCount: parsed.pages.length || 1,
    pages: pageArtifacts,
    processingDurationMs,
    ocrPageCount: ocrConfidences.length,
    ocrMeanConfidence:
      ocrConfidences.length > 0
        ? ocrConfidences.reduce((total, value) => total + value, 0) /
          ocrConfidences.length
        : null,
    ingestedAt: new Date().toISOString(),
    processingState: parsed.processingState
  };
}
