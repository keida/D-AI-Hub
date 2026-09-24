# Decisions

## 2026-09-24 — Define the project-owned result contract for DAI-ARCH-002

**Authority and boundary**

The D-AI-Hub Boss authorizes this consumer-side contract decision for DAI-ARCH-002. It does not authorize D-AI-Hub to accept work on behalf of another project, choose that project's artifact path, publish a result, or advance its durable task. Skill Pulse SP-OPS-006 is the acceptance case, not a source of automatic PASS. Publishing this decision to canonical `main` does not activate the runtime mechanism.

**Canonical location and immutable reference**

A typed result belongs in the execution project's own canonical Git repository, at a repository-relative path that its Project Boss has explicitly approved and registered for that project before D-AI consumption. D-AI-Hub does not impose or guess a Skill Pulse path. An intake request identifies the exact canonical repository identity, full publication commit SHA, registered artifact path, Git blob OID, and SHA-256 of the artifact bytes. The publication commit must be reachable through the project's approved canonical publication ref on its approved remote. A branch name, working-tree file, chat message, mutable URL, or D-AI copy is not the authoritative result. The containing commit reference is carried outside the artifact to avoid a self-referential hash. Corrections use a new immutable result and explicit supersession; the original remains auditable.

**Version 1 result envelope**

The project-owned JSON result has exact top-level `contract: "dai.project-result"` and `schemaVersion: 1`. Its machine-readable shape is [project-owned-result-v1.schema.json](contracts/project-owned-result-v1.schema.json). Required fields are `resultId`; `project.identity`, `project.workId`, and `project.executionOwnerId`; `dai.taskId`; `execution.verdict` (`PASS`, `FAIL`, or `BLOCKED`) and `execution.scope`; `acceptance.verdict` (`ACCEPTED` or `REJECTED`), `acceptance.authorityId`, `acceptance.acceptedScope`, and ISO-8601 `acceptance.acceptedAt`; `evidence.profile`, nonempty `evidence.refs` with unique IDs and typed immutable references/digests, and a profile-specific `evidence.case`. The initial v1 schema supports only `skill-pulse.sp-ops-006/v1`; another project profile requires a separately reviewed schema version and contract decision. Identity fields and accepted scope must be explicit, nonempty, and mutually consistent. An optional original execution/observation timestamp is distinct from `acceptedAt`. Version 1 rejects an unknown contract/version/profile and unknown verdicts; changing mandatory meanings requires a new version. The D-AI consumer must additionally enforce unique reference IDs, safe registered paths, real timestamp/HTTPS parsing, profile-specific relationships, and provider-specific immutability; JSON Schema `uniqueItems` and `format` annotations alone do not establish those facts or Boss authority.

For the `skill-pulse.sp-ops-006/v1` evidence profile, the typed case payload additionally requires `naturalSchedulerInstanceId`, `schedulerEvents[]` with both `eventId` and `recordId`, `runtimeLogSha256`, `snapshot.commitSha`, `snapshot.gitBlobOid`, `snapshot.gitBlobSha256`, `netlify.deployId`, `netlify.immutableManifestUrl`, `netlify.immutableManifestVerification`, and `netlify.productionAliasVerification` tied to the same acceptance run. Each verification result records what was checked and an immutable supporting reference. The project may include further evidence, but these fields cannot be replaced by a summary or chat assertion.

**Acceptance and publishing authority**

Only the project's declared Project Boss, operating through a verified bound Project Boss execution context for that project and task, may approve the result and authorize publication. The actual Git writer may be delegated only when the approval and delegated publication are auditable and bound to that authority. A string `ownerId`, caller-supplied `sourceEnvironment`, repository write access, Git commit/hash, or typed JSON alone proves neither Boss identity nor acceptance. Publication has two auditable steps: the Boss approves the result and any writer delegation before publication; after the commit exists, the Boss attests the exact published artifact. The trusted authority proof must bind the exact `resultId`, project/task IDs, publication commit, registered path, blob OID, and artifact SHA-256; it must be scoped, fresh, and replay-resistant. D-AI must durably record proof consumption or the equivalent replay-prevention state with the accepted handoff before acknowledging it. Wrong scope, changed artifact, replay, stale proof, or absent verified Boss origin blocks. This contract requires those verifiable properties but does not select a challenge, token, signature, RBAC, or other future identity mechanism.

