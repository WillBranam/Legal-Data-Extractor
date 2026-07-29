import { openDB } from "idb";
import type { WorkspaceState } from "@/lib/types";

const DATABASE_NAME = "verity-caseworks-local";
const STORE_NAME = "workspace";
const STATE_KEY = "current";
const LEGACY_DEMO_MATTER_ID = "MN-2025-0421";

async function database() {
  return openDB(DATABASE_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    }
  });
}

export async function loadWorkspace(): Promise<WorkspaceState | undefined> {
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
    documents: state.documents.map((document) => ({
      ...document,
      pages: document.pages ?? [],
      processingDurationMs: document.processingDurationMs ?? 0,
      ocrPageCount: document.ocrPageCount ?? 0,
      ocrMeanConfidence: document.ocrMeanConfidence ?? null
    }))
  };
}

export async function saveWorkspace(state: WorkspaceState): Promise<void> {
  const db = await database();
  await db.put(STORE_NAME, state, STATE_KEY);
}

export async function clearWorkspace(): Promise<void> {
  const db = await database();
  await db.delete(STORE_NAME, STATE_KEY);
}
