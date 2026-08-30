# Decisions

## 2026-08-23 — Supersede cross-environment delivery scope with Codex-first V1

**Context**

The approved 2026-08-21 v2 design remains the historical cross-environment architecture reference, but the current supported product boundary is narrower. The repository has a usable Codex local control layer, GitHub evidence/persistence seams, and Markdown project memory; no supported native Chat or Work activation connector is available.

**Decision**

D-AI V1 is Codex-first: Codex local control and execution, GitHub-backed durable evidence, and D-AI-Hub Markdown knowledge/project memory. ChatGPT Web is for ordinary discussion and viewing only; it is not required for runtime execution. Native Chat activation, native Work activation, the Work file-backed connector, Chat↔Work↔Codex automatic handoff, and cross-environment automatic routing are Future/Deferred rather than V1 requirements.

Keep the existing Chat and Work adapters, handoff envelope, and environment-routing contracts as reference seams. They must remain explicitly unsupported/deferred and fail closed whenever their connectors are unavailable; they must not imply product activation or allow a virtual capability to produce completion.

The V1 user-facing command set is `@D-AI continue`, `@D-AI status`, `@D-AI close`, and `@D-AI rollback`. Local durable state is authoritative for task identity and ownership; GitHub is authoritative for pushed evidence and exact remote repository/ref/SHA verification; Markdown project memory records durable project decisions and checkpoints.

This decision supersedes the delivery scope of the cross-environment V1 sections in `docs/specs/2026-08-21-d-ai-orchestrator-v2-design.md`, not the historical design or its contract definitions. The spec now carries a traceable scope note and keeps the deferred architecture visible.

**Rationale**

It makes the shipped product boundary honest and independently releasable while preserving the original architecture for a later, connector-backed expansion. It also prevents Chat/Work availability gaps from blocking Codex V1 or being mistaken for successful execution.

**Consequences**

Codex runtime, local durable state, GitHub evidence, and Markdown project memory are the only V1 delivery path. A positive close still requires the configured GitHub and repository evidence gates. Chat/Work contract tests may remain as compatibility coverage, but native activation and automatic cross-environment routing are not V1 acceptance criteria.

**Revisit trigger**

Revisit only after a supported external Chat or Work connector is available, its capability and ownership boundary is documented, and an independent acceptance review proves real activation without weakening fail-closed behavior.

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

## 2026-08-23 — Separate the four product layers and keep D-AI as the only control plane

**Context**

The orchestrator runtime accumulated substantial verified implementation, while project status still described the Markdown Hub and PR readiness as if they proved a usable user entry. The approved v2 specification requires one logical `@D-AI` entry across Chat, Work, and Codex, but explicitly allows platform-specific activation syntax.

**Decision**

Treat D-AI-Hub as four non-interchangeable delivery layers:

1. Markdown Hub owns canonical project/specification state.
2. The orchestrator runtime owns normalized lifecycle, routing, durable state, gates, handoff, recovery, rollback, and close verdicts.
3. Platform activation adapters translate a supported product invocation into the same raw logical `@D-AI` command and configured runtime.
4. Chat, Work, and Codex capability connectors perform environment-specific operations and must advertise unavailable behavior as `BLOCKED`.

Codex uses the user-discoverable `d-ai` Skill. Its user-facing form is `$d-ai @D-AI <command>`, with adapter-only `--task <task-id>` for explicit durable task selection in a fresh process. The `@D-AI` prefix remains a D-AI logical protocol and is not described as a Codex built-in command.

**Rationale**

This preserves the approved single-orchestrator design while preventing documentation, internal runtime tests, and platform availability from standing in for each other. Explicit task selection closes the fresh-process registry gap without changing the approved zero-argument logical `@D-AI close` command.

**Consequences**

Codex activation may be delivered before Chat and Work activation. Unconfigured execution, recovery, Git, GitHub, Chat, and Work capabilities remain fail-closed. A platform layer is not complete until its discoverable raw-command product boundary passes; runtime unit tests alone are insufficient.

**Revisit trigger**

Reconsider the Codex adapter syntax only if Codex provides an official native command registration mechanism that can preserve the same normalized command and hard-gate semantics.

## 2026-08-28 — Keep Memorix as an optional, guarded local memory adapter

**Context**

An isolated PoC of `AVIDS2/memorix` v1.8.3 demonstrated manual storage, local SQLite/Orama BM25 search, and JSON transfer of five synthetic structured records between two temporary profiles. It also showed that transfer export preserves secret-shaped content and that duplicate and fork imports are silently skipped without a conflict report. The PoC did not demonstrate native GitHub sync, manifest/hash, device identity, base-version, delta, or bidirectional conflict resolution.

**Decision**

Git/Markdown remains canonical. Memorix may be used only as an optional, pinned v1.8.3, per-workspace local index/cache; it is never an authority, sync engine, or replacement for D-AI-Hub records. Any future, separately authorized implementation must obey the following D-AI adapter contract; these are not current runtime capabilities. The adapter must disable hooks, LLM, embeddings, rerank, HTTP, Dashboard, Git/GitHub sync, and team/orchestration, and accept only manual, structured project records. D-AI must reject secret-shaped input before write or export and return redacted errors; it must never rely on Memorix export for secret removal.

