import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv
} from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { homedir, userInfo } from "node:os";
import { promisify } from "node:util";
import { PassThrough, pipeline, type Readable } from "node:stream";
import type { WorkspaceState } from "@/lib/types";
import { migrateWorkspaceToV2 } from "@/lib/workspace";

const CONFIG_FILE = "vault-config.json";
const WORKSPACE_FILE = "workspace.enc.json";
const AUDIT_FILE = "audit.jsonl";
const ORIGINALS_DIRECTORY = "originals";
const VERIFIER_CONTEXT = "verity-caseworks-local-vault-verifier-v1";
const AUDIT_CONTEXT = "verity-caseworks-local-audit-v1";
const KEYCHAIN_SERVICE = "com.verity-caseworks.local-vault";
const AUDIT_HEAD_KEYCHAIN_SERVICE = "com.verity-caseworks.audit-head";
const execFile = promisify(nodeExecFile);
const MAX_BACKUP_SOURCE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_BACKUP_FILES = 10_000;
let auditQueue: Promise<void> = Promise.resolve();
let workspaceQueue: Promise<void> = Promise.resolve();

function serializeWorkspaceOperation<T>(operation: () => Promise<T>): Promise<T> {
  const run = workspaceQueue.then(operation, operation);
  workspaceQueue = run.then(() => undefined, () => undefined);
  return run;
}

interface LegacyVaultConfig {
  version: 1;
  username: string;
  salt: string;
  verifier: string;
  createdAt: string;
}

interface OsAccountVaultConfig {
  version: 2;
  mode: "macos-keychain";
  username: string;
  verifier: string;
  createdAt: string;
}

type VaultConfig = LegacyVaultConfig | OsAccountVaultConfig;

