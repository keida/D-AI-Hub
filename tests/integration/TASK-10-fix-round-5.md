# Task 10/V1 fix-round-5 report

## Scope

This is the current Task 10/V1 report. The approved spec/plan, `AGENTS.md`, `sources/`, and dependency set were preserved.

## Fixes verified by tests

- `FileDurableContextStore` atomically retains a manifest-addressed generation containing all seven declared artifacts. Load and close verification use the generation and reject generation corruption; recovery snapshots deep-clone their state manifest.
- Manifest IDs are strict UUID/`manifest-<uuid>` values. Runtime, recovery, envelope, and file-store validation reject unsafe IDs; the real file store rejects `ghp_`, `sk_`, and PEM-shaped values before writing.
- Retry resets the active verification evidence set and retains the previous attempt in `verificationHistory`, preventing duplicate active gate IDs.
- The public integration lifecycle fails the original marker-gated command, recovery removes the marker, public `continue` reruns that same command successfully, and a distinct regression command runs separately before handoff and close.
- The original Task 10 report and fix-round-3/4 reports are marked historical/superseded.

The production-selected Skill resources, public completion path, task-bound handoff, retryable close, real external missing-credential `BLOCKED` lane, and local bare-remote test mode remain covered by the existing suite.

## Verification evidence

Fresh verification from the actual checkout:

- Targeted recovery/store/runtime/close/Task 10 tests: 5 files, 107 tests passed.
- `npm test`: 19 files, 298 tests passed.
- `npm run test:integration`: 2 files, 12 tests passed.
- `npm run build`: passed with `tsc --noEmit`.
- `git diff --check`: passed.
- Real external GitHub missing-credential behavior returned `BLOCKED`; the positive remote lane used only the local bare-remote test transport.
