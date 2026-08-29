# Status

## State

- Lifecycle: active
- Last updated: 2026-08-30

## Current checkpoint

- Current task: Integrate the verified Windows PowerShell object-JSON invocation guidance through PR #18 without changing Memory CLI behavior or expanding the manual sync boundary.
- Working state: PR #18's runbook clarification and reconciled checkpoint are clean against current `main`; GitGuardian passed and an ordinary PR merge is explicitly authorized. No Memory CLI code change or new `--value-file` option is justified. The original dirty root checkout remains untouched.
- Authorized file scope: `docs/memory-sync-manual-workflow.md` and this `STATUS.md` integration record only. The ordinary merge of PR #18 is authorized; automatic sync, multi-writer behavior, RAG, Dashboard, Router, and external-memory work remain separately authorized.
- Boundary: local SQLite is a non-control-plane runtime store; Git-versioned JSONL/manifest bundles are the cross-device transfer artifact; Markdown/Git remains canonical for Skills, project state, knowledge, and decisions. One configured writer is allowed in this phase. Reader-mode stores reject writes and never auto-merge.
- Acceptance target: retain the verified npm invocation boundary and Windows wrapper diagnosis, preserve every current `origin/main` policy and checkpoint change, leave no conflict markers, and reduce the PR's net change to the runbook clarification plus its durable status evidence.

## Delivery state

1. **Markdown Hub — required.** `STATUS.md`, `DECISIONS.md`, `ROADMAP.md`, the command reference, and the retained v2 spec describe the Codex-first boundary and its traceability.
2. **Codex control layer — required.** The parser, Skill/CLI entry, workspace-scoped durable discovery, ownership fencing, gates, recovery, rollback, GitHub seam, and close verdict remain the active implementation path.
3. **Chat/Work — deferred contract.** Existing adapters and handoff/routing contracts remain reference seams; unavailable connectors must remain `BLOCKED` and do not block V1 scope completion.

## Verified evidence

