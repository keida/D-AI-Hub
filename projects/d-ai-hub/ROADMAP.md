# Roadmap

## Now

- Apply the safe cross-client sync and write rules in `docs/workflow.md`; new environments must verify GitHub authentication before treating local state as current.
- Keep BUG-001 open for authentication behavior in affected environments; BUG-002 sync behavior is resolved for the verified current workflow.
- Keep `STATUS.md`, `DECISIONS.md`, `BUGS.md`, and `REFERENCES.md` current after meaningful work.
- Add durable knowledge only when it has a clear canonical home and a useful retrieval path.

## Completed in current V1.2 scope

- P0 consistency audit and documentation alignment: command documentation is explicit about ChatGPT Web, Codex, and compatible agents, while `@D-AI update` remains an internal workflow.
- Integrated the progressive project-memory loading revision in `ffe6c59` and documented the Release Gate result.
- Reviewed Fast Read, Write Gate, and Release Gate behavior, including the replace-in-place `STATUS.md` checkpoint.
- Reviewed the manual matrix distinguishing ordinary local continuation from explicit `@D-AI sync`; no documentation contradiction was found.

## Next

- Measure context-loading time, files read, and repeated checks across at least five real project resumptions before considering a context pack.
- Register additional project records only when there is active project state to preserve.

## Deferred to V1.2+

- Optional automated repository health check for broken links, Skill frontmatter, secret-like files, and stale indexes; the current P0 audit is manual and does not introduce an automation system.
- Optional GitHub Actions validation after real repository usage justifies it.
- Optional source-ingestion workflow.
- Optional semantic search or RAG after file-based retrieval is demonstrably insufficient.
- Optional cross-agent bootstrap guidance for additional compatible clients.

## Not planned

- Storing credentials or confidential employer material.
- Vendoring large third-party Skill repositories without a deliberate local fork.
- Automatic sync daemons, background ingestion, or vector infrastructure in V1.
