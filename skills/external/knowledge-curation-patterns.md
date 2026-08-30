# Knowledge curation rule references

## Status and ownership

Reviewed on 2026-08-30. Reference-only: no upstream Skill, plugin, hook, observer, or memory backend is installed by this adoption. D-AI-Hub's custom Skills remain the owners; upstream instructions grant no local write, deletion, or Git authority.

The rules are locally written adaptations of selected ideas, not vendored upstream packages. The three repositories reported MIT licensing at review time; retain attribution when reusing their material. Recheck upstream content and licensing before any later package installation.

## Selected ideas and exclusions

| Source | Adopted idea | Deliberately excluded |
|---|---|---|
| [Claudeception](https://github.com/blader/Claudeception/blob/main/SKILL.md) | Reusable, specific, verified solutions; search before creation; skip low-value extraction | Generating a Skill for every lesson; automatic activation hooks; applying the non-triviality test to explicit personal preferences or useful reference facts |
| [ECC continuous-learning-v2](https://github.com/affaan-m/ECC/blob/main/skills/continuous-learning-v2/SKILL.md) | Atomic claims, traceable evidence, project/global scope separation | Treating silence as confirmation, invented confidence scores, automatic promotion, raw conversation/tool capture, background observer |
| [Compound capture](https://github.com/EveryInc/compound-engineering-plugin/blob/main/skills/ce-compound/SKILL.md) and [refresh classification](https://github.com/EveryInc/compound-engineering-plugin/blob/main/skills/ce-compound-refresh/references/classify.md) | Verified useful learning; retrieval-value test for overlap; age alone is not staleness; unverifiable is not false | Automatic deletion/commits, a parallel solutions store, mandatory multi-agent ceremony, skipping semantic deduplication in lightweight captures |

## Local application

- [Knowledge Manager](../custom/knowledge-manager/SKILL.md) owns knowledge and stable Hub memory admission, deduplication, conflict handling, and receipts.
- [Project Memory](../custom/project-memory/SKILL.md) owns bounded project checkpoints and selective promotion.
- These are agent decision rules, not a deterministic semantic filter in the SQLite write path. Behavioral samples can reveal failures but cannot establish perfect filtering or automatic future invocation.
