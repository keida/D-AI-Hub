# ADR 0001: Explicit actor and session identity

- Status: Proposed
- Date: 2026-09-03

## Context

The V1 runtime currently represents execution identity with `environment`, `role`, and task ownership. `environment` selects a capability surface (`chat`, `work`, or `codex`), while `role` describes work such as planning, implementation, or review. Ownership is fenced by task and environment.

That model cannot distinguish two long-lived chats in the same environment. In particular, a Boss chat and a Worker chat may both use `chat`, while having different authority and stable identities. Treating either the environment, role, model name, or transient request as the actor would conflate capability location, responsibility, authorization, and conversation identity.

The current model router also chooses among otherwise matching policies by lexically sorting model names. That behavior is deterministic, but it does not express product intent and can silently change when a model is renamed.

## Decision

Introduce four separate concepts in a future compatible runtime change:

- `environment`: the execution surface and its available capabilities. Values remain `chat`, `work`, and `codex`.
- `actor`: the authority class participating in the workflow. Initial values are `boss` and `worker`.
- `role`: the responsibility performed for the current stage. The existing role vocabulary remains valid; the initial Boss/Worker workflow relies on `planner`, `implementer`, `reviewer`, `evidence-collector`, and `recovery-operator`.
- `sessionId`: the stable identity of one long-lived chat or execution session. It identifies an instance of an actor, not an authority class.

These fields have independent meanings. An environment does not grant authority, a role does not identify a session, and a model name grants neither authority nor identity.

### Actor authority

The default Boss responsibilities are decision-making, scope approval, review, and release approval. A Boss does not receive ordinary implementation-mutation authority merely because it is the Boss. Any exceptional mutation must be explicitly authorized and recorded through the same policy boundary as other actions.

The default Worker responsibilities are implementation, testing, and evidence collection within an approved scope. A Worker cannot expand its own scope, merge, or perform destructive cleanup without separate explicit authority.

Actor policy is an authorization input. Role and environment remain routing and validation inputs. `sessionId` binds durable state and receipts to the concrete long-lived participant. None replaces the existing task/environment ownership lease; a future migration must strengthen that lease with actor/session binding before relying on these fields for writes.

### Model recommendations

The initial recommendations are:

- Boss: Sol with medium reasoning effort.
- Worker: Luna with high reasoning effort.

These are replaceable configuration defaults, not safety boundaries. Changing the configured model must not change actor authority. A model named Sol or Luna must not acquire permissions merely from its name.

### Model policy selection

Replace implicit model-name ordering with explicit policy metadata. The proposed shape is:

```ts
interface ModelPolicy {
  readonly id: string;
  readonly actor: "boss" | "worker";
  readonly stage: Stage;
  readonly role: Role;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly priority: number;
  readonly isDefault: boolean;
  readonly allowFallback: boolean;
  readonly requiredCapabilities: readonly string[];
  readonly compatibleEnvironments: readonly Environment[];
}
```

Policy IDs must be unique. Policies whose compatible-environment arrays overlap are expanded when checking invariants: for a given `(actor, stage, role, environment)`, exactly one compatible policy may have `isDefault: true`. A new `policyId` override selects one exact compatible policy. The legacy model-string override remains readable during migration, but must match exactly one compatible policy or fail closed. Without an override, the unique default is selected. `priority` orders non-default candidates only when that default declares `allowFallback: true`; no default, duplicate defaults, a tie at the highest eligible priority, or an incompatible override fails closed. Model-name sorting is not a fallback.

### Session binding

The proposed durable binding is additive:

