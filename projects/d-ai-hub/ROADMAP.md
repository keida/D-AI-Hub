# Roadmap

## Now

- Apply the safe cross-client sync and write rules in `docs/workflow.md`; new environments must verify GitHub authentication before treating local state as current.
- Keep `STATUS.md`, `DECISIONS.md`, `BUGS.md`, and `REFERENCES.md` current after meaningful work.
- Add durable knowledge only when it has a clear canonical home and a useful retrieval path.

## Next

- Register additional project records only when there is active project state to preserve.

## Deferred to V1.2+

- Optional repository health check for broken links, Skill frontmatter, secret-like files, and stale indexes.
- Optional GitHub Actions validation after real repository usage justifies it.
- Optional source-ingestion workflow.
- Optional semantic search or RAG after file-based retrieval is demonstrably insufficient.
- Optional cross-agent bootstrap guidance for additional compatible clients.

## Not planned

- Storing credentials or confidential employer material.
- Vendoring large third-party Skill repositories without a deliberate local fork.
- Automatic sync daemons, background ingestion, or vector infrastructure in V1.
