# D-AI-Hub Short Commands

D-AI-Hub exposes two primary lifecycle command prefixes and one optional synchronization check for ChatGPT Web, Codex, and compatible agents. They are repository conventions, not built-in commands. Their authoritative behavior is defined in the root `AGENTS.md`. The `@D-AI update` workflow remains available internally when durable outcomes should be captured during a session. The actions each client can perform still depend on its available GitHub access and permissions.

## Three layers

1. **Logical command** — the user-facing protocol, such as `@D-AI status` or `@D-AI close`.
2. **Codex Skill activation** — when a message begins with `@D-AI`, the `d-ai` Skill invokes the real runtime through `skills/custom/d-ai/scripts/invoke.ps1`.
3. **CLI implementation** — the internal `npm run d-ai -- --workspace <path> --command "@D-AI status"` entry used by the Skill. Codex-only `--task <task-id>` is an explicit override.

The logical prefix is a D-AI-Hub protocol, not a Codex built-in command. The Skill is the supported Codex activation surface.

## Quick reference

| Command | Purpose |
| --- | --- |
| `@D-AI establish` | Establish D-AI-Hub in a new or uncertain environment. |
| `@D-AI sync` | Optionally verify canonical GitHub freshness when remote state matters. |
| `@D-AI status` | Show the uniquely discovered active task for the current workspace, or fail closed. |
| `@D-AI close` | Finish the session by updating project memory/knowledge and syncing durable changes. |

For `status` and `close`, the runtime automatically selects the unique active durable task whose persisted workspace identity matches the current workspace. Zero matches, multiple matches, and ownership conflicts fail closed. Add `--task <task-id>` only when the result asks for explicit disambiguation or recovery.

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
- durable session outcomes are captured;
- touched project `STATUS.md` reflects verified reality and the next action;
- decisions, bugs, roadmap, references, reusable knowledge, and indexes are updated as needed;
- stale machine-specific/transient details are removed or generalized;
- security check is performed;
- changes are committed/pushed when possible, with final sync status reported.

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
→ Release Gate and @D-AI close when durable work is ready
```

When a durable outcome is worth capturing before the session ends, run the internal `@D-AI update` workflow before continuing.

Within one uninterrupted session, continue from the already loaded state instead of rereading unchanged project files. Refresh the project's current checkpoint only after meaningful change.

Use `@D-AI sync` only when an explicit canonical-freshness check is needed. It is not required merely to make the agent read local project context.

`@D-AI establish` is normally not part of the daily loop once an environment has been successfully established.

## Request composition

Ordinary project continuation can name the project and task without a D-AI command prefix. For example:

```text
继续 DeepSeek Harness Desktop，先读取 STATUS 和未解决 BUGS，再决定下一步。
```

When a D-AI command prefix is used, the Codex Skill should invoke the runtime first and then continue the remainder of the user's request. A response that only explains the convention is not activation.
