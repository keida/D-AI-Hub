import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SkillLibraryFixture {
  readonly rootPath: string;
  readonly selectedSkillNames: readonly string[];
  readonly unrelatedSkillName: string;
}

interface SkillFixtureDefinition {
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly compatibleEnvironments: readonly string[];
  readonly compatibleStages: readonly string[];
  readonly requiredResources?: readonly string[];
  readonly instructions: string;
  readonly reference: string;
}

const skillDefinitions: readonly SkillFixtureDefinition[] = [
  {
    name: "repository-execution",
    description: "Executes repository implementation work with local commands.",
    triggers: ["implement", "repository"],
    compatibleEnvironments: ["codex"],
    compatibleStages: ["execute"],
    requiredResources: ["references/contract.md"],
    instructions: "Run the requested repository command and preserve exact evidence.",
    reference: "Use the repository-local command fixtures for execution evidence.",
  },
  {
    name: "verification-evidence",
    description: "Collects verification evidence for repository work.",
    triggers: ["verify"],
    compatibleEnvironments: ["codex"],
    compatibleStages: ["execute", "verify"],
    requiredResources: ["references/contract.md"],
    instructions: "Record observed output and exit status separately.",
    reference: "Require a zero exit code and retain the observed output.",
  },
  {
    name: "unrelated-campaign",
    description: "Plans unrelated campaign work.",
    triggers: ["campaign"],
    compatibleEnvironments: ["chat"],
    compatibleStages: ["plan"],
    instructions: "This unrelated body must never be selected for repository execution.",
    reference: "This unrelated resource must remain unloaded.",
  },
];

function frontmatterList(values: readonly string[]): string {
  return values.map((value) => `  - ${value}`).join("\n");
}

function skillDocument(definition: SkillFixtureDefinition): string {
  return [
    "---",
    `name: ${definition.name}`,
    `description: ${definition.description}`,
    "triggers:",
    frontmatterList(definition.triggers),
    "compatibleEnvironments:",
    frontmatterList(definition.compatibleEnvironments),
    "compatibleStages:",
    frontmatterList(definition.compatibleStages),
    ...(definition.requiredResources === undefined ? [] : ["requiredResources:", frontmatterList(definition.requiredResources)]),
    "---",
    "",
    `# ${definition.name}`,
    "",
    definition.instructions,
    "",
  ].join("\n");
}

async function writeSkill(rootPath: string, definition: SkillFixtureDefinition): Promise<void> {
  const skillPath = join(rootPath, definition.name);
  const referencesPath = join(skillPath, "references");
  await mkdir(referencesPath, { recursive: true });
  await writeFile(join(skillPath, "SKILL.md"), skillDocument(definition), "utf8");
  await writeFile(join(referencesPath, "contract.md"), `${definition.reference}\n`, "utf8");
}

export async function createSkillLibrary(rootPath: string): Promise<SkillLibraryFixture> {
  await mkdir(rootPath, { recursive: true });
  for (const definition of skillDefinitions) {
    await writeSkill(rootPath, definition);
  }
  return {
    rootPath,
    selectedSkillNames: ["repository-execution", "verification-evidence"],
    unrelatedSkillName: "unrelated-campaign",
  };
}
