import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { parse } from "yaml";
import { CapabilityMismatchError, InvalidTaskStateError } from "../domain/errors.js";
import type { Environment, Stage } from "../domain/types.js";

export interface SkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly compatibleEnvironments: readonly Environment[];
  readonly compatibleStages: readonly Stage[];
  readonly requiredResources?: readonly string[];
  readonly skillPath: string;
}

interface ParsedSkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: ParsedSkillMetadata;
}

interface ParsedSkillMetadata {
  readonly triggers?: string;
  readonly compatibleEnvironments?: string;
  readonly compatibleStages?: string;
  readonly requiredResources?: string;
}

const knownEnvironments: ReadonlySet<string> = new Set(["chat", "work", "codex"]);
const knownStages: ReadonlySet<string> = new Set([
  "bootstrap",
  "route",
  "plan",
  "execute",
  "inspect",
  "verify",
  "debug",
  "recover",
  "handoff",
  "close",
]);
const maximumFrontmatterBytes = 16_384;
const skillNamePattern = /^[a-z0-9][a-z0-9-]*$/;

export function isSafeSkillName(name: string): boolean {
  return skillNamePattern.test(name);
}

function assertEnvironment(value: string, context: string): asserts value is Environment {
  if (!knownEnvironments.has(value)) {
    throw new InvalidTaskStateError(`${context} declares an unknown environment: ${value}.`);
  }
}

function assertStage(value: string): asserts value is Stage {
  if (!knownStages.has(value)) {
    throw new InvalidTaskStateError(`Invalid Skill selection stage: ${value}.`);
  }
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const pathRelative = relative(parentPath, childPath);
  return pathRelative.length === 0 || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}

function assertString(value: string | undefined, field: string, sourcePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidTaskStateError(`Skill metadata at ${sourcePath} must declare a non-empty ${field}.`);
  }
  return value.trim();
}

function assertStringArray(
  values: readonly string[] | undefined,
  field: string,
  sourcePath: string,
): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new InvalidTaskStateError(`Skill metadata at ${sourcePath} must declare a non-empty ${field} array.`);
  }

  const normalized = values.map((value) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new InvalidTaskStateError(`Skill metadata at ${sourcePath} has an invalid ${field} value.`);
    }
    return value.trim().toLowerCase();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new InvalidTaskStateError(`Skill metadata at ${sourcePath} contains duplicate ${field} values.`);
  }
  return normalized;
}

function parseMetadataArray(value: string | undefined, field: string, sourcePath: string): readonly string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidTaskStateError(`Skill metadata at ${sourcePath} must declare ${field} as a JSON array string.`);
  }

  const serialized = value.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new InvalidTaskStateError(`Skill metadata at ${sourcePath} has an invalid ${field} JSON array string.`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === "string")) {
    throw new InvalidTaskStateError(`Skill metadata at ${sourcePath} has an invalid ${field} JSON array string.`);
  }
  if (JSON.stringify(parsed) !== serialized) {
    throw new InvalidTaskStateError(`Skill metadata at ${sourcePath} must use a canonical ${field} JSON array string.`);
  }
  return parsed;
}

function assertResourcePaths(values: readonly string[] | undefined, sourcePath: string): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new InvalidTaskStateError(`Skill metadata at ${sourcePath} has an invalid requiredResources array.`);
  const normalized = values.map((value) => {
    if (typeof value !== "string" || value.trim().length === 0 || isAbsolute(value) || value.trim().split(/[\\/]+/u).includes("..")) {
      throw new InvalidTaskStateError(`Skill metadata at ${sourcePath} has an unsafe requiredResources value.`);
    }
    return value.trim();
  });
  if (new Set(normalized).size !== normalized.length) throw new InvalidTaskStateError(`Skill metadata at ${sourcePath} contains duplicate requiredResources values.`);
  return normalized;
}

