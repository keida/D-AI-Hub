import type { HandoffStatus, HandoffService } from "../../handoff/handoff-service.js";
import type { HandoffEnvelope } from "../../handoff/envelope.js";
import type { EnvironmentCapabilities } from "../../routing/environment-capabilities.js";
import { InvalidTaskStateError } from "../../domain/errors.js";
import type { EnvironmentExecutionRequest, EnvironmentExecutionResult, EnvironmentExecutor, HandoffActivationConnector } from "../../runtime/d-ai-runtime.js";

export class CodexEnvironmentAdapter {
  private readonly executor: EnvironmentExecutor | null;
  private readonly activationConnector: HandoffActivationConnector | null;

  public constructor(
    private readonly handoffService: HandoffService & { readonly status: (handoffId: string) => HandoffStatus },
    executor?: EnvironmentExecutor,
    activationConnector?: HandoffActivationConnector,
  ) {
    this.executor = executor ?? null;
    this.activationConnector = activationConnector ?? null;
  }

  public capabilities(): EnvironmentCapabilities {
    return { environment: "codex", capabilities: new Set(["local-execution", "codex-evidence"]) };
  }

  public canReceiveHandoff(): boolean {
    return this.executor !== null && this.activationConnector !== null;
  }

  public async receive(envelope: HandoffEnvelope): Promise<void> {
    if (this.activationConnector === null) throw new InvalidTaskStateError("Codex activation connector is not configured");
    await this.handoffService.reserve(envelope, this.capabilities());
    await this.activationConnector(envelope);
    await this.handoffService.acknowledge(envelope, this.capabilities());
  }

  public async ready(): Promise<void> {
    await this.handoffService.ready();
  }

  public async complete(handoffId: string): Promise<void> {
    await this.handoffService.complete(handoffId, "codex");
  }

  public status(handoffId: string): HandoffStatus {
    return this.handoffService.status(handoffId);
  }

  public async execute(request: EnvironmentExecutionRequest): Promise<EnvironmentExecutionResult> {
    if (this.executor === null) {
      throw new InvalidTaskStateError("Codex execution adapter is not configured");
    }
    return this.executor(request);
  }
}
