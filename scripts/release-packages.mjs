import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_URL = "git+https://github.com/pegma-dev/billing-core.git";
const NODE_RANGE = ">=22";
const REVIEWED_PNPM_VERSION = "10.34.5";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

/** Public packages in dependency order. */
export const RELEASE_PACKAGES = [
  {
    directory: "billing-core",
    name: "@pegma/billing-core",
  },
  {
    directory: "billing-stripe",
    name: "@pegma/billing-stripe",
  },
];

const RELEASE_NAMES = new Set(RELEASE_PACKAGES.map(({ name }) => name));
const FIRST_RELEASE_VERSION = "0.1.0";

export function isNormalReleaseVersion(version) {
  const match =
    typeof version === "string" ? STABLE_SEMVER.exec(version) : null;
  // Reject the entire 0.0.x bootstrap range from the normal release lane.
  return match !== null && (match[1] !== "0" || match[2] !== "0");
}

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    fail(
      `${command} ${arguments_.join(" ")} failed with exit code ${String(result.status)}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result;
}

/** `pnpm run` sets npm_execpath to pnpm; pack/view/publish must still be npm. */
function npmEnvironment(env = process.env) {
  const isolated = { ...env };
  delete isolated.npm_execpath;
  return isolated;
}

function runNpm(arguments_, options = {}) {
  return run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, {
    ...options,
    env: npmEnvironment(options.env ?? process.env),
    shell: process.platform === "win32",
  });
}

/**
 * `npm --json` writes a JSON value: objects, arrays, or scalars
 * (`"sha512-…"`, numbers, true/false/null). Lifecycle scripts invoked
 * during `npm pack` may print a human banner on the same stdout:
 *   > @pegma/...@0.1.1 build /home/runner/work/...
 * Drop those `>` lines, then parse from the first JSON token so the
 * banner is never fed to JSON.parse and `npm view dist.integrity --json`
 * still yields a string.
 */
const JSON_VALUE_START =
  /[\[{"]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b/u;

export function parseNpmJsonStdout(stdout) {
  const text = typeof stdout === "string" ? stdout : "";
  const withoutBanners = text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*>/u.test(line))
    .join("\n");
  const start = withoutBanners.search(JSON_VALUE_START);
  if (start === -1) {
    fail("npm did not write JSON output");
  }
  return JSON.parse(withoutBanners.slice(start));
}

function unquoteYamlScalar(value) {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Reads pnpm-lock.yaml importers without a YAML dependency. */
export function parsePnpmLockfileImporters(text) {
  const importers = {};
  let inImporters = false;
  let currentPath = null;
  let currentSection = null;
  let currentDep = null;

  for (const line of text.split(/\r?\n/u)) {
    if (!inImporters) {
      if (line === "importers:") {
        inImporters = true;
      }
      continue;
    }
    if (line.length > 0 && !line.startsWith(" ") && line.endsWith(":")) {
      break;
    }
    if (line.trim() === "") {
      continue;
    }

    const importerMatch = /^ {2}(\S[^:]*):$/u.exec(line);
    if (importerMatch !== null) {
      currentPath = unquoteYamlScalar(importerMatch[1]);
      importers[currentPath] = {};
      currentSection = null;
      currentDep = null;
      continue;
    }

    const sectionMatch =
      /^ {4}(dependencies|devDependencies|optionalDependencies|peerDependencies):$/u.exec(
        line,
      );
    if (sectionMatch !== null && currentPath !== null) {
      currentSection = sectionMatch[1];
      importers[currentPath][currentSection] = {};
      currentDep = null;
      continue;
    }

    const depMatch = /^ {6}([^:]+):$/u.exec(line);
    if (depMatch !== null && currentPath !== null && currentSection !== null) {
      currentDep = unquoteYamlScalar(depMatch[1]);
      importers[currentPath][currentSection][currentDep] = {};
      continue;
    }

    const fieldMatch = /^ {8}(specifier|version): (.+)$/u.exec(line);
    if (
      fieldMatch !== null &&
      currentPath !== null &&
      currentSection !== null &&
      currentDep !== null
    ) {
      importers[currentPath][currentSection][currentDep][fieldMatch[1]] =
        unquoteYamlScalar(fieldMatch[2]);
    }
  }
  return importers;
}

function parseSemverTriple(version) {
  const match = STABLE_SEMVER.exec(version);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function leadingResolvedSemver(version) {
  const full = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (full !== null) {
    return [Number(full[1]), Number(full[2]), Number(full[3])];
  }
  const majorMinor = /^(\d+)\.(\d+)(?![.\d])/u.exec(version);
  if (majorMinor !== null) {
    return [Number(majorMinor[1]), Number(majorMinor[2]), 0];
  }
  const major = /^(\d+)(?![.\d])/u.exec(version);
  if (major !== null) {
    return [Number(major[1]), 0, 0];
  }
  return null;
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

function caretUpperBound([major, minor, patch]) {
  if (major > 0) {
    return [major + 1, 0, 0];
  }
  if (minor > 0) {
    return [0, minor + 1, 0];
  }
  return [0, 0, patch + 1];
}

function tildeUpperBound([major, minor]) {
  return [major, minor + 1, 0];
}

function inHalfOpenRange(resolved, lower, upper) {
  return (
    compareSemver(resolved, lower) >= 0 && compareSemver(resolved, upper) < 0
  );
}

function lockfileResolvedIdentity(resolved) {
  const suffix = resolved.indexOf("(");
  return suffix === -1 ? resolved : resolved.slice(0, suffix);
}

function parseCaretFloor(version) {
  const triple = parseSemverTriple(version);
  if (triple !== null) {
    return { lower: triple, upper: caretUpperBound(triple) };
  }
  const majorMinor = /^(\d+)\.(\d+)$/u.exec(version);
  if (majorMinor !== null) {
    const major = Number(majorMinor[1]);
    const minor = Number(majorMinor[2]);
    const lower = [major, minor, 0];
    // npm: ^0.0 → <0.1.0; ^1.2 → <2.0.0
    const upper = major > 0 ? [major + 1, 0, 0] : [0, minor + 1, 0];
    return { lower, upper };
  }
  const major = /^(\d+)$/u.exec(version);
  if (major !== null) {
    const value = Number(major[1]);
    // npm: ^0 → <1.0.0; ^1 → <2.0.0
    return { lower: [value, 0, 0], upper: [value + 1, 0, 0] };
  }
  return null;
}

/** Exact pins must match; ranges accept a resolved version in the specifier. */
export function resolvedVersionSatisfies(version, specifier) {
  const resolvedId = lockfileResolvedIdentity(version);
  // Exact pins, including prereleases, match by identity after stripping
  // pnpm peer suffixes at the first "(".
  if (resolvedId === specifier) {
    return true;
  }
  if (STABLE_SEMVER.test(specifier)) {
    return false;
  }
  if (specifier === "*" || specifier === "x" || specifier === "X") {
    return leadingResolvedSemver(version) !== null;
  }
  const resolved = leadingResolvedSemver(version);
  if (resolved === null) {
    return false;
  }
  if (specifier.startsWith("^")) {
    const range = parseCaretFloor(specifier.slice(1));
    return (
      range !== null && inHalfOpenRange(resolved, range.lower, range.upper)
    );
  }
  if (specifier.startsWith("~")) {
    const lower = parseSemverTriple(specifier.slice(1));
    return (
      lower !== null && inHalfOpenRange(resolved, lower, tildeUpperBound(lower))
    );
  }
  const majorOnly = /^(\d+)$/u.exec(specifier);
  if (majorOnly !== null) {
    const lower = [Number(majorOnly[1]), 0, 0];
    return inHalfOpenRange(resolved, lower, [lower[0] + 1, 0, 0]);
  }
  const majorMinor = /^(\d+)\.(\d+)$/u.exec(specifier);
  if (majorMinor !== null) {
    const lower = [Number(majorMinor[1]), Number(majorMinor[2]), 0];
    return inHalfOpenRange(resolved, lower, tildeUpperBound(lower));
  }
  return false;
}

/**
 * Each lockfile importer entry must carry that dependency's own specifier and
 * a resolved version that satisfies it. Independent substring matches can
 * accept a swapped pin; exact-equality on ranges rejects a valid lockfile.
 */
export function lockDependencyMatches(lockDependency, specifier, options = {}) {
  if (
    lockDependency === undefined ||
    unquoteYamlScalar(lockDependency.specifier ?? "") !== specifier ||
    typeof lockDependency.version !== "string"
  ) {
    return false;
  }
  const version = unquoteYamlScalar(lockDependency.version);
  if (options.workspace === true) {
    return version.startsWith("link:");
  }
  return resolvedVersionSatisfies(version, specifier);
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function hashTarball(bytes) {
  return {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function exportSpecifiers(manifest) {
  if (
    manifest.exports === null ||
    typeof manifest.exports !== "object" ||
    Array.isArray(manifest.exports)
  ) {
    fail(`${manifest.name} must declare object-form exports`);
  }
  return Object.keys(manifest.exports).map((key) =>
    key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`,
  );
}

