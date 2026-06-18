import * as fs from "fs";
import * as path from "path";
import * as core from "@actions/core";
import { ActionInputs, DeploymentTarget, Environment, KvTarget, NamespaceMap } from "./types";

export const ENVIRONMENTS: Environment[] = ["zone", "today", "org"];
export const DEFAULT_BUCKET = "cdn-decentraland-org-contentbucket-371d0b7";
export const DEFAULT_CDN_BASE_URL = "https://cdn.decentraland.org";
export const DEFAULT_ROLLOUT_NAME = "_site";
export const DEFAULT_ENVIRONMENTS: Environment[] = ["zone", "today"];

export function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as string[]).includes(value);
}

function asEnvironment(value: string): Environment {
  if (!isEnvironment(value)) {
    throw new Error(`Invalid environment "${value}". Expected one of: ${ENVIRONMENTS.join(", ")}`);
  }
  return value;
}

/** `@dcl/auth-site` -> `auth`, `@dcl/sites` -> `sites`. */
export function deriveDeploymentPath(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, "").replace(/-site$/, "");
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
  const list: string[] = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  return list.map(asEnvironment);
}

/** Pick the namespace id for an environment: explicit override > per-env input. */
export function resolveNamespace(
  environment: Environment,
  map: NamespaceMap,
  override?: string
): string {
  const ns = override || map[environment];
  if (!ns) {
    throw new Error(
      `No Cloudflare namespace id for environment "${environment}". ` +
        `Set the org secret CF_NS_${environment.toUpperCase()} (or cloudflare-namespace-${environment}).`
    );
  }
  return ns;
}

export function resolveKvTargets(
  environments: Environment[],
  map: NamespaceMap,
  override?: string
): KvTarget[] {
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
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Read and validate all action inputs from the environment via @actions/core. */
export function readInputs(): ActionInputs {
  // folder is optional: copy/repoint flows don't upload from disk. When provided, it must exist.
  const folder = core.getInput("folder");
  if (folder && !fs.existsSync(folder)) {
    throw new Error(`folder "${folder}" does not exist`);
  }

  // Identity (package name + base version) comes from the repo-root package.json
  // — the source of truth — NOT the upload folder. A built `./dist` may have no
  // package.json, and copy/repoint flows have no folder at all; reading the root
  // keeps the computed version consistent across deploy/release/manual runs (the
  // reusable workflow always checks the repo out so it's present).
  const pkg = readPackageJson(".");
  const packageName = core.getInput("package-name") || pkg.name;
  if (!packageName) {
    throw new Error(
      "Unable to resolve package name. Set the `package-name` input or add a " +
        '"name" to the built folder\'s package.json.'
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
  let environments: Environment[];
  if (envPlural !== "") environments = parseEnvironments(envPlural); // may be [] (stage)
  else if (envSingular !== "") environments = [asEnvironment(envSingular)];
  else environments = DEFAULT_ENVIRONMENTS;

  const kvTargets = resolveKvTargets(
    environments,
    {
      zone: core.getInput("cloudflare-namespace-zone") || undefined,
      today: core.getInput("cloudflare-namespace-today") || undefined,
      org: core.getInput("cloudflare-namespace-org") || undefined,
    },
    core.getInput("cloudflare-namespace-id") || undefined
  );

  return {
    folder,
    packageName,
    baseVersion: pkg.version || "0.0.0",
    target,
    environments,
    kvTargets,
    deploymentName: core.getInput("deployment-name") || DEFAULT_ROLLOUT_NAME,
    percentage: parsePercentage(core.getInput("percentage")),
    version: core.getInput("version") || undefined,
    sourceVersion: core.getInput("source-version") || undefined,
    commit: core.getInput("commit") || undefined,
    requireIndex: core.getInput("require-index") !== "false",
    force: core.getInput("force") === "true",
    awsRegion: core.getInput("aws-region") || "us-east-1",
    s3Bucket: core.getInput("s3-bucket") || DEFAULT_BUCKET,
    cloudflareAccountId: core.getInput("cloudflare-account-id", { required: true }),
    cloudflareApiToken: core.getInput("cloudflare-api-token", { required: true }),
    slackWebhook: core.getInput("slack-webhook") || undefined,
    createGithubDeployment: core.getBooleanInput("create-github-deployment"),
    cdnBaseUrl: core.getInput("cdn-base-url") || DEFAULT_CDN_BASE_URL,
  };
}