Under that future D-AI adapter contract, D-AI, not Memorix, would own any versioned snapshot wrapper: bundle format, project scope, record count, content hash, snapshot lineage, and import receipt. These are adapter contract fields and do not claim native Memorix manifest/hash/device/version/GitHub-sync features. A future implementation would verify that wrapper before calling Memorix: an exact already-applied bundle would be `NOOP_DUPLICATE`; known-lineage changes to a logical record or incompatible same-topic branch would be `CONFLICT`; only unknown lineage would be `BLOCKED` for lineage, while invalid integrity/version/scope, unavailable capability, or unsafe content would remain `BLOCKED` for their respective reasons. No automatic merge, conflict resolution, network transfer, or Git action would be permitted.

**Rationale**

This retains the PoC-proven local search and manual portability while preserving Hub-first ownership and failing closed where Memorix did not provide integrity, secrecy, or conflict semantics.

**Consequences**

The adapter remains unimplemented until separately authorized. Any future implementation must keep Memorix data rebuildable and non-canonical, expose only D-AI-owned receipts/conflicts, and verify the contract with isolated profiles; it must not infer unproven native capabilities from the PoC.

**Revisit trigger**

Revisit after a disposable integration test proves the adapter-owned secret, bundle integrity/lineage, duplicate, and explicit conflict checks, or after a pinned upstream release demonstrably supplies the missing native capabilities without weakening this boundary.

## 2026-08-28 — Keep external routing optional and subordinate

> Superseded on 2026-08-29 only where this decision assigns complex escalation to Superpowers; see "Permanently disable Superpowers" below.

**Context**

D-AI-Hub needs lightweight provider routing while preserving one control plane and progressive Skill loading.

**Decision**

Keep D-AI-Hub as the authoritative control plane. Use native execution for trivial work, the narrowest routine engineering Skill for normal work, Superpowers for justified complex escalation, and proportional independent review/QA/security. Defer installing an external Router.

**Rationale**

The current instruction-based routing is sufficient for the active scope and avoids adding a second policy surface, runtime, or maintenance dependency. A future Router may shortlist Skills only and must not override D-AI-Hub safety, state, or release rules.

**Revisit trigger**

Reconsider when a candidate demonstrates materially lower context/tool overhead with active maintenance, Codex compatibility, cross-provider discovery, lazy loading, and low integration cost.

## 2026-08-28 — Add a separate local-memory sync boundary, not a general Memory Core

**Context**

The next authorized slice needs one writer to persist agent runtime memory locally, transfer it safely between computers through a private GitHub repository, and let a second computer read the same logical record. Existing `DurableContextStore` is lifecycle state for task ownership, handoff, recovery, rollback, and close; it is not a generic memory abstraction.

**Decision**

Introduce a new, separately named local-memory sync boundary. A configured writer stores structured records in local SQLite. It exports deterministic JSONL plus a versioned manifest into a Git-tracked bundle directory. A reader computer manually pulls that Git history, validates the bundle before any write, imports it into its own SQLite database, and retrieves records by the same logical ID.

The bundle identifies a portable logical scope, writer identity, sequence interval, record count, and SHA-256 digest. The first slice accepts one configured writer only. Reader-mode stores reject `put`; duplicate bundle imports return `NOOP_DUPLICATE`; mismatched scope, version, digest, writer, or same-ID different-content inputs return `BLOCKED`. Secret-shaped values are rejected before SQLite write and rechecked before export/import.

**Rationale**

This gives two devices a small, auditable, Git-versioned transfer loop without making an external memory product, a database, or GitHub transport the D-AI-Hub control plane. It reuses the existing manifest/hash, workspace-fencing, recovery, and GitHub identity-preflight patterns without coupling lifecycle task state to general memory records.

**Consequences**

`DurableContextStore`, `FileDurableContextStore`, lifecycle handoff, recovery, rollback, and close semantics remain unchanged. The initial implementation uses Node's built-in `node:sqlite`; it adds no external memory, vector, embedding, Router, dashboard, or automatic Git transport dependency. GitHub push/pull remains a manual operator action and no two devices may write in the first phase.

**Revisit trigger**

Reconsider the single-writer restriction only after a separately authorized design proves explicit writer election, conflict receipts, and multi-writer recovery behavior without automatic merges.

## 2026-08-29 — Accept isolated reader simulation for the first memory-transfer slice

**Context**

The first local-memory slice requires evidence for SQLite persistence, deterministic JSONL/manifest export, private-GitHub transport, integrity enforcement, duplicate handling, and same-ID reader retrieval. A real second physical computer was available only as a future operational check, while the current environment could create a fresh private-GitHub clone with an independent workspace and SQLite database and force Windows `core.autocrlf=true` behavior.

**Decision**

