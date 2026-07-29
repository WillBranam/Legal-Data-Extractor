import type {
  AnswerClaim,
  Citation,
  EvidenceDocument,
  FactRecord,
  QueryAnswer
} from "@/lib/types";
import { verifyCitation } from "@/lib/evidence";

const STOP_WORDS = new Set([
  "a",
  "about",
  "and",
  "are",
  "between",
  "did",
  "do",
  "for",
  "from",
  "happened",
  "in",
  "is",
  "of",
  "on",
  "the",
  "to",
  "what",
  "when",
  "who",
  "with"
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}-]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function yearFromQuestion(question: string): string | null {
  return question.match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
}

function scoreFact(question: string, fact: FactRecord): number {
  const queryTokens = new Set(tokenize(question));
  const factTokens = tokenize(
    `${fact.statement} ${fact.type} ${fact.eventDate ?? ""}`
  );
  const tokenScore = factTokens.reduce(
    (total, token) => total + (queryTokens.has(token) ? 1 : 0),
    0
  );
  const year = yearFromQuestion(question);
  const yearScore = year && fact.eventDate?.startsWith(year) ? 2 : 0;
  const evidenceScore = tokenScore + yearScore;
  return evidenceScore > 0 ? evidenceScore + fact.confidence : 0;
}

export async function queryApprovedFacts(input: {
  question: string;
  facts: FactRecord[];
  citations: Citation[];
  documents: EvidenceDocument[];
  limit?: number;
}): Promise<QueryAnswer> {
  const citationMap = new Map(input.citations.map((citation) => [citation.id, citation]));
  const documentMap = new Map(input.documents.map((document) => [document.id, document]));
  const candidates = input.facts
    .filter((fact) => fact.status === "approved")
    .map((fact) => ({ fact, score: scoreFact(input.question, fact) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit ?? 3);

  const claims: AnswerClaim[] = [];
  for (const { fact, score } of candidates) {
    const verifiedCitationIds: string[] = [];
    for (const citationId of fact.citationIds) {
      const citation = citationMap.get(citationId);
      if (!citation) continue;
      const result = await verifyCitation(citation, documentMap.get(citation.documentId));
      if (result.verified) verifiedCitationIds.push(citationId);
    }
    if (verifiedCitationIds.length > 0) {
      claims.push({
        factId: fact.id,
        statement: fact.statement,
        citationIds: verifiedCitationIds,
        score
      });
    }
  }

  return {
    status: claims.length > 0 ? "verified" : "insufficient_evidence",
    question: input.question,
    claims
  };
}
