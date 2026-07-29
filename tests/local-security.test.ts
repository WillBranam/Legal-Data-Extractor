import { describe, expect, it } from "vitest";
import { spreadsheetSafeText } from "@/lib/exports";
import {
  validatedLocalModelEndpoint,
  validatedLocalModelName
} from "@/lib/local-llm";

describe("offline security boundaries", () => {
  it("accepts only HTTP loopback model endpoints", () => {
    expect(validatedLocalModelEndpoint("http://127.0.0.1:11434").origin).toBe(
      "http://127.0.0.1:11434"
    );
    expect(validatedLocalModelEndpoint("http://localhost:11434").hostname).toBe(
      "localhost"
    );
    expect(() =>
      validatedLocalModelEndpoint("https://api.example.com")
    ).toThrow("LOCAL_MODEL_MUST_USE_LOOPBACK");
    expect(() =>
      validatedLocalModelEndpoint("http://192.168.1.20:11434")
    ).toThrow("LOCAL_MODEL_MUST_USE_LOOPBACK");
  });

  it("rejects cloud-capable or malformed model identifiers", () => {
    expect(validatedLocalModelName("qwen3:8b")).toBe("qwen3:8b");
    expect(() => validatedLocalModelName("gpt-oss:cloud")).toThrow(
      "LOCAL_MODEL_NAME_REQUIRED"
    );
    expect(() => validatedLocalModelName("https://provider.example/model")).toThrow(
      "LOCAL_MODEL_NAME_REQUIRED"
    );
  });

  it("neutralizes spreadsheet formulas while preserving ordinary evidence", () => {
    expect(spreadsheetSafeText("=HYPERLINK(\"https://example.test\")")).toBe(
      "'=HYPERLINK(\"https://example.test\")"
    );
    expect(spreadsheetSafeText("  +1+1")).toBe("'  +1+1");
    expect(spreadsheetSafeText("\t@SUM(A1:A2)")).toBe("'\t@SUM(A1:A2)");
    expect(spreadsheetSafeText("Ordinary source text")).toBe("Ordinary source text");
  });
});
