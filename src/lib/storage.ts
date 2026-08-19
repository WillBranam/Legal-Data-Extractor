import { openDB } from "idb";
import type { WorkspaceState } from "@/lib/types";
import { migrateWorkspaceToV2 } from "@/lib/workspace";

const DATABASE_NAME = "verity-caseworks-local";
const STORE_NAME = "workspace";
const STATE_KEY = "current";
const LEGACY_DEMO_MATTER_ID = "MN-2025-0421";
export type StorageMode = "browser-local" | "encrypted-local-vault";
let localWorkspaceRevision: string | null = null;
let localWorkspaceLegalHold = false;

async function database() {
  return openDB(DATABASE_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    }
  });
}

function normalizeWorkspace(state: WorkspaceState): WorkspaceState {
  return migrateWorkspaceToV2({
    ...state,
    matter: {
      ...state.matter,
      legalHold: state.matter.legalHold ?? false,
      retentionPolicy: state.matter.retentionPolicy ?? {
        mode: "manual",
        retainUntil: null
      }
    },
    documents: state.documents.map((document) => ({
      ...document,
      pages: document.pages ?? [],
      processingDurationMs: document.processingDurationMs ?? 0,
      ocrPageCount: document.ocrPageCount ?? 0,
      ocrMeanConfidence: document.ocrMeanConfidence ?? null
    })),
    reviewDecisions: state.reviewDecisions ?? []
  });
}

export async function loadWorkspace(
  mode: StorageMode = "browser-local"
): Promise<WorkspaceState | undefined> {
  if (mode === "encrypted-local-vault") {
    const response = await fetch("/api/local/workspace", {
      credentials: "same-origin",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`LOCAL_WORKSPACE_HTTP_${response.status}`);
    const body = (await response.json()) as {
      workspace: WorkspaceState | null;
      revision: string | null;
    };
    localWorkspaceRevision = body.revision;
    if (!body.workspace) return undefined;
    localWorkspaceLegalHold = body.workspace.matter.legalHold;
    return normalizeWorkspace(body.workspace);
  }
  const db = await database();
  const state = (await db.get(STORE_NAME, STATE_KEY)) as
    | WorkspaceState
    | undefined;
  if (!state) return undefined;
  if (state.matter.id === LEGACY_DEMO_MATTER_ID) {
    await db.delete(STORE_NAME, STATE_KEY);
    return undefined;
  }
  return normalizeWorkspace(state);
}

async function putLocalWorkspace(state: WorkspaceState): Promise<{ ok: boolean; error?: string; revision?: string }> {
  const response = await fetch("/api/local/workspace", {
    method: "PUT",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace: state,
      revision: localWorkspaceRevision,
      releaseLegalHold:
        localWorkspaceLegalHold && state.matter.legalHold === false
    })
  });
  const body = (await response.json().catch(() => ({}))) as {
    revision?: string;
    error?: string;
  };
  if (!response.ok) {
    return { ok: false, error: body.error ?? `LOCAL_WORKSPACE_HTTP_${response.status}` };
  }
  return { ok: true, revision: body.revision };
}

/**
 * Reads the vault's current revision without disturbing the caller's in-memory
 * workspace. Used to repair the cached revision after a conflict.
 */
async function refreshLocalWorkspaceRevision(): Promise<void> {
  const response = await fetch("/api/local/workspace", {
    credentials: "same-origin",
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`LOCAL_WORKSPACE_HTTP_${response.status}`);
  const body = (await response.json()) as { workspace: WorkspaceState | null; revision: string | null };
  localWorkspaceRevision = body.revision;
  if (body.workspace) localWorkspaceLegalHold = body.workspace.matter.legalHold;
}

async function saveLocalVaultWorkspace(state: WorkspaceState): Promise<void> {
  let result = await putLocalWorkspace(state);
  if (!result.ok && result.error === "WORKSPACE_CONFLICT") {
    // The cached revision drifted from the vault — typically because an earlier
    // write was applied by the server but its response was never recorded here.
    // Nothing ever repaired it, so every later save failed permanently. This
    // appliance is single-user with one vault, so re-reading the revision and
    // retrying once is the correct recovery. A second conflict means a genuine
    // concurrent writer and is surfaced rather than retried again.
    await refreshLocalWorkspaceRevision();
    result = await putLocalWorkspace(state);
  }
  if (!result.ok) throw new Error(result.error ?? "LOCAL_WORKSPACE_SAVE_FAILED");
  localWorkspaceRevision = result.revision ?? null;
  localWorkspaceLegalHold = state.matter.legalHold;
}

// Vault writes carry an optimistic revision, so two overlapping saves would
// both send the same one and the loser would corrupt the cached revision.
// Every save is chained so that can never happen.
let localWorkspaceWriteQueue: Promise<unknown> = Promise.resolve();

export async function saveWorkspace(
  state: WorkspaceState,
  mode: StorageMode = "browser-local"
): Promise<void> {
  if (mode === "encrypted-local-vault") {
    const write = localWorkspaceWriteQueue
      .catch(() => undefined)
      .then(() => saveLocalVaultWorkspace(state));
    localWorkspaceWriteQueue = write;
    return write;
  }
  const db = await database();
  await db.put(STORE_NAME, state, STATE_KEY);
}

export async function clearWorkspace(
  mode: StorageMode = "browser-local"
): Promise<void> {
  if (mode === "encrypted-local-vault") {
    const response = await fetch("/api/local/workspace", {
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`LOCAL_WORKSPACE_HTTP_${response.status}`);
    localWorkspaceRevision = null;
    localWorkspaceLegalHold = false;
    return;
  }
  const db = await database();
  await db.delete(STORE_NAME, STATE_KEY);
}
