# Verity Caseworks

Verity Caseworks converts legal case documents into reviewable facts and lets
users query approved records using natural-language questions. Every displayed
source quotation is reconstructed from, and verified against, an immutable
canonical UTF-8 byte range.

The application has two intentionally separate operating profiles:

| Profile | Intended use | Model | Storage |
| --- | --- | --- | --- |
| Offline local appliance | Protected case data after firm approval | Local Ollama model | Encrypted local vault |
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

Native PDF text is used when available. Image-only pages are processed with
bundled Tesseract OCR assets from the application origin—no OCR CDN or external
OCR service is required.

## Do I need to install the repository locally?

Yes. For offline operation you need a local copy of this repository. You do not
install it like an App Store application; you clone or download the repository,
install its Node.js dependencies, and build it.

You also need:

- Git, unless you download the repository as a ZIP;
- Node.js 20.18 or newer;
- npm, included with Node.js;
- Ollama;
- enough local disk space for the repository, encrypted case vault, OCR assets,
  and the `qwen3:8b` model.

The initial dependency installation and model download require internet access.
After preparation, the local appliance can run with external networking
disconnected.

## Run as an offline local appliance

### 1. Get and install the application

```bash
git clone https://github.com/WillBranam/Legal-Data-Extractor.git
cd Legal-Data-Extractor
npm ci
ollama pull qwen3:8b
npm run local:build
```

If you already have the repository folder, start with `cd` into that folder and
run `npm ci`; you do not need to clone it again.

`npm ci` also prepares the self-hosted OCR worker, WebAssembly cores, and
English language data in `public/ocr`.

### 2. Start the local model

In the first terminal:

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

Do not bind the application or Ollama to `0.0.0.0`, a LAN address, a reverse
proxy, or a public tunnel.

### 4. First use

1. Create the local reviewer account and a vault password of at least 14
   characters.
2. Store that password in the firm's approved password manager.
3. Upload supported case files.
4. Review locally generated fact proposals and approve only supported facts.
5. Query the approved record and inspect each exact citation.
6. Create encrypted backups from Settings and move them to an approved
   encrypted destination.
7. Sign out when finished to destroy the in-memory vault session key.

Local data is stored under `.verity-local-data` in encrypted form. Losing the
vault password makes that data unrecoverable. Follow the complete
[local operation runbook](docs/LOCAL_RUNBOOK.md) for backup, restore, legal
hold, and incident procedures.

### Local development

Use this only with synthetic or de-identified data:

```bash
npm install
npm run local:model
```

In another terminal:

```bash
npm run local
```

Open `http://127.0.0.1:3000`.

## Run online on Vercel

The online profile is a browser-processing pilot. Documents are parsed and
OCRed in the user's browser, and browser IndexedDB stores the pilot workspace.
The server exposes no upload endpoint or hosted-model endpoint.

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
