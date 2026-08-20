# Bugs

## Open

### BUG-001 — Local Git CLI authentication may be unavailable on a machine

- Severity: medium
- Status: environment-dependent
- First observed: 2026-08-20
- Reproduction: From an affected local checkout, run `git fetch --prune origin` or `git pull --ff-only origin main`.
- Expected: Git authenticates to `https://github.com/keida/D-AI-Hub.git` and updates `main`.
- Actual: On the originally affected machine, GitHub rejected the local HTTPS credentials.
- Impact: Normal local fetch/pull and authoritative history reconciliation cannot be verified on that machine until authentication is configured.
- Workaround: Use an authenticated GitHub integration for repository reads and clearly record that local Git sync is unverified.
- Evidence: The setup session reproduced an HTTPS authentication failure. Machine-specific blob counts, tree hashes, and transient snapshot identifiers are intentionally not preserved here as durable project state.
- Resolution condition: Configure a valid GitHub credential helper or GitHub CLI authentication on the affected machine, then complete a successful `git fetch --prune origin` and verify local `main` against `origin/main`.

## Resolved

_None yet._
