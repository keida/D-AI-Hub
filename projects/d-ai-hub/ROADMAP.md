# Roadmap

## Now — Codex-first D-AI V1 (accepted)

1. Keep the superseding Codex-first scope decision in `projects/d-ai-hub/DECISIONS.md` and retain the 2026-08-21 v2 document as a traceable historical/future architecture reference.
2. Deliver and verify one Codex local control path through the canonical `d-ai` Skill, raw-command CLI, workspace-scoped durable task discovery, ownership fencing, verification gates, recovery, rollback, and close.
3. Use local durable state for task identity, ownership, context, and audit manifests; use the configured GitHub adapter for push evidence and exact remote repository/ref/SHA verification.
4. Keep Markdown project memory (`STATUS.md`, `DECISIONS.md`, `ROADMAP.md`, and related records) as the durable human/agent project source of truth.
5. Preserve the daily user commands `@D-AI continue`, `@D-AI status`, `@D-AI close`, and `@D-AI rollback`; zero/ambiguous/mismatched identity and unavailable connector cases remain fail closed.

## V1 product boundary

- **Codex local control:** required and supported. It owns local repository/workspace inspection, bounded execution, tests, Git operations, recovery, rollback, and local evidence collection through the configured runtime.
- **GitHub evidence:** required where the close gate applies. Push success and exact remote repository/ref/SHA verification are evidence, not assumptions; missing credentials or remote proof remains `BLOCKED`/`NO`.
- **D-AI-Hub Markdown knowledge/project memory:** required. It records canonical decisions, current checkpoints, roadmap, bugs, references, and reusable project context.
- **ChatGPT Web:** ordinary discussion and viewing only; not a V1 runtime dependency.
- **Native Chat and Work activation:** Future/Deferred. Existing adapter and handoff/routing contracts remain reference seams and fail closed without supported connectors.

## Completed on the active implementation line

- Ownership fencing, atomic initial persistence, handoff restart reconciliation, partial rollback audit persistence, credential/quoted-secret rejection, and URL credential redaction.
- Raw Codex command parsing into the existing runtime.
- Fresh-runtime workspace-scoped durable task selection for active-state commands.
- Canonical repository Skill source, compatibility entry, CLI, and external-workspace activation tests.
- Negative close-path acceptance for missing task, dirty worktree, missing credentials, and remote SHA mismatch.
- Fresh positive close-path acceptance whose runtime close response returned `Safe-to-delete: YES`, with normal workspace-scoped discovery, durable context, recovery, private remote identity, successful push, exact remote SHA verification, and clean-worktree enforcement.

## Future / Deferred

- Native Chat activation and a configured Chat intent/approval/status connector.
- Native Work activation and a configured Work durable-context connector.
- The previously proposed Work file-backed activation slice; it is cancelled as a V1 requirement.
- Chat↔Work↔Codex automatic handoff and cross-environment automatic routing. The existing versioned handoff and routing contracts remain reference material.
- External Router installation or evaluation.
- Additional third-party Skill evaluation.
- Repository health-check automation and the three existing untracked health-check/PR2 planning documents.
- New graph runtimes, agent marketplaces, autonomous swarms, or a second top-level orchestrator.

## Post-V1 boundary

- Codex-first V1 acceptance is complete for the verified configured GitHub path; the close response returned `Safe-to-delete: YES`, while missing credentials or remote proof remains `BLOCKED`/`NO`.
- Any future Chat/Work work requires a new scope decision, supported connector, capability/ownership design, and separate acceptance review.
