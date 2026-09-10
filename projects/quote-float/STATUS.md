# Status

## State

- Lifecycle: active
- Current phase: WPF R1 v1.1.0 released; post-release maintenance
- Last updated: 2026-09-10
- Live PR status must be queried from GitHub.

## Current checkpoint

- QF-WPF-001 through QF-WPF-008 — `BOSS PASS`.
- QF-WPF-009 — `IMPLEMENTATION ACCEPTED / EXTERNAL ACCEPTANCE DEFERRED`.
- QF-WPF-009E — `DEFERRED / NOT VERIFIED — OUT OF R1 ACCEPTANCE SCOPE`.
- QF-WPF-010 — `BOSS PASS`; native R1 DPI acceptance is limited to 96 DPI.
- QF-WPF-011 — `BOSS PASS`.
- QF-WPF-012F — `BOSS PASS`.
- QF-WPF-012 — `BOSS PASS`.
- Product verdict — `QUOTE FLOAT WPF R1 v1.1.0 — RELEASED / LATEST WITH DOCUMENTED LIMITATIONS`.
- Simplification PR #2, version PR #3, and release-record PR #4 — merged normally; canonical source `main` is `08bc6435225a73b9ada5fc5f4afcdce26785cf95`.
- Release — annotated tag `v1.1.0` peels to `fc8e2749e7661b19509ee0bb924f04d204779420`; public Latest Release: `https://github.com/keida/codex-quota-float/releases/tag/v1.1.0`.
- Released artifacts — EXE `322DC1F8ED39A6769CCC1102A6C5D2CABBF088CF2C93003399D50C942CDCE507`; WPF DLL `E5F50F66903C29F45AEFF799B6738254A8D6CEC0D59A508103B89EC68D250976`; ZIP `8B6D4AB34A39F9D466A499150968AEA4DDD344FAC1B33B5CDA1696AE5F40024D`.
- Architecture decision — `KEEP WPF FOR R1`; Tauri PoC is a read-only experiment and PoC 3 is not planned.
- Frozen contract — `codex-quota-float::docs/wpf-r1/SIMPLIFICATION-CONTRACT.md`.
- Simplification — `BOSS PASS`; Settings drag, edge/hover ownership, DWM corners, Full/Orb geometry, Plus/Pro and ZH/EN manual matrices are accepted.
- Publication — `v1.1.0 RELEASED / LATEST`.
- Existing `v1.0.0` tag and Draft Release remain historical pre-simplification artifacts and were not published, moved or reused.

## Known unverified R1 limitations

- Same real Pro account `Fresh -> SignedOut -> Fresh`: `NOT VERIFIED / OUT OF R1 ACCEPTANCE SCOPE`.
- Isolated Codex `Present -> close -> three absence confirmations -> Quote Float response -> restart/recovery`: `NOT VERIFIED / OUT OF R1 ACCEPTANCE SCOPE`.
- Native Windows 125% and 150% DPI: `NOT VERIFIED / OUT OF R1 ACCEPTANCE SCOPE`; only native 96 DPI is verified.

## Next concrete action

Treat v1.1.0 as the current public baseline. Handle only evidence-backed post-release defects or explicitly approved R2 work; do not reopen the three unverified R1 limitations as PASS without new native evidence.
