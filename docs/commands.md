# D-AI-Hub Short Commands

D-AI-Hub defines four natural-language command prefixes for Codex and compatible agents. They are repository conventions, not built-in Codex commands. Their authoritative behavior is defined in the root `AGENTS.md`.

## Quick reference

| Command | Purpose |
| --- | --- |
| `@D-AI establish` | Establish D-AI-Hub in a new or uncertain environment. |
| `@D-AI sync` | Refresh canonical context before starting or resuming work. |
| `@D-AI update` | Persist durable outcomes from the current session without closing it. |
| `@D-AI close` | Finish the session by updating project memory/knowledge and syncing durable changes. |

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

Use at the beginning of normal work sessions.

Expected outcome:
- latest available `main` is obtained or freshness limitations are disclosed;
- relevant Skill, knowledge, and project state are loaded;
- project continuation uses repository state rather than remembered chat context.

Example:

```text
@D-AI sync，然后继续开发 DeepSeek Harness Desktop。
```

## `@D-AI update`

Use during a session when something has become worth keeping.

Good candidates:
- a durable technical insight;
- an approved decision;
- verified project progress;
- a useful source/reference;
- a reusable workflow or prompt.

Do not save:
- casual/transient chat;
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
@D-AI sync
→ do the work
→ @D-AI update (only when useful mid-session)
→ continue working
→ @D-AI close
```

`@D-AI establish` is normally not part of the daily loop once an environment has been successfully established.

## Command composition

The command prefix can be followed by normal task instructions. For example:

```text
@D-AI sync，然后继续 DeepSeek Harness Desktop，先读取 STATUS 和未解决 BUGS，再决定下一步。
```

The agent should execute the command protocol first, then continue the remainder of the user's request.
