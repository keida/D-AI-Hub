# References

## Canonical repository

- Title: D-AI-Hub
- URL / repository path: `https://github.com/keida/D-AI-Hub`
- Why it matters: canonical private source for Skills, knowledge, project memory, prompts, templates, and indexes.
- Accessed / reviewed: 2026-08-20
- Canonical branch: `main`.

## Local checkout

- Title: D-AI-Hub local working copy
- URL / repository path: environment-specific local checkout
- Why it matters: local filesystem used by Codex or another compatible agent for reading context and maintaining repository state.
- Accessed / reviewed: 2026-08-20
- Local note: local paths and transient snapshot identifiers differ by machine and are intentionally not stored as canonical project state. Verify sync against GitHub before treating a checkout as current.

## Repository guidance

- Title: D-AI-Hub Agent Bootstrap
- URL / repository path: `AGENTS.md`
- Why it matters: defines session-start, canonical ownership, security, branch, and session-close rules for agents.
- Accessed / reviewed: 2026-08-20

- Title: D-AI-Hub Cross-Client Workflow
- URL / repository path: `docs/workflow.md`
- Why it matters: defines safe sync, dirty/diverged checkout handling, Web/Codex coordination, push failure reporting, and completion evidence.
- Accessed / reviewed: 2026-08-20

- Title: D-AI-Hub README
- URL / repository path: `README.md`
- Why it matters: defines the GitHub-first model, directory ownership, privacy rules, and V1 scope.
- Accessed / reviewed: 2026-08-20

- Title: D-AI-Hub design specification
- URL / repository path: `docs/superpowers/specs/2026-08-20-d-ai-hub-design.md`
- Why it matters: defines the architecture, cross-environment workflow, Skill strategy, security boundaries, and success criteria.
- Accessed / reviewed: 2026-08-20

- Title: D-AI-Hub V1 implementation plan
- URL / repository path: `docs/superpowers/plans/2026-08-20-d-ai-hub-v1-foundation.md`
- Why it matters: records the intended V1 foundation tasks and verification expectations.
- Accessed / reviewed: 2026-08-20

- Title: Approved D-AI Orchestrator v2 design specification
- URL / repository path: `docs/specs/2026-08-21-d-ai-orchestrator-v2-design.md`
- Why it matters: approved product baseline for the single D-AI control plane, logical global entry, Chat/Work/Codex routing and handoff, durable recovery, hard verification, and close verdict.
- Provenance: copied byte-for-byte from the approved untracked design artifact in the legacy orchestrator worktree; both artifacts verified at SHA-256 `5224053CC37E695EC6A0C8047E2AEFBBC836FEFF8D826847FF0518AAF10BCB4F` on 2026-08-23.

- Title: D-AI Codex activation Skill
- URL / repository path: `skills/custom/d-ai/SKILL.md`
- Why it matters: canonical user-discoverable Codex activation instructions and real platform syntax for logical `@D-AI` requests.
- Compatibility entry: `.agents/skills/d-ai/SKILL.md`.

## Skill sources

- `skills/custom/knowledge-manager/SKILL.md` — canonical durable-knowledge capture and retrieval workflow.
- `skills/custom/project-memory/SKILL.md` — canonical project continuation and update workflow.
- `skills/custom/d-ai/SKILL.md` — canonical Codex activation entry for logical D-AI commands.
