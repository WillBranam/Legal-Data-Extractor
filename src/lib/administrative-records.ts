import {
  defaultFieldDefinitions,
  dynamicFieldDefinition,
  entityForName,
  mergeRelationships,
  normalizeInformationValue,
  normalizeRelationshipType,
  reconcileOccurrences,
  relationshipId
} from "@/lib/field-registry";
import type { LocalExtractionProposal, LocalExtractionResult } from "@/lib/local-llm";
import type {
  Citation,
  Entity,
  EvidenceDocument,
  FieldDefinition,
  FieldOccurrence,
  Relationship,
  SignatureObservation,
  WorkspaceState
} from "@/lib/types";

function stableId(prefix: string, value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + first), 0x85ebca6b) >>> 0;
  }
  return `${prefix}-${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`.toUpperCase();
}

function rawValueCitation(document: EvidenceDocument, proposal: LocalExtractionProposal): Citation | null {
  const rawCharacterStart = proposal.exactQuote.indexOf(proposal.rawValue);
  if (rawCharacterStart < 0) return null;
  const encoder = new TextEncoder();
  const byteStart = proposal.canonicalByteStart + encoder.encode(proposal.exactQuote.slice(0, rawCharacterStart)).byteLength;
  const byteEnd = byteStart + encoder.encode(proposal.rawValue).byteLength;
  const exact = new TextDecoder("utf-8", { fatal: true }).decode(
    encoder.encode(document.canonicalText).slice(byteStart, byteEnd)
  );
  if (exact !== proposal.rawValue) return null;
  return {
    id: stableId("CIT", `${document.id}:${byteStart}:${byteEnd}:${proposal.rawValue}`),
    documentId: document.id,
    originalFileSha256: document.originalSha256,
    canonicalArtifactSha256: document.canonicalSha256,
    canonicalByteStart: byteStart,
    canonicalByteEnd: byteEnd,
    exactQuote: proposal.rawValue,
    pageNumber: proposal.pageNumber,
    structuralPath: `page:${proposal.pageNumber};label:${proposal.sourceLabel}`,
    parserVersion: document.parserVersion
  };
}

function registryMatch(proposal: LocalExtractionProposal, definitions: FieldDefinition[]): FieldDefinition | null {
  const exact = definitions.find((field) => field.canonicalKey === proposal.canonicalKey);
  if (exact) return exact;
  const labels = [proposal.sourceLabel, proposal.displayLabel].map((value) => value.toLocaleLowerCase("en-US").trim());
  return definitions.find((field) => field.sourceLabels.some((label) => labels.includes(label.toLocaleLowerCase("en-US")))) ?? null;
}

function upsertEntity(entities: Entity[], name: string | null, type: Entity["type"] | null): Entity | null {
  if (!name?.trim()) return null;
  const candidate = entityForName(name, type ?? "unknown");
  const existing = entities.find((entity) => entity.id === candidate.id);
  if (existing) {
    existing.nameVariants = [...new Set([...existing.nameVariants, name])];
    return existing;
  }
  entities.push(candidate);
  return candidate;
}

export function credibleProposalEntityName(
  name: string | null,
  rawValue: string,
  valueType: LocalExtractionProposal["valueType"],
  category: LocalExtractionProposal["category"]
): string | null {
  const candidate = name?.trim();
  if (!candidate) return null;
  const comparable = (value: string) => value.toLocaleLowerCase("en-US").normalize("NFKC").replaceAll(/[^a-z0-9]+/g, "");
  const valueCanNameItsOwnSubject = valueType === "name" && ["client", "party", "organization", "representative"].includes(category);
  if (!valueCanNameItsOwnSubject && comparable(candidate) === comparable(rawValue)) return null;
  if (["identifier", "phone", "email", "date", "datetime", "money", "number", "boolean"].includes(valueType)) {
    if (/@|\d{3,}/.test(candidate) || comparable(candidate) === comparable(rawValue)) return null;
  }
  return candidate;
}

