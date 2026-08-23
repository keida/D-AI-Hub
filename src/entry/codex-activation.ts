import { parseDAICommand } from "./command-parser.js";
import type { DAIResponse, ExternalDAIRequest } from "../runtime/d-ai-runtime.js";

export interface CodexActivationInput {
  readonly rawCommand: string;
  readonly taskId: string | null;
}

export type DAIRuntimeHandler = (request: ExternalDAIRequest) => Promise<DAIResponse>;

export function createCodexActivation(runtime: DAIRuntimeHandler): (input: CodexActivationInput) => Promise<DAIResponse> {
  return async (input: CodexActivationInput): Promise<DAIResponse> => {
    const command = parseDAICommand(input.rawCommand);
    const result = await runtime({
      command,
      sourceEnvironment: "codex",
      overrides: { model: null, role: null, environment: null, stage: null },
      activeTaskId: input.taskId,
    });
    return result;
  };
}
