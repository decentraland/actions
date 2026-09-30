import * as fs from "fs";
import * as path from "path";
import * as core from "@actions/core";
import { ActionInputs, DEFAULT_BROKER_URL, DEFAULT_OIDC_AUDIENCE, Environment } from "./types";

export const ENVIRONMENTS: Environment[] = ["zone", "today", "org"];
export const DEFAULT_CDN_BASE_URL = "https://cdn.decentraland.org";
export const DEFAULT_ROLLOUT_NAME = "_site";
/**
 * Just the dev channel.
 *
 * A merge to master deploys to zone; staging and production are promoted deliberately, by
 * a human, from a job that declares a GitHub environment so its protection rules apply.
 * Defaulting to `["zone","today"]` made every merge publish zone and then be refused for
 * today, leaving the job red with the dev rollout already live.
 */
export const DEFAULT_ENVIRONMENTS: Environment[] = ["zone"];

/** An npm package name, optionally scoped. Also the S3 key root and KV prefix. */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PACKAGE_NAME_MAX = 214;

export function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as string[]).includes(value);
}

function asEnvironment(value: string): Environment {
  if (!isEnvironment(value)) {
    throw new Error(`Invalid environment "${value}". Expected one of: ${ENVIRONMENTS.join(", ")}`);
  }
  return value;
}

/**
 * Parse a boolean input, tolerating an empty value.
 *
 * `core.getBooleanInput` throws on `""`, and a composite action's `default:`
 * only applies when the key is absent from `with:` — so the common wrapper
 * pattern `require-index: ${{ inputs.require-index }}` with the caller omitting
 * that input would otherwise kill the run before it starts. Case-insensitive on
 * purpose too: `TRUE` silently meaning `false` is a trap.
 */
export function parseBooleanInput(raw: string, fallback: boolean, name: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid value "${raw}" for \`${name}\`. Expected true or false.`);
}

/**
 * The package name doubles as the S3 key root and the KV record prefix, so it
 * decides which site's content a run can overwrite. It comes from the
 * checked-out `package.json` by default, which a PR can edit — validate the
 * shape so it can't contain path segments, traversal, or separators.
 */
export function validatePackageName(packageName: string): string {
  if (packageName.length > PACKAGE_NAME_MAX) {
    throw new Error(
      `Package name is ${packageName.length} characters; npm caps names at ${PACKAGE_NAME_MAX}.`,
    );
  }
  // Lower-case only: S3 keys are case-sensitive, so `@DCL/Auth` would deploy to
  // a prefix the worker never serves and that the broker's completion check can
  // never match.
  if (!PACKAGE_NAME_RE.test(packageName)) {
    throw new Error(
      `Invalid package name "${packageName}". Expected an npm package name (optionally ` +
        "`@scope/`-prefixed) with no path separators or traversal — it is used as the S3 key " +
        "root and the Cloudflare KV prefix.",
    );
  }
  return packageName;
}

/**
 * The other half of the S3 key.
 *
 * `validatePackageName` above guards the first segment precisely because a PR can edit the
 * file it comes from. The version is the second segment of the same key and had no
 * equivalent: `resolveBaseVersion` returns the package.json `version` verbatim whenever
 * there is no release to anchor on — which is any repository that has never released, and
 * also every transient failure of the releases API. A version of
 * `../../@dcl/other-site/9.9.9` produced the key
 * `@dcl/mine/../../@dcl/other-site/9.9.9-…`, and neither the uploader nor the marker write
 * normalises it: both build the key by string concatenation.
 *
 * The broker refuses such a version today, so this is defence in depth rather than the only
 * control. It is worth having anyway: the broker is a different repository, its rules are
 * not visible from here, and this action already validates the segment it can.
 *
 * Deliberately a shape check, not a semver check. The base version is the caller's to pick
 * and `computeVersion` appends to it; requiring semver here would reject legitimate bases
 * that only become valid once the suffix is added.
 */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function validateVersionShape(version: string, source: string): string {
  if (!VERSION_RE.test(version)) {
    throw new Error(
      `Invalid version "${version}" from ${source}. A version becomes the second segment of ` +
        "the S3 key, so it may contain only letters, digits, dot, underscore, plus and hyphen " +
        "— no path separators, traversal or whitespace.",
    );
  }
  return version;
}

