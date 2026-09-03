export type DeliveryCheckStatus = "PASS" | "FAIL" | "PENDING";
export type DeliveryBlockedAt = "context-read" | "workspace-prepare" | "implementation" | "focused-test" | "typecheck" | "publication-authority" | "publication" | "ci-wait" | "review-packet";

export interface PublicationAuthority {
  readonly grantedBy: string;
  readonly allowCommit: boolean;
  readonly allowPush: boolean;
  readonly allowCreatePR: boolean;
}

export interface DeliveryRequest {
  readonly taskId: string;
  readonly project: string | null;
  readonly requestText: string;
  readonly resumeExistingTask: boolean;
  readonly riskLevel: 1 | 2;
  readonly publicationRequested: boolean;
  readonly expectedEndpoint: "local-change" | "review-ready-pr";
  readonly publicationAuthority?: PublicationAuthority | null;
}

export interface DeliveryDependencies {
  readonly readContext: (request: DeliveryRequest) => Promise<{ readonly summary: string }>;
  readonly prepareWorkspace: (request: DeliveryRequest, context: { readonly summary: string }) => Promise<{ readonly branch: string; readonly clean: boolean }>;
  readonly implement: (request: DeliveryRequest, workspace: { readonly branch: string; readonly clean: boolean }) => Promise<{ readonly changes: readonly string[] }>;
  readonly runFocusedTest: (request: DeliveryRequest, changes: readonly string[]) => Promise<DeliveryVerification>;
  readonly runTypecheck: (request: DeliveryRequest, changes: readonly string[]) => Promise<DeliveryVerification>;
  readonly publish: (request: DeliveryRequest, workspace: { readonly branch: string; readonly clean: boolean }, changes: readonly string[]) => Promise<DeliveryPublication>;
  readonly waitForCI: (request: DeliveryRequest, publication: DeliveryPublication) => Promise<DeliveryCI>;
  /** The result is pre-final: review_packet_ms and totalActiveExecutionMs are not authoritative until the caller returns the final result. */
  readonly buildReviewPacket: (request: DeliveryRequest, result: DeliveryResult) => Promise<string>;
  readonly now?: () => number;
}

export interface DeliveryVerification {
  readonly status: "passed" | "failed";
  readonly detail: string;
}

export interface DeliveryPublication {
  readonly branch: string;
  readonly commit: string;
  readonly pr: string;
}

export interface DeliveryCI {
  readonly status: "passed" | "failed";
  readonly detail: string;
  readonly platforms: DeliveryPlatforms;
}

export interface AgentExecutionDirective {
  readonly kind: "codex-agent-delivery";
  readonly requestText: string;
  readonly project: string | null;
  readonly taskId: string;
  readonly resumed: boolean;
  readonly riskLevel: 1 | 2;
  readonly expectedEndpoint: "local-change" | "review-ready-pr";
  readonly publicationAuthorityRequired: boolean;
  readonly mergeAllowed: false;
  readonly nextAction: string;
}

export interface DeliveryPlatforms {
  readonly windows: DeliveryCheckStatus;
  readonly linux: DeliveryCheckStatus;
}

export interface DeliveryTimings {
  context_read_ms: number;
  workspace_prepare_ms: number;
  implementation_ms: number;
  typecheck_ms: number;
  focused_test_ms: number;
  publication_ms: number;
  ci_wait_ms: number;
  review_packet_ms: number;
}

export interface DeliveryResult {
  readonly status: "completed" | "blocked";
  readonly taskId: string;
  readonly intent: "delivery";
  readonly agentExecutionDirective?: AgentExecutionDirective;
  readonly riskLevel: 1 | 2;
  readonly resumed: boolean;
  readonly changes: readonly string[];
  readonly focusedTest: "passed" | "failed" | "not-run";
  readonly typecheck: "passed" | "failed" | "not-run";
  readonly ci: "passed" | "failed" | "not-run";
  readonly platforms: DeliveryPlatforms;
  readonly publicationStatus: DeliveryCheckStatus;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly pr: string | null;
  readonly mergePerformed: "NO";
  readonly timings: DeliveryTimings;
  readonly reviewPacket: string;
  readonly decisionRequired: string | null;
  readonly message: string;
  readonly totalActiveExecutionMs: number;
  readonly blockedAt: string | null;
  readonly reason: string | null;
  readonly userAction: string | null;
  readonly formatted?: string;
}

