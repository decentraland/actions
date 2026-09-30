/** Decentraland CDN environments. `zone` = dev, `today` = stg, `org` = prod. */
export type Environment = "zone" | "today" | "org";

/**
 * The KV key is not resolved here. Which key a package may write is an authorisation
 * decision — it decides whose site this deploy replaces — so the broker makes it from
 * `@decentraland/definitions`, where the repository owning each package is recorded.
 * Accepting a caller-supplied path or domain would let any authorised repository repoint
 * another team's site.
 */

/** What the state-aware S3 step should do for the target version. */
export type S3Action = "upload" | "skip";

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
  /**
   * The caller's build, run between settling the version and uploading. Absent means the
   * caller built it themselves and must pass `version`.
   */
  buildCommand?: string;
  /** The repo-root package.json version. A floor, not the anchor. */
  packageVersion?: string;
  /** Environments whose KV gets repointed. Empty = stage only (S3, no KV). */
  environments: Environment[];
  percentage: number;
  /** Explicit target version (e.g. a release tag). Defaults to the commit version. */
  version?: string;
  /** Explicit version to copy from. Outranks everything but an already-present target. */
  /** The deploy broker's base URL. */
  brokerUrl: string;
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
