# Status

## State

- Lifecycle: active
- Last updated: 2026-08-29

## Current checkpoint

- Current task: The first single-writer local-memory/private-GitHub transfer slice is accepted complete using an isolated device-B simulation. Select and separately authorize the next roadmap slice; do not expand this milestone implicitly.
- Working state: device A used a clean fresh clone of private `keida/D-AI-Hub` on canonical `main`, generated the synthetic bundle, and pushed exact two-file commit `a156c2a0cfbb29424f7a7bf173d72a5a8e609093` to `origin/main`. An isolated reader clone with its own workspace and SQLite database, `core.autocrlf=true`, and no writer operation verified the pulled JSONL digest, returned `IMPORTED`, then `NOOP_DUPLICATE`, and retrieved the same logical ID. The user accepted this as the phase-one device-B simulation. A future second-physical-device run is optional environment validation and must not be claimed as completed evidence. The original dirty root checkout remains untouched; no reset, stash, overwrite, automatic sync, or multi-writer expansion is authorized.
- Authorized file scope: a new `src/memory/` boundary and its focused tests, the local CLI/package script, this project's decision/status/roadmap, and the matching design/implementation plan. Existing `DurableContextStore`, lifecycle runtime, handoff, recovery, rollback, GitHub adapter, Router, external-memory adapters, and dashboard remain out of scope except for reuse through their existing public helpers and patterns.
- Boundary: local SQLite is a non-control-plane runtime store; Git-versioned JSONL/manifest bundles are the cross-device transfer artifact; Markdown/Git remains canonical for Skills, project state, knowledge, and decisions. One configured writer is allowed in this phase. Reader-mode stores reject writes and never auto-merge.
- Acceptance target: restart reads succeed; bundle tampering is rejected before SQLite mutation; a repeated exact import returns `NOOP_DUPLICATE`; all persisted/exported content is validated from one detached snapshot; and an isolated reader clone/database imports private-GitHub bytes and gets the same logical ID without writer access. All phase-one targets are verified. A second physical computer remains unverified optional environment validation rather than a blocker.

## Delivery state

1. **Markdown Hub — required.** `STATUS.md`, `DECISIONS.md`, `ROADMAP.md`, the command reference, and the retained v2 spec describe the Codex-first boundary and its traceability.
2. **Codex control layer — required.** The parser, Skill/CLI entry, workspace-scoped durable discovery, ownership fencing, gates, recovery, rollback, GitHub seam, and close verdict remain the active implementation path.
3. **Chat/Work — deferred contract.** Existing adapters and handoff/routing contracts remain reference seams; unavailable connectors must remain `BLOCKED` and do not block V1 scope completion.

## Verified evidence

- The prior isolated Memorix PoC remains historical evidence only; it is superseded for this slice by the separate local SQLite and versioned JSONL/manifest boundary in `DECISIONS.md`.
- The local SQLite, deterministic bundle, fresh-reader import, workspace binding, reader-only import, exact-byte UTF-8 integrity, sole-owner transaction, CLI, manual runbook, and single-snapshot secret boundary are implemented. Current evidence: 17 store tests, 32 bundle tests, and 9 CLI tests — 58/58 memory tests passed. TypeScript build, tracked `git diff --check`, and untracked trailing-whitespace/final-newline checks passed.
- Full-suite evidence after the BUG-003 fix: 31 test files and 645/645 tests passed. Getter, Proxy/data-descriptor, direct-import, caller-mutation, and normal nested-JSON regressions passed. A same-machine two-directory CLI probe previously completed writer `put`/`export` and fresh reader `IMPORTED`/same-ID `get`; the later accepted simulation added actual private-GitHub push/fresh-clone transport evidence while keeping physical-device evidence explicitly unverified.
- The first controlled device-A attempt used a clean temporary clone whose `main` exactly matched private `origin/main` at merge commit `200192bd2ba2e73a2d18548cc8e50c66703ea104`. Synthetic memory `cross-device-20260829T061229Z` survived a separate CLI `get`; bundle `bundle-20260829T061229Z` exported one record, matched its recorded SHA-256, exposed no machine path or secret-shaped content, and staged exactly `manifest.json` plus `records.jsonl`. It was not pushed because Git warned that Windows checkout would rewrite LF as CRLF.
- BUG-004 was reproduced with real Git materialization under `core.autocrlf=true`: the checked-out JSONL gained byte 13 before its final LF. The failing regression turned green after adding a narrow `text eol=lf` attribute for memory bundle JSONL. Verification covered 59/59 memory tests, 32/32 full-suite files and 646/646 tests, a successful TypeScript build, and a passing `git diff --check` before integration.
- PR #15 merged the BUG-004 fix as merge commit `0b37bb93df0a26a12f75444233b23ead2f648c6e`; GitGuardian passed and `origin/main` matched the merge commit. A post-merge fresh Windows clone with `core.autocrlf=true` passed the real-Git regression and preserved the regenerated JSONL digest after index materialization.
- Device A pushed exact two-file transfer commit `a156c2a0cfbb29424f7a7bf173d72a5a8e609093` directly on top of the verified merge commit. `origin/main` matched that exact SHA. A second fresh local clone pulled the private-GitHub bytes, matched records SHA-256 `0a4773a8f3f08d6d23e839bc226398fd0375798abb88563fabe153871ff66e72`, returned `IMPORTED`, then `NOOP_DUPLICATE`, and retrieved memory ID `cross-device-20260829T061229Z` with the expected synthetic value.
- Production secret-shaped and boundary scans returned zero matches. A separate read-only security reviewer exercised descriptor/Proxy and malformed-shape cases, found no Critical, High, or Important issue, and marked BUG-003 ready to resolve. Memory code still does not invoke Git/GitHub or `DurableContextStore`, reader-mode `put` remains blocked, and automatic sync/merge and multi-writer behavior remain excluded.
- PR #14 merged to canonical `main` as merge commit `200192bd2ba2e73a2d18548cc8e50c66703ea104`. At its merge gate, focused diagnostics passed 2/2, the command-runner file passed 27/27, the full suite passed 31/31 files and 645/645 tests, the TypeScript build passed, and GitGuardian passed.
- Local verification snapshot (2026-08-28, environment-dependent): the installer lock records 17 selected Matt Skills from `mattpocock/skills`, and all 17 are discoverable from the native user-level Skill root; see `skills/external/matt-skills.md`.
- Local verification snapshot (2026-08-28, environment-dependent): Superpowers is exposed through one native discovery junction from a checkout at `v6.3.0` / `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`; see `skills/external/superpowers.md`.
- The Routing decision, discovery links, references, and roadmap agree that no external Router is installed. Documentation link checks and `git diff --check` remain required before any release action.
- PR #12 merged with the Boss internal review as its acceptance gate; its GitGuardian check passed and no external independent approval was required.

## Current blockers

- No implementation, integrity, or private-GitHub transport blocker remains for the accepted first slice. A genuinely separate physical-device run is optional environment validation and is not part of the completed evidence.
- The original root checkout is intentionally not a valid write target because it has uncommitted changes and is behind `origin/main`; it was not touched. The current checkpoint update is local and uncommitted because no third status commit/push was authorized.

## Next concrete action

- After explicit commit/push authorization, publish this acceptance checkpoint. Then select a separately scoped next milestone; automatic synchronization, merging, a second writer, RAG, Dashboard, external memory integration, and Router expansion remain deferred unless explicitly authorized.
