export type MemoryStoreMode = "reader" | "writer";

export type MemoryValue = null | boolean | number | string | readonly MemoryValue[] | { readonly [key: string]: MemoryValue };

export interface MemoryRecord {
  readonly memoryId: string;
  readonly scopeId: string;
  readonly writerId: string;
  readonly sequence: number;
  readonly value: MemoryValue;
  readonly valueSha256: string;
  readonly recordedAt: string;
}

export interface LocalSqliteMemoryStoreOptions {
  readonly databasePath: string;
  readonly workspacePath: string;
  readonly mode: MemoryStoreMode;
  readonly scopeId: string;
  readonly writerId: string;
}

export interface PutMemoryInput {
  readonly memoryId: string;
  readonly value: MemoryValue;
  readonly recordedAt: string;
}

export type MemoryMutation =
  | { readonly operation: "add"; readonly memoryId: string; readonly value: MemoryValue; readonly recordedAt: string }
  | { readonly operation: "update"; readonly memoryId: string; readonly value: MemoryValue; readonly recordedAt: string };

export type CurationCoverage = "complete" | "partial" | "unknown";

export interface CurrentStateView {
  readonly identity: string;
  readonly phase: string | null;
  readonly milestones: readonly string[];
  readonly currentWork: readonly string[];
  readonly confirmedDecisions: readonly string[];
  readonly blockers: readonly string[];
  readonly limitations: readonly string[];
  readonly nextAction: string | null;
  readonly verificationStatus: "verified" | "stale" | "unverified";
  readonly relevantMemoryIds: readonly string[];
  readonly checkpointReference: string | null;
}

export interface CurationCheckpoint {
  readonly checkpointId: string;
  readonly scopeId: string;
  readonly sourceType: string;
  readonly sourceKeySha256: string;
  readonly coveredThroughMarker: string;
  readonly boundarySha256: string;
  readonly lastCuratedAt: string;
  readonly lastCandidateIds: readonly string[];
  readonly unresolvedCriticalIds: readonly string[];
  readonly relevantMemoryIds: readonly string[];
  readonly projectTaskId: string;
  readonly coverageConfidence: CurationCoverage;
  readonly lastCommittedMemorySequence: number;
  readonly currentViewVersion: number;
  readonly newRetainedSinceConsolidation: number;
  readonly currentView: CurrentStateView;
  readonly currentViewSha256: string;
  readonly checkpointSha256: string;
  readonly earliestTrustedMarker: string | null;
  readonly earliestTrustedBoundarySha256: string | null;
  readonly coverageChainComplete: boolean | null;
}

export type MemoryRecordKind = "belief" | "evidence" | "curation-decision";

export interface MemoryProvenance {
  readonly sourceType?: string;
  readonly sourceProject?: string;
  readonly sourceSession?: string;
  readonly sourceCheckpoint?: string;
  readonly sourceMarker?: string;
  readonly observedAt?: string | null;
  readonly evidenceHash?: string;
  readonly createdBy?: string;
  readonly derivationVersion?: string;
  readonly evidenceRefs?: readonly string[];
}

export type CurationCheckpointMetadata = Omit<CurationCheckpoint, "currentView">;

export interface RelatedMemoryQuery {
  readonly memoryId: string | null;
  readonly subjectKey: string;
  readonly projectTaskId: string;
  readonly category: string;
  readonly limit?: number;
}
