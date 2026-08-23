# D-AI Orchestrator v2 Design Specification

**Status:** Approved v2 baseline — status corrected after final review
**Date:** 2026-08-21
**Scope:** D-AI-Hub control-plane architecture
**Decision:** D-AI remains the single top-level orchestrator. Mature external projects are design references, not runtime dependencies or competing orchestrators.

## 1. Summary

D-AI v2 is a personal AI control plane for consistent, recoverable work across ChatGPT Chat, Work, and Codex. The user should be able to say:

```text
@D-AI continue DeepSeek Harness
```

and have D-AI select the smallest useful capability set, route the current stage to the right environment, choose a model by stage and role, carry the task among Chat, Work, and Codex, enforce verification gates, recover from failure, and refuse a `Safe-to-delete: YES` verdict until durable context and the remote result are verified.

The design deliberately separates the control plane from the execution tools. D-AI decides what should happen, where the current stage should run, and whether it is proven; Chat, Work, Codex, model providers, skills, Git, and GitHub are adapters or evidence sources.

## 2. Goals and non-goals

### Goals

1. Provide one global `@D-AI` entry and bootstrap contract for Chat, Work, and Codex.
2. Route work by stage across environments and by role across models, while preserving explicit user overrides.
3. Route skills by capability, with progressive disclosure and minimum useful context.
4. Move a task between Chat, Work, and Codex without copying an uncontrolled transcript.
5. Make verification a hard gate for progress and completion claims.
6. Make failure enter a systematic debugging and recovery path.
7. Create known-good recovery points and safe, auditable rollback paths.
8. Make `@D-AI close` produce an evidence-backed verdict, including GitHub commit verification.
9. Keep the first implementation small enough to test as one coherent control-plane slice.

### Non-goals

- D-AI will not install or embed LangGraph, OpenAI Agents SDK, another agent marketplace, or another top-level orchestrator.
- V1 will not attempt autonomous multi-agent swarms, unrestricted self-modification, or hidden cross-provider routing.
- `@D-AI close` will not delete files, uninstall software, terminate processes, or remove a repository.
- A model's assertion, a successful HTTP response, or the existence of a process is not completion evidence by itself.
- Memory will not be treated as authoritative when current local or remote evidence is available.

## 3. Control-plane model

```text
                         @D-AI
                           │
                    Entry / Bootstrap
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
  Stage Router        Model Router        Skill Router
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                    Context Composer
                           │
                    Execution Adapters
                           │
                 Verification Hard Gates
                           │
              Debugging / Recovery / Handoff
                           │
                    Durable Task State
```

D-AI owns task state, decisions, gates, and verdicts. Adapters own product-specific operations. A component must not silently bypass a gate by calling another component directly.

### 3.1 Core state

Each active task has a portable state record with these conceptual fields:

| Field | Meaning |
|---|---|
| `task_id` | Stable identifier across Chat, Work, Codex, and handoffs. |
| `goal` | User's current goal in plain language. |
| `constraints` | Scope, safety, privacy, schedule, and user-provided limits. |
| `environment` | Current environment: `chat`, `work`, or `codex`. |
| `stage` | Current lifecycle stage. |
| `role` | Current work role. |
| `routing_decision` | Selected environment and model, reason, override sources, and capability requirements. |
| `selected_capabilities` | Minimal skills selected for the current stage. |
| `context_manifest` | Files, references, and evidence intentionally loaded. |
| `handoff_state` | Pending, acknowledged, active, completed, or rejected. |
| `verification_state` | Gates, evidence locations, timestamps, and failures. |
| `recovery_point` | Latest known-good point and how to restore it. |
| `approval_state` | User approvals required for the next irreversible or scope-expanding step. |
| `close_verdict` | `YES`, `NO`, or `BLOCKED`, with evidence and blockers. |

The implementation may use a different storage shape, but it must preserve these semantics and must not store secrets in task handoff payloads or ordinary logs.

### 3.2 Lifecycle stages