function signatureFromProposal(input: {
  document: EvidenceDocument;
  proposal: LocalExtractionProposal;
  occurrence: FieldOccurrence;
  signer: Entity | null;
}): SignatureObservation | null {
  if (input.proposal.category !== "signature") return null;
  const normalized = `${input.proposal.sourceLabel} ${input.proposal.rawValue}`.toLocaleLowerCase("en-US");
  const status = /unsigned|not signed|signature missing/.test(normalized)
    ? "unsigned"
    : /signed|signature|initial/.test(normalized)
      ? "signature-mark-detected"
      : "unclear";
  const signatureType = /electronic|\/s\//.test(normalized)
    ? "electronic"
    : /initial/.test(normalized)
      ? "initials"
      : /typed/.test(normalized)
        ? "typed"
        : status === "signature-mark-detected" ? "handwritten-mark" : "unknown";
  const page = input.document.pages.find((item) => item.pageNumber === input.proposal.pageNumber);
  return {
    id: stableId("SIG", input.occurrence.id),
    documentId: input.document.id,
    status,
    signerEntityId: input.signer?.id ?? null,
    rawSignerName: input.signer?.nameVariants[0] ?? null,
    capacity: input.proposal.relationshipType,
    signatureDate: null,
    signatureType,
    pageNumber: input.proposal.pageNumber,
    boundingBox: null,
    pageImageSha256: page?.imageSha256 ?? null,
    regionSha256: null,
    nearbyTextCitationIds: input.occurrence.citationIds,
    detectorVersion: "administrative-text-anchor-v1",
    confidence: input.occurrence.extractionConfidence,
    reviewStatus: status === "unclear" || input.occurrence.extractionConfidence < 0.95 ? "exception" : "verified"
  };
}

function verifiedCaseNumbers(occurrences: FieldOccurrence[], definitions: FieldDefinition[]): Set<string> {
  const caseDefinitionIds = new Set(definitions.filter((field) => field.canonicalKey === "matter.case_number").map((field) => field.id));
  return new Set(occurrences.filter((item) => caseDefinitionIds.has(item.fieldDefinitionId) && item.status === "verified").map((item) => item.normalizedValue));
}

function partyFingerprint(occurrences: FieldOccurrence[], definitions: FieldDefinition[]): Set<string> {
  const partyIds = new Set(definitions.filter((field) => field.canonicalKey === "party.plaintiff_name" || field.canonicalKey === "party.defendant_name").map((field) => field.id));
  return new Set(occurrences.filter((item) => partyIds.has(item.fieldDefinitionId) && item.status === "verified").map((item) => item.normalizedValue.toLocaleLowerCase("en-US")));
}

