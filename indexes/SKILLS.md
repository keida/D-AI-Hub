# Skills Index

## Custom skills

- [D-AI Codex Activation (canonical)](../skills/custom/d-ai/SKILL.md)
  - [Compatibility entry point](../.agents/skills/d-ai/SKILL.md)
- [Knowledge Manager (canonical)](../skills/custom/knowledge-manager/SKILL.md)
  - [Compatibility entry point](../.agents/skills/knowledge-manager/SKILL.md)
- [Project Memory (canonical)](../skills/custom/project-memory/SKILL.md)
  - [Compatibility entry point](../.agents/skills/project-memory/SKILL.md)

Management notes for locally authored skills live under `skills/custom/`.

## External skills

Third-party skills are referenced under `skills/external/` rather than copied into this repository.

Initial registry:
- [Matt Pocock Skills](../skills/external/matt-skills.md)
- [Superpowers](../skills/external/superpowers.md)
- [Taste Skill / `gpt-taste`](../skills/external/taste-skill.md)
- [Darwin Skill](../skills/external/darwin-skill.md)

Router decision: no independent external or general-purpose Router runtime is installed; D-AI-Hub routing remains authoritative. `ask-matt` is only an optional internal assistant for selecting Matt Skills.

## Rule

A skill defines **how an agent should work**. Durable subject matter belongs under `knowledge/`; project state belongs under `projects/`.
