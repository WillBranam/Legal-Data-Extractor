# Security Hardening Review: Verity Caseworks

## Evidence Basis

The sealed scan at revision `8fcfede` found two low-severity implementation
issues and, more importantly for this decision, confirmed that the public pilot
used unauthenticated browser persistence. I inspected the current storage,
parsing, review, query, and export boundaries. Exact-byte citations were already
a useful invariant; the missing control owner was the protected local runtime.

## Constraints

We must support complete operation without internet access, use a local model,
retain human approval, preserve exact citations, and keep the Vercel profile
safe for synthetic data. We assume a managed workstation, but no measured model
latency or memory target was supplied.

## Opportunity Portfolio

| Opportunity | Evidence | Options | Recommendation | Proposal |
| --- | --- | --- | --- | --- |
| Own the protected workflow inside one local trust boundary | CSV output injection, parser exhaustion, unauthenticated browser storage, and the existing exact-citation invariant | Strengthened browser pilot; loopback local appliance | Use the local appliance for protected work; retain the browser profile only for synthetic demos | [Offline PHI boundary](proposals/offline-phi-boundary.md) |

## Recommendation Summary

I recommend the loopback local appliance under the stated offline requirement.
It moves encryption, identity, audit, model routing, originals, backup, and
legal-hold enforcement behind a single same-origin service while preserving
browser OCR and exact citation verification. The strengthened browser option is
cheaper and remains useful for demonstrations, but it cannot credibly own the
access, audit, and recovery controls needed for protected work.

## Next Decisions

The remaining decisions belong to the firm's security program: workstation and
MFA baseline, approved model, retention schedule, backup destination, incident
owners, penetration testing, and formal release approval.
