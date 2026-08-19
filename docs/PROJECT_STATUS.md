# Project Status

Last updated: 2026-08-19. Reflects `main` at the merge of PR #4.

## Where the project stands

The offline local appliance is functional end to end: ingest, OCR, extract,
dual model review, byte-exact citation verification, exception queue, encrypted
vault, and the portable case package. The online Vercel profile remains a
browser-processing pilot for synthetic data only.

The current focus is throughput and extraction recall on real matter files,
not the model boundary or the storage layer.

## Operating profile

| | Value |
| --- | --- |
| Default model host | oMLX (OpenAI-compatible) on `http://127.0.0.1:8000` |
| Text model | `Qwen3-8B-4bit` |
| Vision model | `Qwen3-VL-8B-Instruct-4bit` |
| Alternative host | Ollama on `http://127.0.0.1:11434` (`qwen3:8b`, `qwen3-vl:8b`) |
| Application port | `3000` — separate from the model host, never the same port |
| OCR | PP-OCRv5 (preferred), Tesseract eng/spa fallback, `qwen3-vl` for hard pages |
| Storage | Encrypted vault at `~/.verity-caseworks/data`, macOS Keychain key |

## Measured performance

Apple M3 Pro, 18 GB, `Qwen3-8B-4bit`, concurrency 4.

| Workload | Before | After |
| --- | --- | --- |
| 12 extraction spans | 94.8 s | 27.3 s |
| Aggregate generation | 22.9 tok/s | 79.8 tok/s |
| OCR, 4 pages | 37 s | 9.4 s |
| Single OCR page | 9.25 s | 2.35 s |

Single-request generation is about 23 tok/s. Concurrency gains flatten above 4;
6 and 8 measured 83 and 85 tok/s aggregate against 79.8 at 4.

## What changed most recently (PR #4)

- Request timeout is derived from the token budget rather than a flat 120 s.
  The old cap aborted any span that spent its budget and misreported a healthy
  model as unavailable.
- The per-document time budget scales with span count, not page count.
- Extraction spans and both reviewer passes share one bounded concurrency pool
  (`LOCAL_EXTRACTION_CONCURRENCY`, default 4). Results merge in document order.
- PDF pages OCR up to four at a time with back-pressure; PP-OCRv5 workers stay
  resident and exit after 90 s idle.
- Coverage is reported in spans as well as pages, and a timeout is now
  distinguished from an unreachable model.

## Known issues and open questions

1. **Extraction recall is lower than expected on real documents.** Under
   investigation. Runs against the same document have returned materially
   different numbers of approved values.
2. **Run-to-run variance at `temperature: 0`.** Three identical runs of one
   document produced 13/11, 9/4 and 5/4 extracted/approved values. Until this
   is understood, single-document benchmarks are not trustworthy and no model
   comparison based on one document should be believed.
3. **Memory is the binding constraint.** 18 GB holds the 8B text model (4.3 GB)
   and the 8B vision model (5.4 GB). A third resident model causes request
   failures. A full OCR worker pool adds 4.9 GB while a scan runs.
4. **Smaller models were tested and rejected.** `Qwen3-1.7B-4bit` had every
   proposal rejected by the reviewers. `Qwen3-4B-Instruct-2507-4bit` generates
   about twice as fast per token but did not show a defensible quality win.
   Neither is installed.
5. **No fixed benchmark set exists.** Model and prompt decisions need a
   multi-document fixture with known expected fields before they can be made on
   evidence rather than impression.

## Verification status

`npm test` 49 tests, `npm run lint`, `npx tsc --noEmit`, `npm run build`, and
`npm run local:check` (13 checks) all pass on `main`.