**D-AI consumer verification**

The consumer first verifies the existing durable task and project identity, predeclared owner and registered path, verified Boss-origin authority proof, then the published commit, blob OID, exact artifact bytes and SHA-256. It validates version, all required fields, project/task/work IDs, accepted scope, timestamp, evidence profile, immutable references, and the relationship of evidence to the claimed run. It independently verifies referenced evidence and the project result. Missing, malformed, stale, conflicting, cross-project, unregistered, or unverifiable input fails closed without writing a successful handoff. Identical replay is idempotent; a conflicting result cannot replace an accepted result silently.

**Lifecycle reconciliation**

The project result is recorded as project-owned execution and acceptance, separate from D-AI-executed lifecycle stages. `PASS` plus `ACCEPTED` is necessary but not sufficient for D-AI verification or close. A dedicated guarded reconciliation operation records D-AI's own verification of authority, scope, provenance, evidence, and current task state; it must preserve the true prior stage and must not invoke ordinary `route → verify` or fabricate `plan`, `execute`, or `inspect`. Close is a separate explicit D-AI decision after successful reconciliation and all applicable close gates. The current runtime still requires `stage === verify` for close, so a legal project-owned reconciliation close predicate remains a future bounded implementation obligation; this decision does not make close available now. `FAIL`, `BLOCKED`, `REJECTED`, missing result, or failed verification leaves the task unclosed with a typed reason. Fresh recovery must expose the result reference, authority, verification outcome, and remaining task state without chat history.

**Historical work and current gate**

Already-completed work is not backfilled from chat or from D-AI's interpretation of engineering evidence. The Project Boss must re-evaluate the preserved immutable evidence, issue a typed retrospective result through the same authority and publication controls, record the actual new acceptance/publication time separately from the original run time, and publish it at its approved project-owned location. If any required evidence or authority is unavailable, the result remains absent and D-AI remains blocked. Skill Pulse task `task-7b959c2155241137b16a5220` stays at `route / unclosed`; do not rerun SP-OPS-006 or alter its production pipeline. The present Codex/D-AI runtime has no verified bound Project Boss caller identity primitive, so this contract does not yet authorize implementation activation, a Skill Pulse artifact, or lifecycle reconciliation. Resolve that trust prerequisite and obtain Skill Pulse Project Boss approval of its exact path before publication review of the mechanism.

The follow-up is split: **DAI-ARCH-002A — Trusted Project Boss Invocation** defines the smallest verifiable Boss-origin runtime trust primitive; **DAI-ARCH-002B — Skill Pulse Project-Owned Result Integration** lets the Skill Pulse Project Boss approve the exact path, publish the typed result with immutable evidence, and only then permit D-AI verification and reconciliation. Neither follow-up is implemented or authorized for activation by publishing this contract.

## 2026-09-24 — Honor Weekly Review natural-run freeze

**Authority**

The Weekly Review Project Boss confirmed `PAUSED / WAITING`, with the current project phase `CODEX-WEEKLY-008 — Natural Run Acceptance / PRE-TRIGGER FREEZE`. The project next action is to wait for the real Codex Scheduled trigger at 2026-09-27 16:00 Pacific/Auckland, then assess that natural-run evidence through the Weekly Review Project Boss. Durable task `task-97b1668e26b1fffb84d18050` remains the canonical resume anchor; its older `bootstrap / establish explicit curation` state is stale and lacks `phase,nextAction`.

**Decision**

