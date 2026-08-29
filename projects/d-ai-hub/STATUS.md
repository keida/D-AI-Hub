# Status

## State

- Lifecycle: active
- Last updated: 2026-08-29

## Current checkpoint

- Current task: Complete the real private-GitHub/two-device bundle acceptance after resolving BUG-004, a Windows Git line-ending boundary discovered during the first device-A export attempt. PR #14 is merged and BUG-003 remains resolved.
- Working state: a clean temporary clone of private `keida/D-AI-Hub` on canonical `main` completed synthetic `put`, restart `get`, and export. Review found that `core.autocrlf=true` can convert the Git-tracked JSONL from LF to CRLF on another checkout and invalidate its manifest digest. The reviewed bundle remains staged only in the isolated temporary clone and was not committed or pushed. A test-first minimal fix and project checkpoint are uncommitted in the preserved feature worktree. The original dirty root checkout remains untouched; no reset, stash, overwrite, automatic sync, or multi-writer expansion is authorized.
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
- The first controlled device-A attempt used a clean temporary clone whose `main` exactly matched private `origin/main` at merge commit `200192bd2ba2e73a2d18548cc8e50c66703ea104`. Synthetic memory `cross-device-20260829T061229Z` survived a separate CLI `get`; bundle `bundle-20260829T061229Z` exported one record, matched its recorded SHA-256, exposed no machine path or secret-shaped content, and staged exactly `manifest.json` plus `records.jsonl`. It was not pushed because Git warned that Windows checkout would rewrite LF as CRLF.
- BUG-004 was reproduced with real Git materialization under `core.autocrlf=true`: the checked-out JSONL gained byte 13 before its final LF. The failing regression turned green after adding a narrow `text eol=lf` attribute for memory bundle JSONL. Current local evidence is 59/59 memory tests, 32/32 full-suite files and 646/646 tests, a successful TypeScript build, and a passing `git diff --check`; fresh-clone verification remains pending until the fix is integrated.
- Production secret-shaped and boundary scans returned zero matches. A separate read-only security reviewer exercised descriptor/Proxy and malformed-shape cases, found no Critical, High, or Important issue, and marked BUG-003 ready to resolve. Memory code still does not invoke Git/GitHub or `DurableContextStore`, reader-mode `put` remains blocked, and automatic sync/merge and multi-writer behavior remain excluded.
- PR #14 merged to canonical `main` as merge commit `200192bd2ba2e73a2d18548cc8e50c66703ea104`. At its merge gate, focused diagnostics passed 2/2, the command-runner file passed 27/27, the full suite passed 31/31 files and 645/645 tests, the TypeScript build passed, and GitGuardian passed.
- Local verification snapshot (2026-08-28, environment-dependent): the installer lock records 17 selected Matt Skills from `mattpocock/skills`, and all 17 are discoverable from the native user-level Skill root; see `skills/external/matt-skills.md`.
- Local verification snapshot (2026-08-28, environment-dependent): Superpowers is exposed through one native discovery junction from a checkout at `v6.3.0` / `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`; see `skills/external/superpowers.md`.
- The Routing decision, discovery links, references, and roadmap agree that no external Router is installed. Documentation link checks and `git diff --check` remain required before any release action.
- PR #12 merged with the Boss internal review as its acceptance gate; its GitGuardian check passed and no external independent approval was required.

## Current blockers

- BUG-004 blocks the real transfer until the narrow Git attribute fix is integrated and verified from a fresh Windows checkout. The local regression, all memory tests, and build pass, but no commit/push authorization has been applied to this follow-up.
- The original root checkout is intentionally not a valid write target because it has uncommitted changes and is behind `origin/main`; it was not touched. The controlled device-A bundle remains unpushed, and real pull/import/get on the second physical device has not been performed.

## Next concrete action

- After explicit commit/push authorization, integrate the narrow BUG-004 fix, verify it from a fresh Windows checkout, regenerate the device-A bundle on clean canonical `main`, and push the reviewed two-file transfer commit. Then have the second physical device pull the exact SHA, import twice (`IMPORTED`, then `NOOP_DUPLICATE`), and get `cross-device-20260829T061229Z`. Do not add automatic synchronization, merging, or a second writer.
