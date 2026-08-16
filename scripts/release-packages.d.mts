export interface ReleasePackageDefinition {
  readonly directory: string;
  readonly name: string;
}

export interface ValidationOptions {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly releasePrerelease?: boolean | string;
  readonly expectedReleaseCommit?: string;
  readonly requireClean?: boolean;
  readonly requireMainAncestor?: boolean;
  readonly requireReleaseTag?: boolean;
}

export interface ReleaseCommandOptions extends ValidationOptions {
  readonly manifest?: string;
  readonly output?: string;
}

export interface PublicPackageManifest {
  readonly name: string;
  readonly version: string;
  readonly [key: string]: unknown;
}

export interface ValidatedPackage {
  readonly definition: ReleasePackageDefinition;
  readonly manifest: PublicPackageManifest;
  readonly packageDirectory: string;
}

export interface ValidationResult {
  readonly root: string;
  readonly packages: readonly ValidatedPackage[];
  readonly releaseTag: string | undefined;
}

export const RELEASE_PACKAGES: readonly ReleasePackageDefinition[];

export function parsePnpmLockfileImporters(
  text: string,
): Record<
  string,
  Record<string, Record<string, { specifier?: string; version?: string }>>
>;

export function resolvedVersionSatisfies(
  version: string,
  specifier: string,
): boolean;

export function lockDependencyMatches(
  lockDependency: { specifier?: string; version?: string } | undefined,
  specifier: string,
  options?: { workspace?: boolean },
): boolean;

export function isNormalReleaseVersion(version: string): boolean;

export function parseNpmJsonStdout(stdout: string): unknown;

export function parseArguments(
  arguments_: readonly string[],
): ReleaseCommandOptions;

export function validateRepository(
  options?: ValidationOptions,
): Promise<ValidationResult>;

export function validateReleaseTag(options?: {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly expectedReleaseCommit?: string;
}): { headCommit: string; releaseTag: string };

export function decidePublication(
  localIntegrity: string,
  registryIntegrity: string | null,
): "publish" | "skip";

export function prepareRelease(
  options?: ReleaseCommandOptions,
): Promise<{ manifestPath: string; manifest: unknown }>;

export function publishPreparedRelease(
  options?: ReleaseCommandOptions,
): Promise<void>;
