# Task 10/V1 fix-round-5 report (corrected during fix-round-6)

## Scope

This is the corrected historical Task 10/V1 report. Fix-round-6 is the current implementation. The approved spec/plan, `AGENTS.md`, `sources/`, and dependency set were preserved.

## Fixes verified by tests

- `FileDurableContextStore` atomically retains a manifest-addressed generation containing all seven declared artifacts. Load and close verification use the generation and reject generation corruption; recovery snapshots deep-clone their state manifest.
- Manifest IDs are strict UUID/`manifest-<uuid>` values. Runtime, recovery, envelope, and file-store validation reject unsafe IDs; the real file store rejects `github_pat_`, `ghp_`, `sk-`, and PEM-shaped values before writing.
- Retry resets the active verification evidence set and retains the previous attempt in `verificationHistory`, preventing duplicate active gate IDs.
- The public integration lifecycle fails the original marker-gated command, recovery removes the marker, public `continue` reruns that same command successfully, and a distinct regression command runs separately before handoff and close.
- The original Task 10 report and fix-round-3/4 reports are historical/superseded.

The production-selected Skill resources, public completion path, task-bound handoff, retryable close, and local bare-remote test mode remain covered by the existing suite. The positive remote proof is local-only; the external GitHub lane cannot be positively verified without configured credentials and is expected to return `BLOCKED`.

## Verification evidence

Fresh verification from the actual checkout:

- Targeted recovery/store/runtime/close/handoff/Skill tests: 6 files, 159 tests passed.
- `npm test`: 19 files, 306 tests passed.
- `npm run test:integration`: 2 files, 12 tests passed.
- `npm run build`: passed with `tsc --noEmit`.
- `git diff --check`: passed.
- The external GitHub missing-credential lane returned `BLOCKED`; no external credentialed push or remote verification is claimed. Positive remote evidence used the local bare-remote test transport only.
