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
 * pattern `force: ${{ inputs.force }}` with the caller omitting `force` would
 * otherwise kill the run before it starts. Case-insensitive on purpose too:
 * `force: TRUE` silently meaning `false` is a trap.
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
  // a prefix the worker never serves and that `prefixExists` can never match.
  if (!PACKAGE_NAME_RE.test(packageName)) {
    throw new Error(
      `Invalid package name "${packageName}". Expected an npm package name (optionally ` +
        "`@scope/`-prefixed) with no path separators or traversal — it is used as the S3 key " +
        "root and the Cloudflare KV prefix.",
    );
  }
  return packageName;
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

  assertNoEscapingSymlinks(real, distPath);

  return distPath;
}

/**
 * Refuse a symlink inside the build folder that points outside it.
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
function assertNoEscapingSymlinks(root: string, distPath: string): void {
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

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

  const baseVersion = core.getInput("base-version") || pkg.version;
  if (!baseVersion) {
    throw new Error(
      "Unable to resolve the base version. The repo-root package.json has no `version` — check " +
        "the repository out in the deploy job, or set the `base-version` input. (This used to " +
        "fall back to 0.0.0, which produced a version nobody serves.)",
    );
  }

  // environments: explicit plural > singular sugar > default [zone, today].
  const envPlural = core.getInput("deployment-environments");
  const envSingular = core.getInput("deployment-environment");
  if (envPlural !== "" && envSingular !== "") {
    throw new Error(
      "Provide either `deployment-environments` or `deployment-environment`, not both.",
    );
  }
  let environments: Environment[];
  if (envPlural !== "")
    environments = parseEnvironments(envPlural); // may be [] (stage)
  else if (envSingular !== "") environments = [asEnvironment(envSingular)];
  else environments = DEFAULT_ENVIRONMENTS;

  const version = core.getInput("version") || undefined;
  const sourceVersion = core.getInput("source-version") || undefined;
  if (distPath && sourceVersion) {
    throw new Error(
      "Provide either `dist-path` (publish these bytes) or `source-version` (copy bytes already " +
        "in S3), not both — otherwise the folder you built would be silently discarded.",
    );
  }
  if (version && sourceVersion && version === sourceVersion) {
    throw new Error(
      `\`version\` and \`source-version\` are both "${version}" — a version cannot be copied ` +
        "onto itself.",
    );
  }

  const slackWebhook = core.getInput("slack-webhook") || undefined;
  if (slackWebhook) core.setSecret(slackWebhook);

  return {
    distPath,
    packageName,
    baseVersion,
    environments,
    deploymentName: core.getInput("deployment-name") || DEFAULT_ROLLOUT_NAME,
    percentage: parsePercentage(core.getInput("percentage")),
    version,
    sourceVersion,
    commit: core.getInput("commit") || undefined,
    requireIndex: parseBooleanInput(core.getInput("require-index"), true, "require-index"),
    force: parseBooleanInput(core.getInput("force"), false, "force"),
    copyFromCommit: parseBooleanInput(core.getInput("copy-from-commit"), false, "copy-from-commit"),
    slackWebhook,
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
