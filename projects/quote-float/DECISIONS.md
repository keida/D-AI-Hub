# Decisions

## 2026-09-06 — Use evidence-backed WPF R1 as the active product baseline

**Context**

The repository contains a protected legacy WinForms implementation and a newer WPF R1 implementation with sequential runtime and Boss acceptance evidence.

**Decision**

Treat the .NET 8 WPF implementation and the accepted QF-WPF-001 through QF-WPF-006 checkpoints as the active product baseline. Preserve legacy WinForms dirty files unless a later task explicitly authorizes changes.

**Rationale**

QF-WPF-006 has direct Boss acceptance evidence, and its dependency chain records the accepted Full, Orb, interaction, topmost, edge, and work-area foundations.

**Consequences**

- QF-WPF-007 is the next product ticket.
- Earlier stale ticket labels do not override later accepted evidence.
- This record does not authorize product implementation, commit, push, or merge.

**Revisit trigger**

Newer runtime or Boss evidence contradicts the accepted WPF R1 chain.

## 2026-09-06 — Keep product state and runtime task state separate

**Context**

D-AI-Hub project Markdown and the D-AI durable runtime serve different purposes.

**Decision**

This project directory owns concise canonical product state. The D-AI runtime owns task identity, ownership, handoff, recovery, and execution state. The human-facing name is `Quote Float`; the current runtime derives `codex-quota-float` from the source repository remote.

**Rationale**

Separating the two prevents a runtime task record from becoming a second product history and avoids inventing an unsupported project alias.

**Consequences**

The exact `@D-AI status` command has zero arguments. Exact continuation uses the repository-derived `codex-quota-float` identity. If `@D-AI continue Quote Float` or `继续 Quote Float` fails only because the display name is not an alias, record `DOGFOOD UX OBSERVATION — EXACT DISPLAY NAME / REPOSITORY SLUG MISMATCH`; do not add a new alias, fuzzy matching, or a second resolver in this bootstrap.

**Revisit trigger**

D-AI adds an evidence-backed project alias mechanism or the canonical source repository name changes. Any such change requires a separate authorization.

## 2026-09-06 — Keep the installed entry self-contained and canonical

**Context**

The global installed D-AI entry previously depended on an obsolete feature worktree. The accepted D-AI-Hub main source contains the canonical Skill files.

**Decision**

For this onboarding task, the installed `d-ai` entry is an ordinary self-contained copy of the accepted canonical `origin/main` Skill files. It has no junction or worktree dependency. Preserve the Quote Float project record in D-AI-Hub Markdown; do not add runtime aliases or alter the D-AI architecture.

**Rationale**

This removes the obsolete installed-source dependency while keeping one canonical Skill implementation and one project-memory owner. The canonical launcher’s ability to resolve its runtime project root from a global installation remains a separate onboarding blocker until supported or explicitly dispositioned.

**Consequences**

Repository-local activation can exercise the reviewed runtime without changing the project-memory ownership boundary. The bootstrap is delivered through one review PR; merge and product-source work remain separate decisions.

**Revisit trigger**

The canonical D-AI-Hub main source or the installed-entry ownership boundary changes.

## 2026-09-07 — Split external lifecycle acceptance from accepted implementation

**Context**

QF-WPF-009 implementation, deterministic data/lifecycle behavior, privacy and regressions passed, but real account/session transition and controlled Codex close/restart cannot be exercised safely in the current environment.

**Decision**

Keep QF-WPF-009 as `IMPLEMENTATION ACCEPTED / EXTERNAL ACCEPTANCE DEFERRED`, isolate the two external gates in QF-WPF-009E, and block QF-WPF-012 until QF-WPF-009E receives `BOSS PASS`.

**Rationale**

The deferred gates are release-acceptance dependencies, not technical inputs to the completed scale or performance work. This preserves safety without discarding accepted implementation evidence.

**Consequences**

- QF-WPF-010 and QF-WPF-011 remain accepted.
- QF-WPF-009E must not be retested without an isolated authenticated profile and independently owned test Codex.
- QF-WPF-012 cannot pass while QF-WPF-009E is blocked.

**Revisit trigger**

A safe isolated environment becomes available or new evidence invalidates the accepted QF-WPF-009 implementation.

## 2026-09-07 — Limit WPF R1 native DPI acceptance to 96 DPI

