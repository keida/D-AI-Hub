# Repository Health Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local, read-only `npm run health-check -- --workspace <path>` command that reports repository health without modifying the checked repository.

**Architecture:** A new `src/health/` module owns the report schema and deterministic checks. It reuses the existing bounded, redacting `runCommand` adapter for local Git and npm commands; a thin CLI prints JSON and maps aggregate health to exit codes. No `@D-AI` command parsing, runtime lifecycle logic, remote access, or scheduler is changed.

**Tech Stack:** TypeScript, Node.js filesystem APIs, the existing `runCommand` adapter, `tsx`, Vitest, real temporary Git repositories.

**Spec:** `docs/superpowers/specs/2026-08-28-repository-health-check-design.md`

## Global Constraints

- Run only local, read-only Git and npm commands; never fetch, pull, push, stage, commit, write repository files, or call a remote API.
- Use the existing `runCommand` output redaction, timeout, output-limit, and process-tree cleanup behavior.
- Use `0` for `healthy`, `1` for `unhealthy`, and `2` for `blocked`.
- A blocked repository-identity check prevents later repository-dependent checks; an unhealthy check does not suppress other safe checks.
- Test with real temporary directories, real `git init`, real Markdown files, and real npm scripts. Do not use mock-based tests for normal behavior.
- Do not commit or push unless separately authorized by the user.

---

### Task 1: Define the health-check domain and repository checks

**Files:**
- Create: `src/health/repository-health-check.ts`
- Test: `tests/health/repository-health-check.test.ts`

**Interfaces:**
- Consumes: `runCommand`, `CommandExecutionError`, and `redactSensitiveText` from `src/adapters/command-runner.ts`.
- Produces: `runRepositoryHealthCheck(input)` returning a stable JSON-serializable `RepositoryHealthReport`.

- [ ] **Step 1: Write real-fixture tests for repository identity, required files, and dirty state**

Create a helper that creates a temporary directory, initializes Git with `git init`, writes the canonical file set, and uses `git add`/`git commit` only inside that disposable fixture. Test these observable results:

```ts
const report = await runRepositoryHealthCheck({ workspacePath: fixture.path });
expect(report.status).toBe("healthy");
expect(report.checks).toContainEqual(expect.objectContaining({ id: "repository", status: "passed" }));

await writeFile(join(fixture.path, "untracked.md"), "# dirty\n");
const dirty = await runRepositoryHealthCheck({ workspacePath: fixture.path });
expect(dirty.status).toBe("unhealthy");
expect(dirty.checks).toContainEqual(expect.objectContaining({ id: "working-tree", status: "failed" }));
```

- [ ] **Step 2: Run the focused test to establish failure**

Run: `npm test -- tests/health/repository-health-check.test.ts`

Expected: FAIL because `runRepositoryHealthCheck` and its report types do not exist.

- [ ] **Step 3: Implement stable report types and bounded Git checks**

Define explicit types and fixed check identifiers:

```ts
export type HealthStatus = "healthy" | "unhealthy" | "blocked";
export type HealthCheckStatus = "passed" | "failed" | "blocked" | "skipped";
export interface HealthCheckResult { readonly id: string; readonly status: HealthCheckStatus; readonly observation: string; }
export interface RepositoryHealthReport { readonly status: HealthStatus; readonly workspacePath: string; readonly checks: readonly HealthCheckResult[]; }
export async function runRepositoryHealthCheck(input: { readonly workspacePath: string; readonly timeoutMs?: number }): Promise<RepositoryHealthReport>;
```

Resolve the input path, run `git rev-parse --show-toplevel`, require that the reported root matches the resolved workspace root, then run `git status --porcelain=v1 --untracked-files=all`. Catch `CommandExecutionError`, retain only its redacted bounded diagnostics in the observation, and classify an uninspectable path as `blocked`.

- [ ] **Step 4: Add required-file checks**

Check these exact repository-relative paths with `stat`/`readFile`: `AGENTS.md`, `README.md`, `indexes/SKILLS.md`, `indexes/KNOWLEDGE.md`, `indexes/PROJECTS.md`, and `projects/d-ai-hub/STATUS.md`. A missing or unreadable path adds a `required-files` check with status `blocked`; it must not run Markdown, build, or test checks afterward.

- [ ] **Step 5: Re-run the focused repository tests**

Run: `npm test -- tests/health/repository-health-check.test.ts`

Expected: PASS for clean, dirty, non-Git, and missing-required-file cases.

### Task 2: Add tracked-Markdown link and build/test checks

**Files:**
- Modify: `src/health/repository-health-check.ts`
- Modify: `tests/health/repository-health-check.test.ts`

**Interfaces:**
- Consumes: Task 1 `RepositoryHealthReport` and `HealthCheckResult`.
- Produces: `markdown-links`, `build`, and `test` results appended in deterministic order.

- [ ] **Step 1: Write real-fixture tests for Markdown links and continued checks**

Create tracked Markdown fixtures containing `./guide.md`, `../outside.md`, `#anchor`, and `https://example.com`. Assert that local in-root targets pass, fragment/external targets are ignored, and a missing local target makes only the `markdown-links` check fail while `build` and `test` still run.

```ts
expect(report.checks).toContainEqual(expect.objectContaining({ id: "markdown-links", status: "failed" }));
expect(report.checks).toContainEqual(expect.objectContaining({ id: "build", status: "passed" }));
expect(report.checks).toContainEqual(expect.objectContaining({ id: "test", status: "passed" }));
```

