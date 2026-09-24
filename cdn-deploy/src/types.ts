/** Decentraland CDN environments. `zone` = dev, `today` = stg, `org` = prod. */
export type Environment = "zone" | "today" | "org";

/**
 * NOTE: the KV key is no longer resolved here. Which key a package may write is an
 * authorisation decision — it decides whose site this deploy replaces — so it is made by
 * the broker from `@decentraland/definitions`, where the repository that owns each package
 * is recorded. Accepting a caller-supplied path or domain would let any authorised
 * repository repoint another team's site.
 */

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
  distPath: string;
  packageName: string;
  baseVersion: string;
  /** Environments whose KV gets repointed. Empty = stage only (S3, no KV). */
  environments: Environment[];
  deploymentName: string;
  percentage: number;
  /** Explicit target version (e.g. a release tag). Defaults to the commit version. */
  version?: string;
  /** Explicit version to copy from. Outranks everything but an already-present target. */
  sourceVersion?: string;
  /** Commit sha to compute the version from (manual deploy by commit). Defaults to GITHUB_SHA. */
  commit?: string;
  /** Fail a deploy if the folder has no index.html at its root (default true). */
  requireIndex: boolean;
  /** Redo the S3 upload/copy even when the target bytes are already present. */
  force: boolean;
  /**
   * Opt in to the release copy: when the target `version` is absent from S3,
   * fill it from the current commit's already-uploaded build. Off by default so
   * a `version` that is merely absent fails instead of being silently filled.
   */
  copyFromCommit: boolean;
  slackWebhook?: string;
  createGithubDeployment: boolean;
  cdnBaseUrl: string;
  /** The deploy broker's base URL. */
  brokerUrl: string;
  /** Audience requested on the OIDC token; the broker verifies it. */
  oidcAudience: string;
};

/** Minimal `node-fetch` shape, narrowed to what the broker client needs. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Written last by an upload; the broker refuses to roll out a prefix without it. */
export const COMPLETION_MARKER_FILENAME = ".deploy-complete.json";

/** The broker's endpoint. One deployment serves every rollout environment. */
export const DEFAULT_BROKER_URL = "https://cdn-deploy.decentraland.org";

/** The audience the broker expects on the OIDC token. */
export const DEFAULT_OIDC_AUDIENCE = "dcl-cdn-deploy";
