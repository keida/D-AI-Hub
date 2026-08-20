# Bugs

## Open

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
