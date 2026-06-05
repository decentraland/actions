import * as fs from "fs";
import * as path from "path";
import * as core from "@actions/core";
import { ActionInputs, DeploymentTarget, Environment, NamespaceMap } from "./types";

export const ENVIRONMENTS: Environment[] = ["zone", "today", "org"];
export const DEFAULT_BUCKET = "cdn-decentraland-org-contentbucket-371d0b7";
export const DEFAULT_CDN_BASE_URL = "https://cdn.decentraland.org";
export const DEFAULT_ROLLOUT_NAME = "_site";

export function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as string[]).includes(value);
}

/** Validate the target: exactly one of path/domain, plus a valid environment. */
export function resolveTarget(raw: {
  path?: string;
  domain?: string;
  environment: string;
}): DeploymentTarget {
  const hasPath = !!raw.path;
  const hasDomain = !!raw.domain;
  if (hasPath === hasDomain) {
    throw new Error("Provide exactly one of `deployment-path` or `domain`");
  }
  if (!isEnvironment(raw.environment)) {
    throw new Error(
      `Invalid deployment-environment "${raw.environment}". Expected one of: ${ENVIRONMENTS.join(", ")}`
    );
  }
  return hasDomain
    ? { kind: "domain", domain: raw.domain as string, environment: raw.environment }
    : { kind: "path", path: raw.path as string, environment: raw.environment };
}

/** Pick the namespace id for an environment (explicit override wins). */
export function resolveNamespace(
  environment: Environment,
  map: NamespaceMap,
  override?: string
): string {
  const ns = override || map[environment];
  if (!ns) {
    throw new Error(
      `No Cloudflare namespace id configured for environment "${environment}". ` +
        `Set cloudflare-namespace-${environment} (or cloudflare-namespace-id).`
    );
  }
  return ns;
}

export function parsePercentage(raw: string): number {
  const pct = raw === "" ? 100 : Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`Invalid percentage "${raw}". Expected a number between 0 and 100.`);
  }
  return pct;
}

/** The KV key for a target: the path or the domain (environment picks namespace). */
export function kvKeyForTarget(target: DeploymentTarget): string {
  return target.kind === "domain" ? target.domain : target.path;
}

/** Human-facing URL for the Slack notification, mirroring `changeRollout`. */
export function rolloutUrlForTarget(target: DeploymentTarget): string {
  return target.kind === "domain"
    ? `https://${target.domain}`
    : `https://decentraland.${target.environment}/${target.path}`;
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
  // folder is optional: redeploy (source-version) and repoint (version) modes
  // don't upload from disk. When provided, it must exist.
  const folder = core.getInput("folder");
  if (folder && !fs.existsSync(folder)) {
    throw new Error(`folder "${folder}" does not exist`);
  }

  const target = resolveTarget({
    path: core.getInput("deployment-path") || undefined,
    domain: core.getInput("domain") || undefined,
    environment: core.getInput("deployment-environment", { required: true }),
  });

  const namespaceId = resolveNamespace(
    target.environment,
    {
      zone: core.getInput("cloudflare-namespace-zone") || undefined,
      today: core.getInput("cloudflare-namespace-today") || undefined,
      org: core.getInput("cloudflare-namespace-org") || undefined,
    },
    core.getInput("cloudflare-namespace-id") || undefined
  );

  return {
    folder,
    packageName: core.getInput("package-name") || undefined,
    target,
    deploymentName: core.getInput("deployment-name") || DEFAULT_ROLLOUT_NAME,
    percentage: parsePercentage(core.getInput("percentage")),
    version: core.getInput("version") || undefined,
    sourceVersion: core.getInput("source-version") || undefined,
    awsRegion: core.getInput("aws-region") || "us-east-1",
    s3Bucket: core.getInput("s3-bucket") || DEFAULT_BUCKET,
    cloudflareAccountId: core.getInput("cloudflare-account-id", { required: true }),
    cloudflareApiToken: core.getInput("cloudflare-api-token", { required: true }),
    namespaceId,
    slackWebhook: core.getInput("slack-webhook") || undefined,
    createGithubDeployment: core.getBooleanInput("create-github-deployment"),
    cdnBaseUrl: core.getInput("cdn-base-url") || DEFAULT_CDN_BASE_URL,
  };
}
