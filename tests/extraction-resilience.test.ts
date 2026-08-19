import { afterEach, describe, expect, it, vi } from "vitest";
import { extractWithLocalModel } from "@/lib/local-llm";
import { modelTimeoutForTokens } from "@/lib/local-model-provider";
import type { EvidenceDocument } from "@/lib/types";

// One page long enough to split into two extraction spans, so a failure on the
// second span leaves genuine work behind on the first.
const HEADER = "PLAINTIFF FACT SHEET\nCase Number: 24STCV18432\nClient: Maria Rivera\n";
const FILLER = "Additional Party: Rosa Delgado, Relationship: spouse\n".repeat(80);
const TEXT = `${HEADER}${FILLER}`;

function documentFixture(): EvidenceDocument {
  const byteLength = new TextEncoder().encode(TEXT).byteLength;
  return {
    id: "doc-1",
    name: "fact-sheet.txt",
    mediaType: "text/plain",
    size: byteLength,
    originalSha256: "0".repeat(64),
    canonicalSha256: "1".repeat(64),
    canonicalText: TEXT,
    canonicalByteLength: byteLength,
    pages: [
      {
        pageNumber: 1,
        canonicalByteStart: 0,
        canonicalByteEnd: byteLength,
        extractionMethod: "native-text",
        width: null,
        height: null,
        imageSha256: null,
        ocrConfidence: null
      }
    ],
    pageCount: 1,
    processingState: "ready",
    ingestedAt: new Date().toISOString(),
    parserVersion: "test",
    processingDurationMs: 0,
    ocrPageCount: 0,
    ocrMeanConfidence: null
  } as unknown as EvidenceDocument;
}

/** Builds a single-page document whose text splits into `spans` extraction spans. */
function spannedDocument(spans: number, unit: string): EvidenceDocument {
  const block = unit.repeat(Math.ceil(3600 / unit.length));
  const text = Array.from({ length: spans }, () => block).join("");
  const byteLength = new TextEncoder().encode(text).byteLength;
  const base = documentFixture();
  return {
    ...base,
    canonicalText: text,
    canonicalByteLength: byteLength,
    size: byteLength,
    pages: [{ ...base.pages[0], canonicalByteEnd: byteLength }]
  } as unknown as EvidenceDocument;
}

function manySpanDocument(): EvidenceDocument {
  return spannedDocument(6, "Case Number: 24STCV18432 filed with the clerk on record.\n");
}

function markerDocument(): EvidenceDocument {
  const markers = Array.from({ length: 12 }, (_, index) => `MARK-${index}`).join(" ");
  return spannedDocument(6, `${markers} Case Number: 24STCV18432\n`);
}

const EXTRACTION_BODY = {
  document_type: "plaintiff fact sheet",
  language: "en",
  fields: [
    {
      canonical_key: "matter.case_number",
      display_label: "Case number",
      category: "matter",
      value_type: "identifier",
      source_label: "Case Number",
      raw_value: "24STCV18432",
      exact_quote: "Case Number: 24STCV18432",
      subject_name: null,
      subject_type: null,
      relationship_type: null,
      related_entity_name: null,
      confidence: 0.9
    }
  ]
};

function completion(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }]
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Mirrors what AbortSignal.timeout produces when a model request outlives its
 * allowance. This is the failure both real documents hit.
 */
function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("extraction resilience", () => {
  it("allows enough wall time for the model to spend its whole token budget", () => {
    // 2,688 tokens is the extraction budget (128 overhead + 8 fields x 320).
    // A 4-bit 8B model on Apple Silicon sustains roughly 20-25 tokens/second,
    // so the allowance must clear ~120s or full-budget spans die mid-flight.
    expect(modelTimeoutForTokens(2688)).toBeGreaterThan(150_000);
    // A small review batch must not wait as long as a full extraction span.
    expect(modelTimeoutForTokens(128)).toBeLessThan(modelTimeoutForTokens(2688));
  });

  it("keeps proposals from spans that succeeded before a model timeout", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body: string }) => {
      call += 1;
      if (call === 1) return completion(EXTRACTION_BODY);
      if (call === 2) throw timeoutError();
      // Later calls are the reviewer passes; approve everything they are shown
      // so the assertion measures extraction survival, not reviewer judgement.
      const sent = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      const candidates = JSON.parse(sent.messages[1].content) as {
        candidates?: Array<{ id: string }>;
      };
      return completion({ approved_ids: (candidates.candidates ?? []).map((item) => item.id) });
    }));

    const result = await extractWithLocalModel(documentFixture(), []);

    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.reviewSummary.coverage).toBe("partial");
    expect(result.reviewSummary.spansScanned).toBe(1);
    expect(result.reviewSummary.spansTotal).toBeGreaterThan(1);
  });

  it("reports a timeout as running out of time, not as the model being unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw timeoutError();
    }));

    const result = await extractWithLocalModel(documentFixture(), []);

    expect(result.reviewSummary.coverageReason).toMatch(/time/i);
    expect(result.reviewSummary.coverageReason).not.toMatch(/unavailable/i);
  });

  it("still reports an unreachable model as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    const result = await extractWithLocalModel(documentFixture(), []);

    expect(result.reviewSummary.coverageReason).toMatch(/unavailable/i);
  });
});

