# Status

## State

- Lifecycle: active
- Last updated: 2026-08-23

## Current checkpoint

- Current task: narrow D-AI product scope to Codex-first V1 without changing the merged runtime or canonical main worktree.
- Working state: this isolated documentation branch is based on `origin/main` at `3829f731`. The canonical `main` worktree remains dirty with pre-existing Skill-routing changes; the ownership-repair worktree and branch are preserved and are not being reused.
- Authorized file scope: product documentation and project state only. Runtime, tests, adapters, dependencies, Router, and third-party Skill records are out of scope.
- Scope decision: D-AI V1 is Codex local control + GitHub durable evidence + D-AI-Hub Markdown knowledge/project memory. ChatGPT Web is for ordinary discussion and viewing only, not a runtime dependency. Native Chat, native Work, the Work file-backed connector, automatic cross-environment handoff, and automatic environment routing are Future/Deferred.

## Delivery state

1. **Markdown Hub — required.** `STATUS.md`, `DECISIONS.md`, `ROADMAP.md`, the command reference, and the retained v2 spec now describe the Codex-first boundary and its traceability.
2. **Codex control layer — required.** The existing parser, Skill/CLI entry, workspace-scoped durable discovery, ownership fencing, gates, recovery, rollback, GitHub seam, and close verdict remain the active implementation path.
3. **Chat/Work — deferred contract.** Existing adapters and handoff/routing contracts remain available as reference and compatibility seams; unavailable connectors must remain `BLOCKED` and do not block V1 scope completion.

## Verified evidence

- Fresh worktree created from refreshed `origin/main`; canonical main status was audited before creation and was not changed.
- Existing controlled smoke: normal `@D-AI status` selected one durable task after fresh runtime restart; normal `@D-AI close` safely returned `BLOCKED` without GitHub credentials/remote evidence; cross-workspace discovery returned `unassigned/BLOCKED`.
- The 2026-08-21 v2 spec remains tracked and now carries an explicit note that its cross-environment delivery scope is superseded by the 2026-08-23 Codex-first decision.

## Current blockers

- The Codex close gate still needs a separately controlled configured GitHub repository/evidence run to demonstrate a real positive `YES`; this is a V1 acceptance blocker, not a Chat/Work blocker.
- This scope branch has uncommitted documentation changes pending human review and explicit publication authorization.

## Next concrete action

Review the uncommitted Codex-first documentation diff and its independent consistency review. If accepted, run the documentation gate and request explicit authorization before any commit or push; do not start Work activation or native Chat/Work integration.
