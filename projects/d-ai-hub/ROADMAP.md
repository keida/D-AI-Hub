# Roadmap

## Completed prerequisite publication chain

- P2 authoritative rebuild, P3 local-only identity, P4 Boss recovery, and their bounded repairs are `PUBLISHED / CANONICAL`.
- DAI-ARCH-001 recovery completeness is `PUBLISHED / CANONICAL`. DSH 2 and Weekly Review retain owner-confirmed paused dispositions; neither is repaired to force completeness.
- DAI-ARCH-002 HUMAN-CONFIRMED handoff is `PUBLISHED / CANONICAL`. Skill Pulse has a verified project-owned handoff, while its durable task remains open at `route` and is not close-eligible on the current evidence. Runtime/global binding activation and HOST-ATTESTED authority remain separate, unimplemented work.

<a name="dai-arch-002--project-owned-lifecycle-handoff-accepted-deferred"></a>

## DAI-ARCH-002 — Project-Owned Lifecycle Handoff (published)

**Status.** HUMAN-CONFIRMED contract and bounded handoff mechanism `PUBLISHED / CANONICAL`; HOST-ATTESTED remains deferred. The published mechanism is not a global runtime binding activation or task close decision.

**Problem.** The ordinary D-AI-Hub lifecycle assumes D-AI-Hub performs `route → plan → execute → inspect → verify`. A separately owned project can complete execution and acceptance while its D-AI-Hub orchestration task remains at `route`. The Skill Pulse project Boss accepted SP-OPS-006 after a natural production run, yet D-AI-Hub correctly rejected direct `route → verify` for task `task-7b959c2155241137b16a5220`. Inventing unperformed stages would falsify the durable lifecycle.

**Goal.** Reconcile a project-owned execution result through an explicit D-AI-Hub handoff while preserving the ordinary lifecycle and the project Boss ownership boundary. Implementation design may choose the smallest correct representation; a new stage, synthetic transitions, special event, or command is not prescribed.

**Acceptance criteria**

1. Reconciliation binds the typed project-owned result to the task's declared project execution owner and exact immutable evidence, under the separately verified HUMAN-CONFIRMED authority mode; it does not claim HOST-ATTESTED Boss identity.
2. The handoff is typed and explicit; an ordinary `verify` transition or arbitrary caller cannot bypass lifecycle gates.
3. The durable result distinguishes D-AI-executed stages, project-owned execution and acceptance, and D-AI-Hub orchestration reconciliation without recording unperformed `plan`, `execute`, or `inspect` stages.
4. Replaying an identical accepted handoff is idempotent: it neither closes the task twice nor creates a second authoritative result. Conflicting replays fail closed.
5. Missing, unverifiable, or mismatched owner/evidence fails closed without advancing stage or closing the task.
6. A project Boss result is required before reconciliation. PASS or explicit closure is necessary but not alone sufficient to close; a defect result remains visible and cannot close the orchestration task automatically.
7. Existing ordinary lifecycle transitions and their fail-closed rejection behavior remain unchanged, with regression evidence for both paths.
8. A fresh recovery exposes the reconciled owner, provenance, result, and remaining lifecycle state without relying on chat history or unrelated project data.

**Current case.** Skill Pulse task `task-7b959c2155241137b16a5220` remains open at `route`. The published project-owned result and HUMAN-CONFIRMED handoff are bound to this task, with disposition `HANDOFF_VERIFIED_AWAITING_CLOSE_DECISION`. Its historical objective and completion criteria remain unknown, so handoff acceptance does not establish close eligibility. D-AI-Hub does not rerun SP-OPS-006 or alter Skill Pulse production files.

**Publication boundary.** P3 → P4 → DAI-ARCH-001 prerequisites and the HUMAN-CONFIRMED handoff are canonical. Any further close or host-attestation work needs its own bounded decision.

## DAI-ARCH-003 — Routable Task Succession (design candidate)

**Status.** `DESIGN ACCEPTED / READY FOR BOUNDED IMPLEMENTATION`; implementation is not started. The 2026-09-25 Skill Pulse Project Boss governance decision is forward-looking: task `task-7b959c2155241137b16a5220` remains open at `route` as a historical recovery/evidence anchor, but is `LEGACY_FROZEN`, receives no new work, and is not the current resume anchor. Its original completion criteria remain unknown. This ticket does not write that disposition into durable task state or create a successor.

**Problem.** Current discovery selects every non-closed task in a workspace, while default establish/status/continue and Boss startup assume exactly one matching open task. Per-task active generation pointers and per-task atomic creation do not represent a project-level current task. An open frozen historical task therefore blocks a later, explicitly chartered current task.

**Bounded model.** Add a typed routing/governance disposition independent of project phase and lifecycle stage: `ROUTABLE` (current), `PAUSED_RESUMABLE` (current resume anchor, with no active execution), or `LEGACY_FROZEN` (explicit-ID historical inspection only). Preserve old durable records without backfill by treating an absent disposition as routable during migration; never infer frozen or paused from `bootstrap`, `route`, missing phase, or task age. An explicit frozen change needs an auditable owner decision, effective time, project/task binding, and reason. It must not change `goal`, `stage`, close state, or the project-owned handoff.

