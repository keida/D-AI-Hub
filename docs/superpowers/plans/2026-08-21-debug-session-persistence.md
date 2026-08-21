# Debug Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the systematic debugging session alongside durable task state so a blocked task can resume after a process restart without losing its failure, recovery point, or hypothesis phase.

**Architecture:** Add an optional `debugSession` value to `TaskState`, validate it at the durable store and handoff envelope boundaries, and persist the session whenever runtime enters or advances debugging. Keep the existing immutable snapshot and ownership publication protocol unchanged. Rollback execution remains a separate follow-up slice.

**Tech Stack:** TypeScript, Zod, Vitest, existing file durable-context store, existing handoff envelope redaction.

**Spec:** `docs/superpowers/specs/2026-08-20-d-ai-hub-design.md`

## Global Constraints

- Preserve immutable generations, active-pointer fencing, heartbeat propagation, and ownership-before-write ordering.
- Do not add dependencies or a new persistence backend.
- Debug session text must pass the existing secret-redaction boundary before durable persistence or handoff serialization.
- A malformed or missing required debug-session field must fail closed with `InvalidTaskStateError` or `InvalidHandoffError`.
- Do not change the existing `safeRollback()` behavior in this slice.

---

### Task 1: Define the durable debug-session contract

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/state/file-durable-context-store.ts`
- Modify: `src/handoff/envelope.ts`
- Test: `tests/state/file-durable-context-store.test.ts`
- Test: `tests/handoff/handoff-service.test.ts`

**Interfaces:**
- Consumes: existing `DebugSession` fields from `src/debugging/debug-session.ts`.
- Produces: `TaskState.debugSession?: DebugSession | null | undefined` and matching strict validation in the file store and handoff envelope.

- [ ] **Step 1: Write the failing tests**

Add a real-store test that saves a state with `{ phase: "hypothesize", originalFailure: "build exits 1", hypothesis: "manifest mismatch", preservedRecoveryPointId: "recovery-1" }`, reloads it, and expects the exact session. Add a handoff test that serializes the same state and expects `debugSession` to be present and redacted through the existing string redaction path.

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `npx vitest run tests/state/file-durable-context-store.test.ts tests/handoff/handoff-service.test.ts -t "debug session"`

Expected: FAIL because `TaskState` and the strict store/envelope schemas do not yet accept or serialize `debugSession`.

- [ ] **Step 3: Add the strict contract**

Define the `DebugPhase` and `DebugSession` types in the domain layer without duplicating the phase union in consumers. Add a strict Zod schema using the same phase values and add `debugSession` as an optional nullable field so old durable states remain readable. Include it in the handoff envelope copy/redaction function and reject secret-shaped text using the existing redaction validation.

- [ ] **Step 4: Run the focused tests to verify the contract**

Run: `npx vitest run tests/state/file-durable-context-store.test.ts tests/handoff/handoff-service.test.ts -t "debug session"`

Expected: PASS with no unrelated test failures.

- [ ] **Step 5: Commit the contract slice**

Run:

```powershell
git add src/domain/types.ts src/state/file-durable-context-store.ts src/handoff/envelope.ts tests/state/file-durable-context-store.test.ts tests/handoff/handoff-service.test.ts
git commit -m "feat: persist debug session contract"
```

### Task 2: Persist debug-session state through runtime recovery

**Files:**
- Modify: `src/runtime/d-ai-runtime.ts`
- Modify: `src/state/file-durable-context-store.ts`
- Test: `tests/runtime/d-ai-runtime.test.ts`

**Interfaces:**
- Consumes: `TaskState.debugSession` and existing `createDebugSession`, `setDebugHypothesis`, `advanceDebugSession`, and `recordRepeatedFailure` functions.
- Produces: runtime responses whose durable state retains the current debug phase and hypothesis across a fresh runtime instance.

- [ ] **Step 1: Write the failing runtime test**

Create a real file-store runtime fixture that forces execution failure, asserts the blocked response contains a durable `debugSession`, creates a fresh runtime using the same store, continues the task, and asserts the loaded session still has the same `originalFailure`, `preservedRecoveryPointId`, and phase.

- [ ] **Step 2: Run the focused test to verify failure**

Run: `npx vitest run tests/runtime/d-ai-runtime.test.ts -t "persists debug session"`

Expected: FAIL because `enterRecovery()` currently calls `createDebugSession()` but discards the returned session.

- [ ] **Step 3: Persist the session at the existing recovery boundary**

Make `enterRecovery()` assign the created session to `debugSession` on the debug state before `persistState()`. Keep the existing `debug` stage, `debugger` role, recovery point, and redacted failure message unchanged. Do not add a second save path or a runtime flag.

- [ ] **Step 4: Persist phase transitions without inventing a new command**

When the existing recovery path records a repeated verification failure, update only `debugSession` using `recordRepeatedFailure()` and persist the returned session together with the existing blocked state. If the session is absent where a repeated failure requires it, return `BLOCKED` with a specific reason.

- [ ] **Step 5: Run focused runtime and state tests**

Run: `npx vitest run tests/runtime/d-ai-runtime.test.ts tests/state/file-durable-context-store.test.ts -t "debug|recovery"`

Expected: PASS.

- [ ] **Step 6: Commit the runtime slice**

Run:

```powershell
git add src/runtime/d-ai-runtime.ts src/state/file-durable-context-store.ts tests/runtime/d-ai-runtime.test.ts
git commit -m "feat: persist runtime debug sessions"
```

### Task 3: Verify restart and handoff compatibility

**Files:**
- Modify: `tests/integration/v1-contract.test.ts`
- Modify: `tests/handoff/handoff-service.test.ts`

**Interfaces:**
- Consumes: the durable `debugSession` field from Tasks 1 and 2.
- Produces: evidence that a persisted debug session survives a fresh runtime and remains redacted during environment handoff.

- [ ] **Step 1: Add one end-to-end restart assertion**

Extend the existing failure/recovery integration fixture to load the blocked task with a new runtime instance and assert the debug session identity and phase remain unchanged before recovery continues.

- [ ] **Step 2: Add one handoff redaction assertion**

Use a debug session containing a secret-shaped failure string and assert envelope creation rejects or redacts it according to the existing handoff security contract; do not assert static prompt text.

- [ ] **Step 3: Run the focused integration tests**

Run: `npx vitest run tests/integration/v1-contract.test.ts tests/handoff/handoff-service.test.ts`

Expected: PASS with all existing close, recovery, and handoff assertions preserved.

- [ ] **Step 4: Run the complete verification suite**

Run: `npx vitest run; npm run build; git --no-pager diff --check`

Expected: all tests pass, TypeScript exits 0, and diff check reports no errors.

- [ ] **Step 5: Review the diff and report the checkpoint**

Run: `git status --short --branch; git log -3 --oneline; git --no-pager diff --stat`

Report the exact commits, test count, build result, and any remaining rollback integration gap. Do not push or merge without explicit approval.
