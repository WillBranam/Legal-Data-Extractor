# Verity Caseworks

Verity Caseworks digitizes administrative information from legal matter files.
It extracts names, parties and roles, firms, case and claim numbers, personal
identifiers, contacts, important dates, signatures, relationships, checkbox
selections, and any other clearly labeled lookup-worthy field. It preserves the
exact source value beside a deterministic normalized value, and produces a
portable case information package for day-to-day legal operations.

The default workflow intentionally excludes testimony, allegations, disputed
event narratives, damages analysis, and model-authored case summaries. Every
published value is tied to a quotation reconstructed from an immutable canonical
UTF-8 byte range. Signature processing reports only that a signature mark was
detected; it never authenticates a signature.

The application has two intentionally separate operating profiles:

| Profile | Intended use | Model | Storage |
| --- | --- | --- | --- |
| Offline local appliance | Protected case data after firm approval | Local oMLX model (Ollama supported) | Encrypted local vault |
| Online Vercel pilot | Synthetic or de-identified data only | No hosted LLM | Browser IndexedDB |

The application supplies technical safeguards, but does not by itself make a
workstation, firm, or workflow HIPAA compliant. Review the
[HIPAA readiness checklist](docs/HIPAA_READINESS_CHECKLIST.md) before using real
PHI.

## Supported files

- Native and scanned PDF
- DOCX
- TXT
- Individual EML and MSG files
- JPEG, PNG, and TIFF images

Native PDF text is used when available. The preferred offline OCR path is local
PP-OCRv5. Bundled English/Spanish Tesseract assets provide an immediate fallback,
and the loopback-only `qwen3-vl:8b` model is used selectively for difficult
handwriting, irregular forms, checkboxes, and signature-region transcription.
No OCR CDN or external OCR service is used.

## Do I need to install the repository locally?

Yes. For offline operation you need a local copy of this repository. You do not
install it like an App Store application; you clone or download the repository,
install its Node.js dependencies, and build it.

You also need:

- Git, unless you download the repository as a ZIP;
- Node.js 20.18 or newer;
- npm, included with Node.js;
- a local model host: oMLX (the default, on loopback port 8000) or Ollama;
- enough local disk space for the repository, encrypted case vault, OCR assets,
  and the text and vision model weights.

The initial dependency installation and model download require internet access.
After preparation, the local appliance can run with external networking
disconnected.

## Run as an offline local appliance

### 1. Get and install the application

```bash
git clone https://github.com/WillBranam/Legal-Data-Extractor.git
cd Legal-Data-Extractor
npm ci
npm run local:build
npm run local:prepare-runtime
npm run local:verify-runtime
```

