import { EnsurePlan } from "./types";

/**
 * Decide what to do with S3 for the target version, from the current S3 state.
 * Pure and testable. The action always repoints the KV afterwards (or stages,
 * if no environments are given) — this only covers the S3 side.
 *
 * - target bytes already present and not `force` -> **skip**.
 * - otherwise populate the target: prefer **copy** from a source (an explicit
 *   `sourceVersion`, or the commit version when the target is a different
 *   version — the release case), else **upload** the built `folder`.
 * - nothing to populate it with -> error.
 */
export function resolveEnsurePlan(opts: {
  folderPresent: boolean;
  sourceVersion?: string;
  targetVersion: string;
  commitVersion: string;
  targetExists: boolean;
  force: boolean;
}): EnsurePlan {
  if (opts.targetExists && !opts.force) {
    return { s3: "skip" };
  }

  const source =
    opts.sourceVersion ||
    (opts.targetVersion !== opts.commitVersion ? opts.commitVersion : undefined);

  if (source && source !== opts.targetVersion) {
    return { s3: "copy", source };
  }

  if (opts.folderPresent) {
    return { s3: "upload" };
  }

  throw new Error(
    `Target version "${opts.targetVersion}" is not in S3 and there is nothing to populate it ` +
      "with: provide a `folder` to upload, or a `source-version` to copy from (or deploy the " +
      "source commit first)."
  );
}
