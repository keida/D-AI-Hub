# References

Source-repository paths below use the prefix `codex-quota-float::` and resolve from the root of `https://github.com/keida/codex-quota-float`. Some acceptance artifacts are local and uncommitted; their repository-relative paths are retained so they can be revalidated without copying the evidence into D-AI-Hub.

## Current authority

- `https://github.com/keida/D-AI-Hub` `origin/main` at `ee5ef26dc73c8ceded4a106929c94c929d59ca0b` — accepted canonical D-AI-Hub source used as the bootstrap base; remote freshness was verified before publication preparation.
- `codex-quota-float::output/wpf-r1/QF-WPF-006-BOSS-REVIEW/boss-acceptance.txt` — direct QF-WPF-006 Boss acceptance, including build, runtime, topmost, edge/work-area, regression, scope, and cleanup results. Reviewed 2026-09-06.
- `codex-quota-float::docs/wpf-r1/TICKET-MAP.md` — ticket ordering and current next-ticket marker; contains stale historical states for QF-WPF-001 through QF-WPF-004. Reviewed 2026-09-06.
- `codex-quota-float::docs/wpf-r1/tickets/QF-WPF-007.md` — approved Civic Settings scope; its old BLOCKED dependency label is superseded by QF-WPF-006 Boss acceptance. Reviewed 2026-09-06.

## Accepted dependency chain

- `codex-quota-float::output/wpf-r1/QF-WPF-001/validation-summary.txt` — WPF shell build/runtime and protected-state evidence.
- `codex-quota-float::output/wpf-r1/QF-WPF-002/independent-review.txt` and `independent-desktop-review-r3.txt` — accepted Full Plus visual/runtime evidence.
- `codex-quota-float::output/wpf-r1/QF-WPF-003/final-manifest.txt` — Full Pro plus mandatory Plus regression evidence.
- `codex-quota-float::output/wpf-r1/QF-WPF-004/final-manifest.txt` — Orb Plus/Pro correction and Full regression evidence.
- `codex-quota-float::output/wpf-r1/QF-WPF-004A/final-manifest.txt` and `codex-quota-float::docs/wpf-r1/tickets/QF-WPF-004A.md` — 10-segment Orb reference alignment and Boss PASS.
- `codex-quota-float::docs/wpf-r1/tickets/QF-WPF-005.md` and `codex-quota-float::output/wpf-r1/QF-WPF-005/boss-review/` — Orb/Full interaction Boss acceptance.
- `codex-quota-float::docs/wpf-r1/tickets/QF-WPF-006.md` — Always-On-Top and edge-behaviour ticket marked BOSS PASS.

## Interpretation rule

Later direct Boss acceptance and accepted dependency evidence supersede earlier READY/BLOCKED dependency labels. Missing or contradictory evidence must be recorded as a conflict rather than guessed.

## D-AI onboarding evidence boundary

- Exact runtime activation output, installed-entry source identity, commit/push/PR identity, and CI results belong in the Worker Result Packet and live review evidence; do not duplicate command logs here.
- The next product task remains `QF-WPF-007 — Civic Settings` and is not started by this bootstrap.
