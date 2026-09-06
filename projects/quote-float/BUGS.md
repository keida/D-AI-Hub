# Bugs

## Open

### GOV-001 — Historical ticket labels conflict with later acceptance evidence

- Severity: low
- Status: deferred documentation correction
- First observed: 2026-09-06
- Expected: ticket metadata reflects the latest accepted dependency chain.
- Actual: `TICKET-MAP.md` still labels QF-WPF-001 through QF-WPF-004 as READY/BLOCKED, and `QF-WPF-007.md` still says BLOCKED while the map says NOT STARTED.
- Evidence: the QF-WPF-004A, QF-WPF-005, and QF-WPF-006 ticket/evidence chain supersedes the earlier dependency labels; QF-WPF-006 has direct Boss acceptance evidence.
- Disposition: canonicalize the current state here; defer edits to the source repository metadata because this task is restricted to D-AI-Hub bootstrap.

### GOV-002 — Human-facing project name is not a D-AI runtime continuation alias

- Severity: medium
- Status: observed dogfood UX limitation
- First observed: 2026-09-06
- Expected: display-name continuation would select the Quote Float durable task.
- Actual: the current runtime resolves exact continuation from the canonical remote repository slug `codex-quota-float`; a display-name failure is expected fail-closed behavior when no alias exists.
- Evidence: Rev 1 acceptance requires exact `@D-AI status` with zero arguments and exact `@D-AI continue codex-quota-float`; any `@D-AI continue Quote Float` or `继续 Quote Float` mismatch must be recorded as `DOGFOOD UX OBSERVATION — EXACT DISPLAY NAME / REPOSITORY SLUG MISMATCH`.
- Disposition: do not alter D-AI architecture, add aliases, or introduce fuzzy matching in this bootstrap.

### GOV-003 — Global installed entry cannot resolve the canonical runtime root

- Severity: medium
- Status: open
- First observed: 2026-09-06
- Expected: the self-contained installed D-AI Skill executes the current canonical D-AI runtime.
- Actual: the installed source is canonical and has no worktree dependency, but its launcher cannot resolve the npm project root from the global installation location; the direct global invocation returns no structured runtime result and exit code `-4058`. Repository-local activation succeeds separately.
- Evidence: installed source blobs match the accepted canonical Skill files; direct repository-local status/continuation checks select the unique durable task; direct global invocation remains blocked.
- Disposition: do not alter the canonical Skill, add aliases, guess a repository, or restore a worktree dependency. Resolve through a separately authorized supported installation/runtime bridge or retain this as an onboarding blocker.

## Resolved

None recorded by this bootstrap.
