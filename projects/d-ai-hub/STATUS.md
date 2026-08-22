# Status

## State

- Lifecycle: active
- Last updated: 2026-08-22

## Current checkpoint

- Current task: Implement and verify progressive loading for the canonical `project-memory` Skill.
- Working state: Isolated branch `codex/project-memory-progressive` contains the Skill, checkpoint, and measurement updates; old worktrees remain untouched. The branch is pushed and tracked by PR #4.
- Active plan: Await review/integration of the progressive Skill change. Continue measuring real resumptions before considering a context pack. Do not introduce a second memory source.
- Latest verified evidence: RED pressure scenarios confirmed the prior fixed six-file order was too broad for narrow continuation. GREEN scenarios confirmed `STATUS.md` first, task-matching files conditionally, direct references as needed, and full order only for close/audit/conflict. Static Skill, compatibility-pointer, AGENTS alignment, and `git diff --check` checks passed. Five local read scenarios measured 2 files for narrow bug/roadmap/decision cases versus 6 files for close/audit cases; local character volume was 7,078/5,629/9,097 versus 19,306 for full reads. These are file-read baselines, not real cross-session recovery timings.

## Last verified progress

- D-AI-Hub V1 foundation was merged into canonical `main`.
- Codex operating context was subsequently committed and successfully pushed to GitHub `main`.
- The root `AGENTS.md` bootstrap defines session-start, canonical ownership, security, branch, and session-close rules for Codex and compatible agents.
- V1.1 hardening documents the safe ChatGPT Web ↔ GitHub ↔ Codex workflow and makes `skills/custom/` the only canonical custom Skill source.
- The current Codex environment has verified GitHub authentication, authenticated fetch/pull, and clean synchronization with `origin/main`.
- A full Codex Hub audit was completed after establishment; the confirmed V1.1 consistency and workflow issues were fixed and post-reviewed with no remaining Critical or blocking Important findings.
- The Web operating pattern is now intentionally short-session based: use D-AI-Hub as durable memory rather than relying on very long ChatGPT conversation history. New durable sessions should restore only the narrowest relevant project, Skill, and knowledge context instead of loading the entire Hub.
- The P0 consistency audit verified the scoped document links, canonical Skill frontmatter and compatibility targets, secret-like filenames/content, and `git diff --check`.
- The P0 audit was a static documentation and consistency audit; it did not verify command behavior end to end.
- The current change set introduced Fast Read, Write Gate, Release Gate, and a replace-in-place progress checkpoint; it repositions `@D-AI sync` as an optional explicit canonical-freshness check. These changes are present on canonical `main` at `0ffd770`.

## Current blockers

BUG-002 blocks treating `@D-AI sync` behavior as verified. Normal local project continuation remains available, but remote freshness must be reported separately. New checkouts and environments must still authenticate before treating GitHub state as current.

## Next concrete action

Collect five real project resumptions and record their file counts, repeated checks, elapsed recovery time, and omissions before considering a context pack. Defer P1 context-pack and all P2 automation.

## Verification notes

Remote GitHub updates have been successfully performed after the original setup session. The isolated branch was created from verified canonical `main` commit `0ffd770`; no old worktree was modified. Measurement results are recorded on the PR branch; canonical `main` remains unchanged until review and merge.
