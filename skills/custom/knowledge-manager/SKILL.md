---
name: knowledge-manager
description: Use when durable information should be captured, classified, normalized, linked, indexed, retrieved, or cleaned up inside D-AI-Hub. Do not use for transient chat, secrets, credentials, or project-only state that belongs under projects/.
---

# Knowledge Manager

Manage durable knowledge in `D-AI-Hub` without turning the repository into an unstructured dump.

## Core workflow

When capturing knowledge:
1. Decide whether the information is durable. If it is temporary, do not store it.
2. Reject secrets, credentials, authentication artifacts, and unauthorized confidential material.
3. Decide whether the information is general knowledge or project-specific state. Project-specific state belongs under `projects/`, not `knowledge/`.
4. Choose the narrowest appropriate domain under `knowledge/`: `ai/`, `data/`, `development/`, `banking/`, or `career/`.
5. Search for an existing canonical note before creating a new one.
6. If an existing note covers the topic, update it instead of creating a duplicate.
7. Normalize the content into concise Markdown: summary first, then durable facts, decisions, examples, and source links where useful.
8. Link related notes using repository-relative links.
9. Update `indexes/KNOWLEDGE.md` when the note becomes important enough to discover directly.
10. Preserve source provenance. Link to sources rather than copying large third-party passages.

When retrieving knowledge:
1. Start with `indexes/KNOWLEDGE.md`.
2. Follow the narrowest relevant domain.
3. Prefer canonical notes over repeated summaries in project or prompt files.
4. If two notes conflict, surface the conflict instead of silently choosing one.
5. If information appears stale, mark it for review rather than presenting it as current.

## Storage rules

- One durable fact or concept should have one canonical home.
- Indexes link to knowledge; they do not duplicate full knowledge.
- Prompts contain reusable instructions, not factual reference material.
- Memory contains cross-project context, not general subject knowledge.
- Projects contain project status and project-specific decisions.

## Failure modes and required response

### Duplicate knowledge
If an existing note already covers the subject, update and link it. Do not create a parallel note merely because wording differs.

### Ambiguous storage location
Choose based on scope:
- reusable subject knowledge -> `knowledge/`
- one project's state or decision -> `projects/<project>/`
- stable cross-project context -> `memory/`
- reusable instruction -> `prompts/` or a Skill
If ambiguity remains, ask before writing.

### Secret or credential capture
Do not store it. State that D-AI-Hub must not contain secrets and recommend an approved secret manager instead.

### Unauthorized employer-confidential material
Do not copy it into D-AI-Hub. Keep only non-confidential personal learning or an abstract note that does not reveal protected information.

### Over-copying a source
Summarize in your own words and preserve a source link. Do not paste long copyrighted source text into the knowledge base.

### Stale indexes
Whenever a canonical note is moved, renamed, or promoted to a key topic, update the relevant index in the same change.

## Completion check

Before claiming a knowledge update is complete, confirm:
- canonical location is correct;
- no duplicate was introduced;
- no secret/confidential material was stored;
- related links are valid in intent;
- relevant index entries are current.
