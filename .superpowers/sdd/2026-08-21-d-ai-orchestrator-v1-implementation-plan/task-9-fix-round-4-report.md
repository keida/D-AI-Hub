# Task 9 Fix Round 4 Report

## Status

Implemented against base commit `4d555e361a7c11243b23825000074c2d8bed527b`. The fresh-runtime continuation ownership gap is fixed in the scoped runtime and runtime test.

## Files

- `src/runtime/d-ai-runtime.ts`
- `tests/runtime/d-ai-runtime.test.ts`
- this report

No adapter, source mirror, `AGENTS.md`, approved spec/plan, package file, or Task 10 file was changed. The two approved untracked documents under `docs/superpowers/` were preserved and excluded.

## Root cause and fix

`continueTaskExclusive` previously compared the request source with durable ownership only when the process-local registry already had an owner. A fresh runtime has an empty registry, so Codex could continue a task whose persisted active handoff state named Work as the owner.

Continuation now first requires `request.sourceEnvironment` to equal the persisted `state.environment`, independently of the local registry. It then separately rejects any process-local owner that disagrees with the durable environment before installing the durable owner locally.

## Regression and TDD evidence

- The regression seeds an active durable handoff owned by Work, creates a fresh runtime sharing the same store, and checks both paths: Codex continuation is blocked and Work continuation is accepted.
- Red run: the focused regression failed because Codex returned `accepted` instead of `blocked`.
- Green run: the focused regression passed after the two ownership checks were separated.
- Focused entry/runtime tests: 2 files and 60/60 tests passed.
- Full suite: 18 files and 269/269 tests passed.
- TypeScript build: passed with exit code 0.

## Scope

The production change is limited to the continuation ownership guard. Existing handoff fencing, durable pending/active persistence, recovery-point validation, adapters, approved documents, and Task 10 remain unchanged.
