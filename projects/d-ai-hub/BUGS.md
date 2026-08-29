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
- Current evidence: authenticated GitHub access and a successful private-repository push were verified for the controlled acceptance path; this does not prove that every checkout has local fetch/pull authentication configured.
- Resolution condition: For each affected environment, configure a valid GitHub credential helper or GitHub CLI authentication, then complete a successful fetch/pull and verify local `main` against `origin/main`.

## Resolved

### BUG-003 — Mutable memory values could bypass secret validation between reads

- Severity: high
- Status: resolved on 2026-08-29
- Resolution: `put` and the direct `applyImportedBundle` seam now capture caller-controlled values once through a detached plain-data descriptor snapshot. Secret scanning, canonical serialization, hashing, SQLite writes, import validation, and returned values use only that snapshot. Accessors, cycles, symbols, sparse or extended arrays, hidden properties, non-plain objects, and inconsistent descriptor operations fail closed.
- Evidence: Getter, Proxy/data-descriptor, direct-import, caller-mutation, and normal nested-JSON regressions passed. Fresh verification completed 58/58 memory tests, 645/645 full-suite tests, TypeScript build, tracked `git diff --check`, untracked trailing-whitespace/final-newline checks, production secret scan, and boundary scan. A separate read-only security reviewer found no Critical, High, or Important issue and marked BUG-003 ready to resolve.
- Limitation: Returned snapshots are detached but remain mutable after return; input size/depth remains unbounded. Neither condition reopens the persistence TOCTOU and both are outside BUG-003.

### BUG-002 — `@D-AI sync` behavior is distinguished from ordinary local project continuation

- Severity: medium
- Status: resolved on 2026-08-22
- Resolution: Ordinary continuation was kept local-only, while explicit sync was verified across dirty and clean `main`, clean and dirty feature branches with and without upstream, unavailable remote fail-closed handling, a real remote-ahead fast-forward (`0/1` fetch followed by successful `pull --ff-only`), and ChatGPT Web handoff through the GitHub connector.
- Limitation: GitHub authentication failure was not reproduced because the current authenticated credentials were not invalidated. That environment-specific condition remains tracked by BUG-001 and is not claimed as verified here.