Record `NO REPAIR — PROJECT PAUSED / WAITING FOR NATURAL TRIGGER`. Do not fill the durable `phase` or `nextAction` merely to make D-AI-Hub recovery report `COMPLETE`, manually trigger the run, change scheduler behavior, or modify the Weekly Review project while its pre-trigger freeze is in force. `INCOMPLETE: phase,nextAction` is currently expected for this owner-confirmed pause, not unresolved repair debt. Weekly Review Project Boss owns the natural-run acceptance. DAI-ARCH-002 architecture work may proceed independently after this documentation enters canonical main.

## 2026-09-24 — Honor DSH 2 paused project disposition

**Authority**

The DSH 2 Project Boss confirmed the project activity state is `PAUSED / WAITING FOR USER DECISION`, with no active execution objective and execution phase intentionally unset. The durable task `task-fb6d8a19f0beb3f467c1f424` remains the unique canonical resume anchor.

**Decision**

Record `NO REPAIR — PROJECT PAUSED / PHASE INTENTIONALLY UNSET` in the D-AI-Hub control plane. Do not write `phase = PAUSED`, infer a phase from the durable `bootstrap` stage, backfill a former phase, or mutate DSH 2 project files, state, task, or memory merely to obtain `COMPLETE`. DAI-ARCH-001 reporting `INCOMPLETE: phase` is expected for this owner-confirmed paused state; it does not indicate that the phase was lost.

**Resume condition**

The user chooses Quiet Bay, Bubble Port, Dive Chamber, Field Station, Sketch Workshop, or explicitly requests a new direction. Resume the same canonical task. The DSH 2 Project Boss then defines an explicit objective and execution phase before the canonical phase is updated and recovery completeness is rerun. Do not create a new task solely because the project resumes.

## 2026-09-22 — Accept Project-Owned Lifecycle Handoff as DAI-ARCH-002

**Context**

Skill Pulse project Boss independently accepted its natural production run, but D-AI-Hub's orchestration task `task-7b959c2155241137b16a5220` remains at `route`. The ordinary lifecycle correctly rejects `route → verify`; D-AI-Hub did not perform `plan`, `execute`, or `inspect`, so those stages cannot be recorded as if they occurred. This is one confirmed cross-project lifecycle blocker, not evidence that ordinary transitions should be relaxed.

**Decision**

