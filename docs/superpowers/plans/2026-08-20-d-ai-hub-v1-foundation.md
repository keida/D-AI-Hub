# D-AI-Hub V1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the minimal private, GitHub-first D-AI-Hub foundation that can serve as the shared source of truth for ChatGPT Web and Codex.

**Architecture:** Markdown-first repository with clear separation between agent skills, durable knowledge, project memory, reusable prompts/templates, and discovery indexes. Third-party skills are referenced rather than copied; custom agent entry points live under `.agents/skills/`.

**Tech Stack:** GitHub, Markdown, Agent Skills (`SKILL.md`), Git.

**Spec:** `docs/superpowers/specs/2026-08-20-d-ai-hub-design.md`

## Global Constraints

- Repository visibility must remain private.
- GitHub is the canonical source of truth.
- Core knowledge must remain portable Markdown.
- Do not store passwords, API keys, access tokens, private certificates, authentication cookies, secret environment files, or unauthorized employer-confidential data.
- Version 1 excludes vector databases, embeddings, web apps, background ingestion daemons, automatic sync services, and automated Darwin runs.
- One task uses at most one working branch; small knowledge/content updates may commit directly to `main` after V1 is merged.

---

### Task 1: Repository Foundation and Security Baseline

**Files:**
- Create: `README.md`
- Create: `.gitignore`

**Interfaces:**
- Consumes: approved design spec.
- Produces: repository orientation and secret-file guardrails used by all later tasks.

- [ ] **Step 1: Create README with purpose, architecture, usage model, and safety rules.**
- [ ] **Step 2: Create `.gitignore` covering environment files, secrets, editor artifacts, OS files, local worktrees, and common build/cache directories.**
- [ ] **Step 3: Verify both files exist on `feat/v1-foundation` and match the design constraints.**
- [ ] **Step 4: Commit with a focused repository-foundation message.**

### Task 2: Discovery Indexes

**Files:**
- Create: `indexes/KNOWLEDGE.md`
- Create: `indexes/PROJECTS.md`
- Create: `indexes/SKILLS.md`

**Interfaces:**
- Consumes: directory conventions from the design spec.
- Produces: stable entry points for humans and agents to discover hub content.

- [ ] **Step 1: Create knowledge index with the five initial domains and update rules.**
- [ ] **Step 2: Create project index with active/archived conventions and continuation instructions.**
- [ ] **Step 3: Create skills index separating custom and external skills.**
- [ ] **Step 4: Verify all index links point to intended repository paths.**
- [ ] **Step 5: Commit the indexes.**

### Task 3: Knowledge Manager Agent Skill

**Files:**
- Create: `.agents/skills/knowledge-manager/SKILL.md`
- Create: `skills/custom/knowledge-manager/README.md`

**Interfaces:**
- Consumes: `knowledge/`, `indexes/KNOWLEDGE.md`, templates.
- Produces: a repeatable capture/classify/link/index/retrieve workflow.

- [ ] **Step 1: Define YAML frontmatter with a narrow description and activation scope.**
- [ ] **Step 2: Encode capture, classification, normalization, linking, index-update, retrieval, and security rules.**
- [ ] **Step 3: Encode failure modes: duplicate knowledge, over-copying sources, secret capture, ambiguous storage location, and stale index entries.**
- [ ] **Step 4: Add custom-skill README that states source-of-truth and compatibility notes.**
- [ ] **Step 5: Verify skill is actionable, has no vague placeholders, and never instructs storage of secrets.**
- [ ] **Step 6: Commit the skill.**

### Task 4: Project Memory Agent Skill and Project Template

**Files:**
- Create: `.agents/skills/project-memory/SKILL.md`
- Create: `skills/custom/project-memory/README.md`
- Create: `projects/_template/README.md`
- Create: `projects/_template/STATUS.md`
- Create: `projects/_template/DECISIONS.md`
- Create: `projects/_template/BUGS.md`
- Create: `projects/_template/ROADMAP.md`
- Create: `projects/_template/REFERENCES.md`

**Interfaces:**
- Consumes: project directory convention.
- Produces: deterministic project continuation context for ChatGPT Web and Codex.

- [ ] **Step 1: Define project-memory skill read order and update rules.**
- [ ] **Step 2: Encode project-state failure modes including stale status, undocumented decisions, resolved bugs left open, and chat-history dependence.**
- [ ] **Step 3: Create complete project template files with explicit sections and instructions.**
- [ ] **Step 4: Verify a new project can be created by copying `_template/` and that every project-state concern has one canonical file.**
- [ ] **Step 5: Commit the project-memory layer.**

### Task 5: Knowledge and Content Templates

**Files:**
- Create: `templates/knowledge-entry.md`
- Create: `templates/decision-record.md`
- Create: `templates/source-record.md`
- Create: `knowledge/README.md`
- Create: `memory/README.md`
- Create: `prompts/README.md`

**Interfaces:**
- Consumes: knowledge-manager and project-memory conventions.
- Produces: consistent Markdown capture format across the hub.

- [ ] **Step 1: Create knowledge entry template with title, summary, domain, source, key points, related notes, and review metadata.**
- [ ] **Step 2: Create decision record template with context, options, decision, rationale, consequences, and revisit trigger.**
- [ ] **Step 3: Create source record template with provenance and rights-aware summary guidance.**
- [ ] **Step 4: Create README files explaining knowledge, memory, and prompt boundaries.**
- [ ] **Step 5: Verify templates do not encourage secrets or excessive copying of source material.**
- [ ] **Step 6: Commit templates and content guidance.**

### Task 6: External Skills Registry

**Files:**
- Create: `skills/external/README.md`
- Create: `skills/external/superpowers.md`
- Create: `skills/external/taste-skill.md`
- Create: `skills/external/darwin-skill.md`

**Interfaces:**
- Consumes: upstream repositories and install names.
- Produces: traceable third-party skill inventory without vendoring upstream code.

- [ ] **Step 1: Define external-skill registry format: upstream, purpose, install path/name, compatibility, pinning, local modifications.**
- [ ] **Step 2: Register Superpowers as the development methodology layer.**
- [ ] **Step 3: Register Taste Skill / `gpt-taste` as the frontend design-quality layer.**
- [ ] **Step 4: Register Darwin Skill as the skill QA/optimization layer.**
- [ ] **Step 5: Verify no third-party source code is copied into the hub.**
- [ ] **Step 6: Commit the registry.**

### Task 7: V1 Verification and Pull Request

**Files:**
- Verify all V1 files against the design spec and implementation plan.

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: reviewable V1 branch ready to merge.

- [ ] **Step 1: Check spec coverage against every V1 success criterion.**
- [ ] **Step 2: Search for placeholder language (`TBD`, `TODO`, `implement later`) and remove any accidental placeholders.**
- [ ] **Step 3: Search for secret-like content or unsafe instructions.**
- [ ] **Step 4: Compare `feat/v1-foundation` against `main` and review changed files.**
- [ ] **Step 5: Open a pull request summarizing architecture, security, and future-scope exclusions.**