Accept the isolated reader clone as the phase-one device-B simulation and mark the implementation slice complete. The simulation must use the actual private-GitHub bundle commit, an independent checkout and database, reader mode with no `put`, exact manifest/JSONL digest validation, a first `IMPORTED` receipt, a repeated `NOOP_DUPLICATE` receipt, and same-logical-ID retrieval.

Do not describe this as evidence from a second physical computer. A future physical-device run is optional environment validation for credentials, installed tooling, filesystem behavior, and operator execution; it does not block the accepted implementation slice.

**Rationale**

The isolated clone exercises every implemented software and Git transport boundary while keeping the unverified hardware/environment distinction explicit. This closes the vertical slice without weakening the single-writer model or repeatedly re-testing already proven behavior.

**Consequences**

The first slice is complete at private `main` bundle commit `a156c2a0cfbb29424f7a7bf173d72a5a8e609093`. Automatic sync, merging, a second writer, external memory products, embeddings/RAG, Router expansion, and Dashboard work remain deferred and require separate authorization. Any later physical-device rehearsal records environment evidence only and must not rewrite the completed implementation result.

**Revisit trigger**

Revisit the acceptance level only if a later physical-device run exposes a reproducible repository-controlled defect rather than a machine-specific credential or tooling issue.

## 2026-08-29 — Require contiguous imports for the single-writer memory chain

**Context**

The accepted first transfer proved one complete bundle, but repeated manual transfers need an explicit ordering rule. Without it, a fresh reader could import a bundle beginning after sequence 1, or an existing reader could skip an unseen range while each individual bundle still passed its own manifest and digest checks.

**Decision**

For a configured scope and writer, every non-empty import must extend the reader's global sequence chain contiguously. A missing reader accepts a first sequence of 1. An initialized reader accepts a first sequence equal to its current maximum plus 1. Any gap or overlap returns `BLOCKED` without inserting records or an import receipt. Exact receipt identity remains higher priority and returns `NOOP_DUPLICATE`, including when replaying an older bundle after later bundles were applied. Empty-bundle behavior and manifest version 1 remain unchanged.

**Rationale**

This is the smallest fail-closed rule that prevents silent history omission during manual single-writer transfer while preserving deterministic duplicate handling and the existing bundle format.

**Consequences**

Operators must export subsequent bundles with `--after-sequence` set to the last verified imported `toSequence` and import them in order. This adds no Git automation, second writer, merge behavior, lineage graph, or manifest schema change.

**Revisit trigger**

Revisit only if a separately authorized multi-writer or out-of-order delivery design supplies explicit lineage, conflict receipts, and recovery semantics.

## 2026-08-29 — Permanently disable Superpowers

**Context**

The prior routing policy treated Superpowers as an optional escalation layer for complex or high-confidence engineering work. The user explicitly rejected that categorization and requested permanent removal because the extra workflow is unnecessary for the current way of working.

**Decision**

Disable Superpowers across D-AI-Hub. Remove its native discovery entry and do not invoke, rediscover, update, or reinstall it unless the user explicitly reverses this decision. Do not classify a task as needing a Superpowers escalation layer. Use native execution, D-AI-Hub custom Skills, the narrowest useful Matt Skill when one matches, and proportional independent review, QA, or security checks.

**Rationale**

The remaining workflow provides enough engineering discipline without a separate orchestration framework. Independent verification and review are confidence controls, not reasons to activate an additional provider.

**Consequences**

The earlier 2026-08-28 routing decision is superseded only where it assigns complex escalation to Superpowers. Historical provenance remains documented, but it is listed as disabled rather than active. An inert local checkout may remain to avoid destructive removal; it is not discoverable or authorized for use.

**Revisit trigger**

Re-enable only after a new explicit user instruction that reverses this permanent-disable decision.

## 2026-08-30 — Define index freshness as required catalog coverage

**Context**

The current repository health check verifies that tracked Markdown links resolve, but a newly added canonical Skill, knowledge domain, or project can remain undiscoverable when its owning index is not updated. Requiring every knowledge note to be indexed would conflict with the existing policy that only important notes need direct promotion.

**Decision**

Add a future read-only `index-freshness` health result that requires exactly one owning-index link for tracked canonical Skill entries, top-level knowledge domains, and non-template project directories with `STATUS.md`. Permit additional valid index links, including promoted knowledge notes. Keep active/planned/archived classification human-owned. Do not copy draft PR #3 code; implementation must use the current `runRepositoryHealthCheck` seam and requires separate authorization.

**Rationale**

Required catalog coverage detects actual discovery drift while preserving intentional editorial judgment inside the knowledge index. One unchanged external health-check interface keeps the module deep and prevents a second command or policy surface.

**Consequences**

The first implementation will expose the currently unindexed planned `d-ai-hub-v2` project and should repair `indexes/PROJECTS.md` explicitly. Index repair remains manual. Skill frontmatter, secret-like scanning, UTF-8, path, symlink, remote, and automation work remain separate candidates.

**Revisit trigger**

Revisit the target rules only if canonical ownership changes or section classification becomes machine-owned through a separately approved schema.
