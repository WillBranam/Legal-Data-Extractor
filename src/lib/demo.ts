import { createCitation, sha256Bytes, sha256Text, utf8ByteLength } from "@/lib/evidence";
import type {
  Citation,
  EvidenceDocument,
  FactRecord,
  WorkspaceState
} from "@/lib/types";

const policyText = [
  "NORTHSTAR HEALTH — POLICY UPDATE",
  "",
  "Effective February 14, 2025, Northstar Health is updating prior authorization requirements to include additional clinical documentation for select services.",
  "",
  "The revised prior authorization requirements will apply to outpatient imaging services beginning March 1, 2025.",
  "",
  "Questions should be directed to Provider Services."
].join("\n");

const claimsText = [
  "NORTHSTAR HEALTH — CLAIMS SYSTEM NOTICE",
  "",
  "Northstar implemented a new claims system on January 8, 2025.",
  "",
  "Existing claim identifiers remain valid during the transition."
].join("\n");

async function demoDocument(
  id: string,
  name: string,
  canonicalText: string,
  pageCount: number
): Promise<EvidenceDocument> {
  const originalBytes = new TextEncoder().encode(canonicalText);
  return {
    id,
    name,
    mediaType: "application/pdf",
    size: originalBytes.byteLength,
    originalSha256: await sha256Bytes(originalBytes),
    canonicalSha256: await sha256Text(canonicalText),
    canonicalText,
    canonicalByteLength: utf8ByteLength(canonicalText),
    parserVersion: "verity-local-parser@0.1.0",
    pageCount,
    ingestedAt: "2025-05-10T20:21:00.000Z",
    processingState: "ready"
  };
}

export async function buildDemoWorkspace(): Promise<WorkspaceState> {
  const policyDocument = await demoDocument(
    "doc-policy",
    "NSH_Policy_Update_2025-02-14.pdf",
    policyText,
    4
  );
  const claimsDocument = await demoDocument(
    "doc-claims",
    "NSH_Claims_System_Notice.pdf",
    claimsText,
    2
  );

  const citationDefinitions = [
    {
      id: "cit-policy-one",
      document: policyDocument,
      exactQuote:
        "Effective February 14, 2025, Northstar Health is updating prior authorization requirements to include additional clinical documentation for select services.",
      pageNumber: 3
    },
    {
      id: "cit-policy-two",
      document: policyDocument,
      exactQuote:
        "The revised prior authorization requirements will apply to outpatient imaging services beginning March 1, 2025.",
      pageNumber: 4
    },
    {
      id: "cit-claims",
      document: claimsDocument,
      exactQuote: "Northstar implemented a new claims system on January 8, 2025.",
      pageNumber: 2
    }
  ];
  const citations: Citation[] = [];
  for (const definition of citationDefinitions) {
    citations.push(await createCitation(definition));
  }

  const facts: FactRecord[] = [
    {
      id: "fact-policy-one",
      matterId: "MN-2025-0421",
      type: "Event",
      statement:
        "Northstar Health changed its prior authorization requirements on February 14, 2025.",
      eventDate: "2025-02-14",
      confidence: 0.98,
      status: "approved",
      citationIds: ["cit-policy-one"],
      reviewer: "Jamie Lee",
      reviewedAt: "2025-05-10T20:21:00.000Z"
    },
    {
      id: "fact-policy-two",
      matterId: "MN-2025-0421",
      type: "Event",
      statement:
        "The revised requirements applied to outpatient imaging services beginning March 1, 2025.",
      eventDate: "2025-03-01",
      confidence: 0.96,
      status: "approved",
      citationIds: ["cit-policy-two"],
      reviewer: "Jamie Lee",
      reviewedAt: "2025-05-10T20:21:00.000Z"
    },
    {
      id: "fact-claims",
      matterId: "MN-2025-0421",
      type: "Event",
      statement: "Northstar implemented a new claims system on January 8, 2025.",
      eventDate: "2025-01-08",
      confidence: 0.86,
      status: "pending",
      citationIds: ["cit-claims"],
      reviewer: null,
      reviewedAt: null
    }
  ];

  return {
    matter: {
      id: "MN-2025-0421",
      name: "Morgan v. Northstar Health",
      court: "District Court",
      jurisdiction: "New York",
      updatedAt: "2025-05-12T14:42:00.000Z"
    },
    documents: [policyDocument, claimsDocument],
    citations,
    facts
  };
}
