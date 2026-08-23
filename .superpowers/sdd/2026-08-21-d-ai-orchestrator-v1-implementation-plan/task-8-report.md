# Task 8 Report — GitHub verification and close verdict

## Scope delivered

Implemented the Task 8 close-verification slice without adding a runtime, parser, dependency, competing orchestrator, destructive operation, or external credential.

- `src/adapters/git.ts` captures repository root, branch, full HEAD SHA, porcelain worktree state, configured remote name, configured remote URL, and target ref through the existing typed command runner. Push results retain sanitized output and an explicit exit code.
- `src/adapters/github.ts` accepts only `github.com` or an explicitly configured Enterprise host, rejects credential-bearing HTTPS URLs, pushes the inspected full SHA, and independently resolves the exact remote ref with `git ls-remote`.
- `src/close/close-service.ts` evaluates persisted-state correspondence, explicit close stage, completed handoff, resolved approval, durable artifacts, critical unsaved context, the applicable Task 7 gates, recovery-point/evidence correspondence, the clean-worktree policy, successful push evidence, durable commit-artifact correspondence, and exact remote SHA identity.
- Verdicts are fail-closed: unmet local conditions return `NO`; unavailable/ambiguous durable or remote state returns `BLOCKED`; only the complete evidence path returns `YES`. Every negative or blocked reason contains a next check. The close path does not delete, remove, reset, or clean up files.

## Evidence contract

Task 8 associates existing `VerificationEvidence` with the applicable Task 7 hard gates through `evidenceId` values of the form `gate:<gate-name>`. The durable context manifest must record exactly one repository identity, remote, ref, `local-state:clean-required` policy, and `artifact:commit:<full-sha>` entry before close can return `YES`.

## Tests added

- `tests/adapters/github.test.ts`: GitHub and Enterprise remote parsing, non-GitHub host blocking, and credential-bearing URL rejection.
- `tests/close/close-service.test.ts`: successful close plus missing durable context, unsaved context, failed push, SHA mismatch, missing artifact, stale gate, pending handoff, dirty worktree, and unavailable remote.
- `tests/integration/github-close.test.ts`: creates a temporary repository and bare remote, pushes through `GitHubCliAdapter`, and independently validates the pushed ref SHA. The test uses a repository-local Git URL rewrite solely to keep the verified transport local while retaining GitHub remote identity validation.

## Verification performed

All commands were run in `C:\Users\User\Documents\ChatGPT\D-AI-Hub\.worktrees\d-ai-orchestrator-v1`.

| Check | Result |
| --- | --- |
| `npm test -- tests/close/close-service.test.ts tests/adapters/github.test.ts` | Pass: 14 tests |
| `npm run test:integration` | Pass: 2 tests |
| `npm test` | Pass: 16 files, 182 tests |
| `npm run build` | Pass |
| `git diff --check` | Pass |

## External GitHub lane

No external GitHub credentials or opt-in integration configuration was supplied. The external lane is explicitly `BLOCKED`; it was not treated as a success and no credential was fabricated. The local temporary bare-remote integration passed independently.

## Review boundary

The two pre-existing untracked documents under `docs/superpowers/` were preserved and excluded from this task's changes and commit.
