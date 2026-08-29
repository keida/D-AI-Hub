# Status

## State

- Lifecycle: active
- Last updated: 2026-08-29

## Current checkpoint

- Current task: Fresh-device bootstrap and independent Memory CLI execution are verified and recorded on canonical `main`. Select the next separately scoped roadmap slice without expanding the manual single-writer boundary implicitly.
- Working state: A new private-repository clone at `be233d05abef675b3aa3fc85c12e5c7887b68b4a` with `core.autocrlf=true` ran `npm ci`, TypeScript build, and its own `tsx 4.23.12` without borrowing another worktree's dependencies. Its own `npm run memory` completed synthetic writer `put/get/export`, fresh-reader `import/get`, and repeat import `NOOP_DUPLICATE`. The prior two-bundle GitHub rehearsal remains recorded below. The original dirty root checkout remains untouched, with no reset, stash, overwrite, automatic sync, or multi-writer expansion.
- Authorized file scope: a new `src/memory/` boundary and its focused tests, the local CLI/package script, this project's decision/status/roadmap, and the matching design/implementation plan. Existing `DurableContextStore`, lifecycle runtime, handoff, recovery, rollback, GitHub adapter, Router, external-memory adapters, and dashboard remain out of scope except for reuse through their existing public helpers and patterns.
- Boundary: local SQLite is a non-control-plane runtime store; Git-versioned JSONL/manifest bundles are the cross-device transfer artifact; Markdown/Git remains canonical for Skills, project state, knowledge, and decisions. One configured writer is allowed in this phase. Reader-mode stores reject writes and never auto-merge.
- Acceptance target: preserve all accepted phase-one behavior and prove ordered repeated transfers: bundle 1 then bundle 2 imports successfully, both IDs are readable, gaps and overlaps are rejected without mutation, and replaying either applied bundle remains `NOOP_DUPLICATE`. These code and CLI targets are verified locally; a second physical computer remains optional environment validation rather than a blocker.

## Delivery state

1. **Markdown Hub — required.** `STATUS.md`, `DECISIONS.md`, `ROADMAP.md`, the command reference, and the retained v2 spec describe the Codex-first boundary and its traceability.
2. **Codex control layer — required.** The parser, Skill/CLI entry, workspace-scoped durable discovery, ownership fencing, gates, recovery, rollback, GitHub seam, and close verdict remain the active implementation path.
3. **Chat/Work — deferred contract.** Existing adapters and handoff/routing contracts remain reference seams; unavailable connectors must remain `BLOCKED` and do not block V1 scope completion.

## Verified evidence

- The prior isolated Memorix PoC remains historical evidence only; it is superseded for this slice by the separate local SQLite and versioned JSONL/manifest boundary in `DECISIONS.md`.
- The local SQLite, deterministic bundle, fresh-reader import, workspace binding, reader-only import, exact-byte UTF-8 integrity, sole-owner transaction, CLI, manual runbook, and single-snapshot secret boundary are implemented. Incremental continuity adds missing-reader and existing-reader gap regressions plus a real two-bundle CLI acceptance. Current evidence: 17 store tests, 34 bundle tests, 1 real-Git transfer test, and 10 CLI tests — 62/62 memory tests passed. The full suite passed 32/32 files and 649/649 tests, and the TypeScript build passed.
- The isolated operational rehearsal used only synthetic values and OS-local SQLite files. Bundle 1 transferred sequence 1 with digest `291a0e53fc97fc952ca7aef72fb0a783867bd70cf736b89d2b3a911bfe8be9b2`; bundle 2 transferred sequence 2 with digest `56423255745902603e66a6aee5b08d690c27ee6369c9b94a7ce845cf9783c88a`. Device B verified both Git-materialized digests, ordered import, duplicate receipts, and both reads without writer access. The synthetic SQLite files and temporary worktree were removed after verification; no rehearsal bundle path exists on `main`.
- Fresh-device bootstrap evidence: `npm ci` installed 57 packages and audited 58 with zero reported vulnerabilities; `npm run build` passed; the clone-local CLI persisted and reread value `42`, exported one-record digest `e8336ced7296243f4e31be3bf9fdfa8b91e843fd7c02e5c1515381c41be1b89d`, imported it into a separate SQLite database, reread the same ID, and returned `NOOP_DUPLICATE` on repeat. npm warned that the `esbuild@0.28.2` postinstall is not covered by allowScripts, but the installed build and runtime executed successfully.
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

- No implementation, integrity, or private-GitHub transport blocker remains for the accepted first slice or the locally verified ordered-increment slice. A genuinely separate physical-device run is optional environment validation and is not part of the completed evidence.
- The original root checkout remains intentionally excluded from writes because it has unrelated uncommitted changes and is behind `origin/main`; it was not touched. No blocker remains for the merged ordered-increment slice, two-bundle GitHub rehearsal, or fresh-clone bootstrap. The allowScripts warning is recorded as environment evidence, not a demonstrated runtime failure.

## Next concrete action

- Select the next separately scoped roadmap milestone. Automatic synchronization, merging behavior, a second writer, RAG, Dashboard, external memory integration, and Router expansion remain deferred unless separately authorized.
