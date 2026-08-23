---
name: d-ai
description: Activate the D-AI control plane in Codex when a request begins with @D-AI or asks to continue, inspect, hand off, close, or roll back a durable D-AI task.
metadata:
  triggers: '["d-ai","continue","status","handoff","close","rollback"]'
  compatibleEnvironments: '["codex"]'
  compatibleStages: '["bootstrap","inspect","recover","handoff","close"]'
  requiredResources: '[]'
---

# D-AI Codex Activation

Treat `@D-AI` as D-AI's logical command prefix, not as a Codex built-in command.

## Invoke

When the user message begins with `@D-AI`, activate this Skill and invoke the real D-AI runtime. Do not answer that the prefix is only a convention.

1. Keep the logical command unchanged, such as `@D-AI status` or `@D-AI close`.
2. Extract Codex-only options from the invocation:
   - `--task <task-id>` selects a durable task in a fresh Codex process.
   - `--workspace <path>` selects the target workspace; otherwise use the current workspace.
3. Run this Skill's `scripts/invoke.ps1` with `-CommandText`, `-WorkspacePath`, and optional `-TaskId`.
4. Report the returned status, message, and evidence without converting `BLOCKED` or `NO` into completion.

For `@D-AI status` and `@D-AI close`, omit `--task` on the normal path. The runtime discovers the unique active durable task for the current workspace. If there are zero matches, multiple matches, or an ownership/workspace conflict, keep the result `BLOCKED` and follow the returned retry guidance.

User-facing syntax:

```text
@D-AI status
@D-AI close
```

`--task <task-id>` is an explicit Codex option for ambiguity resolution or recovery, not the normal user-facing command. Unconfigured Chat, Work, Codex, recovery, Git, or GitHub capabilities remain `BLOCKED`.
