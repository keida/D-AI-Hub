# Status

## State

- Lifecycle: completed
- Last updated: 2026-08-24

## Current checkpoint

- Current task: none. Codex-first V1 is completed and passed real acceptance; PR #9 was merged into `main` with a normal merge commit.
- Working state: the project is in a stable post-merge state with no active development task. The canonical `main` worktree remains dirty with pre-existing Skill-routing changes; all existing worktrees, branches, and fixtures are preserved.
- Authorized file scope: product documentation and project state only. Runtime, tests, adapters, dependencies, Router, and third-party Skill records are out of scope.
- Scope decision: D-AI V1 is Codex local control + GitHub durable evidence + D-AI-Hub Markdown knowledge/project memory. ChatGPT Web is for ordinary discussion and viewing only, not a D-AI runtime dependency; any separate authorized repository-hosted maintenance remains outside V1 activation. Native Chat, native Work, the Work file-backed connector, automatic cross-environment handoff, and automatic environment routing are Future/Deferred.

## Delivery state

1. **Markdown Hub — required.** `STATUS.md`, `DECISIONS.md`, `ROADMAP.md`, the command reference, and the retained v2 spec now describe the Codex-first boundary and its traceability.
2. **Codex control layer — required.** The existing parser, Skill/CLI entry, workspace-scoped durable discovery, ownership fencing, gates, recovery, rollback, GitHub seam, and close verdict remain the active implementation path.
3. **Chat/Work — deferred contract.** Existing adapters and handoff/routing contracts remain available as reference and compatibility seams; unavailable connectors must remain `BLOCKED` and do not block V1 scope completion.

## Verified evidence

- PR #9 was merged into `main` with a normal merge commit after the tracked documentation diff and GitHub PR review gates passed.
- The merged PR's tracked diff and GitHub PR record document the Codex-first V1 acceptance conclusion, preservation of known gaps, and explicit Chat/Work deferral; detailed execution evidence is intentionally not repeated in project memory.
- The 2026-08-21 v2 spec remains tracked and carries an explicit note that its cross-environment delivery scope is superseded by the Codex-first decision.

## Current blockers

- None for the completed Codex-first V1 scope. BUG-001 remains a known environment-dependent gap, not an active task.
- Chat/Work remains deferred and is not a current task; any future continuation requires a new independent scope and task.

## Next concrete action

No action; wait for a new explicit scope/task. Do not start Chat/Work without that independent scope and task.
