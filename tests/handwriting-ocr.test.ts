import { describe, expect, it } from "vitest";
import {
  orphanedLabelCount,
  preferPairedTranscription,
  suggestsUnreadFormValues
} from "@/lib/ocr";

// Shaped after real PP-OCRv5 output on a scanned fact sheet: the printed
// labels are read cleanly and the handwritten answers land on their own lines,
// or are missed entirely.
const PADDLE_PAGE = [
  "PLAINTIFF FACT SHEET",
  "Patient Provider(s)' Date of Birth:",
  "07191968",
  "Patient Provider(s)' Home Address:",
  "Claim Number:",
  "Adjuster:",
  "Date of Loss:"
].join("\n");

const VISION_PAGE = [
  "PLAINTIFF FACT SHEET",
  "Patient Provider(s)' Date of Birth: 07/19/1968",
  "Patient Provider(s)' Home Address: 1188 Winterset Lane",
  "Claim Number: CFS-2024-119703",
  "Adjuster: Raymond Ellis",
  "Date of Loss: 09/28/2023"
].join("\n");

const PROSE_PAGE = [
  "If the spaces provided in the enclosed Plaintiff Fact Sheet are insufficient,",
  "please attach additional pages as needed and return the completed form."
].join("\n");

describe("orphaned label detection", () => {
  it("counts labels whose value is missing or on the next line", () => {
    expect(orphanedLabelCount(PADDLE_PAGE)).toBe(5);
  });

  it("does not count a label that carries its value on the same line", () => {
    expect(orphanedLabelCount(VISION_PAGE)).toBe(0);
  });

  it("does not count ordinary prose", () => {
    expect(orphanedLabelCount(PROSE_PAGE)).toBe(0);
  });
});

describe("handwriting escalation", () => {
  it("escalates a form page whose answers were not read", () => {
    // Confidence is high on this page because the printed labels read cleanly;
    // the unread handwriting never enters the mean, so coverage decides.
    expect(suggestsUnreadFormValues(PADDLE_PAGE)).toBe(true);
  });

  it("does not escalate a page that already pairs its values", () => {
    expect(suggestsUnreadFormValues(VISION_PAGE)).toBe(false);
  });

  it("does not escalate prose, which has no labels to pair", () => {
    expect(suggestsUnreadFormValues(PROSE_PAGE)).toBe(false);
  });
});

describe("choosing between two transcriptions", () => {
  it("prefers the transcription that pairs more labels with values", () => {
    const chosen = preferPairedTranscription(
      { text: PADDLE_PAGE, confidence: 0.93, engine: "pp-ocrv5" },
      { text: VISION_PAGE, confidence: 0.75, engine: "qwen3-vl" }
    );

    expect(chosen.engine).toBe("qwen3-vl");
  });

  it("keeps the original when the second transcription lost content", () => {
    const chosen = preferPairedTranscription(
      { text: PADDLE_PAGE, confidence: 0.93, engine: "pp-ocrv5" },
      { text: "Fact Sheet", confidence: 0.75, engine: "qwen3-vl" }
    );

    expect(chosen.engine).toBe("pp-ocrv5");
  });

  it("keeps the original when the second transcription is empty", () => {
    const chosen = preferPairedTranscription(
      { text: PADDLE_PAGE, confidence: 0.93, engine: "pp-ocrv5" },
      { text: "   ", confidence: 0, engine: "qwen3-vl" }
    );

    expect(chosen.engine).toBe("pp-ocrv5");
  });
});
