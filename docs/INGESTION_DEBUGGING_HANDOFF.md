# Ingestion Debugging, Performance, and Agent Handoff

Last verified: August 18, 2026

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
- Larger DOCX and PDF files can still fail during structured extraction when
  `qwen3:8b` returns JSON truncated in the middle of a string. The stored source,
  parsed text, and OCR artifacts are retained, but the document is marked
  extraction failed and should expose a retry action.
- The next implementation priority is a bounded, resumable extraction strategy
  with automatic recovery from truncated model output. Do not treat increasing
  the model timeout alone as a sufficient fix.

## Know which server you are testing

Do not infer progress from HTTP `200` responses alone. The app polls
`GET /api/local/status` about every five seconds; those responses only prove
that the local readiness endpoint is alive.

Before debugging:

1. Confirm the browser title and UI are **Verity Caseworks**. A different local
   project has previously occupied port `3000`.
2. Prefer an isolated test profile and explicit port:

   ```bash
   cd "/Users/williambranam/Desktop/Freelance/Legal-Data-Extractor"
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
| OCR succeeds but extraction returns `400` after roughly a minute | Canonical artifact exists; extract error contains `Unterminated string in JSON` | Model output was truncated before valid JSON completed | Keep source/OCR artifacts, mark extraction failed, and retry only after bounded-output recovery is implemented |
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
async function importFiles(files: FileList | null): Promise<void> {
  const selected = files ? Array.from(files) : [];
  if (!workspace || selected.length === 0 || processing) return;

  // Readiness checks may await only after the immutable snapshot exists.
}
```

Regression requirements:

- Clearing the file input immediately after dispatch must not change the files
  seen by `importFiles`.
- Selecting one file must cause one encrypted document write before extraction.
- Selecting multiple files must preserve the original names and count.
- A readiness failure must explain why processing did not start and must not
  report `0 documents processed` as success.

## Current structured-extraction failure

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

Relevant current limits in `src/lib/local-llm.ts`:

- text model request timeout: 120 seconds;
- maximum fields per extraction chunk: 16;
- maximum text per extraction chunk: 6,000 characters;
- total extraction deadline: 4 minutes;
- primary structured output budget: 1,600 tokens;
- each review output budget: 384 tokens.

Treat these values as a recorded baseline, not recommended final settings.

## Fix list

### P0 — extraction reliability

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

1. Upload one small synthetic TXT fixture.
2. Confirm the document write occurs and the source row shows active progress.
3. Confirm extraction reaches a terminal state and survives a page reload.
4. Ask a narrow administrative query and inspect its exact source citation.
5. Upload a synthetic multi-page PDF that needs OCR.
6. Force one truncated response and confirm bounded resume does not repeat OCR
   or duplicate values.
7. Confirm the browser console has no uncaught errors.

The last verified automated baseline was 35 passing tests, successful lint, and
a successful production build. The build emitted an existing Turbopack file-
trace warning related to the local-vault route; do not silently classify that
warning as an ingestion failure.

## Agent and context-compaction handoff

### Repository rules

- Repository: `/Users/williambranam/Desktop/Freelance/Legal-Data-Extractor`
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
Repo: /Users/williambranam/Desktop/Freelance/Legal-Data-Extractor

Verified upload bug and fix:
- The browser FileList was copied only after an awaited readiness check while
  the input value was cleared. This produced "0 documents processed" and no
  document PUT/OCR/extract requests.
- importFiles now snapshots `Array.from(files)` before its first await.
- Browser E2E then showed document PUT 200, extract 200, persisted terminal
  state, 6 auto-published values, 1 exception, and clean console.

Current unresolved failure:
- Larger DOCX/PDF files store and parse successfully; the tested 17-page PDF
  also completed OCR for all pages at about 0.88 mean confidence.
- qwen3:8b extraction then returned HTTP 400 after about 80 seconds because the
  structured JSON ended mid-string (`Unterminated string in JSON`).
- Source/canonical/OCR artifacts remain stored. Do not re-OCR unchanged files.

Next task:
Implement and test bounded recovery for truncated model JSON: smaller field and
text groups, strict output lengths, resumable per-chunk persistence, deterministic
deduplication, phase-specific deadline reserves, and a PHI-safe user error.

Guardrails:
- Verify current code and git status first; preserve dirty worktree changes.
- Do not log or quote PHI. Do not weaken exact UTF-8 citation verification.
- The server—not the model—hydrates final quotations from canonical bytes.
- Do not enable query/final export before selected documents are terminal.
- Validate with tests, lint, build, and browser E2E on an isolated data profile.
```

Update this document whenever the failure class, measured baseline, expected
request sequence, or next recommended implementation step changes.
