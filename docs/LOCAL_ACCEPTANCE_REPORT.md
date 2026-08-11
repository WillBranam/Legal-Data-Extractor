# Local-First v1 Acceptance Report

Date: August 10, 2026  
Test matter: `sample-data/rivera-v-northstar` (fully synthetic)

## Attorney-oriented workflow findings

The test began from an empty workspace without an application login. All seven
numbered files were selected together as if by a first-time legal user. The app
kept Ask and Export disabled during parsing, OCR, three model passes, exact-byte
verification, and encrypted save. It continuously showed the current file,
processing phase, progress indicator, and the reason those actions were locked.

The full `qwen3:4b` baseline processed seven files, nine pages, and one OCR page
in 255.1 seconds (28.34 seconds per page). A later prompt revision processed the
same set in 215.3 seconds (23.92 seconds per page). Local OCR correctly handled
the scanned PNG, and native TXT, EML, DOCX, and PDF parsing completed without
document errors.

## Model comparison

On the difficult fact-sheet, deposition, and damages subset:

| Model | Time | Accepted facts | Withheld proposals | Result |
| --- | ---: | ---: | ---: | --- |
| `qwen3:4b` | 124.3 s | 5 | 13 | Faster, but missed the fact sheet, transcript facts, and stated damages total |
| `qwen3:8b` | 156.0 s | 16 | 0 | Recovered the fact sheet, itemized damages, and the $16,452.75 total |

The 8B model was about 26% slower on this hardware, but materially more useful.
It is therefore the release default. The 4B model remains configurable for
lower-memory machines, with an explicit recall tradeoff.

## Accuracy and guardrails

- Every accepted claim displayed the server-verified exact quotation, document,
  page, UTF-8 byte range, canonical hash, original hash, parser, context, and
  review provenance.
- The adversarial instruction fixture produced no verified facts.
- The app did not assert that Northstar admitted liability.
- Preserving native PDF line endings increased the deposition regression from
  one accepted fact to ten. It recovered both the obstructed-view testimony and
  “I cannot rule that out.”
- `qwen3:8b` extracted the itemized damages rows and `TOTAL DOCUMENTED
  $16,452.75` as exact byte-matched evidence.
- Unsupported questions returned `insufficient_evidence` instead of fabricated
  prose.

This is a synthetic functional test, not a legal validation study. Exact byte
matching proves quotation integrity, not that a source is true or that every
material fact was found.

## Export review

CSV, XLSX, JSON, and DOCX generators include the exact quotation, source name,
page/structural location, surrounding context, byte bounds, original and
canonical hashes, parser version, review provenance, and confidence. CSV cells
that could be interpreted as spreadsheet formulas are neutralized. Automated
tests reject exports whose citation hash or byte range has been tampered with.

## Local privacy and HIPAA boundary

The tested profile bound both the app and Ollama to loopback, used bundled OCR,
stored the vault key in the signed-in macOS user's Keychain, encrypted workspace
and original-file payloads with AES-256-GCM, and made no cloud-model fallback
available. No application login is shown for the single-user macOS appliance;
the managed OS account is the unique identity boundary.

These application safeguards do not guarantee HIPAA compliance by themselves.
Before real PHI, the firm must complete the workstation, identity, risk-analysis,
backup, retention, incident-response, training, and validation items in
`docs/HIPAA_READINESS_CHECKLIST.md`.
