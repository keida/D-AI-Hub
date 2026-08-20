# Historical/superseded Task 10 report: V1 integration contract suite

> Historical baseline only. This report is superseded by `tests/integration/TASK-10-fix-round-4.md`; its original claim that the public intent lifecycle completed in one executor and that recovery self-artifacts were already fully correspondent is stale.

## Scope

Implemented the Task 10 contract suite against public `handleDAIRequest()` and the existing production contracts. Changes are limited to:

- `tests/integration/v1-contract.test.ts`
- `tests/integration/fixtures/known-good-repo.ts`
- `tests/integration/fixtures/skill-library.ts`
- this report

No production source, dependency, adapter, or unrelated documentation changes were made.

## Contract coverage

- Fail-closed public `handleDAIRequest()` status with no active task.
- Disposable real filesystem repository under the OS temp directory, with `.d-ai/`, known branch, valid selected Skills, an unrelated Skill, and deterministic failing/passing Node commands.
- Chat → Work → Codex → Work lifecycle with one stable task ID, persistent handoff records, and one active owner per handoff.
- Real file-backed durable context persistence and reload through `FileDurableContextStore` and `FileHandoffPersistence`.
- Failure reproduction, systematic debug phases, recovery point, passing verification, and regression verification.
- Negative close prerequisites for missing durable context, unsaved context, failed hard gate, failed push, and mismatched remote SHA.
- Positive close only after durable state, all applicable gates, successful push evidence, exact local bare-remote SHA verification, and empty critical unsaved context.
- External GitHub lane remains opt-in and reports `BLOCKED` when credentials/configuration are absent.

## Existing contract boundary

`FileHandoffPersistence` uses integrity-checked committed snapshots below its lock directory; it does not guarantee that the nominal `handoffs.json` path is a standalone readable JSON file. The integration assertion therefore reloads records through the real persistence adapter and verifies the task ID, which is the strongest valid contract without changing production behavior.

## Verification evidence

Executed from the actual checkout at `C:\Users\User\Documents\ChatGPT\D-AI-Hub\.worktrees\d-ai-orchestrator-v1`, based on `e0969ad`:

| Check | Result |
|---|---|
| Focused integration test | 1 file, 4 tests passed |
| `npm run build` | passed, exit 0 |
| `npm test` | 19 files, 273 tests passed |
| `npm run test:integration` | 2 files, 10 tests passed |
| `git diff --check` | passed |

The external GitHub lane was not counted as remote verification; its missing-credentials path is explicitly asserted as `BLOCKED`.
