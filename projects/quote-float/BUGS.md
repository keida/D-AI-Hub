# Bugs

## Open

### GOV-002 — Human-facing project name is not a D-AI runtime continuation alias

- Severity: medium
- Status: observed dogfood UX limitation
- First observed: 2026-09-06
- Expected: display-name continuation would select the Quote Float durable task.
- Actual: the current runtime resolves exact continuation from the canonical remote repository slug `codex-quota-float`; a display-name failure is expected fail-closed behavior when no alias exists.
- Evidence: Rev 1 acceptance requires exact `@D-AI status` with zero arguments and exact `@D-AI continue codex-quota-float`; any `@D-AI continue Quote Float` or `继续 Quote Float` mismatch must be recorded as `DOGFOOD UX OBSERVATION — EXACT DISPLAY NAME / REPOSITORY SLUG MISMATCH`.
- Disposition: do not alter D-AI architecture, add aliases, or introduce fuzzy matching in this bootstrap.

### GOV-003 — Global installed entry cannot resolve the canonical runtime root

- Severity: medium
- Status: resolved
- First observed: 2026-09-06
- Expected: the self-contained installed D-AI Skill executes the current canonical D-AI runtime.
- Actual: resolved. The installed self-contained entry now binds through `.runtime-root` to the canonical runtime checkout and returns the unique Quote Float durable task from the real source workspace.
- Evidence: fresh installed-entry `@D-AI status` and `@D-AI continue codex-quota-float` both selected `task-937dc8b8c2a683764bc3eb62` on 2026-09-07.
- Disposition: retain the canonical runtime binding and fail-closed exact repository identity; do not restore a worktree dependency.

## Resolved

- GOV-001 — historical QF-WPF-001–004 and QF-WPF-007–008 ticket labels were normalized to `BOSS PASS` during WPF R1 freeze on 2026-09-08; final matrix is recorded in `codex-quota-float::docs/wpf-r1/WPF-R1-FREEZE.md`.
- GOV-003 — installed entry canonical runtime-root binding verified 2026-09-07.
- UI-001 — Settings Refresh interval typography corrected and independently accepted 2026-09-07. Input remains Segoe UI; label/unit retain Microsoft YaHei UI with Segoe UI fallback; ZH -> EN -> ZH keeps fixed geometry and one 520 x 520 Settings window. Evidence: `codex-quota-float::output/wpf-r1/QF-WPF-SETTINGS-TYPOGRAPHY-001-BOSS-REVIEW/boss-acceptance.txt`.
- UI-002 — Settings 420 x 296 manual header drag and control isolation passed the final human matrix; released in v1.1.0.
- UI-003 — authoritative `WidgetWindowController.ApplyState()` ownership, edge-to-Orb, 300 ms temporary Full, exact Orb restore, and multi-monitor anchoring passed the final Plus/Pro human matrices; released in v1.1.0.
- UI-004 — DWM `ROUNDSMALL` native corner ownership with no HRGN/SetWindowRgn product clipping passed physical-screen white-background review; the remaining Default-mode capture anomaly was classified capture-only for the tested environment; released in v1.1.0.
