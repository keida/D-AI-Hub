import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { InvalidTaskStateError } from "../domain/errors.js";
import type { SkillDescriptor } from "./registry.js";

export interface LoadedSkill {
  readonly descriptor: SkillDescriptor;
  readonly instructions: string;
  readonly loadedResources: readonly string[];
}

const maximumSelectedFileBytes = 1_048_576;

function isPathInside(parentPath: string, childPath: string): boolean {
  const pathRelative = relative(parentPath, childPath);
  return pathRelative.length === 0 || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  let status;
  try {
    status = await lstat(path);
  } catch {
    throw new InvalidTaskStateError(`${label} is missing: ${path}.`);
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new InvalidTaskStateError(`${label} must be a non-symlink regular file: ${path}.`);
  }
}

async function readBoundedUtf8File(path: string, label: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const status = await handle.stat();
    if (!status.isFile()) {
      throw new InvalidTaskStateError(`${label} must be a regular file: ${path}.`);
    }
    if (status.size > maximumSelectedFileBytes) {
      throw new InvalidTaskStateError(`${label} exceeds the ${maximumSelectedFileBytes}-byte limit: ${path}.`);
    }

    const content = Buffer.alloc(status.size);
    const readResult = await handle.read(content, 0, status.size, 0);
    if (readResult.bytesRead !== status.size) {
      throw new InvalidTaskStateError(`${label} changed while being read: ${path}.`);
    }
    const trailingByte = Buffer.alloc(1);
    const trailingReadResult = await handle.read(trailingByte, 0, 1, status.size);
    if (trailingReadResult.bytesRead !== 0) {
      throw new InvalidTaskStateError(`${label} changed while being read: ${path}.`);
    }
    return content.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function validateDescriptorPath(descriptor: SkillDescriptor): Promise<string> {
  if (descriptor === null || typeof descriptor !== "object") {
    throw new InvalidTaskStateError("Selected Skill descriptor must be an object.");
  }
  if (typeof descriptor.skillPath !== "string" || !isAbsolute(descriptor.skillPath) || resolve(descriptor.skillPath) !== descriptor.skillPath) {
    throw new InvalidTaskStateError("Selected Skill descriptor must declare an absolute normalized skillPath.");
  }
  if (basename(descriptor.skillPath) !== "SKILL.md") {
    throw new InvalidTaskStateError(`Selected Skill path must point to SKILL.md: ${descriptor.skillPath}.`);
  }
  await assertRegularFile(descriptor.skillPath, "Selected Skill file");
  const resolvedSkillPath = await realpath(descriptor.skillPath);
  const skillDirectory = dirname(descriptor.skillPath);
  if (!isPathInside(skillDirectory, resolvedSkillPath)) {
    throw new InvalidTaskStateError(`Selected Skill path escapes its directory: ${descriptor.skillPath}.`);
  }
  return skillDirectory;
}

function assertResourceRequest(resourcePath: string, skillDirectory: string): string {
  if (typeof resourcePath !== "string" || resourcePath.length === 0) {
    throw new InvalidTaskStateError("Skill resource requests must be non-empty relative paths.");
  }
  if (isAbsolute(resourcePath)) {
    throw new InvalidTaskStateError(`Skill resource request must be relative: ${resourcePath}.`);
  }
  const resolvedResourcePath = resolve(skillDirectory, resourcePath);
  if (!isPathInside(skillDirectory, resolvedResourcePath)) {
    throw new InvalidTaskStateError(`Skill resource request escapes the Skill directory: ${resourcePath}.`);
  }
  return resolvedResourcePath;
}

export async function loadSelectedSkill(
  descriptor: SkillDescriptor,
  requiredResources: readonly string[],
): Promise<LoadedSkill> {
  if (!Array.isArray(requiredResources)) {
    throw new InvalidTaskStateError("Skill resource requests must be an array.");
  }
  const skillDirectory = await validateDescriptorPath(descriptor);
  const resourcePaths = requiredResources.map((resourcePath) => assertResourceRequest(resourcePath, skillDirectory));
  if (new Set(resourcePaths).size !== resourcePaths.length) {
    throw new InvalidTaskStateError("Skill resource requests must not contain duplicates.");
  }

  const instructions = await readBoundedUtf8File(descriptor.skillPath, "Selected Skill file");
  for (const resourcePath of resourcePaths) {
    await assertRegularFile(resourcePath, "Skill resource");
    const resolvedResourcePath = await realpath(resourcePath);
    if (!isPathInside(skillDirectory, resolvedResourcePath)) {
      throw new InvalidTaskStateError(`Skill resource escapes the Skill directory: ${resourcePath}.`);
    }
    await readBoundedUtf8File(resolvedResourcePath, "Skill resource");
  }

  return {
    descriptor: {
      ...descriptor,
      triggers: [...descriptor.triggers],
      compatibleEnvironments: [...descriptor.compatibleEnvironments],
      compatibleStages: [...descriptor.compatibleStages],
    },
    instructions,
    loadedResources: [...resourcePaths],
  };
}
