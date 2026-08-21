---
name: project-memory
description: Use when starting, resuming, updating, or closing a project in D-AI-Hub so project state is explicit and does not depend on old chat history.
metadata:
  triggers:
    - project
    - memory
    - resume
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
    - handoff
    - close
  requiredResources: []
---

# Project Memory — Agent Entry Point

The canonical skill is maintained at:

`../../../skills/custom/project-memory/SKILL.md`

Read and follow that file before performing project-memory work. Do not maintain independent behavior in this compatibility entry point.
