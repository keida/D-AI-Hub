---
name: d-ai
description: Activate the D-AI control plane in Codex for ordinary natural-language project requests and explicit @D-AI commands, with deterministic intent routing and fail-closed delivery boundaries.
metadata:
  triggers: '["d-ai","continue","status","fix","change","deliver","curate","整理","close","rollback","sync","establish"]'
  compatibleEnvironments: '["codex"]'
  compatibleStages: '["bootstrap","inspect","recover","handoff","close"]'
  requiredResources: '[]'
---

# D-AI Codex Activation

Treat ordinary natural language as the default D-AI entry. Treat `@D-AI` as an explicit logical command prefix that takes priority when present; it is not a Codex built-in command.

## Invoke

Activate this Skill for project-oriented natural language such as “继续 D-AI-Hub”, “查看当前状态”, “这个方案是不是应该改成 SQLite？”, or “那就改成 SQLite”. Also activate it when the user message begins with `@D-AI`. Do not answer that the prefix is only a convention.

Route deterministically:

- questions and status requests are read-only discussion/status paths;
- continue/resume requests use the durable-task continuation path;
- fix/change/build/deliver requests use the bounded delivery path; local implementation and verification remain local by default, while milestone publication requires explicit publication authority;
- close, rollback, sync, and establish retain their named runtime paths or fail closed when unavailable;
- ambiguous language is read-only and must not create or mutate durable state.

Risk levels are explicit: Level 0 is read-only discussion/status, Level 1 is local reversible implementation, Level 2 is publication, and Level 3 is irreversible or destructive action. Verification tiers are separate: Tier 1 is ordinary local checking, Tier 2 is critical local verification, and Tier 3 is publication/remote evidence. Local Level 1 work and Tier 1/2 verification do not publish by default. Publication authority gates commit/push/PR/CI publication; it does not block a permitted local result.

An explicit `@D-AI` command overrides the natural-language default. In particular, an explicit status command remains status even if later text asks for a change. There is no new user-facing `@D-AI deliver` command.

1. Keep the logical command unchanged, such as `@D-AI status` or `@D-AI close`.
2. Extract Codex-only options from the invocation:
   - `--task <task-id>` selects a durable task in a fresh Codex process.
   - `--workspace <path>` selects the target workspace; otherwise use the current workspace.
3. For exact curation forms, pass only a deliberately selected structured JSON payload with `-CurationPayloadPath`; the payload is not a transcript and must contain `{ "version": 1, "candidates": [...] }` current-context facts. Optionally pass an absolute `-MemoryDatabasePath` in a separate private directory outside the target workspace/repository for an isolated test database; when omitted, persistence uses the deterministic OS-local D-AI-Hub memory path outside the workspace. Run this Skill's `scripts/invoke.ps1` with `-CommandText`, `-WorkspacePath`, and optional `-TaskId`, `-CurationPayloadPath`, and `-MemoryDatabasePath`; natural-language text is passed unchanged when it is the default entry.
   The installed Skill root must contain a machine-local `.runtime-root` file pointing to a validated D-AI-Hub runtime checkout. Establish or switch that binding with `scripts/set-runtime-binding.ps1 -SkillRoot <installed-skill-root> -RuntimeRoot <d-ai-hub-checkout>`; a missing or invalid binding fails closed.
4. Report the returned status, message, and evidence without converting `BLOCKED` or `NO` into completion.

The supported exact curation forms, with or without the `@D-AI` prefix, are `整理`, `整理一下`, `整理当前内容`, `整理进我的知识库`, `curate`, and `curate this`. Without a supplied structured curation payload, each returns SAFE NO and does not capture chat history or create durable task state. Missing, unreadable, malformed, relative, or secret-shaped payload values fail closed before any memory or durable write. Selected facts pass a local quality gate for stable subject identity, observation/provenance, supersession, contradiction/duplicate detection, and durable repository or HTTPS evidence/assets; the gate returns structured `PASS`, `HOLD`, or `NO` findings and does not auto-edit its own rules.

To create a payload, select only facts already present in the current visible context, write them to an absolute temporary JSON file, and pass that file to the Skill. For example:

```json
{"version":1,"candidates":[{"candidateId":"release-gate","memoryId":"release-gate","fact":"Local release checks require a clean worktree.","category":"knowledge","source":"current-context","privacyRisk":"local-private"}]}
```

Do not place a transcript, chat export, credentials, workplace-confidential material, or unverified project-memory claim in the payload. The runtime discovers one exact active task for the current workspace and canonical repository when available; project-memory is deferred when no exact task exists, and curation is blocked when discovery is ambiguous.

For `@D-AI status` and `@D-AI close`, omit `--task` on the normal path. The runtime discovers the unique active durable task for the current workspace. Close is local by default; an explicit publication close must provide publication intent and authority. If there are zero matches, multiple matches, or an ownership/workspace conflict, keep the result `BLOCKED` and follow the returned retry guidance.

Fresh `@D-AI status` and `@D-AI continue` also return a bounded redacted task-scoped `memorySnapshot` from an existing private SQLite database. A missing database is reported as no-memory without creating it; this read-only recovery path never crawls chat history, crosses project-task bindings, or mutates durable task state. SAFE TO DELETE remains YES only after selected facts pass the quality gate, persist/read back, and are recovered by a fresh reader.

User-facing explicit syntax:

```text
@D-AI status
@D-AI close
```

`--task <task-id>` is an explicit Codex option for ambiguity resolution or recovery, not the normal user-facing command. Unconfigured Chat, Work, Codex, recovery, Git, or GitHub capabilities remain `BLOCKED`.

Delivery is a thin visible orchestration seam. It may read context, prepare a workspace, implement, run focused verification, typecheck, and build a local review packet. Publication, CI, and release steps occur only for an explicit milestone/publication request with authority; commit, push, and PR creation never receive implicit authorization. It never merges, auto-merges, force-pushes, deletes, resets, cleans, or performs destructive rollback. The delivery result must report stage timings and keep review/merge as a separate decision.

The raw CLI is a real classification and execution-boundary check, not an implementation simulator. If no Codex agent execution seam is attached, it returns a formatted `BLOCKED` result with `execution required` and leaves files, tests, Git, CI, and durable task state unchanged. The Skill/agent continues Level 1 work through the actual Codex workspace; injected delivery dependencies are the only route to claim implementation or publication evidence.

When the response includes `agentExecutionDirective`, consume it immediately in the current Codex agent: use its request, project/task, resume flag, risk, endpoint, publication-authority requirement, and `mergeAllowed: false` boundary to continue the actual work under the normal gates. Do not ask the user to type another command merely to resume this handoff.

The Delivery Result keeps `typecheck_ms` separate from `implementation_ms`, reports observed Windows/Linux CI states independently, and records the exact blocked stage (`context-read`, `workspace-prepare`, `implementation`, `focused-test`, `typecheck`, `publication-authority`, `publication`, `ci-wait`, or `review-packet`) when work cannot continue.
