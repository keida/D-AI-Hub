---
name: knowledge-manager
description: Use when durable information should be captured, classified, normalized, linked, indexed, retrieved, or cleaned up inside D-AI-Hub. Do not use for transient chat, secrets, credentials, or project-only state that belongs under projects/.
triggers:
  - knowledge
  - durable
  - retrieve
compatibleEnvironments:
  - chat
  - work
  - codex
compatibleStages:
  - bootstrap
  - plan
  - execute
  - inspect
  - verify
  - close
---

# Knowledge Manager — Agent Entry Point

The canonical skill is maintained at:

`../../../skills/custom/knowledge-manager/SKILL.md`

Read and follow that file before performing knowledge-management work. Do not maintain independent behavior in this compatibility entry point.
