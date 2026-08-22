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
## 2026-08-22 — Match safety work to the risk of the next action

**Context**

Ordinary project continuation already causes Codex to load local repository context. Repeating full synchronization, repository-wide audits, and release checks during read-only work adds time and token cost without proving additional runtime behavior.

**Decision**

Use three safety gates: Fast Read for read-only continuation, Write Gate before the first file modification, and Release Gate before commit, push, merge, PR creation, or close. Treat `@D-AI sync` as an optional explicit canonical-freshness check rather than a prerequisite for normal continuation.

**Rationale**

Risk-based gates preserve fail-closed Git behavior while avoiding repeated high-cost checks when no write or release action is planned. They also separate local context loading from verified GitHub synchronization.

**Consequences**

Agents must state whether remote refs were refreshed and must not claim canonical synchronization from local reads or cached refs. Full diff, test, secret, staging, and remote verification belongs at Release Gate, not Fast Read.

**Revisit trigger**

Reconsider if the manual behavior matrix shows that a client cannot reliably distinguish these gates or if real usage data shows that the lighter Fast Read omits required project context.

## 2026-08-22 — Keep one replace-in-place project progress checkpoint

**Context**

Repeatedly rereading old chat, unchanged project files, and previous plans adds time and token cost. A chronological activity log would create a second history to maintain and would quickly become stale.

**Decision**

Keep one concise current checkpoint inside each active project's canonical `STATUS.md`. Replace it after meaningful changes to the task, working state, verified evidence, blocker, authorized scope, active plan, or next action. Reuse already loaded state during an uninterrupted session and read the checkpoint first after a new session, compaction, or client handoff.

**Rationale**

A replace-in-place checkpoint makes the latest resume state directly discoverable without duplicating canonical decisions, bugs, roadmap, references, or full conversation history.

**Consequences**

The checkpoint must distinguish verified, local, remote, reported, and unverified state. It links to canonical detail rather than copying it, and it must not become a command log, chat archive, or second memory source.

**Revisit trigger**

Reconsider if five measured project resumptions show that the checkpoint is still too large, omits required context, or fails to reduce repeated reads.

## 2026-08-22 — Use progressive project-memory loading for ordinary continuation

**Context**

The fixed six-file project read order caused narrow continuation tasks to reread unchanged context. RED pressure scenarios confirmed that a focused BUG-002 check needed only current status, the matching bug entry, and directly referenced workflow files.

**Decision**

Start ordinary project continuation with `STATUS.md`, then load the task-matching project file and directly referenced files. Reserve the complete project read order for close, status conflicts, full audits, or explicit complete-context requests.

**Rationale**

This reduces repeated reads and token use while keeping canonical project state, explicit expansion rules, and full-context recovery available when risk requires it.

**Consequences**

The canonical `project-memory` Skill is the owner of the progressive read contract. The `.agents/skills/` entry point remains a compatibility pointer. Agents must report skipped files when that affects recovery confidence and must not create a second memory source.

**Revisit trigger**

Reconsider after measuring at least five real project resumptions or if a client demonstrates that the conditional read rules omit required context.