describe("span concurrency", () => {
  it("runs spans in parallel up to the configured limit", async () => {
    vi.stubEnv("LOCAL_EXTRACTION_CONCURRENCY", "4");
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      const isReview = sent.messages[0].content.includes("review");
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      if (isReview) {
        const parsed = JSON.parse(sent.messages[1].content) as { candidates?: Array<{ id: string }> };
        return completion({ approved_ids: (parsed.candidates ?? []).map((item) => item.id) });
      }
      return completion(EXTRACTION_BODY);
    }));

    const result = await extractWithLocalModel(manySpanDocument(), []);

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.reviewSummary.coverage).toBe("complete");
  });

  it("honours a concurrency limit of one", async () => {
    vi.stubEnv("LOCAL_EXTRACTION_CONCURRENCY", "1");
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body: string }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const sent = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      if (sent.messages[0].content.includes("review")) {
        const parsed = JSON.parse(sent.messages[1].content) as { candidates?: Array<{ id: string }> };
        return completion({ approved_ids: (parsed.candidates ?? []).map((item) => item.id) });
      }
      return completion(EXTRACTION_BODY);
    }));

    await extractWithLocalModel(manySpanDocument(), []);

    expect(peak).toBe(1);
  });

  it("keeps proposal order stable regardless of which span finishes first", async () => {
    vi.stubEnv("LOCAL_EXTRACTION_CONCURRENCY", "4");
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      if (sent.messages[0].content.includes("review")) {
        const parsed = JSON.parse(sent.messages[1].content) as { candidates?: Array<{ id: string }> };
        return completion({ approved_ids: (parsed.candidates ?? []).map((item) => item.id) });
      }
      // Later spans return sooner, so completion order is the reverse of span
      // order. Published order must still follow the document.
      const index = call++;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 40 - index * 10)));
      return completion({
        ...EXTRACTION_BODY,
        fields: [{ ...EXTRACTION_BODY.fields[0], raw_value: `MARK-${index}`, exact_quote: `MARK-${index}` }]
      });
    }));

    const result = await extractWithLocalModel(markerDocument(), []);
    const marks = result.proposals.map((item) => item.rawValue).filter((value) => value.startsWith("MARK-"));

    expect(marks.length).toBeGreaterThan(1);
    expect([...marks].sort((a, b) => a.localeCompare(b))).toEqual(marks);
  });
});

describe("reviewer concurrency", () => {
  it("runs the evidence and adversarial passes at the same time", async () => {
    vi.stubEnv("LOCAL_EXTRACTION_CONCURRENCY", "4");
    let reviewInFlight = 0;
    let reviewPeak = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      const isReview = sent.messages[0].content.includes("reviewer");
      if (!isReview) return completion(EXTRACTION_BODY);
      reviewInFlight += 1;
      reviewPeak = Math.max(reviewPeak, reviewInFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      reviewInFlight -= 1;
      const parsed = JSON.parse(sent.messages[1].content) as { candidates?: Array<{ id: string }> };
      return completion({ approved_ids: (parsed.candidates ?? []).map((item) => item.id) });
    }));

    const result = await extractWithLocalModel(manySpanDocument(), []);

    expect(result.reviewSummary.consensusApproved).toBeGreaterThan(0);
    expect(reviewPeak).toBeGreaterThan(1);
  });

  it("still withholds a proposal when one reviewer pass rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      if (!sent.messages[0].content.includes("reviewer")) return completion(EXTRACTION_BODY);
      // The adversarial reviewer approves nothing, so consensus must fail even
      // though the evidence reviewer approved.
      const isAdversarial = sent.messages[0].content.includes("adversarial");
      const parsed = JSON.parse(sent.messages[1].content) as { candidates?: Array<{ id: string }> };
      return completion({
        approved_ids: isAdversarial ? [] : (parsed.candidates ?? []).map((item) => item.id)
      });
    }));

    const result = await extractWithLocalModel(manySpanDocument(), []);

    expect(result.reviewSummary.consensusApproved).toBe(0);
    expect(result.reviewSummary.withheld).toBeGreaterThan(0);
  });
});