**Context**

The WPF application retains Per-Monitor-V2 and logical DIP foundations, but real Windows 125% and 150% runtime acceptance was explicitly excluded from QF-WPF-010.

**Decision**

Record native 96 DPI as verified. Record Windows 125% and 150% as `OUT OF R1 ACCEPTANCE SCOPE`; simulated calculations must not be described as native DPI PASS.

**Consequences**

QF-WPF-012 must preserve this limitation in any final report.

**Revisit trigger**

A separately authorized native 125%/150% DPI acceptance phase is created.

## 2026-09-07 — Correct Settings typography before final acceptance

**Context**

After QF-WPF-011 passed, the Settings Refresh interval row was observed to use inconsistent font/fallback treatment and visual alignment between Chinese and English.

**Decision**

The next product action is a minimal Settings typography correction limited to font family/fallback, baseline, text width and unit/input alignment. It does not redesign Settings or start QF-WPF-012.

**Consequences**

Settings remains 520 x 520. Full, Orb, tray, data/lifecycle, scale behavior and approved copy remain protected. Fresh ZH/EN screenshots and ZH -> EN -> ZH runtime switching are required.

**Revisit trigger**

The minimal correction cannot satisfy both approved language states without a broader layout or copy decision.

## 2026-09-07 — Accept the bounded Settings typography correction

**Context**

The first correction aligned the visible row but still allowed runtime language switching to change the numeric input font. Boss review held acceptance until the source contract and bilingual runtime geometry both matched the requested behavior.

**Decision**

Accept the final bounded correction: Refresh interval input remains Segoe UI; its label and localized unit retain Microsoft YaHei UI with Segoe UI fallback. The host, input and unit geometry remain stable through ZH -> EN -> ZH in one 520 x 520 Settings window.

**Consequences**

UI-001 is resolved. Full, Orb, scale, tray and lifecycle baselines remain protected. QF-WPF-009E remains the release blocker and QF-WPF-012 remains not started.

**Revisit trigger**

Future native DPI acceptance or an approved Settings redesign changes the typography or layout contract.

## 2026-09-07 — Use one Pro account for QF-WPF-009E authentication acceptance

**Context**

The user has one authorized Pro account for isolated lifecycle testing and will not purchase another Plus or Pro account for R1 acceptance. Plus/Pro plan mapping is already covered by accepted QF-WPF-009 Rev 2 deterministic tests.

**Decision**

Separate plan mapping from authentication/session lifecycle. QF-WPF-009E uses manual logout and same-account login in an isolated environment to prove Fresh -> SignedOut -> Fresh behavior, a newly observed session when the data source exposes one, rejection of the prior session snapshot as current data, and absence of refresh storms. A second paid account and a real Pro-to-Plus account switch are not R1 requirements.

**Consequences**

- Authentication credentials, MFA values, tokens, and cookies remain exclusively user-controlled and never enter Worker evidence.
- If the product or upstream source cannot distinguish a new same-account session, report `SECOND-ACCOUNT COVERAGE UNAVAILABLE` as a coverage limitation for explicit Boss adjudication.
- The limitation does not automatically fail the product and does not authorize purchasing or requesting another account.
- QF-WPF-009E remains blocked on a safe isolated environment; QF-WPF-012 remains blocked until explicit 009E Boss acceptance.

**Revisit trigger**

The formal R1 contract later requires cross-plan real-account validation, or the data source changes its session identity behavior.

## 2026-09-08 — Defer QF-WPF-009E outside R1 acceptance scope

**Context**

QF-WPF-009 Rev 2 has accepted deterministic evidence, but the two remaining real lifecycle scenarios require a separate Hyper-V/VM environment. The user has decided not to create or operate that environment for R1.

**Decision**

Record QF-WPF-009E as `DEFERRED / NOT VERIFIED — OUT OF R1 ACCEPTANCE SCOPE`; do not issue `BOSS PASS`. Stop Hyper-V, VM/Sandbox, second-Windows-environment, real-account logout/login, and isolated Codex close/restart work. Remove QF-WPF-009E as a dependency of QF-WPF-012 and mark QF-WPF-012 READY.

**Verified R1 evidence retained**