export function applyAdministrativeExtraction(
  workspace: WorkspaceState,
  document: EvidenceDocument,
  result: LocalExtractionResult
): WorkspaceState {
  const definitions = [...(workspace.fieldDefinitions?.length ? workspace.fieldDefinitions : defaultFieldDefinitions())];
  const entities = (workspace.entities ?? []).map((item) => ({ ...item, nameVariants: [...item.nameVariants] }));
  const citations = [...workspace.citations];
  const newOccurrences: FieldOccurrence[] = [];
  const newRelationships: Relationship[] = [];
  const newSignatures: SignatureObservation[] = [];

  for (const proposal of result.proposals) {
    let definition = registryMatch(proposal, definitions);
    if (!definition) {
      definition = dynamicFieldDefinition({ documentType: result.documentType, label: proposal.sourceLabel || proposal.displayLabel, valueType: proposal.valueType });
      definitions.push(definition);
    }
    if (!definition.enabled) continue;
    const citation = rawValueCitation(document, proposal);
    if (!citation) continue;
    if (!citations.some((item) => item.id === citation.id)) citations.push(citation);
    const subjectName = credibleProposalEntityName(proposal.subjectName, proposal.rawValue, proposal.valueType, proposal.category);
    const subject = upsertEntity(entities, subjectName, proposal.subjectType);
    const normalized = normalizeInformationValue(proposal.rawValue, definition.valueType);
    const pageConfidence = document.pages.find((item) => item.pageNumber === proposal.pageNumber)?.ocrConfidence ?? 1;
    const effectiveExtractionConfidence = Math.min(proposal.confidence, pageConfidence);
    const sensitiveExact = definition.sensitivity === "restricted-identifier";
    const exactEnough = !sensitiveExact || (effectiveExtractionConfidence >= 0.98 && normalized.confidence >= 0.99);
    const status = effectiveExtractionConfidence >= 0.9 && normalized.confidence >= 0.9 && !normalized.ambiguous && exactEnough
      ? "verified" as const
      : "exception" as const;
    const occurrence: FieldOccurrence = {
      id: stableId("OCC", `${document.id}:${definition.id}:${citation.id}:${subject?.id ?? "matter"}`),
      fieldDefinitionId: definition.id,
      subjectEntityId: subject?.id ?? null,
      documentId: document.id,
      rawValue: proposal.rawValue,
      normalizedValue: normalized.value,
      valueType: definition.valueType,
      language: result.language,
      citationIds: [citation.id],
      pageNumber: proposal.pageNumber,
      boundingBox: null,
      extractionConfidence: effectiveExtractionConfidence,
      normalizationConfidence: normalized.confidence,
      status,
      exceptionReason: status === "verified" ? null : sensitiveExact && !exactEnough
        ? "Sensitive identifiers publish automatically only at exact model confidence with deterministic character validation."
        : normalized.ambiguous ? "The source value is ambiguous and was preserved without guessing." : "The value did not meet the automatic publication threshold.",
      sourceLabel: proposal.sourceLabel
    };
    newOccurrences.push(occurrence);

    const targetName = credibleProposalEntityName(proposal.relatedEntityName, proposal.rawValue, proposal.valueType, proposal.category);
    const target = upsertEntity(entities, targetName, "unknown");
    if (subject && target && subject.id !== target.id && proposal.relationshipType) {
      const relationshipType = normalizeRelationshipType(proposal.relationshipType);
      newRelationships.push({
        id: relationshipId(subject.id, relationshipType, target.id),
        sourceEntityId: subject.id,
        relationshipType,
        targetEntityId: target.id,
        occurrenceIds: [occurrence.id],
        status
      });
    }
    const signature = signatureFromProposal({ document, proposal, occurrence, signer: subject });
    if (signature) newSignatures.push(signature);
  }

  const priorOccurrences = (workspace.fieldOccurrences ?? []).filter((item) => item.documentId !== document.id);
  let occurrences = [...priorOccurrences, ...newOccurrences];
  const priorCaseNumbers = verifiedCaseNumbers(priorOccurrences, definitions);
  const newCaseNumbers = verifiedCaseNumbers(newOccurrences, definitions);
  const conflictingCaseNumber = priorCaseNumbers.size > 0 && newCaseNumbers.size > 0 && [...newCaseNumbers].every((value) => !priorCaseNumbers.has(value));
  const priorParties = partyFingerprint(priorOccurrences, definitions);
  const newParties = partyFingerprint(newOccurrences, definitions);
  const partyMismatch = !conflictingCaseNumber && priorParties.size >= 2 && newParties.size >= 2 && [...newParties].every((value) => !priorParties.has(value));
  const documents = workspace.documents.map((item) => item.id === document.id ? {
    ...item,
    documentType: result.documentType,
    detectedLanguage: result.language,
    matterMatchStatus: conflictingCaseNumber ? "quarantined" as const : partyMismatch ? "review" as const : "matched" as const,
    matterMatchReason: conflictingCaseNumber ? "An explicit case number conflicts with the established matter fingerprint." : partyMismatch ? "The explicitly labeled plaintiff/defendant set does not overlap the established matter parties." : null,
    extractionState: "complete" as const,
    extractionError: null,
    extractedAt: new Date().toISOString()
  } : item);
  if (conflictingCaseNumber || partyMismatch) {
    occurrences = occurrences.map((item) => item.documentId === document.id ? { ...item, status: "exception" as const, exceptionReason: conflictingCaseNumber ? "Document quarantined because its case number conflicts with this matter." : "Document requires matter confirmation because its labeled parties do not match the established party fingerprint." } : item);
  }
  const reconciled = reconcileOccurrences(occurrences);
  return {
    ...workspace,
    schemaVersion: 2,
    documents,
    citations,
    fieldDefinitions: definitions,
    fieldOccurrences: reconciled.occurrences,
    canonicalValues: reconciled.canonicalValues,
    entities,
    relationships: mergeRelationships([...(workspace.relationships ?? []).filter((item) => !item.occurrenceIds.some((id) => newOccurrences.some((occurrence) => occurrence.id === id))), ...newRelationships]),
    signatures: [...(workspace.signatures ?? []).filter((item) => item.documentId !== document.id), ...newSignatures],
    extractionSpecification: workspace.extractionSpecification ?? {
      version: 2,
      fieldDefinitionIds: definitions.filter((field) => field.enabled).map((field) => field.id),
      customInstructions: "",
      detectedDocumentTypes: [result.documentType],
      detectedLanguages: [result.language],
      confirmedAt: null
    }
  };
}

