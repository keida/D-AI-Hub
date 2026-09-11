# D-AI-Hub Short Commands

D-AI V1 exposes a Codex-first control path with natural language as its default entry and `@D-AI` as an explicit override. Commands are repository conventions, not built-in commands. Codex is the supported runtime activation surface; ChatGPT Web is for ordinary discussion and viewing only. The authoritative behavior is defined in the root `AGENTS.md`. The `@D-AI update` workflow remains internal when durable outcomes should be captured during a session.

## Four layers

1. **Natural-language intent** — ordinary project requests are classified into discussion, status, continuation, delivery, close, rollback, sync, or establish.
2. **Explicit override** — when a message begins with `@D-AI`, the named command has priority over later natural-language text.
3. **Codex Skill activation** — the `d-ai` Skill invokes the real runtime through `skills/custom/d-ai/scripts/invoke.ps1`.
4. **CLI implementation** — the internal `npm run d-ai -- --workspace <path> --command <text>` entry used by the Skill. Codex-only `--task <task-id>` is an explicit override.

The logical prefix is a D-AI-Hub protocol, not a Codex built-in command. The Skill is the supported Codex activation surface.

## Quick reference

Natural-language examples:

| Request | Route | Durable mutation |
| --- | --- | --- |
| `这个方案是不是应该改成 SQLite？` | discussion | No |
| `那就改成 SQLite。` | bounded delivery when configured | Only with explicit authority |
| `查看 D-AI-Hub 当前状态` | status | No |
| `继续 D-AI-Hub，修复并创建 PR` | continuation/delivery | Only with explicit authority |
| `fix the project and create a PR` | bounded delivery when configured | Only with explicit authority |

Questions, status requests, and ambiguous requests are read-only. No durable task is created or mutated for those paths.

Risk levels: Level 0 = read-only; Level 1 = local reversible implementation; Level 2 = publication; Level 3 = irreversible/destructive action. Verification tiers are a separate axis: Tier 1 covers ordinary local checks, Tier 2 covers critical local verification, and Tier 3 covers publication/remote evidence. Tier 1 and Tier 2 work do not publish by default. Publication authority is required at the commit/push/PR/CI boundary.

| Command | Purpose |
| --- | --- |
| `@D-AI continue <task-or-project>` | Resume the active Codex task after workspace and ownership checks. |
| `@D-AI status` | Show the uniquely discovered active task for the current workspace, or fail closed. |
| `@D-AI close` | Verify local durable state, ownership, recovery, and project-memory outcomes; complete a local close by default and return `YES`, `NO`, or `BLOCKED`. |
| `@D-AI rollback` | Perform an explicitly authorized, durable, auditable rollback or fail closed. |

`@D-AI establish`, `@D-AI sync`, and internal `@D-AI update` remain setup/maintenance workflows rather than the daily V1 command set. There is no new user-facing `@D-AI deliver` command. Cross-environment `handoff` remains a contract/reference command and is Future/Deferred for product delivery.

For `status` and `close`, the runtime automatically selects the unique active durable task whose persisted workspace identity matches the current workspace. Zero matches, multiple matches, and ownership conflicts fail closed. Close is local by default; an explicit publication close requires publication intent and authority. Add `--task <task-id>` only when the result asks for explicit disambiguation or recovery.

## `@D-AI establish`

Use mainly once per new Codex/agent environment, or whenever setup/authentication is uncertain.

Expected outcome:
- canonical repo and `main` are identified;
- repository access is verified as far as the environment permits;
- `AGENTS.md`, README, indexes, canonical Skills, and D-AI-Hub project state are read;
- unresolved environment blockers are reported explicitly.

Example:

```text
@D-AI establish
```

Then you can continue with a task in the same prompt:

```text
@D-AI establish, then review my current DeepSeek Harness project setup.
```

## `@D-AI sync`

Use when canonical GitHub freshness must be explicitly verified, such as after switching clients, after a long pause, or when remote changes are suspected. Normal project continuation does not require this command.

Expected outcome:
- actual checkout, branch, HEAD, worktree, remote, and freshness evidence are distinguished;
- latest available `main` is obtained only when a safe fast-forward update is possible;
- dirty, feature-branch, detached, diverged, authentication, and read-only limitations are disclosed;
- local context reads are not reported as verified GitHub synchronization.

