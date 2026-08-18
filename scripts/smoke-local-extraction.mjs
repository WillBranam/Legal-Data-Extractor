// Drives the real extractWithLocalModel against whatever LOCAL_LLM_PROVIDER
// points at, so provider changes are verified through the actual extraction,
// review, and byte-citation path rather than a raw HTTP probe.
//
//   npx tsx scripts/smoke-local-extraction.mjs
//
// Synthetic content only. Never point this at real case data.
import { loadEnvFile } from "node:process";
try { loadEnvFile(".env.local"); } catch {}
const { extractWithLocalModel } = await import("../src/lib/local-llm.ts");
const { localModelProvider, validatedLocalModelName } = await import("../src/lib/local-model-provider.ts");

const text = `CIVIL CASE COVER SHEET
Case Number: 24STCV18432
Filing Date: March 14, 2024
Plaintiff: Maria Elena Sanchez-Rivera
Plaintiff Phone: (323) 555-0142
Plaintiff Email: m.sanchez.rivera@example.com
Defendant: Northstar Logistics Group, Inc.
Attorney for Plaintiff: Daniel R. Whitfield, Esq.
State Bar Number: 214877
Claim Number: NS-2024-004417
Date of Loss: November 2, 2023`;

const bytes = new TextEncoder().encode(text);
const doc = {
  id: "test-doc", name: "cover-sheet.txt", mediaType: "text/plain", size: bytes.byteLength,
  originalSha256: "0".repeat(64), canonicalArtifactSha256: "1".repeat(64),
  canonicalText: text, canonicalByteLength: bytes.byteLength,
  pages: [{ pageNumber: 1, canonicalByteStart: 0, canonicalByteEnd: bytes.byteLength,
            extractionMethod: "native-text", width: null, height: null,
            imageSha256: null, ocrConfidence: null }],
  pageCount: 1, processingState: "ready", ingestedAt: new Date().toISOString(),
  parserVersion: "test", processingDurationMs: 0, ocrPageCount: 0, ocrMeanConfidence: null
};

console.log(`provider=${localModelProvider()}  model=${validatedLocalModelName()}`);
const t0 = Date.now();
const result = await extractWithLocalModel(doc, []);
console.log(`elapsed_s=${((Date.now()-t0)/1000).toFixed(1)}`);
console.log("coverage:", result.reviewSummary.coverage,
            `pages ${result.reviewSummary.pagesScanned}/${result.reviewSummary.totalPages}`,
            "| reviewCompleted:", result.reviewSummary.reviewCompleted,
            "| truncationRecoveries:", result.reviewSummary.truncationRecoveries);
console.log("documentType:", result.documentType, "| language:", result.language);
console.log(`extracted=${result.reviewSummary.extracted} approved=${result.reviewSummary.consensusApproved} withheld=${result.reviewSummary.withheld}`);
for (const p of result.proposals) {
  const verified = new TextDecoder().decode(bytes.slice(p.canonicalByteStart, p.canonicalByteEnd)) === p.exactQuote;
  console.log(`  ${verified ? "OK " : "BAD"} ${p.displayLabel} = ${p.rawValue}  (conf ${p.confidence})`);
}
