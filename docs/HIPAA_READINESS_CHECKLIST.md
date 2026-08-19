# HIPAA Technical Readiness Checklist

This checklist separates source-code controls from controls that require firm
approval or operational evidence. “Implemented” means the repository contains
the control; it does not mean a regulated entity has completed HIPAA compliance.

## Application controls

| Control | Status | Evidence |
| --- | --- | --- |
| External document and prompt egress blocked | Implemented | Local API and model host checks accept loopback only |
| Tiered local OCR with self-hosted assets | Implemented with local prerequisites | PP-OCRv5 one-shot worker, bundled English/Spanish Tesseract assets, loopback visual fallback |
| Encrypted originals and canonical evidence | Implemented | AES-256-GCM local vault in `src/lib/local-vault.ts` |
| Case data excluded from build artifacts | Implemented | The vault defaults outside the repository; legacy vault, environment, sample, and vault paths are explicitly excluded from Next.js output tracing |
| Unique local identity | Implemented for single-user macOS appliance | Individual signed-in OS account; random vault key stored in macOS Keychain |
| Cross-site mutation protection | Implemented | Loopback host enforcement and same-origin validation |
| Exact citation integrity | Implemented | SHA-256 plus exact UTF-8 byte verification |
| Automatic verification before lookup | Implemented with residual model risk | Two separate local-model review passes, deterministic normalization, exact raw-value byte verification, and exception routing |
| Typed administrative record separation | Implemented | Verified occurrences, exceptions, withheld values, quarantined documents, and legacy narratives remain separate |
| Sensitive identifier handling | Implemented with explicit open-export risk | Values remain text, exact characters are required for auto-publication, identifiers are excluded from logs/filenames, export requires acknowledgement |
| Matter isolation | Implemented for explicit case-number conflict | Conflicting case number quarantines document; party-only mismatch remains a review exception design boundary |
| Signature claim limitation | Implemented | Presence-only status and explicit no-authenticity disclaimer in UI and every primary export |
| Signature region provenance | Guarded fallback | Native/electronic text anchors are supported. Visual observations without an exact region hash and bounding box remain exceptions and cannot auto-publish. |
| Tamper-evident audit events | Implemented | HMAC hash chain plus a separately protected macOS Keychain head checkpoint detects modification and rollback |
| Legal-hold deletion block | Implemented | Client and vault enforcement |
| Encrypted backup generation | Implemented | Loopback-only backup route; Keychain key excluded |
| Parser resource limits | Implemented with residual PDF risk | File, batch, page, render, image-header, DOCX expansion, and extracted-text limits |
| Spreadsheet formula injection protection | Implemented | CSV formula-prefix neutralization |
| Unsupported model prose withheld | Implemented | v2 publishes typed values only; no model-authored narrative summary is required or exported |
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
5. legal, privacy, and security reviewers approve the documented residual risk,
   including correlated errors from multiple passes of the same local model and
   the limits of any control after a fully compromised privileged OS account.

## Latest repository validation

- Local and public production builds: passed.
- Lint and 30 automated tests: passed.
- Local readiness verifies loopback Ollama, both local models, English/Spanish
  OCR assets, PP-OCRv5 Python and weights, and vault permissions; each target
  workstation must produce its own passing result.
- Production dependency audit (`npm audit --omit=dev`): zero known
  vulnerabilities.
- Full development and production dependency audit: zero known vulnerabilities.
