# Status

## State

- Lifecycle: active
- Current objective: Dogfood Mode — use D-AI-Hub to manage real projects and observe actual failures instead of continuing preventive architecture expansion.
- Privacy boundary: repository `knowledge/`, `memory/`, and `projects/` contain public-safe promoted context only; private Memory remains in OS-local SQLite/private state. Live GitHub visibility must be verified separately.
- Stable capability: natural-language intent classification, explicit `@D-AI` priority, structured Codex-agent handoff, bounded delivery, workspace fencing, and fail-closed configured Codex repository identity preflight.
- Live PR status must be queried from GitHub.
- Live GitHub CI, branch-protection, visibility, and remote-freshness state must be queried before release or privacy decisions.
- Last checkpoint: 2026-09-11

## Current checkpoint

- V1 Foundation: CLOSED.
- Verified V1 foundation: V1 Stabilization is CLOSED; legacy migration is ALREADY SATISFIED; natural-language project continuation DOGFOOD is PASS; explicit task-ID continuation is PASS; and the future-task canonical repository guarantee is CLOSED.
- Configured Codex new-task invariant: establish exactly one inspected canonical `remote-repository:<host>/<owner>/<repo>` identity before first durable persistence, or return `BLOCKED` with zero durable writes.
- Configured Codex generic-intent invariant: without explicit establish/new-task authority, discover active tasks by exact canonical workspace and repository identity; zero matches return `BLOCKED` with zero writes, one match binds the existing task and fails closed when no safe operation is configured, and multiple matches return ambiguity `BLOCKED` with zero writes. Explicit establish/new-task behavior remains unchanged.
- Existing workspace fencing and fail-closed behavior remain accepted.
- LOCAL FIRST, GITHUB ON MILESTONE is implemented for this checkpoint: local runtime, live local Git state, durable state, private SQLite memory, and project checkpoints are active working truth; GitHub is the last explicitly published public-safe milestone and transport.
- Default `@D-AI close` completes locally only after live local Git identity, clean-worktree, durable, ownership, recovery, and critical-unsaved-context gates. A late dirty or untracked worktree, identity mismatch, inspection failure, or recovery mismatch returns `BLOCKED`/`NO` without GitHub calls. Explicit publication close requires `publicationRequested: true` and authority allowing commit and push; the existing exact remote-SHA GitHub gates remain in that lane.
- Working state: accepted local-first baseline is active at `30153cb806bdee8360215e45a00d0c965971a293`; the task-reuse fix is locally reviewed and captured in this local checkpoint. No push, PR, CI, or GitHub publication was performed.
- Local validation: task-reuse relevant integration tests passed 40 with 1 platform skip; runtime/parser focused tests passed 133; typecheck and diff check passed; added-line secret-like scan had 0 hits. Structural health passed repository identity, required files, index freshness, Skill frontmatter, and Markdown links, with only intentional dirty-working-tree checks failing.
- Real Quote Float cleanup condition remains unresolved and untouched: active durable tasks `task-937dc8b8c2a683764bc3eb62`, `task-d568bcbd45a8d2e139bcfe66`, and `task-cb9212276ba3e1bc76d04638` remain under the real workspace. No cleanup, replay, close, merge, or deletion was performed.
- Dogfood freeze: absent new real evidence, do not implement Actor/Session V2, Memory redesign, RAG, embeddings, a vector database, fuzzy or semantic resolution, cross-workspace resume, a Router, swarm behavior, a second orchestrator, Chat/Work runtime, Runtime V2, automatic sync, or multi-writer support.
- PR #29 remains Deferred and untouched.

## Current blockers

- No current V1 product blocker; the next evidence must come from real dogfood.
- Keep public-safe boundaries intact in `knowledge/`, `memory/`, and `projects/`; do not store private Memory, credentials, or confidential durable context there.
- Any PR, CI, branch-protection, or remote-freshness claim must be refreshed from GitHub rather than copied into this checkpoint.
- Merge and destructive Git operations still require separate explicit authorization.

## Next concrete action

Recommended next action: activate and verify the new local runtime baseline, then obtain a distinct destructive cleanup decision for the three untouched Quote Float tasks. Do not publish to GitHub in that step.

## Evidence pointers

- Historical implementation and release evidence: [Evidence History](EVIDENCE_HISTORY.md).
- Durable product and architecture choices: [Decisions](DECISIONS.md); future work: [Roadmap](ROADMAP.md).