Then install the model weights for your host. For the default oMLX profile see
[Default model host: oMLX](#default-model-host-omlx) below. For Ollama:

```bash
ollama pull qwen3:8b
ollama pull qwen3-vl:8b
```

If you already have the repository folder, start with `cd` into that folder and
run `npm ci`; you do not need to clone it again.

`npm ci` also prepares the self-hosted OCR worker, WebAssembly cores, and
English and Spanish language data in `public/ocr`.

For the preferred PP-OCRv5 path, create a dedicated offline Python environment,
install PaddleOCR and PaddlePaddle, download the PP-OCRv5 detection and
recognition model directories while online, then set absolute paths in
`.env.local`:

```bash
npm run local:setup
```

This command performs those steps on an Apple Silicon Mac, preserves existing
`.env.local` values, runs an OCR smoke test, and finishes with the complete
readiness check. Its model step targets the Ollama host and installs
`qwen3-vl:8b`; on the default oMLX profile install the MLX vision build instead
and let the readiness check confirm it. The resulting settings are:

```text
PADDLEOCR_PYTHON=/absolute/path/to/paddleocr-venv/bin/python
PADDLE_OCR_MODEL_DIR=/absolute/path/to/ppocr-models
LOCAL_VISION_MODEL=qwen3-vl:8b
```

`PADDLE_OCR_MODEL_DIR` must contain `detection/` and `recognition/`. The
readiness check fails if either local model, either language asset, or either
PP-OCRv5 weight directory is missing. Once prepared, the OCR worker runs as a
one-shot local process and is never bound to a network interface.

`local:prepare-runtime` removes development-only lint, test, and build packages
after the production build is complete. `local:verify-runtime` audits only the
installed production dependency boundary. Run `npm ci` again before doing
development work or rebuilding.

`Qwen3-8B-4bit` on oMLX is the structured field-extraction default, and
`qwen3:8b` is its Ollama equivalent. Extraction spans are sent to the model
concurrently; `LOCAL_EXTRACTION_CONCURRENCY` (default 4) tunes how many run at
once, and scanned pages are OCRed up to four at a time. The PP-OCRv5 workers stay
resident between pages so the models are loaded once per scan rather than once
per page, and they exit after 90 seconds idle to give the memory back. Machines with limited memory may drop to
the 4B build of either, but should expect lower recall and
must validate it against representative intake forms, cover sheets, service
documents, notices, agreements, and identifiers.

### Default model host: oMLX

The appliance defaults to oMLX on loopback port `8000`, which measured about
30% faster than Ollama on Apple Silicon. MLX cannot load Ollama's GGUF weights,
so install MLX builds:

- text: `mlx-community/Qwen3-8B-4bit`
- vision: `mlx-community/Qwen3-VL-8B-Instruct-4bit`

Place them under `~/.omlx/models/` and run `omlx restart` so the server
rescans. The provider, base URL, and both model names above are the built-in
defaults, so `.env.local` only needs the API key when oMLX auth is enabled:

```text
LOCAL_LLM_API_KEY=<oMLX API key>
```

To override any of them, or to run the alternative Ollama host instead:

```text
LOCAL_LLM_PROVIDER=ollama
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434
LOCAL_LLM_MODEL=qwen3:8b
LOCAL_VISION_MODEL=qwen3-vl:8b
```

Model names are the **directory basename**, not the Hugging Face path. Verify
with `node scripts/check-omlx-compatibility.mjs` and `npm run local:check`
before use, and tighten oMLX's `cors_origins` and `server_aliases` to loopback
first. See the [provider notes](docs/INGESTION_DEBUGGING_HANDOFF.md).

### 2. Start the local model

With the default oMLX profile, start the oMLX server and confirm it is bound to
loopback port `8000`. Nothing needs to run in this repository for that host.

With the alternative Ollama profile, in the first terminal:

```bash
cd Legal-Data-Extractor
npm run local:model
```

This starts Ollama with:

- `OLLAMA_HOST=127.0.0.1:11434`;
- `OLLAMA_NO_CLOUD=1`;
- no application fallback to a remote provider.

Keep this terminal running.

### 3. Check and start the application

In a second terminal:

```bash
cd Legal-Data-Extractor
npm run local:check
npm run local:start
```

Every readiness check must pass. Open:

```text
http://127.0.0.1:3000
```

The application itself listens on port `3000`; the model host listens on
`8000` (oMLX) or `11434` (Ollama). Do not bind the application or the model
host to `0.0.0.0`, a LAN address, a reverse proxy, or a public tunnel.

### 4. First use

Local-first v1 supports passwordless operation on a single-user, firm-managed
Mac. The app creates a random vault key in the signed-in user's macOS Keychain;
it does not display a second application login. The operating-system account is
the user identity and must be individual, managed, protected by MFA where firm
policy requires it, and backed by FileVault and automatic screen lock. If the
app finds an earlier password-locked vault, it preserves that entire vault in a
timestamped `locked-vault` archive beside the active data directory and opens a
fresh Keychain-protected workspace. It never asks for the old password.

1. Add supported case files or one matter folder. Use the **Add files** and
   **Add matter folder** buttons, drag files onto the window, or paste them with
   `⌘V`. Unsupported files are named and skipped rather than ignored. Files are
   stored even when the local text model is not running; extraction then waits
   and can be started later with **Retry extraction**.
2. Review or adjust the enabled administrative field registry.
3. Wait until classification, OCR, extraction, two independent model-review
   passes, normalization, exact-byte verification, reconciliation, and encrypted
   save finish. Lookup and export remain locked while this runs. A document that
   could not be scanned end to end is reported with the pages actually read and
   stays retryable; it is never presented as complete.
4. Resolve only the short **Exceptions** queue. Clear values publish automatically.
5. Use **Find Information** for administrative lookup and inspect exact citations.
6. Open **Download Case Package**, acknowledge that the open package may contain
   full PII/PHI, build it, and download either the
   complete ZIP or individual SQLite, Word, Excel, or PDF files.
7. Create encrypted backups from Settings and move them to an approved
   encrypted destination.
8. Lock or sign out of macOS when finished.

Local data is stored outside the repository under `~/.verity-caseworks/data` in encrypted form. Existing `.verity-local-data` workspaces are copied there on the first local start and are never deleted automatically. Set `LOCAL_DATA_DIRECTORY` to an absolute encrypted location when firm policy requires a managed volume. Losing the
macOS Keychain item makes that data unrecoverable. Follow the complete
[local operation runbook](docs/LOCAL_RUNBOOK.md) for backup, restore, legal
hold, and incident procedures.

## Portable case database and legal documents

The local Export workspace creates every deliverable from one verified snapshot.
The complete package includes:

- a standard SQLite database with full-text search, typed information views,
  field-level citations, source hashes, and example SQL;
- editable table-based Case Information Summary and Document Register DOCX files;
- matching searchable, printable PDF references;
- a multi-sheet `Case_Information.xlsx` workbook, data dictionary, and separate
  exception workbook;
- CSV and JSONL mirrors of the typed administrative tables;
- original sources, canonical UTF-8 evidence, provenance metadata, a manifest,
  and SHA-256 checksums.

The Export screen shows each generation phase and keeps the files unavailable
until database creation, document rendering, citation verification, parity
checks, and hashing finish. A final package is blocked while any document is
still awaiting OCR. An explicitly requested partial package is labeled
`PARTIAL` throughout its filename and metadata.

These portable exports are intentionally unencrypted so SQLite, Word, Excel,
and PDF tools can open them directly. They may contain PHI. Save them only to a
firm-approved encrypted destination, restrict access through the operating
system or document-management system, and use an approved secure transfer
method. The encrypted vault backup and the open legal-work-product export serve
different purposes.

### Local development

The local development command is loopback-only and enables the protected local
profile. Use synthetic or de-identified data until the firm has completed the
readiness checklist and approved the workstation:

```bash
npm install
npm run local:model
```

In another terminal:

```bash
npm run local
```

Open `http://127.0.0.1:3000`.

## Synthetic acceptance matter

The existing synthetic matter remains useful for parser regression, but its
narrative fact expectations predate the administrative pivot. New administrative
benchmarks should focus on cover sheets, intake forms, service records, notices
of appearance, agreements, identifiers, contacts, dates, checkboxes, and
signature marks.

To regenerate the fixture, use Python 3.10 or newer and install its generator
dependencies first:

```bash
python3 -m pip install python-docx Pillow reportlab
python3 scripts/generate-sample-case.py
```

## Run online on Vercel

The online profile is a browser-processing pilot. Documents are parsed and
OCRed in the user's browser, and browser IndexedDB stores the pilot workspace.
The server exposes no remote-upload endpoint or hosted-model endpoint.

The Vercel profile is **not approved for PHI**. Use only synthetic or
de-identified documents unless a separately reviewed hosted architecture,
contracts, BAAs, identity controls, storage services, and incident procedures
have been implemented.

### Deploy from GitHub

1. Push this source tree to the dedicated GitHub repository
   `WillBranam/Legal-Data-Extractor`.
2. In Vercel, choose **Add New → Project**.
3. Import only the dedicated `Legal-Data-Extractor` repository.
4. Create a new Vercel project; do not reuse another project's ID, environment
   variables, domains, storage, or deployment history.
5. Confirm the framework is Next.js.
6. Set these environment variables for Production, Preview, and Development:

   ```text
   PHI_MODE=disabled
   LOCAL_ONLY_MODE=disabled
   ```

7. Keep the install command as `npm ci` and build command as `npm run build`.
8. Deploy and confirm `/api/health` reports protected processing as disabled.

Vercel will build and redeploy the site whenever the configured GitHub branch is
updated.

### Deploy with the Vercel CLI

After installing and authenticating the Vercel CLI:

```bash
cd Legal-Data-Extractor
vercel link
vercel deploy --prod
```

During `vercel link`, create or select only the dedicated Verity Caseworks
project. Inspect `.vercel/project.json` and confirm its project name and
`projectId` before deploying. The `.vercel` directory is intentionally ignored
by Git and must not be copied from another project.

See [deployment isolation instructions](docs/DEPLOYMENT.md) for the complete
online deployment boundary.

## Validate changes

```bash
npm run lint
npm test
npm run local:build
npm run build
npm audit --omit=dev
```

To validate the local runtime, start `npm run local:model`, then run:

```bash
npm run local:check
```

## Architecture and security documentation

- [Architecture overview](docs/ARCHITECTURE.md)
- [Offline architecture](docs/OFFLINE_ARCHITECTURE.md)
- [Local operation runbook](docs/LOCAL_RUNBOOK.md)
- [HIPAA readiness checklist](docs/HIPAA_READINESS_CHECKLIST.md)
- [Deployment isolation](docs/DEPLOYMENT.md)
- [Security-hardening review](docs/hardening/hardening.md)
- [Local acceptance report](docs/LOCAL_ACCEPTANCE_REPORT.md)
