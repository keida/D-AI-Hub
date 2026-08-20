# D-AI-Hub Operating Model

- Domain: ai
- Status: verified
- Last reviewed: 2026-08-20
- Source: repository README, design specification, indexes, custom Skills, and authenticated GitHub main snapshot

## Summary

D-AI-Hub is a private, GitHub-first personal AI operating system shared across ChatGPT Web, Codex, and other compatible agents. GitHub is the canonical source of truth; local checkouts are working copies used for repository maintenance and local Skill discovery.

## Key points

- Skills define how agents should work. `.agents/skills/` contains Agent Skills-compatible entry points; the canonical user-authored Skill files live under `skills/custom/`.
- Durable subject knowledge belongs under the narrowest domain in `knowledge/` and is discovered through `indexes/KNOWLEDGE.md`.
- Project state belongs under `projects/<project>/` and is resumed from `README.md`, `STATUS.md`, `DECISIONS.md`, `BUGS.md`, `ROADMAP.md`, then `REFERENCES.md`.
- Cross-project durable context belongs under `memory/`; reusable instructions belong under Skills or `prompts/`.
- Third-party Skills are registered under `skills/external/` rather than copied into the hub by default.
- V1 is intentionally Markdown-first and excludes vector databases, embeddings, RAG infrastructure, background ingestion, and automatic sync services.
- Never store passwords, API keys, access tokens, certificates, cookies, secret environment files, or unauthorized confidential material.

## Retrieval and update rule

Start with the relevant index, follow the canonical file boundary, update the source-of-truth file, and keep related indexes current. Record uncertainty or stale external state instead of silently presenting it as current.

## Related notes

- [Knowledge Index](../../indexes/KNOWLEDGE.md)
- [Project Index](../../indexes/PROJECTS.md)
- [Knowledge Manager Skill](../../skills/custom/knowledge-manager/SKILL.md)
- [Project Memory Skill](../../skills/custom/project-memory/SKILL.md)
- [Repository README](../../README.md)

## Review trigger

Review this note when the repository structure, canonical sync method, Skill discovery mechanism, or V1 scope changes.