- The prior isolated Memorix PoC remains historical evidence only; it is superseded for this slice by the separate local SQLite and versioned JSONL/manifest boundary in `DECISIONS.md`.
- The local SQLite, deterministic bundle, fresh-reader import, workspace binding, reader-only import, exact-byte UTF-8 integrity, sole-owner transaction, CLI, manual runbook, and single-snapshot secret boundary are implemented. Incremental continuity adds missing-reader and existing-reader gap regressions plus a real two-bundle CLI acceptance. Current evidence: 17 store tests, 34 bundle tests, 1 real-Git transfer test, and 10 CLI tests — 62/62 memory tests passed. The full suite passed 32/32 files and 649/649 tests, and the TypeScript build passed.
- The isolated operational rehearsal used only synthetic values and OS-local SQLite files. Bundle 1 transferred sequence 1 with digest `291a0e53fc97fc952ca7aef72fb0a783867bd70cf736b89d2b3a911bfe8be9b2`; bundle 2 transferred sequence 2 with digest `56423255745902603e66a6aee5b08d690c27ee6369c9b94a7ce845cf9783c88a`. Device B verified both Git-materialized digests, ordered import, duplicate receipts, and both reads without writer access. The synthetic SQLite files and temporary worktree were removed after verification; no rehearsal bundle path exists on `main`.
- Fresh-device bootstrap evidence: `npm ci` installed 57 packages and audited 58 with zero reported vulnerabilities; `npm run build` passed; the clone-local CLI persisted and reread value `42`, exported one-record digest `e8336ced7296243f4e31be3bf9fdfa8b91e843fd7c02e5c1515381c41be1b89d`, imported it into a separate SQLite database, reread the same ID, and returned `NOOP_DUPLICATE` on repeat. npm warned that the `esbuild@0.28.2` postinstall is not covered by allowScripts, but the installed build and runtime executed successfully.
- Windows PowerShell object-JSON diagnosis: two exact npm-path runs persisted `{"text":"hello"}` and created no repository changes. The same value failed only through the unsupported direct `tsx.cmd` wrapper and succeeded through the direct Node `tsx` entry, isolating the issue to Windows batch argument forwarding rather than Memory CLI parsing. The runbook now explicitly preserves the verified npm invocation boundary.
- Full-suite evidence after the BUG-003 fix: 31 test files and 645/645 tests passed. Getter, Proxy/data-descriptor, direct-import, caller-mutation, and normal nested-JSON regressions passed. A same-machine two-directory CLI probe previously completed writer `put`/`export` and fresh reader `IMPORTED`/same-ID `get`; the later accepted simulation added actual private-GitHub push/fresh-clone transport evidence while keeping physical-device evidence explicitly unverified.
- The first controlled device-A attempt used a clean temporary clone whose `main` exactly matched private `origin/main` at merge commit `200192bd2ba2e73a2d18548cc8e50c66703ea104`. Synthetic memory `cross-device-20260829T061229Z` survived a separate CLI `get`; bundle `bundle-20260829T061229Z` exported one record, matched its recorded SHA-256, exposed no machine path or secret-shaped content, and staged exactly `manifest.json` plus `records.jsonl`. It was not pushed because Git warned that Windows checkout would rewrite LF as CRLF.
- BUG-004 was reproduced with real Git materialization under `core.autocrlf=true`: the checked-out JSONL gained byte 13 before its final LF. The failing regression turned green after adding a narrow `text eol=lf` attribute for memory bundle JSONL. Verification covered 59/59 memory tests, 32/32 full-suite files and 646/646 tests, a successful TypeScript build, and a passing `git diff --check` before integration.
- PR #15 merged the BUG-004 fix as merge commit `0b37bb93df0a26a12f75444233b23ead2f648c6e`; GitGuardian passed and `origin/main` matched the merge commit. A post-merge fresh Windows clone with `core.autocrlf=true` passed the real-Git regression and preserved the regenerated JSONL digest after index materialization.
- Device A pushed exact two-file transfer commit `a156c2a0cfbb29424f7a7bf173d72a5a8e609093` directly on top of the verified merge commit. `origin/main` matched that exact SHA. A second fresh local clone pulled the private-GitHub bytes, matched records SHA-256 `0a4773a8f3f08d6d23e839bc226398fd0375798abb88563fabe153871ff66e72`, returned `IMPORTED`, then `NOOP_DUPLICATE`, and retrieved memory ID `cross-device-20260829T061229Z` with the expected synthetic value.
- Production secret-shaped and boundary scans returned zero matches. A separate read-only security reviewer exercised descriptor/Proxy and malformed-shape cases, found no Critical, High, or Important issue, and marked BUG-003 ready to resolve. Memory code still does not invoke Git/GitHub or `DurableContextStore`, reader-mode `put` remains blocked, and automatic sync/merge and multi-writer behavior remain excluded.
- PR #14 merged to canonical `main` as merge commit `200192bd2ba2e73a2d18548cc8e50c66703ea104`. At its merge gate, focused diagnostics passed 2/2, the command-runner file passed 27/27, the full suite passed 31/31 files and 645/645 tests, the TypeScript build passed, and GitGuardian passed.
- Local verification snapshot (2026-08-28, environment-dependent): the installer lock records 17 selected Matt Skills from `mattpocock/skills`, and all 17 are discoverable from the native user-level Skill root; see `skills/external/matt-skills.md`.
- The 2026-08-28 Superpowers discovery snapshot is superseded: on 2026-08-29 its native user-level discovery junction was removed by explicit user decision. The preserved upstream checkout is inert and must not be treated as an active Skill source; see `skills/external/superpowers.md`.
- Superpowers-disable release evidence: all native user and workspace Skill roots returned no Superpowers discovery entry; the disabled provenance links resolve; `git diff --check`, the changed-content secret scan, TypeScript build, and Markdown link validation passed; the final full suite passed 32/32 files and 649/649 tests. A prior full run's single Windows descendant-cleanup timing failure passed three focused reruns and the final full suite without implementation changes.
- The Routing decision, discovery links, references, and roadmap agree that no external Router is installed. Documentation link checks and `git diff --check` remain required before any release action.
- PR #12 merged with the Boss internal review as its acceptance gate; its GitGuardian check passed and no external independent approval was required.

## Current blockers

- No implementation, integrity, or private-GitHub transport blocker remains for the accepted first slice or the locally verified ordered-increment slice. A genuinely separate physical-device run is optional environment validation and is not part of the completed evidence.
- The original root checkout remains intentionally excluded from writes because it has unrelated uncommitted changes and is behind `origin/main`; it was not touched. No blocker remains for the merged ordered-increment slice, two-bundle GitHub rehearsal, or fresh-clone bootstrap. The allowScripts warning is recorded as environment evidence, not a demonstrated runtime failure.

## Next concrete action

- With the Windows invocation guidance integrated, select the next separately scoped roadmap milestone. Automatic synchronization, merging behavior, a second writer, RAG, Dashboard, external memory integration, and Router expansion remain deferred unless separately authorized.