async function readFrontmatter(skillPath: string): Promise<string> {
  const handle = await open(skillPath, "r");
  try {
    const frontmatterBytes: number[] = [];
    const lineBytes: number[] = [];
    const byteBuffer = Buffer.alloc(1);
    let foundOpeningMarker = false;

    for (let position = 0; position < maximumFrontmatterBytes; position += 1) {
      const result = await handle.read(byteBuffer, 0, 1, position);
      if (result.bytesRead === 0) {
        break;
      }
      const byte = byteBuffer[0];
      if (byte === undefined) {
        throw new InvalidTaskStateError(`Unable to read Skill metadata at ${skillPath}.`);
      }
      frontmatterBytes.push(byte);
      lineBytes.push(byte);
      if (byte !== 10) {
        continue;
      }

      const line = Buffer.from(lineBytes).toString("utf8").replace(/\r?\n$/, "");
      lineBytes.length = 0;
      if (!foundOpeningMarker) {
        if (line !== "---") {
          throw new InvalidTaskStateError(`Skill metadata at ${skillPath} must start with a YAML frontmatter marker.`);
        }
        foundOpeningMarker = true;
        continue;
      }
      if (line === "---") {
        return Buffer.from(frontmatterBytes).toString("utf8").split(/\r?\n/).slice(1, -2).join("\n");
      }
    }
  } finally {
    await handle.close();
  }
  throw new InvalidTaskStateError(`Skill metadata at ${skillPath} must contain a closing YAML frontmatter marker within ${maximumFrontmatterBytes} bytes.`);
}

async function assertSafeRoot(root: string): Promise<string> {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new InvalidTaskStateError("Skill discovery roots must be non-empty strings.");
  }
  const normalizedRoot = resolve(root);
  let rootStatus;
  try {
    rootStatus = await lstat(normalizedRoot);
  } catch {
    throw new InvalidTaskStateError(`Skill discovery root does not exist: ${normalizedRoot}.`);
  }
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new InvalidTaskStateError(`Skill discovery root must be a non-symlink directory: ${normalizedRoot}.`);
  }
  return realpath(normalizedRoot);
}

async function assertRegularSkillFile(skillPath: string): Promise<void> {
  let skillStatus;
  try {
    skillStatus = await lstat(skillPath);
  } catch {
    throw new InvalidTaskStateError(`Skill file is missing: ${skillPath}.`);
  }
  if (skillStatus.isSymbolicLink() || !skillStatus.isFile()) {
    throw new InvalidTaskStateError(`Skill file must be a non-symlink regular file: ${skillPath}.`);
  }
}

function parseDescriptor(skillPath: string, frontmatter: string): SkillDescriptor {
  let frontmatterMetadata: ParsedSkillFrontmatter | null;
  try {
    frontmatterMetadata = parse(frontmatter) as ParsedSkillFrontmatter | null;
  } catch {
    throw new InvalidTaskStateError(`Skill metadata at ${skillPath} is not valid YAML.`);
  }
  if (frontmatterMetadata === null || typeof frontmatterMetadata !== "object" || Array.isArray(frontmatterMetadata)) {
    throw new InvalidTaskStateError(`Skill metadata at ${skillPath} must be a YAML object.`);
  }

  const metadata = frontmatterMetadata.metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new InvalidTaskStateError(`Skill metadata at ${skillPath} must declare a metadata object.`);
  }

  const name = assertString(frontmatterMetadata.name, "name", skillPath);
  if (!isSafeSkillName(name)) {
    throw new InvalidTaskStateError(`Skill metadata at ${skillPath} has an unsafe name: ${name}.`);
  }
  if (basename(dirname(skillPath)) !== name) {
    throw new InvalidTaskStateError(`Skill directory ${basename(dirname(skillPath))} must match metadata name ${name}.`);
  }
  const description = assertString(frontmatterMetadata.description, "description", skillPath);
  const triggers = assertStringArray(parseMetadataArray(metadata.triggers, "triggers", skillPath), "triggers", skillPath);
  const compatibleEnvironments = assertStringArray(
    parseMetadataArray(metadata.compatibleEnvironments, "compatibleEnvironments", skillPath),
    "compatibleEnvironments",
    skillPath,
  );
  for (const environment of compatibleEnvironments) {
    assertEnvironment(environment, `Skill metadata at ${skillPath}`);
  }
  const compatibleStages = assertStringArray(
    parseMetadataArray(metadata.compatibleStages, "compatibleStages", skillPath),
    "compatibleStages",
    skillPath,
  );
  for (const stage of compatibleStages) {
    assertStage(stage);
  }
  const requiredResources = metadata.requiredResources === undefined
    ? undefined
    : assertResourcePaths(parseMetadataArray(metadata.requiredResources, "requiredResources", skillPath), skillPath);

  return {
    name,
    description,
    triggers,
    compatibleEnvironments: compatibleEnvironments as readonly Environment[],
    compatibleStages: compatibleStages as readonly Stage[],
    ...(requiredResources === undefined ? {} : { requiredResources }),
    skillPath,
  };
}

