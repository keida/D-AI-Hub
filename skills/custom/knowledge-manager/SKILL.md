---
name: knowledge-manager
description: Curate and retrieve reusable knowledge or stable cross-project memory in D-AI-Hub; assess value, evidence, duplicates, and conflicts before saving. Route project-only progress to project-memory.
---

# Knowledge Manager

Keep useful, evidence-backed information in `D-AI-Hub`. A capture may correctly produce no write.

This Skill governs Markdown in `knowledge/` and Hub `memory/`; it does not write Codex's generated memory store or automatically capture conversations into SQLite. Apply the repository Write Gate before modifying files. A request to curate information does not authorize installing hooks, changing workflow rules, deleting existing records, or publishing Git changes.

## Admission by information type

First identify a future use: what decision, recurring task, or explanation will this information improve? If no concrete use can be identified, skip it. Judge each candidate separately; neither time spent nor repetition proves value.

| Candidate | Admission evidence | Canonical destination |
|---|---|---|
| Reusable solution or discovered technique | Specific applicability, actual verification, and a useful lesson beyond copying documentation | Narrowest domain under `knowledge/` |
| Durable reference fact or conceptual explanation | Relevant to the user's work, attributable to a reliable source; record conditions or date when changeable | `knowledge/`; link to the source rather than reproduce it |
| Stable personal context or cross-project preference | Explicit user statement with clear scope; one statement can suffice | Hub `memory/`; link to existing governing rules instead of duplicating them |
| Observed behavior or inferred preference | Not confirmation: repeated actions and user silence do not establish a standing preference | Keep out of authoritative memory; ask only if the distinction matters to future work |
| Current progress, unresolved issue, or project decision | Use the project-specific checkpoint criteria | Route to [project-memory](../project-memory/SKILL.md) |
| Reusable executable workflow | Demonstrated repeatable procedure, not merely a fact | Propose a Skill/prompt change within its own authorization scope |

Acknowledgements, isolated option numbers, unchanged status, raw logs, and speculative conclusions are not independent memories. An option number with unambiguous context may establish the selected decision and its bounded authorization, not a permanent permission.

## Core workflow

When capturing knowledge or stable context:

1. Extract the smallest useful claims from the authorized material and apply the admission table. Do not harvest unrelated chats or bulk-import a transcript.
2. Reject secrets, authentication artifacts, and unauthorized confidential material before writing any candidate or receipt. Store only necessary non-sensitive context; a pattern scanner cannot establish permission or privacy safety.
3. Choose one canonical owner. For knowledge, use the narrowest existing domain: `ai/`, `data/`, `development/`, `banking/`, or `career/`. Personal context belongs in Hub `memory/`, not a parallel knowledge note.
4. Search that owner and its relevant index by topic, synonyms, and trigger/problem; read the closest matches. Matching IDs or filenames alone is not semantic deduplication. If existing state cannot be read reliably, defer the affected write.
5. Decide: **ADD** a distinct useful claim; **UPDATE** the existing owner with new evidence or an explicit correction; **NOOP** when already covered; **DEFER** when evidence, scope, or a conflict is unresolved; **REJECT** disallowed content. Keep skipped candidates out of permanent inboxes unless a separate triage store was requested.
6. Write a concise conclusion with its future use/applicability and evidence. Identify user-confirmed context, observed results, and source-backed facts distinctly. Include a source locator or a short attributed statement; add an observation date/version or review condition for changing facts. Do not invent confidence scores or convert a hypothesis into a verified fact.
7. Link related canonical notes. Update `indexes/KNOWLEDGE.md` when discovery changes; for Hub memory, keep new notes discoverable from `memory/README.md`. Indexes hold pointers, not duplicate paragraphs.
8. Read back the changed content and check evidence, scope, links, and contradictions before reporting it saved.

When retrieving knowledge or stable context:
1. Start with `indexes/KNOWLEDGE.md` for subject knowledge or `memory/README.md` for stable cross-project context.
2. Follow only the relevant domain or memory pointers.
3. Prefer canonical notes over repeated summaries in project or prompt files.
4. If two notes conflict, surface the conflict instead of silently choosing one.
5. Retrieve only the material relevant to this task. Check changing facts against their date/conditions; distinguish recorded evidence from newly verified state. Age alone is not proof of staleness.

## Maintenance and conflict handling

- Keep accurate, useful notes unchanged; a review alone does not justify a timestamp or cosmetic rewrite.
- Update a fact only with supporting evidence. A newer explicit preference supersedes the older one within the same scope; preserve enough dated supersession context to avoid reviving the old rule. An inferred preference never overrides an explicit instruction.
- Surface contradictory claims with their sources and scope. If the current answer cannot be established, defer the disputed change and report the verification gap. Lack of local evidence is not proof that a claim is false.
- Consolidate only when the notes address the same retrieval need; similar topics with distinct causes or audiences may deserve separate notes. Preserve unique evidence and inbound links. Recommend destructive merges, deletion, or archival until separately authorized; general curation is not deletion permission.
- Review expiry-sensitive facts when they are used or when maintenance is requested. This Skill schedules no background cleanup and installs no automatic observer.

## Capture receipt

Report the actual files added or updated, the useful outcome and evidence, and a brief grouped reason for NOOP/DEFER/REJECT where relevant. Never echo rejected secret values. If nothing qualifies, say so without creating a receipt file or an empty note.

State local-only versus published state. Markdown persistence is not proof of SQLite insertion, Codex Memory injection, successful future retrieval, or cross-device synchronization.

## Storage rules

- One durable fact or concept should have one canonical home.
- Indexes link to knowledge; they do not duplicate full knowledge.
- Prompts contain reusable instructions, not factual reference material.
- Memory contains cross-project context, not general subject knowledge.
- Projects contain project status and project-specific decisions.

## Failure modes and required response

### Duplicate knowledge
If an existing note already covers the claim, link to it and use NOOP. Update only when new evidence materially changes confidence, applicability, or the next useful action; an equivalent reconfirmation alone does not warrant another entry or timestamp. Do not create a parallel note merely because wording differs.

### Ambiguous storage location
Choose based on scope:
- reusable subject knowledge -> `knowledge/`
- one project's state or decision -> `projects/<project>/`
- stable cross-project context -> `memory/`
- reusable instruction -> `prompts/` or a Skill
If ambiguity remains, ask before writing.

### Secret or credential capture
Do not store it. State that D-AI-Hub must not contain secrets and recommend an approved secret manager instead.

### Unauthorized employer-confidential material
Do not copy it into D-AI-Hub. Keep only non-confidential personal learning or an abstract note that does not reveal protected information.

### Over-copying a source
Summarize in your own words and preserve a source link. Do not paste long copyrighted source text into the knowledge base.

### Stale indexes
Whenever a canonical note is moved, renamed, or promoted to a key topic, update the relevant index in the same change.

## Completion check

Before claiming a knowledge update is complete, confirm:
- canonical location is correct;
- each saved claim has a concrete future use and an attributable basis;
- no duplicate was introduced;
- no secret/confidential material was stored;
- related links are valid in intent;
- relevant index entries are current.

Selective rule provenance and rejected upstream defaults: [knowledge curation patterns](../../external/knowledge-curation-patterns.md). These are references, not additional Skills to invoke.
