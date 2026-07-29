# Verity Caseworks

A privacy-first legal evidence pilot that converts local case documents into
reviewable facts, then answers natural-language questions using approved records
and exact, reproducible UTF-8 citations.

## Safety posture

The deployed pilot is intentionally **zero egress**:

- Source documents are parsed in the browser.
- Scanned PDF pages and supported images are OCRed in the browser with
  self-hosted Tesseract WebAssembly and English language data.
- Source bytes are read transiently and are not persisted by the pilot.
  Canonical text, hashes, citations, review state, and query state are stored in
  browser IndexedDB.
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

- Native and scanned PDF
- DOCX
- TXT
- Individual EML and MSG files
- JPEG, PNG, and TIFF images

Native PDF text remains the fast path. Pages without usable native text are
rendered by PDF.js and passed to a reusable on-device OCR worker. The app records
the OCR engine version, page confidence, rendered-page hash, dimensions,
canonical UTF-8 byte range, and total processing time.

OCR runtime files are copied from pinned npm packages into `public/ocr` during
`npm install`. They are served from the same origin and are intentionally not
fetched from a third-party CDN.

The Documents screen reports elapsed time, pages, OCR pages, bytes, and seconds
per page for the most recent import. Start performance testing with synthetic or
de-identified scans before using production case data.

## Deployment

This repository is intended to map one-to-one to its own Vercel project. The
`.vercel` directory is ignored and must never be copied from another project.
See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
