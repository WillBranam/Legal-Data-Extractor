import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv
} from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import type { WorkspaceState } from "@/lib/types";

const CONFIG_FILE = "vault-config.json";
const WORKSPACE_FILE = "workspace.enc.json";
const AUDIT_FILE = "audit.jsonl";
const ORIGINALS_DIRECTORY = "originals";
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const VERIFIER_CONTEXT = "verity-caseworks-local-vault-verifier-v1";
const AUDIT_CONTEXT = "verity-caseworks-local-audit-v1";

interface VaultConfig {
  version: 1;
  username: string;
  salt: string;
  verifier: string;
  createdAt: string;
}

interface EncryptedPayload {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

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
  storage: "encrypted-local-vault";
  networkBoundary: "loopback-only";
  audit: {
    valid: boolean;
    records: number;
  } | null;
}

declare global {
  var __verityLocalSessions: Map<string, Session> | undefined;
}

function sessions(): Map<string, Session> {
  globalThis.__verityLocalSessions ??= new Map<string, Session>();
  return globalThis.__verityLocalSessions;
}

export function localOnlyModeEnabled(): boolean {
  return process.env.LOCAL_ONLY_MODE === "enabled";
}

export function localDataDirectory(): string {
  return path.join(process.cwd(), ".verity-local-data");
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

function encrypt(key: Buffer, plaintext: Buffer): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decrypt(key: Buffer, payload: EncryptedPayload): Buffer {
  if (payload.version !== 1 || payload.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported local vault format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );
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
  const config = await readConfig();
  const session = await authenticateLocalSession(token);
  return {
    enabled: localOnlyModeEnabled(),
    configured: config !== null,
    authenticated: session !== null,
    username: session?.username ?? null,
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
  if (!config || config.username !== input.username.trim()) return null;
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

export async function writeLocalWorkspace(
  session: Session,
  workspace: WorkspaceState
): Promise<void> {
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
}

export async function deleteLocalWorkspace(session: Session): Promise<void> {
  const workspace = await readLocalWorkspace(session);
  if (workspace?.matter.legalHold) throw new Error("LEGAL_HOLD_ACTIVE");
  try {
    await unlink(await encryptedFilePath(WORKSPACE_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await appendAuditEvent(
    session.key,
    session.username,
    "workspace.delete",
    "success",
    "matter",
    null
  );
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
  await atomicPrivateWrite(
    path.join(directory, `${documentId}.enc.json`),
    JSON.stringify(encrypt(session.key, bytes))
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
  const bytes = decrypt(session.key, payload);
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
}

export async function verifyAuditChain(
  session: Session
): Promise<{ valid: boolean; records: number }> {
  let text: string;
  try {
    text = await readFile(await encryptedFilePath(AUDIT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { valid: true, records: 0 };
    }
    throw error;
  }
  const lines = text.trim().split("\n").filter(Boolean);
  let previousHash: string | null = null;
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

export async function createEncryptedLocalBackup(session: Session): Promise<Buffer> {
  await appendAuditEvent(
    session.key,
    session.username,
    "backup.create",
    "success",
    "vault",
    null
  );
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const directory = await ensureDataDirectory();
  for (const filename of [CONFIG_FILE, WORKSPACE_FILE, AUDIT_FILE]) {
    try {
      zip.file(filename, await readFile(path.join(directory, filename)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const originalsPath = path.join(directory, ORIGINALS_DIRECTORY);
  try {
    for (const filename of await readdir(originalsPath)) {
      if (!filename.endsWith(".enc.json")) continue;
      zip.file(
        `${ORIGINALS_DIRECTORY}/${filename}`,
        await readFile(path.join(originalsPath, filename))
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
}
