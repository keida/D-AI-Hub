---
name: project-memory
description: Use when starting, resuming, updating, or closing a project in D-AI-Hub so project state is explicit and does not depend on old chat history.
---

# Project Memory

Maintain project continuity under `projects/<project>/`.

## Read order when resuming a project

1. `README.md` — purpose, scope, architecture, and repository links.
2. `STATUS.md` — current state, last completed work, immediate next action, blockers.
3. `DECISIONS.md` — architectural/product decisions that constrain future work.
4. `BUGS.md` — unresolved defects and verified fixes.
5. `ROADMAP.md` — planned milestones and deferred work.
6. `REFERENCES.md` — external references when needed.

Do not rely on previous chat history when these files can carry the state explicitly.

## Update workflow

After meaningful project progress:
1. Update `STATUS.md` with what changed, what is verified, current blockers, and the next concrete action.
2. Add durable product or architecture choices to `DECISIONS.md` with context and rationale.
3. Add newly discovered bugs to `BUGS.md`; mark fixed bugs resolved only after verification.
4. Update `ROADMAP.md` when scope, sequencing, or milestones change.
5. Add important source/document links to `REFERENCES.md` rather than scattering them across chat.
6. Update `indexes/PROJECTS.md` when a project is created, archived, renamed, or changes active status.

## Canonical ownership

- Current execution state -> `STATUS.md`
- Durable project decision -> `DECISIONS.md`
- Defect lifecycle -> `BUGS.md`
- Future work -> `ROADMAP.md`
- External links and source provenance -> `REFERENCES.md`
- General reusable subject knowledge -> `knowledge/`, not the project folder

## Failure modes and required response

### Stale status
If `STATUS.md` conflicts with recent verified work, update it before continuing. Never knowingly leave the next session with an obsolete status summary.

### Undocumented decision
If implementation depends on a non-obvious product or architecture choice, record it in `DECISIONS.md` before treating it as settled.

### Chat-history dependency
If the project can only be resumed by searching an old conversation, capture the missing durable state in the project files.

### Resolved bug left open
Only mark a bug resolved after evidence of verification is available. Record the verification briefly.

### Project knowledge duplicated into general knowledge
Keep project-specific context in the project. Promote only reusable, generalized knowledge to `knowledge/` and link back if useful.

### Secret/confidential content
Do not store credentials, tokens, cookies, or unauthorized employer-confidential material in project memory.

## Completion check

Before ending meaningful project work, confirm:
- `STATUS.md` reflects reality;
- decisions are recorded;
- unresolved bugs remain visible;
- roadmap reflects current scope;
- the next session can resume without relying on chat history.
