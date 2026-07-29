# Verity Caseworks

A privacy-first legal evidence pilot that converts local case documents into
reviewable facts, then answers natural-language questions using approved records
and exact, reproducible UTF-8 citations.

## Safety posture

The deployed pilot is intentionally **zero egress**:

- Source documents are parsed in the browser.
- Source bytes, canonical text, citations, review state, and query state are
  stored in browser IndexedDB.
- The server exposes no upload or model endpoint.
- Natural-language retrieval is deterministic and restricted to approved facts.
- Displayed quotations are rehydrated from canonical byte ranges and checked
  against immutable hashes.
- Protected PHI mode is disabled by default.

This application does not by itself make an organization HIPAA compliant. Do
not enable protected cloud processing until the required BAAs, risk analysis,
access controls, retention policies, incident procedures, and vendor
configurations have been reviewed.

## Local development

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Validation

```bash
npm run lint
npm test
npm run build
```

## Supported pilot inputs

- Native PDF
- DOCX
- TXT
- Individual EML and MSG files

Image-only documents are recognized but require a separately configured
protected OCR worker. Original files are never transmitted by this deployment.

## Deployment

This repository is intended to map one-to-one to its own Vercel project. The
`.vercel` directory is ignored and must never be copied from another project.
See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
