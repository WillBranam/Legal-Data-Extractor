import { openDB } from "idb";
import type { WorkspaceState } from "@/lib/types";

const DATABASE_NAME = "verity-caseworks-local";
const STORE_NAME = "workspace";
const STATE_KEY = "current";

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
  return db.get(STORE_NAME, STATE_KEY);
}

export async function saveWorkspace(state: WorkspaceState): Promise<void> {
  const db = await database();
  await db.put(STORE_NAME, state, STATE_KEY);
}

export async function clearWorkspace(): Promise<void> {
  const db = await database();
  await db.delete(STORE_NAME, STATE_KEY);
}