Example:

```text
@D-AI sync，然后核实 D-AI-Hub 的 canonical main 是否有其他客户端更新。
```

## Internal `@D-AI update` workflow

Use internally during a session when something has become worth keeping. It is not promoted as a primary daily command.

For an active project, first replace the current checkpoint in `STATUS.md` when the task, working state, verified evidence, blocker, active plan, file scope, or next action has changed meaningfully. This lets later continuation start from one concise current-state summary rather than rereading old chat or rebuilding the plan.

Good candidates:
- a durable technical insight;
- an approved decision;
- verified project progress;
- a useful source/reference;
- a reusable workflow or prompt.

Do not save:
- casual/transient chat;
- a command-by-command activity log;
- repeated unchanged checkpoints;
- unverified speculation as fact;
- passwords, tokens, cookies, keys, or credentials;
- unauthorized employer-confidential information;
- duplicate canonical copies.

Example:

```text
@D-AI update
```

Or with scope:

```text
@D-AI update — save the architecture decision and the reusable Electron packaging lesson, but not the temporary debugging notes.
```

## `@D-AI close`

Use when meaningful work is finished for the session.

Expected outcome:
- local durable task state and the touched project's Markdown memory reflect verified reality and the next action;
- GitHub push success and exact remote repository/ref/SHA evidence are checked only for an explicit publication close;
- missing ownership, recovery, or durable context can return `NO`/`BLOCKED`; missing credentials or remote evidence blocks only an explicit publication close;
- no files, processes, repositories, or unrelated user changes are deleted or hidden.

Example:

```text
@D-AI close
```

## Recommended daily pattern

```text
Continue <project>
→ Fast Read
→ Write Gate before the first modification
→ do the work
→ local focused verification and @D-AI close when durable work is ready
```

Use a separate milestone/publication decision before commit, push, PR, CI, or publication close. `@D-AI 整理` is implemented as a local-only curation seam: the handling agent may pass a selected versioned current-context JSON payload to the Codex Skill, which validates and stores only eligible facts in the OS-local SQLite memory path (or an explicit absolute test override). It never crawls chat history, creates durable tasks, or publishes to GitHub; missing or ambiguous project identity keeps project-memory curation fail-closed.

An internal close request may set `publicationRequested: true` and provide `publicationAuthority: { grantedBy, allowCommit: true, allowPush: true }`. The default omitted flag is local close. This request flag is not implicit commit authority.

When a durable outcome is worth capturing before the session ends, run the internal `@D-AI update` workflow before continuing.

Within one uninterrupted session, continue from the already loaded state instead of rereading unchanged project files. Refresh the project's current checkpoint only after meaningful change.

Use `@D-AI sync` only when an explicit canonical-freshness check is needed. It remains unsupported/fail-closed with zero durable writes in the current runtime and is not a publication command. The overloaded word `同步` must be clarified before any GitHub action.

`@D-AI establish` is normally not part of the daily loop once an environment has been successfully established.

## Request composition

Any ordinary project request can use natural language without a D-AI command prefix. For example:

```text
继续 DeepSeek Harness Desktop，先读取 STATUS 和未解决 BUGS，再决定下一步。
```

For a change request, the visible delivery path must have explicit publication authority. Without it, the request is blocked before commit, push, or PR creation. Delivery never merges or performs destructive Git actions.

The raw CLI can classify the request and return an execution-required Delivery Result, but it does not simulate implementation, tests, Git, or CI. The canonical Codex Skill/agent must continue Level 1 work through an attached execution seam before any implementation or publication evidence is claimed.

The response carries a structured `agentExecutionDirective` containing the original request, project/task, resume flag, risk, endpoint, publication-authority requirement, and `mergeAllowed: false`. The current Codex agent consumes it immediately under the normal gates; the user does not need to type another command.

Delivery receipts keep typecheck timing separate, show observed Windows/Linux states independently, and identify the precise stage that blocked (`context-read`, `workspace-prepare`, `implementation`, `focused-test`, `typecheck`, `publication-authority`, `publication`, `ci-wait`, or `review-packet`).

When a D-AI command prefix is used, the Codex Skill should invoke the runtime first and then continue the remainder of the user's request. A response that only explains the convention is not activation.