- QF-WPF-009 Rev 2: 29 focused assertions, Plus/Pro mapping, deterministic loading/signed-out/stale and other lifecycle-state logic, refresh/sync, single instance, deterministic Codex presence/watch behavior, privacy, and QF-WPF-005 through QF-WPF-008 regressions.

**Known unverified R1 limitations**

- Same real Pro account `Fresh -> SignedOut -> Fresh`.
- Isolated Codex `Present -> close -> three absence confirmations -> Quote Float response -> restart/recovery`.
- Native Windows 125% and 150% DPI runtime acceptance.

**Consequences**

QF-WPF-012 may accept only its verified in-scope matrix. Its final acceptance record and release notes must identify all three items as `NOT VERIFIED / OUT OF R1 ACCEPTANCE SCOPE` and must not claim them as PASS.

**Revisit trigger**

A post-R1 scope explicitly authorizes the isolated environment and direct evidence for the deferred scenarios.

## 2026-09-08 — Accept and freeze WPF R1 with documented limitations

**Context**

QF-WPF-012F closed the Settings resource, English safe-state layout, and independent Refreshing evidence blockers. QF-WPF-012 then passed final candidate identity, build/tests, targeted runtime regression, manifest integrity, privacy, D-AI recovery, and cleanup review.

**Decision**

Record `QF-WPF-012 — BOSS PASS` and `QUOTE FLOAT WPF R1 — ACCEPTED WITH DOCUMENTED LIMITATIONS`. Freeze the accepted local candidate at EXE SHA-256 `77A2E2D531C56E6B5FE2A0E69A4203DD1E667ED61D88BB7FFF80A952E3C11A40` and DLL SHA-256 `DC4E046C198E364F5C8C9C343B5E75643D6CC442668B5D50AE842612F4071D6E`.

Adopt the regression rule: relevant code changed -> rerun the relevant heavy gate; relevant code unchanged -> reuse accepted evidence plus lightweight smoke. Reuse requires candidate/source identity and changed-file analysis.

**Consequences**

- WPF R1 implementation/acceptance is closed; the active phase is freeze/publication preparation.
- QF-WPF-009E remains deferred and is not relabeled PASS.
- The same-account real Pro lifecycle, isolated Codex close/restart lifecycle, and native Windows 125%/150% DPI remain `NOT VERIFIED / OUT OF R1 ACCEPTANCE SCOPE`.
- Legacy WinForms dirty files remain outside WPF R1 and protected.
- No publication or Git action is authorized by this decision.

**Evidence**

- `codex-quota-float::output/wpf-r1/QF-WPF-012/BOSS-REVIEW/final-recheck.txt`
- `codex-quota-float::docs/wpf-r1/WPF-R1-FREEZE.md`

**Revisit trigger**

An explicitly authorized publication, packaging, post-R1 lifecycle/DPI acceptance, or product-change phase begins.

## 2026-09-08 — Merge the accepted WPF R1 publication into main

**Context**

Publication preparation Steps 1 through 5A established an exact 53-file public scope, preserved the legacy WinForms dirty boundary, passed public privacy and link review, and corrected the final publication-state documentation. PR #1 was open at exact head `ce9cc923ded971d8aa051ab8d4b69dc065051c8b` with GitGuardian passing and no applicable build/test CI.

**Decision**

Merge PR #1 with the repository's normal merge-commit method. Canonical Quote Float `main` is now `d86e21e01d3e1ed389cb53afa7f327184a345c3a`. The merge retains the four publication commits unchanged and does not delete the publication branch.

**Consequences**

- WPF R1 source, tests, canonical visual references, and public documentation are now on `main`.
- The merged delta remains the exact 53-file publication allowlist; protected `native/**`, `output/**`, generated binaries, ZIPs and `PRODUCT.md` are excluded.
- The three documented R1 limitations remain mandatory and are not converted to PASS.
- No tag, release asset, ZIP/EXE publication, or GitHub Release has occurred.
- The next gated action is `PUBLICATION PREP STEP 7 — VERSION + TAG + RELEASE BUILD`, requiring separate authorization.

**Evidence**

- `https://github.com/keida/codex-quota-float/pull/1`
- `https://github.com/keida/codex-quota-float/commit/d86e21e01d3e1ed389cb53afa7f327184a345c3a`
- `codex-quota-float::docs/wpf-r1/PUBLICATION-ALLOWLIST-V2.md`

