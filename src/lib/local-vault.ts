import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as nodeScrypt,
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
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { PassThrough, pipeline, type Readable } from "node:stream";
import type { WorkspaceState } from "@/lib/types";

const CONFIG_FILE = "vault-config.json";
const WORKSPACE_FILE = "workspace.enc.json";
const AUDIT_FILE = "audit.jsonl";
const ORIGINALS_DIRECTORY = "originals";
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
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

interface Session {
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
  authenticated: boolean;
  username: string | null;
  accessMode: "macos-keychain" | "legacy-password";
  storage: "encrypted-local-vault";
  networkBoundary: "loopback-only";
  audit: {
    valid: boolean;
    records: number;
  } | null;
}

declare global {
  var __verityLocalSessions: Map<string, Session> | undefined;
  var __verityKeychainKey: Buffer | undefined;
}

function sessions(): Map<string, Session> {
  globalThis.__verityLocalSessions ??= new Map<string, Session>();
  return globalThis.__verityLocalSessions;
}

export function localOnlyModeEnabled(): boolean {
  return process.env.LOCAL_ONLY_MODE === "enabled";
}

export function localDataDirectory(): string {
  const profile = process.env.LOCAL_DATA_PROFILE?.trim();
  if (!profile) {
    return path.join(/* turbopackIgnore: true */ process.cwd(), ".verity-local-data");
  }
  if (!/^[a-z0-9-]{1,40}$/i.test(profile)) {
    throw new Error("INVALID_LOCAL_DATA_PROFILE");
  }
  return path.join(
    /* turbopackIgnore: true */ process.cwd(),
    `.verity-local-data-${profile}`
  );
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

function localOsUsername(): string {
  const username = userInfo().username.trim();
  return username.length > 0 && username.length <= 80 ? username : "Local OS user";
}

function auditCheckpointService(): string {
  const profile = process.env.LOCAL_DATA_PROFILE?.trim() || "default";
  return `${AUDIT_HEAD_KEYCHAIN_SERVICE}.${profile}`;
}

interface AuditCheckpoint {
  sequence: number;
  hash: string;
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
  } catch {
    return null;
  }
  const checkpoint = JSON.parse(encoded) as AuditCheckpoint;
  if (
    !Number.isSafeInteger(checkpoint.sequence) ||
    checkpoint.sequence < 1 ||
    !/^[a-f0-9]{64}$/.test(checkpoint.hash)
  ) {
    throw new Error("AUDIT_CHECKPOINT_INVALID");
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

async function readKeychainKey(createWhenMissing: boolean): Promise<Buffer> {
  if (process.platform !== "darwin") throw new Error("MACOS_KEYCHAIN_REQUIRED");
  if (globalThis.__verityKeychainKey) {
    return Buffer.from(globalThis.__verityKeychainKey);
  }
  const username = localOsUsername();
  let encoded: string;
  try {
    const result = await execFile(
      "/usr/bin/security",
      ["find-generic-password", "-a", username, "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", maxBuffer: 4096 }
    );
    encoded = result.stdout.trim();
  } catch {
    if (!createWhenMissing) throw new Error("LOCAL_KEYCHAIN_ENTRY_MISSING");
    encoded = randomBytes(32).toString("base64url");
    try {
      await execFile(
        "/usr/bin/security",
        [
          "add-generic-password",
          "-a",
          username,
          "-s",
          KEYCHAIN_SERVICE,
          "-w",
          encoded
        ],
        { encoding: "utf8", maxBuffer: 4096 }
      );
    } catch {
      throw new Error("LOCAL_KEYCHAIN_CREATE_FAILED");
    }
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) {
    key.fill(0);
    throw new Error("LOCAL_KEYCHAIN_KEY_INVALID");
  }
  globalThis.__verityKeychainKey = Buffer.from(key);
  return key;
}

export async function osAccountLocalSession(): Promise<Session | null> {
  let config = await readConfig();
  if (config?.version === 1) return null;
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

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      32,
      {
        N: 1 << 15,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      }
    );
  });
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

function newSession(username: string, key: Buffer): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  sessions().set(createHash("sha256").update(token).digest("hex"), {
    username,
    key: Buffer.from(key),
    createdAt: now,
    lastSeenAt: now
  });
  return token;
}

function removeExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions()) {
    if (
      now - session.lastSeenAt > SESSION_IDLE_MS ||
      now - session.createdAt > SESSION_ABSOLUTE_MS
    ) {
      session.key.fill(0);
      sessions().delete(id);
    }
  }
}

export async function authenticateLocalSession(token: string | null): Promise<Session | null> {
  if (!token) return null;
  removeExpiredSessions();
  const session = sessions().get(createHash("sha256").update(token).digest("hex")) ?? null;
  if (session) session.lastSeenAt = Date.now();
  return session;
}

