# Git line endings and hashed text artifacts

## When this matters

Use this note when JSONL or another byte-hashed text artifact verifies before Git transport but fails verification after checkout on Windows. Search terms: CRLF, LF, core.autocrlf, manifest hash, bundle integrity, Windows checkout, 换行转换.

## Verified lesson

Equivalent-looking text is not necessarily identical bytes. A checkout that changes LF to CRLF changes the hashed input. Keep the exporter and checked-out artifact byte-stable; do not weaken integrity checks to make a mismatched bundle importable.

D-AI-Hub applies a narrow repository attribute to its transfer JSONL:

```gitattributes
memory-bundles/**/records.jsonl text eol=lf
```

This is a project-scoped rule, not a reason to change a user's global Git settings or normalize unrelated files. Other artifact formats and existing tracked content need their own byte-level verification.

## Evidence and limits

- The project's [BUG-004 record](../../projects/d-ai-hub/BUGS.md#bug-004--windows-git-checkout-could-invalidate-a-memory-bundle-digest) records the reproduced extra CR byte and the fix. Its historical full-suite and transfer results are not fresh results for this note.
- The current [attribute](../../.gitattributes) is exercised by the [real-Git regression](../../tests/memory/memory-git-transfer.test.ts): it creates an isolated repository with `core.autocrlf=true`, stages an LF-only JSONL fixture, materializes it from Git's index, and compares the bytes exactly.
- On 2026-08-30, `npm test -- tests/memory/memory-git-transfer.test.ts` passed 1/1 in the working checkout. This proves that fixture's byte preservation under the tested Git configuration; it is not a new network transfer, second-physical-device run, or full-suite result.

For D-AI-Hub export/import steps, use the existing [manual transfer runbook](../../docs/memory-sync-manual-workflow.md), not a duplicate procedure here. Recheck this lesson if the exporter encoding, artifact paths, attributes, or materialization path changes.