Accept the bounded architecture ticket [DAI-ARCH-002 — Project-Owned Lifecycle Handoff](ROADMAP.md#dai-arch-002--project-owned-lifecycle-handoff-accepted-deferred). Its goal is an explicit, typed ingestion and reconciliation boundary for evidence from the declared project execution owner, preserving provenance, fail-closed behavior, idempotency, ordinary transitions, and the separation between project execution and D-AI-Hub orchestration. The implementation form remains open; this decision does not prescribe a stage, synthetic transition, event, or command.

Keep the Skill Pulse durable task and its `route` stage unchanged and unclosed, marked `BLOCKED — awaiting lifecycle handoff capability`. Do not start DAI-ARCH-002 implementation now. Complete P3, P4, and DAI-ARCH-001 publication in order; dispatch DAI-ARCH-002 only after DAI-ARCH-001 enters canonical main, from the then-current canonical base.

**Consequences**

Project Boss continues to own project-internal execution, review, and acceptance. D-AI-Hub retains the orchestration pointer and durable state without duplicating that execution. Neither project acceptance alone nor an arbitrary caller may close the D-AI-Hub task; the evidence and owner must pass the future handoff contract. Existing `route → plan → execute → inspect → verify` behavior is unchanged until a separately reviewed implementation is authorized.

**Revisit trigger**

Design and dispatch after DAI-ARCH-001 is canonical. Any broader lifecycle redesign or automatic project-result ingestion requires separate evidence and scope approval.

## 2026-09-04 — Separate privacy intent from live GitHub visibility

**Context**

The product boundary intends D-AI-Hub to remain private, while GitHub visibility, pull-request state, and branch protection are external live state that can change without a Markdown edit.

**Decision**

Keep privacy as a product/security requirement, but do not treat README, project Markdown, or historical acceptance language as proof of current GitHub visibility. Query GitHub before storing personal or otherwise private project context and before release decisions. If the repository is public, changing it to private is a user action; this decision authorizes no visibility mutation.

**Consequences**

Current checkpoints must avoid mutable PR numbers, proposal labels, and live visibility claims. Historical private-repository evidence remains preserved as historical evidence and must not be presented as current state.

## 2026-08-23 — Supersede cross-environment delivery scope with Codex-first V1

**Context**

The approved 2026-08-21 v2 design remains the historical cross-environment architecture reference, but the current supported product boundary is narrower. The repository has a usable Codex local control layer, GitHub evidence/persistence seams, and Markdown project memory; no supported native Chat or Work activation connector is available.

**Decision**

D-AI V1 is Codex-first: Codex local control and execution, GitHub-backed durable evidence, and D-AI-Hub Markdown knowledge/project memory. ChatGPT Web is for ordinary discussion and viewing only; it is not required for runtime execution. Native Chat activation, native Work activation, the Work file-backed connector, Chat↔Work↔Codex automatic handoff, and cross-environment automatic routing are Future/Deferred rather than V1 requirements.

Keep the existing Chat and Work adapters, handoff envelope, and environment-routing contracts as reference seams. They must remain explicitly unsupported/deferred and fail closed whenever their connectors are unavailable; they must not imply product activation or allow a virtual capability to produce completion.

The V1 user-facing entry is ordinary natural-language project requests, deterministically classified into discussion, status, continuation, bounded delivery, close, rollback, sync, or establish. An explicit `@D-AI` command remains the force/precision override and takes priority over surrounding text. Local durable state is authoritative for task identity and ownership; GitHub is authoritative for pushed evidence and exact remote repository/ref/SHA verification; Markdown project memory records durable project decisions and checkpoints.

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

At the time of this decision, Codex used the user-discoverable `d-ai` Skill with the user-facing form `$d-ai @D-AI <command>`, and adapter-only `--task <task-id>` for explicit durable task selection in a fresh process. That user-entry wording is partially superseded by the later natural-language-default acceptance: ordinary project language is now passed unchanged to the Skill/agent, while `@D-AI <command>` remains the force/precision override. The `@D-AI` prefix remains a D-AI logical protocol and is not described as a Codex built-in command.

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

## 2026-09-03 — Pin the CI reproducibility support baseline

**Context**

PR #28 verified a cross-platform CI matrix on Windows and Linux with Node 22.20.0 and 26.7.0, but its package metadata and README allowed or described a wider npm range than the evidence covered.

**Decision**

The supported reproducibility baseline is Node 22.20.0 and Node 26.7.0 on Windows and Linux, with npm 11.19.0 exact. `packageManager`, package and lockfile root metadata, README, and CI must state and use that same contract. Widening the supported Node or npm set requires new matrix evidence. The CI and structural-health boundaries remain verification seams; they do not change the Codex-first control-plane or project-memory ownership boundaries.

**Revisit trigger**

Revisit only with executed evidence for the proposed additional runtime or package-manager version and an explicitly reviewed support decision.

## 2026-09-03 — Validate declared project lifecycle and index consistency

**Context**

The 2026-08-30 index-freshness decision kept active/planned/archived classification human-owned and required separate authorization for implementation. The user later authorized this PR to add project-index lifecycle consistency checks, including conflicts such as an archived or superseded project listed under active projects.

**Decision**

Humans continue to declare each project's `Lifecycle` in `STATUS.md` and its owning section in `indexes/PROJECTS.md`. The read-only health check may validate that those declared values agree, and may report structured current-PR state contradictions, but it must never edit, reclassify, or infer either value from broad free text. This authorization reconciles the implementation with the earlier ownership boundary; it does not make classification machine-owned or waive human review of lifecycle changes.

**Revisit trigger**

Revisit only if a separately approved schema changes who owns lifecycle or index-section declarations.