export async function localVaultStatus(token: string | null): Promise<LocalVaultStatus> {
  const initialConfig = await readConfig();
  const session =
    (await authenticateLocalSession(token)) ?? (await osAccountLocalSession());
  const config = initialConfig ?? (await readConfig());
  return {
    enabled: localOnlyModeEnabled(),
    configured: config !== null,
    authenticated: session !== null,
    username: session?.username ?? null,
    accessMode: config?.version === 1 ? "legacy-password" : "macos-keychain",
    storage: "encrypted-local-vault",
    networkBoundary: "loopback-only",
    audit: session ? await verifyAuditChain(session) : null
  };
}

export async function setupLocalVault(input: {
  username: string;
  password: string;
}): Promise<string> {
  if ((await readConfig()) !== null) throw new Error("Local vault is already configured.");
  const username = input.username.trim();
  if (username.length < 3 || username.length > 80) {
    throw new Error("Reviewer name must be between 3 and 80 characters.");
  }
  if (input.password.length < 14) {
    throw new Error("Local vault password must contain at least 14 characters.");
  }
  const salt = randomBytes(16);
  const key = await deriveKey(input.password, salt);
  const config: VaultConfig = {
    version: 1,
    username,
    salt: salt.toString("base64"),
    verifier: verifierFor(key).toString("base64"),
    createdAt: new Date().toISOString()
  };
  const target = await configPath();
  await writeFile(target, JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await chmod(target, 0o600);
  await appendAuditEvent(key, username, "vault.setup", "success", "vault", null);
  const token = newSession(username, key);
  key.fill(0);
  return token;
}

export async function loginLocalVault(input: {
  username: string;
  password: string;
}): Promise<string | null> {
  const config = await readConfig();
  if (
    !config ||
    config.version !== 1 ||
    config.username !== input.username.trim()
  ) return null;
  const key = await deriveKey(input.password, Buffer.from(config.salt, "base64"));
  if (!safeEqualBase64(config.verifier, verifierFor(key))) {
    key.fill(0);
    return null;
  }
  const token = newSession(config.username, key);
  await appendAuditEvent(key, config.username, "session.login", "success", "session", null);
  key.fill(0);
  return token;
}

export async function logoutLocalVault(token: string | null): Promise<void> {
  const session = await authenticateLocalSession(token);
  if (!session || !token) return;
  await appendAuditEvent(
    session.key,
    session.username,
    "session.logout",
    "success",
    "session",
    null
  );
  const id = createHash("sha256").update(token).digest("hex");
  session.key.fill(0);
  sessions().delete(id);
}

async function encryptedFilePath(filename: string): Promise<string> {
  return path.join(await ensureDataDirectory(), filename);
}

export async function readLocalWorkspace(session: Session): Promise<WorkspaceState | null> {
  try {
    const payload = JSON.parse(
      await readFile(await encryptedFilePath(WORKSPACE_FILE), "utf8")
    ) as EncryptedPayload;
    const workspace = JSON.parse(decrypt(session.key, payload).toString("utf8")) as WorkspaceState;
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
      const nextFactIds = new Set(workspace.facts.map((fact) => fact.id));
      const nextDecisionIds = new Set(
        workspace.reviewDecisions.map((decision) => decision.id)
      );
      if (
        existing.facts.some((fact) => !nextFactIds.has(fact.id)) ||
        existing.reviewDecisions.some((decision) => !nextDecisionIds.has(decision.id))
      ) {
        throw new Error("LEGAL_HOLD_PRESERVATION_REQUIRED");
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
    try {
      const lines = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const previous = JSON.parse(lines.at(-1)!) as AuditRecordBody & { hash: string };
        previousHash = previous.hash;
        sequence = previous.sequence + 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    await writeAuditCheckpoint({ sequence, hash });
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
  if (!checkpointMatched || (checkpoint && checkpoint.sequence > lines.length)) {
    return { valid: false, records: lines.length };
  }
  if (lines.length > 0 && (!checkpoint || checkpoint.sequence < lines.length)) {
    await writeAuditCheckpoint({ sequence: lines.length, hash: previousHash! });
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
  let outcomeRecorded = false;
  const recordOutcome = async (outcome: "success" | "failure") => {
    if (outcomeRecorded) return;
    outcomeRecorded = true;
    await appendAuditEvent(
      session.key,
      session.username,
      "backup.create",
      outcome,
      "vault",
      null
    );
  };
  pipeline(source, output, (error) => {
    void recordOutcome(error ? "failure" : "success").catch(() => undefined);
  });
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
      "backup.create",
      "failure",
      "vault",
      null
    );
    throw error;
  }
}