```ts
interface ActorSession {
  readonly actor: "boss" | "worker";
  readonly sessionId: string;
}

type AuthorizedAction =
  | "decide"
  | "approve-scope"
  | "implement"
  | "test"
  | "collect-evidence"
  | "review"
  | "approve-release"
  | "merge"
  | "destructive-cleanup";

interface ActorAuthorization {
  readonly authorizationId: string;
  readonly taskId: string;
  readonly subject: ActorSession;
  readonly scopeRef: string;
  readonly scopeSha256: string;
  readonly allowedActions: readonly AuthorizedAction[];
  readonly deniedActions: readonly AuthorizedAction[];
  readonly issuedBy: ActorSession | "trusted-operator";
  readonly ownershipGeneration: string;
  readonly nonce: string;
  readonly use: "standing" | "single-use";
}

interface TaskState {
  // Existing fields remain during migration.
  readonly actorSession?: ActorSession;
  readonly actorAuthorization?: ActorAuthorization;
}
```

`sessionId` must be non-empty, opaque, and stable for the life of the long-lived chat. It must not contain credentials or be treated as proof of authority by itself. `scopeRef` identifies the canonical approved task packet or scope record; `scopeSha256` binds the grant to its exact canonical bytes. The authorization validator applies explicit deny before allow. A normal Worker grant includes `implement`, `test`, and `collect-evidence` within the bound scope, and explicitly denies `merge` and `destructive-cleanup`. Exceptional Boss implementation mutation is a separately recorded, scope-bound, single-use grant rather than an implication of the `boss` actor value.

A write must match the persisted task, environment, actor/session binding, authorization scope digest, action, and ownership generation. Consuming a single-use grant increments the generation and records its nonce so it cannot be replayed. Free-text `goal` and `constraints` may be displayed but are not an enforceable authorization seam.

### Trusted bootstrap and rebinding

An incoming request may not self-declare `boss`, `worker`, or a trusted `sessionId`. Initial binding requires a configured host trust adapter to attest the opaque session identity plus an explicit operator-approved actor designation. The runtime persists that attestation as the initial authorization receipt under the current task ownership lease. If the host cannot attest a stable session identity, legacy tasks remain readable but actor-authorized mutations are blocked.

A bound Boss may issue a scoped Worker authorization only after validating the target host session attestation. Rebinding requires the current ownership generation, an unused nonce, the target actor/session, the replacement scope digest, and a reason. A Worker cannot issue or broaden its own grant. Stale generations, replayed nonces, untrusted target identities, and requests whose claimed session differs from the host attestation fail closed.

### Atomic handoff and actor/session transfer

An environment-only handoff preserves actor/session binding. A cross-session transfer uses one versioned pending-transition record containing source and target environment, actor, session, scope digest, expected ownership generation, and nonce. The target acknowledgement validates both connector capability and target host attestation. Only then may one durable-store transaction update the environment lease, actor/session binding, authorization generation, and transition state while consuming the nonce.

If acknowledgement or that transaction fails, the source lease and binding remain authoritative and the pending transition is rejected or safely retryable. A successful replay returns the existing receipt; a conflicting replay is rejected. An adapter/store that cannot provide this atomic transition must report the cross-session handoff as unsupported rather than performing separate environment and session writes.

Boss review consumes actual diffs, tests, execution evidence, and Git/GitHub state. It must not request, persist, or treat hidden reasoning as review evidence.

## Migration plan

1. Define version-2 durable schemas and canonical serialization for actor session, authorization receipts, ownership transitions, routing decisions, verification evidence, recovery points, close candidates, and handoff envelopes. New actor/session fields participate in v2 integrity hashes; existing v1 bytes and hashes are never silently reinterpreted or rewritten.
2. Ship dual readers that accept strict v1 and strict v2 records, while writers continue to emit v1. Unknown versions and extra fields remain rejected. Add a capability/version handshake so a v2 envelope is emitted only to a target that explicitly advertises v2 support; a v1 receiver is never expected to accept a v2 envelope.
3. Add the trusted host identity adapter and operator-approved initial-binding ceremony. Newly bound tasks receive a v2 actor/session authorization; legacy tasks remain readable, but actor-authorized mutations stay blocked until this ceremony succeeds. Do not infer identity from environment, role, model, task owner token, or request fields.
4. Add `id`, `actor`, `priority`, `isDefault`, and `allowFallback` model-policy fields behind a compatibility adapter, plus a `policyId` routing override. Translate legacy policies into deterministic read-only IDs, and reject ambiguous legacy model-string overrides. Continue the current v1 selection path until every active configuration passes the explicit-default invariants.
5. Extend the durable store with the atomic environment/actor/session transition and replay receipt. Only after all participating adapters advertise v2 may handoff write v2 and include the target attestation. Rollback restores the complete prior v2 lease/binding/authorization tuple; it never downgrades a v2 record to v1.
6. Switch new task writes and default model selection to v2 behind an explicit migration gate. Preserve rollback by retaining v1 readers and snapshots until the configured retention boundary has passed. Remove v1 writers and the compatibility adapter only after mixed-version and recovery evidence is accepted.
7. Keep Chat and Work product activation, automatic cross-chat communication, and automatic actor discovery out of this migration.

