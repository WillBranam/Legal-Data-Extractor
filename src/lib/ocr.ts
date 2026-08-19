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

  return {
    async recognize(image, onProgress) {
      if (image instanceof HTMLCanvasElement) {
        const imageData = image.toDataURL("image/png");
        try {
          const response = await fetch("/api/local/ocr", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageData, languages: ["en", "es"] }) });
          if (response.ok) {
            const local = await response.json() as OcrRecognition;
            if (local.text.trim() && local.confidence >= 0.72) return local;
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
          if (image instanceof HTMLCanvasElement && tesseractResult.confidence < 0.72) {
          try {
            const response = await fetch("/api/local/visual-ocr", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageData: image.toDataURL("image/png") }) });
            if (response.ok) {
              const visual = await response.json() as OcrRecognition;
              if (visual.text.trim()) return visual;
            }
          } catch { /* Preserve the deterministic Tesseract result if visual fallback is unavailable. */ }
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