interface EncryptedPayloadV1 {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

interface EncryptedPayloadV2 {
  version: 2;
  algorithm: "aes-256-gcm";
  binding: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

type EncryptedPayload = EncryptedPayloadV1 | EncryptedPayloadV2;

export interface Session {
  username: string;
  key: Buffer;
  createdAt: number;
  lastSeenAt: number;
}

interface AuditRecordBody {
  version: 1;
  sequence: number;
  occurredAt: string;
  actor: string;
  action: string;
  outcome: "success" | "failure";
  resourceType: string;
  resourceId: string | null;
  previousHash: string | null;
}

export interface LocalVaultStatus {
  enabled: boolean;
  configured: boolean;
  username: string | null;
  legacyVaultArchived: boolean;
  storage: "encrypted-local-vault";
  networkBoundary: "loopback-only";
  audit: {
    valid: boolean;
    records: number;
  } | null;
}

declare global {
  var __verityKeychainKeys: Map<string, Buffer> | undefined;
  var __verityLegacyVaultArchived: boolean | undefined;
}

export function localOnlyModeEnabled(): boolean {
  return process.env.LOCAL_ONLY_MODE === "enabled";
}

export function localDataDirectory(): string {
  const profile = process.env.LOCAL_DATA_PROFILE?.trim();
  if (profile && !/^[a-z0-9-]{1,40}$/i.test(profile)) {
    throw new Error("INVALID_LOCAL_DATA_PROFILE");
  }
  const configuredRoot = process.env.LOCAL_DATA_DIRECTORY?.trim();
  if (configuredRoot && !path.isAbsolute(configuredRoot)) {
    throw new Error("LOCAL_DATA_DIRECTORY_MUST_BE_ABSOLUTE");
  }
  const root = configuredRoot || path.join(homedir(), ".verity-caseworks");
  return profile ? path.join(root, "profiles", profile) : path.join(root, "data");
}

async function ensureDataDirectory(): Promise<string> {
  const directory = localDataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

async function configPath(): Promise<string> {
  return path.join(await ensureDataDirectory(), CONFIG_FILE);
}

async function readConfig(): Promise<VaultConfig | null> {
  try {
    return JSON.parse(await readFile(await configPath(), "utf8")) as VaultConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function archiveLockedLegacyVault(): Promise<void> {
  const directory = localDataDirectory();
  const checkpoint = await readAuditCheckpoint();
  const suffix = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const archive = path.join(
    path.dirname(directory),
    `${path.basename(directory)}.locked-vault-${suffix}`
  );
  await rename(directory, archive);
  try {
    if (checkpoint) {
      await atomicPrivateWrite(
        path.join(archive, "archived-audit-checkpoint.json"),
        JSON.stringify(checkpoint, null, 2)
      );
    }
    await deleteAuditCheckpoint();
    await ensureDataDirectory();
  } catch (error) {
    await rename(archive, directory).catch(() => undefined);
    throw error;
  }
  globalThis.__verityLegacyVaultArchived = true;
}

function localOsUsername(): string {
  const username = userInfo().username.trim();
  return username.length > 0 && username.length <= 80 ? username : "Local OS user";
}

function auditCheckpointService(): string {
  const profile = process.env.LOCAL_DATA_PROFILE?.trim() || "default";
  return `${AUDIT_HEAD_KEYCHAIN_SERVICE}.${profile}`;
}

function vaultKeychainService(): string {
  const profile = process.env.LOCAL_DATA_PROFILE?.trim() || "default";
  return `${KEYCHAIN_SERVICE}.${profile}`;
}

interface AuditCheckpoint {
  sequence: number;
  hash: string;
  restorePoints?: Array<{ sequence: number; hash: string }>;
}

export function auditRestorePointApproved(
  restorePoints: Array<{ sequence: number; hash: string }> | undefined,
  sequence: number,
  hash: string | null
): boolean {
  return restorePoints?.some(
    (restorePoint) =>
      restorePoint.sequence === sequence && restorePoint.hash === hash
  ) ?? false;
}

async function readAuditCheckpoint(): Promise<AuditCheckpoint | null> {
  if (process.platform !== "darwin") throw new Error("MACOS_KEYCHAIN_REQUIRED");
  let encoded: string;
  try {
    const result = await execFile(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        localOsUsername(),
        "-s",
        auditCheckpointService(),
        "-w"
      ],
      { encoding: "utf8", maxBuffer: 4096 }
    );
    encoded = result.stdout.trim();
  } catch (error) {
    const commandError = error as { code?: string | number; stderr?: string };
    if (
      commandError.code === 44 ||
      /could not be found in the keychain/i.test(commandError.stderr ?? "")
    ) {
      return null;
    }
    throw error;
  }
  const checkpoint = JSON.parse(encoded) as AuditCheckpoint;
  if (
    !Number.isSafeInteger(checkpoint.sequence) ||
    checkpoint.sequence < 1 ||
    !/^[a-f0-9]{64}$/.test(checkpoint.hash)
  ) {
    throw new Error("AUDIT_CHECKPOINT_INVALID");
  }
  for (const restorePoint of checkpoint.restorePoints ?? []) {
    if (
      !Number.isSafeInteger(restorePoint.sequence) ||
      restorePoint.sequence < 1 ||
      !/^[a-f0-9]{64}$/.test(restorePoint.hash)
    ) {
      throw new Error("AUDIT_CHECKPOINT_INVALID");
    }
  }
  return checkpoint;
}

async function writeAuditCheckpoint(checkpoint: AuditCheckpoint): Promise<void> {
  await execFile(
    "/usr/bin/security",
    [
      "add-generic-password",
      "-U",
      "-a",
      localOsUsername(),
      "-s",
      auditCheckpointService(),
      "-w",
      JSON.stringify(checkpoint)
    ],
    { encoding: "utf8", maxBuffer: 4096 }
  );
}

async function deleteAuditCheckpoint(): Promise<void> {
  try {
    await execFile(
      "/usr/bin/security",
      [
        "delete-generic-password",
        "-a",
        localOsUsername(),
        "-s",
        auditCheckpointService()
      ],
      { encoding: "utf8", maxBuffer: 4096 }
    );
  } catch (error) {
    const commandError = error as { code?: string | number; stderr?: string };
    if (
      commandError.code === 44 ||
      /could not be found in the keychain/i.test(commandError.stderr ?? "")
    ) {
      return;
    }
    throw error;
  }
}

async function approveCurrentAuditRestorePoint(): Promise<void> {
  const checkpoint = await readAuditCheckpoint();
  if (!checkpoint) throw new Error("AUDIT_CHECKPOINT_MISSING");
  const restorePoints = [
    ...(checkpoint.restorePoints ?? []),
    { sequence: checkpoint.sequence, hash: checkpoint.hash }
  ].filter(
    (candidate, index, candidates) =>
      candidates.findIndex(
        (item) => item.sequence === candidate.sequence && item.hash === candidate.hash
      ) === index
  ).slice(-32);
  await writeAuditCheckpoint({ ...checkpoint, restorePoints });
}

async function readKeychainSecret(service: string): Promise<string | null> {
  const username = localOsUsername();
  try {
    const result = await execFile(
      "/usr/bin/security",
      ["find-generic-password", "-a", username, "-s", service, "-w"],
      { encoding: "utf8", maxBuffer: 4096 }
    );
    return result.stdout.trim();
  } catch (error) {
    const commandError = error as { code?: string | number; stderr?: string };
    if (
      commandError.code === 44 ||
      /could not be found in the keychain/i.test(commandError.stderr ?? "")
    ) {
      return null;
    }
    throw error;
  }
}

async function writeKeychainSecret(service: string, encoded: string): Promise<void> {
  try {
    await execFile(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-U",
        "-a",
        localOsUsername(),
        "-s",
        service,
        "-w",
        encoded
      ],
      { encoding: "utf8", maxBuffer: 4096 }
    );
  } catch {
    throw new Error("LOCAL_KEYCHAIN_CREATE_FAILED");
  }
}

async function readKeychainKey(createWhenMissing: boolean): Promise<Buffer> {
  if (process.platform !== "darwin") throw new Error("MACOS_KEYCHAIN_REQUIRED");
  const service = vaultKeychainService();
  globalThis.__verityKeychainKeys ??= new Map<string, Buffer>();
  const cached = globalThis.__verityKeychainKeys.get(service);
  if (cached) return Buffer.from(cached);

  let encoded = await readKeychainSecret(service);
  if (!encoded && service !== KEYCHAIN_SERVICE) {
    encoded = await readKeychainSecret(KEYCHAIN_SERVICE);
    if (encoded) await writeKeychainSecret(service, encoded);
  }
  if (!encoded) {
    if (!createWhenMissing) throw new Error("LOCAL_KEYCHAIN_ENTRY_MISSING");
    encoded = randomBytes(32).toString("base64url");
    await writeKeychainSecret(service, encoded);
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) {
    key.fill(0);
    throw new Error("LOCAL_KEYCHAIN_KEY_INVALID");
  }
  globalThis.__verityKeychainKeys.set(service, Buffer.from(key));
  return key;
}

export async function osAccountLocalSession(): Promise<Session> {
  let config = await readConfig();
  if (config?.version === 1) {
    await archiveLockedLegacyVault();
    config = null;
  }
  const key = await readKeychainKey(config === null);

  if (!config) {
    const username = localOsUsername();
    const nextConfig: OsAccountVaultConfig = {
      version: 2,
      mode: "macos-keychain",
      username,
      verifier: verifierFor(key).toString("base64"),
      createdAt: new Date().toISOString()
    };
    try {
      await writeFile(await configPath(), JSON.stringify(nextConfig, null, 2), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      await chmod(await configPath(), 0o600);
      await appendAuditEvent(
        key,
        username,
        "vault.macos-keychain-initialize",
        "success",
        "vault",
        null
      );
      config = nextConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        key.fill(0);
        throw error;
      }
      config = await readConfig();
    }
  }

  if (!config || config.version !== 2 || !safeEqualBase64(config.verifier, verifierFor(key))) {
    key.fill(0);
    throw new Error("LOCAL_KEYCHAIN_KEY_MISMATCH");
  }
  return {
    username: config.username,
    key,
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  };
}

function verifierFor(key: Buffer): Buffer {
  return createHmac("sha256", key).update(VERIFIER_CONTEXT).digest();
}

function safeEqualBase64(expected: string, actual: Buffer): boolean {
  const expectedBytes = Buffer.from(expected, "base64");
  return expectedBytes.length === actual.length && timingSafeEqual(expectedBytes, actual);
}

function encrypt(key: Buffer, plaintext: Buffer, binding?: string): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (binding) cipher.setAAD(Buffer.from(binding, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const common = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
  return binding
    ? { version: 2, algorithm: "aes-256-gcm", binding, ...common }
    : { version: 1, algorithm: "aes-256-gcm", ...common };
}

function decrypt(key: Buffer, payload: EncryptedPayload, binding?: string): Buffer {
  if (![1, 2].includes(payload.version) || payload.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported local vault format.");
  }
  if (payload.version === 2 && payload.binding !== binding) {
    throw new Error("ENCRYPTED_PAYLOAD_BINDING_MISMATCH");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );
  if (payload.version === 2) {
    decipher.setAAD(Buffer.from(payload.binding, "utf8"));
  }
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ]);
}

async function atomicPrivateWrite(filePath: string, value: string): Promise<void> {
  const temporaryPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

export async function localVaultStatus(): Promise<LocalVaultStatus> {
  const session = await osAccountLocalSession();
  const config = await readConfig();
  return {
    enabled: localOnlyModeEnabled(),
    configured: config !== null,
    username: session.username,
    legacyVaultArchived: globalThis.__verityLegacyVaultArchived ?? false,
    storage: "encrypted-local-vault",
    networkBoundary: "loopback-only",
    audit: await verifyAuditChain(session)
  };
}

async function encryptedFilePath(filename: string): Promise<string> {
  return path.join(await ensureDataDirectory(), filename);
}

export async function readLocalWorkspace(session: Session): Promise<WorkspaceState | null> {
  try {
    const payload = JSON.parse(
      await readFile(await encryptedFilePath(WORKSPACE_FILE), "utf8")
    ) as EncryptedPayload;
    const workspace = migrateWorkspaceToV2(JSON.parse(decrypt(session.key, payload).toString("utf8")) as WorkspaceState);
    await appendAuditEvent(
      session.key,
      session.username,
      "workspace.read",
      "success",
      "matter",
      workspace.matter.id
    );
    return workspace;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function localWorkspaceRevision(): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(await encryptedFilePath(WORKSPACE_FILE)))
      .digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readLocalWorkspaceSnapshot(
  session: Session
): Promise<{ workspace: WorkspaceState | null; revision: string | null }> {
  return serializeWorkspaceOperation(async () => ({
    workspace: await readLocalWorkspace(session),
    revision: await localWorkspaceRevision()
  }));
}

export async function writeLocalWorkspace(
  session: Session,
  workspace: WorkspaceState,
  expectedRevision: string | null,
  releaseLegalHold = false
): Promise<string> {
  return serializeWorkspaceOperation(async () => {
    if ((await localWorkspaceRevision()) !== expectedRevision) {
      throw new Error("WORKSPACE_CONFLICT");
    }
    const existing = await readLocalWorkspace(session);
    if (
      existing?.matter.legalHold &&
      !workspace.matter.legalHold &&
      !releaseLegalHold
    ) {
      throw new Error("LEGAL_HOLD_ACTIVE");
    }
    if (existing?.matter.legalHold) {
      if (existing.matter.id !== workspace.matter.id) {
        throw new Error("LEGAL_HOLD_PRESERVATION_REQUIRED");
      }
      const nextDocuments = new Map(
        workspace.documents.map((document) => [document.id, document])
      );
      for (const document of existing.documents) {
        if (JSON.stringify(nextDocuments.get(document.id)) !== JSON.stringify(document)) {
          throw new Error("LEGAL_HOLD_PRESERVATION_REQUIRED");
        }
      }
      const nextCitations = new Map(
        workspace.citations.map((citation) => [citation.id, citation])
      );
      for (const citation of existing.citations) {
        if (JSON.stringify(nextCitations.get(citation.id)) !== JSON.stringify(citation)) {
          throw new Error("LEGAL_HOLD_PRESERVATION_REQUIRED");
        }
      }
      const nextFacts = new Map(workspace.facts.map((fact) => [fact.id, fact]));
      const nextDecisions = new Map(
        workspace.reviewDecisions.map((decision) => [decision.id, decision])
      );
      if (
        existing.facts.some(
          (fact) => JSON.stringify(nextFacts.get(fact.id)) !== JSON.stringify(fact)
        ) ||
        existing.reviewDecisions.some(
          (decision) =>
            JSON.stringify(nextDecisions.get(decision.id)) !== JSON.stringify(decision)
        )
      ) {
        throw new Error("LEGAL_HOLD_PRESERVATION_REQUIRED");
      }
      const protectedCollections = ["fieldDefinitions", "fieldOccurrences", "canonicalValues", "entities", "relationships", "signatures", "legacyFacts"] as const;
      for (const collection of protectedCollections) {
        const existingItems = existing[collection] ?? [];
        const nextItems = new Map((workspace[collection] ?? []).map((item) => [item.id, item]));
        if (existingItems.some((item) => JSON.stringify(nextItems.get(item.id)) !== JSON.stringify(item))) {
          throw new Error("LEGAL_HOLD_PRESERVATION_REQUIRED");
        }
      }
    }
    const legalHoldChanged =
      existing !== null &&
      existing.matter.legalHold !== workspace.matter.legalHold;
    const serialized = Buffer.from(JSON.stringify(workspace), "utf8");
    const payload = encrypt(session.key, serialized);
    serialized.fill(0);
    await atomicPrivateWrite(
      await encryptedFilePath(WORKSPACE_FILE),
      JSON.stringify(payload)
    );
    await appendAuditEvent(
      session.key,
      session.username,
      "workspace.write",
      "success",
      "matter",
      workspace.matter.id
    );
    if (legalHoldChanged) {
      await appendAuditEvent(
        session.key,
        session.username,
        workspace.matter.legalHold
          ? "matter.legal-hold-enable"
          : "matter.legal-hold-release",
        "success",
        "matter",
        workspace.matter.id
      );
    }
    const revision = await localWorkspaceRevision();
    if (!revision) throw new Error("WORKSPACE_WRITE_FAILED");
    return revision;
  });
}

export async function deleteLocalWorkspace(session: Session): Promise<void> {
  await serializeWorkspaceOperation(async () => {
    const workspace = await readLocalWorkspace(session);
    if (workspace?.matter.legalHold) throw new Error("LEGAL_HOLD_ACTIVE");
    try {
      await unlink(await encryptedFilePath(WORKSPACE_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (workspace) {
      const originalsPath = path.join(
        await ensureDataDirectory(),
        ORIGINALS_DIRECTORY
      );
      for (const document of workspace.documents) {
        if (!/^[a-f0-9-]{16,64}$/i.test(document.id)) continue;
        try {
          await unlink(path.join(originalsPath, `${document.id}.enc.json`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      try {
        if ((await readdir(originalsPath)).length === 0) {
          await rm(originalsPath, { recursive: false });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await appendAuditEvent(
      session.key,
      session.username,
      "workspace.delete",
      "success",
      "matter",
      null
    );
  });
}

export async function storeOriginalDocument(
  session: Session,
  documentId: string,
  bytes: Buffer
): Promise<void> {
  if (!/^[a-f0-9-]{16,64}$/i.test(documentId)) throw new Error("Invalid document ID.");
  const directory = path.join(await ensureDataDirectory(), ORIGINALS_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = path.join(directory, `${documentId}.enc.json`);
  try {
    await stat(target);
    throw new Error("ORIGINAL_ALREADY_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicPrivateWrite(
    target,
    JSON.stringify(encrypt(session.key, bytes, `original:${documentId}`))
  );
  await appendAuditEvent(
    session.key,
    session.username,
    "document.store-original",
    "success",
    "document",
    documentId
  );
}

export async function deleteStagedOriginalDocument(
  session: Session,
  documentId: string
): Promise<void> {
  if (!/^[a-f0-9-]{16,64}$/i.test(documentId)) {
    throw new Error("INVALID_DOCUMENT_ID");
  }
  await serializeWorkspaceOperation(async () => {
    const workspace = await readLocalWorkspace(session);
    if (workspace?.documents.some((document) => document.id === documentId)) {
      throw new Error("ORIGINAL_DOCUMENT_IN_USE");
    }
    try {
      await unlink(
        path.join(
          await ensureDataDirectory(),
          ORIGINALS_DIRECTORY,
          `${documentId}.enc.json`
        )
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await appendAuditEvent(
      session.key,
      session.username,
      "document.delete-staged-original",
      "success",
      "document",
      documentId
    );
  });
}

export async function readOriginalDocument(
  session: Session,
  documentId: string
): Promise<Buffer> {
  if (!/^[a-f0-9-]{16,64}$/i.test(documentId)) throw new Error("Invalid document ID.");
  const payload = JSON.parse(
    await readFile(
      path.join(
        await ensureDataDirectory(),
        ORIGINALS_DIRECTORY,
        `${documentId}.enc.json`
      ),
      "utf8"
    )
  ) as EncryptedPayload;
  const bytes = decrypt(
    session.key,
    payload,
    payload.version === 2 ? `original:${documentId}` : undefined
  );
  const workspace = await readLocalWorkspace(session);
  const document = workspace?.documents.find((item) => item.id === documentId);
  if (
    document &&
    createHash("sha256").update(bytes).digest("hex") !== document.originalSha256
  ) {
    bytes.fill(0);
    throw new Error("ORIGINAL_HASH_MISMATCH");
  }
  await appendAuditEvent(
    session.key,
    session.username,
    "document.read-original",
    "success",
    "document",
    documentId
  );
  return bytes;
}

export async function appendAuditEvent(
  key: Buffer,
  actor: string,
  action: string,
  outcome: "success" | "failure",
  resourceType: string,
  resourceId: string | null
): Promise<void> {
  const run = auditQueue.then(async () => {
    const auditPath = await encryptedFilePath(AUDIT_FILE);
    let previousHash: string | null = null;
    let sequence = 1;
    let lines: string[] = [];
    try {
      lines = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const previous = JSON.parse(lines.at(-1)!) as AuditRecordBody & { hash: string };
        previousHash = previous.hash;
        sequence = previous.sequence + 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const checkpoint = await readAuditCheckpoint();
    const currentSequence = sequence - 1;
    const checkpointMatchesCurrentHead = Boolean(
      checkpoint &&
      checkpoint.sequence === currentSequence &&
      checkpoint.hash === previousHash
    );
    const approvedRestorePoint = auditRestorePointApproved(
      checkpoint?.restorePoints,
      currentSequence,
      previousHash
    );
    if (
      !(
        (checkpoint === null && currentSequence === 0) ||
        checkpointMatchesCurrentHead ||
        approvedRestorePoint
      )
    ) {
      throw new Error("AUDIT_ROLLBACK_DETECTED");
    }
    const body: AuditRecordBody = {
      version: 1,
      sequence,
      occurredAt: new Date().toISOString(),
      actor,
      action,
      outcome,
      resourceType,
      resourceId: resourceId
        ? createHmac("sha256", key)
            .update("verity-caseworks-audit-resource-id-v1")
            .update(resourceId)
            .digest("hex")
        : null,
      previousHash
    };
    const hash = createHmac("sha256", key)
      .update(AUDIT_CONTEXT)
      .update(JSON.stringify(body))
      .digest("hex");
    await appendFile(auditPath, `${JSON.stringify({ ...body, hash })}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await chmod(auditPath, 0o600);
    await writeAuditCheckpoint({
      sequence,
      hash,
      restorePoints: checkpoint?.restorePoints
    });
  });
  auditQueue = run.catch(() => undefined);
  return run;
}

export async function verifyAuditChain(
  session: Session
): Promise<{ valid: boolean; records: number }> {
  await auditQueue;
  const checkpoint = await readAuditCheckpoint();
  let text: string;
  try {
    text = await readFile(await encryptedFilePath(AUDIT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { valid: checkpoint === null, records: 0 };
    }
    throw error;
  }
  const lines = text.trim().split("\n").filter(Boolean);
  let previousHash: string | null = null;
  let checkpointMatched = checkpoint === null;
  for (let index = 0; index < lines.length; index += 1) {
    const record = JSON.parse(lines[index]) as AuditRecordBody & { hash: string };
    const body: AuditRecordBody = {
      version: record.version,
      sequence: record.sequence,
      occurredAt: record.occurredAt,
      actor: record.actor,
      action: record.action,
      outcome: record.outcome,
      resourceType: record.resourceType,
      resourceId: record.resourceId,
      previousHash: record.previousHash
    };
    const expected = createHmac("sha256", session.key)
      .update(AUDIT_CONTEXT)
      .update(JSON.stringify(body))
      .digest("hex");
    if (
      record.sequence !== index + 1 ||
      record.previousHash !== previousHash ||
      expected.length !== record.hash.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(record.hash))
    ) {
      return { valid: false, records: lines.length };
    }
    previousHash = record.hash;
    if (checkpoint?.sequence === record.sequence) {
      checkpointMatched = checkpoint.hash === record.hash;
    }
  }
  const approvedRestorePoint = auditRestorePointApproved(
    checkpoint?.restorePoints,
    lines.length,
    previousHash
  );
  if (
    (!checkpointMatched || (checkpoint && checkpoint.sequence > lines.length)) &&
    !approvedRestorePoint
  ) {
    return { valid: false, records: lines.length };
  }
  if (
    lines.length > 0 &&
    (approvedRestorePoint || !checkpoint || checkpoint.sequence < lines.length)
  ) {
    await writeAuditCheckpoint({
      sequence: lines.length,
      hash: previousHash!,
      restorePoints: checkpoint?.restorePoints
    });
  }
  return { valid: true, records: lines.length };
}

export async function localVaultFileStats(): Promise<{
  workspaceBytes: number;
  auditBytes: number;
}> {
  async function size(filename: string): Promise<number> {
    try {
      return (await stat(await encryptedFilePath(filename))).size;
    } catch {
      return 0;
    }
  }
  return {
    workspaceBytes: await size(WORKSPACE_FILE),
    auditBytes: await size(AUDIT_FILE)
  };
}

async function buildEncryptedLocalBackupStream(
  session: Session
): Promise<Readable> {
  await appendAuditEvent(
    session.key,
    session.username,
    "backup.create-attempt",
    "success",
    "vault",
    null
  );
  await approveCurrentAuditRestorePoint();
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const directory = await ensureDataDirectory();
  const entries: Array<{ archivePath: string; sourcePath: string; size: number }> = [];
  for (const filename of [CONFIG_FILE, WORKSPACE_FILE, AUDIT_FILE]) {
    try {
      const sourcePath = path.join(directory, filename);
      entries.push({
        archivePath: filename,
        sourcePath,
        size: (await stat(sourcePath)).size
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const originalsPath = path.join(directory, ORIGINALS_DIRECTORY);
  const referencedOriginals = new Set<string>();
  const workspace = await readLocalWorkspace(session);
  for (const document of workspace?.documents ?? []) {
    if (/^[a-f0-9-]{16,64}$/i.test(document.id)) {
      referencedOriginals.add(`${document.id}.enc.json`);
    }
  }
  try {
    for (const filename of await readdir(originalsPath)) {
      if (!referencedOriginals.has(filename)) continue;
      const sourcePath = path.join(originalsPath, filename);
      entries.push({
        archivePath: `${ORIGINALS_DIRECTORY}/${filename}`,
        sourcePath,
        size: (await stat(sourcePath)).size
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (entries.length > MAX_BACKUP_FILES || totalBytes > MAX_BACKUP_SOURCE_BYTES) {
    throw new Error("BACKUP_SIZE_LIMIT_EXCEEDED");
  }
  for (const entry of entries) {
    zip.file(entry.archivePath, createReadStream(entry.sourcePath));
  }
  const source = zip.generateNodeStream({
    type: "nodebuffer",
    streamFiles: true,
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
  const output = new PassThrough();
  pipeline(source, output, () => undefined);
  return output;
}

export async function createEncryptedLocalBackupStream(
  session: Session
): Promise<Readable> {
  try {
    return await buildEncryptedLocalBackupStream(session);
  } catch (error) {
    await appendAuditEvent(
      session.key,
      session.username,
      "backup.create-attempt",
      "failure",
      "vault",
      null
    );
    throw error;
  }
}
