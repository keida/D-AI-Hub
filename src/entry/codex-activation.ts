import { parseDAIInvocation } from "./command-parser.js";
import { classifyUserIntent, type UserIntent } from "../automation/user-intent.js";
import type { DeliveryRequest, DeliveryResult, PublicationAuthority } from "../automation/delivery.js";
import type { DAIResponse, ExternalDAIRequest } from "../runtime/d-ai-runtime.js";

export interface CodexActivationInput {
  readonly rawCommand: string;
  readonly taskId: string | null;
}

export interface CodexActivationOptions {
  readonly deliver?: (request: DeliveryRequest) => Promise<DeliveryResult>;
  readonly publicationAuthority?: PublicationAuthority | null;
}

export interface CodexActivationResponse extends DAIResponse {
  readonly userIntent?: UserIntent;
  readonly deliveryResult?: DeliveryResult;
}

export type DAIRuntimeHandler = (request: ExternalDAIRequest) => Promise<DAIResponse>;

function defaultsForStatus(): ReturnType<typeof parseDAIInvocation> {
  return parseDAIInvocation("@D-AI status");
}

function isExplicitStatusOverride(text: string): boolean {
  return /^@D-AI\s+status(?:\s|[,，:：]|$)/iu.test(text.trim());
}

function naturalResponse(input: CodexActivationInput, intent: UserIntent, status: DAIResponse["status"], message: string): CodexActivationResponse {
  return {
    taskId: input.taskId ?? "unassigned",
    stage: intent.intent === "discuss" || intent.intent === "status" ? "inspect" : "execute",
    environment: "codex",
    status,
    evidence: [],
    message,
    userIntent: intent,
  };
}

export function createCodexActivation(runtime: DAIRuntimeHandler, options: CodexActivationOptions = {}): (input: CodexActivationInput) => Promise<CodexActivationResponse> {
  return async (input: CodexActivationInput): Promise<CodexActivationResponse> => {
    const rawText = input.rawCommand.trim();
    if (rawText.startsWith("@D-AI")) {
      const parsed = isExplicitStatusOverride(rawText) ? defaultsForStatus() : parseDAIInvocation(rawText);
      return runtime({
        command: parsed.command,
        sourceEnvironment: "codex",
        overrides: parsed.overrides,
        activeTaskId: input.taskId,
      });
    }

    const intent = classifyUserIntent(rawText);
    if (intent.intent === "discuss") {
      return naturalResponse(input, intent, "accepted", "Read-only discussion; no durable task was created or mutated");
    }
    if (intent.intent === "status") {
      const parsed = defaultsForStatus();
      const result = await runtime({ command: parsed.command, sourceEnvironment: "codex", overrides: parsed.overrides, activeTaskId: input.taskId });
      return { ...result, userIntent: intent };
    }
    if (intent.intent === "continue") {
      if (intent.project === null) return naturalResponse(input, intent, "blocked", "Continue is blocked because no task or project was identified");
      const parsed = parseDAIInvocation(`@D-AI continue ${intent.project}`);
      const result = await runtime({ command: parsed.command, sourceEnvironment: "codex", overrides: parsed.overrides, activeTaskId: input.taskId });
      return { ...result, userIntent: intent };
    }
    if (intent.intent === "close" || intent.intent === "rollback") {
      const parsed = parseDAIInvocation(`@D-AI ${intent.intent}`);
      const result = await runtime({ command: parsed.command, sourceEnvironment: "codex", overrides: parsed.overrides, activeTaskId: input.taskId });
      return { ...result, userIntent: intent };
    }
    if (intent.intent === "delivery") {
      if (options.deliver === undefined) {
        return naturalResponse(input, intent, "blocked", "Delivery orchestration is unavailable; explicit publication authority is required before commit, push, or PR creation");
      }
      const deliveryRequest: DeliveryRequest = {
        taskId: input.taskId ?? "unassigned",
        project: intent.project,
        requestText: intent.text,
        resumeExistingTask: intent.resumeExistingTask,
        riskLevel: intent.riskLevel === 2 ? 2 : 1,
        publicationRequested: intent.expectedEndpoint === "review-ready-pr",
        publicationAuthority: options.publicationAuthority ?? null,
      };
      const deliveryResult = await options.deliver(deliveryRequest);
      return {
        taskId: deliveryResult.taskId,
        stage: "execute",
        environment: "codex",
        status: deliveryResult.status,
        evidence: [],
        message: deliveryResult.formatted ?? deliveryResult.message,
        userIntent: intent,
        deliveryResult,
      };
    }
    return naturalResponse(input, intent, "blocked", `${intent.intent} is recognized but unavailable in this local MVP; it remains fail-closed`);
  };
}
