# Decisions

## 2026-08-20 — GitHub main is canonical

**Context**

D-AI-Hub must provide one durable source of truth across ChatGPT Web, Codex, and compatible agents.

**Decision**

Treat the private `keida/D-AI-Hub` GitHub repository, especially `main`, as canonical. Local checkouts are working copies and must be reconciled with GitHub before their state is treated as current.

**Rationale**

The repository README and design specification explicitly define a GitHub-first operating model and prevent diverging local knowledge bases.

**Consequences**

Local Git credentials and fetch verification are operational requirements. Connector-based reads may be used when local Git authentication is unavailable, but the limitation must remain visible.

**Revisit trigger**

Reconsider only if a deliberate replacement source of truth is designed, documented, and adopted across clients.

## 2026-08-20 — Keep knowledge, project state, Skills, and memory separate

**Context**

Mixing durable facts, workflow instructions, and current project state makes retrieval ambiguous and causes stale duplication.

**Decision**

Use `knowledge/` for reusable subject knowledge, `projects/<project>/` for project state, `memory/` for cross-project context, and Skills or `prompts/` for reusable instructions. Maintain indexes as links rather than duplicate content.

**Rationale**

This follows the canonical Knowledge Manager and Project Memory Skills and gives each durable item one obvious owner.

**Consequences**

Updates may touch a source file and its index together, but the same content should not be copied across categories.

**Revisit trigger**

Reconsider if real retrieval usage demonstrates that the boundaries cannot support the active workload.