**Selection and pointer.** Keep full, integrity-checked discovery of all open tasks. Derive the default current pointer from exactly one task with a routable or paused-resumable disposition for the exact canonical project, workspace, and environment. Zero eligible tasks means no default resume target; multiple eligible tasks or identity conflicts fail closed. A frozen task stays addressable by exact task ID for read-only recovery and project-owned audit, but normal establish/continue/status/Boss startup must not select it as the current task. A current runtime registry pointer must be invalidated when its task becomes frozen. Do not turn the per-task active generation pointer into a project pointer or silently rewrite it.

**Successor gate.** Only an expressly approved new task charter may create a successor while a frozen task remains open. The charter must bind canonical project identity, explicit objective, owned/excluded scope, completion criteria, termination condition, initial phase/state where applicable, and initial canonical nextAction. Do not derive these from the legacy task or from a free-form `establish` keyword. Use the existing bootstrap state creation with a distinct stable charter/task identity; configured local-only reservation must not reuse the frozen task ID. A project-scoped cross-runtime election/ownership guard must recheck eligible tasks, publish one new task, then verify a single eligible result. Per-task `createIfAbsent` and in-process workspace serialization alone cannot provide this cross-task guarantee. Any valid in-progress publication must use the bounded P3R initialization-aware path; malformed or stale partial state still fails closed.

**Implementation seam.** Expected narrow modules: `src/domain/types.ts` for the typed disposition; `src/state/file-durable-context-store.ts` and `src/state/durable-context-store.ts` for strict persisted validation and project-scoped election; `src/runtime/d-ai-runtime.ts` for current-task selection, explicit-ID read-only fencing, and Boss startup selection; `src/bootstrap/bootstrap-task.ts` for a distinct charter-bound successor ID. Only add an entry/parser change if the approved charter cannot enter through an existing typed request. Keep ordinary lifecycle transitions, recovery-completeness checks, P4 presentation, and the DAI-ARCH-002 project-owned audit unchanged.

**Recovery and regression.** Explicit frozen-task recovery reports open status, `LEGACY_FROZEN`, not-current-anchor, no task-owned nextAction, unresolved historical scope, and its existing project-owned handoff/audit by exact task ID. Keep DAI-ARCH-001 completeness unchanged; an incomplete historical task stays incomplete. Default recovery targets the sole eligible task and remains blocked if none or ambiguous. DSH 2 and Weekly Review remain paused but resumable under their existing task IDs, with their present incompleteness unchanged. Ordinary one-task projects keep reuse behavior. Concurrent successor establishment must converge on one new eligible task across independent runtimes, with no duplicate and no regression in P3R/P3R-T1 local-only initialization behavior.

**Excluded.** No Skill Pulse successor or close, no reassignment of PROD/PERF work, no lifecycle/identity/completeness redesign, no project-owned handoff migration, no general task scheduler, and no runtime/global binding activation.

## Now — Codex-first D-AI V1 (accepted)

0. Deliver the visible automation MVP: classify ordinary natural-language requests deterministically, preserve explicit `@D-AI` command priority, keep discussion/status read-only, and expose bounded delivery only through explicit dependency and publication-authority seams.
1. Keep the superseding Codex-first scope decision in `projects/d-ai-hub/DECISIONS.md` and retain the 2026-08-21 v2 document as a traceable historical/future architecture reference.
2. Deliver and verify one Codex local control path through the canonical `d-ai` Skill, raw-command CLI, workspace-scoped durable task discovery, ownership fencing, verification gates, recovery, rollback, and close.
3. Use local durable state for task identity, ownership, context, and audit manifests; use the configured GitHub adapter for push evidence and exact remote repository/ref/SHA verification.
4. Keep Markdown project memory (`STATUS.md`, `DECISIONS.md`, `ROADMAP.md`, and related records) as the durable human/agent project source of truth.
5. Preserve the daily user commands `@D-AI continue`, `@D-AI status`, `@D-AI close`, and `@D-AI rollback`; zero/ambiguous/mismatched identity and unavailable connector cases remain fail closed.
6. Keep the separately bounded local-memory sync slice within its verified single-writer and manual-transport boundary; any expansion requires a new scope decision.

## Current authorized follow-up

- Canonical truth cleanup completed: the project checkpoint is concise, the superseded D-AI-Hub V2 implementation plan is archived, project continuation follows progressive loading, and repository health checks cover project lifecycle/index consistency.
- Default handoff safety completed.
- CI/reproducibility implemented.
- Current milestone: visible natural-language automation MVP; live PR/CI status remains a GitHub query.
- Repository visibility, PR/CI, branch protection, and remote freshness remain live external evidence; do not copy mutable values into this roadmap.
- Actor/session ADR remains Proposed/Deferred; runtime implementation is not authorized by that proposal.

