# Evidence History

This file preserves release and verification context that no longer belongs in the replace-in-place current checkpoint. Git history and the linked pull requests remain the detailed audit source.

## Canonical project milestones

- PR #12 established the repository-health baseline and merged after local review and GitGuardian checks.
- PR #14 merged the first local SQLite memory slice after focused diagnostics, command-runner checks, the full test suite, TypeScript validation, and GitGuardian.
- PR #15 fixed Windows line-ending corruption of hashed memory bundle JSONL; a fresh Windows checkout with `core.autocrlf=true` preserved the recorded digest.
- PR #22 completed the separately reviewed project-memory and curation-rule revision.
- PR #23 merged the knowledge-curation publication and Git line-ending lesson.
- PR #24 merged the selective knowledge/project-memory curation update.
- [PR #25](https://github.com/keida/D-AI-Hub/pull/25) merged the tracked Skill-frontmatter health check as canonical merge commit `7beec52407fba58aca4e90aae06d88a1b7f335ed`.

## Accepted implementation boundaries

- D-AI V1 is Codex-first. Native Chat/Work activation and automatic cross-environment routing remain deferred and must fail closed when unavailable.
- Markdown/Git owns canonical project and knowledge state. Local SQLite stores runtime or derived data and is not a second control plane.
- The memory transfer slice remains single-writer and manually transported through versioned JSONL/manifest artifacts. Automatic sync, merge, second-writer behavior, embeddings, RAG, and dashboards remain deferred.
- Superpowers is disabled by explicit user decision. Native execution, D-AI-Hub Skills, narrow routine engineering Skills, and proportional independent review remain the supported workflow.

## Verification history and limits

- Historical full-suite counts, fresh-clone rehearsals, private-GitHub transfer checks, hashes, and security reviews are preserved in the commits and PR descriptions that introduced them. They are historical evidence, not proof of the current untested working tree.
- The isolated reader rehearsal proved same-machine retrieval from a separate workspace and database; it did not prove a second physical device or automatic new-chat recall.
- The GitHub transfer rehearsal proved exact private-repository bytes and ordered import for the accepted single-writer slice; it did not prove automatic synchronization or conflict merging.
- Repository health checks are local and read-only with respect to tracked source, but the aggregate command executes trusted package scripts and is not a substitute for GitHub CI.
- Branch protection and required-check configuration must be reported from live GitHub evidence when accessible; absence of local configuration is not proof of a remote protection setting.

## Canonical detail

- [Decisions](DECISIONS.md)
- [Bugs](BUGS.md)
- [Roadmap](ROADMAP.md)
- [References](REFERENCES.md)
