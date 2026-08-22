# D-AI-Hub Agent Bootstrap

This repository is the canonical source of truth for D-AI-Hub across ChatGPT Web, Codex, and compatible agents.

## D-AI Command Protocol

The following are D-AI-Hub natural-language workflows for ChatGPT Web, Codex, and compatible agents. They are not built-in commands. `@D-AI establish` and `@D-AI close` are the primary lifecycle commands; `@D-AI sync` is an optional explicit canonical-freshness check, and `@D-AI update` remains an internal workflow for recording durable outcomes during a session. When the user's message begins with one of these exact prefixes, interpret it as the workflow below and then continue with any task text that follows the command.

### `@D-AI establish`

Use when setting up D-AI-Hub in a new Codex/agent environment or when setup state is uncertain.

1. Confirm the canonical repository is `keida/D-AI-Hub` and the intended canonical branch is `main`.
2. Verify authenticated read access and, when local Git is available, verify fetch/pull access. Do not claim sync if authentication fails.
3. Confirm the root `AGENTS.md` is present and read it completely.
4. Read `README.md` and the three discovery indexes: `indexes/SKILLS.md`, `indexes/KNOWLEDGE.md`, and `indexes/PROJECTS.md`.
5. Confirm the canonical custom Skills under `skills/custom/` are discoverable/readable and note `.agents/skills/` as compatibility entry points.
6. If there is an active D-AI-Hub project record, read `projects/d-ai-hub/STATUS.md` and the standard project continuation files.
7. Report what is established, what is verified, and any remaining environment-specific blocker. Do not store credentials or machine secrets.

### `@D-AI sync`

Use when the user explicitly wants canonical GitHub freshness verified, especially after switching clients, after a long pause, or when remote changes are suspected. Ordinary project continuation does not require this command.

1. Read and follow [`docs/workflow.md`](docs/workflow.md) before any sync or write operation.
2. Inspect the actual checkout, current branch, HEAD, and working tree before network or integration actions.
3. With authenticated local Git, refresh remote refs using `git fetch --prune origin`. Fetch may update Git metadata but must not modify the working tree, index, or current branch.
4. Pull only when the checkout is clean, the current branch is canonical `main`, and the update is fast-forwardable; use `git pull --ff-only origin main`.
5. On a dirty worktree, feature branch, detached HEAD, divergence, authentication failure, or explicit read-only restriction, do not pull, merge, stash, reset, delete, or overwrite. Report exactly what was and was not verified.
6. Never describe local file reads or a cached `origin/main` reference as verified GitHub synchronization.
7. Read only the narrowest relevant index, Skill, knowledge note, and project files required by the task.
8. Continue the user's task using repository state as canonical context instead of relying on old chat history.

### `@D-AI update`

Use to persist worthwhile information from the current session without ending the session.

1. When project progress, verification, blockers, authorized scope, or the next action changes meaningfully, replace the project's `STATUS.md` current checkpoint with a concise summary.
2. Extract only durable knowledge, decisions, verified project state, useful references, and other information that has long-term retrieval value.
3. Exclude transient conversation, repeated unchanged state, speculation presented as fact, secrets, credentials, authentication artifacts, and unauthorized confidential material.
4. Search for an existing canonical file before creating anything new; update instead of duplicating.
5. Route content to the canonical owner:
   - workflow instructions -> `skills/custom/`
   - reusable subject knowledge -> `knowledge/`
   - project-specific state/decisions/bugs/roadmap/references -> `projects/<project>/`
   - stable cross-project context -> `memory/`
   - reusable standalone prompt -> `prompts/`
6. Update relevant indexes when discovery state changes.
7. Verify the resulting content is internally consistent and source-aware.
8. Commit/push small durable updates only when explicitly authorized; otherwise report exactly what remains local/unsynced.

### `@D-AI close`

Use at the end of meaningful work.

1. Perform the `@D-AI update` workflow for all durable outcomes from the session.
2. For each active project touched, ensure `STATUS.md` reflects verified reality and contains the next concrete action.
3. Record non-obvious durable decisions in `DECISIONS.md`; keep unresolved bugs visible in `BUGS.md`; update `ROADMAP.md` and `REFERENCES.md` when applicable.
4. Promote reusable knowledge out of project notes into the appropriate `knowledge/` domain only when it is genuinely reusable; link rather than duplicate.
5. Remove or generalize stale machine-specific paths, transient SHAs/snapshot hashes, and one-session diagnostics unless still operationally relevant.
6. Verify no secrets or unauthorized confidential material were added.
7. Commit/push durable changes when possible and report the final sync state plus the next action. If push fails, do not claim the close is fully synced.

Detailed command examples and behavior notes live in `docs/commands.md`; cross-client safety and Git decision rules live in `docs/workflow.md`.

## Risk-based safety gates

