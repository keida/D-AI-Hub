import { redactSensitiveText } from "../adapters/command-runner.js";

export class InvalidRepositoryHealthCheckInputError extends Error {
  public constructor(message: string) {
    super(redactSensitiveText(message));
    this.name = "InvalidRepositoryHealthCheckInputError";
  }
}

export class RepositoryHealthPathTraversalError extends Error {
  public constructor(message: string) {
    super(redactSensitiveText(message));
    this.name = "RepositoryHealthPathTraversalError";
  }
}

export class RepositoryHealthTextDecodingError extends Error {
  public constructor(relativePath: string) {
    super(redactSensitiveText(`Invalid UTF-8 text file: ${relativePath}`));
    this.name = "RepositoryHealthTextDecodingError";
  }
}
