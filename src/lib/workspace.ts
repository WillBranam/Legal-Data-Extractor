import type { WorkspaceState } from "@/lib/types";

export function createEmptyWorkspace(now = new Date()): WorkspaceState {
  return {
    matter: {
      id: `MAT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      name: "New local matter",
      court: "Not set",
      jurisdiction: "Not set",
      updatedAt: now.toISOString()
    },
    documents: [],
    citations: [],
    facts: []
  };
}