| Stage | Primary purpose | Default role |
|---|---|---|
| `bootstrap` | Identify the task, environment, repository, and current state. | Analyst |
| `route` | Select capabilities, context, model, and next action. | Planner |
| `plan` | Produce an approved implementation or investigation plan. | Planner |
| `execute` | Make the smallest scoped change or perform the requested operation. | Implementer |
| `inspect` | Read current state and collect direct evidence. | Evidence collector |
| `verify` | Run required checks and record results. | Reviewer |
| `debug` | Reproduce, isolate, hypothesize, change minimally, and re-verify. | Debugger |
| `recover` | Restore a known-good point or preserve a failed state for review. | Recovery operator |
| `handoff` | Transfer the portable task state between environments. | Coordinator |
| `close` | Verify durable completion and produce the safe-to-delete verdict. | Reviewer |

The stage is explicit in state and user-visible progress. The model may recommend a transition, but the control plane validates whether the transition is allowed.

### 3.3 Stage-based environment routing

Environment routing answers **where** the current stage runs; model routing answers **which model** performs the role there. The default environment policy is:

| Stage | Default environment | Responsibility |
|---|---|---|
| `bootstrap` | Chat | Capture intent, recover task identity, and request missing approvals. |
| `route` | Chat | Select stage, environment, role, capabilities, and model. |
| `plan` | Chat or Work | Chat clarifies intent; Work persists the approved plan and project context. |
| `execute` | Work or Codex | Work handles workspace-aware operations; Codex handles local code, tools, and processes. |
| `inspect` | Work or Codex | Read project state in Work; inspect live local state in Codex. |
| `verify` | Work or Codex | Work verifies durable artifacts; Codex verifies local execution and test evidence. |
| `debug` | Codex or Work | Codex isolates runtime/repository failures; Work handles project-state or workflow failures. |
| `recover` | Work or Codex | Work restores durable task context; Codex restores local known-good state. |
| `handoff` | Source and target | Any environment may emit or receive a validated envelope. |
| `close` | Work with Codex evidence | Work confirms durable context and final state; Codex supplies local worktree and execution evidence when applicable. |

The router may choose a different environment when task evidence requires it, but it must record the reason and re-check the target's capabilities. An environment override may constrain routing, but cannot bypass a gate or make an unavailable adapter appear compatible.

## 4. Global `@D-AI` entry and bootstrap

### 4.1 Entry contract

Chat, Work, and Codex must recognize the same logical command family:

```text
@D-AI <intent>
@D-AI continue <task-or-project>
@D-AI status
@D-AI handoff <environment>
@D-AI close
```

Environment-specific syntax may differ at the adapter boundary, but the normalized intent and resulting state transitions must be equivalent.

### 4.2 Bootstrap sequence

1. Normalize the request and assign or recover `task_id`.
2. Identify the active environment, workspace, repository, branch, and relevant project instructions.
3. Read current task state and the latest recovery point.
4. Inspect only the bounded files and evidence needed to classify the request.
5. Select the minimum capability candidates; do not load the entire skill library.
6. Resolve stage, role, model, and user overrides.
7. State the next action, required approval, and verification gate before execution.

Bootstrap is read-only unless the user explicitly requests an operation. If the workspace or repository cannot be identified, D-AI must stop with an actionable error instead of guessing.

### 4.3 Environment adapter contract and compatibility assumptions

The names Chat, Work, and Codex define the target adapter contract for this design; they do not claim that every current product surface already exposes all required APIs. The implementation must validate capabilities at runtime rather than infer them from a label:

- **Chat** is the conversational intent, approval, routing, and status surface. It must not be treated as a local filesystem or process executor unless an explicit adapter provides that capability.
- **Work** is the workspace-aware and durable-context surface. It must be able to persist task state, context manifests, approvals, evidence manifests, and handoff records before close can succeed.
- **Codex** is the local execution surface for repository, tool, process, and test operations. It supplies local state evidence and may push to GitHub through the configured Git adapter.

If a surface cannot provide the capability required by its assigned stage, D-AI stops or routes to a compatible environment with an explicit transition record. Compatibility is capability-based, not name-based.

