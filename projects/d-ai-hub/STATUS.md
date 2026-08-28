# Status

## State

- Lifecycle: active
- Last updated: 2026-08-28

## Current checkpoint

- Current task: Preserve the guarded Memorix decision while integrating lightweight engineering routing, direct upstream Matt Skills, Superpowers discovery, and Router deferral.
- Working state: this integration branch combines the current `main` Memorix documentation with the routing documentation. The original dirty checkout and its existing worktrees remain untouched.
- Authorized file scope: Memorix and routing documentation, third-party Skill records, discovery index, roadmap, references, and project state only. Runtime, tests, adapters, dependencies, Router implementation, and Memorix adapter implementation remain out of scope.
- Scope decision: Git/Markdown and D-AI-Hub remain canonical. Memorix remains an optional guarded local adapter proposal; the routing update adds no second control plane, external Router, native Chat/Work activation, or automatic cross-environment handoff.
- PoC verdict: Memorix is PARTIAL; see its 2026-08-28 decision in `DECISIONS.md` for verified capabilities, limits, and the guarded adapter contract.

## Delivery state

1. **Markdown Hub — required.** `STATUS.md`, `DECISIONS.md`, `ROADMAP.md`, the command reference, and the retained v2 spec describe the Codex-first boundary and its traceability.
2. **Codex control layer — required.** The parser, Skill/CLI entry, workspace-scoped durable discovery, ownership fencing, gates, recovery, rollback, GitHub seam, and close verdict remain the active implementation path.
3. **Chat/Work — deferred contract.** Existing adapters and handoff/routing contracts remain reference seams; unavailable connectors must remain `BLOCKED` and do not block V1 scope completion.

## Verified evidence

- The Memorix decision records an isolated PoC with local SQLite/Orama search and manual transfer, alongside its unproven sync, integrity, secrecy, and conflict semantics.
- Local verification snapshot (2026-08-28, environment-dependent): the installer lock records 17 selected Matt Skills from `mattpocock/skills`, and all 17 are discoverable from the native user-level Skill root; see `skills/external/matt-skills.md`.
- Local verification snapshot (2026-08-28, environment-dependent): Superpowers is exposed through one native discovery junction from a checkout at `v6.3.0` / `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`; see `skills/external/superpowers.md`.
- The Routing decision, discovery links, references, and roadmap agree that no external Router is installed. Documentation link checks and `git diff --check` remain required before any release action.

## Current blockers

- No implementation blocker. Memorix and any external Router remain unimplemented and require separate authorization; Chat/Work remains deferred.

## Next concrete action

Do not open a pull request, merge, implement the Memorix adapter, or install an external Router without explicit authorization.
