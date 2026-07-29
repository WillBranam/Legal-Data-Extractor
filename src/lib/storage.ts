import { openDB } from "idb";
import type { WorkspaceState } from "@/lib/types";

const DATABASE_NAME = "verity-caseworks-local";
const STORE_NAME = "workspace";
const STATE_KEY = "current";
const LEGACY_DEMO_MATTER_ID = "MN-2025-0421";
export type StorageMode = "browser-local" | "encrypted-local-vault";

async function database() {
  return openDB(DATABASE_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    }
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
    const body = (await response.json()) as { workspace: WorkspaceState | null };
    if (!body.workspace) return undefined;
    return {
      ...body.workspace,
      matter: {
        ...body.workspace.matter,
        legalHold: body.workspace.matter.legalHold ?? false,
        retentionPolicy: body.workspace.matter.retentionPolicy ?? {
          mode: "manual",
          retainUntil: null
        }
      },
      documents: body.workspace.documents.map((document) => ({
        ...document,
        pages: document.pages ?? [],
        processingDurationMs: document.processingDurationMs ?? 0,
        ocrPageCount: document.ocrPageCount ?? 0,
        ocrMeanConfidence: document.ocrMeanConfidence ?? null
      })),
      reviewDecisions: body.workspace.reviewDecisions ?? []
    };
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
  return {
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
  };
}

export async function saveWorkspace(
  state: WorkspaceState,
  mode: StorageMode = "browser-local"
): Promise<void> {
  if (mode === "encrypted-local-vault") {
    const response = await fetch("/api/local/workspace", {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: state })
    });
    if (!response.ok) throw new Error(`LOCAL_WORKSPACE_HTTP_${response.status}`);
    return;
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
    return;
  }
  const db = await database();
  await db.delete(STORE_NAME, STATE_KEY);
}
