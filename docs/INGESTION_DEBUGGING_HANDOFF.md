# Ingestion Debugging, Performance, and Agent Handoff

Last verified: August 18, 2026

> **Status change.** The truncated-JSON extraction failure described below has
> been root-caused, reproduced deterministically, and fixed. See
> [Resolved: truncated structured output](#resolved-truncated-structured-output).
> The fix has not yet been validated by `npm test`, `npm run lint`,
> `npm run build`, or a browser E2E pass. Run
> [Validation after a fix](#validation-after-a-fix) before trusting it.

This document is the engineering runbook for diagnosing local file ingestion,
OCR, extraction, and apparent processing stalls. It also provides a compact,
PHI-safe handoff for another model or a continuation after context compaction.
For end-user setup and compliance boundaries, see `LOCAL_RUNBOOK.md` and
`HIPAA_READINESS_CHECKLIST.md`.

## Current verified state

- The file-picker race that reported `0 documents processed` has been fixed.
  `importFiles` now copies the browser's live `FileList` into a normal array
  before its first `await`.
- A synthetic one-page administrative fact sheet completed end to end through
  encrypted storage, extraction, two review passes, citation checks, and
  workspace persistence.
- The truncated-JSON extraction failure on larger DOCX and PDF files has been
  root-caused and fixed. It was an output-token budget set below what the JSON
  Schema permitted, not a timeout. Increasing the model timeout would not have
  helped.
- Files can now be added by drag-and-drop and by paste as well as the picker.
  Previously neither existed, and a dragged file navigated away from the app.
- The next implementation priority is throughput and durability, not the model
  boundary. See `## Local model providers (Ollama and oMLX)

The appliance supports two loopback model hosts, selected by
`LOCAL_LLM_PROVIDER`. All transport lives in `src/lib/local-model-provider.ts`;
extraction, review, and citation logic are identical on both.

| | `ollama` | `openai` (oMLX, default) |
| --- | --- | --- |
| Base URL | `http://127.0.0.1:11434` | `http://127.0.0.1:8000` |
| List models | `/api/tags` → `models[].name` | `/v1/models` → `data[].id` |
| Chat | `/api/chat` | `/v1/chat/completions` |
| Auth | none | `Authorization: Bearer $LOCAL_LLM_API_KEY` |
| Output cap | `options.num_predict` | `max_tokens` |
| Schema | `format` | `response_format.json_schema` |
| Truncation | `done_reason: "length"` | `choices[0].finish_reason: "length"` |
| Vision | `/api/generate` + `images` | content parts + `image_url` data URI |

Model identifiers differ. Ollama uses `name:tag`; oMLX uses the **directory
basename** under its model dir, so `mlx-community/Qwen3-8B-4bit` on disk is
served as `Qwen3-8B-4bit`. `isConfiguredLocalModelInstalled` normalizes vendor
prefixes and quantization suffixes so either form resolves.

### oMLX configuration

```bash
LOCAL_LLM_PROVIDER=openai
LOCAL_LLM_BASE_URL=http://127.0.0.1:8000
LOCAL_LLM_MODEL=Qwen3-8B-4bit
LOCAL_VISION_MODEL=Qwen3-VL-8B-Instruct-4bit
LOCAL_LLM_API_KEY=<from ~/.omlx/settings.json auth.api_key>
```

MLX cannot load Ollama's GGUF weights. Install MLX builds into
`~/.omlx/models/`, then `omlx restart` — the server only rescans its model
directory on start, so a newly downloaded model reports as "not installed"
until it does.

### Pretty-printed JSON inflates the output budget

Schema-constrained decoders may indent their output, and oMLX does. The same
eight fields cost **760 tokens compact and exceeded 1,856 indented**, which
truncated the response inside the first field object — leaving salvage nothing
complete to recover and the document with zero extracted values.

Two mitigations are in place and both must stay:

- `COMPACT_JSON_INSTRUCTION` is appended to every structured prompt.
- `EXTRACTION_TOKENS_PER_FIELD` is 320 and `REVIEW_TOKENS_PER_ID` is 12, well
  above the compact-output measurement, to absorb formatting variance.

If a provider is ever added, re-measure both before trusting extraction.

### Verifying a provider

```bash
# Does the server support schema-constrained decoding and a length stop reason?
OMLX_MODEL=Qwen3-8B-4bit node scripts/check-omlx-compatibility.mjs

# Does the real extraction path work end to end against it?
npx tsx scripts/smoke-local-extraction.mjs

# Full readiness, including both models and OCR assets
npm run local:check
```

`check-omlx-compatibility.mjs` is the gate. It fails loudly if the server does
not enforce the JSON Schema or does not report `finish_reason: "length"`,
because the truncation recovery in `local-llm.ts` depends on both.

### oMLX settings to tighten before real case data

`~/.omlx/settings.json` ships with `server.cors_origins: ["*"]` and
`server.server_aliases` containing LAN addresses and `.local` hostnames. Both
contradict the loopback-only boundary this appliance requires. Restrict origins
to the application origin and aliases to loopback before processing PHI.
`distributed_inference_enabled` must remain `false`.

### Turbopack and out-of-root symlinks

`npm run local:build` fails with `Symlink ... points out of the filesystem root`
if a Python virtualenv sits inside the repository, because its `bin/python`
resolves into Homebrew. Keep the PaddleOCR venv outside the project — the
runtime path under `~/.verity-caseworks/runtime/` is correct — and the build
succeeds.

## Production readiness`.

## Know which server you are testing

Do not infer progress from HTTP `200` responses alone. The app polls
`GET /api/local/status` about every five seconds; those responses only prove
that the local readiness endpoint is alive.

Before debugging:

1. Confirm the browser title and UI are **Verity Caseworks**. A different local
   project has previously occupied port `3000`.
2. Prefer an isolated test profile and explicit port:

   ```bash
   cd "$(git rev-parse --show-toplevel)"
   npm run local:model
   LOCAL_DATA_PROFILE=qa-rivera-debug npm run local -- -p 3010
   ```

3. Open `http://127.0.0.1:3010` and confirm Settings reports the expected local
   text model and a ready OCR path.
4. Do not assume a server from an earlier session is still using the expected
   branch, build, profile, or port. Restart it when results are ambiguous.

For a production-mode local check:

```bash
npm run local:build
LOCAL_DATA_PROFILE=qa-rivera-debug npm run local:start -- -p 3010
```

Use synthetic or de-identified files while diagnosing. Never paste document
contents, personal identifiers, or extracted values into tickets, commits,
model handoffs, logs, or terminal transcripts.

## Expected request sequence

A successful upload and extraction should produce meaningful requests in this
order:

1. `PUT /api/local/documents/<document-id>` stores encrypted source bytes.
2. `POST /api/local/ocr` appears only for pages that need local OCR.
3. `POST /api/local/extract` performs structured extraction and bounded review.
4. `PUT /api/local/workspace` persists state transitions and extracted values.

The UI should progress through queued, parsing/OCR, extracting, reviewing,
validating, and a terminal state. Find Information and final export must remain
locked while selected documents are nonterminal.

## Failure identification matrix

| Symptom | Evidence to check | Likely cause | Correct response |
| --- | --- | --- | --- |
| Immediate `0 documents processed` | No document `PUT`, OCR, or extract request | Live `FileList` was cleared before it was copied | Confirm the current branch includes the early `Array.from(files)` snapshot; do not add delays |
| File appears but never becomes ready | Document `PUT` missing or failed | Vault write, file size/type validation, or client-side exception | Inspect the document state and sanitized server error; test one small TXT fixture |
| OCR returns `503` | `POST /api/local/ocr 503` and local status is not ready | Missing OCR assets/runtime or unavailable local visual/OCR worker | Run `npm run local:check`; prepare all local models and OCR weights before disconnecting the network |
| Extraction returns `400` with `MODEL_OUTPUT_TRUNCATED` | Extract error code, and `reviewSummary.truncationRecoveries` above zero | Output-token budget exhausted for that span | Expected and recoverable. Salvage keeps complete objects; investigate only if coverage is `partial` |
| Extraction returns `400` with a raw JSON `SyntaxError` | Any parser text reaching the browser | A code path bypassing `disclosableErrorCode` | Regression. Add the code to the allowlist in `local-request.ts`; never echo `error.message` |
| A document shows complete but values are missing | `reviewSummary.coverage` is `partial` | Not every page was scanned | The document must display as retryable, not complete. If it shows complete, that is a disclosure bug — fix it before anything else |
| Dragging a file navigates away from the app | Workspace state lost on drop | `dragover` handler missing its `preventDefault` | Regression in the shell drag handlers |
| Only repeated status `200`s appear | No document `PUT`, OCR, or extract request | The app is polling readiness, not ingesting | Verify the correct app/port and reproduce with one supported fixture while watching the browser state |
| Document reports processing after a restart | Stored state has a nonterminal phase with no active job | Interrupted browser-owned workflow | Repair to a retryable failed/interrupted state; never claim completion |
| Query is enabled while extraction is active | Workspace has queued/processing documents | Lock calculation is using stale or incomplete state | Treat any selected nonterminal document as a global query/export lock |

Do not expose raw provider/model responses to the user. Map failures to a short
actionable message and keep the technical, non-PHI failure class separately.

## Verified upload-race fix

Browser `FileList` objects are live. The input's change handler clears its value
after invoking `importFiles`, so awaiting readiness before copying the list made
the list empty. The safe order is:

```ts
async function importFiles(files: FileList | File[] | null): Promise<void> {
  if (!workspace || processing) return;
  const offered = files ? Array.from(files) : [];

  // Readiness checks may await only after the immutable snapshot exists.
}
```

Drop and paste hand in a plain `File[]`, which is already immutable; only the
picker's `FileList` is live. The signature accepts both.

Regression requirements:

- Clearing the file input immediately after dispatch must not change the files
  seen by `importFiles`.
- Selecting one file must cause one encrypted document write before extraction.
- Selecting multiple files must preserve the original names and count.
- A readiness failure must explain why processing did not start and must not
  report `0 documents processed` as success.

## Historic structured-extraction failure (resolved)

Two real-world-sized test files reached encrypted storage and parsing. A
17-page PDF also completed local OCR for every page with mean OCR confidence of
approximately `0.88`. Both extraction requests then failed with errors of the
form:

```text
Unterminated string in JSON at position <offset>
```

This establishes that upload and OCR worked for those runs. The failure is at
the structured model-response boundary. A deterministic retry with identical
context and token limits is likely to fail again and should not rerun successful
OCR unnecessarily.

Historic limits in `src/lib/local-llm.ts` at the time of failure:

- text model request timeout: 120 seconds;
- maximum fields per extraction chunk: 16;
- maximum text per extraction chunk: 6,000 characters;
- total extraction deadline: 4 minutes;
- primary structured output budget: 1,600 tokens;
- each review output budget: 384 tokens.

The last two were the defect. Current values are derived per request; see
[Resolved: truncated structured output](#resolved-truncated-structured-output).

## Resolved: truncated structured output

### Root cause

`structuredChat` in `src/lib/local-llm.ts` called `JSON.parse` on the model's
raw content without inspecting Ollama's `done_reason`. Two request sites set an
output-token budget far below what their own JSON Schema permitted, so the model
was cut off mid-value and the resulting `SyntaxError` surfaced as an HTTP `400`
carrying the raw parser message.

Both sites were reproduced against the live `qwen3:8b`:

| Site | Previous setting | Schema ceiling | Reproduced result |
| --- | --- | --- | --- |
| Primary extraction | `maxTokens: 1600` | 16 field objects, `raw_value` and `exact_quote` up to 2,000 characters each | A 29-line civil case cover sheet — one page, one chunk — returned `done_reason: length`, `eval_count: 1600`, and failed to parse after 71.8 s |
| Both review passes | `maxTokens: 384` | `maxItems: MAX_FACTS` (200) | 60 candidates returned `done_reason: length`, `eval_count: 384`, stopping at `proposal-55` |

The review budget was a direct self-contradiction: 384 tokens holds roughly 55
`"proposal-N"` elements against a schema allowing 200. Any document producing
more than about 55 proposals failed review even when extraction had fully
succeeded, and because `reviewProposalsWithLocalModel` was called without a
`try`/`catch`, that discarded every valid proposal.

Three behaviors turned a single bad response into a lost document:

- `if (proposals.length === 0) throw error` aborted the whole document when the
  first chunk failed.
- Deadline exhaustion `break`s were silent, and the document was then stored as
  complete with pages never read.
- `localApiError` returned `error.message` verbatim for any unrecognized error.

### What changed

`src/lib/local-llm.ts`

- `structuredChat` returns typed `TruncatedModelOutputError` (carrying the
  partial content) and `MalformedModelOutputError` instead of leaking a
  `SyntaxError`. Truncation is classified before parsing.
- Output budgets are derived from the request rather than hardcoded:
  `EXTRACTION_TOKENS_PER_FIELD` (220) and `REVIEW_TOKENS_PER_ID` (8).
- `MAX_FIELDS_PER_CHUNK` 16 → 8, `MAX_CHUNK_CHARACTERS` 6,000 → 3,500.
- `salvageTruncatedArrayItems` recovers the complete elements of a cut-off JSON
  array. A truncated response is a valid prefix, so its finished field objects
  and approval IDs are kept; only the incomplete tail element is dropped.
- `extractChunkFields` retries a span at half the field budget when salvage
  recovers nothing.
- Review passes are batched at `REVIEW_BATCH_SIZE` (40) with a per-batch token
  budget, and a failed batch marks its proposals **unreviewed** rather than
  rejected. Unreviewed proposals keep their verified citation but have
  confidence demoted to `0.5`, which routes them to the Exceptions queue for a
  human instead of being silently dropped.
- 30% of the extraction deadline is reserved for review so discovery cannot
  consume the whole allowance.
- `reviewSummary` now carries `coverage`, `coverageReason`, `pagesScanned`,
  `totalPages`, `truncationRecoveries`, and `reviewCompleted`. A document that
  was not scanned end to end is reported `partial` and must be disclosed.
- `isConfiguredLocalModelInstalled` matches base name and tag prefix, so
  `qwen3:8b-q4_K_M` and a bare `qwen3` no longer disable the application.

`src/lib/local-request.ts`

- `disclosableErrorCode` allowlists the codes that may reach the client.
  Everything else becomes `LOCAL_API_ERROR`, so parser exceptions, filesystem
  paths, and any document-derived text stay inside the server.

`src/components/legal-workspace.tsx`

- `EXTRACTION_ERROR_MESSAGES` maps each code to user-actionable text.
- Partial coverage is written to the document's `extractionError` and named in
  the import summary; the document is left retryable rather than shown complete.

### Resolved: files could not be dropped or pasted

The application had no `onDrop`, `onDragOver`, `onPaste`, or `dataTransfer`
handler anywhere in `src/`. The only ingestion path was two hidden
`<input type="file">` elements behind buttons, so dragging a file onto the
window triggered the browser default and navigated away from the workspace,
and `⌘V` did nothing.

- A window-level `paste` listener and shell-level drag handlers now feed the
  same `importFiles`, which accepts `FileList | File[] | null`. The
  `preventDefault` on `dragover` is what stops the navigate-away data loss.
- Model readiness no longer disables the upload buttons. Files are always
  parsed, hashed, and stored; extraction is held in a retryable `not-started`
  state when the model is down, so a stopped Ollama can never lose a document.
- Rejected and unsupported files are reported by name instead of returning
  silently.
- `accept` now carries MIME types alongside extensions on both inputs.

## Fix list

### P0 — extraction reliability (implemented; see above)

- Detect empty, malformed, and likely truncated JSON separately from semantic
  schema-validation failures.
- Retry a truncated primary response with fewer requested fields, a smaller
  source chunk, and a correspondingly narrower JSON Schema.
- Put explicit maximum lengths on raw values, exact-quote candidates, labels,
  reviewer explanations, and arrays. The server must still construct final
  displayed quotations from canonical bytes.
- Persist successful chunk results before continuing, using deterministic chunk
  and proposal identities so a retry cannot duplicate records.
- Resume at the failed chunk and reuse valid parse/OCR artifacts when document,
  parser, OCR, schema, prompt, and model hashes are unchanged.
- Reserve time for discovery and both review passes instead of allowing one
  phase to consume the entire shared deadline.
- Return a user-safe error such as: `The local model response was incomplete.
  Your file and OCR results were saved; retry will resume extraction.`

### P1 — scale and performance

- Benchmark smaller field groups, beginning around eight fields per model call,
  instead of changing limits without measurement.
- Split long documents by structural section or page window with small overlap;
  reconcile entities and equivalent values after per-chunk extraction.
- Run deterministic labeled-field extraction first and send only ambiguous or
  dynamic fields to the model.
- Route handwriting, low-confidence OCR, checkboxes, and signature regions to
  visual review selectively; do not visually reprocess clear native text.
- Bound concurrency by available memory and model context. Keep model weights
  warm across documents.
- Show document-, page-, chunk-, and review-level progress, plus elapsed time
  and a nonbinding estimate. Never show complete until persistence succeeds.
- Record only non-PHI timings, counts, model/version identifiers, outcome class,
  and retry count.

### P1 — test coverage and usability

- Add a regression test for the live `FileList` race.
- Add model fixtures that return truncated JSON, invalid JSON, an empty object,
  oversized arrays, and valid JSON at the output limit.
- Verify a failed extraction can resume without repeating successful OCR.
- Verify interrupted processing becomes retryable after restart.
- Verify queries and final exports remain locked until every selected document
  is successful, explicitly excluded, quarantined, or failed and disclosed.
- Verify error messages identify the failed phase and next action without
  echoing source text or personal identifiers.

## Performance baseline

These numbers are observations from one local machine and are not release
targets:

| Workload | Result | Observed time |
| --- | --- | ---: |
| Synthetic six-field intake through the extraction API | 6/6 published; two reviews; exact citation checks | 42.08 s |
| One-page synthetic administrative fact sheet through the browser | 6 values auto-published; 1 exception | about 76 s |
| Large DOCX extraction | Failed on truncated structured JSON | about 80 s |
| 17-page PDF extraction after successful OCR | Failed on truncated structured JSON | about 81 s for extraction |
| Individual OCR page requests in that PDF | All returned `200` | commonly 7–19.5 s/page |

The 8B model has previously produced roughly 20 output tokens per second on the
test hardware. Report parsing, OCR, extraction, review, validation, and save
times separately; a single total hides the bottleneck. Re-run benchmarks after
each reliability change and compare recall, precision, exception rate, and
exact-citation success—not speed alone.

## Validation after a fix

Run:

```bash
npm test
npm run lint
npm run build
```

Then perform a browser test with an isolated profile:

```bash
npm run local:model                                    # terminal 1
LOCAL_DATA_PROFILE=qa-ingest-fix npm run local -- -p 3010   # terminal 2
```

Confirm the page title is **Verity Caseworks** before testing.

Ingestion paths — each must produce an encrypted document write:

1. Click **Add files** and choose one small synthetic TXT fixture.
2. Drag a synthetic PDF from Finder onto the window. The dashed drop overlay
   must appear, and the app must **not** navigate away.
3. Copy a file in Finder and press `⌘V` over the window.
4. Drop a `.pages` or other unsupported file. It must be named in a skip notice,
   not silently ignored.
5. Stop Ollama, then add a file. It must still be stored, and appear with a
   retryable state and a message naming `npm run local:model` — never lost.

Extraction:

6. Restart Ollama and use **Retry extraction**. Confirm OCR is not repeated.
7. Add a multi-page synthetic PDF that needs OCR — the 17-page fixture that
   previously failed is the key regression. It must reach a terminal state.
8. Confirm any document that could not be scanned end to end shows
   `pagesScanned of totalPages` and stays retryable. It must never display as
   complete.
9. Confirm no error message on screen contains raw JSON, a `SyntaxError`, a
   stack trace, a filesystem path, or any document text.
10. Ask a narrow administrative query and inspect its exact source citation.
11. Confirm extraction survives a page reload and the console has no uncaught
    errors.

To force a truncation without a large document, temporarily lower
`EXTRACTION_TOKENS_PER_FIELD` in `src/lib/local-llm.ts` to `20`. Salvage must
still publish the complete field objects, and coverage must report `partial`.
Restore the constant afterward.

The last verified automated baseline was 35 passing tests, successful lint, and
a successful production build. The build emitted an existing Turbopack file-
trace warning related to the local-vault route; do not silently classify that
warning as an ingestion failure.

## Production readiness

The target is a firm-managed workstation processing hundreds of documents per
matter. These are the structural gaps between the current build and that target,
in dependency order. None are model-quality problems.

### Measured throughput does not reach that scale

One 6,000-character chunk took 71.8 s on the test hardware. OCR runs 7–19.5 s
per page. A 17-page PDF is roughly seven chunks of discovery plus OCR plus two
review passes — about twelve minutes. Two hundred documents is therefore on the
order of forty hours, run serially inside `importFiles` in a browser tab that
cannot be closed.

The highest-leverage change is not a faster model.
`deterministicLabeledProposals` already exists, already produces exact-byte
citations, and costs nothing, but the model still re-processes every chunk
regardless of what the regex pass already resolved. Legal intake forms, cover
sheets, service records, and notices are overwhelmingly `Label: value` lines.
Run the deterministic pass first and send only unresolved regions to the model.
Measure the reduction in model calls per document before tuning anything else.

### Persistence is quadratic

`updateWorkspace` is called once per document inside the import loop, and
`saveWorkspace` serializes the entire workspace — including every document's
full `canonicalText` — to JSON, ships it over HTTP, Zod-validates the whole
tree, re-encrypts it, and rewrites it. The workspace endpoint's bound is
256 MB. Document 200 rewrites all 200.

The project already builds a real SQLite database for export. That schema should
become the primary store, with per-document and per-occurrence rows, so a write
is O(1) and an interruption costs one document rather than the matter.

### Orchestration is owned by the browser

Closing the tab kills the batch. Import needs to move to a durable server-side
job queue with one row per document and resumable phases, leaving the browser as
a viewer that polls job state. This must land before any throughput tuning —
optimizing a serial browser loop that rewrites the whole workspace per document
optimizes the wrong layer.

### There is no accuracy measurement

All 35 tests pass and the export-package test is thorough, but nothing exercises
`src/lib/local-llm.ts`, and there is no labeled gold set. For a tool whose value
is that it is more accurate than a person reading the file, shipping without
per-field recall, precision, exception rate, and citation-exactness is the
largest risk in the project. Both defects fixed here would have been caught by a
fixture returning `done_reason: "length"`.

Required fixtures, none of which need a running model:

- truncated JSON mid-string and mid-object;
- invalid JSON;
- an empty object;
- an array exceeding `maxItems`;
- valid JSON exactly at the output limit;
- a live `FileList` cleared immediately after dispatch.

### Suggested sequence

| Phase | Work | Exit condition |
| --- | --- | --- |
| 1 | Validate the fixes in this document | 17-page PDF and large DOCX both reach a terminal state with honest coverage |
| 2 | Model-boundary fixtures and the `FileList` regression test | The fixed defects are unreproducible without a running model |
| 3 | Durable server-side job queue | Closing the tab mid-batch loses nothing |
| 4 | SQLite as primary store | Per-document write time is flat from document 1 to 200 |
| 5 | Deterministic-first routing, bounded concurrency, warm weights | Median form-heavy document under 90 s |
| 6 | Labeled gold set and per-release accuracy tracking | Published numbers a firm can rely on when accepting the tool |
| 7 | Multi-matter isolation, retention, tested backup/restore drill | A workstation can be approved against a completed checklist |

### What is already sound

Worth recording so it is not refactored away. Quotations are reconstructed from
immutable canonical bytes and verified for exact UTF-8 match; the server, not
the model, hydrates the final quote; prompt-injection screening covers the
surrounding context as well as the quote; `validatedLocalModelEndpoint` enforces
loopback strictly. The evidence layer is the hard part of this product and it is
correct. The defects were all in the orchestration around it.

## Agent and context-compaction handoff

### Repository rules

- Repository: `Legal-Data-Extractor` (local clone)
- The worktree may contain user and prior-agent changes. Inspect `git status`
  and preserve unrelated edits.
- Do not commit, push, open a PR, merge, discard, or delete changes unless the
  user explicitly requests that action.
- Use `rg`/`rg --files` for discovery and `apply_patch` for source edits.
- Do not assume port `3000` is Verity. Confirm the page identity and process.
- Do not include PHI or document contents in debugging output. Prefer document
  IDs, phases, page counts, confidence aggregates, error classes, and durations.

### Important code locations

- Upload orchestration and UI state: `src/components/legal-workspace.tsx`
- Local model extraction and review: `src/lib/local-llm.ts`
- Local parsing/OCR client: `src/lib/parsers.ts`
- Encrypted document/workspace routes: `src/app/api/local/`
- Workspace records and migration: inspect `src/lib/` for the current schema
  rather than relying on older narrative-fact documentation.
- End-user local setup: `docs/LOCAL_RUNBOOK.md`

### Compact continuation context

Copy this block into a new model/task after context compaction, then verify every
claim against the current code before editing:

```text
Project: Verity Caseworks local-first administrative legal-document extractor.
Repo: Legal-Data-Extractor (local clone)

Verified upload bug and fix:
- The browser FileList was copied only after an awaited readiness check while
  the input value was cleared. This produced "0 documents processed" and no
  document PUT/OCR/extract requests.
- importFiles now snapshots `Array.from(files)` before its first await.
- Browser E2E then showed document PUT 200, extract 200, persisted terminal
  state, 6 auto-published values, 1 exception, and clean console.

Resolved truncation failure:
- Root cause was an output-token budget below the JSON Schema ceiling, not a
  timeout. Primary extraction used 1,600 tokens for a 16-field schema; both
  review passes used 384 tokens for a 200-item schema (~55 IDs fit).
- structuredChat now classifies done_reason "length" as TruncatedModelOutputError
  before parsing, salvages complete array elements, retries at a smaller field
  budget, batches review at 40 candidates, and reserves 30% of the deadline for
  review. A failed review batch demotes proposals to the exceptions queue rather
  than discarding them.
- reviewSummary now reports coverage/pagesScanned/totalPages. A partially
  scanned document must never display as complete.

Resolved ingestion failure:
- No drop or paste handler existed; dragging a file navigated away from the app.
  Window paste listener and shell drag handlers now feed the same importFiles.
- Model readiness no longer disables upload. Files are always stored; extraction
  is held retryable when the model is down.

Next task:
Validate (npm test, lint, build, browser E2E on an isolated profile), then move
orchestration off the browser into a durable job queue and replace
whole-workspace writes with the SQLite schema. See ## Production readiness.

Guardrails:
- Verify current code and git status first; preserve dirty worktree changes.
- Do not log or quote PHI. Do not weaken exact UTF-8 citation verification.
- The server—not the model—hydrates final quotations from canonical bytes.
- Do not enable query/final export before selected documents are terminal.
- Validate with tests, lint, build, and browser E2E on an isolated data profile.
```

Update this document whenever the failure class, measured baseline, expected
request sequence, or next recommended implementation step changes.
