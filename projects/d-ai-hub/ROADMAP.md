# Roadmap

## Prerequisite publication order

- P2 — Authoritative Rebuild / Belief: `PUBLISHED / CANONICAL`; publication base for P3 is `f8e9b10c0123b3f0b48e53997a63349a72b538fc`.
- P3 — Local-only identity / zero-remote validation: next slice.
- P4 — Boss recovery / rollover: after P3 publication review and canonical publication.
- DAI-ARCH-001 — Active Task Recovery Completeness: publish after its minimal prerequisites are canonical; do not close it or repair DSH 2 / Weekly Review early.
- DAI-ARCH-002: accepted but deferred until DAI-ARCH-001 is canonical. No implementation, runtime activation, or Skill Pulse durable-stage repair is authorized by this ticket entry.

## DAI-ARCH-002 — Project-Owned Lifecycle Handoff (accepted, deferred)

**Status.** `ACCEPTED / IMPLEMENTATION DEFERRED`.

**Problem.** The ordinary D-AI-Hub lifecycle assumes D-AI-Hub performs `route → plan → execute → inspect → verify`. A separately owned project can complete execution and acceptance while its D-AI-Hub orchestration task remains at `route`. The Skill Pulse project Boss accepted SP-OPS-006 after a natural production run, yet D-AI-Hub correctly rejected direct `route → verify` for task `task-7b959c2155241137b16a5220`. Inventing unperformed stages would falsify the durable lifecycle.

**Goal.** Reconcile a project-owned execution result through an explicit D-AI-Hub handoff while preserving the ordinary lifecycle and the project Boss ownership boundary. Implementation design may choose the smallest correct representation; a new stage, synthetic transitions, special event, or command is not prescribed.

**Acceptance criteria**

1. Ingestion accepts results only from the task's declared project execution owner, with explicit verifiable provenance and evidence.
2. The handoff is typed and explicit; an ordinary `verify` transition or arbitrary caller cannot bypass lifecycle gates.
3. The durable result distinguishes D-AI-executed stages, project-owned execution and acceptance, and D-AI-Hub orchestration reconciliation without recording unperformed `plan`, `execute`, or `inspect` stages.
4. Replaying an identical accepted handoff is idempotent: it neither closes the task twice nor creates a second authoritative result. Conflicting replays fail closed.
5. Missing, unverifiable, or mismatched owner/evidence fails closed without advancing stage or closing the task.
6. A project Boss result is required before reconciliation. PASS or explicit closure is necessary but not alone sufficient to close; a defect result remains visible and cannot close the orchestration task automatically.
7. Existing ordinary lifecycle transitions and their fail-closed rejection behavior remain unchanged, with regression evidence for both paths.
8. A fresh recovery exposes the reconciled owner, provenance, result, and remaining lifecycle state without relying on chat history or unrelated project data.

**Current case.** Skill Pulse task `task-7b959c2155241137b16a5220` stays at `route`, unclosed, `BLOCKED — awaiting lifecycle handoff capability`. Its project Boss owns execution and acceptance; D-AI-Hub does not rerun SP-OPS-006 or alter Skill Pulse files. This ticket does not authorize an immediate repair or implementation.

**Dispatch gate.** Start only after P3 → P4 → DAI-ARCH-001 publication has completed and DAI-ARCH-001 is on canonical main. Use the then-current canonical base and a separately bounded implementation packet.

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
