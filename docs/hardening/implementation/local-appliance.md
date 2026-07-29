# Implementation Plan: Loopback local appliance

## Selected Design And Constraints

The selected design runs the application and Ollama on loopback, stores evidence
in an encrypted local vault, and prohibits external model fallback. Vercel
remains a synthetic-data pilot.

## Source Revision And Drift Check

The design is anchored to security scan revision `8fcfede`. The working tree
contains the selected implementation, so source drift is expected and must be
validated before commit.

## Affected Components

- local API routes under `src/app/api/local`;
- `src/lib/local-vault.ts`, `local-llm.ts`, and `local-client.ts`;
- parser, query, evidence, storage, review, settings, and export flows;
- offline runbook and HIPAA readiness evidence.

## Ordered Work Packages

1. Establish loopback and fail-closed model boundaries.
2. Add authenticated encrypted storage, sessions, originals, and audit records.
3. Add local structured extraction and approved-fact semantic selection.
4. Add review history, legal holds, backups, parser budgets, and safe exports.
5. Add tests, offline preflight, documentation, and manual verification.

## Compatibility And Migration

Browser pilot data is intentionally not migrated automatically into the PHI
vault. A reviewer should start a new local vault and re-import authoritative
sources to preserve provenance.

## Tactical Protections During Migration

PHI mode stays disabled on Vercel. Local routes return not found unless
`LOCAL_ONLY_MODE=enabled` and the request host is loopback.

## Tests And Security Validation

- unit tests for citations, query gating, parser limits, export sanitization,
  local URL policy, and vault cryptography;
- production and local-profile builds;
- API tests for setup, login, session expiry, CSRF, legal hold, backup, and
  remote-host rejection;
- offline manual import, OCR, extraction, review, query, export, and restore.

## Performance And Resource Benchmarks

Measure representative native and scanned PDFs, peak browser memory, OCR
seconds per page, model tokens per page, extraction time, and vault size.

## Rollout And Rollback

Pilot with synthetic data on a managed workstation. Rollback stops the local
service and preserves the encrypted vault and backup. Never roll protected data
back into browser IndexedDB or the Vercel profile.

## Acceptance Criteria

- no evidence request reaches a non-loopback address;
- originals and workspace state are encrypted at rest;
- unauthenticated local API calls fail;
- only approved records produce answers;
- every displayed citation byte-matches;
- legal holds block deletion;
- audit verification and backup restoration pass;
- firm-controlled checklist items have documented owners and evidence.

## Open Decisions

- firm-approved model and hardware profile;
- retention periods by matter class;
- operating-system identity and MFA baseline;
- approved encrypted backup destination.
