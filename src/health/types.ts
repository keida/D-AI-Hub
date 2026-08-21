export type HealthCheckId = "index" | "link" | "secret" | "skill-frontmatter";

export type HealthSeverity = "error" | "warning";

export interface HealthFinding {
  readonly checkId: HealthCheckId;
  readonly severity: HealthSeverity;
  readonly relativePath: string;
  readonly line?: number;
  readonly message: string;
}

export interface HealthSummaryCounts {
  readonly total: number;
  readonly errors: number;
  readonly warnings: number;
}

export interface RepositoryHealthReport {
  readonly healthy: boolean;
  readonly findings: readonly HealthFinding[];
  readonly summary: HealthSummaryCounts;
}

export interface RepositoryHealthScanConfiguration {
  readonly enabledChecks: readonly HealthCheckId[];
  readonly candidatePaths: readonly string[];
}

export interface RepositoryHealthCheckInput {
  readonly repositoryRoot: string;
  readonly scan: RepositoryHealthScanConfiguration;
}
