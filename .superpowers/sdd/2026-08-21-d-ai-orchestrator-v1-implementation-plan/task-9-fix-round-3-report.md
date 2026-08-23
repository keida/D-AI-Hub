# Task 9 Fix Round 3 Report

## Status

Implemented against base commit `9fbfb714e27315be12b3413b21a23a2c4e3c08a3`. The two Critical Task 9 review findings are fixed in the scoped runtime and runtime tests.

## Files

- `src/runtime/d-ai-runtime.ts`
- `tests/runtime/d-ai-runtime.test.ts`
- this report

The two approved untracked spec/plan documents under `docs/superpowers/` were preserved and excluded. No adapter, Task 1-8 source, package file, approved spec/plan, `AGENTS.md`, `sources/`, or Task 10 file was changed.

## Implemented fixes

1. The runtime registry now has one per-task mutation fence used by execute and its recovery path, continue, handoff, and close. Continue resolves aliases to the stable persisted task ID before entering the fence. Handoff and close recheck authoritative ownership inside the fence before loading or mutating state.
2. Handoff removes the executable runtime owner before persistence, atomically persists `stage: handoff` with `handoffState: pending`, and only then calls `handoffService.create` or target acknowledgement. It keeps both runtime lanes blocked until acknowledged active state is durably saved, then installs only the target owner. Failure compensation remains `rejected`; no handoff path writes `handoffState: none`.
3. A separate runtime sharing the durable store is blocked from continuing the task when the first handoff connector call begins because it observes the already-durable pending state.
4. RecoveryPoint validation retains strict schema allowlists for stage, environment, role, timestamp, and SHA-256 hash values. Every remaining textual field is checked before persistence for labelled secrets and high-confidence unlabelled OpenAI `sk-proj-`/`sk-`, GitHub legacy and fine-grained token signatures, and PEM private-key headers.
5. Secret-bearing RecoveryPoints enter the existing blocked recovery path without saving any RecoveryPoint or echoing the credential in the response.

## Regression and TDD evidence

- Baseline before changes: full `npm test` passed 18 files and 257 tests.
- Red run: the expanded runtime suite produced 6 expected failures. Connector creation observed `verify/none`; delayed handoff load raced close into an invalid `close -> handoff` overwrite; and OpenAI/GitHub signatures bypassed secret detection or failed only at later identity/artifact checks.
- Green run: focused `npm test -- tests/entry tests/runtime` passed 2 files and 59 tests.
- Deterministic delayed-store coverage holds a handoff load while concurrent close and continue requests are issued. Both are fenced, neither closes or resumes the old executable state, and the final durable owner is only Work with active handoff state.
- Connector-order coverage observes durable `handoff/pending` before envelope creation and verifies an independent runtime cannot continue that task.
- Independent RecoveryPoint cases cover each unrestricted text surface and each required credential signature. Schema-constrained text surfaces remain fail-closed through their existing enum, datetime, and hash allowlists.

## Verification

- Focused entry/runtime tests: 59/59 passed.
- Full suite: 18 files and 268/268 tests passed on the final source/test tree.
- TypeScript build: passed with exit code 0.
- Final diff, scope, and staged-file checks are run immediately before commit; their exact results are recorded in the commit handoff.

## Known concerns

- The mutation queue is intentionally local to one runtime instance because the existing `DurableContextStore` contract has no distributed lock operation. Cross-runtime fail-closed behavior begins with the atomic durable pending save, which now precedes all handoff connector I/O and is covered by a separate-runtime regression. An external mutation already running in another process before the handoff request cannot be preempted by this Task 9 interface.
- Credential-format screening is defense in depth around a strict RecoveryPoint schema, not a general-purpose secret scanner. The added signatures are limited to the high-confidence formats required by this review to avoid rejecting ordinary recovery paths and instructions.