function assertDescriptor(descriptor: SkillDescriptor, index: number): void {
  if (descriptor === null || typeof descriptor !== "object") {
    throw new InvalidTaskStateError(`Skill descriptor at index=${index} must be an object.`);
  }
  if (typeof descriptor.skillPath !== "string" || !isAbsolute(descriptor.skillPath) || resolve(descriptor.skillPath) !== descriptor.skillPath) {
    throw new InvalidTaskStateError(`Skill descriptor at index=${index} must declare an absolute normalized skillPath.`);
  }
  if (!isSafeSkillName(descriptor.name) || basename(dirname(descriptor.skillPath)) !== descriptor.name) {
    throw new InvalidTaskStateError(`Skill descriptor at index=${index} has an invalid name or skillPath.`);
  }
  assertString(descriptor.description, "description", descriptor.skillPath);
  const triggers = assertStringArray(descriptor.triggers, "triggers", descriptor.skillPath);
  const environments = assertStringArray(descriptor.compatibleEnvironments, "compatibleEnvironments", descriptor.skillPath);
  const stages = assertStringArray(descriptor.compatibleStages, "compatibleStages", descriptor.skillPath);
  const requiredResources = assertResourcePaths(descriptor.requiredResources, descriptor.skillPath);
  for (const environment of environments) {
    assertEnvironment(environment, `Skill descriptor at index=${index}`);
  }
  for (const stage of stages) {
    assertStage(stage);
  }
  if (
    triggers.length !== descriptor.triggers.length ||
    environments.length !== descriptor.compatibleEnvironments.length ||
    stages.length !== descriptor.compatibleStages.length ||
    !triggers.every((trigger, triggerIndex) => trigger === descriptor.triggers[triggerIndex]) ||
    !environments.every((compatibleEnvironment, environmentIndex) => compatibleEnvironment === descriptor.compatibleEnvironments[environmentIndex]) ||
    !stages.every((compatibleStage, stageIndex) => compatibleStage === descriptor.compatibleStages[stageIndex])
    || (requiredResources !== undefined && !requiredResources.every((resource, resourceIndex) => resource === descriptor.requiredResources?.[resourceIndex]))
  ) {
    throw new InvalidTaskStateError(`Skill descriptor at index=${index} contains invalid metadata.`);
  }
}

function intentTokens(intent: string): readonly string[] {
  if (typeof intent !== "string") {
    throw new InvalidTaskStateError("Skill selection intent must be a string.");
  }
  return [...new Set(intent.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [])];
}

function coversToken(descriptor: SkillDescriptor, token: string): boolean {
  return descriptor.triggers.includes(token);
}

function chooseMinimumSet(
  candidates: readonly SkillDescriptor[],
  requiredTokens: readonly string[],
): readonly SkillDescriptor[] {
  let best: readonly SkillDescriptor[] | null = null;
  const sortedCandidates = [...candidates].sort((left, right) => left.name.localeCompare(right.name));

  function search(index: number, selected: readonly SkillDescriptor[], covered: ReadonlySet<string>): void {
    if (best !== null && selected.length > best.length) {
      return;
    }
    if (covered.size === requiredTokens.length) {
      const selectedNames = selected.map((descriptor) => descriptor.name).join("\u0000");
      const bestNames = best === null ? null : best.map((descriptor) => descriptor.name).join("\u0000");
      if (best === null || selected.length < best.length || (selected.length === best.length && selectedNames < bestNames!)) {
        best = selected;
      }
      return;
    }
    if (index === sortedCandidates.length) {
      return;
    }

    const candidate = sortedCandidates[index];
    if (candidate === undefined) {
      throw new InvalidTaskStateError("Skill selection encountered an invalid candidate list.");
    }
    const nextCovered = new Set(covered);
    for (const token of requiredTokens) {
      if (coversToken(candidate, token)) {
        nextCovered.add(token);
      }
    }
    if (nextCovered.size > covered.size) {
      search(index + 1, [...selected, candidate], nextCovered);
    }
    search(index + 1, selected, covered);
  }

  search(0, [], new Set<string>());
  return best === null ? [] : [...best];
}

