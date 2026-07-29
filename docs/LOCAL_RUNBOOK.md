# Offline Local-Appliance Runbook

## One-time preparation

Use a firm-managed Mac, Windows, or Linux workstation with full-disk
encryption, screen lock, current patches, endpoint protection, and a controlled
browser profile.

Install Node.js 20.18 or newer, install Ollama, and install the application
dependencies while the preparation environment is permitted to use the
internet:

```bash
npm ci
ollama pull qwen3:8b
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

1. Enter the reviewer's unique name.
2. Create a vault password of at least 14 characters.
3. Store the password in the firm's approved password manager.
4. Confirm Settings shows:
   - AES-256-GCM local vault;
   - the expected local model;
   - a verified audit chain;
   - local technical PHI profile.

Losing the password makes the encrypted evidence unrecoverable.

## Matter workflow

1. Add supported files or a case folder.
2. Confirm each file reaches a ready evidence state.
3. Review the local-model proposals against the exact source quotations.
4. Approve only supported facts.
5. Query the approved record.
6. Inspect every answer citation.
7. Use XLSX, JSON, or DOCX for ordinary exports. CSV is formula-neutralized,
   but the destination spreadsheet and workstation remain controlled systems.
8. Enable a legal hold when preservation duties apply.
9. Download an encrypted backup and move it to approved encrypted backup media.
10. Sign out to destroy the in-memory session key.

## Backup restoration exercise

The encrypted backup is a portable copy of `.verity-local-data`.

1. Stop the application.
2. Preserve the current `.verity-local-data` directory.
3. Extract the backup into the repository as `.verity-local-data`.
4. Ensure the directory permission is `0700` and files are `0600` on Unix-like
   systems.
5. Start the appliance and unlock it with the original vault password.
6. Confirm the audit chain verifies and a sample citation still byte-matches.
7. Record the exercise in the firm's continuity evidence.

Perform this test with synthetic data before relying on backups containing PHI.

## Incident response

If the workstation, password, browser profile, export, or backup may be
compromised:

1. stop the appliance and disconnect the workstation according to the firm's
   incident plan;
2. preserve `.verity-local-data/audit.jsonl` and relevant endpoint telemetry;
3. do not delete or modify evidence subject to legal hold;
4. notify the designated security and privacy contacts;
5. conduct the required HIPAA breach-risk assessment;
6. rotate credentials and rebuild the workstation before returning it to use.