const emptyTimings = (): DeliveryTimings => ({
  context_read_ms: 0,
  workspace_prepare_ms: 0,
  implementation_ms: 0,
  typecheck_ms: 0,
  focused_test_ms: 0,
  publication_ms: 0,
  ci_wait_ms: 0,
  review_packet_ms: 0,
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasPublicationAuthority(authority: PublicationAuthority | null | undefined): authority is PublicationAuthority {
  return authority !== null
    && authority !== undefined
    && authority.grantedBy.trim().length > 0
    && authority.allowCommit
    && authority.allowPush
    && authority.allowCreatePR;
}

function hasCompletePassingPlatformEvidence(platforms: DeliveryPlatforms): boolean {
  return platforms.windows === "PASS" && platforms.linux === "PASS";
}

function createAgentExecutionDirective(request: DeliveryRequest): AgentExecutionDirective {
  return {
    kind: "codex-agent-delivery",
    requestText: request.requestText,
    project: request.project,
    taskId: request.taskId,
    resumed: request.resumeExistingTask,
    riskLevel: request.riskLevel,
    expectedEndpoint: request.expectedEndpoint,
    publicationAuthorityRequired: request.publicationRequested,
    mergeAllowed: false,
    nextAction: "Continue in the current Codex agent through the real workspace and verification seams; do not ask for another command",
  };
}

function baseBlockedResult(request: DeliveryRequest, message: string, decisionRequired: string, blockedAt: DeliveryBlockedAt | null, overrides: Partial<DeliveryResult> = {}): DeliveryResult {
  return {
    status: "blocked",
    taskId: request.taskId,
    intent: "delivery",
    riskLevel: request.riskLevel,
    resumed: request.resumeExistingTask,
    changes: [],
    focusedTest: "not-run",
    typecheck: "not-run",
    ci: "not-run",
    platforms: { windows: "PENDING", linux: "PENDING" },
    publicationStatus: "PENDING",
    branch: null,
    commit: null,
    pr: null,
    mergePerformed: "NO",
    timings: emptyTimings(),
    reviewPacket: "",
    decisionRequired,
    message,
    totalActiveExecutionMs: 0,
    blockedAt,
    reason: message,
    userAction: decisionRequired,
    ...overrides,
  };
}

function finalize(result: DeliveryResult): DeliveryResult {
  const totalActiveExecutionMs = Object.values(result.timings).reduce((total, value) => total + value, 0);
  return { ...result, totalActiveExecutionMs, formatted: formatDeliveryResult({ ...result, totalActiveExecutionMs }) };
}

export function formatDeliveryResult(result: DeliveryResult): string {
  const changes = result.changes.length === 0 ? "none" : result.changes.join(", ");
  const timing = Object.entries(result.timings).map(([key, value]) => `${key}=${value}ms`).join(", ");
  return [
    "D-AI Delivery Result",
    `Task: ${result.taskId}`,
    `Intent: ${result.intent} (Level ${result.riskLevel})`,
    `resumed: ${result.resumed ? "YES" : "NO"}`,
    `Changes: ${changes}`,
    `Focused test: ${result.focusedTest.toUpperCase()}`,
    `Typecheck: ${result.typecheck.toUpperCase()}`,
    `CI: ${result.ci.toUpperCase()}`,
    `Windows: ${result.platforms.windows}`,
    `Linux: ${result.platforms.linux}`,
    `Publication: ${result.publicationStatus}${result.branch === null ? "" : `, branch=${result.branch}`}${result.commit === null ? "" : `, commit=${result.commit}`}${result.pr === null ? "" : `, PR=${result.pr}`}`,
    `Timing: ${timing}`,
    `Total active execution: ${result.totalActiveExecutionMs}ms`,
    `Decision: ${result.decisionRequired ?? "none"}`,
    `Completed/Blocked: ${result.status === "completed" ? "COMPLETED" : "BLOCKED"}`,
    `Blocked at: ${result.blockedAt ?? "none"}`,
    `Reason: ${result.reason ?? "none"}`,
    `User action: ${result.userAction ?? "none"}`,
    "Merge performed: NO",
    `Status: ${result.status.toUpperCase()} — ${result.message}`,
  ].join("\n");
}

export function createDeliveryOrchestrator(dependencies: DeliveryDependencies): (request: DeliveryRequest) => Promise<DeliveryResult> {
  const now = dependencies.now ?? Date.now;
  return async (request: DeliveryRequest): Promise<DeliveryResult> => {
    const timings = emptyTimings();
    const timed = async <T>(key: keyof DeliveryTimings, operation: () => Promise<T>): Promise<T> => {
      const started = now();
      try {
        return await operation();
      } finally {
        timings[key] += Math.max(0, now() - started);
      }
    };

    let branch: string | null = null;
    let changes: readonly string[] = [];
    let focusedTest: DeliveryResult["focusedTest"] = "not-run";
    let typecheck: DeliveryResult["typecheck"] = "not-run";
    let activeStage: DeliveryBlockedAt = "context-read";
    try {
      activeStage = "context-read";
      const context = await timed("context_read_ms", () => dependencies.readContext(request));
      activeStage = "workspace-prepare";
      const workspace = await timed("workspace_prepare_ms", () => dependencies.prepareWorkspace(request, context));
      branch = workspace.branch;
      if (!workspace.clean) {
        return finalize(baseBlockedResult(request, "Delivery blocked because the prepared workspace is not clean", "Resolve unrelated workspace changes before implementation or publication", "workspace-prepare", { branch, timings }));
      }
      activeStage = "implementation";
      const implementation = await timed("implementation_ms", () => dependencies.implement(request, workspace));
      changes = implementation.changes;
      activeStage = "focused-test";
      const focused = await timed("focused_test_ms", () => dependencies.runFocusedTest(request, changes));
      focusedTest = focused.status;
      if (focused.status !== "passed") {
        return finalize(baseBlockedResult(request, `Delivery blocked after focused verification: ${focused.detail}`, "Resolve the focused verification failure before publication", "focused-test", { changes, branch, focusedTest, timings }));
      }
      activeStage = "typecheck";
      const checked = await timed("typecheck_ms", () => dependencies.runTypecheck(request, changes));
      typecheck = checked.status;
      if (checked.status !== "passed") {
        return finalize(baseBlockedResult(request, `Delivery blocked after typecheck: ${checked.detail}`, "Resolve the typecheck failure before publication", "typecheck", { changes, branch, focusedTest, typecheck, timings }));
      }

      if (!request.publicationRequested) {
        activeStage = "review-packet";
        const localResult = baseBlockedResult(request, "Local reversible implementation verified; publication was not requested", "Publication remains a separate Level 2 decision", null, {
          status: "completed",
          changes,
          branch,
          focusedTest,
          typecheck,
          timings,
        });
        const reviewPacket = await timed("review_packet_ms", () => dependencies.buildReviewPacket(request, localResult));
        return finalize({ ...localResult, reviewPacket, timings });
      }

      if (!hasPublicationAuthority(request.publicationAuthority)) {
        activeStage = "review-packet";
        const pendingPublication = baseBlockedResult(request, "Local delivery verified, but publication is blocked because publication authority is not explicit", "Explicit publication authority is required before commit, push, or PR creation", "publication-authority", {
          changes,
          branch,
          focusedTest,
          typecheck,
          timings,
        });
        const reviewPacket = await timed("review_packet_ms", () => dependencies.buildReviewPacket(request, pendingPublication));
        return finalize({ ...pendingPublication, reviewPacket, timings });
      }

      activeStage = "publication";
      const publication = await timed("publication_ms", () => dependencies.publish(request, workspace, changes));
      activeStage = "ci-wait";
      const ci = await timed("ci_wait_ms", () => dependencies.waitForCI(request, publication));
      if (ci.status !== "passed" || !hasCompletePassingPlatformEvidence(ci.platforms)) {
        const detail = ci.status !== "passed"
          ? ci.detail
          : "Aggregate CI passed without PASS evidence for both Windows and Linux";
        return finalize(baseBlockedResult(request, `Delivery blocked by CI: ${detail}`, "Resolve the CI result before review-ready delivery", "ci-wait", {
          changes,
          focusedTest,
          typecheck,
          ci: "failed",
          platforms: ci.platforms,
          publicationStatus: "PASS",
          branch: publication.branch,
          commit: publication.commit,
          pr: publication.pr,
          timings,
        }));
      }
      activeStage = "review-packet";
      const completed: DeliveryResult = {
        status: "completed",
        taskId: request.taskId,
        intent: "delivery",
        riskLevel: request.riskLevel,
        resumed: request.resumeExistingTask,
        changes,
        focusedTest,
        typecheck,
        ci: "passed",
        platforms: ci.platforms,
        publicationStatus: "PASS",
        branch: publication.branch,
        commit: publication.commit,
        pr: publication.pr,
        mergePerformed: "NO",
        timings,
        reviewPacket: "",
        decisionRequired: "Separate review and merge authorization are required",
        message: "Delivery completed through publication and CI; merge was not performed",
        totalActiveExecutionMs: 0,
        blockedAt: null,
        reason: null,
        userAction: null,
      };
      const reviewPacket = await timed("review_packet_ms", () => dependencies.buildReviewPacket(request, completed));
      return finalize({ ...completed, reviewPacket, timings });
    } catch (error: unknown) {
      return finalize(baseBlockedResult(request, `Delivery blocked by dependency error: ${errorMessage(error)}`, "Resolve the reported dependency error before continuing", activeStage, {
        changes,
        branch,
        focusedTest,
        typecheck,
        timings,
      }));
    }
  };
}

export function createCodexExecutionBoundary(): (request: DeliveryRequest) => Promise<DeliveryResult> {
  return async (request) => finalize({
    ...baseBlockedResult(
      request,
      "The CLI classified this delivery request, but actual implementation must continue in the canonical Codex agent boundary; no files, tests, commits, pushes, or PRs were performed",
      "Continue through the Codex Skill/agent execution seam for Level 1 implementation; request Level 2 publication authority separately",
      "implementation",
    ),
    agentExecutionDirective: createAgentExecutionDirective(request),
  });
}
