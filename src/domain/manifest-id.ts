import { InvalidTaskStateError } from "./errors.js";

const manifestIdPattern = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|manifest-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const pemPrivateKeyBlockPattern = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/i;
const pemPrivateKeyBlockGlobalPattern = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gi;
const truncatedPemPrivateKeyBlockGlobalPattern = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*$/gi;
const secretShapedValuePattern = /(?:\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)/i;
const secretShapedValueGlobalPattern = /(?:\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)/gi;
const credentialAssignmentPattern = /(?:api[_-]?key|token|secret|password|passwd|auth|authorization|credential|access[_-]?token|private[_-]?key|cookie|session[_-]?token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"']+)/i;
const bearerPattern = /(?:authorization\s*:\s*)?bearer\s+(?:"[^"]*"|'[^']*'|[^\s"']+)/i;

export function isSafeManifestId(value: string): boolean {
  return manifestIdPattern.test(value);
}

export function assertSafeManifestId(value: string, label: string): void {
  if (!isSafeManifestId(value)) {
    throw new InvalidTaskStateError(`${label} must use a UUID or manifest-UUID format`);
  }
}

export function containsSecretShapedValue(value: string): boolean {
  return secretShapedValuePattern.test(value)
    || pemPrivateKeyBlockPattern.test(value)
    || credentialAssignmentPattern.test(value)
    || bearerPattern.test(value);
}

export function redactSecretShapedValues(value: string): string {
  return value
    .replace(pemPrivateKeyBlockGlobalPattern, "[REDACTED]")
    .replace(truncatedPemPrivateKeyBlockGlobalPattern, "[REDACTED]")
    .replace(secretShapedValueGlobalPattern, "[REDACTED]");
}
