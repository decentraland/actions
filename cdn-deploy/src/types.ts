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

/** Fully-resolved, validated action inputs. */
export type ActionInputs = {
  folder: string;
  packageName?: string;
  target: DeploymentTarget;
  deploymentName: string;
  percentage: number;
  /** When set, skip the S3 upload and only patch the KV record (rollback / re-point). */
  version?: string;
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
