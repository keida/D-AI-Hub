# Status

## State

- Lifecycle: active
- Last updated: 2026-08-29

## Current checkpoint

- Current task: Preserve the completed first single-writer local-memory transfer slice in one reviewed local branch commit. BUG-003 is resolved locally; no implementation blocker remains in the authorized slice.
- Working state: implementation work remains isolated on `codex/memory-sync-slice`, based on `e5aadeb`, which matched the cached `origin/main` ref at the release gate. The implementation, tests, documentation, package script, and project-state checkpoint are included in one local commit. The original root checkout is dirty and behind, and remains untouched. The user authorized this local commit only; no push, merge, reset, stash, or overwrite is authorized.
- Authorized file scope: a new `src/memory/` boundary and its focused tests, the local CLI/package script, this project's decision/status/roadmap, and the matching design/implementation plan. Existing `DurableContextStore`, lifecycle runtime, handoff, recovery, rollback, GitHub adapter, Router, external-memory adapters, and dashboard remain out of scope except for reuse through their existing public helpers and patterns.
- Boundary: local SQLite is a non-control-plane runtime store; Git-versioned JSONL/manifest bundles are the cross-device transfer artifact; Markdown/Git remains canonical for Skills, project state, knowledge, and decisions. One configured writer is allowed in this phase. Reader-mode stores reject writes and never auto-merge.
- Acceptance target: restart reads succeed; bundle tampering is rejected before SQLite mutation; a repeated exact import returns `NOOP_DUPLICATE`; all persisted/exported content is validated from one detached snapshot; a separate reader database and directory on the same machine import and get the same logical ID. All local targets are verified. Real second-device operation and private-GitHub push/pull remain unverified manual actions outside this slice.

## Delivery state

1. **Markdown Hub — required.** `STATUS.md`, `DECISIONS.md`, `ROADMAP.md`, the command reference, and the retained v2 spec describe the Codex-first boundary and its traceability.
2. **Codex control layer — required.** The parser, Skill/CLI entry, workspace-scoped durable discovery, ownership fencing, gates, recovery, rollback, GitHub seam, and close verdict remain the active implementation path.
3. **Chat/Work — deferred contract.** Existing adapters and handoff/routing contracts remain reference seams; unavailable connectors must remain `BLOCKED` and do not block V1 scope completion.

## Verified evidence

- The prior isolated Memorix PoC remains historical evidence only; it is superseded for this slice by the separate local SQLite and versioned JSONL/manifest boundary in `DECISIONS.md`.
- The local SQLite, deterministic bundle, fresh-reader import, workspace binding, reader-only import, exact-byte UTF-8 integrity, sole-owner transaction, CLI, manual runbook, and single-snapshot secret boundary are implemented. Current evidence: 17 store tests, 32 bundle tests, and 9 CLI tests — 58/58 memory tests passed. TypeScript build, tracked `git diff --check`, and untracked trailing-whitespace/final-newline checks passed.
- Full-suite evidence after the BUG-003 fix: 31 test files and 645/645 tests passed. Getter, Proxy/data-descriptor, direct-import, caller-mutation, and normal nested-JSON regressions passed. A same-machine two-directory CLI probe previously completed writer `put`/`export` and fresh reader `IMPORTED`/same-ID `get`. The CLI/runbook are locally verified; real second-device and private-GitHub push/pull behavior is not verified.
- Production secret-shaped and boundary scans returned zero matches. A separate read-only security reviewer exercised descriptor/Proxy and malformed-shape cases, found no Critical, High, or Important issue, and marked BUG-003 ready to resolve. Memory code still does not invoke Git/GitHub or `DurableContextStore`, reader-mode `put` remains blocked, and automatic sync/merge and multi-writer behavior remain excluded.
- Local verification snapshot (2026-08-28, environment-dependent): the installer lock records 17 selected Matt Skills from `mattpocock/skills`, and all 17 are discoverable from the native user-level Skill root; see `skills/external/matt-skills.md`.
- Local verification snapshot (2026-08-28, environment-dependent): Superpowers is exposed through one native discovery junction from a checkout at `v6.3.0` / `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`; see `skills/external/superpowers.md`.
- The Routing decision, discovery links, references, and roadmap agree that no external Router is installed. Documentation link checks and `git diff --check` remain required before any release action.
- PR #12 merged with the Boss internal review as its acceptance gate; its GitGuardian check passed and no external independent approval was required.

## Current blockers

- No local implementation blocker remains in the authorized single-writer slice. BUG-003 is resolved with fresh verification and independent security review.
- The original root checkout is intentionally not a valid write target because it has uncommitted changes and is behind `origin/main`; it was not touched. A real second-device or private-GitHub push/pull acceptance run was not performed because transport is manual and no release authorization was given.

## Next concrete action

- Decide whether to authorize pushing the exact local slice commit and then perform the real private-GitHub/two-device acceptance milestone. Do not push, merge, or perform Git transport without separate authorization.