Each step should be independently releasable. A partially migrated runtime must fail closed for actor-authorized mutations rather than inventing identity from legacy fields.

## Test plan

- Prove that Boss and Worker sessions can share `chat` while retaining distinct actor/session identities and authority.
- Reject duplicate policy IDs and two defaults for the same `(actor, stage, role, environment)`.
- Prove that renaming model strings does not change the selected default.
- Reject missing or ambiguous defaults, tied fallback priorities, incompatible environment/capability combinations, unknown `policyId` overrides, ambiguous legacy model-string overrides, and unauthorized model overrides.
- Preserve legacy environment-only reads, while blocking actor-privileged writes until an explicit binding is established.
- Reject self-declared initial actors, forged host attestations, replayed initial bindings, stale generations, reused nonces, scope-digest mismatches, and Worker attempts to issue or broaden authorization.
- Enforce action grants and explicit denies, including normal Worker denial of merge and destructive cleanup and single-use exceptional Boss mutation.
- Reject stale, mismatched, or forged actor/session ownership on save, continue, handoff, recovery, rollback, close, and review receipts.
- Prove that environment handoff does not silently change actor/session binding and that failed acknowledgement leaves neither partial ownership nor an orphan active handoff.
- Prove atomic cross-session transition, idempotent successful replay, conflicting replay rejection, and source ownership preservation after acknowledgement or persistence failure.
- Prove strict v1/v2 reading, gated v2 writing, integrity-hash coverage of new fields, old-hash preservation, mixed-version rejection/negotiation, and complete rollback without version downgrade.
- Prove that Worker scope expansion, merge, and destructive cleanup remain blocked without separate authority.
- Prove that review evidence contains observable artifacts and does not require hidden reasoning.

Tests should exercise the public runtime and real durable store seams where practical. Schema-only unit tests are useful for invariant failures, but they are not sufficient evidence for ownership or handoff behavior.

## Risks and consequences

- Adding identity to every durable artifact is a cross-cutting migration. Implementing it in one large change would risk inconsistent validation and legacy-state corruption.
- Optional compatibility fields can create a false sense of enforcement. Actor-dependent authorization must remain blocked until the relevant write path validates an explicit binding.
- Stable session identity depends on the host supplying a trustworthy opaque identifier. The repository cannot manufacture or verify a platform session identity when the host does not expose one.
- Scope digests prove equality to an approved artifact, not that its contents are safe or complete. Boss review remains responsible for the actual scope decision.
- Versioned envelopes and hashes increase migration and rollback cost. Dual readers and gated writers are required to avoid breaking strict older receivers or invalidating historical evidence.
- Model catalogs and names change. Keeping recommendations as configuration avoids coupling authority to provider branding, but requires explicit configuration validation.
- Existing environment ownership remains necessary for capability and handoff safety. Actor/session identity complements it rather than replacing it.

This ADR does not activate Chat or Work, implement automatic routing between chats, create a second orchestrator, or change current V1 runtime behavior. Runtime implementation is deferred because the required ownership, persistence, routing, evidence, recovery, and handoff changes are not a sufficiently local PR.