- [ ] **Step 2: Run the focused test to establish failure**

Run: `npm test -- tests/health/repository-health-check.test.ts`

Expected: FAIL because the new check identifiers are absent.

- [ ] **Step 3: Implement tracked-Markdown validation**

Use `git ls-files -z -- '*.md'` so generated, untracked, ignored, and `.git` content is never scanned. Extract Markdown destinations, strip optional titles and `#fragment`, skip absolute URLs, mail links, anchors, and protocol-relative URLs, then resolve remaining paths. Mark `markdown-links` failed when a target is missing or resolves outside the repository root; include the redacted relative source and destination in the observation.

- [ ] **Step 4: Implement bounded build and test checks**

Run the workspace-local package manager command with explicit arguments and the Task 1 timeout/output bound:

```ts
await runCommand({ command: npmCommand, arguments: ["run", "build"], cwd: workspacePath, timeoutMs, maxOutputBytes });
await runCommand({ command: npmCommand, arguments: ["test"], cwd: workspacePath, timeoutMs, maxOutputBytes });
```

Derive `npmCommand` from the platform (`npm.cmd` on Windows, `npm` otherwise). Convert `CommandExecutionError` into a failed check without throwing away the later check. Add a temporary fixture script that exceeds a short injected timeout and assert its `build` result is failed with redacted diagnostics.

- [ ] **Step 5: Re-run the focused health tests**

Run: `npm test -- tests/health/repository-health-check.test.ts`

Expected: PASS for valid/broken links, command failure, timeout, redaction, and all report aggregation cases.

### Task 3: Expose the local CLI and npm script

**Files:**
- Create: `src/health/health-check-cli.ts`
- Create: `tests/health/health-check-cli.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `runRepositoryHealthCheck` from Task 1/2.
- Produces: JSON stdout and exit codes `0`, `1`, or `2`; package script `health-check`.

- [ ] **Step 1: Write CLI parsing and exit-code tests**

Export a callable seam rather than testing `process.exit` directly:

```ts
const result = await runHealthCheckCLI(["--workspace", fixture.path]);
expect(result.exitCode).toBe(0);
expect(result.report.status).toBe("healthy");

await expect(runHealthCheckCLI([])).rejects.toThrow(/--workspace/i);
```

Add real temporary-fixture cases yielding `unhealthy` and `blocked`, asserting exit codes `1` and `2` respectively.

- [ ] **Step 2: Run the CLI test to establish failure**

Run: `npm test -- tests/health/health-check-cli.test.ts`

Expected: FAIL because the CLI module and package script do not exist.

- [ ] **Step 3: Implement the CLI and package script**

Require exactly one nonempty `--workspace <path>` argument, invoke `runRepositoryHealthCheck`, print only `JSON.stringify(report, null, 2)`, and map aggregate status to the prescribed exit code. Add this exact script to `package.json`:

```json
"health-check": "tsx src/health/health-check-cli.ts"
```

Use the same direct-invocation guard style as `src/entry/codex-cli.ts`; redact thrown error messages before producing a `blocked` JSON report.

- [ ] **Step 4: Document local use and boundaries**

Add a concise README section with:

```text
npm run health-check -- --workspace <repository-path>
```

State that it is local/read-only, does not fetch or contact GitHub, reports dirty state as unhealthy, and does not replace `@D-AI` lifecycle commands or release gates.

- [ ] **Step 5: Re-run the focused CLI tests**

Run: `npm test -- tests/health/health-check-cli.test.ts`

Expected: PASS for argument handling, JSON report mapping, and `0`/`1`/`2` exits.

### Task 4: Verify the full integration and record project state

**Files:**
- Modify: `projects/d-ai-hub/STATUS.md`
- Test: `tests/health/repository-health-check.test.ts`
- Test: `tests/health/health-check-cli.test.ts`

**Interfaces:**
- Consumes: completed health checker and CLI from Tasks 1-3.
- Produces: verified implementation evidence and an accurate next action.

- [ ] **Step 1: Run the real command against the implementation worktree**

Run: `npm run health-check -- --workspace .`

Expected: JSON report with every configured check. If it reports an expected dirty worktree during development, record that fact; do not suppress or weaken the dirty-state check.

- [ ] **Step 2: Run focused tests and the existing validation suite**

Run:

```text
npm test -- tests/health/repository-health-check.test.ts tests/health/health-check-cli.test.ts
npm run build
npm test
git diff --check
```

Expected: all selected and repository tests pass, build exits `0`, and the diff has no whitespace errors.

- [ ] **Step 3: Inspect the complete intended diff and secret-like additions**

Inspect only the expected source, tests, package script, README, and `STATUS.md`. Scan additions for credential-shaped values using the existing redaction conventions; do not treat ordinary documentation words such as “secret” as credentials.

- [ ] **Step 4: Update the checkpoint after verified implementation**

Replace the current checkpoint with the verified command behavior, test/build evidence, remaining deferred CI/scheduler work, and the next concrete action. Do not mark the feature released, committed, pushed, or merged unless those actions are separately authorized and verified.

- [ ] **Step 5: Obtain independent review before any release action**

Have a fresh reviewer inspect scope, command safety, test evidence, and documentation. Address actionable findings, rerun the affected verification, then ask the user whether to commit, push, open a PR, or merge.
