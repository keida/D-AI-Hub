---
name: d-ai
description: Activate the D-AI control plane in Codex when a request begins with @D-AI or asks to continue, inspect, hand off, close, or roll back a durable D-AI task.
metadata:
  triggers: '["d-ai","continue","status","handoff","close","rollback"]'
  compatibleEnvironments: '["codex"]'
  compatibleStages: '["bootstrap","inspect","recover","handoff","close"]'
  requiredResources: '[]'
---

# Compatibility Entry Point

The canonical Skill is [`../../../skills/custom/d-ai/SKILL.md`](../../../skills/custom/d-ai/SKILL.md).

Read that file completely and follow it before handling a D-AI logical command.
