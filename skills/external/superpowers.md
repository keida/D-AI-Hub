# Superpowers

- Upstream: `https://github.com/obra/superpowers`
- Purpose: complex engineering escalation and orchestration.
- Role in D-AI-Hub: use for complex planning, long-running work, multi-module changes, parallel or multi-agent execution, difficult debugging escalation, autonomous multi-step implementation, and high-confidence final verification.
- Routine boundary: do not automatically invoke Superpowers for routine engineering when a narrower workflow provides sufficient confidence.
- Installation: direct upstream Git checkout exposed through native Codex Skill discovery. Do not vendor it in D-AI-Hub; Codex Plugin Directory copies are not canonical for this setup.
- Local verification (2026-08-28): the checkout's `main` is at `v6.3.0`, commit `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`; one native user-level discovery link resolves to the checkout's `skills/` directory.
- Updates: explicitly run `git fetch --prune` and `git pull --ff-only` in the upstream checkout, then smoke-check discovery. Do not automate updates.
- Compatibility: supports Codex and multiple coding agents; other surfaces depend on their available Skill mechanisms.
- Local modifications: none.
