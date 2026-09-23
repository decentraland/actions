import { EnsurePlan } from "./types";

/**
 * Decide what to do with S3 for the target version, from the current S3 state.
 * Pure and testable. The action always repoints the KV afterwards (or stages,
 * if no environments are given) — this only covers the S3 side.
 *
 * Precedence is deliberate, and it is what keeps a caller from deploying bytes
 * it did not ask for:
 *
 * 1. target already populated and not `force` -> **skip**.
 * 2. an explicit `sourceVersion` -> **copy** from it. The caller named the
 *    bytes, so it outranks everything below.
 * 3. a `dist-path` was handed over -> **upload** it. A folder the caller built
 *    always beats the implicit commit-version source: `dist-path` + `version`
 *    means "publish THESE bytes under that version".
 * 4. `copyFromCommit` (the release flow) and the target is a different version
 *    -> **copy** the commit's already-uploaded build into it.
 * 5. nothing to populate it with -> error.
 *
 * Step 4 is opt-in on purpose. "Repoint at version X" and "release-copy into
 * version X" are otherwise the same input shape (`version` set, no folder), so
 * without the flag a target that is merely absent — a typo, an expired prefix —
 * would silently be filled with whatever the current commit built and then
 * served. Failing closed is the only safe default.
 */
export function resolveEnsurePlan(opts: {
  folderPresent: boolean;
  sourceVersion?: string;
  targetVersion: string;
  commitVersion: string;
  targetExists: boolean;
  force: boolean;
  copyFromCommit: boolean;
}): EnsurePlan {
  if (opts.targetExists && !opts.force) {
    return { s3: "skip" };
  }

  if (opts.sourceVersion) {
    if (opts.sourceVersion === opts.targetVersion) {
      throw new Error(
        `\`source-version\` and the target version are both "${opts.targetVersion}" — ` +
          "a version cannot be copied onto itself. Drop `source-version`, or point it at the " +
          "version the bytes should come from.",
      );
    }
    return { s3: "copy", source: opts.sourceVersion };
  }

  if (opts.folderPresent) {
    return { s3: "upload" };
  }

  if (opts.copyFromCommit && opts.targetVersion !== opts.commitVersion) {
    return { s3: "copy", source: opts.commitVersion };
  }

  const how =
    "Provide a `dist-path` to upload, a `source-version` to copy from, or set " +
    "`copy-from-commit: true` to copy the current commit's already-uploaded build into it " +
    "(the release flow).";

  // Reaching here with the target PRESENT means `force` carried us past the
  // skip branch — saying "is not in S3" would send an operator hunting for a
  // prefix that is sitting right there.
  if (opts.targetExists) {
    throw new Error(
      `Target version "${opts.targetVersion}" is already in S3, but \`force\` was set and ` +
        `there is nothing to re-populate it with. ${how} Or drop \`force\` to keep the ` +
        "existing bytes.",
    );
  }

  throw new Error(
    `Target version "${opts.targetVersion}" is not in S3 and there is nothing to populate it ` +
      `with. ${how} To repoint at an existing version, deploy it first.`,
  );
}
