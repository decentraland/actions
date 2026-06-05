/** Decentraland CDN environments. `zone` = dev, `today` = stg, `org` = prod. */
export type Environment = "zone" | "today" | "org";

/**
 * Where the rollout record is written. Mirrors the key derivation in
 * `webhooks-receiver`'s `changeRollout`: the KV key is either a path
 * (path-based sites, e.g. `auth`) or a full domain. In both cases the
 * `environment` selects which Cloudflare KV namespace receives the write.
 */
export type DeploymentTarget =
  | { kind: "path"; path: string; environment: Environment }
  | { kind: "domain"; domain: string; environment: Environment };

/** Per-environment Cloudflare KV namespace ids (the `CF_ROLLOUTS__*_NAMESPACE` values). */
export type NamespaceMap = {
  zone?: string;
  today?: string;
  org?: string;
};

/**
 * What the action will do, derived from which inputs are present:
 * - `deploy`   — upload the built `folder` to `<packageName>/<version>/`.
 * - `redeploy` — copy an already-uploaded `<packageName>/<sourceVersion>/` to
 *   `<packageName>/<version>/` (no rebuild), e.g. promoting a dev build to a
 *   release tag.
 * - `repoint`  — only move the KV pointer to an already-uploaded `version`.
 */
export type DeployMode = "deploy" | "redeploy" | "repoint";

export type DeployPlan = {
  mode: DeployMode;
  packageName: string;
  /** The version the KV record will point at and the S3 target prefix. */
  version: string;
  /** Only set for `redeploy`: the version whose objects are copied from. */
  sourceVersion?: string;
};

/** Fully-resolved, validated action inputs. */
export type ActionInputs = {
  /** Pre-built directory to upload. Empty in redeploy/repoint modes. */
  folder: string;
  packageName?: string;
  target: DeploymentTarget;
  deploymentName: string;
  percentage: number;
  /** Explicit target version (e.g. a release tag). Required when no `folder`. */
  version?: string;
  /** Source version to copy from (triggers redeploy mode). */
  sourceVersion?: string;
  awsRegion: string;
  s3Bucket: string;
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  /** Namespace id resolved from `target.environment` (or the explicit override). */
  namespaceId: string;
  slackWebhook?: string;
  createGithubDeployment: boolean;
  cdnBaseUrl: string;
};
