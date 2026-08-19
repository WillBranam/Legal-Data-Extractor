import type { ImageLike, LoggerMessage, Worker } from "tesseract.js";

export interface OcrProgress {
  status: string;
  progress: number;
}

export interface OcrRecognition {
  text: string;
  confidence: number;
  engine: "pp-ocrv5" | "qwen3-vl" | "tesseract";
}

export interface LocalOcrSession {
  recognize(
    image: ImageLike,
    onProgress?: (progress: OcrProgress) => void
  ): Promise<OcrRecognition>;
  terminate(): Promise<void>;
}

const OCR_VERSION = "pp-ocrv5-local|qwen3-vl-local-fallback|tesseract.js@7.0.0+eng+spa_best_int@4.0.0";

export function localOcrVersion(): string {
  return OCR_VERSION;
}

// A scanned form is read well or badly in a way mean confidence cannot see.
// PP-OCRv5 reads the printed labels at ~0.98 and simply does not detect the
// handwritten answers, so they never enter the mean: a page can score 0.9 while
// every value on it is missing. Coverage of label/value pairing is the signal
// that actually tracks unread handwriting.
const MIN_ORPHANED_LABELS = 3;
const MIN_ORPHANED_LABEL_RATIO = 0.2;
// A replacement transcription must not quietly lose text.
const MIN_RETAINED_TEXT_RATIO = 0.6;

function labelLines(text: string): { labels: number; orphaned: number } {
  let labels = 0;
  let orphaned = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // A label is short, ends at a colon, and is not a sentence.
    const match = /^([^:]{2,60}):(.*)$/.exec(line);
    if (!match) continue;
    if (/[.!?]$/.test(match[1])) continue;
    if (match[1].split(/\s+/).length > 8) continue;
    labels += 1;
    if (!match[2].trim()) orphaned += 1;
  }
  return { labels, orphaned };
}

/** Labels whose value was not read onto the same line. */
export function orphanedLabelCount(text: string): number {
  return labelLines(text).orphaned;
}

/**
 * True when a transcription looks like a form whose answers were not read.
 * Used to escalate to the handwriting-capable visual model regardless of the
 * confidence the printed text earned.
 */
export function suggestsUnreadFormValues(text: string): boolean {
  const { labels, orphaned } = labelLines(text);
  if (orphaned < MIN_ORPHANED_LABELS) return false;
  return orphaned / Math.max(1, labels) >= MIN_ORPHANED_LABEL_RATIO;
}

/**
 * Picks the transcription that keeps more labels attached to their values,
 * which is what downstream field extraction depends on. A candidate that
 * dropped a large share of the text is rejected even if it pairs better.
 */
export function preferPairedTranscription(
  current: OcrRecognition,
  candidate: OcrRecognition
): OcrRecognition {
  if (!candidate.text.trim()) return current;
  if (candidate.text.trim().length < current.text.trim().length * MIN_RETAINED_TEXT_RATIO) return current;
  return orphanedLabelCount(candidate.text) < orphanedLabelCount(current.text) ? candidate : current;
}

export function createLocalOcrSession(): LocalOcrSession {
  let workerPromise: Promise<Worker> | null = null;
  let progressListener: ((progress: OcrProgress) => void) | undefined;
  let lastProgress = -1;
  let lastStatus = "";

  async function worker(): Promise<Worker> {
    if (!workerPromise) {
      workerPromise = import("tesseract.js").then(async ({ createWorker, OEM }) => {
        const origin = window.location.origin;
        return createWorker(["eng", "spa"], OEM.LSTM_ONLY, {
          workerPath: `${origin}/ocr/worker.min.js`,
          corePath: `${origin}/ocr/core`,
          langPath: `${origin}/ocr/lang`,
          workerBlobURL: false,
          cacheMethod: "none",
          logger: (message: LoggerMessage) => {
            const progress = Math.max(0, Math.min(1, message.progress));
            if (
              message.status !== lastStatus ||
              progress === 1 ||
              progress - lastProgress >= 0.02
            ) {
              lastStatus = message.status;
              lastProgress = progress;
              progressListener?.({ status: message.status, progress });
            }
          }
        });
      });
    }
    return workerPromise;
  }

  // The PP-OCRv5 path is a stateless request per page and is safe to run for
  // several pages at once. The Tesseract worker is not: it is a single worker
  // with shared progress state, so concurrent callers would interleave their
  // logging and corrupt each other's progress. Serialize only that fallback.
  let tesseractQueue: Promise<unknown> = Promise.resolve();

  function serializeOnTesseract<T>(work: () => Promise<T>): Promise<T> {
    const result = tesseractQueue.then(work, work);
    tesseractQueue = result.catch(() => undefined);
    return result;
  }

  async function visualTranscribe(
    image: HTMLCanvasElement,
    onProgress?: (progress: OcrProgress) => void
  ): Promise<OcrRecognition | null> {
    onProgress?.({ status: "reading handwriting", progress: 0.5 });
    try {
      const response = await fetch("/api/local/visual-ocr", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageData: image.toDataURL("image/png") }) });
      if (!response.ok) return null;
      const visual = await response.json() as OcrRecognition;
      return visual.text.trim() ? visual : null;
    } catch {
      return null;
    }
  }

  return {
    async recognize(image, onProgress) {
      if (image instanceof HTMLCanvasElement) {
        const imageData = image.toDataURL("image/png");
        try {
          const response = await fetch("/api/local/ocr", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageData, languages: ["en", "es"] }) });
          if (response.ok) {
            const local = await response.json() as OcrRecognition;
            if (local.text.trim() && local.confidence >= 0.72) {
              // High confidence only means the detected text was read well. A
              // form whose handwritten answers were never detected still scores
              // high, so pages with unpaired labels go to the visual model.
              if (!suggestsUnreadFormValues(local.text)) return local;
              const visual = await visualTranscribe(image, onProgress);
              return visual ? preferPairedTranscription(local, visual) : local;
            }
          }
        } catch { /* Local PaddleOCR is optional; use bundled browser OCR below. */ }
      }
      return serializeOnTesseract(async () => {
        lastProgress = -1;
        lastStatus = "";
        progressListener = onProgress;
        try {
          const activeWorker = await worker();
          const result = await activeWorker.recognize(
          image,
          { rotateAuto: true },
          { text: true }
          );
          const tesseractResult: OcrRecognition = {
          text: result.data.text,
          confidence: Math.max(0, Math.min(1, result.data.confidence / 100)),
          engine: "tesseract"
          };
          const weak = tesseractResult.confidence < 0.72;
          if (image instanceof HTMLCanvasElement && (weak || suggestsUnreadFormValues(tesseractResult.text))) {
            const visual = await visualTranscribe(image, onProgress);
            if (visual) return weak ? visual : preferPairedTranscription(tesseractResult, visual);
          }
          return tesseractResult;
        } finally {
          progressListener = undefined;
        }
      });
    },
    async terminate() {
      if (!workerPromise) return;
      const activeWorker = await workerPromise;
      await activeWorker.terminate();
      workerPromise = null;
    }
  };
}
