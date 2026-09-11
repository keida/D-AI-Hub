# Status

## State

- Lifecycle: active
- Current objective: Dogfood Mode — activate and dogfood Local Curation V1 with deliberately selected local-private facts, without publishing or ingesting a full chat transcript.
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
- Working state: Local Curation V1 is implemented and locally verified on the local-first branch. Exact curation forms route before generic task bootstrap, persist only selected structured facts to the OS-local SQLite memory store, and return deterministic `ADD`, `UPDATE`, `NOOP`, `DEFER`, or `REJECT` outcomes with post-transaction read-back evidence. No push, PR, GitHub Actions, or GitHub publication was performed.
- Local Curation V1 safety contract: repository `knowledge/`, `memory/`, and `projects/` receive zero automatic curation writes; workplace-risk content fails conservatively; project-memory requires an exact active workspace/repository task; and `SAFE TO DELETE ORIGINAL CHAT: YES` covers only the selected verified facts, not a transcript or every sentence.
- Local validation: focused curation, parser, runtime, CLI, memory, rollback, and installed-Skill tests pass; relevant close/task-reuse integration tests remain green; typecheck and diff checks pass; privacy review found no content disclosure in serialized curation results.
- Quote Float durable cleanup is CLOSED by Boss acceptance. The real workspace has one active canonical task, `task-937dc8b8c2a683764bc3eb62`; this implementation used only synthetic isolated stores and did not access or mutate that real durable state.
- Dogfood freeze: absent new real evidence, do not implement Actor/Session V2, Memory redesign, RAG, embeddings, a vector database, fuzzy or semantic resolution, cross-workspace resume, a Router, swarm behavior, a second orchestrator, Chat/Work runtime, Runtime V2, automatic sync, or multi-writer support.
- PR #29 remains Deferred and untouched.

## Current blockers

- No current product blocker in the locally verified implementation; activation and real-user curation still require a separate controlled dogfood acceptance.
- Keep public-safe boundaries intact in `knowledge/`, `memory/`, and `projects/`; do not store private Memory, credentials, or confidential durable context there.
- Any PR, CI, branch-protection, or remote-freshness claim must be refreshed from GitHub rather than copied into this checkpoint.
- Merge and destructive Git operations still require separate explicit authorization.

## Next concrete action

Recommended next action: activate the new local runtime baseline, then run a separately approved real-user Local Curation dogfood with a small reviewed fact set and verify SQLite read-back. Do not ingest the full chat or publish to GitHub.

## Evidence pointers

- Historical implementation and release evidence: [Evidence History](EVIDENCE_HISTORY.md).
- Durable product and architecture choices: [Decisions](DECISIONS.md); future work: [Roadmap](ROADMAP.md).
