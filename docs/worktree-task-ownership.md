# Git worktrees and D-AI task ownership

D-AI's default durable root is `<invoked workspace>/.d-ai`, **not** the Git repository's shared common directory. The repository URL identifies a project; it does not authorize a second worktree to read, take ownership of, copy, or resume a task persisted under the first worktree.

This separation is intentional: task context manifests contain exact canonical workspace and absolute durable paths, and the strict reader verifies them. A detached linked worktree can resume its *own* existing task, but does not automatically inherit a sibling's task. Cross-root global task uniqueness has **not** been established.

## When rollover says `missingFields: ["task-pointer"]`

1. Keep the current Boss session alive. Do not retry rollover to create a task; rollover is read-only projection and cannot create a session or task.
2. Identify the exact workspace used by the invocation. Confirm its Git repository identity, canonical path, branch/HEAD and whether its own `.d-ai` exists.
3. In a trusted local checkout, inspect `git worktree list --porcelain` read-only. Inspect likely sibling `.d-ai` roots **without modifying them**. Task IDs from a different worktree are evidence, not permission to reuse them.
4. Distinguish an absent current task, a `LEGACY_FROZEN` historical-only task, an active routable task in another worktree, a task owned by a different agent environment, a project-identity conflict, and an ambiguous/corrupt task root. A foreign owner or identity conflict is **not** proof of a missing task; inspect and resolve that conflict before any registration. Never choose one by name similarity or repository URL alone.
5. If a routable task exists in the **intended owner workspace**, invoke `@D-AI status` or `@D-AI continue` with that exact workspace through the supported Skill and verify identity and recovery completeness. Do not claim that this transfers ownership to the current worktree.
6. If work must continue under a new worktree and its root is genuinely empty, prepare the intended project's approved task charter and request **separate explicit authorization** before using supported `@D-AI establish`. Check competing live task owners across known worktrees; the initial registration lock guarantees uniqueness only within its own durable root.
7. If the only existing state is `LEGACY_FROZEN`, preserve it for history. New-task and successor registration are distinct governed actions. Do not silently unfreeze, retarget, or migrate the historical task.

Never copy `.d-ai` across worktrees, change stored workspace identities, weaken path/hash validation, symlink multiple roots into one, or downgrade code against new-format durable state as a quick fix. A supported cross-worktree transfer/migration requires a separate explicit contract, backups, conflict/ownership handling, and recovery regression proof.

## What constitutes completed rollover

An accepted `@D-AI establish` creates a task; it does not produce authoritative phase, nextAction, a complete Current-State view, a persisted conversation handoff, or a new Boss session.

Rollover is ready only when the same unique routable task is selected, Current-State rebuild is verified and complete, and the prepare projection contains a non-null handoff. The handoff returned by the runtime is a **read-only projection**, not an automatically persisted handoff record or Codex session creation. Keep the original Boss open until the new Boss independently recovers the same authoritative identity, phase, nextAction, decisions, blockers and limitations.

## Boundaries

- Local-first: private memory stays in local SQLite; never sync raw `.d-ai`, personal transcripts or private databases to GitHub.
- GitHub contains reviewed public-safe framework milestones, not live task state.
- Old and new D-AI writers must not concurrently modify the same durable root during activation or rollback.
- A runnable worktree may be detached or have no remote; avoid introducing GitHub-only assumptions into local-only task recovery.
