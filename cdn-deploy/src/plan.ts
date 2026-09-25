import { EnsurePlan } from "./types";

/**
 * Decide what to do with S3 for the target version. Pure and testable. The action always
 * repoints the KV afterwards (or stages, if no environments are given) — this only covers
 * the S3 side.
 *
 * Precedence is deliberate:
 *
 * 1. a `dist-path` was handed over -> **upload** it. The caller built those bytes and
 *    named them, so they outrank the implicit commit-version source below.
 * 2. `copyFromCommit` (the release flow) and the target is a different version -> **copy**
 *    the commit's already-uploaded build into it.
 * 3. nothing to populate it with -> error.
 *
 * Step 2 is opt-in on purpose. "Repoint at version X" and "release-copy into version X"
 * are otherwise the same input shape (`version` set, no folder), so without the flag a
 * target that is merely absent — a typo, an expired prefix — would silently be filled with
 * whatever the current commit built and then served. Failing closed is the only safe
 * default.
 *
 * There is deliberately no "already there, skip" branch. Whether a version is published is
 * the broker's answer, not something inferred here: it refuses to mint write credentials
 * for a completed prefix, and the caller turns that refusal into a skip. Inferring it from
 * a client-side existence check is what let a crashed upload read as deployed.
 */
export function resolveEnsurePlan(opts: {
  folderPresent: boolean;
  targetVersion: string;
  commitVersion: string;
  copyFromCommit: boolean;
}): EnsurePlan {
  if (opts.folderPresent) {
    return { s3: "upload" };
  }

  if (opts.copyFromCommit && opts.targetVersion !== opts.commitVersion) {
    return { s3: "copy", source: opts.commitVersion };
  }

  throw new Error(
    `Target version "${opts.targetVersion}" is not in S3 and there is nothing to populate it ` +
      "with. Provide a `dist-path` to upload, or set `copy-from-commit: true` to copy the " +
      "current commit's already-uploaded build into it (the release flow). To repoint at an " +
      "existing version, deploy it first.",
  );
}
