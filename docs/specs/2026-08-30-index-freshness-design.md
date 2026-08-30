# Index Freshness Check Design

## Purpose

Extend the existing local repository health check with one read-only `index-freshness` result that detects canonical Skills, knowledge domains, and projects that have become undiscoverable from their owning indexes. The check reports drift only; it never edits an index or changes repository state.

## Existing seam

The external seam remains:

```ts
runRepositoryHealthCheck(input): Promise<RepositoryHealthReport>
```

Callers and the CLI learn no new arguments or configuration. The aggregate report gains one deterministic check with ID `index-freshness`, placed after `required-files` and before `markdown-links`. A failed freshness check makes the report `unhealthy` but does not suppress Markdown, build, test, or final working-tree checks. An inability to enumerate tracked candidates or read an owning index makes only `index-freshness` `blocked`.

## Required catalog targets

Expected targets are derived only from tracked repository paths. Each expected target must appear exactly once in its owning index after URI decoding, fragment removal, separator normalization, and resolution relative to that index.

### `indexes/SKILLS.md`

- Every tracked `skills/custom/<name>/SKILL.md`.
- Every tracked `.agents/skills/<name>/SKILL.md` compatibility entry.
- Every tracked `skills/external/*.md` provenance record except `skills/external/README.md`.

Disabled external Skills remain expected provenance targets. Their presence in the disabled section is valid and does not activate discovery.

### `indexes/KNOWLEDGE.md`

- Every top-level `knowledge/<domain>/` directory inferred from tracked content below that directory.

Individual knowledge notes are not exhaustively required. The existing policy intentionally lets the index promote only notes important enough for direct discovery, so additional valid links are allowed.

### `indexes/PROJECTS.md`

- Every tracked `projects/<name>/STATUS.md`, represented by a link to `projects/<name>/`.
- `projects/_template/` is excluded.
- `active`, `planned`, and `archived` projects all require discovery; section classification remains human-owned and is not inferred by this first slice.

The current repository is expected to expose one initial finding: `projects/d-ai-hub-v2/STATUS.md` is tracked but its project directory is not indexed. The implementation slice should add a `Planned projects` entry rather than weaken the coverage rule.

## Allowed index content

- Additional valid links are allowed, including promoted knowledge notes and explanatory references.
- External URLs, anchors, and protocol-relative links do not participate.
- Existing Markdown-link validation remains responsible for missing targets and repository-containment checks.
- Duplicate occurrences of an expected catalog target in the same owning index fail freshness even when both links resolve.
- Results are sorted by owning index and normalized target so observations are deterministic.

## Module shape

`src/health/index-freshness.ts` owns candidate derivation, index coverage comparison, deterministic findings, and the returned `HealthCheckResult`. It is an internal module called only by `runRepositoryHealthCheck`.

The existing pure Markdown destination helpers should move unchanged into `src/health/markdown-targets.ts` and be shared by Markdown-link and index-freshness implementations. This creates one internal seam for parsing without expanding the public health-check interface. Existing Markdown-link tests must remain green to prove the move does not change behavior.

## Test seam

Tests exercise the public `runRepositoryHealthCheck` interface with real temporary Git repositories and tracked files. Minimum observable cases:

1. all required Skill, knowledge-domain, and project targets are indexed exactly once;
2. one missing target per owning index produces an `unhealthy` `index-freshness` result while later checks still run;
3. a duplicate required target fails deterministically;
4. extra promoted knowledge links remain valid;
5. `skills/external/README.md` and `projects/_template/` are excluded;
6. a planned project requires an index entry;
7. untracked candidates do not affect freshness;
8. Git enumeration or index-read failure produces a bounded, redacted `blocked` result.

No mock-based test is required; existing real Git fixtures are the stable seam.

## Non-goals

- No automatic index repair.
- No remote, GitHub, fetch, pull, branch-policy, or scheduler behavior.
- No semantic validation of active/planned/archived section placement.
- No requirement to index every knowledge note.
- No Skill frontmatter, secret-like content, UTF-8, path, or symlink hardening in this slice.
- No reuse or resurrection of draft PR #3 implementation or Superpowers planning files.

## Implementation acceptance

Implementation requires separate authorization. When authorized, use observable tests first, keep the net source change inside `src/health/` plus focused health tests and the one known `indexes/PROJECTS.md` baseline repair, then run focused health tests, TypeScript build, the full suite, `git diff --check`, and changed-content secret scanning before any release action.
