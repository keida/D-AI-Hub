# D-AI-Hub

GitHub-first personal AI operating system shared across ChatGPT Web, Codex, and other compatible agents, with a private-by-intent security boundary.

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
- `skills/custom/` — canonical user-authored Skill instructions and management notes.
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

Use for ordinary discussion and viewing/reviewing repository-hosted content. It is not a D-AI runtime.

### Codex

Use for repository maintenance, software development, testing, Git operations, local Agent Skills, structured project-memory updates, and skill optimization.

## D-AI V1 boundary

D-AI V1 is a Codex-first local control layer with GitHub-backed durable evidence and D-AI-Hub Markdown knowledge/project memory. ChatGPT Web remains available for ordinary discussion and viewing, but it is not required for the D-AI runtime.

Native Chat activation, native Work activation, the Work file-backed connector, automatic Chat↔Work↔Codex handoff, and automatic cross-environment routing are Future/Deferred. Existing contracts may remain for reference, but unavailable Chat/Work capabilities must fail closed and must not be presented as product activation.

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

Repository visibility is live GitHub state, not proof supplied by this file. Verify it before storing personal or otherwise private project context; if it is public, user action is required to make it private.

## Local repository health check

```text
npm run health-check -- --workspace <repository-path>
```

The Git identity, required-file, Markdown-link, and working-tree checks are local and do not modify the workspace or call Git remotes. The command also runs the workspace's own `typecheck`, `test`, and `test:integration` scripts; those execute arbitrary project code and may modify files or access the network. Use this command only with a trusted workspace. An initially dirty or script-modified working tree is reported as unhealthy. This command does not replace `@D-AI` lifecycle commands or release gates.

## Runtime and verification

The repository produces no distributable bundle; `typecheck` is the compile-time gate. The legacy `build` and `lint` scripts are compatibility aliases for `typecheck`, not separate build or lint stages. Supported, CI-verified runtimes are Node 22.20.0 and Node 26.7.0 with npm 11.19.0 and the committed lockfile.

```text
npm ci
npm run verify
```

`verify` runs type checking, ordinary tests, the serial integration suite, and repository structural validation. CI runs the same boundaries on Windows and Linux. The public D-AI Skill entry wrapper remains PowerShell-specific, so its product-boundary test runs on Windows; the remaining integration suite and an explicit `node:sqlite` smoke test run on both operating systems. `health-check:structural` omits package-script execution so CI can validate repository structure without recursively rerunning tests.

## V1 scope

V1 intentionally stays simple: Markdown, Agent Skills, indexes, templates, project memory, and external skill references. Vector databases, embeddings, RAG infrastructure, background ingestion, and automatic sync services are deferred until file-based retrieval proves insufficient.
