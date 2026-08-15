import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RELEASE_PACKAGES,
  decidePublication,
  isNormalReleaseVersion,
  lockDependencyMatches,
  parseArguments,
  parsePnpmLockfileImporters,
  resolvedVersionSatisfies,
  validateRepository,
} from "../scripts/release-packages.mjs";

const packageVersion = (
  JSON.parse(
    readFileSync(
      join(process.cwd(), "packages", "billing-core", "package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

describe("release package metadata", () => {
  it("accepts npm's cross-platform argument separator", () => {
    expect(parseArguments(["--", "--output", ".release"])).toEqual({
      output: ".release",
    });
  });

  it("validates package manifests and the lockfile together", async () => {
    await expect(validateRepository()).resolves.toBeDefined();
  });

  it("keeps the exact public package inventory", () => {
    expect(RELEASE_PACKAGES.map(({ name }) => name)).toEqual([
      "@pegma/billing-core",
      "@pegma/billing-stripe",
    ]);
  });

  it("ships the unpublished 0.1.0 package with exact Pegma pins", () => {
    const manifests = RELEASE_PACKAGES.map(({ directory }) =>
      JSON.parse(
        readFileSync(
          join(process.cwd(), "packages", directory, "package.json"),
          "utf8",
        ),
      ),
    ) as Array<{
      name: string;
      version: string;
      dependencies?: Record<string, string>;
    }>;

    expect(manifests.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "@pegma/billing-core", version: "0.1.0" },
      { name: "@pegma/billing-stripe", version: "0.1.0" },
    ]);
    expect(manifests[0]?.dependencies?.["@pegma/spine"]).toBe("0.1.2");
    expect(manifests[0]?.dependencies?.["@pegma/storage-core"]).toBe("0.4.0");
    expect(manifests[1]?.dependencies?.["@pegma/billing-core"]).toBe("0.1.0");
    expect(manifests[1]?.dependencies?.["@pegma/spine"]).toBe("0.1.2");
    expect(packageVersion).toBe("0.1.0");
  });

  it("rejects the bootstrap range from the normal release lane", () => {
    expect(isNormalReleaseVersion("0.0.0")).toBe(false);
    expect(isNormalReleaseVersion("0.0.1")).toBe(false);
    expect(isNormalReleaseVersion("0.1.0")).toBe(true);
    expect(isNormalReleaseVersion("1.0.0")).toBe(true);
  });

  it("pins pnpm as the workspace package manager", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { packageManager?: string };
    expect(manifest.packageManager).toBe("pnpm@10.34.5");
    expect(existsSync(join(process.cwd(), "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(join(process.cwd(), "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(join(process.cwd(), "package-lock.json"))).toBe(false);
    expect(existsSync(join(process.cwd(), "yarn.lock"))).toBe(false);
  });

  it("reads workspace inventory from pnpm-lock.yaml without requiring peerDependencies", () => {
    const importers = parsePnpmLockfileImporters(`importers:

  .:
    devDependencies:
      prettier:
        specifier: ^3.9.6
        version: 3.9.6

  packages/billing-core:
    dependencies:
      '@pegma/spine':
        specifier: 0.1.2
        version: 0.1.2
      '@pegma/storage-core':
        specifier: 0.4.0
        version: 0.4.0

packages:
  prettier@3.9.6:
    resolution: {integrity: sha512-example}
`);
    expect(Object.keys(importers)).toEqual([".", "packages/billing-core"]);
    expect(importers["packages/billing-core"]).toEqual({
      dependencies: {
        "@pegma/spine": { specifier: "0.1.2", version: "0.1.2" },
        "@pegma/storage-core": { specifier: "0.4.0", version: "0.4.0" },
      },
    });
    expect(importers["packages/billing-core"]?.peerDependencies).toBe(
      undefined,
    );

    const live = parsePnpmLockfileImporters(
      readFileSync(join(process.cwd(), "pnpm-lock.yaml"), "utf8"),
    );
    expect(
      lockDependencyMatches(
        live["packages/billing-core"]?.dependencies?.["@pegma/spine"],
        "0.1.2",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/billing-core"]?.dependencies?.["@pegma/storage-core"],
        "0.4.0",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/billing-stripe"]?.dependencies?.["@pegma/billing-core"],
        "0.1.0",
        { workspace: true },
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/billing-stripe"]?.dependencies?.["@pegma/spine"],
        "0.1.2",
      ),
    ).toBe(true);
  });

  it("matches each lockfile dependency to its own specifier and resolved version", () => {
    expect(
      lockDependencyMatches({ specifier: "0.1.2", version: "0.1.2" }, "0.1.2"),
    ).toBe(true);
    expect(
      lockDependencyMatches({ specifier: "0.1.2", version: "0.4.0" }, "0.1.2"),
    ).toBe(false);
    expect(
      lockDependencyMatches(
        { specifier: "0.1.0", version: "link:../billing-core" },
        "0.1.0",
        { workspace: true },
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches({ specifier: "0.1.0", version: "0.1.0" }, "0.1.0", {
        workspace: true,
      }),
    ).toBe(false);
    expect(resolvedVersionSatisfies("1.2.3", "^1.2.0")).toBe(true);
    expect(
      resolvedVersionSatisfies("1.2.3(@types/node@26.1.2)", "^1.2.0"),
    ).toBe(true);
    expect(resolvedVersionSatisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(resolvedVersionSatisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(resolvedVersionSatisfies("0.3.0", "^0.2.3")).toBe(false);
    expect(resolvedVersionSatisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(resolvedVersionSatisfies("0.0.4", "^0.0.3")).toBe(false);
    expect(resolvedVersionSatisfies("0.1.1", "0.1.1")).toBe(true);
    expect(resolvedVersionSatisfies("0.1.1(@pegma/spine@0.1.1)", "0.1.1")).toBe(
      true,
    );
    expect(resolvedVersionSatisfies("0.1.2", "0.1.1")).toBe(false);
    expect(resolvedVersionSatisfies("1.2.3-rc.1", "1.2.3")).toBe(false);
    expect(resolvedVersionSatisfies("1.2.3-rc.1", "1.2.3-rc.1")).toBe(true);
    expect(
      resolvedVersionSatisfies("1.2.3-rc.1(@foo@1.0.0)", "1.2.3-rc.1"),
    ).toBe(true);
    expect(resolvedVersionSatisfies("1.2.3", "1.2.3-rc.1")).toBe(false);
    expect(resolvedVersionSatisfies("0.9.0", "^0")).toBe(true);
    expect(resolvedVersionSatisfies("1.0.0", "^0")).toBe(false);
    expect(resolvedVersionSatisfies("0.0.9", "^0.0")).toBe(true);
    expect(resolvedVersionSatisfies("0.1.0", "^0.0")).toBe(false);
  });

  it("keeps pack, registry view, and publish on the npm CLI", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/release-packages.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(
      /(?:npmExecPath|npm_execpath)\s*(?:\?\?|===|!==)/u,
    );
    expect(source).toMatch(
      /function runNpm\([\s\S]*?process\.platform === "win32" \? "npm\.cmd" : "npm"/u,
    );
  });
});

describe("release source authentication", () => {
  it("keeps preparation outside the OIDC-enabled publisher job", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf8",
    );
    const jobsMarker = "\njobs:\n";
    const jobsIndex = workflow.indexOf(jobsMarker);
    expect(jobsIndex).toBeGreaterThanOrEqual(0);
    const header = workflow.slice(0, jobsIndex);
    const jobs = workflow.slice(jobsIndex + jobsMarker.length);
    const prepareStart = jobs.indexOf("  prepare:");
    const publishStart = jobs.indexOf("\n  publish:");
    expect(header).not.toContain("id-token: write");
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(publishStart).toBeGreaterThan(prepareStart);
    const prepare = jobs.slice(prepareStart, publishStart);
    const publish = jobs.slice(publishStart);
    expect(prepare).not.toContain("id-token: write");
    expect(prepare).toContain("npm install --global npm@11.18.0");
    expect(prepare).toContain("pnpm run release:pack");
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("npm ci");
    expect(publish).toContain("npm install --global npm@11.18.0");
    expect(publish).not.toContain("pnpm install");
    expect(publish).not.toContain("corepack");
    expect(publish).not.toContain("pnpm run");
    expect(publish).not.toContain("pnpm/action-setup");
    expect(publish).toContain("node scripts/release-packages.mjs publish");
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toContain("retention-days: 30");
  });
});

describe("retry-safe publication", () => {
  const integrity = "sha512-cHJlcGFyZWQtdGFyYmFsbA==";

  it("publishes an absent version", () => {
    expect(decidePublication(integrity, null)).toBe("publish");
  });

  it("skips a byte-identical existing version", () => {
    expect(decidePublication(integrity, integrity)).toBe("skip");
  });

  it("rejects an existing version with different bytes", () => {
    expect(() => decidePublication(integrity, "sha512-ZGlmZmVyZW50")).toThrow(
      "different tarball integrity",
    );
  });
});