## 5. Stage/role-based model routing

### 5.1 Routing decision

Routing is a policy decision, not a hidden model preference. The normalized decision must contain:

```text
stage
role
required_capabilities
selected_model
override_source
reason
verification_requirements
fallback_policy
```

The default policy chooses the least expensive model that is sufficient for the stage and role, subject to configured quality, context, latency, privacy, and tool-use requirements. A stronger model may be selected when the task is ambiguous, high-risk, cross-environment, security-sensitive, or in repeated failure.

### 5.2 Default role policy

| Role | Typical work | Routing preference |
|---|---|---|
| Analyst | Inspect state, classify intent, gather bounded evidence. | Fast, context-efficient model. |
| Planner | Define interfaces, scope, risks, and acceptance criteria. | Reasoning-capable model. |
| Implementer | Make a scoped change using the selected tools. | Tool-capable model with sufficient context. |
| Evidence collector | Run checks and report observed output without inference. | Deterministic/tool-capable model. |
| Reviewer | Challenge correctness, scope, security, and evidence. | Independent reasoning path where available. |
| Debugger | Follow the systematic failure loop and isolate root cause. | Reasoning-capable model; no silent model hopping. |
| Recovery operator | Preserve state, restore a known-good point, and re-verify. | Conservative tool-capable model. |

### 5.3 User overrides

Users may pin or constrain routing, for example:

```text
@D-AI continue task-123 model=<model-id>
@D-AI continue task-123 role=reviewer
@D-AI continue task-123 stage=verify
```

Override rules:

- An explicit override is recorded in `override_source` and shown in status.
- D-AI must not silently replace an unavailable or disallowed override.
- If the override cannot satisfy the stage's hard requirements, D-AI stops and explains the conflict.
- A user override changes model or role selection; it does not bypass verification, approval, safety, or close gates.

## 6. Capability-based skill routing and minimum context

### 6.1 Capability registry

Skills are discoverable capabilities, not a second orchestration layer. Each registry entry exposes lightweight metadata such as:

```text
name
description
triggers
domain
required_tools
trust/provenance
compatible_environments
```

The router selects the smallest set that covers the current intent, stage, and environment. Conflicting or redundant skills are rejected or omitted with a reason recorded in state.

### 6.2 Progressive disclosure

D-AI follows three loading levels:

1. **Metadata:** discover candidate capabilities without loading their bodies.
2. **Skill instructions:** load `SKILL.md` only after a capability is selected.
3. **Resources:** load `references/`, `scripts/`, or `assets/` only when the selected procedure requires them.

The context manifest records what was loaded and why. A task must not receive the full library merely because the library exists. Large reference material is loaded on demand and is not copied wholesale into a handoff.

### 6.3 Routing example

For `@D-AI finish the launcher UI`, the expected minimum combination is:

```text
Project continuity / memory
+
Superpowers workflow
+
Taste / UI quality review
```

Additional skills are selected only when the task evidence requires them, such as Windows lifecycle control, testing, or security review.

## 7. Chat ↔ Work ↔ Codex handoff

### 7.1 Handoff envelope

A handoff transfers a versioned state envelope, not an uncontrolled transcript. It contains:

```text
schema_version
task_id
goal
constraints
source_environment
target_environment
workspace/repository identity
branch and recovery point
current stage and role
environment capability snapshot
routing decision
selected capabilities and context manifest
completed actions
verification evidence
durable-context manifest
open failures and blockers
pending approvals
unsaved-context status
redaction metadata
```

Secrets, API keys, raw credentials, and unnecessary conversation history are excluded. Large artifacts are referenced by stable paths or hashes where possible.

### 7.2 Handoff protocol

1. Source environment freezes the current state at a recovery point.
2. Source emits the envelope and a unique handoff identifier.
3. Target validates schema, task identity, workspace identity, target capabilities, and freshness.
4. Target acknowledges the handoff before acting.
5. Only one environment owns execution for a task at a time; duplicate execution is rejected.
6. Target continues from the recorded stage and rechecks stale evidence before irreversible work.
7. Completion or rejection is written back to task state.

