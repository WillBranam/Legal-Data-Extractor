import { describe, expect, it } from "vitest";
import { resolveOccurrenceException } from "@/lib/administrative-records";
import { reconcileOccurrences } from "@/lib/field-registry";
import type { FieldOccurrence, WorkspaceState } from "@/lib/types";
import { createEmptyWorkspace } from "@/lib/workspace";

function occurrence(overrides: Partial<FieldOccurrence> & { id: string }): FieldOccurrence {
  return {
    fieldDefinitionId: "FLD-1",
    subjectEntityId: null,
    documentId: "doc-1",
    rawValue: "value",
    normalizedValue: "value",
    valueType: "text",
    language: "en",
    citationIds: ["CIT-1"],
    pageNumber: 1,
    boundingBox: null,
    extractionConfidence: 0.8,
    normalizationConfidence: 0.9,
    status: "exception",
    exceptionReason: "Conflicting non-equivalent values were found for the same field and subject.",
    sourceLabel: "Label",
    ...overrides
  };
}

function workspaceWith(occurrences: FieldOccurrence[]): WorkspaceState {
  return { ...createEmptyWorkspace(), fieldOccurrences: occurrences } as WorkspaceState;
}

describe("exception resolution", () => {
  // Both conflict members carry the same field, subject and label, so this is a
  // genuine competing-value case that must reach a human.
  const conflictPair = [
    occurrence({ id: "OCC-A", normalizedValue: "111 First Street" }),
    occurrence({ id: "OCC-B", normalizedValue: "222 Second Avenue" })
  ];

  it("keeps a value the user accepted instead of reverting it to an exception", () => {
    const next = resolveOccurrenceException(workspaceWith(conflictPair), "OCC-A", "verify");
    const resolved = (next.fieldOccurrences ?? []).find((item) => item.id === "OCC-A");

    expect(resolved?.status).toBe("verified");
  });

  it("keeps a value the user withheld instead of reverting it to an exception", () => {
    const next = resolveOccurrenceException(workspaceWith(conflictPair), "OCC-A", "withhold");
    const resolved = (next.fieldOccurrences ?? []).find((item) => item.id === "OCC-A");

    expect(resolved?.status).toBe("withheld");
  });

  it("settles the whole conflict when the user picks one value", () => {
    const next = resolveOccurrenceException(workspaceWith(conflictPair), "OCC-A", "verify");
    const other = (next.fieldOccurrences ?? []).find((item) => item.id === "OCC-B");

    // Choosing one value answers the question the group was asking, so the
    // competing value must not stay in the queue demanding another decision.
    expect(other?.status).not.toBe("exception");
    expect((next.fieldOccurrences ?? []).filter((item) => item.status === "exception")).toHaveLength(0);
  });

  it("survives a later reconciliation pass", () => {
    const next = resolveOccurrenceException(workspaceWith(conflictPair), "OCC-A", "verify");
    const again = reconcileOccurrences(next.fieldOccurrences ?? []);

    expect(again.occurrences.find((item) => item.id === "OCC-A")?.status).toBe("verified");
  });
});

describe("automatic exception avoidance", () => {
  it("does not treat values under different source labels as competing", () => {
    // "Yes" to one question and "No" to another are unrelated answers that
    // happen to share a generic catch-all field.
    const result = reconcileOccurrences([
      occurrence({ id: "OCC-1", normalizedValue: "Yes", sourceLabel: "Interrogatories served", status: "verified" }),
      occurrence({ id: "OCC-2", normalizedValue: "No", sourceLabel: "Medical authorizations returned", status: "verified" })
    ]);

    expect(result.occurrences.every((item) => item.status === "verified")).toBe(true);
  });

  it("merges values that differ only in punctuation, case or spacing", () => {
    const result = reconcileOccurrences([
      occurrence({ id: "OCC-1", normalizedValue: "(626) 555-0198", status: "verified" }),
      occurrence({ id: "OCC-2", normalizedValue: "626-555-0198", status: "verified" })
    ]);

    expect(result.occurrences.every((item) => item.status === "verified")).toBe(true);
    expect(result.canonicalValues.filter((item) => item.resolutionStatus === "conflict")).toHaveLength(0);
  });

  it("still raises a genuine conflict between different values under one label", () => {
    const result = reconcileOccurrences([
      occurrence({ id: "OCC-1", normalizedValue: "111 First Street", status: "verified" }),
      occurrence({ id: "OCC-2", normalizedValue: "222 Second Avenue", status: "verified" })
    ]);

    expect(result.occurrences.every((item) => item.status === "exception")).toBe(true);
  });
});
