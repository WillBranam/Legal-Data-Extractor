import type {
  CanonicalValue,
  Entity,
  FieldCategory,
  FieldDefinition,
  FieldOccurrence,
  FieldValueType,
  InformationStatus,
  Relationship
} from "@/lib/types";

type RegistrySeed = Omit<FieldDefinition, "id" | "schemaVersion" | "enabled" | "dynamic">;

const seeds: RegistrySeed[] = [
  ["matter.case_caption", "Case caption", "matter", "text", false, "matter", "confidential", "trim", ["case name", "case caption", "plaintiff/petitioner", "defendant/respondent"]],
  ["matter.case_number", "Case or docket number", "matter", "identifier", true, "matter", "confidential", "identifier", ["case no", "case number", "civil action no", "docket number", "file no", "reference number"]],
  ["matter.court", "Court", "matter", "text", true, "matter", "confidential", "title", ["court", "superior court", "district court"]],
  ["matter.jurisdiction", "Jurisdiction", "matter", "text", true, "matter", "confidential", "title", ["jurisdiction", "county", "district", "division", "branch"]],
  ["matter.judge", "Judge or magistrate", "matter", "name", true, "person", "confidential", "name", ["judge", "magistrate judge", "assigned judge"]],
  ["matter.related_case_number", "Related case number", "matter", "identifier", true, "matter", "confidential", "identifier", ["related case", "related cases", "related case number"]],
  ["document.form_number", "Form number", "document", "identifier", true, "document", "standard", "identifier", ["form no", "form number", "judicial council form"]],
  ["document.title", "Document title", "document", "text", true, "document", "standard", "title", ["document title", "title"]],
  ["document.status", "Document status", "document", "text", true, "document", "confidential", "trim", ["status", "filing status", "authorization status"]],
  ["party.client_name", "Client name", "client", "name", true, "person", "confidential", "name", ["client", "client name", "prospective client"]],
  ["party.plaintiff_name", "Plaintiff or petitioner", "party", "name", true, "any", "confidential", "name", ["plaintiff", "plaintiffs", "petitioner", "petitioners"]],
  ["party.defendant_name", "Defendant or respondent", "party", "name", true, "any", "confidential", "name", ["defendant", "defendants", "respondent", "respondents"]],
  ["party.other_name", "Other named party", "party", "name", true, "any", "confidential", "name", ["claimant", "insured", "beneficiary", "guardian", "agent", "custodian", "witness", "party served"]],
  ["person.alias", "Alias or prior name", "party", "name", true, "person", "confidential", "name", ["alias", "also known as", "aka", "formerly known as", "prior name"]],
  ["organization.name", "Organization or firm", "organization", "name", true, "organization", "confidential", "name", ["organization", "company", "firm", "law firm", "employer", "insurer", "provider", "agency"]],
  ["representative.attorney_name", "Attorney or representative", "representative", "name", true, "person", "confidential", "name", ["attorney", "attorney of record", "counsel", "representative", "server"]],
  ["representative.firm_name", "Firm name", "representative", "name", true, "organization", "confidential", "name", ["firm name", "law firm"]],
  ["representative.bar_number", "Bar number", "identifier", "identifier", true, "person", "confidential", "identifier", ["bar number", "state bar no", "bar no"]],
  ["identifier.ssn", "Social Security number", "identifier", "identifier", true, "person", "restricted-identifier", "ssn", ["ssn", "social security number", "social security no"]],
  ["identifier.tax_id", "Tax identifier", "identifier", "identifier", true, "any", "restricted-identifier", "identifier", ["ein", "tin", "tax id", "taxpayer identification number"]],
  ["identifier.drivers_license", "Driver's license number", "identifier", "identifier", true, "person", "restricted-identifier", "identifier", ["driver license", "driver's license", "dl number"]],
  ["identifier.passport", "Passport number", "identifier", "identifier", true, "person", "restricted-identifier", "identifier", ["passport", "passport number"]],
  ["identifier.medical_record", "Medical record number", "identifier", "identifier", true, "person", "restricted-identifier", "identifier", ["medical record number", "mrn"]],
  ["identifier.member_id", "Member ID", "identifier", "identifier", true, "person", "restricted-identifier", "identifier", ["member id", "subscriber id"]],
  ["identifier.policy_number", "Policy number", "identifier", "identifier", true, "any", "restricted-identifier", "identifier", ["policy number", "policy no"]],
  ["identifier.claim_number", "Claim number", "identifier", "identifier", true, "any", "restricted-identifier", "identifier", ["claim number", "claim no"]],
  ["identifier.account_number", "Account number", "identifier", "identifier", true, "any", "restricted-identifier", "identifier", ["account number", "account no"]],
  ["identifier.invoice_number", "Invoice number", "identifier", "identifier", true, "any", "confidential", "identifier", ["invoice number", "invoice no"]],
  ["contact.phone", "Phone number", "contact", "phone", true, "any", "confidential", "phone", ["phone", "telephone", "mobile", "cell"]],
  ["contact.email", "Email address", "contact", "email", true, "any", "confidential", "email", ["email", "e-mail", "electronic service address"]],
  ["contact.address", "Address", "contact", "address", true, "any", "confidential", "address", ["address", "mailing address", "street address", "residence", "service address"]],
  ["contact.fax", "Fax number", "contact", "phone", true, "any", "confidential", "phone", ["fax", "fax number"]],
  ["date.filing", "Filing date", "date", "date", true, "matter", "confidential", "date", ["filing date", "filed", "date filed"]],
  ["date.execution", "Execution or effective date", "date", "date", true, "document", "confidential", "date", ["execution date", "effective date", "executed"]],
  ["date.service", "Service date", "date", "date", true, "document", "confidential", "date", ["date served", "service date", "served on"]],
  ["date.signature", "Signature date", "date", "date", true, "document", "confidential", "date", ["signature date", "signed on", "date signed"]],
  ["date.deadline", "Deadline or response date", "date", "date", true, "matter", "confidential", "date", ["deadline", "due date", "response date", "expiration date"]],
  ["signature.status", "Signature status", "signature", "text", true, "document", "confidential", "signature", ["signature", "signed", "initials"]],
  ["administrative.service_method", "Service method", "administrative", "text", true, "document", "confidential", "trim", ["method of service", "served by", "personal service", "substituted service"]],
  ["administrative.checkbox", "Selected option", "administrative", "text", true, "document", "confidential", "trim", ["checked", "selected", "yes", "no"]],
  ["administrative.amount", "Stated amount or rate", "administrative", "money", true, "any", "confidential", "money", ["amount", "fee", "rate", "demand", "coverage"]]
].map(([canonicalKey, displayLabel, category, valueType, repeatable, subjectType, sensitivity, normalizationRule, sourceLabels]) => ({
  canonicalKey: canonicalKey as string,
  displayLabel: displayLabel as string,
  category: category as FieldCategory,
  valueType: valueType as FieldValueType,
  repeatable: repeatable as boolean,
  subjectType: subjectType as RegistrySeed["subjectType"],
  sensitivity: sensitivity as RegistrySeed["sensitivity"],
  normalizationRule: normalizationRule as string,
  sourceLabels: sourceLabels as string[]
}));

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