function exportTargets(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
}

async function validatePackage(root, definition, lockfile) {
  const packageDirectory = join(root, "packages", definition.directory);
  const manifest = await readJson(join(packageDirectory, "package.json"));
  if (manifest.name !== definition.name) {
    fail(`expected ${definition.name} in packages/${definition.directory}`);
  }
  if (!STABLE_SEMVER.test(manifest.version)) {
    fail(`${definition.name} must use a stable semantic version`);
  }
  if (
    manifest.private === true ||
    manifest.license !== "MIT" ||
    manifest.type !== "module" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.engines?.node !== NODE_RANGE ||
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== REPOSITORY_URL ||
    manifest.repository?.directory !== `packages/${definition.directory}`
  ) {
    fail(`${definition.name} has invalid public package metadata`);
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some((entry) => !entry.startsWith("dist/"))
  ) {
    fail(`${definition.name} must publish only its dist allowlist`);
  }
  if (
    typeof manifest.scripts?.prepack !== "string" ||
    !(
      manifest.scripts.prepack.includes("build") ||
      manifest.scripts.prepack.includes("tsc")
    )
  ) {
    fail(`${definition.name} must build during prepack`);
  }
  const targets = exportTargets(manifest.exports);
  if (
    targets.length === 0 ||
    targets.some(
      (target) =>
        typeof target !== "string" ||
        !target.startsWith("./dist/") ||
        target.includes(".."),
    )
  ) {
    fail(`${definition.name} exports must point into dist`);
  }
  await stat(join(packageDirectory, "README.md"));
  await stat(join(packageDirectory, "LICENSE"));

  const lockEntry = lockfile[`packages/${definition.directory}`];
  if (lockEntry === undefined || typeof lockEntry !== "object") {
    fail(
      `${definition.name} is missing from pnpm-lock.yaml workspace inventory`,
    );
  }
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      const workspace = RELEASE_NAMES.has(name);
      if (workspace) {
        const dependency = RELEASE_PACKAGES.find(
          (entry) => entry.name === name,
        );
        const dependencyManifest = await readJson(
          join(root, "packages", dependency.directory, "package.json"),
        );
        if (version !== dependencyManifest.version) {
          fail(
            `${definition.name} must pin ${name} to its exact workspace version`,
          );
        }
      }
      if (
        !lockDependencyMatches(lockEntry[section]?.[name], version, {
          workspace,
        })
      ) {
        fail(
          workspace
            ? `${definition.name} must pin ${name} to its exact workspace version`
            : `${definition.name} ${name}@${version} is not synchronized with pnpm-lock.yaml`,
        );
      }
    }
  }
  return { definition, manifest, packageDirectory };
}

