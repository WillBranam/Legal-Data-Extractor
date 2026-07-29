import type { ImageLike, LoggerMessage, Worker } from "tesseract.js";

export interface OcrProgress {
  status: string;
  progress: number;
}

export interface OcrRecognition {
  text: string;
  confidence: number;
}

export interface LocalOcrSession {
  recognize(
    image: ImageLike,
    onProgress?: (progress: OcrProgress) => void
  ): Promise<OcrRecognition>;
  terminate(): Promise<void>;
}

const OCR_VERSION = "tesseract.js@7.0.0+eng_best_int@4.0.0";

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
        return createWorker("eng", OEM.LSTM_ONLY, {
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

  return {
    async recognize(image, onProgress) {
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
        return {
          text: result.data.text,
          confidence: Math.max(0, Math.min(1, result.data.confidence / 100))
        };
      } finally {
        progressListener = undefined;
      }
    },
    async terminate() {
      if (!workerPromise) return;
      const activeWorker = await workerPromise;
      await activeWorker.terminate();
      workerPromise = null;
    }
  };
}