/**
 * Records a human decision on one exception and settles the group it belonged
 * to. Choosing a value answers the question the conflict was asking, so the
 * values it competed with are withheld rather than left in the queue demanding
 * another decision for the same field.
 */
export function resolveOccurrenceException(workspace: WorkspaceState, occurrenceId: string, decision: "verify" | "withhold"): WorkspaceState {
  const all = workspace.fieldOccurrences ?? [];
  const target = all.find((item) => item.id === occurrenceId);
  const groupKey = (item: FieldOccurrence): string =>
    `${item.fieldDefinitionId}:${item.subjectEntityId ?? "matter"}:${item.sourceLabel.toLocaleLowerCase("en-US").replaceAll(/[^a-z0-9]+/g, " ").trim()}`;
  const occurrences = all.map((item) => {
    if (item.id === occurrenceId) {
      return {
        ...item,
        status: decision === "verify" ? "verified" as const : "withheld" as const,
        exceptionReason: decision === "verify" ? null : "Withheld by user during exception review.",
        decidedByUser: true
      };
    }
    const competing = decision === "verify"
      && target
      && item.status === "exception"
      && !item.decidedByUser
      && groupKey(item) === groupKey(target);
    if (competing) {
      return {
        ...item,
        status: "withheld" as const,
        exceptionReason: "Superseded by the value chosen during exception review.",
        decidedByUser: true
      };
    }
    return item;
  });
  const reconciled = reconcileOccurrences(occurrences);
  return { ...workspace, fieldOccurrences: reconciled.occurrences, canonicalValues: reconciled.canonicalValues };
}

export function resolveDocumentMatterMatch(workspace: WorkspaceState, documentId: string, decision: "attach" | "exclude"): WorkspaceState {
  const documents = workspace.documents.map((item) => item.id === documentId ? { ...item, matterMatchStatus: decision === "attach" ? "matched" as const : "excluded" as const, matterMatchReason: decision === "attach" ? null : "Document explicitly excluded from this matter by the user." } : item);
  const occurrences = (workspace.fieldOccurrences ?? []).map((item) => item.documentId !== documentId ? item : decision === "exclude" ? { ...item, status: "withheld" as const, exceptionReason: "Source document was explicitly excluded from this matter." } : item.exceptionReason?.includes("Document quarantined") || item.exceptionReason?.includes("requires matter confirmation") ? { ...item, status: "verified" as const, exceptionReason: null } : item);
  const reconciled = reconcileOccurrences(occurrences);
  return { ...workspace, documents, fieldOccurrences: reconciled.occurrences, canonicalValues: reconciled.canonicalValues };
}
