# HIPAA Technical Readiness Checklist

This checklist separates source-code controls from controls that require firm
approval or operational evidence. “Implemented” means the repository contains
the control; it does not mean a regulated entity has completed HIPAA compliance.

## Application controls

| Control | Status | Evidence |
| --- | --- | --- |
| External document and prompt egress blocked | Implemented | Local API and model host checks accept loopback only |
| Local OCR with self-hosted assets | Implemented | `src/lib/ocr.ts`, `public/ocr` build assets |
| Encrypted originals and canonical evidence | Implemented | AES-256-GCM local vault in `src/lib/local-vault.ts` |
| Password-based unique local identity | Implemented for single-user appliance | Local vault setup and session routes |
| Session expiration | Implemented | 30-minute idle and 12-hour absolute limits |
| Cross-site mutation protection | Implemented | Same-origin validation and strict same-site cookie |
| Exact citation integrity | Implemented | SHA-256 plus exact UTF-8 byte verification |
| Human approval before query | Implemented | Pending facts excluded from query |
| Authenticated review history | Implemented | Append-only `ReviewDecision` records |
| Tamper-evident audit events | Implemented | HMAC hash chain with verification |
| Legal-hold deletion block | Implemented | Client and vault enforcement |
| Encrypted backup generation | Implemented | Local authenticated backup route |
| Parser resource limits | Implemented | File, batch, page, render, and pixel limits |
| Spreadsheet formula injection protection | Implemented | CSV formula-prefix neutralization |
| Unsupported claims withheld | Implemented | Selected facts still undergo deterministic citation verification |
| Cloud/model fallback prohibited | Implemented | Loopback endpoint, non-cloud model-name validation, `OLLAMA_NO_CLOUD=1`, and no fallback |

## Firm-controlled safeguards

| Control | Status | Required completion evidence |
| --- | --- | --- |
| Enterprise risk analysis | Firm action required | Signed risk assessment covering workstation, users, backups, exports, and facilities |
| Security management process | Firm action required | Named security official, risk register, remediation tracking |
| Workforce authorization and termination | Firm action required | Joiner/mover/leaver procedure and access review records |
| Security awareness and sanctions | Firm action required | Training records and approved policy |
| Incident and breach response | Firm action required | Approved plan and completed tabletop exercise |
| Contingency and disaster recovery | Firm action required | Backup schedule and successful restoration evidence |
| Workstation security | Firm action required | Full-disk encryption, secure boot, EDR, patching, screen lock |
| MFA and operating-system identity | Firm action required | Managed identity policy and device configuration evidence |
| Browser and extension control | Firm action required | Managed browser policy and extension allowlist |
| Physical safeguards | Firm action required | Facility and workstation access policy |
| Retention schedule | Firm action required | Matter-class retention schedule approved by counsel |
| Backup and export destination control | Firm action required | Approved encrypted destination, DLP, and removable-media policy |
| Vendor and BAA review | Firm action required | Written determination for every service that creates, receives, maintains, or transmits PHI |
| Penetration test | Independent validation required | Current report and closed remediation items |
| Periodic technical evaluation | Firm action required | Scheduled annual and material-change reviews |

## Release gate for real PHI

Real PHI must not be used until:

1. every application control above passes automated and manual validation;
2. every firm-controlled safeguard has an owner and evidence;
3. local operation is demonstrated with the external network disconnected;
4. backup restoration and incident-response exercises pass;
5. legal, privacy, and security reviewers approve the documented residual risk.

## Latest repository validation

- Local and public production builds: passed.
- Lint and 12 automated tests: passed.
- Local readiness with loopback Ollama and `qwen3:8b`: passed.
- Production dependency audit (`npm audit --omit=dev`): zero known
  vulnerabilities.
- Development-only lint/build dependency audit: nine high-severity
  `brace-expansion` findings remain because the registry's proposed forced
  remediation breaks the current ESLint matcher API. The documented
  `local:prepare-runtime` step prunes those packages from the appliance after
  building, and `local:verify-runtime` audits the resulting production
  dependency boundary. The development dependency chain must still be upgraded
  when a compatible fix is available.
