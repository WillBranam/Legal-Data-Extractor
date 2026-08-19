import { describe, expect, it } from "vitest";
import { normalizeInformationValue, reconcileOccurrences } from "@/lib/field-registry";
import { queryAdministrativeInformation } from "@/lib/information-query";
import { credibleProposalEntityName } from "@/lib/administrative-records";
import { deterministicLabeledProposals, localExtractionProposalIdentity } from "@/lib/local-llm";
import { createEmptyWorkspace, migrateWorkspaceToV2 } from "@/lib/workspace";
import type { FieldOccurrence } from "@/lib/types";

describe("administrative normalization and lookup", () => {
  it("retains identifier characters in raw values and preserves leading zeros in normalized text", () => { expect(normalizeInformationValue("ABC 001-24", "identifier").value).toBe("ABC00124"); expect(normalizeInformationValue("001234", "identifier").value).toBe("001234"); });
  it("marks ambiguous numeric dates instead of guessing", () => { expect(normalizeInformationValue("03/04/26", "date")).toMatchObject({ value: "03/04/26", ambiguous: true }); });
  it("repairs an empty v2 field registry without replacing existing workspace data", () => {
    const workspace = createEmptyWorkspace(new Date("2026-08-13T00:00:00Z"));
    workspace.fieldDefinitions = [];
    workspace.documents = [{ id: "DOC", name: "Intake.txt", mediaType: "text/plain", size: 1, originalSha256: "a".repeat(64), canonicalSha256: "b".repeat(64), canonicalText: "X", canonicalByteLength: 1, parserVersion: "test", pageCount: 1, pages: [], processingDurationMs: 1, ocrPageCount: 0, ocrMeanConfidence: null, ingestedAt: "2026-08-13T00:00:00Z", processingState: "ready" }];
    const migrated = migrateWorkspaceToV2(workspace);
    expect(migrated.fieldDefinitions?.length).toBeGreaterThan(30);
    expect(migrated.documents).toHaveLength(1);
  });
  it("turns non-equivalent values for one field and subject into exceptions", () => { const base = { fieldDefinitionId: "FLD", subjectEntityId: "ENT", documentId: "DOC", valueType: "identifier" as const, language: "en" as const, citationIds: ["CIT"], pageNumber: 1, boundingBox: null, extractionConfidence: 1, normalizationConfidence: 1, status: "verified" as const, exceptionReason: null, sourceLabel: "Case number" }; const values: FieldOccurrence[] = [{ ...base, id: "O1", rawValue: "001", normalizedValue: "001" }, { ...base, id: "O2", rawValue: "002", normalizedValue: "002" }]; const result = reconcileOccurrences(values); expect(result.canonicalValues.every((item) => item.resolutionStatus === "conflict")).toBe(true); expect(result.occurrences.every((item) => item.status === "exception")).toBe(true); });
  it("queries verified typed information without using legacy narrative facts", () => { const workspace = createEmptyWorkspace(new Date("2026-08-13T00:00:00Z")); const field = workspace.fieldDefinitions!.find((item) => item.canonicalKey === "contact.phone")!; workspace.documents = [{ id: "DOC", name: "Intake.pdf", mediaType: "application/pdf", size: 1, originalSha256: "a".repeat(64), canonicalSha256: "b".repeat(64), canonicalText: "", canonicalByteLength: 0, parserVersion: "test", pageCount: 1, pages: [], processingDurationMs: 1, ocrPageCount: 0, ocrMeanConfidence: null, ingestedAt: "2026-08-13T00:00:00Z", processingState: "ready", matterMatchStatus: "matched" }]; workspace.fieldOccurrences = [{ id: "O1", fieldDefinitionId: field.id, subjectEntityId: null, documentId: "DOC", rawValue: "(404) 555-0198", normalizedValue: "4045550198", valueType: "phone", language: "en", citationIds: ["C1"], pageNumber: 1, boundingBox: null, extractionConfidence: 1, normalizationConfidence: .98, status: "verified", exceptionReason: null, sourceLabel: "Phone" }]; workspace.facts = [{ id: "LEGACY", matterId: workspace.matter.id, type: "Allegation", statement: "Narrative statement", eventDate: null, confidence: 1, status: "approved", citationIds: [], reviewer: "legacy", reviewedAt: null }]; const answer = queryAdministrativeInformation("What phone numbers are listed?", workspace); expect(answer.items).toHaveLength(1); expect(answer.items[0].normalizedValue).toBe("4045550198"); });
  it("uses explicit query intent instead of returning every contact or numbered field", () => {
    const workspace = createEmptyWorkspace(new Date("2026-08-13T00:00:00Z"));
    workspace.documents = [{ id: "DOC", name: "Intake.txt", mediaType: "text/plain", size: 1, originalSha256: "a".repeat(64), canonicalSha256: "b".repeat(64), canonicalText: "", canonicalByteLength: 0, parserVersion: "test", pageCount: 1, pages: [], processingDurationMs: 1, ocrPageCount: 0, ocrMeanConfidence: null, ingestedAt: "2026-08-13T00:00:00Z", processingState: "ready", matterMatchStatus: "matched" }];
    const keys = ["contact.phone", "contact.email", "matter.case_number", "party.client_name"];
    workspace.fieldOccurrences = keys.map((key, index) => {
      const field = workspace.fieldDefinitions!.find((item) => item.canonicalKey === key)!;
      return { id: `O${index}`, fieldDefinitionId: field.id, subjectEntityId: null, documentId: "DOC", rawValue: ["(404) 555-0198", "client@example.test", "24-CV-001", "Maria Sanchez"][index], normalizedValue: ["4045550198", "client@example.test", "24CV001", "Maria Sanchez"][index], valueType: field.valueType, language: "en" as const, citationIds: [`C${index}`], pageNumber: 1, boundingBox: null, extractionConfidence: 1, normalizationConfidence: 1, status: "verified" as const, exceptionReason: null, sourceLabel: field.displayLabel };
    });
    const answer = queryAdministrativeInformation("What is the client phone number?", workspace);
    expect(answer.items.map((item) => item.label)).toEqual(["Phone number"]);
  });
  it("captures exact labeled values deterministically before model discovery", () => {
    const workspace = createEmptyWorkspace(new Date("2026-08-13T00:00:00Z"));
    const text = "Client name: Maria Sanchez\nCase number: 24-CV-001\nPhone: (404) 555-0198";
    const document = { id: "DOC", name: "Intake.txt", mediaType: "text/plain", size: text.length, originalSha256: "a".repeat(64), canonicalSha256: "b".repeat(64), canonicalText: text, canonicalByteLength: new TextEncoder().encode(text).byteLength, parserVersion: "test", pageCount: 1, pages: [{ pageNumber: 1, extractionMethod: "native-text" as const, canonicalByteStart: 0, canonicalByteEnd: new TextEncoder().encode(text).byteLength, width: null, height: null, imageSha256: null, ocrConfidence: null }], processingDurationMs: 1, ocrPageCount: 0, ocrMeanConfidence: null, ingestedAt: "2026-08-13T00:00:00Z", processingState: "ready" as const };
    const proposals = deterministicLabeledProposals(document, 1, text, workspace.fieldDefinitions!);
    expect(proposals.map((item) => [item.canonicalKey, item.rawValue])).toEqual([["party.client_name", "Maria Sanchez"], ["matter.case_number", "24-CV-001"], ["contact.phone", "(404) 555-0198"]]);
  });
  it("rejects identifiers and contacts as their own entity subjects", () => {
    expect(credibleProposalEntityName("(404) 555-0198", "(404) 555-0198", "phone", "contact")).toBeNull();
    expect(credibleProposalEntityName("client@example.test", "client@example.test", "email", "contact")).toBeNull();
    expect(credibleProposalEntityName("Maria Sanchez", "Maria Sanchez", "name", "client")).toBe("Maria Sanchez");
  });
  it("deduplicates the same field value when model and deterministic quotes use different spans", () => {
    const base = { canonicalKey: "matter.case_number", displayLabel: "Case number", category: "matter" as const, valueType: "identifier" as const, sourceLabel: "Case number", rawValue: "SYN-25-CV-1042", subjectName: null, subjectType: null, relationshipType: null, relatedEntityName: null, confidence: 1, pageNumber: 1 };
    expect(localExtractionProposalIdentity({ ...base, exactQuote: "Case number: SYN-25-CV-1042", canonicalByteStart: 10, canonicalByteEnd: 38 })).toBe(localExtractionProposalIdentity({ ...base, exactQuote: "SYN-25-CV-1042", canonicalByteStart: 23, canonicalByteEnd: 38 }));
  });
});
