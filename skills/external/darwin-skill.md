# Darwin Skill

- Upstream: `https://github.com/alchaincyf/darwin-skill`
- Purpose: evaluate and optimize Agent Skills using structure checks, test prompts, independent judging, and keep/revert gating.
- Role in D-AI-Hub: Skill QA/optimization layer for locally maintained `SKILL.md` files; not the knowledge-management core.
- Installation: install through the supported Agent Skills mechanism for the target harness.
- Compatibility: intended for Agent Skills-compatible tools including Codex-class coding agents; full optimization requires file/Git/test capabilities.
- Pinning: recommended when running repeatable skill evaluations.
- Local modifications: none.
- Safety: review diffs at checkpoints and do not store credentials in evaluation fixtures.
