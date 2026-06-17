/** Decentraland CDN environments. `zone` = dev, `today` = stg, `org` = prod. */
export type Environment = "zone" | "today" | "org";

/**
 * The KV key the rollout is written under. Mirrors `webhooks-receiver`'s
 * `changeRollout`: either a path (path-based sites, e.g. `auth`) or a full
 * domain. The environment(s) select which Cloudflare KV namespace(s) receive
 * the write.
 */
export type DeploymentTarget =
  | { kind: "path"; path: string }
  | { kind: "domain"; domain: string };

/** Per-environment Cloudflare KV namespace ids (the `CF_ROLLOUTS__*_NAMESPACE` values). */
export type NamespaceMap = {
  zone?: string;
  today?: string;
  org?: string;
};

/** A resolved KV write target: which namespace, for which environment. */
export type KvTarget = { environment: Environment; namespaceId: string };

/** What the state-aware S3 step should do for the target version. */
export type S3Action = "upload" | "copy" | "skip";

export type EnsurePlan = {
  s3: S3Action;
  /** For `copy`: the version to copy from. */
  source?: string;
};

/** Fully-resolved, validated action inputs. */
export type ActionInputs = {
  /** Pre-built directory to upload (deploy). Empty for copy/repoint flows. */
  folder: string;
  packageName: string;
  baseVersion: string;
  target: DeploymentTarget;
  /** Environments whose KV gets repointed. Empty = stage only (S3, no KV). */
  environments: Environment[];
  /** `environments` resolved to namespace ids. */
  kvTargets: KvTarget[];
  deploymentName: string;
  percentage: number;
  /** Explicit target version (e.g. a release tag). Defaults to the commit version. */
  version?: string;
  /** Explicit version to copy from; otherwise the commit version is used for a release. */
  sourceVersion?: string;
  /** Fail a deploy if the folder has no index.html at its root (default true). */
  requireIndex: boolean;
  /** Redo the S3 upload/copy even when the target bytes are already present. */
  force: boolean;
  awsRegion: string;
  s3Bucket: string;
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  slackWebhook?: string;
  createGithubDeployment: boolean;
  cdnBaseUrl: string;
};