Chat may hand off an approved plan to Work, Work may hand off executable work to Codex, and Codex may return evidence or a recovery state to Work or Chat. Any other direction is valid when the target capability check passes. If the target cannot validate the envelope, the handoff is rejected with a specific reason. It must not fall back to starting a new, untracked task.

## 8. Verification hard gates

Verification is a state transition requirement. D-AI must not claim a task is complete, fixed, safe, or ready for deletion without fresh evidence for the applicable gates.

### 8.1 Gate classes

| Gate | Required evidence |
|---|---|
| Scope | Requested files and behavior are within the approved task boundary. |
| Environment capability | The selected Chat, Work, or Codex adapter can perform the assigned stage. |
| State | Current workspace, branch, process, or service state was inspected directly. |
| Quality | Applicable tests, lint, build, smoke, or UI checks completed with captured output. |
| Failure | Failed checks entered systematic debugging; no failure was silently masked. |
| Recovery | A known-good point exists before a risky transition and remains restorable. |
| Handoff | Envelope was validated and acknowledged by the target environment. |
| Durable context | Task state, context manifest, approvals, evidence manifest, handoff state, and recovery point are saved to durable storage. |
| Unsaved context | No critical decision, artifact, failure state, approval, or pending handoff remains only in a transient environment. |
| Remote durability | Required artifacts and intended commit are present on the configured GitHub remote. |
| Close | All required gates pass and no active work or unresolved blocker remains. |

The gate set is task-specific, but omission must be explicit: D-AI records why a normally applicable gate does not apply. “Not run” is never treated as “passed.”

### 8.2 Evidence rules

- Evidence is timestamped and tied to `task_id` and the current recovery point.
- The verifier records observed output and exit status separately from interpretation.
- A model-generated summary never substitutes for the underlying evidence.
- Stale evidence must be rechecked after a handoff, rollback, dependency change, or external-state change.
- Verification failure blocks the next success-like transition until debug or recovery completes.

## 9. Systematic debugging on failure

Every failure follows the same bounded loop:

```text
Reproduce
  ↓
Capture exact symptom and evidence
  ↓
Isolate the failing boundary
  ↓
State one falsifiable hypothesis
  ↓
Make the smallest in-scope change
  ↓
Re-run the original check
  ↓
Run relevant regression checks
  ↓
Keep, recover, or stop with a blocker
```

The debugger must preserve the failed state before changing it. A repeated failure escalates to a new hypothesis or human decision; it does not trigger an unannounced model, tool, or architecture switch. The final report distinguishes observed facts, issued actions, and verified results.

## 10. Known-good recovery points and safe rollback

### 10.1 Recovery-point policy

D-AI creates or records a recovery point:

- before implementation or any destructive/external operation;
- after a verified milestone;
- before a handoff;
- before attempting recovery from a failed state;
- before `close` evaluates deletion safety.

A recovery point includes the relevant commit or artifact hash, workspace identity, branch, state manifest, verification results, and restoration instructions.

### 10.2 Rollback policy

- Prefer a reversible, auditable operation that preserves the failed state.
- Never use an unreviewed destructive reset as the default recovery action.
- Preserve uncommitted user work before restoring a known-good point.
- After rollback, rerun the original failing check and the recovery-point verification.
- A rollback is not completion; it is a state transition requiring a new plan or user decision.
- If safe restoration cannot be proven, the result is `BLOCKED`, not `Safe-to-delete: YES`.

## 11. Verified `@D-AI close` and deletion verdict

`@D-AI close` is a verification workflow, not a cleanup command.

### 11.1 Preconditions

The close workflow requires:

1. An explicit close request for the active `task_id`.
2. No active execution, pending handoff, or unresolved approval.
3. Durable context is saved, including task state, context manifest, approvals, evidence manifest, handoff state, and recovery point.
4. No critical unsaved context remains in Chat, Work, Codex, or any transient tool session.
5. Required artifacts are present and linked to the durable task state.
6. Applicable verification gates passed with fresh evidence.
7. A known-good recovery point is recorded and restorable.
8. A clean local worktree exists, or an explicit documented reason why cleanliness is not required.
9. The GitHub push operation succeeds for the intended commit on the configured repository and ref, with push evidence recorded.
10. GitHub resolves the exact expected commit SHA on that repository/ref; “push command succeeded” alone is insufficient.
11. The verified remote commit corresponds to the durable artifact and verification state being closed.

