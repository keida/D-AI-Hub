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

## 2026-08-21 — Make rollback explicit, durable, and fail-closed

**Context**

Rollback can change repository state and must remain safe across a fresh runtime, client handoff, or interrupted session.

**Decision**

Use an explicit zero-argument `@D-AI rollback` command for the active task. Require durable ownership, a matching RecoveryPoint and RecoverySnapshot, preservation of current user work, auditable Git `revert`/`apply` actions, and post-operation verification. Persist the resulting archive, actions, and verification as RollbackAudit. Missing or mismatched durable evidence returns `BLOCKED` and never guesses or silently recovers.

**Rationale**

This preserves user work, prevents accidental rollback during ordinary `continue`, and lets a fresh ChatGPT Web, Work, or Codex runtime make decisions from verified durable state rather than chat history.

**Consequences**

Rollback uses a new revert commit instead of rewriting history, so verification compares the restored tree and workspace state to the recovery point rather than requiring the HEAD SHA to be identical. The current V1.1 checkpoint remains local until explicitly integrated into canonical `main`.

**Revisit trigger**

Reconsider when a later checkpoint adds a formally versioned cross-client rollback protocol or a different repository recovery mechanism with equivalent preservation and verification guarantees.
