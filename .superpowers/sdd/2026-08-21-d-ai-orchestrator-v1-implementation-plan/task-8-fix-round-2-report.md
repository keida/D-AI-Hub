# Task 8 Fix Round 2 Report

## Scope

Fixed exactly the two Task 8 re-review findings against base commit `84d6fc1` while preserving all prior Task 8 fixes.

Changed only:

- `src/adapters/git.ts`
- `src/adapters/github.ts`
- `src/close/close-service.ts`
- `tests/close/close-service.test.ts`
- `tests/integration/github-close.test.ts`
- this report

No credentials, dependencies, competing orchestrator, deletion behavior, or Task 9 runtime were added. The test-only Git transport injection remains available. The two pre-existing untracked documents under `docs/superpowers/` were preserved and excluded.

## Finding 1: Chained Git URL rewrites

### Root cause

The adapter validated the single endpoint returned by `git remote get-url --push --all`, then passed that endpoint back to `git push` and `git ls-remote`. Git could apply another `url.*.insteadOf` or `url.*.pushInsteadOf` rule to the already validated endpoint, diverting both operations after validation.

### Fix

- Read the single raw configured remote URL and optional raw push URL instead of accepting a partially rewritten endpoint from Git.
- Read all visible included Git URL rewrite rules, including applicable local and global `insteadOf` and `pushInsteadOf` entries.
- Resolve rewrites to a fixed point using longest-prefix matching.
- Reject malformed rules, different endpoints from equally long applicable rules, cycles, and rewrite chains that do not converge within the finite rule set.
- Validate the final fixed endpoint with the existing explicit GitHub or configured Enterprise host, protocol, repository, and port policy before push.
- Resolve and validate the recorded endpoint again immediately before remote-state verification.
- Continue to pass the final validated endpoint through the existing transport interface, preserving test-only transport injection.

### Regression behavior

The new integration test uses a temporary global `pushInsteadOf` rule followed by a repository-local `insteadOf` rule:

1. GitHub HTTPS endpoint to an equivalent GitHub SSH endpoint.
2. The SSH endpoint to a temporary local bare repository.

Before the fix, the test observed `YES` because Git applied the second rewrite during push and verification. After the fix, close returns `BLOCKED`, and the bare repository still has no target ref.

## Finding 2: Contradictory remote evidence

### Root cause

Remote evidence validation checked only one contradiction direction: a true match flag with a different SHA. It accepted a false match flag when `remoteSha` exactly equaled the expected pushed SHA, then classified the result as `NO` rather than blocking ambiguous adapter evidence.

### Fix

The adapter flag must now exactly equal the independently computed comparison in both directions:

`matchesExpectedSha === (remoteSha === pushedSha)`

Any disagreement is invalid adapter evidence and produces `BLOCKED`. A genuine unequal SHA with a false flag remains a verified mismatch and produces `NO`.

### Regression behavior

The new close-service test supplies the exact pushed SHA with `matchesExpectedSha: false`. It failed before the fix with `NO` and passes after the fix with `BLOCKED`.

## Verification

Run from `C:\Users\User\Documents\ChatGPT\D-AI-Hub\.worktrees\d-ai-orchestrator-v1` on 2026-08-21:

| Check | Result |
| --- | --- |
| Chained rewrite red test before production fix | Failed as expected: received `YES` instead of `BLOCKED` |
| Contradictory evidence red test before production fix | Failed as expected: received `NO` instead of `BLOCKED` |
| `npm test -- tests/adapters/github.test.ts tests/close/close-service.test.ts` | Passed: 2 files, 37 tests |
| `npm run test:integration` | Passed: 1 file, 6 tests |
| `npm test` | Passed: 16 files, 209 tests |
| `npm run build` | Passed |
| `git diff --check` | Passed; Windows line-ending notices only |

## Remaining concern

The live external GitHub lane was not opted in because no explicit external credentials/configuration was supplied. Its required no-configuration path ran and returned `BLOCKED`. All local temporary-repository behaviors, including exact SHA verification and unchanged bare-remote evidence for the chained rewrite case, passed.