### 11.2 Verdicts

| Verdict | Meaning |
|---|---|
| `Safe-to-delete: YES` | Durable context is saved, the GitHub push succeeded, the exact remote state is verified, no critical unsaved context remains, and every other close precondition is verified. |
| `Safe-to-delete: NO` | A close precondition failed or required work remains. The report names the blocker. |
| `Safe-to-delete: BLOCKED` | Verification could not be completed because an external dependency, permission, or state ambiguity prevented a trustworthy decision. |

Only `YES` may be presented as safe. `NO` and `BLOCKED` must include the next concrete check or recovery action. D-AI never performs deletion as part of this command.

## 12. Compatibility and capability matrix

The matrices describe the V1 contract, not an assertion that every adapter already exists. Runtime capability discovery is mandatory; the environment name alone is never sufficient.

### 12.1 Environment capability matrix

| Environment | Primary responsibility | Must support in V1 | Must not be assumed |
|---|---|---|---|
| Chat | Intent capture, approval, routing, status, and human-readable handoff initiation. | Global entry, bootstrap, route decisions, approval records, status, handoff envelope creation. | Local filesystem, process control, repository mutation, or durable storage without an explicit adapter. |
| Work | Workspace-aware planning, durable context, artifact manifests, and cross-environment continuity. | Durable task state, context manifests, approvals, evidence manifests, recovery points, handoff records, close coordination. | Local execution or Git push unless its adapters expose and verify those capabilities. |
| Codex | Local repository, tool, process, test, and runtime execution. | Workspace inspection, scoped changes, local verification, recovery, worktree state, Git push evidence. | Durable context persistence or remote verification without an explicit Work/GitHub adapter. |

### 12.2 Capability-by-environment contract

| Capability | Chat | Work | Codex | V1 boundary |
|---|---:|---:|---:|---|
| Normalized `@D-AI` entry | Required | Required | Required | All three adapters normalize to the same intent. |
| Bootstrap and task identity | Required | Required | Required | Any environment may resume a task. |
| Stage-based environment routing | Required | Required | Required | Router records selected environment and reason. |
| Role-based model routing | Required | Required | Required | Model selection is separate from environment selection. |
| User model/role/environment override | Required | Required | Required | Overrides never bypass gates. |
| Agent Skills metadata routing | Required | Required | Required | Metadata first; bodies and resources on demand. |
| Durable context save | Via Work adapter | Native responsibility | Via Work adapter | Required before close. |
| Local execution and live state | No default | Adapter-dependent | Native responsibility | Evidence must identify its source. |
| Chat ↔ Work ↔ Codex handoff | Source/target | Source/target | Source/target | Versioned envelope, ack, single owner. |
| Verification hard gates | Required | Required | Required | Gate execution may be delegated; gate state is centralized. |
| Systematic debugging | Coordination | Workflow/project failures | Runtime/repository failures | Original symptom must be re-run. |
| Known-good recovery point | Record/approve | Persist/restore context | Persist/restore local state | Rollback preserves user work. |
| GitHub push evidence | Adapter result | Consume/verify | Produce | Push success is recorded, not inferred. |
| GitHub remote-state verification | Adapter result | Required for close | Adapter result | Exact repository/ref/SHA required. |
| Safe-to-delete verdict | Display/approve | Authoritative computation | Supply local evidence | YES requires all close preconditions. |

### 12.3 Delivery compatibility

