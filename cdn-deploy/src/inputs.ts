import * as fs from "fs";
import * as path from "path";
import * as core from "@actions/core";
import { ActionInputs, DeploymentTarget, Environment, KvTarget, NamespaceMap } from "./types";

export const ENVIRONMENTS: Environment[] = ["zone", "today", "org"];
export const DEFAULT_BUCKET = "cdn-decentraland-org-contentbucket-371d0b7";
export const DEFAULT_CDN_BASE_URL = "https://cdn.decentraland.org";
export const DEFAULT_ROLLOUT_NAME = "_site";
export const DEFAULT_ENVIRONMENTS: Environment[] = ["zone", "today"];

/** An npm package name, optionally scoped. Also the S3 key root and KV prefix. */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

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

/** `@dcl/auth-site` -> `auth`, `@dcl/sites` -> `sites`. */
export function deriveDeploymentPath(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, "").replace(/-site$/, "");
}

/**
 * The package name doubles as the S3 key root and the KV record prefix, so it
 * decides which site's content a run can overwrite. It comes from the
 * checked-out `package.json` by default, which a PR can edit — validate the
 * shape so it can't contain path segments, traversal, or separators.
 */
export function validatePackageName(packageName: string): string {
  if (!PACKAGE_NAME_RE.test(packageName)) {
    throw new Error(
      `Invalid package name "${packageName}". Expected an npm package name (optionally ` +
        "`@scope/`-prefixed) with no path separators or traversal — it is used as the S3 key " +
        "root and the Cloudflare KV prefix.",
    );
  }
  return packageName;
}

/** The KV key: explicit `domain`, explicit `deployment-path`, or derived from the package name. */
export function resolveTarget(opts: {
  path?: string;
  domain?: string;
  packageName: string;
}): DeploymentTarget {
  if (opts.domain && opts.path) {
    throw new Error("Provide either `deployment-path` or `domain`, not both");
  }
  if (opts.domain) return { kind: "domain", domain: opts.domain };
  return { kind: "path", path: opts.path || deriveDeploymentPath(opts.packageName) };
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

/** Pick the namespace id for an environment: explicit override > per-env input. */
export function resolveNamespace(
  environment: Environment,
  map: NamespaceMap,
  override?: string,
): string {
  const ns = override || map[environment];
  if (!ns) {
    throw new Error(
      `No Cloudflare namespace id for environment "${environment}". ` +
        `Set the org secret CF_NS_${environment.toUpperCase()} (or cloudflare-namespace-${environment}).`,
    );
  }
  return ns;
}

export function resolveKvTargets(
  environments: Environment[],
  map: NamespaceMap,
  override?: string,
): KvTarget[] {
  if (override && environments.length > 1) {
    throw new Error(
      "`cloudflare-namespace-id` maps every environment to one namespace, so a multi-environment " +
        `run (${environments.join(", ")}) would write them all to the same place. Use the ` +
        "per-environment `cloudflare-namespace-*` inputs instead.",
    );
  }
  return environments.map((environment) => ({
    environment,
    namespaceId: resolveNamespace(environment, map, override),
  }));
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

/** The KV key for a target: the path or the domain (environment picks namespace). */
export function kvKeyForTarget(target: DeploymentTarget): string {
  return target.kind === "domain" ? target.domain : target.path;
}

/** Human-facing URL for the Slack notification, mirroring `changeRollout`. */
export function rolloutUrlForTarget(target: DeploymentTarget, environment: Environment): string {
  return target.kind === "domain"
    ? `https://${target.domain}`
    : `https://decentraland.${environment}/${target.path}`;
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
  workspace = process.env.GITHUB_WORKSPACE,
): string {
  const resolved = path.resolve(distPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`dist-path "${distPath}" does not exist`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`dist-path "${distPath}" is not a directory`);
  }

  if (workspace) {
    const root = path.resolve(workspace);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `dist-path "${distPath}" resolves outside the workspace (${root}). Point it at the ` +
          "build output inside the checked-out repository.",
      );
    }
    if (relative === "") {
      throw new Error(
        "dist-path is the repository root. Everything under it — including `.git`, `.env` and " +
          "`.npmrc` — would be published to a public CDN bucket. Point it at the build output " +
          "directory (e.g. ./dist).",
      );
    }
  }

  if (fs.existsSync(path.join(resolved, ".git"))) {
    throw new Error(
      `dist-path "${distPath}" contains a .git directory, which would be published to a public ` +
        "CDN bucket. Point it at the build output directory.",
    );
  }

  return distPath;
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

  const target = resolveTarget({
    path: core.getInput("deployment-path") || undefined,
    domain: core.getInput("domain") || undefined,
    packageName,
  });

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

  const namespaceOverride = core.getInput("cloudflare-namespace-id") || undefined;
  const kvTargets = resolveKvTargets(
    environments,
    {
      zone: core.getInput("cloudflare-namespace-zone") || undefined,
      today: core.getInput("cloudflare-namespace-today") || undefined,
      org: core.getInput("cloudflare-namespace-org") || undefined,
    },
    namespaceOverride,
  );

  // Namespace ids are org secrets. Mask them so they can't reach a log through
  // an error message even when a caller passes them from a `vars.*`.
  for (const { namespaceId } of kvTargets) core.setSecret(namespaceId);

  const version = core.getInput("version") || undefined;
  const sourceVersion = core.getInput("source-version") || undefined;
  if (version && sourceVersion && version === sourceVersion) {
    throw new Error(
      `\`version\` and \`source-version\` are both "${version}" — a version cannot be copied ` +
        "onto itself.",
    );
  }

  // Cloudflare credentials are only needed when something is actually repointed;
  // a stage-only run (`deployment-environments: '[]'`) never calls Cloudflare.
  const needsCloudflare = environments.length > 0;
  const cloudflareAccountId = core.getInput("cloudflare-account-id", { required: needsCloudflare });
  const cloudflareApiToken = core.getInput("cloudflare-api-token", { required: needsCloudflare });
  if (cloudflareApiToken) core.setSecret(cloudflareApiToken);

  const slackWebhook = core.getInput("slack-webhook") || undefined;
  if (slackWebhook) core.setSecret(slackWebhook);

  return {
    distPath,
    packageName,
    baseVersion,
    target,
    environments,
    kvTargets,
    deploymentName: core.getInput("deployment-name") || DEFAULT_ROLLOUT_NAME,
    percentage: parsePercentage(core.getInput("percentage")),
    version,
    sourceVersion,
    commit: core.getInput("commit") || undefined,
    requireIndex: parseBooleanInput(core.getInput("require-index"), true, "require-index"),
    force: parseBooleanInput(core.getInput("force"), false, "force"),
    copyFromCommit: parseBooleanInput(core.getInput("copy-from-commit"), false, "copy-from-commit"),
    awsRegion: core.getInput("aws-region") || "us-east-1",
    s3Bucket: core.getInput("s3-bucket") || DEFAULT_BUCKET,
    cloudflareAccountId,
    cloudflareApiToken,
    slackWebhook,
    createGithubDeployment: parseBooleanInput(
      core.getInput("create-github-deployment"),
      true,
      "create-github-deployment",
    ),
    cdnBaseUrl: core.getInput("cdn-base-url") || DEFAULT_CDN_BASE_URL,
  };
}
