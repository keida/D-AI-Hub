# Explicit Safe Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit `@D-AI rollback` workflow that preserves uncommitted work, performs only auditable Git revert/apply actions, verifies the recovery point, and fails closed without changing ordinary continue or close behavior.

**Architecture:** Extend the command protocol with a zero-argument `rollback` command targeting the active task. The runtime acquires the existing durable ownership lease, validates a recovery point and debug context, then calls an injected rollback operation whose implementation delegates to `safeRollback()`. Successful rollback persists the returned recovery state; any preservation, Git, or verification failure returns `BLOCKED` and leaves the recovery point and DebugSession durable.

**Tech Stack:** TypeScript, existing rollback domain module, existing runtime registry and file durable store, Vitest, real temporary Git repositories for integration coverage.

**Spec:** `docs/superpowers/specs/2026-08-20-d-ai-hub-design.md`

## Global Constraints

- `continue`, `handoff`, and `close` retain their current behavior.
- Rollback requires active durable ownership, a non-null recovery point, and a non-null durable context.
- Rollback may use only auditable successful `git revert` and `git apply`; `reset`, `clean`, force-push, and deletion are prohibited.
- User work must be preserved and independently verifiable before any revert/apply action.
- Any failure returns `BLOCKED` with a redacted actionable reason and does not claim recovery success.
- No new dependency or persistence backend; no automatic rollback on ordinary execution failure.

---

### Task 1: Add the explicit command contract

**Files:**
- Modify: `src/entry/command-parser.ts`
- Test: `tests/entry/command-parser.test.ts`

**Interfaces:**
- Produces: `DAICommand` variant `{ readonly kind: "rollback" }`.

- [ ] **Step 1: Write the failing parser tests**

Add assertions that `parseDAICommand("@D-AI rollback")` returns `{ kind: "rollback" }`, `@D-AI rollback extra` throws an exact-argument error, and rollback is no longer treated as an intent.

- [ ] **Step 2: Run the parser tests and verify failure**

Run: `npx vitest run tests/entry/command-parser.test.ts -t "rollback"`

Expected: FAIL because rollback is not a reserved command.

- [ ] **Step 3: Implement the smallest parser change**

Add the rollback variant, reserve the command name, enforce zero arguments, and return the new variant. Do not add task-id arguments or implicit task lookup changes in this task.

- [ ] **Step 4: Run focused parser tests**

Run: `npx vitest run tests/entry/command-parser.test.ts -t "rollback"`

Expected: PASS.

### Task 2: Wire an ownership-gated runtime rollback operation

**Files:**
- Modify: `src/runtime/d-ai-runtime.ts`
- Test: `tests/runtime/d-ai-runtime.test.ts`

**Interfaces:**
- Adds `rollbackTask: (state: TaskState, lease: TaskOwnershipLease) => Promise<RollbackResult>` to `DAIRuntimeDependencies`.
- Produces: `DAIResponse` with `status: "completed"` only after the injected rollback result verifies; otherwise `status: "blocked"`.

- [ ] **Step 1: Write failing runtime tests**

Add tests for: no active task; wrong environment ownership; missing recovery point; rollback adapter failure; and successful rollback. The successful test must assert the injected operation receives the active task and current ownership lease, and that the persisted response is `stage: "recover"` with the existing `debugSession` preserved.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npx vitest run tests/runtime/d-ai-runtime.test.ts -t "rollback"`

Expected: FAIL because the command variant and runtime branch do not exist.

- [ ] **Step 3: Implement the runtime branch**

Add `rollbackActiveTask()` using the existing registry serialization and `withDurableTaskOwnership()`. Before invoking `dependencies.rollbackTask`, require `state.recoveryPoint !== null` and `state.durableContext !== null`; pass the current state and lease; persist the returned recovery state with stage `recover`, role `recovery-operator`, and unchanged `debugSession`; redact all failure messages.

- [ ] **Step 4: Run focused runtime tests**

Run: `npx vitest run tests/runtime/d-ai-runtime.test.ts -t "rollback"`

Expected: PASS.

### Task 3: Connect safeRollback to a real Git adapter boundary

**Files:**
- Modify: `src/runtime/d-ai-runtime.ts`
- Modify: `src/recovery/rollback.ts` only if the adapter boundary needs a typed helper; preserve existing safety assertions.
- Test: `tests/integration/rollback-runtime.test.ts`

**Interfaces:**
- Consumes: `RollbackInput`, `RollbackResult`, and the injected runtime `rollbackTask` contract.
- Produces: a real temporary Git repository integration path that preserves work, reverts a known commit, applies the recovery patch, and verifies the recovery point.

- [ ] **Step 1: Write the failing real-Git integration test**

Create a temporary Git repository with one known commit and one uncommitted file, capture a recovery point, invoke `@D-AI rollback` through the runtime with a real adapter, and assert the commit revert/apply sequence plus a completed recovery response. Add a second test where verification returns failed and assert `BLOCKED` with no completed recovery claim.

- [ ] **Step 2: Run the integration tests and verify failure**

Run: `npx vitest run tests/integration/rollback-runtime.test.ts`

Expected: FAIL because the runtime has no real rollback connector wiring.

- [ ] **Step 3: Implement the adapter wiring**

Construct the injected operation from `safeRollback()` and the existing command runner/Git adapter. Preserve redacted auditable actions and pass the recovery point snapshot exactly; do not add destructive Git commands or fallback behavior.

- [ ] **Step 4: Run the integration tests**

Run: `npx vitest run tests/integration/rollback-runtime.test.ts`

Expected: PASS with both success and verification-failure cases.

### Task 4: Final regression and checkpoint review

**Files:**
- Test: `tests/entry/command-parser.test.ts`
- Test: `tests/runtime/d-ai-runtime.test.ts`
- Test: `tests/integration/rollback-runtime.test.ts`

- [ ] **Step 1: Run the complete suite**

Run: `npx vitest run; npm run build; git --no-pager diff --check`

Expected: all tests pass, build exits 0, and diff check reports no errors.

- [ ] **Step 2: Inspect the checkpoint**

Run: `git status --short --branch; git --no-pager diff --stat; git log -3 --oneline`

Confirm no unrelated files changed, no secrets were added, and no existing close/continue behavior changed.

- [ ] **Step 3: Stop before commit or push**

Report the exact verification evidence and wait for explicit commit approval. Do not push, merge, reset, clean, or delete files.
