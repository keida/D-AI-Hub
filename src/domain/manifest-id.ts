import { InvalidTaskStateError } from "./errors.js";

const manifestIdPattern = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|manifest-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const secretShapedValuePattern = /(?:\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b|-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----)/i;
const secretShapedValueGlobalPattern = /(?:\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b|-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----)/gi;

export function isSafeManifestId(value: string): boolean {
  return manifestIdPattern.test(value);
}

export function assertSafeManifestId(value: string, label: string): void {
  if (!isSafeManifestId(value)) {
    throw new InvalidTaskStateError(`${label} must use a UUID or manifest-UUID format`);
  }
}

export function containsSecretShapedValue(value: string): boolean {
  return secretShapedValuePattern.test(value);
}

export function redactSecretShapedValues(value: string): string {
  return value.replace(secretShapedValueGlobalPattern, "[REDACTED]");
}
