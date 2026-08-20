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
- Local checkout: `C:\Users\User\Documents\ChatGPT\D-AI-Hub`
- Current local branch: `main`
- Current authenticated snapshot: remote commit `791114d50ba86857bbae4322af93831b03b2cbca`, tree `8a203f6900e4fa636297d418e6ecf320b29f1216`

## Current continuation entry point

Read `STATUS.md` first, then `DECISIONS.md`, `BUGS.md`, `ROADMAP.md`, and `REFERENCES.md`. For general repository rules, read the root `README.md`; for knowledge or project updates, follow the canonical Skills under `skills/custom/`.
