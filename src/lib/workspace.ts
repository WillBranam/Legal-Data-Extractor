import type { WorkspaceState } from "@/lib/types";
import { defaultFieldDefinitions } from "@/lib/field-registry";

export function migrateWorkspaceToV2(workspace: WorkspaceState): WorkspaceState {
  if (workspace.schemaVersion === 2) {
    return {
      ...workspace,
      fieldDefinitions: workspace.fieldDefinitions?.length ? workspace.fieldDefinitions : defaultFieldDefinitions(),
      fieldOccurrences: workspace.fieldOccurrences ?? [], canonicalValues: workspace.canonicalValues ?? [],
      entities: workspace.entities ?? [], relationships: workspace.relationships ?? [], signatures: workspace.signatures ?? [],
      extractionSpecification: workspace.extractionSpecification ?? null, legacyFacts: workspace.legacyFacts ?? workspace.facts
    };
  }
  return {
    ...workspace, schemaVersion: 2, fieldDefinitions: defaultFieldDefinitions(), fieldOccurrences: [], canonicalValues: [],
    entities: [], relationships: [], signatures: [], extractionSpecification: null, legacyFacts: [...workspace.facts]
  };
}

export function createEmptyWorkspace(now = new Date()): WorkspaceState {
  return {
    schemaVersion: 2,
    matter: {
      id: `MAT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      name: "New local matter",
      court: "Not set",
      jurisdiction: "Not set",
      updatedAt: now.toISOString(),
      legalHold: false,
      retentionPolicy: {
        mode: "manual",
        retainUntil: null
      }
    },
    documents: [],
    citations: [],
    facts: [],
    reviewDecisions: [],
    fieldDefinitions: defaultFieldDefinitions(), fieldOccurrences: [], canonicalValues: [], entities: [], relationships: [], signatures: [], extractionSpecification: null, legacyFacts: []
  };
}
