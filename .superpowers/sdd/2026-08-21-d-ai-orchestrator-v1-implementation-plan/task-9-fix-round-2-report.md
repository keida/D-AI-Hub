# Task 9 Fix Round 2 Report

## Status

Complete against base commit `1b134c8f94da5b9d417269f33d228bccff2d5492`. The four scoped Task 9 fix-round-2 findings are implemented and verified.

## Files

- `src/runtime/d-ai-runtime.ts`
- `tests/runtime/d-ai-runtime.test.ts`
- this report

The two pre-existing untracked documents under `docs/superpowers/` were preserved and excluded. No Task 1-8 source, adapter, package, approved plan/spec, `AGENTS.md`, `sources/`, or unrelated user file was changed.

## Implemented fixes

1. Handoff commands are serialized per task. The runtime removes the source from its single owner map before handoff I/O, persists `pending` before target acknowledgement, persists `active` after acknowledgement, and replaces the owner map atomically only after durable success.
2. Recognized handoff failures reject the service handoff, persist a terminal `rejected` task state when possible, retain the runtime block, redact connector text, and leave neither source nor target as an executable runtime lane. The runtime never writes `handoffState: "none"` during handoff handling.
3. Applicable execution gates are derived from state. Once a recovery point exists, exact `gate:recovery` evidence and exactly one passing recovery result are required alongside the prior seven gates.
4. Injected recovery points are strict-schema validated before persistence. Malformed or future timestamps, identity/artifact mismatches, duplicate or extra hash keys, invalid hashes, and secret-like text in IDs, paths, hash keys/values, restoration instructions, timestamps, and other textual fields fail closed before the recovery point is saved.
5. Recognized recovery connector failures, including `InvalidTaskStateError`, `CloseBlockedError`, command execution failures, handoff/capability failures, verification failures, and unsaved-context failures, become redacted blocked responses. The already-persisted debug state remains the durable latest state; unexpected programming errors still reject explicitly.

## Regression coverage

- Delayed handoff persistence proves `pending` is the first durable handoff state, acknowledgement waits for it, a concurrent handoff is blocked, and source status is blocked.
- Failing active-state persistence proves an acknowledged service handoff is rejected, durable task state becomes `rejected`, secrets are redacted, and both runtime lanes remain blocked.
- A failed recovery gate is no longer ignored after recovery capture.
- Malformed and future recovery-point timestamps block before persistence.
- Recovery throws from three recognized error categories return blocked at the durable debug state with redacted messages.
- A recovery point carrying secret-like restoration instructions, ID text, durable paths, and hash keys is rejected before any recovery point is persisted.
- Prior exact gate evidence, lifecycle, real close, close verdict, single-owner, execution redaction, and malformed request regressions remain green.

## TDD evidence

- The expanded runtime test first produced 9 expected failures: first handoff persistence was `active`, active-store failure escaped, the recovery gate and malformed/future points completed, recognized recovery errors rejected, and a secret-bearing recovery point reached persistence before a later evidence mismatch blocked it.
- After the runtime-only implementation, the runtime test passed 29/29.

## Verification

- Focused: `npm test -- tests/entry tests/runtime` — 2 files, 48 tests passed, exit code 0.
- Full: `npm test` — 18 files, 257 tests passed, exit code 0.
- Build: `npm run build` — TypeScript completed with exit code 0.
- Diff: `git diff --check` — exit code 0 with no whitespace errors; Git emitted only the existing Windows LF-to-CRLF working-copy warning.

## Concerns

- Runtime command serialization and the active owner map are intentionally process-local; the existing persistent handoff service remains the cross-process lifecycle authority.
- If an unrecognized programming error occurs, the request still rejects explicitly after failure compensation is attempted, while the process-local task registry remains blocked. This preserves the repository rule against hiding unknown failures.
- The default V1 execution and recovery-point connectors remain fail-closed and dependency-injected, unchanged from the prior Task 9 boundary.
