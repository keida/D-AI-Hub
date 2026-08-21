# D-AI-Hub V1.2 Repository Health Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a deterministic local health-check library that detects repository integrity and security hygiene defects without modifying or publishing repository state.

**Architecture:** Keep the feature as a pure health-check service with four focused check modules and one deterministic report aggregator. Each check receives explicit root/configuration and returns typed findings; the aggregator owns path safety, ordering, and summary calculation.

**Tech Stack:** TypeScript, existing `yaml` dependency, Node filesystem APIs, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-repository-health-check.md`

## Global Constraints

- The scan is local-only and must not contact GitHub or read credentials.
- The scan must never execute discovered repository files.
- Secret-like values must never appear in reports, logs, snapshots, or handoff envelopes.
- No new dependency or persistence backend.
- No automatic repair, commit, push, merge, reset, clean, or deletion.
- Existing close, rollback, ownership, and handoff behavior must remain unchanged.

---

### Task 1: Define typed health-check contracts and deterministic aggregation

**Files:**
- Create: `src/health/types.ts`
- Create: `src/health/repository-health-check.ts`
- Test: `tests/health/repository-health-check.test.ts`

**Interfaces:**
- Produces `runRepositoryHealthCheck(input: RepositoryHealthCheckInput): Promise<RepositoryHealthReport>`.
- Produces stable `HealthFinding` values with check id, severity, relative path, optional line, and redacted message.

- [ ] Write failing tests for empty-repository health, stable ordering, and root traversal rejection.
- [ ] Run the focused health tests and confirm they fail because the contracts do not exist.
- [ ] Implement strict types, explicit input validation, path containment, and deterministic report aggregation.
- [ ] Run the focused health tests and confirm they pass.

### Task 2: Implement Markdown link and index freshness checks

**Files:**
- Create: `src/health/markdown-links.ts`
- Create: `src/health/index-freshness.ts`
- Modify: `src/health/repository-health-check.ts`
- Test: `tests/health/markdown-links.test.ts`
- Test: `tests/health/index-freshness.test.ts`

**Interfaces:**
- Consumes the root and file inventory from Task 1.
- Produces `link` and `index` findings with source-relative path and line number.

- [ ] Add failing tests for valid local links, missing targets, anchor-only links, external links, and path traversal.
- [ ] Add failing tests for missing index targets and duplicate canonical entries.
- [ ] Implement UTF-8 Markdown scanning without executing or resolving external resources.
- [ ] Run focused link and index tests and confirm they pass.

### Task 3: Implement Skill frontmatter and secret-like content checks

**Files:**
- Create: `src/health/skill-frontmatter.ts`
- Create: `src/health/secret-scan.ts`
- Modify: `src/health/repository-health-check.ts`
- Test: `tests/health/skill-frontmatter.test.ts`
- Test: `tests/health/secret-scan.test.ts`

**Interfaces:**
- Consumes the explicit scan root and allowed Skill/index paths.
- Produces `skill-frontmatter` and `secret` findings with redacted messages only.

- [ ] Add failing tests for valid frontmatter, missing name/description, malformed YAML, duplicate names, and compatibility links.
- [ ] Add failing tests for representative secret-like patterns and safe non-secret text; assert matched values never appear in serialized reports.
- [ ] Implement strict YAML frontmatter parsing and high-confidence redacted pattern detection.
- [ ] Run focused Skill and secret tests and confirm they pass.

### Task 4: Add the real temporary-repository integration fixture and regression gate

**Files:**
- Create: `tests/integration/repository-health-check.test.ts`
- Modify: `tests/health/repository-health-check.test.ts` only if integration contracts require an assertion update.

**Interfaces:**
- Consumes the public health-check function.
- Produces evidence that a valid temporary repository is healthy and an invalid repository reports all intended findings without executing content.

- [ ] Build a temporary repository fixture with valid and invalid Markdown, Skills, indexes, and secret-like files.
- [ ] Add assertions for summary counts, deterministic ordering, redaction, and no network or process execution.
- [ ] Run the focused health and integration tests.
- [ ] Run the complete suite, build, and `git --no-pager diff --check`.
- [ ] Review the diff for scope creep and confirm current Draft PR files are not modified by this milestone.

## Review checklist

- [ ] No placeholder text or guessed interfaces remain.
- [ ] Every finding is path-safe, deterministic, and redacted.
- [ ] The report cannot claim healthy when an error finding exists.
- [ ] Existing close, rollback, ownership, heartbeat, fencing, and handoff tests remain untouched except for additive regression coverage.
- [ ] The feature remains local-only and has no automatic mutation path.