## V1 product boundary

- **Codex local control:** required and supported. It owns local repository/workspace inspection, bounded execution, tests, Git operations, recovery, rollback, and local evidence collection through the configured runtime.
- **GitHub evidence:** required where the close gate applies. Push success and exact remote repository/ref/SHA verification are evidence, not assumptions; missing credentials or remote proof remains `BLOCKED`/`NO`.
- **D-AI-Hub Markdown knowledge/project memory:** required. It records canonical decisions, current checkpoints, roadmap, bugs, references, and reusable project context.
- **ChatGPT Web:** ordinary discussion and viewing only; not a V1 runtime dependency.
- **Native Chat and Work activation:** Future/Deferred. Existing adapter and handoff/routing contracts remain reference seams and fail closed without supported connectors.

## Completed on the active implementation line

- Ownership fencing, atomic initial persistence, handoff restart reconciliation, partial rollback audit persistence, credential/quoted-secret rejection, and URL credential redaction.
- Raw Codex command parsing into the existing runtime.
- Deterministic natural-language intent classification for discussion, status, continuation, delivery, close, rollback, sync, and establish, with explicit `@D-AI` priority.
- Thin delivery orchestration seam with context/workspace/implementation/verification/publication/CI/review-packet dependencies, stage timings, explicit publication authority, and a review-ready Delivery Result that always reports merge as `NO`.
- Read-only discussion and status paths that do not create or mutate durable task state; ambiguous natural language fails closed to read-only handling.
- Fresh-runtime workspace-scoped durable task selection for active-state commands.
- Canonical repository Skill source, compatibility entry, CLI, and external-workspace activation tests.
- Negative close-path acceptance for missing task, dirty worktree, missing credentials, and remote SHA mismatch.
- Fresh positive close-path acceptance at the then-private remote whose runtime close response returned `Safe-to-delete: YES`, with normal workspace-scoped discovery, durable context, recovery, private remote identity, successful push, exact remote SHA verification, and clean-worktree enforcement.
- Lightweight engineering routing documented; selected Matt Skills remain available through native discovery, Superpowers is permanently disabled and absent from native discovery, and no independent external or general-purpose Router runtime is installed.
- Single-writer local-memory transfer slice: local SQLite `put/get`, deterministic JSONL/manifest export, explicit `put|get|export|import` CLI, and the manual private-GitHub operator runbook are implemented and accepted. The historical Device A rehearsal pushed an exact two-file bundle commit to the then-private `main`; an isolated reader clone with a separate workspace/SQLite database and `core.autocrlf=true` verified the pulled digest, `IMPORTED`, `NOOP_DUPLICATE`, and same-ID read without writer access. Subsequent non-empty bundles must now extend the reader's sequence chain exactly; missing ranges and overlaps fail closed without records or receipts, while exact old/new replays remain `NOOP_DUPLICATE`. This isolated device-B simulation satisfies phase-one implementation acceptance; a second physical computer is optional environment validation and remains unverified. Git/GitHub transport stays manual, and automatic synchronization/merge and multi-writer behavior remain excluded.
- Read-only repository index freshness: `runRepositoryHealthCheck` reports deterministic required catalog coverage for tracked Skills, top-level knowledge domains, and projects. Missing and duplicate targets fail, allowed extras and exclusions remain valid, enumeration errors fail closed, and the now-archived `d-ai-hub-v2` reference remains indexed. The approved boundary is recorded in `docs/specs/2026-08-30-index-freshness-design.md`.

## Future / Deferred

- Native Chat activation and a configured Chat intent/approval/status connector.
- Native Work activation and a configured Work durable-context connector.
- The previously proposed Work file-backed activation slice; it is cancelled as a V1 requirement.
- Chat↔Work↔Codex automatic handoff and cross-environment automatic routing. The existing versioned handoff and routing contracts remain reference material.
- External Router installation.
- Additional third-party Skill evaluation.
- External memory-product integration, including Memorix and Mem0.
- Automatic or real-time memory synchronization, multi-writer automatic merge, Supabase, embeddings, RAG, and memory dashboards.
- Optional second-physical-device environment rehearsal for the accepted manual memory-transfer runbook.
- Selective repository health-check hardening beyond index freshness and the currently authorized Skill-frontmatter slice: secret-like scanning and broader UTF-8/path/symlink handling remain separate candidates. Draft PR #3 is closed as superseded and must not be merged or resurrected wholesale; its old architecture and Superpowers planning artifacts are historical only.
- New graph runtimes, agent marketplaces, autonomous swarms, or a second top-level orchestrator.

## Post-V1 boundary

- Codex-first V1 acceptance is complete for the verified configured GitHub path; the historical close response returned `Safe-to-delete: YES`, while missing credentials, remote proof, or current privacy verification remains `BLOCKED`/`NO`.
- Any future Chat/Work work requires a new scope decision, supported connector, capability/ownership design, and separate acceptance review.
