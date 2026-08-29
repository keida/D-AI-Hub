# Local SQLite Memory Git Bundle Design

## Goal

Provide one single-writer memory loop across two computers: `put` and `get` use local SQLite; an explicit export creates deterministic JSONL and a manifest; an operator manually pushes/pulls the bundle through private GitHub; a reader validates then imports it and retrieves the same ID.

## Boundary

`DurableContextStore` remains task-lifecycle infrastructure. It continues to own task ownership, handoff, recovery, rollback, close evidence, and its own manifests. The new `src/memory/` boundary owns only structured runtime memory records and imported-bundle receipts. It may reuse the existing secret detection, SHA-256 integrity discipline, workspace-identity concepts, and GitHub identity-preflight behavior; it must not alter those lifecycle services.

Git/Markdown remains the control plane for Skills, project state, knowledge, and decisions. SQLite is local runtime storage. Git-tracked JSONL/manifest bundles are a portable, auditable transfer artifact, not a new control plane or an automatic transport service.

## Data model

Each record has `memoryId`, `scopeId`, `writerId`, monotonic `sequence`, JSON `value`, `valueSha256`, and `recordedAt`. `scopeId` is a portable configured project identity, not an absolute path; each process separately validates its local workspace before selecting its configured scope. The writer configuration contains the sole permitted `writerId`; reader mode rejects `put`.

SQLite contains `memory_records` keyed by `(scope_id, memory_id)` and `applied_bundles` keyed by `(scope_id, bundle_id)`. Imports use one SQLite transaction: validate the entire bundle first, then either insert all records and the receipt or change nothing.

## Bundle contract

An export writes `records.jsonl` and `manifest.json` under a caller-selected Git-tracked bundle directory. JSONL has one canonical JSON record per line, ordered by sequence. The manifest contains `formatVersion: 1`, `bundleId`, `scopeId`, `writerId`, `fromSequence`, `toSequence`, `recordCount`, `recordsSha256`, and `createdAt`.

Import checks format, safe paths, scope, expected writer, strict sequence/order, record schema, SHA-256, count, and secret-shaped input before opening a write transaction. An already-applied `(scopeId, bundleId, recordsSha256)` returns `NOOP_DUPLICATE`; the same bundle ID with another digest, or an existing memory ID with another content digest, returns `BLOCKED`. No conflict resolution or automatic merge exists in this phase.

## Manual Git workflow

The writer runs `export`, reviews the bundle, then manually stages, commits, and pushes it to the private repository. The reader manually pulls, runs `import`, and calls `get`. The code neither invokes Git nor calls GitHub. Existing GitHub adapter preflight and remote-SHA verification remain available to the separate close path and are not changed by this slice.

## Validation

Focused integration tests create two temporary SQLite files and a temporary bundle directory. They prove restart reads, export/import same-ID retrieval, tamper rejection with no reader mutation, duplicate import `NOOP_DUPLICATE`, secret rejection, and reader-mode write rejection. A later operator acceptance run may use two real local clones and a private GitHub repository only after a separate release authorization.

## Explicit exclusions

No external memory product, Router expansion, automatic synchronization, multi-writer support, automatic merge, Supabase, embeddings/RAG, dashboard, background ingestion, or Git/GitHub transport is implemented.
