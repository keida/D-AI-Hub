import type { HandoffStatus, HandoffService } from "../../handoff/handoff-service.js";
import type { HandoffEnvelope } from "../../handoff/envelope.js";
import type { EnvironmentCapabilities } from "../../routing/environment-capabilities.js";

export class CodexEnvironmentAdapter {
  public constructor(private readonly handoffService: HandoffService & { readonly status: (handoffId: string) => HandoffStatus }) {}

  public capabilities(): EnvironmentCapabilities {
    return { environment: "codex", capabilities: new Set(["local-execution", "codex-evidence"]) };
  }

  public async receive(envelope: HandoffEnvelope): Promise<void> {
    await this.handoffService.acknowledge(envelope, this.capabilities());
  }

  public status(handoffId: string): HandoffStatus {
    return this.handoffService.status(handoffId);
  }
}
