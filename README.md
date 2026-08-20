# D-AI-Hub

Private, GitHub-first personal AI operating system shared across ChatGPT Web, Codex, and other compatible agents.

## What belongs here

- **Skills** — how agents should work.
- **Knowledge** — durable subject knowledge.
- **Projects** — current project state, decisions, bugs, and roadmaps.
- **Memory** — durable cross-project context.
- **Prompts** — reusable prompts that are useful outside a specific skill.
- **Templates** — repeatable Markdown structures.
- **Indexes** — human- and agent-readable discovery maps.

GitHub is the canonical source of truth. ChatGPT Web and Codex should both read from this repository rather than maintaining separate knowledge bases.

## Repository map

- `.agents/skills/` — Agent Skills-compatible entry points.
- `skills/custom/` — documentation and management notes for user-authored skills.
- `skills/external/` — references to third-party skills without copying upstream code.
- `knowledge/` — durable knowledge by domain.
- `projects/` — project-specific working memory.
- `memory/` — cross-project durable context.
- `prompts/` — reusable prompts.
- `templates/` — reusable Markdown templates.
- `indexes/` — discovery indexes.
- `docs/superpowers/` — design specs and implementation plans.

## Operating model

### ChatGPT Web

Use for discussion, planning, lightweight skill use, knowledge capture, and reviewing repository-hosted context.

### Codex

Use for repository maintenance, software development, testing, Git operations, local Agent Skills, structured project-memory updates, and skill optimization.

## Core rules

1. Keep this repository private.
2. Prefer Markdown over proprietary formats for durable knowledge.
3. Store one canonical copy of durable information and link to it from indexes.
4. Do not copy third-party skill repositories into this hub unless a deliberate local fork is required.
5. Never commit credentials or secrets.
6. Do not depend on old chat history for active project state; update project files instead.
7. One task uses at most one working branch. Small knowledge/content updates may commit directly to `main` after V1 is merged.

## Security

Never commit passwords, API keys, access tokens, private certificates, authentication cookies, secret environment files, or unauthorized employer-confidential data.

## V1 scope

V1 intentionally stays simple: Markdown, Agent Skills, indexes, templates, project memory, and external skill references. Vector databases, embeddings, RAG infrastructure, background ingestion, and automatic sync services are deferred until file-based retrieval proves insufficient.
