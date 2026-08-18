import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { z } from "zod";
import { localApiError, readBoundedJson, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";
export const maxDuration = 180;
const run = promisify(execFile);
const schema = z.object({ imageData: z.string().startsWith("data:image/").max(35 * 1024 * 1024), languages: z.array(z.enum(["en", "es"])).min(1).max(2) });

export async function POST(request: Request) {
  let directory: string | null = null;
  try {
    await requireLocalSession(request, true);
    const python = process.env.PADDLEOCR_PYTHON?.trim(); const modelDir = process.env.PADDLE_OCR_MODEL_DIR?.trim();
    if (!python || !path.isAbsolute(python) || !modelDir || !path.isAbsolute(modelDir)) return NextResponse.json({ error: "LOCAL_PADDLEOCR_NOT_CONFIGURED" }, { status: 503 });
    const { imageData } = schema.parse(await readBoundedJson(request, 36 * 1024 * 1024, "OCR_REQUEST_TOO_LARGE"));
    const match = imageData.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s); if (!match) throw new Error("INVALID_OCR_IMAGE");
    directory = await mkdtemp(path.join(tmpdir(), "verity-ocr-")); const imagePath = path.join(directory, "page.png"); await writeFile(imagePath, Buffer.from(match[1], "base64"), { mode: 0o600 });
    const script = path.join(process.cwd(), "scripts", "ppocr-worker.py"); const { stdout } = await run(python, [script, imagePath, "--model-dir", modelDir], { timeout: 170_000, maxBuffer: 16 * 1024 * 1024, env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "", PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True", PYTHONNOUSERSITE: "1" } });
    const result = z.object({ text: z.string(), confidence: z.number().min(0).max(1), engine: z.literal("pp-ocrv5") }).parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return localApiError(error); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}
