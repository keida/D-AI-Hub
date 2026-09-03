# Status

## State

- Lifecycle: active
- Last merged delivery: PR #30
- Active proposal: PR #29
- Current objective: Visible natural-language automation MVP
- Stable capability: natural-language intent classification, explicit `@D-AI` priority, structured Codex-agent handoff, and a bounded delivery seam with explicit publication authority
- Live PR status must be queried from GitHub.
- Live PR/CI state: query GitHub
- Main branch protection and remote freshness: live environment evidence only; query before release decisions
- Last checkpoint: 2026-09-03

## Current checkpoint

- Current objective: Make the Codex entry understand ordinary project language while keeping mutation and publication fail-closed.
- Verified state: The deterministic classifier covers discussion, status, continuation, delivery, close, rollback, sync, and establish; focused automation and entry tests pass. Discussion is read-only and creates no durable task state.
- Working state: Delivery is a thin dependency-injected path for context, workspace, implementation, focused verification, typecheck, publication, CI wait, and review-packet construction. The raw CLI only classifies and returns an execution-required boundary result; attached Codex agent seams are required before implementation evidence. Publication authority gates Level 2, and delivery never merges or performs destructive Git actions.
- Proposal boundary: The actor/session ADR remains Proposed/Deferred; actor/session runtime, Chat/Work activation, automatic sync, and related redesigns are not implemented.
- Authorized scope: This MVP does not add Chat/Work/provider routing, memory sync, RAG, embeddings, dashboards, swarm behavior, or a second orchestrator. No merge or auto-merge is authorized.

## Current blockers

- Publication authority is required before commit, push, or PR creation; absent authority blocks at the Level 2 publication boundary while permitted Level 1 local work may still return a verified result.
- Any PR, CI, branch-protection, or remote-freshness claim must be refreshed from GitHub rather than copied into this checkpoint.

## Next concrete action

Independently review the current branch and live PR/CI evidence before any separately authorized merge decision; keep merge unperformed until that decision.

## Evidence pointers

- Historical implementation and release evidence: [Evidence History](EVIDENCE_HISTORY.md).
- Durable product and architecture choices: [Decisions](DECISIONS.md); future work: [Roadmap](ROADMAP.md).
