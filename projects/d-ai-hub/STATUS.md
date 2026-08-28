# Status

## State

- Lifecycle: completed
- Last updated: 2026-08-28

## Current checkpoint

- Current task: record the user-approved 2026-08-28 Hub-first decision to keep Memorix as an optional, guarded local memory adapter; these two documents remain uncommitted, and committing or discarding them still requires the user's explicit decision. Do not implement the adapter.
- Working state: isolated worktree branch `codex/memorix-adapter-contract` is based on `origin/main` at `45a650d`. The scoped diff is exactly the decision in `DECISIONS.md` plus this status checkpoint; both files are uncommitted.
- Authorized file scope: `projects/d-ai-hub/DECISIONS.md` and `projects/d-ai-hub/STATUS.md` only. Runtime, tests, adapters, dependencies, Router, and third-party Skill records are out of scope.
- PoC verdict: PARTIAL. Memorix v1.8.3 proved manual structured-record storage, local SQLite/Orama BM25 search, and JSON transfer of five synthetic records between two temporary profiles.
- Known limits and risks: native GitHub sync, manifest/hash, device identity, base-version/delta, and bidirectional conflict resolution remain unproven or missing; transfer export preserved secret-shaped content, so export is not a secret-removal boundary.

## Delivery state

1. **Markdown Hub — required.** `STATUS.md`, `DECISIONS.md`, `ROADMAP.md`, the command reference, and the retained v2 spec now describe the Codex-first boundary and its traceability.
2. **Codex control layer — required.** The existing parser, Skill/CLI entry, workspace-scoped durable discovery, ownership fencing, gates, recovery, rollback, GitHub seam, and close verdict remain the active implementation path.
3. **Chat/Work — deferred contract.** Existing adapters and handoff/routing contracts remain available as reference and compatibility seams; unavailable connectors must remain `BLOCKED` and do not block V1 scope completion.

## Verified evidence

- PR #9 was merged into `main` with a normal merge commit after the tracked documentation diff and GitHub PR review gates passed.
- The merged PR's tracked diff and GitHub PR record document the Codex-first V1 acceptance conclusion, preservation of known gaps, and explicit Chat/Work deferral; detailed execution evidence is intentionally not repeated in project memory.
- The 2026-08-21 v2 spec remains tracked and carries an explicit note that its cross-environment delivery scope is superseded by the Codex-first decision.

## Current blockers

- None for the completed Codex-first V1 scope. The Memorix adapter remains unimplemented and requires separate authorization; the PoC limits and export secret risk above remain visible.
- Chat/Work remains deferred and is not a current task; any future continuation requires a new independent scope and task.

## Next concrete action

Review the two uncommitted documents (`DECISIONS.md` and this `STATUS.md`), then explicitly decide whether to commit or discard them. Do not implement the Memorix adapter.
