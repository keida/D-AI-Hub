# Repository Health Check Design

## Purpose

Provide a local health check for a D-AI-Hub repository. Its repository
inspections are read-only and produce a deterministic report suitable for a
developer or agent before beginning work, without becoming a second control
plane. The command also runs workspace-supplied build and test scripts, so the
target must be trusted and those scripts may change repository state.

## Scope

The initial command is `npm run health-check -- --workspace <path>`.

It verifies:

1. the supplied path is a Git working tree;
2. the canonical Hub files and discovery indexes required by the current
   control plane are present;
3. repository-local Markdown relative links resolve to files inside the
   supplied repository;
4. the existing TypeScript build and Vitest suite complete successfully.

The command emits one structured report containing every completed check. A
clean result exits with `0`; a failed health check exits nonzero; a workspace
that cannot be safely inspected is reported as `blocked` with a nonzero exit.
After the workspace `build` and `test` scripts finish, the checker repeats the
working-tree inspection so script-created changes are reported as `unhealthy`.

## Boundaries

- The Git identity, required-file, Markdown-link, and working-tree checks are
  local inspections: they do not write files, stage, commit, push, pull, fetch,
  call Git remotes, or use credentials.
- The build and test checks execute arbitrary scripts supplied by the target
  workspace. Those scripts may write files, contact networks, or otherwise have
  side effects; use the command only with a trusted workspace.
- The health check itself has no GitHub Action, scheduler, native Chat/Work
  connector, Router, or direct network dependency.
- Bounded execution: each child command has a timeout and failures do not hide
  results from earlier checks.
- Safe reporting: command output is redacted before inclusion in the report.
- The health check is a normal npm command, not a new `@D-AI` lifecycle
  command.

## Architecture

`src/health/` owns the pure report model, filesystem checks, Markdown-link
validation, and a bounded local-command adapter. A thin CLI receives the
workspace path, calls the checker, prints JSON, and maps the aggregate report
to an exit code. `package.json` exposes that CLI as `health-check`.

Each check has a stable identifier, status, observation, and optional reason.
The aggregate report distinguishes `healthy`, `unhealthy`, and `blocked` so an
agent can fail closed when the repository identity or required control-plane
files cannot be established.

## Error handling

Invalid arguments, a missing path, a non-Git path, and unreadable required
files are `blocked`. Broken links, a dirty working tree, failed build, or
failed test are `unhealthy`. A single `unhealthy` result does not stop later
safe checks; a `blocked` repository identity check prevents checks that would
otherwise operate on an untrusted path.

## Verification

Use real temporary Git repositories and real filesystem fixtures for focused
integration tests. Cover clean and dirty worktrees, missing required files,
valid and broken Markdown links, build/test command failures, timeout handling,
redaction, report/exit-code mapping, and the npm CLI seam. Run the focused
health tests, then the existing build and complete test suite before claiming
completion.

## Deferred work

CI integration, scheduled execution, remote repository freshness, branch
policy enforcement, and automatic repair remain outside this design and need
separate authorization.
