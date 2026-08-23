export class InvalidTaskStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidTaskStateError";
  }
}

export class CapabilityMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CapabilityMismatchError";
  }
}

export class InvalidHandoffError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidHandoffError";
  }
}

export class VerificationGateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VerificationGateError";
  }
}

export class UnsavedContextError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsavedContextError";
  }
}

export class CloseBlockedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CloseBlockedError";
  }
}

export class TaskOwnershipError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TaskOwnershipError";
  }
}
