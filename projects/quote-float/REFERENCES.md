# References

Source-repository paths below use the prefix `codex-quota-float::` and resolve from the root of `https://github.com/keida/codex-quota-float`. Some acceptance artifacts are local and uncommitted; their repository-relative paths are retained so they can be revalidated without copying the evidence into D-AI-Hub.

## Current authority

- `https://github.com/keida/D-AI-Hub` `origin/main` at `ee5ef26dc73c8ceded4a106929c94c929d59ca0b` — accepted canonical D-AI-Hub source used as the bootstrap base; remote freshness was verified before publication preparation.
- `https://github.com/keida/codex-quota-float/pull/1` — WPF R1 publication PR, merged normally on 2026-09-08 as merge commit `d86e21e01d3e1ed389cb53afa7f327184a345c3a`.
- `https://github.com/keida/codex-quota-float/commit/d86e21e01d3e1ed389cb53afa7f327184a345c3a` — canonical WPF R1 merged source on `main`; its publication delta is the exact 53-file allowlist and retains all four publication commits.
- `codex-quota-float::output/wpf-r1/QF-WPF-006-BOSS-REVIEW/boss-acceptance.txt` — direct QF-WPF-006 Boss acceptance, including build, runtime, topmost, edge/work-area, regression, scope, and cleanup results. Reviewed 2026-09-06.
- `codex-quota-float::docs/wpf-r1/TICKET-MAP.md` — normalized final ticket register and WPF R1 acceptance state; historical QF-WPF-001–004 labels were corrected during freeze on 2026-09-08.
- `codex-quota-float::docs/wpf-r1/tickets/QF-WPF-007.md` — approved Civic Settings scope and normalized `BOSS PASS` state.
- `codex-quota-float::docs/wpf-r1/SIMPLIFICATION-CONTRACT.md` — frozen 2026-09-09 Settings, footer, removed-feature, fixed-behavior, authoritative-state, corner and migration contract; supersedes affected earlier details.
- `codex-quota-float::docs/wpf-r1/tickets/QF-WPF-R1-SIMPLIFICATION.md` — active bounded implementation and native acceptance ticket.
- `codex-quota-float::design-preview/wpf-r1/simplification/qf-wpf-r1-simplification-approval.png` — approved static Settings/footer reference; not native runtime evidence.

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
- WPF R1 is merged into canonical `main`. The next gated publication action is `PUBLICATION PREP STEP 7 — VERSION + TAG + RELEASE BUILD`, which still requires separate authorization.

## Current accepted WPF R1 chain

- `codex-quota-float::docs/wpf-r1/TICKET-MAP.md` — source-repository ticket register; QF-WPF-001 through QF-WPF-008, QF-WPF-010, QF-WPF-011, QF-WPF-012F and QF-WPF-012 are recorded BOSS PASS; QF-WPF-009 is implementation accepted and QF-WPF-009E remains deferred outside R1 acceptance scope.
- `codex-quota-float::output/wpf-r1/QF-WPF-008-BOSS-REVIEW/boss-runtime.txt` and `boss-regression.txt` — independent bilingual Full/Orb/Settings runtime and prior-ticket regression evidence supporting QF-WPF-008 acceptance.
- `codex-quota-float::docs/wpf-r1/tickets/QF-WPF-009.md` — accepted implementation/external-acceptance split.
- `codex-quota-float::docs/wpf-r1/tickets/QF-WPF-009E.md` — approved R1 scope exclusion for the two unverified real lifecycle scenarios; not `BOSS PASS` and no longer a QF-WPF-012 dependency.
- `codex-quota-float::docs/wpf-r1/tickets/QF-WPF-012.md` — final native acceptance contract, including the mandatory R1 limitations list.
- `codex-quota-float::output/wpf-r1/QF-WPF-010-BOSS-REVIEW/rev4/boss-acceptance.txt` — QF-WPF-010 Boss acceptance, discrete 40/70/100 scale behavior and the native 96 DPI limitation.
- `codex-quota-float::output/wpf-r1/QF-WPF-011-BOSS-REVIEW/boss-acceptance.txt` — QF-WPF-011 performance/lifecycle Boss acceptance, including warmed Settings resource curves and cleanup.
- `codex-quota-float::output/wpf-r1/QF-WPF-012/BOSS-REVIEW/final-recheck.txt` — final native Boss acceptance, frozen EXE/DLL identity, targeted regression, privacy, D-AI recovery, cleanup, and the three mandatory limitations.
- `codex-quota-float::docs/wpf-r1/WPF-R1-FREEZE.md` — final ticket matrix, exact publication boundary, protected legacy WinForms boundary, frozen regression policy, and PR #1 merge-decision state preserved in the publication history.
- `codex-quota-float::output/wpf-r1/QF-WPF-012/RELEASE-NOTES-DRAFT.md` — release-notes draft carrying all three `NOT VERIFIED / OUT OF R1 ACCEPTANCE SCOPE` disclosures.

## Accepted Settings typography correction

- `codex-quota-float::wpf/Windows/SettingsWindow.xaml` — Refresh interval input and unit font/alignment definitions.
- `codex-quota-float::output/wpf-r1/QF-WPF-SETTINGS-TYPOGRAPHY-001-BOSS-REVIEW/boss-acceptance.txt` — independent Boss build, 29-fixture test, native ZH -> EN -> ZH geometry, focused regression, privacy and cleanup acceptance.
- `codex-quota-float::output/wpf-r1/QF-WPF-SETTINGS-TYPOGRAPHY-001/rev3/` — Worker runtime screenshots, exact source/binary hashes and independent read-only visual review supporting the accepted correction.
- `codex-quota-float::output/wpf-r1/QF-WPF-010/settings-zh.png` and `settings-en.png` — earlier bilingual native Settings evidence used to identify UI-001.
- `codex-quota-float::design-preview/wpf-r1/03-civic-settings-zh.png` and `04-civic-settings-en.png` — approved bilingual Settings references.

## WPF R1 v1.1.0 publication

- `https://github.com/keida/codex-quota-float/pull/2` — merged WPF R1 simplification source and state-controller/corner/interaction fixes.
- `https://github.com/keida/codex-quota-float/pull/3` — merged v1.1.0 version metadata and release-candidate records.
- `https://github.com/keida/codex-quota-float/pull/4` — merged post-release public documentation record; canonical source `main` is `08bc6435225a73b9ada5fc5f4afcdce26785cf95`.
- `https://github.com/keida/codex-quota-float/releases/tag/v1.1.0` — public Latest Release, Windows x64 framework-dependent ZIP and SHA256SUMS.
- `codex-quota-float::docs/wpf-r1/CANDIDATE-MANIFEST.json` — released artifact identity, accepted evidence, scope, publication metadata and mandatory limitations.