| Capability | V1 | V1.1 | Future |
|---|---:|---:|---:|
| Chat/Work/Codex global entry and bootstrap | Yes | Expand syntax | More surfaces |
| Stage-based environment routing | Explicit policy | Compatibility registry and metrics | Autonomous cross-provider optimization |
| Role/model routing and overrides | Yes | Saved preferences and richer policy | Policy simulation |
| Skill progressive disclosure | Yes | Resource caching | Distributed capability graph |
| Three-way handoff | Yes | Resume and conflict UI | Multi-device live collaboration |
| Verification hard gates | Yes | Promptfoo regression suite | Continuous production evaluation |
| Systematic debugging | Yes | Failure analytics | Automated hypothesis search with approval |
| Recovery points and safe rollback | Yes | Rich checkpoints and dry-run rollback | Durable graph replay |
| Durable context and GitHub close verification | Yes | Multi-remote support | Artifact notarization policies |
| Trace/audit record | Evidence manifest | Full trace | Long-lived observability platform |
| LangGraph/OpenAI Agents SDK runtime | No | No required dependency | Evaluate only after a new design review |

## 13. Delivery boundaries

### V1 — reliable control-plane slice

V1 is complete only when the following are implemented as one coherent, testable path:

- Global normalized `@D-AI` entry and bootstrap for Chat, Work, and Codex adapters.
- Stage-based environment routing across Chat, Work, and Codex with capability checks.
- Task identity and the core state fields in Section 3.1.
- Explicit lifecycle stages and role-aware model routing.
- User model, role, and stage overrides with clear conflict errors.
- Capability registry lookup with metadata-first, skill-second, resource-on-demand loading.
- Minimum-context manifests and secret redaction for handoffs.
- Chat ↔ Work ↔ Codex handoff envelope, validation, acknowledgement, and single-owner execution.
- Durable context save and critical-unsaved-context detection before close.
- Verification hard gates with evidence, exit status, and stale-evidence handling.
- Systematic debugging loop and failure stop behavior.
- Known-good recovery points and safe rollback that preserves user work.
- `@D-AI close` with durable-context verification, recorded push success, exact GitHub repository/ref/SHA verification, and the three-way deletion verdict.
- Initial environment capability matrix and contract-level tests for all of the above.

V1 intentionally uses a small number of explicit transitions and adapters. It does not require a general graph runtime, a marketplace import, or automatic multi-agent delegation.

### V1.1 — stronger continuity and evaluation

V1.1 may add:

- Checkpoint/resume across sessions and more robust handoff conflict handling.
- A compatibility registry for model, environment, tool, and skill versions.
- Structured trace/audit views that link decisions to evidence.
- Promptfoo-backed regression and adversarial evaluation for routing, handoff, close, and failure behavior.
- Richer recovery manifests, dry-run rollback, and multi-remote verification.
- Measured routing policy improvements based on recorded latency, cost, and verification outcomes.

V1.1 must preserve V1's explicit gates and must not turn evaluation or tracing into an unreviewed self-modification loop.

### Future — deliberate expansion only after evidence

Future work may evaluate:

- Durable graph-style execution and replay inspired by LangGraph.
- More formal agent/runner/handoff/guardrail abstractions inspired by the OpenAI Agents SDK.
- Cross-environment orchestration, distributed locks, and multi-device collaboration.
- Stronger memory and knowledge layers with retention and provenance policies.
- Validation-gated routing evolution inspired by Darwin, with independent paired evaluation and human checkpoints.

These are research and decision areas, not V1 dependencies. Any future adoption requires a new design review demonstrating that it improves reliability without creating a second top-level orchestrator.

## 14. Design references and adopted patterns

