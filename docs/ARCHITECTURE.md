# Administrative Legal Document Automation Architecture

## Product boundary

Verity Caseworks is an administrative case-information digitization system. It
classifies one matter’s documents and creates a typed lookup index of parties,
roles, organizations, counsel, identifiers, contacts, dates, signatures,
relationships, structured statuses, and other clearly labeled fields.

Narrative testimony, allegations, event reconstruction, and evidence synthesis
are outside the default extraction specification. Existing v1 narrative records
remain read-only in `legacyFacts` and are excluded from v2 exports.

## Local processing flow

```text
source folder
  -> immutable inventory and source hash
  -> native text or tiered local OCR
  -> canonical UTF-8 artifact and page provenance
  -> document/language classification and editable field registry
  -> structured field extraction with exact source spans
  -> independent source-support and adversarial review
  -> deterministic normalization, citation, hash, and matter checks
  -> automatically verified information OR short exception queue
  -> restricted administrative lookup
  -> one synchronized SQLite/XLSX/DOCX/PDF/CSV/JSONL snapshot
```

The local application and Ollama bind only to loopback. Originals, canonical
artifacts, typed records, citations, exceptions, audit events, and legal-hold
state are stored in an AES-256-GCM local vault. Open exports are deliberately
unencrypted for interoperability and require an explicit sensitive-data
acknowledgement.

## Typed schema v2

The authoritative objects are `FieldDefinition`, `FieldOccurrence`,
`CanonicalValue`, `Entity`, `Relationship`, and `SignatureObservation`.
`FieldOccurrence` always retains both `rawValue` and `normalizedValue`.
Identifiers are stored as text so leading zeros cannot be lost.

The versioned field registry covers common administrative families and permits
dynamic fields only when a value has an explicit label or structural anchor.
Equivalent values reconcile automatically. Non-equivalent case numbers,
identifiers, names, dates, or party values remain separate and create an
exception; the model cannot silently choose a winner.

An explicit conflicting case number quarantines the document. Quarantined
documents cannot contribute to verified lookup views or exports until resolved.

## Tiered local OCR

1. PDF.js or the native office/text parser is used when usable text exists.
2. A configured offline PP-OCRv5 worker performs local page OCR using only
   pre-downloaded detection and recognition models.
3. Bundled Tesseract.js English and Spanish weights provide a self-contained
   browser fallback.
4. Loopback-only `qwen3-vl:8b` is used selectively after low OCR confidence for
   difficult handwriting, irregular layouts, checkboxes, and signature context.
5. `qwen3:8b` performs structured field extraction and bounded review.

The PP-OCR worker is spawned for one request, receives a permission-restricted
temporary page image, has model-source checks disabled, receives a minimal
environment, and is securely removed after processing. It does not bind a port.

## Verification rules

For text fields:

```text
SHA256(current canonical artifact) == stored canonical hash
UTF8(canonical)[byteStart:byteEnd] == UTF8(rawValue)
```

The model proposes a field and source span; the application narrows the stored
citation to the exact raw value and reconstructs the displayed quotation from
canonical bytes. Sensitive identifiers publish automatically only when all
characters survive exact citation validation and the extraction reaches the
strict confidence threshold. Otherwise they are exceptions.

Signature observations record presence, signer context, page, detector version,
confidence, and available image provenance. All interfaces and outputs use the
phrase “signature mark detected” and explicitly state that no authenticity or
genuineness determination was made.

## Lookup boundary

Administrative lookup uses verified typed records only. It cannot use v1 legacy
narratives, rejected or withheld values, quarantined documents, or arbitrary
SQL. Results show the normalized value, exact source form, subject, field type,
document, page, and verified citation.

## Synchronized output package

One `ExportSnapshot` is the source for every format. It contains verified field
occurrences, definitions, canonical values, entities, relationships, signatures,
citations, documents, coverage, and disclosed exceptions. Cross-format counts
must match before the package is hashed and released.

`case.sqlite` contains typed tables, full-text search, and convenience views such
as `case_master`, `client_directory`, `party_directory`, `counsel_directory`,
`identifier_index`, `contact_index`, `important_dates`, `signature_register`,
`relationship_index`, `document_register`, and `source_occurrences`.

The Excel workbook is the primary staff-facing index. DOCX/PDF outputs are
table-based Case Information Summary and Document Register references rather
than model-authored narratives. CSV and JSONL mirror the typed tables.

## Deployment profiles

- The offline local appliance is the protected processing profile after firm
  approval and readiness validation.
- The public Vercel profile is limited to synthetic or de-identified data. It
  has no hosted model, durable protected storage, BAA chain, or PHI approval.
- A future hosted service must use a separately reviewed private backend,
  enterprise identity, encrypted object/database storage, durable jobs, egress
  controls, BAAs, and an administrator-approved model provider. That hosted
  architecture is not implemented by this pivot.
