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
const PDF_OCR_SCALE = 2;
const MAX_IMAGE_OCR_DIMENSION = 3000;

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

async function parsePdf(
  buffer: ArrayBuffer,
  file: File,
  session: LocalOcrSession,
  options: ParseLocalFileOptions
): Promise<ParsedContent> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false
  }).promise;
  const pages: ParsedPage[] = [];
  let ocrFailed = false;

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
    const nativeText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    const viewport = page.getViewport({ scale: PDF_OCR_SCALE });

    if (!needsOcr(nativeText)) {
      pages.push({
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

    const canvas = window.document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Could not create a local PDF rendering canvas.");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    try {
      pages.push(
        await recognizeCanvas({
          canvas,
          file,
          pageNumber,
          totalPages: document.numPages,
          session,
          options
        })
      );
    } catch {
      ocrFailed = true;
      pages.push({
        pageNumber,
        text: "",
        extractionMethod: "ocr",
        width: canvas.width,
        height: canvas.height,
        imageSha256: await sha256Bytes(canvasPixelBytes(canvas)),
        ocrConfidence: 0
      });
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

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
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    report(file, options, {
      phase: "ocr-loading",
      pageNumber: 1,
      totalPages: 1,
      progress: 0,
      message: "Preparing on-device OCR"
    });
    try {
      const result = await session.recognize(file, (ocrProgress) => {
        report(file, options, {
          phase: "ocr",
          pageNumber: 1,
          totalPages: 1,
          progress: ocrProgress.progress,
          message: `OCR page 1 of 1: ${ocrProgress.status}`
        });
      });
      return {
        pages: [
          {
            pageNumber: 1,
            text: result.text,
            extractionMethod: "ocr",
            width: null,
            height: null,
            imageSha256: await sha256Bytes(await file.arrayBuffer()),
            ocrConfidence: result.confidence
          }
        ],
        parserVersion: `image-local+tesseract-local:${localOcrVersion()}`,
        processingState: "ready"
      };
    } catch {
      return {
        pages: [],
        parserVersion: `image-local+tesseract-local:${localOcrVersion()}`,
        processingState: "ocr-failed"
      };
    }
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
  const mammoth = await import("mammoth/mammoth.browser");
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
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
