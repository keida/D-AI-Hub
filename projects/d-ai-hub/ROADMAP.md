# Roadmap

## Now — restore the approved v2 product slice

1. Keep the approved product baseline tracked at `docs/specs/2026-08-21-d-ai-orchestrator-v2-design.md` and use it as the acceptance source of truth.
2. Preserve the implemented orchestrator runtime and close hard gates; fix only defects that directly block Codex activation or its acceptance.
3. Deliver the Codex activation layer through the canonical `d-ai` Skill, raw-command CLI, explicit durable task selection, and fail-closed default connectors.
4. Prove discover → parse → configured runtime → durable state → close verdict from an unrelated workspace, including no active task, dirty worktree, missing connector/credentials, and remote SHA mismatch.
5. Run full single-worker tests, build, diff integrity, secret-shaped additions scan, and one independent review against the approved v2 specification.

## Four-layer product sequence

- **Markdown Hub:** canonical source, product specification, decisions, roadmap, status, and references.
- **Orchestrator runtime:** one D-AI control plane for lifecycle, routing, handoff, durable context, verification, recovery, rollback, and close.
- **Codex activation:** first supported product entry; platform syntax invokes the same logical `@D-AI` command family.
- **Chat/Work adapters:** later product entries after their actual supported capability seams and durable connectors are available; until then they remain explicitly `BLOCKED`.

## Completed on the active feature branch

- Ownership fencing, atomic initial persistence, handoff restart reconciliation, partial rollback audit persistence, credential/quoted-secret rejection, and URL credential redaction.
- Raw Codex command parsing into the existing runtime.
- Fresh-runtime explicit durable task selection for active-state commands.
- Canonical repository Skill source, compatibility entry, CLI, and external-workspace activation tests.
- Negative close-path acceptance for missing task, dirty worktree, missing credentials, and remote SHA mismatch.

## Deferred until directly required by product acceptance

- External Router installation or evaluation.
- Additional third-party Skill evaluation.
- Repository health-check automation and the three existing untracked health-check/PR2 planning documents.
- New graph runtimes, agent marketplaces, autonomous swarms, or a second top-level orchestrator.

## Not yet delivered

- Supported Chat activation entry and configured Chat execution/approval connector.
- Supported Work activation entry and configured Work durable-context connector.
- A successful real-environment `Safe-to-delete: YES` demonstration with exact GitHub remote SHA evidence for this activation release.
- Canonical merge and release of the feature branch.
