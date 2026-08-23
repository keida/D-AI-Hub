import type { HandoffStatus, HandoffService } from "../../handoff/handoff-service.js";
import type { HandoffEnvelope } from "../../handoff/envelope.js";
import type { EnvironmentCapabilities } from "../../routing/environment-capabilities.js";
import { InvalidTaskStateError } from "../../domain/errors.js";
import type { EnvironmentExecutionRequest, EnvironmentExecutionResult, EnvironmentExecutor } from "../../runtime/d-ai-runtime.js";

export class ChatEnvironmentAdapter {
  private readonly executor: EnvironmentExecutor | null;

  public constructor(handoffService: HandoffService & { readonly status: (handoffId: string) => HandoffStatus });
  public constructor(handoffService: HandoffService & { readonly status: (handoffId: string) => HandoffStatus }, executor: EnvironmentExecutor);
  public constructor(
    private readonly handoffService: HandoffService & { readonly status: (handoffId: string) => HandoffStatus },
    executor?: EnvironmentExecutor,
  ) {
    this.executor = executor ?? null;
  }

  public capabilities(): EnvironmentCapabilities {
    return { environment: "chat", capabilities: new Set(["approval", "status"]) };
  }

  public async receive(envelope: HandoffEnvelope): Promise<void> {
    await this.handoffService.acknowledge(envelope, this.capabilities());
  }

  public async ready(): Promise<void> {
    await this.handoffService.ready();
  }

  public async complete(handoffId: string): Promise<void> {
    await this.handoffService.complete(handoffId, "chat");
  }

  public status(handoffId: string): HandoffStatus {
    return this.handoffService.status(handoffId);
  }

  public async execute(request: EnvironmentExecutionRequest): Promise<EnvironmentExecutionResult> {
    if (this.executor === null) {
      throw new InvalidTaskStateError("Chat execution adapter is not configured");
    }
    return this.executor(request);
  }
}