/** Parse the environments input — JSON array (`["zone","today"]`) or comma list. Empty string -> []. */
export function parseEnvironments(raw: string): Environment[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];

  let list: string[];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(
        `Could not parse \`deployment-environments\` as JSON: ${trimmed}. ` +
          `Expected a JSON array like '["zone","today"]' or a comma list like 'zone,today'. ` +
          `(${e instanceof Error ? e.message : String(e)})`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `\`deployment-environments\` must be a JSON array, got: ${trimmed}. ` +
          `Expected something like '["zone","today"]'.`,
      );
    }
    list = parsed.map((entry) => String(entry).trim()).filter(Boolean);
  } else {
    list = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const environments = list.map(asEnvironment);
  const duplicates = environments.filter((env, i) => environments.indexOf(env) !== i);
  if (duplicates.length) {
    throw new Error(
      `Duplicate environment(s) in \`deployment-environments\`: ${[...new Set(duplicates)].join(", ")}.`,
    );
  }
  return environments;
}

export function parsePercentage(raw: string): number {
  const pct = raw === "" ? 100 : Number(raw);
  // Rollout percentages are integers; a fractional value would be silently
  // truncated when stored, so reject it instead.
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    throw new Error(`Invalid percentage "${raw}". Expected an integer between 0 and 100.`);
  }
  return pct;
}

/** True when the folder has an `index.html` at its root. */
export function folderHasIndexHtml(folder: string): boolean {
  return fs.existsSync(path.join(folder, "index.html"));
}

export function readPackageJson(folder: string): { name?: string; version?: string } {
  const file = path.join(folder, "package.json");
  if (!fs.existsSync(file)) return {};
  const contents = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(contents);
  } catch (e) {
    // Swallowing this used to hand back `{}`, which silently became the
    // `0.0.0` base version and a prefix nobody serves.
    throw new Error(
      `Could not parse ${path.resolve(file)}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Validate the folder that is about to be published to a PUBLIC bucket.
 *
 * `@dcl/cdn-uploader` globs with `dot: true` and writes every object
 * `public-read`, so pointing this at a repo root would publish `.git`, `.env`
 * and `.npmrc` to the CDN. Keep it inside the workspace and make the caller
 * name a real directory.
 */
export function validateDistPath(
  distPath: string,
  workspace = process.env.GITHUB_WORKSPACE || process.cwd(),
): string {
  const resolved = path.resolve(distPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`dist-path "${distPath}" does not exist`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`dist-path "${distPath}" is not a directory`);
  }

  // Compare real paths. `path.resolve` does not follow symlinks, so a
  // `dist -> ..` symlink would pass a textual containment check while the
  // uploader globbed through it, and a symlinked GITHUB_WORKSPACE (common on
  // self-hosted runners) would reject a perfectly valid folder.
  const real = fs.realpathSync(resolved);
  const root = fs.realpathSync(path.resolve(workspace));
  const relative = path.relative(root, real);

  if (relative.split(path.sep)[0] === ".." || path.isAbsolute(relative)) {
    throw new Error(
      `dist-path "${distPath}" resolves to ${real}, which is outside the workspace (${root}). ` +
        "Point it at the build output inside the checked-out repository.",
    );
  }
  if (relative === "") {
    throw new Error(
      "dist-path is the repository root. Everything under it — including `.git`, `.env` and " +
        "`.npmrc` — would be published to a public CDN bucket. Point it at the build output " +
        "directory (e.g. ./dist).",
    );
  }
  if (fs.existsSync(path.join(real, ".git"))) {
    throw new Error(
      `dist-path "${distPath}" contains a .git directory, which would be published to a public ` +
        "CDN bucket. Point it at the build output directory.",
    );
  }

  assertNothingPrivateInside(real, distPath);

  return distPath;
}

/**
 * Refuse anything inside the build folder that must not reach a public bucket.
 *
 * One walk, two rules — both about the same thing: the uploader globs `**\/*` with
 * `dot: true` and writes every object `public-read`, so whatever is in here is about to be
 * on the open internet.
 *
 * Checking the root is not enough. The uploader globs `**\/*` with `dot: true` and glob
 * follows symlinked directories, so a single `dist/assets -> ../.git` publishes the
 * repository's git config — which on a runner carries the `AUTHORIZATION: basic <token>`
 * header `actions/checkout` writes — to a public bucket, at a guessable URL, cached
 * immutable for a year. The same trick reaches `~/.aws`, `~/.npmrc` and the runner's
 * workflow temp directory.
 *
 * This does not need a hostile workflow author: any build step, or a dependency's
 * postinstall, can drop one into `dist`.
 *
 * Symlinks that stay inside the folder are fine — they resolve to content that was going
 * to be published anyway.
 */
function assertNothingPrivateInside(root: string, distPath: string): void {
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      // Checking the root only was not enough. A submodule, a vendored checkout, or a
      // build step that copies a repository in all leave a `.git` further down, and on a
      // runner `.git/config` carries the `AUTHORIZATION: basic <token>` extraheader the
      // checkout wrote — a live credential, published world-readable and cached for a
      // year. A submodule's `.git` is a file rather than a directory, so neither is
      // assumed here.
      if (entry.name === ".git") {
        throw new Error(
          `dist-path "${distPath}" contains ${path.relative(root, full)}, a git directory nested ` +
            "inside the build. It would be published to a public CDN bucket, and on a runner its " +
            "config holds the checkout token. Remove it from the build output before deploying.",
        );
      }

      if (entry.isSymbolicLink()) {
        // realpath, not readlink: a relative link, and a chain of links, both have to be
        // resolved before the containment test means anything.
        let target: string;
        try {
          target = fs.realpathSync(full);
        } catch {
          // Dangling: it publishes nothing, and the uploader skips it.
          continue;
        }
        const relative = path.relative(root, target);
        if (
          relative === ".." ||
          relative.split(path.sep)[0] === ".." ||
          path.isAbsolute(relative)
        ) {
          throw new Error(
            `dist-path "${distPath}" contains a symlink that points outside it: ` +
              `${path.relative(root, full)} -> ${target}. The uploader follows symlinks and ` +
              "writes every object public-read, so this would publish files from outside the " +
              "build to a public CDN. Remove it, or point dist-path at a clean build folder.",
          );
        }
        // Inside the folder, so its contents are already in scope. Not followed, to avoid
        // a cycle.
        continue;
      }

      if (entry.isDirectory()) walk(full);
    }
  };

  walk(root);
}

