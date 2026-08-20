# D-AI-Hub

## Purpose

Maintain one private, GitHub-first source of truth for personal AI Skills, durable knowledge, project memory, prompts, templates, and discovery indexes.

## Scope

Included: Markdown documentation, Agent Skills entry points, custom and external Skill registries, knowledge domains, project continuation records, templates, indexes, and security guidance.

Excluded from V1: vector databases, embeddings, RAG infrastructure, web applications, background ingestion daemons, automatic sync services, and large third-party Skill copies.

## Architecture

- `.agents/skills/` provides Agent Skills-compatible entry points.
- `skills/custom/` contains canonical user-authored Skill instructions.
- `skills/external/` records third-party Skill provenance without vendoring source code.
- `knowledge/` stores durable subject knowledge.
- `projects/` stores project-specific continuation state.
- `memory/` stores durable cross-project context.
- `prompts/` and `templates/` store reusable interaction and content structures.
- `indexes/` provides human- and agent-readable discovery maps.

## Repositories / Environments

- Canonical repository: `https://github.com/keida/D-AI-Hub`
- Canonical branch: `main`
- Local checkouts are working copies and may live at different paths on different machines.
- A local checkout is current only after sync has been verified against the canonical repository. Do not preserve transient commit/tree identifiers here as durable state.

## Bootstrap

Agents should read the root `AGENTS.md` when entering this repository. It defines session-start, canonical ownership, security, branch, and session-close rules.

## Current continuation entry point

Read `STATUS.md` first, then `DECISIONS.md`, `BUGS.md`, `ROADMAP.md`, and `REFERENCES.md`. For general repository rules, read `AGENTS.md` and the root `README.md`; for knowledge or project updates, follow the canonical Skills under `skills/custom/`.
