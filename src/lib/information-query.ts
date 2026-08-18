import type { InformationAnswerItem, InformationQueryAnswer, WorkspaceState } from "@/lib/types";

const STOP_WORDS = new Set(["all", "and", "are", "associated", "connected", "documents", "for", "from", "information", "is", "number", "numbers", "of", "show", "the", "these", "to", "what", "which", "who", "with"]);

const SYNONYMS: Record<string, string[]> = {
  attorney: ["counsel", "representative", "lawyer"],
  counsel: ["attorney", "representative", "lawyer"],
  client: ["party", "claimant"],
  docket: ["case", "number"],
  email: ["contact"],
  firm: ["organization", "counsel"],
  phone: ["telephone", "mobile", "contact"],
  signed: ["signature", "signer"],
  ssn: ["social", "security", "identifier"],
  served: ["service", "date"],
  unsigned: ["signature", "unclear"]
};

function tokens(value: string): string[] {
  return value.toLocaleLowerCase("en-US").normalize("NFKD").replaceAll(/[^a-z0-9]+/g, " ").split(" ").filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function requestedFieldIntent(question: string): ((canonicalKey: string, category: string) => boolean) | null {
  const normalized = question.toLocaleLowerCase("en-US");
  if (/\b(phone|telephone|mobile|cell)\b/.test(normalized)) return (key) => key === "contact.phone";
  if (/\b(e-?mail)\b/.test(normalized)) return (key) => key === "contact.email";
  if (/\b(ssn|social security)\b/.test(normalized)) return (key) => key === "identifier.ssn";
  if (/\b(case|docket)\b.*\b(number|no\.?|#)\b|\b(case|docket)\s*(number|no\.?|#)/.test(normalized)) return (key) => key === "matter.case_number";
  if (/\b(signature|signed|signer|unsigned)\b/.test(normalized)) return (_key, category) => category === "signature";
  if (/\b(service|served)\b.*\b(date|when)\b|\b(date|when)\b.*\b(service|served)\b/.test(normalized)) return (key) => key === "date.service";
  return null;
}

export function queryAdministrativeInformation(question: string, workspace: WorkspaceState, limit = 50): InformationQueryAnswer {
  const terms = [...new Set(tokens(question).flatMap((term) => [term, ...(SYNONYMS[term] ?? [])]))];
  const fieldIntent = requestedFieldIntent(question);
  const definitions = new Map((workspace.fieldDefinitions ?? []).map((item) => [item.id, item]));
  const entities = new Map((workspace.entities ?? []).map((item) => [item.id, item]));
  const documents = new Map(workspace.documents.map((item) => [item.id, item]));
  const relationshipText = new Map<string, string[]>();
  for (const relationship of workspace.relationships ?? []) {
    if (relationship.status !== "verified") continue;
    const text = `${entities.get(relationship.sourceEntityId)?.canonicalName ?? ""} ${relationship.relationshipType} ${entities.get(relationship.targetEntityId)?.canonicalName ?? ""}`;
    for (const occurrenceId of relationship.occurrenceIds) relationshipText.set(occurrenceId, [...(relationshipText.get(occurrenceId) ?? []), text]);
  }
  const items = (workspace.fieldOccurrences ?? [])
    .filter((occurrence) => occurrence.status === "verified" && !["quarantined", "excluded"].includes(documents.get(occurrence.documentId)?.matterMatchStatus ?? "matched"))
    .filter((occurrence) => {
      if (!fieldIntent) return true;
      const definition = definitions.get(occurrence.fieldDefinitionId);
      return fieldIntent(definition?.canonicalKey ?? "", definition?.category ?? "other");
    })
    .map((occurrence): InformationAnswerItem => {
      const definition = definitions.get(occurrence.fieldDefinitionId);
      const subject = occurrence.subjectEntityId ? entities.get(occurrence.subjectEntityId)?.canonicalName ?? null : null;
      const search = new Set(tokens(`${definition?.canonicalKey ?? ""} ${definition?.displayLabel ?? ""} ${definition?.category ?? "other"} ${definition?.sourceLabels.join(" ") ?? ""} ${occurrence.sourceLabel} ${occurrence.rawValue} ${occurrence.normalizedValue} ${subject ?? ""} ${(relationshipText.get(occurrence.id) ?? []).join(" ")} ${documents.get(occurrence.documentId)?.name ?? ""}`));
      const score = terms.length === 0 ? 1 : terms.reduce((total, term) => total + (search.has(term) ? 2 : [...search].some((token) => token.startsWith(term) || term.startsWith(token)) ? 1 : 0), 0);
      return {
        occurrenceId: occurrence.id,
        label: definition?.displayLabel ?? occurrence.sourceLabel,
        normalizedValue: occurrence.normalizedValue,
        rawValue: occurrence.rawValue,
        subject,
        category: definition?.category ?? "other",
        documentId: occurrence.documentId,
        citationIds: occurrence.citationIds,
        score
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, limit);
  return { status: items.length ? "verified" : "insufficient_information", question, items };
}
