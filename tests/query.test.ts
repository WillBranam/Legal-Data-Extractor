import { describe, expect, it } from "vitest";
import { buildDemoWorkspace } from "@/lib/demo";
import { queryApprovedFacts } from "@/lib/query";

describe("approved-only natural-language query", () => {
  it("returns only approved facts with verified citations", async () => {
    const workspace = await buildDemoWorkspace();
    const answer = await queryApprovedFacts({
      question: "What happened between January and March 2025?",
      facts: workspace.facts,
      citations: workspace.citations,
      documents: workspace.documents
    });
    expect(answer.status).toBe("verified");
    expect(answer.claims).toHaveLength(2);
    expect(answer.claims.every((claim) => claim.factId !== "fact-claims")).toBe(true);
  });

  it("abstains when no approved evidence matches", async () => {
    const workspace = await buildDemoWorkspace();
    const answer = await queryApprovedFacts({
      question: "What did the witness say about a red vehicle in 2038?",
      facts: workspace.facts,
      citations: workspace.citations,
      documents: workspace.documents
    });
    expect(answer.status).toBe("insufficient_evidence");
    expect(answer.claims).toEqual([]);
  });
});
