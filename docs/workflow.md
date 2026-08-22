# D-AI-Hub Cross-Client Workflow

This document defines the safe operating contract between ChatGPT Web, GitHub, Codex, and other compatible agents. It supplements the command protocol in `AGENTS.md`; it does not authorize destructive Git operations by itself.

## Canonical source

- The private GitHub repository `keida/D-AI-Hub` is the canonical source of truth.
- The `main` branch is the canonical branch.
- ChatGPT Web and Codex use GitHub as the shared coordination point; local checkouts are working copies.
- Never store credentials, tokens, cookies, or authentication artifacts in D-AI-Hub.

## Risk-based safety gates

### Fast Read

Use for read-only questions and ordinary project continuation.

1. Locate the real checkout and inspect current branch, HEAD, and working tree.
2. Read the target project's `STATUS.md` and relevant open bugs.
3. Read other project files, indexes, or Skills only when required by the task.
4. Do not fetch, pull, run full-repository audits, or claim remote freshness unless explicitly required.

### Write Gate

Use before the first file modification.

1. Confirm the user's authorized scope and the exact files that may change.
2. Preserve existing modified and untracked files; do not treat them as disposable agent state.
3. Load the narrowest required canonical Skill.
4. Verify canonical freshness when stale remote state could cause a conflicting write.
5. Stop on dirty-scope overlap, divergence, authentication failure, or uncertain ownership rather than overwriting work.

### Release Gate

Use before commit, push, merge, PR creation, or `@D-AI close`.

1. Inspect the complete intended diff and staged file list.
2. Run the repository's relevant tests plus validation proportional to the changed files.
3. Check changed content and filenames for secret-like additions.
4. Verify branch, remote, ancestry, and the actual push result.
5. Report local commit and remote synchronization separately.

Do not run Release Gate checks repeatedly during Fast Read work.

## Progress checkpoints

Each active project keeps one current checkpoint inside its canonical `STATUS.md`.

Update the checkpoint when any of these changes meaningfully:

- current task or authorized scope;
- working state or changed file set;
- verified result or newly failed check;
- blocker or risk;
- active plan or next concrete action;
- handoff/close readiness.

Replace the checkpoint in place. Keep it concise and link to `DECISIONS.md`, `BUGS.md`, `ROADMAP.md`, or `REFERENCES.md` for canonical details. Do not create a chronological command log, duplicate canonical content, save full chat, or record unchanged progress after every tool call.

Within one uninterrupted session, reuse the already loaded current state instead of rereading unchanged files. On a new session, after context compaction, during a client handoff, or when external changes are possible, read the checkpoint first and expand context only as required.

## Explicit `@D-AI sync`

`@D-AI sync` is an optional canonical-freshness check, not a prerequisite for ordinary local project continuation.

1. Inspect the actual checkout, current branch, HEAD, and working tree before network actions.
2. Authenticate and run `git fetch --prune origin` when local Git is available and the user has not prohibited Git metadata changes.
3. If the checkout is clean, current branch is canonical `main`, and local `main` is fast-forwardable to refreshed `origin/main`, update with `git pull --ff-only origin main`.
4. On a dirty worktree, feature branch, detached HEAD, or divergence, do not pull or integrate. Report local HEAD, refreshed or cached remote refs, and the exact limitation.
5. If authentication or freshness verification fails, report the checkout as unsynced. Do not reconstruct authoritative history from memory or claim that sync succeeded.
6. Never equate local context loading, a cached `origin/main`, or a feature-branch push with canonical `main` synchronization.

## Writes, commits, and push

- Before editing, read the relevant canonical Skill and project-memory files.
- Stage only the confirmed files for the task and inspect the diff before committing.
- Never use destructive reset, force-push, or deletion to resolve a sync or push problem without explicit user confirmation.
- A successful local commit is not a successful GitHub update. Report commit and push states separately.
- If authentication, push, or remote update fails, leave the work visible, report `unsynced`, and do not claim that `@D-AI close` is fully synchronized.

## ChatGPT Web and Codex coordination

- ChatGPT Web may discuss, plan, retrieve, and perform authorized repository-hosted updates through its available GitHub integration.
- Codex may use a local checkout for filesystem edits, local Skill discovery, Git verification, and authorized commits/pushes.
- Before either client writes, it must refresh the relevant `main` state and inspect the working tree.
- Prefer one active writer for a file set. If Web and Codex modify the same files concurrently, the later writer must fetch again, compare the remote changes, and stop on conflicts rather than overwriting them.
- Resolve conflicts only after preserving both sides and choosing an explicit merge or rebase decision. Never force-push to make the histories appear aligned.

## Completion evidence

Before reporting sync or close as complete, verify:

- the intended branch and remote are correct;
- the working tree is clean, unless uncommitted work was explicitly left for review;
- local and remote ancestry is understood;
- the push result is known, or the state is explicitly reported as unsynced;
- no credentials or unauthorized confidential material were added.
