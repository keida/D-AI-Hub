# Task 9 Fix Round 1 Report

## Status

Complete against base commit `d97033f`. The Task 9 runtime flaws reported in review are fixed in the Task 9 runtime and behavior tests.

## Files

- `src/runtime/d-ai-runtime.ts`
- `tests/runtime/d-ai-runtime.test.ts`
- this report

The pre-existing untracked documents under `docs/superpowers/` were preserved and excluded. No Task 1-8 source, adapter, package, approved plan/spec, `AGENTS.md`, or `sources/` file was changed in this fix round.

## Implemented fixes

1. Gate evidence is selected only by the exact `gate:<gate>` evidence ID. Every applicable execution gate must have exactly one record; missing or duplicate records fail before an injected evaluator can report success.
2. The runtime uses `assertStageTransition` and persists `bootstrap -> route -> plan -> execute -> inspect -> verify`. Verification evidence is bound to an injected, identity-checked recovery point and the final durable verify manifest before the real Task 7 evaluator runs.
3. Close is accepted only from `verify`, transitions and persists `close`, and passes that close-stage state to Task 8 `closeTask`.
4. A single owner map is updated through one synchronous transfer function. Initial routing leaves only the routed environment as owner, continuation restores only the persisted owner, and handoff transfers ownership only after acknowledgement and durable persistence.
5. Handoff no longer resets `handoffState` to `none`. A second handoff from an active handoff is returned as blocked.
6. Typed execution, handoff, recovery-point, and close connector errors are converted to blocked responses at their own boundaries. Untyped programming errors continue to reject rather than being hidden.
7. External execution evidence and connector messages are redacted with `redactSensitiveText` before persistence, recovery routing text, and response construction.
8. `ExternalDAIRequest` now uses explicit request and override interfaces. Task 9 boundary code no longer declares `object`, `unknown`, or `any` request/error types.

## Behavior evidence

- Initial reviewer regressions: focused runtime baseline produced 8 expected failures covering missing gate identity, skipped stages, duplicate ownership, handoff identity, close stage, and rejected close errors.
- Expanded red run: 14 expected runtime failures confirmed lifecycle, real-gate, real-close, and redaction defects before the production fix.
- Independent evaluator-bypass regression: failed with `completed` instead of `blocked` before the exact-evidence precheck was added.
- Final runtime tests use the real `evaluateHardGates` for successful lifecycle paths and a real `closeTask` preflight test. Stub verdicts remain only where all three close verdict mappings must be exercised without remote mutation.
- Existing close sentinel coverage remains and confirms the runtime never deletes the Skill fixture.

## Verification

- Focused: `npm test -- tests/entry tests/runtime` — 2 files, 39 tests passed, exit code 0.
- Full: `npm test` — 18 files, 248 tests passed, exit code 0.
- Build: `npm run build` — TypeScript completed with exit code 0.
- Diff: `git diff --check` — exit code 0 with no whitespace errors.

## Concerns

- The default V1 runtime still has no concrete execution or recovery-point connector. Both defaults fail closed with typed blocked outcomes; real connectors remain dependency-injected as required.
- The real close test intentionally reaches Task 8 preflight and returns `NO` because the Task 9 fixture does not fabricate completed handoff, remote, and commit artifacts. A `YES` verdict remains reserved for Task 8's fully evidenced close contract.
- Only recognized typed connector failures become blocked. Unexpected error classes remain visible as rejected programming failures, consistent with the repository's fail-explicitly rule.
