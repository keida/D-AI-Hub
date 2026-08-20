# D-AI-Hub Design Specification

Date: 2026-08-20
Status: Design approved for specification review
Visibility: Private

## 1. Purpose

D-AI-Hub is a private, GitHub-first personal AI operating system that provides one shared source of truth for ChatGPT Web, Codex, and future compatible agents.

It separates:
- Skills: how agents should work.
- Knowledge: what agents should know.
- Projects: what is being worked on and current project state.
- Memory: durable cross-project context.
- Prompts and templates: reusable interaction and content patterns.
- Indexes: human- and agent-readable discovery maps.

The repository is designed to avoid maintaining separate, diverging ChatGPT Web and Codex configurations.

## 2. Design Principles

1. GitHub-first: GitHub is the canonical source of truth.
2. Markdown-first: core knowledge must remain portable and readable without a proprietary application.
3. Agent-native: files and directories should be easy for AI agents to discover and interpret.
4. Multi-client: the same repository should support ChatGPT Web, Codex, Claude Code, GitHub Copilot, and other Agent Skills-compatible systems where practical.
5. Private-by-default: personal knowledge, work notes, career materials, and project memory stay private.
6. Minimal initial scope: start with a small structure and add automation only after real usage justifies it.
7. External skills are referenced rather than copied unless a local fork is intentionally maintained.

## 3. Repository Structure

D-AI-Hub/
├── .agents/
│   └── skills/
│       ├── knowledge-manager/
│       └── project-memory/
├── skills/
│   ├── external/
│   └── custom/
├── knowledge/
│   ├── ai/
│   ├── data/
│   ├── development/
│   ├── banking/
│   └── career/
├── projects/
│   └── _template/
├── memory/
├── prompts/
├── templates/
├── indexes/
├── docs/
│   └── superpowers/
│       └── specs/
└── README.md

## 4. Component Responsibilities

### .agents/skills/

Contains Agent Skills-compatible entry points intended for direct agent discovery.

Initial skills:
- knowledge-manager: governs capture, classification, linking, indexing, and retrieval of knowledge.
- project-memory: governs project status, decisions, bugs, roadmaps, and continuation context.

### skills/

Management layer for skills.

- skills/custom/: source-of-truth files for user-authored skills.
- skills/external/: manifests and references for third-party skills such as Superpowers, Taste Skill, and Darwin Skill.

Third-party repositories should not be copied wholesale by default. Each external skill reference should record:
- upstream repository
- install name
- purpose
- compatibility notes
- version or commit when pinning matters
- local modifications, if any

### knowledge/

Durable subject knowledge organized by broad domain.

Initial domains:
- ai/
- data/
- development/
- banking/
- career/

Knowledge entries should be portable Markdown and may link to original sources rather than duplicating large external content.

### projects/

Project-specific working memory.

Each project should be able to contain:
- README.md
- STATUS.md
- DECISIONS.md
- BUGS.md
- ROADMAP.md
- REFERENCES.md

The `_template/` directory defines the canonical starting structure.

### memory/

Durable cross-project context that is neither general subject knowledge nor a single project's state.

Examples:
- stable preferences
- recurring workflows
- long-term objectives
- environment notes

Sensitive secrets, passwords, API keys, tokens, or credentials must never be stored here.

### prompts/

Reusable prompts that are useful independently of a specific Skill.

### templates/

Reusable Markdown templates for:
- knowledge entries
- project initialization
- decision records
- source records

### indexes/

Discovery maps generated or maintained for both humans and agents.

Initial indexes:
- KNOWLEDGE.md
- PROJECTS.md
- SKILLS.md

Indexes should link rather than duplicate full content.

## 5. Cross-Environment Workflow

### ChatGPT Web

Primary uses:
- discussion
- planning
- lightweight skill use
- knowledge capture
- reviewing GitHub-hosted knowledge and project state

When ChatGPT Web cannot install a local skill directly, the repository remains the canonical reference.

### Codex

Primary uses:
- repository maintenance
- software development
- local Agent Skills
- testing
- Git operations
- Darwin-based skill optimization
- structured updates to project memory and knowledge

Codex should clone or pull D-AI-Hub rather than maintain a separate independent knowledge base.

## 6. Third-Party Skill Strategy

Initial third-party skill roles:

- Superpowers: software-development process and engineering discipline.
- Taste Skill / gpt-taste: frontend and UI design quality.
- Darwin Skill: evaluation and optimization of locally maintained SKILL.md files.

Darwin is a quality/optimization layer, not the knowledge-management core.

No third-party skill is copied into the repository unless:
1. offline availability is required,
2. a local modification is necessary, or
3. reproducibility requires pinning a specific version.

## 7. Knowledge Flow

Capture:
raw note / source / conversation insight
→ classify
→ normalize into Markdown
→ add metadata and links
→ update relevant index

Retrieval:
user or agent request
→ consult index
→ open relevant knowledge/project files
→ answer or act
→ optionally capture new durable knowledge

The first version does not require vector databases, embeddings, RAG infrastructure, or a separate database. These are deferred until file-based retrieval proves insufficient.

## 8. Project Memory Flow

Each active project maintains explicit state rather than relying on chat history.

Recommended continuation flow:
1. Read project README and STATUS.
2. Read DECISIONS before proposing architectural changes.
3. Read BUGS when debugging.
4. Read ROADMAP before planning new work.
5. Update STATUS and relevant records after meaningful progress.

## 9. Security and Privacy

The repository must remain private.

Never commit:
- passwords
- API keys
- access tokens
- private certificates
- authentication cookies
- secret environment files
- employer-confidential data that is not authorized for personal storage

A root `.gitignore` will later include common secret and environment patterns.

## 10. Initial Scope

Version 1 will include only:
- repository documentation
- directory structure
- README
- indexes
- knowledge-manager skill
- project-memory skill
- project template
- external skill registry
- security/gitignore baseline

Version 1 explicitly excludes:
- vector database
- embeddings
- web application
- automatic sync service
- background ingestion daemon
- large third-party skill copies
- automated Darwin optimization runs

These can be added later based on real usage.

## 11. Success Criteria

D-AI-Hub v1 is successful when:
1. The same private GitHub repository can be used as the source of truth from company ChatGPT Web and home Codex.
2. New knowledge has one obvious place to be stored.
3. Active projects can be resumed without relying on old chat history.
4. Skills are discoverable and separated from knowledge.
5. Third-party skills have traceable upstream references.
6. No secrets are committed.
7. The repository remains understandable without special software.

## 12. Future Extensions

Potential later phases:
- Darwin-based skill QA
- automated indexes
- source ingestion skill
- lint/health-check skill
- semantic search or RAG
- Obsidian compatibility
- GitHub Actions validation
- cross-agent bootstrap instructions

These are intentionally deferred from v1.
