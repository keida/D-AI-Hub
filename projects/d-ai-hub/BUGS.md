# Bugs

## Open

### BUG-002 — `@D-AI sync` behavior is not distinguished from ordinary local project continuation

- Severity: medium
- Status: open
- First observed: 2026-08-22
- Reproduction: In an existing Codex checkout, compare starting the same project with `@D-AI sync` and with an ordinary instruction such as `Continue D-AI-Hub`.
- Expected: Ordinary continuation performs a Fast Read of local project context without claiming remote freshness. Explicit sync produces separate GitHub freshness evidence or a precise unsynced limitation.
- Actual: User-observed behavior and the supplied screenshot show both paths primarily loading local context. The Codex-side matrix now confirms that Fast Read is local-only and explicit sync performs separate remote freshness checks. Web initially lacked the repository workspace and could not find `projects/d-ai-hub/STATUS.md`; after the `keida/D-AI-Hub` GitHub connector was provided, Web successfully read `STATUS.md`, `BUGS.md`, and confirmed commit `8aab39d`. The connector is therefore a required dependency for Web ↔ Codex context handoff, not evidence that the canonical project files were lost.
- Impact: Users may spend extra time on repeated safety checks or incorrectly believe local context loading proves canonical GitHub synchronization.
- Workaround: Treat local file reads as local evidence. Require current fetch, ancestry, or remote-SHA evidence before describing canonical `main` as synchronized.
- Behavior matrix status:
  - [x] Fast Read on the current dirty `main`: loaded branch/status and the current checkpoint without a full audit or pull.
  - [x] Explicit sync on the current dirty `main`: refreshed remote refs, confirmed `HEAD = origin/main = remote main`, and did not pull, merge, or overwrite local changes.
  - [x] Fast Read on a clean canonical `main`: loaded branch/status/checkpoint with no network operation.
  - [x] Explicit sync on a clean canonical `main` no-op path: `fetch --prune` and `pull --ff-only` succeeded; `HEAD = origin/main = remote main = ef9a9b0`, ahead/behind `0/0`.
  - [ ] Explicit sync on a clean canonical `main` with a remote-ahead fast-forward update path (not artificially created).
  - [x] Dirty feature branch with upstream: `feat/d-ai-ownership-repair` was fetched while dirty; its upstream was present and ahead/behind was `0/0`, with all uncommitted files preserved.
  - [x] Dirty feature branch without upstream: `feat/d-ai-orchestrator-v1` was fetched while dirty; upstream resolution failed with exit `128`, the status snapshot remained identical before and after, and no pull or overwrite was attempted.
  - [x] Clean feature branch: `codex/project-memory-progressive` was fetched while clean; its upstream was present and ahead/behind was `0/0`.
  - [ ] Authentication failure: not reproduced because doing so would require changing or invalidating the authenticated remote configuration.
  - [x] Unavailable remote fail-closed probe: a direct `ls-remote` to an intentionally unreachable local endpoint failed with exit `128`; `HEAD`, `origin/main`, and the worktree were unchanged. This is not GitHub authentication evidence.
  - [x] ChatGPT Web to Codex handoff through the GitHub connector: Web read `STATUS.md` and `BUGS.md` and confirmed commit `8aab39d`; without the connector, the workspace could not locate the project.
- Resolution condition: Keep the command and safety-gate documentation aligned, then pass the remaining matrix for authentication failure and remote-ahead fast-forward path. Do not claim the bug resolved from Codex-only evidence.

### BUG-001 — Local Git CLI authentication may be unavailable in a new environment

- Severity: medium
- Status: open
- First observed: 2026-08-20
- Reproduction: From an affected local checkout, run `git fetch --prune origin` or `git pull --ff-only origin main`.
- Expected: Git authenticates to `https://github.com/keida/D-AI-Hub.git` and updates `main`.
- Actual: On the originally affected machine, GitHub rejected the local HTTPS credentials.
- Impact: Normal local fetch/pull and authoritative history reconciliation cannot be verified on that machine until authentication is configured.
- Workaround: Use an authenticated GitHub integration for repository reads and clearly record that local Git sync is unverified.
- Evidence: The setup session reproduced an HTTPS authentication failure. Machine-specific blob counts, tree hashes, and transient snapshot identifiers are intentionally not preserved here as durable project state.
- Current environment: verified resolved for this Codex checkout after authenticated `git fetch --prune origin`, `git pull --ff-only origin main`, and clean `main`/`origin/main` synchronization.
- Resolution condition: For each affected environment, configure a valid GitHub credential helper or GitHub CLI authentication, then complete a successful fetch/pull and verify local `main` against `origin/main`.

## Resolved

_None yet._
