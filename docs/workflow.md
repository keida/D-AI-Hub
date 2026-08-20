# D-AI-Hub Cross-Client Workflow

This document defines the safe operating contract between ChatGPT Web, GitHub, Codex, and other compatible agents. It supplements the command protocol in `AGENTS.md`; it does not authorize destructive Git operations by itself.

## Canonical source

- The private GitHub repository `keida/D-AI-Hub` is the canonical source of truth.
- The `main` branch is the canonical branch.
- ChatGPT Web and Codex use GitHub as the shared coordination point; local checkouts are working copies.
- Never store credentials, tokens, cookies, or authentication artifacts in D-AI-Hub.

## Safe `@D-AI sync`

1. Inspect the current branch and working tree before changing anything.
2. Authenticate and run `git fetch --prune origin` when local Git is available.
3. If the checkout is clean and local `main` is fast-forwardable to `origin/main`, update it with `git pull --ff-only origin main`. Do not create a backup branch for this normal case.
4. If the working tree is dirty, stop and report the exact state. Do not automatically stash, reset, delete, or overwrite changes.
5. If local commits and remote commits have diverged, protect the local work with a non-destructive backup branch or equivalent copy, then stop and report the divergence. Wait for a safety decision before merge, rebase, reset, or other integration.
6. If authentication or freshness verification fails, report the checkout as unsynced. Do not reconstruct authoritative history from memory or claim that sync succeeded.

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
