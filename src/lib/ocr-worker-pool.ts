import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

const run = promisify(execFile);

/**
 * PP-OCRv5 recognises a page in about 5.5 seconds, but a one-shot process
 * spends a further 4.6 seconds importing PaddleOCR and building the engine.
 * On a 17-page scan that overhead was most of the wall clock, so workers are
 * kept alive with the models resident and answer one page per stdin line.
 *
 * Every failure path falls back to a one-shot invocation, so the pool can only
 * make OCR faster, never unavailable.
 */

export interface OcrWorkerResult {
  text: string;
  confidence: number;
  engine: "pp-ocrv5";
}

const MAX_WORKERS = 4;
const REQUEST_TIMEOUT_MS = 170_000;
const STARTUP_TIMEOUT_MS = 120_000;
// Each resident worker holds about 1.07 GB of PaddleOCR weights. On an 18 GB
// machine a full pool is 4.3 GB that must not outlive the scan that needed it,
// so idle workers exit and the next page pays the build cost again.
const IDLE_SHUTDOWN_MS = 90_000;

interface Worker {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
}

const workers: Worker[] = [];
const waiting: Array<(worker: Worker | null) => void> = [];

function workerEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH ?? "",
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
    PYTHONNOUSERSITE: "1"
  };
}

function scriptPath(): string {
  return path.join(process.cwd(), "scripts", "ppocr-worker.py");
}

/** Reads exactly one line, rejecting if the worker dies or stalls. */
function readLine(worker: Worker, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.lines.off("line", onLine);
      worker.child.off("exit", onExit);
      worker.child.off("error", onExit);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("OCR_WORKER_TIMEOUT"));
    }, timeoutMs);
    const onLine = (line: string) => {
      if (!line.trim()) return;
      cleanup();
      resolve(line);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("OCR_WORKER_EXITED"));
    };
    worker.lines.on("line", onLine);
    worker.child.once("exit", onExit);
    worker.child.once("error", onExit);
  });
}

function discard(worker: Worker): void {
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = null;
  const index = workers.indexOf(worker);
  if (index >= 0) workers.splice(index, 1);
  worker.lines.close();
  worker.child.kill("SIGKILL");
}

async function startWorker(python: string, modelDir: string): Promise<Worker | null> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(python, [scriptPath(), "--serve", "--model-dir", modelDir], {
      env: workerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch {
    return null;
  }
  // stderr is drained so a chatty worker cannot fill its pipe buffer and hang.
  child.stderr.resume();
  const worker: Worker = { child, lines: createInterface({ input: child.stdout }), busy: true, idleTimer: null };
  try {
    const ready = JSON.parse(await readLine(worker, STARTUP_TIMEOUT_MS)) as { ready?: boolean };
    if (!ready.ready) throw new Error("OCR_WORKER_NOT_READY");
  } catch {
    discard(worker);
    return null;
  }
  workers.push(worker);
  return worker;
}

function release(worker: Worker): void {
  const next = waiting.shift();
  if (next) {
    next(worker);
    return;
  }
  worker.busy = false;
  worker.idleTimer = setTimeout(() => discard(worker), IDLE_SHUTDOWN_MS);
  // An idle timer must never hold the process open on its own.
  worker.idleTimer.unref?.();
}

async function acquire(python: string, modelDir: string): Promise<Worker | null> {
  const idle = workers.find((worker) => !worker.busy);
  if (idle) {
    if (idle.idleTimer) clearTimeout(idle.idleTimer);
    idle.idleTimer = null;
    idle.busy = true;
    return idle;
  }
  if (workers.length < MAX_WORKERS) return startWorker(python, modelDir);
  return new Promise((resolve) => waiting.push(resolve));
}

async function oneShot(python: string, modelDir: string, imagePath: string): Promise<string> {
  const { stdout } = await run(python, [scriptPath(), imagePath, "--model-dir", modelDir], {
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: workerEnvironment()
  });
  return stdout.trim().split("\n").at(-1) ?? "{}";
}

/**
 * Recognises one page, preferring a resident worker and falling back to a
 * one-shot process whenever the pool cannot serve the request.
 */
export async function recognizePage(
  python: string,
  modelDir: string,
  imagePath: string
): Promise<string> {
  const worker = await acquire(python, modelDir);
  if (!worker) return oneShot(python, modelDir, imagePath);
  try {
    const reply = readLine(worker, REQUEST_TIMEOUT_MS);
    worker.child.stdin.write(`${JSON.stringify({ image: imagePath })}\n`);
    const line = await reply;
    release(worker);
    return line;
  } catch {
    // A stalled or dead worker is never reused; the page still gets its result.
    discard(worker);
    const next = waiting.shift();
    if (next) next(null);
    return oneShot(python, modelDir, imagePath);
  }
}
