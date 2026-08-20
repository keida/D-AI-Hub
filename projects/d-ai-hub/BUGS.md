# Bugs

## Open

### BUG-001 — Local Git CLI cannot authenticate to the private repository

- Severity: medium
- Status: blocked
- First observed: 2026-08-20
- Reproduction: From the local checkout, run `git fetch --prune origin` or `git pull --ff-only origin main`.
- Expected: Git authenticates to `https://github.com/keida/D-AI-Hub.git` and updates `main`.
- Actual: GitHub returns `Invalid username or token. Password authentication is not supported for Git operations.`
- Impact: Normal local fetch/pull and authoritative history reconciliation cannot yet be verified.
- Workaround: Use the authenticated GitHub connector for read-only snapshot retrieval, then verify local file blobs/tree content.
- Evidence: Terminal output from the setup session; local content verification matched all 34 blobs and tree `8a203f6900e4fa636297d418e6ecf320b29f1216`.
- Resolution condition: Configure a valid GitHub credential helper or GitHub CLI authentication, then complete a successful `git fetch --prune origin`.

## Resolved

_None yet._
