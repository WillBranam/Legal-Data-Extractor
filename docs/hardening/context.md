# Hardening evidence context

- Source root: `/Users/williambranam/Desktop/Freelance/Legal-Data-Extractor`
- Source revision: `8fcfede8f848712bc3b6b6d7cacc9590294aa9c3`
- Source drift: present; the local-appliance implementation is the current working tree.
- Security scan: `6d76cc34-7222-4013-b714-d9902aaa1ea6`
- Sealed manifest SHA-256:
  `42dea1e134e4899c9a7c4f8d18cbc71a813096f69cdbccf4f71ff12f460cdc04`

Evidence:

- `F1`: CSV formula injection in `src/lib/exports.ts`.
- `F2`: unbounded client parser resources in `src/lib/parsers.ts`.
- `C1`: browser persistence had no application authentication, encryption,
  durable audit log, recovery, or matter isolation.
- `C2`: the public pilot had no LLM and used first-sentence extraction.
- `C3`: citation verification already enforced canonical hashes and exact UTF-8
  quotations.