export async function discoverSkillMetadata(roots: readonly string[]): Promise<readonly SkillDescriptor[]> {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new InvalidTaskStateError("Skill discovery requires at least one root directory.");
  }

  const descriptors: SkillDescriptor[] = [];
  const names = new Set<string>();
  const normalizedRoots = await Promise.all(roots.map((root) => assertSafeRoot(root)));
  if (new Set(normalizedRoots).size !== normalizedRoots.length) {
    throw new InvalidTaskStateError("Skill discovery roots must be unique.");
  }

  for (const root of normalizedRoots.sort((left, right) => left.localeCompare(right))) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const skillDirectory = resolve(root, entry.name);
      if (!isPathInside(root, skillDirectory)) {
        throw new InvalidTaskStateError(`Skill directory escapes discovery root: ${skillDirectory}.`);
      }
      const skillPath = resolve(skillDirectory, "SKILL.md");
      await assertRegularSkillFile(skillPath);
      const resolvedSkillPath = await realpath(skillPath);
      if (!isPathInside(root, resolvedSkillPath)) {
        throw new InvalidTaskStateError(`Skill file escapes discovery root: ${skillPath}.`);
      }
      const descriptor = parseDescriptor(resolvedSkillPath, await readFrontmatter(resolvedSkillPath));
      if (names.has(descriptor.name)) {
        throw new InvalidTaskStateError(`Duplicate Skill name: ${descriptor.name}.`);
      }
      names.add(descriptor.name);
      descriptors.push(descriptor);
    }
  }
  return descriptors.sort((left, right) => left.name.localeCompare(right.name)).map((descriptor) => ({
    ...descriptor,
    triggers: [...descriptor.triggers],
    compatibleEnvironments: [...descriptor.compatibleEnvironments],
    compatibleStages: [...descriptor.compatibleStages],
    ...(descriptor.requiredResources === undefined ? {} : { requiredResources: [...descriptor.requiredResources] }),
  }));
}

export function selectCapabilities(
  intent: string,
  stage: Stage,
  environment: Environment,
  descriptors: readonly SkillDescriptor[],
): readonly SkillDescriptor[] {
  assertStage(stage);
  assertEnvironment(environment, "Skill selection");
  if (!Array.isArray(descriptors)) {
    throw new InvalidTaskStateError("Skill descriptors must be an array.");
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const [index, descriptor] of descriptors.entries()) {
    assertDescriptor(descriptor, index);
    if (names.has(descriptor.name) || paths.has(descriptor.skillPath)) {
      throw new CapabilityMismatchError(`Ambiguous duplicate Skill descriptor: ${descriptor.name}.`);
    }
    names.add(descriptor.name);
    paths.add(descriptor.skillPath);
  }

  const compatibleCandidates = descriptors.filter(
    (descriptor) => descriptor.compatibleEnvironments.includes(environment) && descriptor.compatibleStages.includes(stage),
  );
  const tokens = intentTokens(intent);
  const matchedTokens = tokens.filter((token) => compatibleCandidates.some((descriptor) => coversToken(descriptor, token)));
  if (matchedTokens.length === 0) {
    return [];
  }
  return chooseMinimumSet(compatibleCandidates, matchedTokens).map((descriptor) => ({
    ...descriptor,
    triggers: [...descriptor.triggers],
    compatibleEnvironments: [...descriptor.compatibleEnvironments],
    compatibleStages: [...descriptor.compatibleStages],
    ...(descriptor.requiredResources === undefined ? {} : { requiredResources: [...descriptor.requiredResources] }),
  }));
}
