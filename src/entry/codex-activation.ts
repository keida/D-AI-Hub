import { parseDAIInvocation } from "./command-parser.js";
import type { DAIResponse, ExternalDAIRequest } from "../runtime/d-ai-runtime.js";

export interface CodexActivationInput {
  readonly rawCommand: string;
  readonly taskId: string | null;
}

export type DAIRuntimeHandler = (request: ExternalDAIRequest) => Promise<DAIResponse>;

export function createCodexActivation(runtime: DAIRuntimeHandler): (input: CodexActivationInput) => Promise<DAIResponse> {
  return async (input: CodexActivationInput): Promise<DAIResponse> => {
    const parsed = parseDAIInvocation(input.rawCommand);
    const result = await runtime({
      command: parsed.command,
      sourceEnvironment: "codex",
      overrides: parsed.overrides,
      activeTaskId: input.taskId,
    });
    return result;
  };
}
