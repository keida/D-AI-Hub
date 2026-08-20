# D-AI-Hub Agent Bootstrap

This repository is the canonical source of truth for D-AI-Hub across ChatGPT Web, Codex, and compatible agents.

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
