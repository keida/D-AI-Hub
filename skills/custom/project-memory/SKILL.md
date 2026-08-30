---
name: project-memory
description: Use when starting, resuming, updating, or closing a project in D-AI-Hub so project state is explicit and does not depend on old chat history.
---

# Project Memory

Maintain project continuity under `projects/<project>/`.

This Skill maintains Markdown checkpoints, not full chat history or an automatic SQLite/Codex Memory hook. Apply the repository Write Gate before durable changes and retain existing user work.

## Progressive read order when resuming a project

Start with the smallest current-state read, then expand only when the task requires it:

1. `STATUS.md` — current state, checkpoint, blockers, and next action.
2. Read the one project file that matches the task:
   - `BUGS.md` for a defect, failed verification, or behavior investigation.
   - `ROADMAP.md` for milestone sequencing, scope, or deferred work.
   - `DECISIONS.md` for an architectural or product choice.
3. Read the directly referenced workflow, source, or project file needed to perform the task.
4. Read `README.md` only when project purpose, scope, or architecture is unclear.
5. Read `REFERENCES.md` only when an external source or repository link is needed.

For `@D-AI close`, a status conflict, a full audit, or an explicit request for complete project context, use the full order: `README.md`, `STATUS.md`, `DECISIONS.md`, `BUGS.md`, `ROADMAP.md`, then `REFERENCES.md`.

For a narrow continuation, do not reread unchanged project files whose content is not required by the current task. Report which files were read, which were skipped, and why when the distinction affects recovery confidence. Do not rely on previous chat history when the selected project files carry the state explicitly.

## Checkpoint admission

Save the minimum state needed for another agent to resume safely: current objective, meaningful completed work, verification scope, unresolved blockers, bounded authorization, and next action. Project state need not be reusable across projects to qualify.

- Update on a meaningful change in outcome, evidence, scope, blocker, decision, or next action. Otherwise leave the checkpoint unchanged; acknowledgements and repeated status checks create no new entry.
- Use a replace-in-place current checkpoint, not a command log. Keep a concise historical evidence item only when it still affects continuation; link to decisions, bugs, and roadmap instead of copying them.
- Separate **verified**, **reported/historical**, **proposed**, and **unresolved** state in ordinary prose. Passing one focused test does not establish full acceptance, production readiness, a remote merge, or a physical-device result.
- Preserve a suspected problem as an unresolved project question when it affects the next action; record observable symptoms in `BUGS.md`, not a guessed root cause as fact. Proposed decisions remain proposed until decided.
- Resolve short replies such as "1" against their explicit choice context. Save a material selected decision and its scope, not the reply itself; ask if the choice cannot be recovered. Prior permission for one operation does not become standing authorization in a new task or project.
- Ground current-state claims in the actual checkout and relevant evidence. If a checkpoint conflicts with current evidence, preserve the existing work, explain the conflict, and correct only what is supported and authorized.

## Update workflow

After meaningful project progress:
1. Update `STATUS.md` with what changed, what is verified, current blockers, and the next concrete action.
2. Add material, settled product or architecture choices to `DECISIONS.md` with their actual context and rationale. Repeated routine selections already covered by an existing decision do not create new entries; label undecided proposals separately.
3. Add newly discovered bugs to `BUGS.md`; mark fixed bugs resolved only after verification.
4. Update `ROADMAP.md` when scope, sequencing, or milestones change.
5. Add important source/document links to `REFERENCES.md` rather than scattering them across chat.
6. Update `indexes/PROJECTS.md` when a project is created, archived, renamed, or changes active status.

## Promotion and runtime memory

When a session yields reusable knowledge or stable cross-project context, read [knowledge-manager](../knowledge-manager/SKILL.md) and apply its admission, evidence, and deduplication workflow before promoting anything. Keep project-specific facts here, and link to the promoted canonical note. Workflow changes require their own authorization; do not silently turn a lesson into a governing rule.

Do not copy every checkpoint into all memory stores. If an authorized task explicitly includes a SQLite handoff, verify the intended database, workspace, scope, writer, and mode using the existing runtime contract. Store only the admitted handoff summary with source, recorded time, and evidence limits. Report actual put/get results separately from Markdown updates. Missing or mismatched binding means defer the runtime write, not guess or rebind it; new-chat auto-recall and synchronization remain unproven until separately exercised.

Codex-generated memory is host-managed and outside this Skill's write scope. A Hub `memory/` update does not modify it.

## Completion receipt

Report changed project files, verified evidence and its limits, unresolved items, and the next concrete action. Mention promoted knowledge/context only if actually written; use a brief grouped skip reason when no promotion qualified. State local-only/published status and any separately verified runtime result. A no-change review needs no durable receipt file.

## Canonical ownership

- Current execution state -> `STATUS.md`
- Durable project decision -> `DECISIONS.md`
- Defect lifecycle -> `BUGS.md`
- Future work -> `ROADMAP.md`
- External links and source provenance -> `REFERENCES.md`
- General reusable subject knowledge -> `knowledge/`, not the project folder

## Failure modes and required response

### Stale status
If `STATUS.md` conflicts with recent verified work, correct the supported claims when the Write Gate permits. If read-only scope, conflicting user edits, or unavailable evidence prevents a safe update, report the mismatch and proposed correction without writing or claiming the checkpoint is current.

### Undocumented decision
If implementation depends on a non-obvious product or architecture choice, record it in `DECISIONS.md` before treating it as settled.

### Chat-history dependency
If the project can only be resumed by searching an old conversation, capture the missing durable state in the project files.

### Resolved bug left open
Only mark a bug resolved after evidence of verification is available. Record the verification briefly.

### Project knowledge duplicated into general knowledge
Keep project-specific context in the project. Promote only reusable, generalized knowledge to `knowledge/` and link back if useful.

### Secret/confidential content
Do not store credentials, tokens, cookies, or unauthorized employer-confidential material in project memory.

## Completion check

Before ending meaningful project work, confirm:
- `STATUS.md` reflects verified reality, or an unapplied discrepancy and its write blocker are explicitly reported;
- material decisions needed for continuation are recorded without inventing rationale or approval;
- unresolved bugs remain visible;
- roadmap reflects current scope;
- the next session can resume without relying on chat history.
