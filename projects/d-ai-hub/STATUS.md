# Status

## State

- Lifecycle: active
- Last updated: 2026-08-24

## Current checkpoint

- Current task: close out and publish the verified Codex-first V1 scope without changing the runtime or canonical main worktree.
- Working state: the fresh private-repository acceptance lifecycle passed on current main. The canonical `main` worktree remains dirty with pre-existing Skill-routing changes; all existing worktrees, branches, and fixtures are preserved.
- Authorized file scope: product documentation and project state only. Runtime, tests, adapters, dependencies, Router, and third-party Skill records are out of scope.
- Scope decision: D-AI V1 is Codex local control + GitHub durable evidence + D-AI-Hub Markdown knowledge/project memory. ChatGPT Web is for ordinary discussion and viewing only, not a D-AI runtime dependency; any separate authorized repository-hosted maintenance remains outside V1 activation. Native Chat, native Work, the Work file-backed connector, automatic cross-environment handoff, and automatic environment routing are Future/Deferred.

## Delivery state

1. **Markdown Hub — required.** `STATUS.md`, `DECISIONS.md`, `ROADMAP.md`, the command reference, and the retained v2 spec now describe the Codex-first boundary and its traceability.
2. **Codex control layer — required.** The existing parser, Skill/CLI entry, workspace-scoped durable discovery, ownership fencing, gates, recovery, rollback, GitHub seam, and close verdict remain the active implementation path.
3. **Chat/Work — deferred contract.** Existing adapters and handoff/routing contracts remain available as reference and compatibility seams; unavailable connectors must remain `BLOCKED` and do not block V1 scope completion.

## Verified evidence

- A new private-repository acceptance task was established from current main with fresh durable state and a recovery point.
- Normal `@D-AI status` uniquely discovered the active task without `--task`; normal `@D-AI close` completed with all 11 evidence gates passing, including push and exact remote repository/ref/SHA verification.
- The runtime close response returned `Safe-to-delete: YES`; critical unsaved context was empty, durable context was saved, the worktree was clean at the execution boundary, and no secret-like material was found in the durable evidence. The exact command results and GitHub visibility proof remain in the temporary acceptance report, not in project memory.
- The 2026-08-21 v2 spec remains tracked and carries an explicit note that its cross-environment delivery scope is superseded by the Codex-first decision.

## Current blockers

- Local Git authentication remains environment-dependent and is tracked by BUG-001; it does not invalidate the verified configured acceptance path.

## Next concrete action

Review PR #9. If head/base remain unchanged, no new P0/P1 findings appear, and the PR remains mergeable, wait for explicit merge authorization. Do not start Work activation or native Chat/Work integration.