| Reference | Pattern used in this spec | Boundary |
|---|---|---|
| [Agent Skills specification](https://agentskills.io/specification) and [Anthropic Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) | Standard skill directory shape, metadata-first discovery, progressive disclosure, on-demand resources. | D-AI routes skills; it does not replace the standard or load every skill. |
| [wshobson/agents](https://github.com/wshobson/agents) | Capability descriptions and automatic matching of task intent to specialized roles. | Use the routing idea; do not import its marketplace or make its agents the control plane. |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) | Explicit agent/runner separation, handoff concepts, guardrail thinking, and traceability as design vocabulary. | No SDK runtime dependency in V1. |
| [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) | Explicit state transitions, checkpoints, replay, and recovery as future design references. | No general graph engine in V1. |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | Declarative evaluation and CI-style regression gates for V1.1. | V1 uses direct contract checks; no evaluation framework is required to bootstrap the control plane. |
| [Superpowers](https://github.com/obra/superpowers) | Brainstorm → spec → approval → plan → implementation → verification, with deliberate checkpoints. | This workflow governs delivery; it is not embedded as a competing runtime orchestrator. |
| Taste (`design-taste-frontend`, installed local reference) | Context-sensitive design reading, anti-default bias, and preflight/audit discipline for future D-AI surfaces. | It informs UI quality; it does not define routing or backend architecture. |
| Darwin (`darwin-skill`, installed local reference) | Validation-gated evolution, independent comparison, explicit checkpoints, and reversible improvement. | No self-modifying router in V1; future changes require independent evidence and human approval. |

The local Taste and Darwin references are profile-local inputs and are not treated as portable repository dependencies. Their version and compatibility must be pinned during implementation planning if implementation needs them.

## 15. Testing and acceptance strategy

V1 testing should prefer real adapter and repository behavior over mocks. The minimum contract suite must cover:

1. Chat, Work, and Codex bootstrap create equivalent normalized state.
2. A normal intent selects a stage, compatible environment, minimal capability set, and no unrelated resources.
3. A user model, role, or environment override is honored; an impossible override fails clearly.
4. Each Chat ↔ Work ↔ Codex handoff is rejected when stale, malformed, mismatched, or already owned, and is resumed when valid.
5. A failed verification gate prevents a completion claim and enters the debugging path.
6. A debugging change preserves the failed state and re-runs the original check.
7. A recovery restores the known-good point without discarding uncommitted user work.
8. `@D-AI close` returns `NO` when durable context is not saved.
9. `@D-AI close` returns `NO` when critical unsaved context remains.
10. `@D-AI close` returns `NO` when GitHub push does not succeed.
11. `@D-AI close` returns `NO` when GitHub has a different SHA than the expected artifact.
12. `@D-AI close` returns `BLOCKED` when GitHub or required evidence cannot be checked.
13. `@D-AI close` returns `YES` only when every applicable precondition is freshly verified.
14. No close path deletes files or performs unrelated cleanup.

The implementation plan must map each case to a stable state identifier or accessibility/test identifier rather than relying on brittle visible-text clicks for UI automation.

## 16. Definition of Done

### Spec DoD for this document

- [x] V1, V1.1, and Future boundaries are explicit.
- [x] Chat, Work, and Codex bootstrap and global `@D-AI` entry are defined.
- [x] Stage-based environment routing and role/model routing with user overrides are defined.
- [x] Capability routing, progressive disclosure, and minimum context are defined.
- [x] Chat ↔ Work ↔ Codex handoff is versioned, validated, and single-owner.
- [x] Durable context, push success, remote state, and critical-unsaved-context close gates are explicit.
- [x] Verification gates, systematic debugging, recovery points, and rollback rules are defined.
- [x] `@D-AI close` requires exact GitHub commit verification and emits a constrained deletion verdict.
- [x] Compatibility matrix and contract-level acceptance cases are included.
- [x] Mature design references are linked or identified without adding competing orchestrators.
- [x] User approved this written spec before implementation planning began.

### V1 implementation DoD

V1 is done only when all V1 capabilities in Section 13 are implemented, the contract suite in Section 15 passes with fresh evidence, the repository diff is reviewable, failure and recovery paths have been exercised, and an independent review confirms that no gate is bypassed.

### Close-verdict DoD

The close feature is done only when a successful `YES` case and each negative/blocked case have been demonstrated against a real configured GitHub repository, with the exact repository, ref, SHA, local state, evidence manifest, and verdict visible in the audit record.

## 17. Approval boundary

This document is the design output for the approved v2 baseline. The next action is to invoke the writing-plans workflow and decompose V1 into implementation tasks. No orchestrator implementation, dependency installation, commit, push, or deletion operation is authorized by this spec-writing task.
