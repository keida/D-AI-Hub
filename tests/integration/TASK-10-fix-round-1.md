# Task 10 fix-round-1 report

## Scope

Only the Task 10 contract test and its two disposable fixtures were inspected for the acceptance change. Production code, adapters, dependencies, approved documents, `AGENTS.md`, and `sources/` were not changed.

## Changes

- The lifecycle now uses the public `createDAIRuntime(dependencies)` factory for intent, continue, status, handoff, and close requests. The zero-configuration `handleDAIRequest` entry remains covered by a fail-closed status assertion.
- The runtime receives a file-backed `FileDurableContextStore`, persistent handoff storage, real command execution, real Skill discovery/loading, and a local bare GitHub transport.
- Every response snapshot retains the same task ID. The handoff assertion verifies one active Work owner after acknowledgement.
- Gate evidence is generated from distinct command/store operations. Missing and failed quality evidence are negative cases.
- Selected Skill bodies and `references/contract.md` resources are asserted as loaded; the unrelated Skill name/path is asserted absent from loaded runtime context.

## Contract blocker retained truthfully

`handleDAIRequest(request)` has no dependency/configuration argument and closes over the module-level default runtime. The public injectable boundary is `createDAIRuntime(dependencies)`, so the configured acceptance lane uses that public factory. Adding production injection was outside the requested file scope.

The public handoff command persists the task at `stage: "handoff"` and `handoffState: "active"`. The public command set has no handoff-completion or transition-back-to-`verify` operation, while close requires `stage: "verify"` and `handoffState: "completed"`. The test therefore records the close request as `BLOCKED` using the same task ID and the same file-backed durable store; it does not fabricate a close state or detached snapshot store.

The external GitHub adapter also has no credential-presence configuration check before transport use. The configured external lane is explicitly skipped when opt-in is absent; no injected always-throw adapter is used in this round.

## Verification evidence

Verified at HEAD `3a0a443` before commit:

- `npm test`: 19 files, 274 tests passed.
- `npm run test:integration`: 2 files, 11 tests passed.
- `npm run build`: passed with `tsc --noEmit`.
- `git diff --check`: passed.
