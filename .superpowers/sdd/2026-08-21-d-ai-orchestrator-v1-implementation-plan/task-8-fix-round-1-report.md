# Task 8 Fix Round 1 Report

## Scope

Fixed all Task 8 review findings against base commit `4353fff` without changing Task 1–7 contracts, adding dependencies, adding a runtime/parser, storing credentials, introducing another orchestrator, or adding destructive close behavior.

Changed only:

- `src/adapters/git.ts`
- `src/adapters/github.ts`
- `src/close/close-service.ts`
- `tests/adapters/github.test.ts`
- `tests/close/close-service.test.ts`
- `tests/integration/github-close.test.ts`
- this report

The two pre-existing untracked documents under `docs/superpowers/` were preserved and excluded.

## Fixes

### Effective push transport

- Local Git inspection now resolves exactly one effective push endpoint through `git remote get-url --push --all`.
- Both the configured remote URL and effective push endpoint must resolve to the same allowed GitHub or explicitly configured Enterprise repository identity.
- Non-GitHub transports, conflicting `pushurl`, URL rewrites to local/non-GitHub endpoints, multiple effective push endpoints, and unsupported HTTPS/SSH ports are blocked before push.
- Production push and `ls-remote` use the same recorded, validated endpoint for the exact repository/ref pair.
- The local bare-remote integration uses an explicit test transport; production GitHub identity validation never accepts `file://`.

### Adapter evidence and commit artifacts

- `closeTask` runtime-validates push and remote evidence fields, state consistency, object IDs, and exact configured remote/ref correspondence.
- Push evidence must identify the configured remote/ref; remote state must identify the same validated repository/ref.
- Exactly one `artifact:commit:<sha>` entry is required before the adapter runs.
- Git object IDs are accepted only at exactly 40 or 64 hexadecimal characters; malformed, duplicate, and conflicting commit artifacts are rejected.
- A valid pushed SHA that differs from the single configured commit artifact returns `NO`; malformed or contradictory adapter evidence returns `BLOCKED`.

### Durable/recovery correspondence

- Durable manifest and recovery point now require identical non-empty durable path sets and identical path-to-hash mappings.
- Duplicate paths, missing/extra hash keys, path differences, and hash differences fail close.

### Failure classification

- Git push failures carry a typed category: authentication, permission, network, remote unavailable, ambiguous, verification mismatch, or dirty worktree.
- Authentication, permission, network, unavailable remote, and ambiguous failures return `BLOCKED`.
- Dirty worktree and known verification mismatch remain `NO`.
- Remote SHA mismatch remains `NO`; malformed or ambiguous remote output is `BLOCKED`.

### External integration lane

- The external lane requires explicit opt-in, an explicit credentials-configured marker, repository path, remote, and ref.
- When configuration or credentials are absent, the test exercises the adapter/`closeTask` path and verifies `BLOCKED`; it no longer constructs a synthetic skipped status.
- When all opt-in configuration is present, the same lane runs the production adapter and requires `YES`.
- No external credentials were added or logged.

## Test coverage added

- Conflicting `pushurl` cannot divert a push and leaves the bare remote unchanged.
- URL rewrite cannot divert a push and leaves the bare remote unchanged.
- Unsupported HTTPS and SSH ports are rejected.
- Typed Git failure classification covers authentication, permission, network, unavailable remote, verification mismatch, and ambiguous output.
- Push/remote adapter evidence mismatches and malformed object IDs return `BLOCKED`.
- Duplicate, conflicting, and malformed commit artifacts fail before adapter invocation.
- Both 40-character and 64-character commit artifacts are covered.
- Durable/recovery path-set and hash-set mismatches return `NO`.
- Authentication, permission, network, unavailable remote, and ambiguous push failures return `BLOCKED`.
- Pending approval and dirty worktree return `NO`.
- Missing external credentials/configuration returns `BLOCKED` through the close path.
- The real temporary local repository plus bare-remote push and exact remote SHA verification remains behavioral.

## Verification

Run from `C:\Users\User\Documents\ChatGPT\D-AI-Hub\.worktrees\d-ai-orchestrator-v1` on 2026-08-21:

| Check | Result |
| --- | --- |
| `npm test -- tests/adapters/github.test.ts tests/close/close-service.test.ts` | Passed: 2 files, 36 tests |
| `npm run test:integration` | Passed: 1 file, 5 tests |
| `npm test` | Passed: 16 files, 207 tests |
| `npm run build` | Passed |
| `git diff --check` | Passed; line-ending notices only |

## Remaining concern

The live external GitHub lane was not opted in because no explicit external credentials/configuration was supplied. Its required no-configuration behavior was executed through the adapter/close path and returned `BLOCKED`. The local temporary bare-remote behavioral integration passed.
