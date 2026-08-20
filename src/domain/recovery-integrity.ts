function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length
    && rightSet.size === right.length
    && leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

export function hasExactPathHashEquality(
  leftPaths: readonly string[],
  leftHashes: Readonly<Record<string, string>>,
  rightPaths: readonly string[],
  rightHashes: Readonly<Record<string, string>>,
): boolean {
  const leftHashPaths = Object.keys(leftHashes);
  const rightHashPaths = Object.keys(rightHashes);
  if (!sameSet(leftPaths, rightPaths) || !sameSet(leftHashPaths, rightHashPaths) || !sameSet(leftPaths, leftHashPaths)) return false;
  return leftPaths.every((path) => leftHashes[path] === rightHashes[path]);
}
