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

## Historical verification records

- Skill-frontmatter health verification passed 46/46 focused tests and 620/620 tests across the other 30 files, covering 666/666 checks across 32 files. TypeScript build, changed-content secret scan, local-link checks, and `git diff --check` passed; the metadata check remained read-only and no native-loader compatibility certification was claimed.
- PR #24 verification recorded a three-file publication at head `25057bb93d368d9267ee8ddb5a8e58955e2596ea`; GitHub reported MERGED as `9f95a47f0d5d772830c8897f35d357564ffd3b1e`, with GitGuardian passing and remote main verified after merge.
- The curation-rule review evaluated 16 synthetic capture cases plus a three-case follow-up; the result was a decision simulation, not persisted fixture execution or a measured real-world filtering rate. A separate retrieval rehearsal resolved 15 local links with no secret-shaped matches and classified an equivalent candidate as NOOP without querying GitHub.
- The local reader-handoff rehearsal persisted `handoff-20260830-01` at sequence 1. A separate reader returned the matching value digest with exit 0; database SHA-256, size, modification time, tracked-file fingerprint of 163 files, and Git status matched before/after.
- The local SQLite/memory slice recorded 17 store tests, 34 bundle tests, 1 real-Git transfer test, and 10 CLI tests: 62/62 memory tests passed; the full suite recorded 649/649 tests. The two-bundle rehearsal recorded digests `291a0e53fc97fc952ca7aef72fb0a783867bd70cf736b89d2b3a911bfe8be9b2` and `56423255745902603e66a6aee5b08d690c27ee6369c9b94a7ce845cf9783c88a`; a reader verified ordered import, duplicate receipts, and both reads.
- Fresh-device bootstrap installed 57 packages with zero reported vulnerabilities, passed build, persisted/read value `42`, exported digest `e8336ced7296243f4e31be3bf9fdfa8b91e843fd7c02e5c1515381c41be1b89d`, and verified fresh import plus `NOOP_DUPLICATE`. The allowScripts warning for `esbuild@0.28.2` was recorded as environment evidence.
- The BUG-004 line-ending regression reproduced byte 13 insertion under `core.autocrlf=true`; the narrow JSONL `text eol=lf` fix then passed 59/59 memory tests, 646/646 full-suite tests, build, and `git diff --check`. PR #15 merged as `0b37bb93df0a26a12f75444233b23ead2f648c6e`, and a fresh Windows checkout preserved the regenerated JSONL digest.
- The first controlled device-A transfer pushed exact commit `a156c2a0cfbb29424f7a7bf173d72a5a8e609093`; a second fresh clone matched records digest `0a4773a8f3f08d6d23e839bc226398fd0375798abb88563fabe153871ff66e72`, returned `IMPORTED` then `NOOP_DUPLICATE`, and retrieved the expected synthetic record.
- Index-freshness verification covered missing targets, duplicates, promoted notes, exclusions, planned projects, untracked candidates, bounded Git enumeration, and a multibyte diagnostic regression that initially measured 2,049 bytes against a 2,048-byte cap. The narrow fix passed ASCII and multibyte cases; the final full suite recorded 659/659 tests and the working tree reported `index-freshness` passed.
- Superpowers-disable verification found no active native discovery entry; disabled provenance links, `git diff --check`, changed-content secret scan, TypeScript build, Markdown links, and the final 649/649 full-suite run passed. The original dirty root and protected fixtures remained unchanged.

Architecture and product boundaries remain canonical in [Decisions](DECISIONS.md) and [Roadmap](ROADMAP.md); this file records historical verification evidence only.

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
