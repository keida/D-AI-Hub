# Status

## State

- Lifecycle: active
- Last updated: 2026-08-23

## Current checkpoint

- Current task: Restore the approved D-AI orchestrator v2 product intent and deliver a usable Codex activation entry without expanding Router, third-party Skill, or repository-health scope.
- Authorized scope: Track the approved v2 specification; align project state; implement the minimum Codex raw-command activation, explicit durable task selection, and product-boundary acceptance. Commit and push only the intended feature-branch files; do not merge, reset, stash, clean, or delete. Preserve all existing modified and untracked files outside the intended set.
- Working state: `main = origin/main = c958fbc` and its user-owned Skill-routing documentation edits remain untouched. Local release commits are `8557242`, `6c61c97`, and `76f02f2`; remote feature remains at `e81d74e` pending the authorized push. The three pre-existing untracked repository-health/PR2 planning files remain untouched.
- Active plan: Release candidate commits prepared; push only `feat/d-ai-ownership-repair` to `origin`, verify the exact remote SHA, and do not merge.

## Four-layer delivery state

1. **Markdown Hub — established, canonical integration pending.** `main` remains the canonical GitHub branch. The approved v2 product specification is present at `docs/specs/2026-08-21-d-ai-orchestrator-v2-design.md` on the active branch. Release commits are local and not yet pushed.
2. **Orchestrator runtime — implemented on the feature branch, not merged.** Parser, routing, handoff, durable state, verification, recovery, rollback, and close logic exist. The branch contains 75 commits and 85 files / 17,665 insertions beyond `origin/main`; the last pushed checkpoint is `e81d74e`.
3. **Codex activation — release candidate commits prepared.** The canonical `d-ai` Skill, compatibility entry, raw-command adapter, CLI, and explicit `activeTaskId` recovery seam are committed locally. A reversible user-level junction at `~/.agents/skills/d-ai` points to the canonical Skill source. Fresh `@D-AI status`/`@D-AI close` auto-select one active durable task by persisted workspace identity; zero, multiple, mismatch, malformed/duplicate identity, closed-task, and ownership cases remain `BLOCKED`. Targeted tests prove canonical paths, junctions, Windows case variants, cross-workspace isolation, dirty-worktree `NO`, missing-credentials `BLOCKED`, remote-SHA-mismatch `NO`, and unconfigured execution connector `BLOCKED`.
4. **Chat/Work adapters — contract only, not product-activated.** Runtime adapter classes and logical command semantics exist, but no supported Chat or Work activation surface or configured execution/durable connector has been delivered. Their unavailable capabilities remain `BLOCKED` and must not be reported as complete.

## Verified evidence

- Live remote read before push: `refs/heads/main = c958fbc88c7e1c76fcfa5cd58b1049c3c0c93c95`; `refs/heads/feat/d-ai-ownership-repair = e81d74e9753a3c5684978f8c88882d32abaa8c35`.
- Approved-spec source and tracked copy share SHA-256 `5224053CC37E695EC6A0C8047E2AEFBBC836FEFF8D826847FF0518AAF10BCB4F`.
- Targeted activation verification passed: runtime 77/77; entry 3/3; external Skill boundary 2/2; configured close boundary 14/14.
- Real user-level smoke from an unrelated temporary workspace resolved `~/.agents/skills/d-ai`, entered the configured Codex runtime, and returned exit code 2 with `taskId=unassigned`, `status=blocked`, and workspace-scoped retry guidance.
- Final complete verification passed 25/25 test files and 477/477 tests with one worker, `npm run build`, and `git diff --check`. Secret-shaped scan found no non-test credentials; three matches are intentional sentinel values in existing rejection tests.
- Earlier pushed runtime checkpoint verification passed 21 test files and 457/457 tests; the current 25/477 result supersedes that local validation baseline.

## Release-candidate commit scope

- Committed intended set: docs/Skill/project-state commit `8557242`; runtime/store/entry/package commit `6c61c97`; tests commit `76f02f2`.
- Untracked preserved and excluded: `docs/superpowers/plans/2026-08-21-repository-health-check.md`, `docs/superpowers/plans/2026-08-22-pr2-review-repair.md`, and `docs/superpowers/specs/2026-08-21-repository-health-check.md`.

## Current blockers

- Independent two-axis review completed with separate GPT-5.6 Luna High reviewers. Standards: no new hard violation; PR2 plan source traceability remains partial because the original review artifact/issue ID is not present in the repository. Spec: the requested Codex slice is resolved; the workspace hash is intentionally a snapshot fingerprint and path is the stable discovery key.
- Chat and Work product activation/connectors remain unavailable and correctly remain `BLOCKED`.
- Canonical `main` cannot be updated from this task because merge is not authorized and its working tree contains preserved user edits.

## Next concrete action

Push `feat/d-ai-ownership-repair` to `origin` and verify the remote SHA; merge remains out of scope and requires separate authorization.
