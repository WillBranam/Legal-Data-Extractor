import { NextResponse } from "next/server";
import { z } from "zod";
import { transcribeWithLocalVisualModel } from "@/lib/local-llm";
import { localApiError, readBoundedJson, requireLocalSession } from "@/lib/local-request";

export const runtime = "nodejs";
export const maxDuration = 120;
const schema = z.object({ imageData: z.string().startsWith("data:image/").max(35 * 1024 * 1024) });
export async function POST(request: Request) { try { await requireLocalSession(request, true); const { imageData } = schema.parse(await readBoundedJson(request, 36 * 1024 * 1024, "VISUAL_OCR_REQUEST_TOO_LARGE")); const base64 = imageData.slice(imageData.indexOf(",") + 1); return NextResponse.json(await transcribeWithLocalVisualModel(base64), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return localApiError(error); } }
