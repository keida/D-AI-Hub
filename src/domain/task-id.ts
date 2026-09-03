const durableTaskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isDurableTaskId(value: string): boolean {
  return durableTaskIdPattern.test(value);
}