**Revisit trigger**

A separately authorized version/tag/release-build phase begins, or live GitHub evidence contradicts the recorded merge identity.

## 2026-09-09 — Keep WPF for R1 and freeze the simplification contract

**Context**

The Tauri feasibility PoCs showed easier web-style UI iteration, but real Settings click/drag remained failed, edge/hover/tray closure and native corners were incomplete, process-tree private memory was about 2.2 times WPF with roughly seven to eight processes, and the native bridge was more complex. Real manual testing of the pre-simplification WPF candidate also exposed Settings drag failure, unstable edge/hover behavior, `Orb visual + Full geometry`, and black native corner backing.

**Decision**

Keep WPF for R1. Freeze `codex-quota-float::docs/wpf-r1/SIMPLIFICATION-CONTRACT.md` and dispatch one bounded WPF Simplification Worker. Settings becomes 420 x 296 with only Language and five refresh intervals. The Full footer retains reset information, Sync status, Refresh and Settings. Product Scale, Compact Full, Click-through, Reset preferences, Usage/Billing navigation, low-quota alerts and configurable behavior toggles are removed. `WidgetWindowController` and one `ApplyState()` transaction become the sole authority for visual state, geometry, anchor, hover, hit testing, native region and corner composition.

**Consequences**

- WPF R1 publication remains HOLD.
- Tauri PoC remains read-only; no migration or PoC 3 is authorized.
- The existing `v1.0.0` tag and Draft Release are pre-simplification artifacts and cannot be moved, published or reused as the final simplified candidate.
- Static artwork is reference only. Real native manual acceptance remains mandatory for Settings drag/control isolation, edge-to-Orb, hover Full and exact Orb restore, authoritative state/geometry integrity, and white-background corners.
- No commit, push, merge, tag movement or release publication is authorized by this decision.

**Revisit trigger**

The bounded Simplification Worker returns a complete Result Packet and the Boss completes independent native acceptance.

## 2026-09-10 — Release the simplified WPF R1 as v1.1.0

**Context**

The simplification and final ownership repair passed Plus, Pro, Settings, edge/hover, topmost, multi-monitor anchor, DWM corner, bilingual, cleanup and protected-boundary acceptance. PR #2 merged the 34-file simplification scope, PR #3 added consistent 1.1.0 version metadata, and clean tag builds reproduced the release artifacts. The historical v1.0.0 tag and Draft Release remained pre-simplification records and were not reused.

**Decision**

Publish the simplified Windows x64 framework-dependent package as `v1.1.0`, with annotated tag `v1.1.0` peeling to `fc8e2749e7661b19509ee0bb924f04d204779420`. Record the public Latest Release at `https://github.com/keida/codex-quota-float/releases/tag/v1.1.0`. Merge the post-release documentation record through PR #4; canonical source `main` is `08bc6435225a73b9ada5fc5f4afcdce26785cf95`.

**Consequences**

- WPF R1 publication is complete; v1.1.0 is the current public baseline.
- The historical v1.0.0 tag and Draft Release remain unchanged and unpublished.
- Released hashes are EXE `322DC1F8ED39A6769CCC1102A6C5D2CABBF088CF2C93003399D50C942CDCE507`, WPF DLL `E5F50F66903C29F45AEFF799B6738254A8D6CEC0D59A508103B89EC68D250976`, and ZIP `8B6D4AB34A39F9D466A499150968AEA4DDD344FAC1B33B5CDA1696AE5F40024D`.
- The same-account real-session transition, isolated Codex close/restart lifecycle, and native Windows 125%/150% DPI scenarios remain `NOT VERIFIED / OUT OF R1 ACCEPTANCE SCOPE`.
- Future work is post-release defect triage or explicitly approved R2 scope; removed R1 features are not restored implicitly.

**Evidence**

- `https://github.com/keida/codex-quota-float/pull/2`
- `https://github.com/keida/codex-quota-float/pull/3`
- `https://github.com/keida/codex-quota-float/pull/4`
- `https://github.com/keida/codex-quota-float/releases/tag/v1.1.0`
- `codex-quota-float::docs/wpf-r1/CANDIDATE-MANIFEST.json`

**Revisit trigger**

A verified post-release defect, a separately approved R2 plan, or new native evidence for an explicitly excluded R1 limitation.
