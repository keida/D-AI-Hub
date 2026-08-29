# Local SQLite Memory Git Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first single-writer SQLite memory transfer slice with deterministic JSONL/manifest export and verified reader import.

**Architecture:** `src/memory/` is independent from `DurableContextStore`. `LocalSqliteMemoryStore` owns local records and import receipts; `MemoryBundleCodec` owns canonical JSONL/manifest validation; `memory-cli` composes them for explicit `put`, `get`, `export`, and `import` commands without Git transport.

**Tech Stack:** TypeScript, Node built-in `node:sqlite`, Node `crypto`, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-local-sqlite-memory-git-bundle-design.md`

## Global Constraints

- Keep `DurableContextStore`, lifecycle runtime, handoff, recovery, rollback, GitHub adapter, and Router unchanged.
- One configured writer only; reader mode must reject writes.
- Reject secret-shaped values before SQLite write and before export/import.
- Do not invoke Git/GitHub from this feature; operator push/pull is manual.
- Do not commit, push, or merge this task without explicit user authorization.

---

### Task 1: Local SQLite record boundary

**Files:**
- Create: `src/memory/types.ts`
- Create: `src/memory/local-sqlite-memory-store.ts`
- Test: `tests/memory/local-sqlite-memory-store.test.ts`

**Interfaces:**
- Produces: `MemoryRecord`, `MemoryStoreMode`, `PutMemoryInput`, `LocalSqliteMemoryStore.put`, `get`, and `close`.
- Consumes: `containsSecretShapedValue` from `src/domain/manifest-id.ts`.

- [x] Write failing tests that create a writer SQLite database, put `{ memoryId: "note-1", value: { text: "hello" } }`, close it, reopen it, and get the identical logical ID; add tests that reader mode rejects `put` and `ghp_123456789012345678901234567890` is rejected before a row exists.
- [x] Implement runtime-validated memory types with a portable `scopeId`, a configured `writerId`, positive monotonic sequence, canonical value hash, and `PutMemoryInput`.
- [x] Implement SQLite schema creation with `memory_records(scope_id, memory_id, writer_id, sequence, value_json, value_sha256, recorded_at)` plus a transaction-backed `put` that rejects reader mode, unsafe content, duplicate ID, and invalid JSON values.
- [x] Implement `get` with stored-value hash verification; ensure invalid input leaves no row behind.
- [x] Run `npx vitest run tests/memory/local-sqlite-memory-store.test.ts --maxWorkers 2 --minWorkers 2` and `npm run build`.

### Task 2: Deterministic bundle export and fail-closed import

**Files:**
- Create: `src/memory/memory-bundle-codec.ts`
- Modify: `src/memory/local-sqlite-memory-store.ts`
- Test: `tests/memory/memory-bundle-codec.test.ts`

**Interfaces:**
- Consumes: `MemoryRecord` and `LocalSqliteMemoryStore` from Task 1.
- Produces: `exportMemoryBundle`, `importMemoryBundle`, and `MemoryImportReceipt` with `IMPORTED`, `NOOP_DUPLICATE`, or `BLOCKED` outcomes.

- [x] Write failing tests with a writer database and a separate reader database: export two ordered records, import the bundle, and assert reader `get("note-1")` equals the writer value.
- [x] Add failing tests that alter one JSONL byte, repeat an unchanged import, re-use a bundle ID with a different digest, and use secret-shaped JSONL; assert tampering/unsafe/reused-different inputs are `BLOCKED` with no reader mutation and the unchanged repeat is `NOOP_DUPLICATE`.
- [x] Implement canonical JSON serialization, newline-delimited record output ordered by sequence, SHA-256 over the exact UTF-8 JSONL bytes, and a manifest validator for version, scope, writer, sequence range, count, digest, and safe bundle identifiers.
- [x] Add ordered `listAfter` and exact applied-bundle receipt lookup/write methods, backed by `applied_bundles(scope_id, bundle_id, records_sha256, applied_at)`.
- [x] Implement import as validate-first then one SQLite transaction: exact previous receipt returns `NOOP_DUPLICATE`; other receipt/content conflicts are `BLOCKED`; only a fully verified bundle inserts records plus its receipt.
- [x] Run `npx vitest run tests/memory/memory-bundle-codec.test.ts --maxWorkers 2 --minWorkers 2` and `npm run build`.

### Task 3: Explicit local CLI and operator runbook

**Files:**
- Create: `src/memory/memory-cli.ts`
- Modify: `package.json`
- Create: `docs/memory-sync-manual-workflow.md`
- Test: `tests/memory/memory-cli.test.ts`

**Interfaces:**
- Consumes: Task 1 store and Task 2 codec.
- Produces: `npm run memory -- put|get|export|import` with explicit database, scope, writer/mode, and bundle arguments.

- [x] Write failing CLI tests that invoke `put`, restart with `get`, export a bundle, import it into a reader database, and assert JSON output includes the same `memoryId`; add a test that reader-mode `put` exits non-zero without modifying SQLite.
- [x] Implement strict argument parsing with no default remote, Git, GitHub, network, or automatic sync behavior. Add only the `memory` npm script.
- [x] Write the manual two-device workflow: writer command sequence, manual Git review/commit/push, reader manual pull/import/get, and expected `NOOP_DUPLICATE`/`BLOCKED` responses. State that the SQLite database location must be outside the Git-tracked bundle directory.
- [x] Run `npx vitest run tests/memory/memory-cli.test.ts --maxWorkers 2 --minWorkers 2`, `npm run build`, and `npm test`.

### Task 4: Project-state and scope verification

**Files:**
- Modify: `projects/d-ai-hub/DECISIONS.md`
- Modify: `projects/d-ai-hub/STATUS.md`
- Modify: `projects/d-ai-hub/ROADMAP.md`
- Test: `git diff --check`

**Interfaces:**
- Records: the separate memory boundary, single-writer restriction, manual Git transport, explicit exclusions, and verified results from Tasks 1–3.

- [x] Reconcile the current checkpoint with actual branch, changed file set, completed verification, and the next concrete action.
- [x] Confirm the ADR does not promote SQLite, JSONL bundles, or GitHub transport above Git/Markdown control-plane ownership.
- [x] Run `git diff --check` and a targeted secret-shaped scan of the new bundle fixtures and documentation.
