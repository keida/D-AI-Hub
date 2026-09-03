---
name: d-ai
description: Activate the D-AI control plane in Codex for ordinary natural-language project requests and explicit @D-AI commands, with deterministic intent routing and fail-closed delivery boundaries.
metadata:
  triggers: '["d-ai","continue","status","fix","change","deliver","close","rollback","sync","establish"]'
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
- fix/change/build/deliver requests use the bounded delivery path; Level 1 may produce a local verified result, while Level 2 publication requires explicit publication authority;
- close, rollback, sync, and establish retain their named runtime paths or fail closed when unavailable;
- ambiguous language is read-only and must not create or mutate durable state.

Risk levels are explicit: Level 0 is read-only discussion/status, Level 1 is local reversible implementation, Level 2 is publication (commit/push/PR), and Level 3 is irreversible or destructive action. Publication authority gates only Level 2 publication; it does not block a permitted Level 0 read or Level 1 local result.

An explicit `@D-AI` command overrides the natural-language default. In particular, an explicit status command remains status even if later text asks for a change. There is no new user-facing `@D-AI deliver` command.

1. Keep the logical command unchanged, such as `@D-AI status` or `@D-AI close`.
2. Extract Codex-only options from the invocation:
   - `--task <task-id>` selects a durable task in a fresh Codex process.
   - `--workspace <path>` selects the target workspace; otherwise use the current workspace.
3. Run this Skill's `scripts/invoke.ps1` with `-CommandText`, `-WorkspacePath`, and optional `-TaskId`; natural-language text is passed unchanged when it is the default entry.
4. Report the returned status, message, and evidence without converting `BLOCKED` or `NO` into completion.

For `@D-AI status` and `@D-AI close`, omit `--task` on the normal path. The runtime discovers the unique active durable task for the current workspace. If there are zero matches, multiple matches, or an ownership/workspace conflict, keep the result `BLOCKED` and follow the returned retry guidance.

User-facing explicit syntax:

```text
@D-AI status
@D-AI close
```

`--task <task-id>` is an explicit Codex option for ambiguity resolution or recovery, not the normal user-facing command. Unconfigured Chat, Work, Codex, recovery, Git, or GitHub capabilities remain `BLOCKED`.

Delivery is a thin visible orchestration seam. It may read context, prepare a workspace, implement, run focused verification, typecheck, publish, wait for CI, and build a review packet. It must receive explicit publication authority before commit, push, or PR creation; it never merges, auto-merges, force-pushes, deletes, resets, cleans, or performs destructive rollback. The delivery result must report stage timings and keep review/merge as a separate decision.

The raw CLI is a real classification and execution-boundary check, not an implementation simulator. If no Codex agent execution seam is attached, it returns a formatted `BLOCKED` result with `execution required` and leaves files, tests, Git, CI, and durable task state unchanged. The Skill/agent continues Level 1 work through the actual Codex workspace; injected delivery dependencies are the only route to claim implementation or publication evidence.

When the response includes `agentExecutionDirective`, consume it immediately in the current Codex agent: use its request, project/task, resume flag, risk, endpoint, publication-authority requirement, and `mergeAllowed: false` boundary to continue the actual work under the normal gates. Do not ask the user to type another command merely to resume this handoff.

The Delivery Result keeps `typecheck_ms` separate from `implementation_ms`, reports observed Windows/Linux CI states independently, and records the exact blocked stage (`context-read`, `workspace-prepare`, `implementation`, `focused-test`, `typecheck`, `publication-authority`, `publication`, `ci-wait`, or `review-packet`) when work cannot continue.
