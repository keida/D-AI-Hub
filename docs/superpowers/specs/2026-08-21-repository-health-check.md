# D-AI-Hub V1.2 Repository Health Check

## Goal

Provide a deterministic, local-only health check for D-AI-Hub so broken internal links, malformed Skills, stale indexes, and secret-like repository content are found before a durable update, commit, push, or close.

## Scope

The health check scans the repository root and returns a structured report. It does not modify files, contact GitHub, read credentials, execute Skill scripts, or attempt automatic repairs.

### Checks

1. **Internal links**: validate relative Markdown links and repository-local file references. Ignore external `http`, `https`, `mailto`, and anchor-only links. Report the source file, target, and line number.
2. **Skill frontmatter**: validate canonical Skill files under `skills/custom/` and compatibility entry points under `.agents/skills/`. Require a parseable YAML frontmatter block with `name` and `description`; reject unsafe or duplicate canonical names.
3. **Secret-like content**: inspect tracked-scope text files for high-confidence token, private-key, password, and credential patterns. Report only a redacted finding with path and line number. Do not print the matched value.
4. **Index freshness**: validate links in `indexes/SKILLS.md`, `indexes/KNOWLEDGE.md`, and `indexes/PROJECTS.md`; report missing targets and duplicate canonical entries.

## API

The implementation exposes a pure function:

```ts
runRepositoryHealthCheck(input: RepositoryHealthCheckInput): Promise<RepositoryHealthReport>
```

`RepositoryHealthCheckInput` contains an absolute repository root and explicit scan configuration. The report contains a stable check identifier, severity, relative path, optional line number, redacted message, and summary counts. Findings are sorted by check identifier, path, line, and message so repeated runs are diffable.

The report is `healthy: true` only when it contains zero findings. Warnings remain visible and make the report unhealthy even when no error findings exist. A missing root, unreadable file, malformed configuration, or traversal outside the root is an explicit error, not a silent skip.

## Safety boundaries

- Use the existing `yaml` dependency; add no new package.
- Resolve every candidate path against the repository root and reject traversal outside it.
- Skip `.git`, `node_modules`, coverage/build output, and the ignored Superpowers scratch directory.
- Read text files as UTF-8 with explicit errors for invalid input.
- Never execute files discovered during scanning.
- Never include secret-like values in reports, logs, snapshots, or handoff envelopes.
- Do not change existing `@D-AI close`, rollback, ownership, or handoff behavior in this milestone.

## Verification

- Unit tests cover each check's success and failure cases, deterministic ordering, redaction, path traversal, and unreadable input.
- An integration fixture scans a temporary repository containing valid and invalid Markdown, Skills, indexes, and secret-like files.
- Existing tests and TypeScript build remain green.
- `git --no-pager diff --check` remains clean.

## Definition of Done

- All four checks return structured, redacted findings.
- A clean fixture produces `healthy: true` with zero errors and zero warnings.
- An invalid fixture identifies every intended defect without executing repository content.
- The implementation is independent of GitHub credentials and network availability.
- No automatic repair, commit, push, merge, reset, clean, or deletion is introduced.
- The implementation plan is complete, self-reviewed, and traceable to this spec.
