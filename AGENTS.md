# D-AI-Hub Agent Bootstrap

This repository is the canonical source of truth for D-AI-Hub across ChatGPT Web, Codex, and compatible agents.

## D-AI Command Protocol

The following are D-AI-Hub natural-language commands. They are not built-in Codex commands. When the user's message begins with one of these exact prefixes, interpret it as the workflow below and then continue with any task text that follows the command.

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

Use before starting or resuming durable work.

1. Get the latest available `main` safely. With local Git, fetch/pull using authenticated access; otherwise use the authenticated repository source available in the environment.
2. If freshness cannot be verified, state that limitation before proceeding.
3. Read the relevant indexes and identify the narrowest relevant Skill, knowledge note, and/or project.
4. For a continuing project, read `README.md`, `STATUS.md`, `DECISIONS.md`, `BUGS.md`, `ROADMAP.md`, then `REFERENCES.md`.
5. Continue the user's task using repository state as canonical context instead of relying on old chat history.

### `@D-AI update`

Use to persist worthwhile information from the current session without ending the session.

1. Extract only durable knowledge, decisions, verified project state, useful references, and other information that has long-term retrieval value.
2. Exclude transient conversation, speculation presented as fact, secrets, credentials, authentication artifacts, and unauthorized confidential material.
3. Search for an existing canonical file before creating anything new; update instead of duplicating.
4. Route content to the canonical owner:
   - workflow instructions -> `skills/custom/`
   - reusable subject knowledge -> `knowledge/`
   - project-specific state/decisions/bugs/roadmap/references -> `projects/<project>/`
   - stable cross-project context -> `memory/`
   - reusable standalone prompt -> `prompts/`
5. Update relevant indexes when discovery state changes.
6. Verify the resulting content is internally consistent and source-aware.
7. Commit/push small durable updates when the environment permits it; otherwise report exactly what remains local/unsynced.

### `@D-AI close`

Use at the end of meaningful work.

1. Perform the `@D-AI update` workflow for all durable outcomes from the session.
2. For each active project touched, ensure `STATUS.md` reflects verified reality and contains the next concrete action.
3. Record non-obvious durable decisions in `DECISIONS.md`; keep unresolved bugs visible in `BUGS.md`; update `ROADMAP.md` and `REFERENCES.md` when applicable.
4. Promote reusable knowledge out of project notes into the appropriate `knowledge/` domain only when it is genuinely reusable; link rather than duplicate.
5. Remove or generalize stale machine-specific paths, transient SHAs/snapshot hashes, and one-session diagnostics unless still operationally relevant.
6. Verify no secrets or unauthorized confidential material were added.
7. Commit/push durable changes when possible and report the final sync state plus the next action. If push fails, do not claim the close is fully synced.

Detailed command examples and behavior notes live in `docs/commands.md`.

## Session start

Before doing durable work in this repository:

1. Confirm you are using the latest available `main` state. If local Git access is available, fetch/pull safely before treating the checkout as current. If sync cannot be verified, state the limitation instead of assuming freshness.
2. Read `README.md` for repository purpose, boundaries, and security rules.
3. Read the relevant discovery indexes:
   - `indexes/SKILLS.md`
   - `indexes/KNOWLEDGE.md`
   - `indexes/PROJECTS.md`
4. Load the narrowest relevant canonical Skill under `skills/custom/` before modifying durable knowledge or project state.
5. When continuing a project, read its files in this order:
   - `README.md`
   - `STATUS.md`
   - `DECISIONS.md`
   - `BUGS.md`
   - `ROADMAP.md`
   - `REFERENCES.md`
6. Prefer repository state over old chat history when the repository contains the canonical answer.

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
