# Historical/superseded Task 10/V1 fix-round-3 report

> Historical record only. Superseded by `tests/integration/TASK-10-fix-round-5.md`.

## Scope

This report supersedes the stale fix-round-2 title/content and records the current Task 10/V1 fix-round-3 truth. Approved documents, dependencies, `AGENTS.md`, and `sources/` were not changed.

## Changes

- `HandoffStatus` now exposes immutable `taskId` and `target`; completion compares both to the active durable task before mutation. Wrong-ID coverage proves both task state and handoff records remain unchanged.
- Completion calls the service before persisting verify/completed state, preserves retryable handoff/active state on service failure, and reconciles a service-completed handoff after a task-save failure.
- Recovery points use explicitly documented immutable snapshot semantics for stable companion artifacts; close no longer exempts `state.json`, `manifest.json`, or `recovery.json`, and mismatch regressions cover each name.
- Close evaluates from retryable `verify`, persists `close` only after a `YES`, and a `NO`/`BLOCKED` attempt can be retried successfully with the same runtime/store.
- The positive integration lifecycle uses one configured runtime and one file-backed store for Chat intent, Codex continue/status, Codex-to-Work handoff, Work completion, verify, and Work close. It reloads a fresh `FileHandoffPersistence`, asserts envelope/task/target/owner/state/ID identity, exact selected Skill resource paths/content, and absence of unrelated Skill context.
- The local bare remote remains the positive Git evidence lane.
- `GitHubCliAdapter.create` is an explicit external policy boundary requiring a credential-presence boolean; missing credentials block before Git transport. Bare-remote tests use the explicit `mode: "test"` transport policy. The missing-credentials lane exercises the real adapter.

## Remaining limitation

No external GitHub credentials/configuration were present locally, so no external GitHub success is claimed. The real adapter's missing-credentials `BLOCKED` behavior is covered; no always-throw fake adapter is used.

## Verification evidence

Fresh verification before commit:

- Targeted handoff/runtime/close/recovery/integration tests: 4 files, 86 tests passed.
- `npm test`: 19 files, 287 tests passed.
- `npm run test:integration`: 2 files, 11 tests passed.
- `npm run build`: passed with `tsc --noEmit`.
- `git diff --check`: passed.
