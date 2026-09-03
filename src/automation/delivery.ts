export type DeliveryCheckStatus = "PASS" | "FAIL" | "PENDING";

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

export interface DeliveryPlatforms {
  readonly windows: DeliveryCheckStatus;
  readonly linux: DeliveryCheckStatus;
}

export interface DeliveryTimings {
  context_read_ms: number;
  workspace_prepare_ms: number;
  implementation_ms: number;
  focused_test_ms: number;
  publication_ms: number;
  ci_wait_ms: number;
  review_packet_ms: number;
}

export interface DeliveryResult {
  readonly status: "completed" | "blocked";
  readonly taskId: string;
  readonly intent: "delivery";
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

function baseBlockedResult(request: DeliveryRequest, message: string, decisionRequired: string, overrides: Partial<DeliveryResult> = {}): DeliveryResult {
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
    blockedAt: "delivery",
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
    try {
      const context = await timed("context_read_ms", () => dependencies.readContext(request));
      const workspace = await timed("workspace_prepare_ms", () => dependencies.prepareWorkspace(request, context));
      branch = workspace.branch;
      if (!workspace.clean) {
        return finalize(baseBlockedResult(request, "Delivery blocked because the prepared workspace is not clean", "Resolve unrelated workspace changes before implementation or publication", { branch, timings }));
      }
      const implementation = await timed("implementation_ms", () => dependencies.implement(request, workspace));
      changes = implementation.changes;
      const focused = await timed("focused_test_ms", () => dependencies.runFocusedTest(request, changes));
      focusedTest = focused.status;
      if (focused.status !== "passed") {
        return finalize(baseBlockedResult(request, `Delivery blocked after focused verification: ${focused.detail}`, "Resolve the focused verification failure before publication", { changes, branch, focusedTest, timings }));
      }
      const checked = await timed("implementation_ms", () => dependencies.runTypecheck(request, changes));
      typecheck = checked.status;
      if (checked.status !== "passed") {
        return finalize(baseBlockedResult(request, `Delivery blocked after typecheck: ${checked.detail}`, "Resolve the typecheck failure before publication", { changes, branch, focusedTest, typecheck, timings }));
      }

      if (!request.publicationRequested) {
        const localResult = baseBlockedResult(request, "Local reversible implementation verified; publication was not requested", "Publication remains a separate Level 2 decision", {
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
        const pendingPublication = baseBlockedResult(request, "Local delivery verified, but publication is blocked because publication authority is not explicit", "Explicit publication authority is required before commit, push, or PR creation", {
          changes,
          branch,
          focusedTest,
          typecheck,
          timings,
        });
        const reviewPacket = await timed("review_packet_ms", () => dependencies.buildReviewPacket(request, pendingPublication));
        return finalize({ ...pendingPublication, reviewPacket, timings });
      }

      const publication = await timed("publication_ms", () => dependencies.publish(request, workspace, changes));
      const ci = await timed("ci_wait_ms", () => dependencies.waitForCI(request, publication));
      if (ci.status !== "passed") {
        return finalize(baseBlockedResult(request, `Delivery blocked by CI: ${ci.detail}`, "Resolve the CI result before review-ready delivery", {
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
        platforms: { windows: "PASS", linux: "PASS" },
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
      return finalize(baseBlockedResult(request, `Delivery blocked by dependency error: ${errorMessage(error)}`, "Resolve the reported dependency error before continuing", {
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
  return async (request) => finalize(baseBlockedResult(
    request,
    "The CLI classified this delivery request, but actual implementation must continue in the canonical Codex agent boundary; no files, tests, commits, pushes, or PRs were performed",
    "Continue through the Codex Skill/agent execution seam for Level 1 implementation; request Level 2 publication authority separately",
  ));
}
