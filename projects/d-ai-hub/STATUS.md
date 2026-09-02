# Status

## State

- Lifecycle: active
- Last merged delivery: PR #28
- Active proposal: PR #29
- Current stabilization: Windows Node 22 integration reliability
- PR #26: merged
- PR #27: merged
- PR #28: merged; its main-push CI failed only in Windows Node 22 integration run `33687769873`
- Main branch protection: disabled/not protected
- Live PR status must be queried from GitHub.
- Last verified: 2026-09-03

## Current checkpoint

- Current objective: Diagnose and minimally stabilize the Windows Node 22 integration timeout without changing runtime behavior or weakening assertions.
- Verified state: The live main-push failure was the public-runtime lifecycle test in `tests/integration/v1-contract.test.ts`; it reached 20,024ms and hit the 20,000ms timeout, while the entire test file reported 45.06s. Exact local Node 22.20.0/npm 11.19.0 reproduction did not reproduce the failure and passed across five isolated runs.
- Working state: The hotfix branch is based on current `origin/main`; PR #29 is untouched and deferred. Main is not claimed restored before this hotfix is merged.
- Proposal boundary: The actor/session ADR remains Proposed/Deferred; actor/session runtime, Chat/Work activation, automatic sync, and related redesigns are not implemented.
- Authorized scope: Only the target integration test, project-doc files, and health-check files authorized in this packet may change; no merge or auto-merge is authorized.

## Current blockers

- The hotfix PR and its live check conclusions must be queried after publication; main remains unrestored until a separately authorized merge.
- Branch-protection state is live evidence only and is currently disabled/not protected.

## Next concrete action

Publish the minimal hotfix PR, wait for its complete check matrix, record the real result, and request separate merge authorization only if the evidence supports it.

## Evidence pointers

- Historical implementation and release evidence: [Evidence History](EVIDENCE_HISTORY.md).
- Durable product and architecture choices: [Decisions](DECISIONS.md); future work: [Roadmap](ROADMAP.md).
