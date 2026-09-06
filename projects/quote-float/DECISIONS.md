# Decisions

## 2026-09-06 — Use evidence-backed WPF R1 as the active product baseline

**Context**

The repository contains a protected legacy WinForms implementation and a newer WPF R1 implementation with sequential runtime and Boss acceptance evidence.

**Decision**

Treat the .NET 8 WPF implementation and the accepted QF-WPF-001 through QF-WPF-006 checkpoints as the active product baseline. Preserve legacy WinForms dirty files unless a later task explicitly authorizes changes.

**Rationale**

QF-WPF-006 has direct Boss acceptance evidence, and its dependency chain records the accepted Full, Orb, interaction, topmost, edge, and work-area foundations.

**Consequences**

- QF-WPF-007 is the next product ticket.
- Earlier stale ticket labels do not override later accepted evidence.
- This record does not authorize product implementation, commit, push, or merge.

**Revisit trigger**

Newer runtime or Boss evidence contradicts the accepted WPF R1 chain.

## 2026-09-06 — Keep product state and runtime task state separate

**Context**

D-AI-Hub project Markdown and the D-AI durable runtime serve different purposes.

**Decision**

This project directory owns concise canonical product state. The D-AI runtime owns task identity, ownership, handoff, recovery, and execution state. The human-facing name is `Quote Float`; the current runtime derives `codex-quota-float` from the source repository remote.

**Rationale**

Separating the two prevents a runtime task record from becoming a second product history and avoids inventing an unsupported project alias.

**Consequences**

The exact `@D-AI status` command has zero arguments. Exact continuation uses the repository-derived `codex-quota-float` identity. If `@D-AI continue Quote Float` or `继续 Quote Float` fails only because the display name is not an alias, record `DOGFOOD UX OBSERVATION — EXACT DISPLAY NAME / REPOSITORY SLUG MISMATCH`; do not add a new alias, fuzzy matching, or a second resolver in this bootstrap.

**Revisit trigger**

D-AI adds an evidence-backed project alias mechanism or the canonical source repository name changes. Any such change requires a separate authorization.

## 2026-09-06 — Keep the installed entry self-contained and canonical

**Context**

The global installed D-AI entry previously depended on an obsolete feature worktree. The accepted D-AI-Hub main source contains the canonical Skill files.

**Decision**

For this onboarding task, the installed `d-ai` entry is an ordinary self-contained copy of the accepted canonical `origin/main` Skill files. It has no junction or worktree dependency. Preserve the Quote Float project record in D-AI-Hub Markdown; do not add runtime aliases or alter the D-AI architecture.

**Rationale**

This removes the obsolete installed-source dependency while keeping one canonical Skill implementation and one project-memory owner. The canonical launcher’s ability to resolve its runtime project root from a global installation remains a separate onboarding blocker until supported or explicitly dispositioned.

**Consequences**

Repository-local activation can exercise the reviewed runtime without changing the project-memory ownership boundary. The bootstrap is delivered through one review PR; merge and product-source work remain separate decisions.

**Revisit trigger**

The canonical D-AI-Hub main source or the installed-entry ownership boundary changes.
