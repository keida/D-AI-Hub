# Matt Pocock Skills

- Upstream: `https://github.com/mattpocock/skills`
- Purpose: composable engineering Skills for real software development.
- Role in D-AI-Hub: routine engineering toolkit.
- Preferred use: requirements clarification, specification, implementation, testing, debugging, code review, prototyping, architecture, domain modelling, handoff, and ticket decomposition.
- Routing: prefer the narrowest stable/promoted Matt Skill for routine engineering; use `ask-matt` when Matt-internal routing is unclear.
- Installation: direct upstream installation for Codex through the official `skills@latest` CLI. Do not treat `matt-skills-curated` or a plugin bundle as canonical.
- Installation snapshot (2026-08-22): upstream `main` commit `5b15a47f2d7150f545fbcacbfe381787fc0230dc`; latest visible release tag `v1.2.3`; the selected skills are discoverable from the native user-level Skill root and are recorded in the installer lock file.
- Updates: use the explicit upstream-supported `npx skills update -g` flow, review the changes, and smoke-check discovery. Do not automate updates.
- Experimental policy: do not automatically route production work through explicitly in-progress, deprecated, or experimental Skills.
