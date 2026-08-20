import type { Environment } from "../domain/types.js";

export interface EnvironmentCapabilities {
  readonly environment: Environment;
  readonly capabilities: ReadonlySet<string>;
}