async function publicWorkspaceInventory(root) {
  const directories = await readdir(join(root, "packages"), {
    withFileTypes: true,
  });
  const names = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) {
      continue;
    }
    const manifestPath = join(root, "packages", directory.name, "package.json");
    try {
      const manifest = await readJson(manifestPath);
      if (manifest.private !== true) {
        names.push(manifest.name);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return names.sort();
}

export function validateReleaseTag(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedReleaseCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag === undefined || !/^v\d+\.\d+\.\d+$/u.test(releaseTag)) {
    fail("a stable release tag is required");
  }
  if (
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedReleaseCommit)
  ) {
    fail("an exact release event commit is required");
  }

  const tagRef = `refs/tags/${releaseTag}`;
  const objectType = run(gitCommand(), ["cat-file", "-t", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (objectType.status !== 0 || objectType.stdout.trim() !== "tag") {
    fail("the release ref must be an annotated tag object");
  }
  const headCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const tagCommit = run(gitCommand(), ["rev-parse", `${tagRef}^{commit}`], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  if (
    !safeEqual(headCommit, tagCommit) ||
    !safeEqual(headCommit, expectedReleaseCommit)
  ) {
    fail(
      "the release checkout, signed tag target, and release event commit must match",
    );
  }
  const signature = run(gitCommand(), ["verify-tag", "--raw", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (signature.status !== 0) {
    fail("the release tag signature is not valid for an approved signer");
  }
  const onMain = run(
    gitCommand(),
    ["merge-base", "--is-ancestor", tagCommit, "refs/remotes/origin/main"],
    { cwd: root, capture: true, allowFailure: true },
  );
  if (onMain.status !== 0) {
    fail("the release tag commit must be contained in origin/main");
  }
  return { headCommit, releaseTag };
}

export async function validateRepository(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const rootManifest = await readJson(join(root, "package.json"));
  if (
    rootManifest.private !== true ||
    rootManifest.packageManager !== `pnpm@${REVIEWED_PNPM_VERSION}`
  ) {
    fail(`the private root must pin pnpm@${REVIEWED_PNPM_VERSION}`);
  }
  const expectedInventory = RELEASE_PACKAGES.map(({ name }) => name).sort();
  const actualInventory = await publicWorkspaceInventory(root);
  if (!sameJson(actualInventory, expectedInventory)) {
    fail("public workspace inventory does not match the reviewed release list");
  }
  const lockfile = parsePnpmLockfileImporters(
    await readFile(join(root, "pnpm-lock.yaml"), "utf8"),
  );
  const packages = [];
  for (const definition of RELEASE_PACKAGES) {
    packages.push(await validatePackage(root, definition, lockfile));
  }

  if (options.requireClean) {
    const status = run(gitCommand(), ["status", "--porcelain"], {
      cwd: root,
      capture: true,
    }).stdout;
    if (status.trim() !== "") {
      fail("release preparation requires a clean checkout");
    }
  }
  if (options.requireMainAncestor) {
    const head = run(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: root,
      capture: true,
    }).stdout.trim();
    const onMain = run(
      gitCommand(),
      ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"],
      { cwd: root, capture: true, allowFailure: true },
    );
    if (onMain.status !== 0) {
      fail("release commit must be contained in origin/main");
    }
  }

  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag !== undefined) {
    if (!/^v\d+\.\d+\.\d+$/u.test(releaseTag)) {
      fail("release tag must be a stable vX.Y.Z tag");
    }
    const version = releaseTag.slice(1);
    if (!packages.some(({ manifest }) => manifest.version === version)) {
      fail(
        `release tag ${releaseTag} does not match any public package version`,
      );
    }
    const prerelease =
      options.releasePrerelease ?? process.env.RELEASE_PRERELEASE ?? false;
    if (prerelease === true || prerelease === "true") {
      fail("prereleases cannot publish packages");
    }
  }
  if (options.requireReleaseTag) {
    validateReleaseTag({
      root,
      releaseTag,
      expectedReleaseCommit: options.expectedReleaseCommit,
    });
  }
  return { root, packages, releaseTag };
}

function verifyPackedFiles(manifest, files) {
  const paths = files.map(({ path }) => path);
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!paths.includes(required)) {
      fail(`${manifest.name} tarball is missing ${required}`);
    }
  }
  if (
    paths.some(
      (path) =>
        !["package.json", "README.md", "LICENSE"].includes(path) &&
        !path.startsWith("dist/"),
    )
  ) {
    fail(
      `${manifest.name} tarball contains a file outside the reviewed allowlist`,
    );
  }
  for (const target of exportTargets(manifest.exports)) {
    const path = target.replace(/^\.\//u, "");
    if (!paths.includes(path)) {
      fail(`${manifest.name} tarball is missing exported file ${path}`);
    }
  }
}

async function smokeTestTarballs(root, packageRecords) {
  const directory = await mkdtemp(join(tmpdir(), "pegma-release-smoke-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      '{"name":"pegma-release-smoke","private":true,"type":"module"}\n',
    );
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        ...packageRecords.map(({ tarballPath }) => tarballPath),
      ],
      { cwd: directory, capture: true },
    );
    for (const { manifest } of packageRecords) {
      for (const specifier of exportSpecifiers(manifest)) {
        run(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `await import(${JSON.stringify(specifier)})`,
          ],
          { cwd: directory, capture: true },
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function queryRegistryIntegrity(name, version) {
  const spec = `${name}@${version}`;
  const result = runNpm(["view", spec, "dist.integrity", "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (result.status === 0) {
    const integrity = parseNpmJsonStdout(result.stdout);
    if (typeof integrity !== "string" || integrity.length === 0) {
      fail(`${spec} exists without dist.integrity`);
    }
    return integrity;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b/u.test(output)) {
    return null;
  }
  fail(`npm registry lookup failed for ${spec}:\n${output.trim()}`);
}

export function decidePublication(localIntegrity, registryIntegrity) {
  if (registryIntegrity === null) {
    return "publish";
  }
  if (safeEqual(localIntegrity, registryIntegrity)) {
    return "skip";
  }
  fail("the registry version exists with different tarball integrity");
}

export async function prepareRelease(options = {}) {
  const { root, packages, releaseTag } = await validateRepository(options);
  for (const { manifest } of packages) {
    if (!isNormalReleaseVersion(manifest.version)) {
      fail(
        `normal releases require version ${FIRST_RELEASE_VERSION} or later (got ${manifest.name}@${manifest.version})`,
      );
    }
  }
  const gitCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(gitCommit)) {
    fail(`git returned an invalid commit SHA: ${gitCommit}`);
  }
  const output = resolve(root, options.output ?? ".release");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) {
    fail(`release output directory must be empty: ${output}`);
  }

  runNpm(["run", "build"], { cwd: root });
  const records = [];
  const tagVersion = releaseTag?.slice(1);
  for (const { definition, manifest } of packages) {
    const result = runNpm(
      [
        "pack",
        join(root, "packages", definition.directory),
        "--json",
        "--pack-destination",
        output,
      ],
      { cwd: root, capture: true },
    );
    const [packed] = parseNpmJsonStdout(result.stdout);
    if (
      packed?.name !== definition.name ||
      packed?.version !== manifest.version ||
      typeof packed.filename !== "string" ||
      !Array.isArray(packed.files)
    ) {
      fail(`npm pack returned invalid metadata for ${definition.name}`);
    }
    verifyPackedFiles(manifest, packed.files);
    const tarballPath = join(output, basename(packed.filename));
    const hashes = hashTarball(await readFile(tarballPath));
    if (
      !safeEqual(hashes.integrity, packed.integrity) ||
      !safeEqual(hashes.shasum, packed.shasum)
    ) {
      fail(`${definition.name} tarball hashes do not match npm pack metadata`);
    }
    records.push({
      name: definition.name,
      version: manifest.version,
      directory: definition.directory,
      tarball: basename(tarballPath),
      tarballPath,
      integrity: hashes.integrity,
      shasum: hashes.shasum,
      publish: tagVersion === undefined || manifest.version === tagVersion,
      files: packed.files
        .map(({ path, size }) => ({ path, size }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      manifest,
    });
  }
  await smokeTestTarballs(root, records);

  if (releaseTag !== undefined) {
    for (const record of records.filter(({ publish }) => !publish)) {
      const registryIntegrity = queryRegistryIntegrity(
        record.name,
        record.version,
      );
      if (
        registryIntegrity === null ||
        !safeEqual(record.integrity, registryIntegrity)
      ) {
        fail(
          `${record.name}@${record.version} is not selected by ${releaseTag} and must exactly match npm`,
        );
      }
    }
  }

  const manifest = {
    schemaVersion: 1,
    gitCommit,
    releaseTag: releaseTag ?? null,
    packages: records.map(
      ({ tarballPath, manifest: _manifest, ...record }) => record,
    ),
  };
  const manifestPath = join(output, "package-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, manifest };
}

async function verifyPreparedManifest(manifestPath) {
  const manifest = await readJson(manifestPath);
  if (
    manifest.schemaVersion !== 1 ||
    !/^[0-9a-f]{40,64}$/u.test(manifest.gitCommit) ||
    !/^v\d+\.\d+\.\d+$/u.test(manifest.releaseTag) ||
    !Array.isArray(manifest.packages) ||
    !sameJson(
      manifest.packages.map(({ name }) => name),
      RELEASE_PACKAGES.map(({ name }) => name),
    )
  ) {
    fail("prepared package manifest has an invalid package inventory");
  }
  const currentCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: defaultRoot(),
    capture: true,
  }).stdout.trim();
  if (!safeEqual(currentCommit, manifest.gitCommit)) {
    fail("prepared package manifest commit does not match the checkout");
  }
  const tagVersion = manifest.releaseTag.slice(1);
  if (!manifest.packages.some(({ publish }) => publish)) {
    fail("prepared package manifest has no release candidates");
  }
  for (const [index, record] of manifest.packages.entries()) {
    const definition = RELEASE_PACKAGES[index];
    const expectedTarball = `${definition.name
      .slice(1)
      .replace("/", "-")}-${record.version}.tgz`;
    if (
      record.directory !== definition.directory ||
      record.tarball !== expectedTarball ||
      !STABLE_SEMVER.test(record.version) ||
      record.publish !== (record.version === tagVersion) ||
      typeof record.integrity !== "string" ||
      typeof record.shasum !== "string" ||
      !Array.isArray(record.files)
    ) {
      fail(`${record.name} has invalid prepared metadata`);
    }
    const tarball = resolve(dirname(manifestPath), record.tarball);
    if (dirname(tarball) !== resolve(dirname(manifestPath))) {
      fail(`${record.name} tarball must be beside the package manifest`);
    }
    const hashes = hashTarball(await readFile(tarball));
    if (
      !safeEqual(hashes.integrity, record.integrity) ||
      !safeEqual(hashes.shasum, record.shasum)
    ) {
      fail(`${record.name} prepared tarball has changed`);
    }
  }
  return manifest;
}

function requireTrustedPublishingNpm() {
  const version = runNpm(["--version"], { capture: true }).stdout.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u.exec(version);
  if (match === null) {
    fail(`could not parse npm version ${version}`);
  }
  const [, majorText, minorText, patchText] = match;
  const [major, minor, patch] = [majorText, minorText, patchText].map(Number);
  if (
    major < 11 ||
    (major === 11 && minor < 5) ||
    (major === 11 && minor === 5 && patch < 1)
  ) {
    fail("trusted publishing requires npm 11.5.1 or newer");
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function confirmRegistryIntegrity(record) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const integrity = queryRegistryIntegrity(record.name, record.version);
    if (integrity !== null && safeEqual(record.integrity, integrity)) {
      return;
    }
    if (attempt < 5) {
      wait(2 ** attempt * 1000);
    }
  }
  fail(
    `${record.name}@${record.version} did not become visible with the prepared integrity`,
  );
}

export async function publishPreparedRelease(options = {}) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "release"
  ) {
    fail("release:publish is restricted to a GitHub release workflow");
  }
  requireTrustedPublishingNpm();
  const manifestPath = resolve(
    options.manifest ?? ".release/package-manifest.json",
  );
  const manifest = await verifyPreparedManifest(manifestPath);
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedReleaseCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag !== manifest.releaseTag) {
    fail("prepared manifest must match the release tag");
  }
  if (
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedReleaseCommit) ||
    !safeEqual(manifest.gitCommit, expectedReleaseCommit)
  ) {
    fail("prepared package manifest must match the release event commit");
  }
  for (const record of manifest.packages.filter(({ publish }) => publish)) {
    const registryIntegrity = queryRegistryIntegrity(
      record.name,
      record.version,
    );
    const decision = decidePublication(record.integrity, registryIntegrity);
    if (decision === "skip") {
      process.stdout.write(
        `Verified existing ${record.name}@${record.version}; skipping.\n`,
      );
      continue;
    }
    const tarball = resolve(dirname(manifestPath), record.tarball);
    runNpm(["publish", tarball, "--access", "public", "--provenance"], {
      cwd: dirname(manifestPath),
    });
    confirmRegistryIntegrity(record);
  }
}

export function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--require-main-ancestor") {
      options.requireMainAncestor = true;
      continue;
    }
    if (argument === "--require-clean") {
      options.requireClean = true;
      continue;
    }
    if (argument === "--require-release-tag") {
      options.requireReleaseTag = true;
      continue;
    }
    const key =
      argument === "--root"
        ? "root"
        : argument === "--output"
          ? "output"
          : argument === "--manifest"
            ? "manifest"
            : argument === "--expected-release-commit"
              ? "expectedReleaseCommit"
              : null;
    if (key === null || arguments_[index + 1] === undefined) {
      fail(`unknown or incomplete argument: ${argument}`);
    }
    options[key] = arguments_[index + 1];
    index += 1;
  }
  return options;
}

function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseArguments(arguments_);
  if (command === "check") {
    await validateRepository(options);
    process.stdout.write("Release metadata is valid.\n");
    return;
  }
  if (command === "pack") {
    const { manifestPath } = await prepareRelease(options);
    process.stdout.write(`Prepared release packages at ${manifestPath}.\n`);
    return;
  }
  if (command === "publish") {
    await publishPreparedRelease(options);
    return;
  }
  fail("usage: release-packages.mjs <check|pack|publish> [options]");
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
