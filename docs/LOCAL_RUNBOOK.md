# Offline Local-Appliance Runbook

## One-time preparation

Local-first v1 supports a firm-managed Mac with FileVault full-disk
encryption, screen lock, current patches, endpoint protection, and a controlled
browser profile.

Install Node.js 20.18 or newer, install Ollama, and install the application
dependencies while the preparation environment is permitted to use the
internet:

```bash
npm ci
ollama pull qwen3:8b
ollama pull qwen3-vl:8b
npm run local:build
npm run local:prepare-runtime
npm run local:verify-runtime
```

The application, OCR worker, OCR language data, and model weights can then run
without internet access.

The runtime-preparation step removes development-only dependencies from the
appliance checkout after the build. The verification step audits the production
dependency tree. Run `npm ci` again before rebuilding or running developer
tooling.

## Preflight

Start Ollama in a dedicated terminal with cloud features disabled:

```bash
npm run local:model
```

Keep that terminal running. In a second terminal, run:

```bash
npm run local:check
```

Every check must pass. In particular, the model endpoint must resolve to a
loopback address and the configured non-cloud model must already be installed.

## Start the appliance

For the production local build:

```bash
npm run local:start
```

Open:

```text
http://127.0.0.1:3000
```

Do not use `-H 0.0.0.0`, a LAN address, a reverse tunnel, or a public proxy.
The release validation must also be repeated with the workstation's external
network disconnected or blocked by host firewall policy.

For development with synthetic data:

```bash
npm run local
```

## First setup

No application login is required. On first start, the app creates a random
AES-256 vault key in the signed-in user's macOS Keychain. The individual macOS
account supplies unique user identification for this single-user appliance.
Do not use a shared OS account.

Workspaces created by an earlier password-based release do not produce a sign-in
prompt. Because those files cannot be decrypted without their former password,
Verity moves the complete locked vault to a timestamped `locked-vault` archive
beside the active data directory and opens a fresh Keychain-protected workspace.
The archived ciphertext is preserved for manual recovery or later disposal.

1. Confirm FileVault, automatic screen lock, and the firm's managed OS identity
   controls are active.
2. Start the app only through `npm run local:start`.
3. Confirm Settings shows:
   - AES-256-GCM local vault;
   - the expected local model;
   - a verified audit chain;
   - local technical PHI profile.

Losing the Keychain item makes the encrypted evidence unrecoverable.

## Matter workflow

1. Add supported files or a case folder.
2. Confirm each file reaches a ready source state and is not quarantined.
3. Confirm the administrative field registry fits the matter and dynamic
   labeled-field discovery is enabled.
4. Wait for classification, OCR, extraction, both independent model reviews,
   normalization, reconciliation, and deterministic byte checks.
5. Resolve only conflicts, uncertain handwriting, ambiguous identifiers or
   dates, and matter mismatches in **Exceptions**.
6. Use **Find Information** and inspect every exact-source citation.
7. Open **Download Case Package** and build the complete package. Download the ZIP for a
   self-contained handoff or download SQLite, DOCX, XLSX, and PDF files
   individually. The open files may contain PHI and must be saved only to an
   encrypted, access-controlled destination. CSV values are formula-neutralized,
   but the destination spreadsheet and workstation remain controlled systems.
8. Enable a legal hold when preservation duties apply.
9. Download an encrypted backup and move it to approved encrypted backup media.
10. Lock or sign out of macOS after use.

## Backup restoration exercise

The encrypted backup contains ciphertext from `~/.verity-caseworks/data`; the
Keychain-held decryption key is intentionally not included. Backup creation
registers the archive's audit head as an approved restore point in Keychain.
The appliance retains the latest 32 approved restore points and rejects an
unregistered filesystem rollback.

1. Stop the application.
2. Preserve the current `~/.verity-caseworks/data` directory.
3. Extract the backup into `~/.verity-caseworks/data`, or the absolute `LOCAL_DATA_DIRECTORY` selected by the firm.
4. Ensure the directory permission is `0700` and files are `0600` on Unix-like
   systems.
5. Restore only under the original managed macOS account with its Keychain item
   available. Cross-device recovery requires the firm's separately approved
   Keychain escrow/recovery procedure.
6. Confirm the audit chain verifies and a sample citation still byte-matches.
7. Record the exercise in the firm's continuity evidence.

Perform this test with synthetic data before relying on backups containing PHI.

## Incident response

If the workstation, OS account, Keychain, browser profile, export, or backup may be
compromised:

1. stop the appliance and disconnect the workstation according to the firm's
   incident plan;
2. preserve `~/.verity-caseworks/data/audit.jsonl` and relevant endpoint telemetry;
3. do not delete or modify evidence subject to legal hold;
4. notify the designated security and privacy contacts;
5. conduct the required HIPAA breach-risk assessment;
6. rotate credentials and rebuild the workstation before returning it to use.
