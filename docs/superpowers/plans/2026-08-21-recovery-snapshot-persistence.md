# Recovery Snapshot Persistence Plan

## Goal

Persist the complete, validated recovery snapshot required by `safeRollback()` so a fresh runtime can perform an explicit rollback without relying on the previous process or chat memory.

## Design

- Define the serializable `RecoverySnapshot` contract in the domain layer and add an optional nullable `recoverySnapshot` field to `TaskState`.
- Persist the recovery point and its snapshot together in the existing recovery durable record, protected by the existing strict schema validation, secret-like value rejection, generation hashing, active-pointer publication, and ownership fencing.
- Change runtime recovery capture to retain `CapturedRecoveryPoint.snapshot` alongside `RecoveryPoint` after validating that snapshot identity, manifest, Git HEAD/branch/workspace, binary patch, and verification evidence correspond to the current task.
- Reconstruct `CapturedRecoveryPoint` at the rollback boundary from the durable `RecoveryPoint` and `RecoverySnapshot`; refuse rollback when the pair is incomplete or mismatched.
- Keep handoff portable state redacted and minimal. A handoff may carry the recovery point metadata, but rollback execution must require the locally verified durable snapshot rather than trusting a portable envelope copy.
- Preserve compatibility for older durable states by treating a missing snapshot as rollback-unavailable and returning a clear `BLOCKED` result; do not silently infer or recreate a snapshot.

## Implementation sequence

1. Add typed domain/schema contracts and round-trip tests.
2. Retain and validate captured snapshots in execution and handoff-completion paths.
3. Add runtime reconstruction and fail-closed mismatch tests.
4. Add the real Git adapter only after the durable contract is verified across a fresh runtime.
5. Run the full suite, build, and diff-integrity checks; stop before commit or push.

## Safety gates

- No rollback is allowed without both a recovery point and a durable snapshot.
- Snapshot identity and manifest hashes must match the current task state.
- Secret-like values remain rejected before persistence and redacted at handoff boundaries.
- Existing close, continue, handoff, ownership, heartbeat, and generation-fencing behavior must remain unchanged.
- No `git reset`, `git clean`, force-push, deletion, or automatic recovery fallback is introduced.