/** Read and validate all action inputs from the environment via @actions/core. */
export function readInputs(): ActionInputs {
  // dist-path is optional: copy/repoint flows don't upload from disk. When
  // provided it must be a real directory inside the workspace.
  const distPath = core.getInput("dist-path");
  if (distPath) validateDistPath(distPath);

  // Identity (package name + base version) comes from the repo-root package.json
  // — the source of truth — NOT the upload folder. A built `./dist` may have no
  // package.json, and copy/repoint flows have no folder at all; reading the root
  // keeps the computed version consistent across deploy/release/manual runs (the
  // caller's workflow must check the repo out).
  const pkg = readPackageJson(".");
  const packageNameInput = core.getInput("package-name") || pkg.name;
  if (!packageNameInput) {
    throw new Error(
      "Unable to resolve package name. Set the `package-name` input, or check the repository " +
        'out so the repo-root package.json (with its "name") is available.',
    );
  }
  const packageName = validatePackageName(packageNameInput);

  // Optional here, demanded where it is actually used. A promotion supplies `version` and
  // runs with no checkout — nothing to build, the bytes are already in S3 — so throwing
  // here refused a job that never needed a base version at all.
  //
  // The two are kept apart on purpose. `base-version` is a deliberate override and wins
  // outright; package.json is only a FLOOR, because the newest release is the real anchor.
  // Collapsing them is what let `@dcl/sites` build `0.0.1-…` while serving 0.69.x — its
  // package.json had been stale for 69 minor versions, and nothing read it until now.
  const baseVersionInput = core.getInput("base-version");
  const baseVersion = baseVersionInput
    ? validateVersionShape(baseVersionInput, "the `base-version` input")
    : undefined;
  const packageVersion = pkg.version
    ? validateVersionShape(pkg.version, "the repo-root package.json")
    : undefined;

  // `deployment-environments` already accepts a bare name, a comma list or a JSON array,
  // so `org` and `["zone","today"]` are both valid and a separate singular input bought
  // nothing but a way to set two inputs that disagree.
  const envInput = core.getInput("deployment-environments");
  const environments: Environment[] =
    envInput !== "" ? parseEnvironments(envInput) : DEFAULT_ENVIRONMENTS; // may be [] (stage)

  const versionInput = core.getInput("version");
  const version = versionInput
    ? validateVersionShape(versionInput, "the `version` input")
    : undefined;

  return {
    distPath,
    packageName,
    baseVersion,
    packageVersion,
    environments,
    deploymentName: core.getInput("deployment-name") || DEFAULT_ROLLOUT_NAME,
    percentage: parsePercentage(core.getInput("percentage")),
    version,
    commit: core.getInput("commit") || undefined,
    requireIndex: parseBooleanInput(core.getInput("require-index"), true, "require-index"),
    copyFromCommit: parseBooleanInput(core.getInput("copy-from-commit"), false, "copy-from-commit"),
    createGithubDeployment: parseBooleanInput(
      core.getInput("create-github-deployment"),
      true,
      "create-github-deployment",
    ),
    cdnBaseUrl: core.getInput("cdn-base-url") || DEFAULT_CDN_BASE_URL,
    brokerUrl: core.getInput("broker-url") || DEFAULT_BROKER_URL,
    oidcAudience: core.getInput("oidc-audience") || DEFAULT_OIDC_AUDIENCE,
  };
}
