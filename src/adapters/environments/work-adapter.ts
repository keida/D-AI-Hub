import type { HandoffStatus, HandoffService } from "../../handoff/handoff-service.js";
import type { HandoffEnvelope } from "../../handoff/envelope.js";
import type { EnvironmentCapabilities } from "../../routing/environment-capabilities.js";

export class WorkEnvironmentAdapter {
  public constructor(private readonly handoffService: HandoffService & { readonly status: (handoffId: string) => HandoffStatus }) {}

  public capabilities(): EnvironmentCapabilities {
    return { environment: "work", capabilities: new Set(["durable-context"]) };
  }

  public async receive(envelope: HandoffEnvelope): Promise<void> {
    await this.handoffService.acknowledge(envelope, this.capabilities());
  }

  public async ready(): Promise<void> {
    await this.handoffService.ready();
  }

  public async complete(handoffId: string): Promise<void> {
    await this.handoffService.complete(handoffId, "work");
  }

  public status(handoffId: string): HandoffStatus {
    return this.handoffService.status(handoffId);
  }
}