Use the smallest gate that matches the action:

- **Fast Read** — for read-only questions and ordinary project continuation: locate the real checkout, inspect branch/status, and read `STATUS.md` plus relevant open bugs. Do not run network sync, full-repository audits, or release checks unless the task needs them.
- **Write Gate** — before the first file modification: confirm the authorized file scope, preserve existing dirty changes, load the narrowest required Skill, and verify canonical freshness when stale remote state could affect the write.
- **Release Gate** — before commit, push, merge, PR, or `@D-AI close`: inspect the complete intended diff, run relevant tests and targeted validation, check staged files and secret-like additions, then verify the actual remote result after push.

Do not run Release Gate checks repeatedly during read-only work. A lower gate never authorizes an action that requires a higher gate.

## Progress checkpoints

Keep one replace-in-place current checkpoint in each active project's `STATUS.md`. Update it when a meaningful event changes the current task, working state, verified evidence, blocker, authorized file scope, active plan, or next action.

- Record the latest verified state and a short active plan; link to canonical decisions or bugs instead of copying them.
- Do not append a command-by-command log, full chat transcript, repeated unchanged state, or speculative reasoning.
- During the same session, do not reread unchanged context merely to reconstruct the plan. Continue from the current in-session state and refresh the checkpoint after meaningful change.
- On a new session, context compaction, client handoff, or uncertain state, read the checkpoint first and expand to other files only as needed.
- A checkpoint is a project-state summary, not a second memory source and not proof of remote synchronization.

## Session start

For ordinary read-only continuation, apply Fast Read. Before the first durable write, complete Write Gate:

1. Locate the actual Git checkout and inspect branch/status before using repository state as current evidence.
2. Read `README.md` when repository purpose, boundaries, or security rules are not already established.
3. Read only the discovery index needed to locate the relevant Skill, knowledge note, or project.
4. For project continuation, start with `STATUS.md` and relevant open entries in `BUGS.md`; read `README.md`, `DECISIONS.md`, `ROADMAP.md`, and `REFERENCES.md` only when the task requires their content.
5. Load the narrowest relevant canonical Skill under `skills/custom/` before modifying durable knowledge or project state.
6. Before writing, verify canonical freshness when stale remote state could cause conflicts. If freshness cannot be verified, state the limitation and fail closed.
7. Prefer repository state over old chat history when the repository contains the canonical answer.

## Canonical ownership

- Agent workflow instructions -> `skills/custom/`
- Agent discovery entry points -> `.agents/skills/`
- Durable reusable subject knowledge -> `knowledge/`
- Project-specific state and decisions -> `projects/<project>/`
- Stable cross-project context -> `memory/`
- Reusable standalone prompts -> `prompts/`
- Reusable content structures -> `templates/`
- Discovery only -> `indexes/`

Do not create duplicate canonical copies across these areas. Link to the canonical file instead.

## During work

- Search for an existing canonical file before creating a new one.
- Keep knowledge concise, source-aware, and easy to retrieve.
- Update relevant indexes when a canonical item is created, renamed, archived, or promoted to a key topic.
- Record non-obvious project/product/architecture choices in `DECISIONS.md`.
- Record current execution state and the next concrete action in `STATUS.md`.
- Record bugs only with observable symptoms; mark them resolved only after verification.
- Store reusable general knowledge in `knowledge/`, not inside one project unless the project-specific context is essential.
- Keep third-party Skill provenance under `skills/external/`; do not vendor upstream repositories by default.

## Security and privacy

Never commit:

- passwords or API keys;
- access tokens or session cookies;
- private certificates or secret environment files;
- authentication artifacts;
- unauthorized employer-confidential information;
- machine-specific secrets or credentials.

Machine-specific paths, transient commit SHAs, local snapshot hashes, and temporary environment details should not be treated as durable canonical knowledge unless there is a clear long-term reason to preserve them.

## Branch policy

- Small knowledge, index, status, and documentation updates may commit directly to `main`.
- Larger structural, automation, or code changes should use at most one working branch per task.
- Do not create speculative branches.

## Session close

Before ending meaningful work:

1. Update the active project's `STATUS.md` so another session can resume without chat history.
2. Record durable decisions, unresolved bugs, references, and roadmap changes where applicable.
3. Promote reusable knowledge to the appropriate `knowledge/` domain and update indexes when needed.
4. Remove or generalize stale machine-specific paths, transient SHAs, temporary snapshots, and one-session diagnostics unless they are still operationally relevant.
5. Verify that no secrets or unauthorized confidential material were added.
6. Commit/push durable changes when the environment permits it; otherwise state exactly what remains unsynced.

## D-AI-Hub project continuation

For work on D-AI-Hub itself, start at `projects/d-ai-hub/STATUS.md`, then follow the standard project read order above.