export function defaultFieldDefinitions(): FieldDefinition[] {
  return seeds.map((seed) => ({ ...seed, id: stableId("FLD", seed.canonicalKey), schemaVersion: 2, enabled: true, dynamic: false }));
}

export function dynamicFieldDefinition(input: { documentType: string; label: string; valueType: FieldValueType }): FieldDefinition {
  const namespace = input.documentType.toLowerCase().normalize("NFKD").replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "") || "document";
  const field = input.label.toLowerCase().normalize("NFKD").replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "") || "important_field";
  const canonicalKey = `${namespace}.${field}`.slice(0, 160);
  return {
    id: stableId("FLD", canonicalKey), canonicalKey, displayLabel: input.label.trim(), category: "other",
    valueType: input.valueType, repeatable: true, subjectType: "any", sensitivity: "confidential",
    normalizationRule: input.valueType, sourceLabels: [input.label.trim()], schemaVersion: 2, enabled: true, dynamic: true
  };
}

export function normalizeInformationValue(rawValue: string, valueType: FieldValueType): { value: string; confidence: number; ambiguous: boolean } {
  const raw = rawValue.normalize("NFKC").trim().replaceAll(/\s+/g, " ");
  if (valueType === "email") return { value: raw.toLowerCase(), confidence: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? 1 : 0.55, ambiguous: false };
  if (valueType === "phone") {
    const digits = raw.replaceAll(/\D/g, "");
    const value = raw.trim().startsWith("+") ? `+${digits}` : digits;
    return { value, confidence: value.length >= 10 ? 0.98 : 0.5, ambiguous: false };
  }
  if (valueType === "identifier") return { value: raw.replaceAll(/[^\p{L}\p{N}]/gu, "").toUpperCase(), confidence: raw.length > 0 ? 0.99 : 0, ambiguous: false };
  if (valueType === "name") return { value: raw.toLocaleLowerCase("en-US").replaceAll(/(^|[\s'-])\p{L}/gu, (part) => part.toLocaleUpperCase("en-US")), confidence: 0.92, ambiguous: false };
  if (valueType === "money") return { value: raw.replaceAll(/\s/g, ""), confidence: /^[($-]?[\d,.]+\)?$/.test(raw) ? 0.98 : 0.7, ambiguous: false };
  if (valueType === "date" || valueType === "datetime") {
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return { value: raw, confidence: 1, ambiguous: false };
    const numeric = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (numeric) {
      const [, a, b, y] = numeric;
      const ambiguous = Number(a) <= 12 && Number(b) <= 12;
      if (ambiguous) return { value: raw, confidence: 0.6, ambiguous: true };
      const year = y.length === 2 ? `20${y}` : y;
      const month = Number(a) > 12 ? b : a;
      const day = Number(a) > 12 ? a : b;
      return { value: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`, confidence: 0.9, ambiguous: false };
    }
    return { value: raw, confidence: 0.65, ambiguous: true };
  }
  return { value: raw, confidence: raw.length > 0 ? 0.95 : 0, ambiguous: false };
}

/**
 * Two values compete only if they mean different things. Punctuation, case and
 * spacing differences are formatting, not disagreement: "(626) 555-0198" and
 * "626-555-0198" are one phone number, and flagging them as a conflict sends a
 * decision to a human that has no content.
 */
function equivalenceKey(value: string): string {
  return value.toLocaleLowerCase("en-US").normalize("NFKD").replaceAll(/[^a-z0-9]+/g, "");
}

function groupingLabel(value: string): string {
  return value.toLocaleLowerCase("en-US").normalize("NFKD").replaceAll(/[^a-z0-9]+/g, " ").trim();
}

export function reconcileOccurrences(occurrences: FieldOccurrence[]): { canonicalValues: CanonicalValue[]; occurrences: FieldOccurrence[] } {
  const grouped = new Map<string, FieldOccurrence[]>();
  for (const occurrence of occurrences) {
    // The source label is part of the identity of a value. Generic catch-all
    // fields (checkbox, amount, address) otherwise collect unrelated answers
    // from all over a form into one bucket and declare them contradictory.
    const key = `${occurrence.fieldDefinitionId}:${occurrence.subjectEntityId ?? "matter"}:${groupingLabel(occurrence.sourceLabel)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), occurrence]);
  }
  const canonicalValues: CanonicalValue[] = [];
  const next = occurrences.map((item) => ({ ...item }));
  const nextMap = new Map(next.map((item) => [item.id, item]));
  for (const [key, values] of grouped) {
    const normalized = new Map<string, FieldOccurrence[]>();
    for (const value of values) {
      const identity = equivalenceKey(value.normalizedValue);
      normalized.set(identity, [...(normalized.get(identity) ?? []), value]);
    }
    // A value a person already ruled on is settled and cannot be in dispute.
    const undecided = new Set(
      values.filter((item) => !item.decidedByUser).map((item) => equivalenceKey(item.normalizedValue))
    );
    const conflictGroupId = undecided.size > 1 ? stableId("CONFLICT", key) : null;
    for (const [identity, matching] of normalized) {
      const status = conflictGroupId
        ? "conflict"
        : matching.every((item) => item.status === "verified") ? "verified" : "withheld";
      canonicalValues.push({ id: stableId("VAL", `${key}:${identity}`), fieldDefinitionId: matching[0].fieldDefinitionId, subjectEntityId: matching[0].subjectEntityId, normalizedValue: matching[0].normalizedValue, occurrenceIds: matching.map((item) => item.id), resolutionStatus: status, conflictGroupId });
      if (conflictGroupId) {
        for (const item of matching) {
          if (item.decidedByUser) continue;
          Object.assign(nextMap.get(item.id)!, { status: "exception" as InformationStatus, exceptionReason: "Conflicting non-equivalent values were found for the same field and subject." });
        }
      }
    }
  }
  return { canonicalValues, occurrences: next };
}

export function entityForName(name: string, type: Entity["type"] = "unknown"): Entity {
  const normalized = normalizeInformationValue(name, "name").value;
  return { id: stableId("ENT", `${type}:${normalized.toLowerCase()}`), type, canonicalName: normalized, nameVariants: [name] };
}

export function relationshipId(sourceEntityId: string, relationshipType: string, targetEntityId: string): string {
  return stableId("REL", `${sourceEntityId}:${relationshipType}:${targetEntityId}`);
}

export function normalizeRelationshipType(value: string): string {
  const normalized = value.toLocaleLowerCase("en-US").normalize("NFKD").replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "");
  const synonyms: Record<string, string> = {
    attorney_for: "represents", counsel_for: "represents", represents: "represents",
    employed_by: "employed_by", employee_of: "employed_by",
    insured_by: "insured_by", covered_by: "insured_by",
    agent_for: "agent_for", signs_for: "signs_for", signed_on_behalf_of: "signs_for",
    served_on_behalf_of: "served_on_behalf_of", parent_of: "parent_of", subsidiary_of: "subsidiary_of",
    related_to: "related_to"
  };
  return synonyms[normalized] ?? (normalized || "related_to");
}

export function mergeRelationships(values: Relationship[]): Relationship[] {
  const map = new Map<string, Relationship>();
  for (const value of values) {
    const prior = map.get(value.id);
    map.set(value.id, prior ? { ...prior, occurrenceIds: [...new Set([...prior.occurrenceIds, ...value.occurrenceIds])] } : value);
  }
  return [...map.values()];
}
