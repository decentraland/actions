import * as semver from "semver";

/**
 * The version a commit build is published under.
 *
 * Format: `<baseVersion>-<runId>.commit-<shortSha>`, e.g.
 * `0.69.1-36632121287.commit-3a766af`.
 *
 * This is oddish's format, deliberately, because the rollout records already hold years of
 * versions it produced and the two have to sort together. Semver splits prerelease
 * identifiers on `.` only, so `<runId>` is compared as a NUMBER and `commit-<sha>` as a
 * string after it. Both parts matter:
 *
 * - Without the run id, every build between two releases shares a base and they sort by
 *   sha, alphabetically. Roughly half of consecutive deploys would land below the previous
 *   one, and a rollout that cannot win is a green job that changes nothing.
 * - With a `-` instead of the `.`, `<runId>-commit-<sha>` is one alphanumeric identifier
 *   compared lexically, which works only while every run id has the same digit count.
 *
 * An earlier version of this file omitted the run id on purpose, so that a release could
 * reconstruct the commit version it was copying. That reason is gone: releases rebuild
 * under the tag rather than copying, because every site bakes its asset base from the
 * version at build time. A re-run keeps its run id, so re-running a failed job still
 * resolves to the same prefix.
 */

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const RUN_ID_RE = /^[0-9]+$/;

/**
 * First 7 chars of a commit sha, matching `git rev-parse --short`.
 *
 * Lower-cased and shape-checked: `commit: main` would otherwise sail through and
 * produce the version `1.0.0-commit-main`, and an upper-case sha would compute a
 * different string than the same commit in lower case — both of which resolve to
 * an S3 prefix that does not exist.
 */
export function shortSha(sha: string): string {
  const trimmed = sha.trim();
  if (!SHA_RE.test(trimmed)) {
    throw new Error(
      `"${sha}" is not a commit sha. Pass a full or abbreviated (7+ hex characters) sha — a ` +
        "branch or tag name will not resolve to a deployed version.",
    );
  }
  return trimmed.toLowerCase().slice(0, 7);
}

/**
 * Which release a commit build is built on top of.
 *
 * This is oddish's rule with the registry swapped for GitHub. `package.json` is only a
 * floor — the anchor is the newest release, patch-incremented, because a prerelease of the
 * live version sorts BELOW it (`0.69.0-x < 0.69.0`) and would never be served.
 *
 * That `package.json` is only a floor is not a detail: `@dcl/sites` sat at `0.0.1` for 69
 * minor versions without anyone noticing, because oddish never read it either.
 */
export function resolveBaseVersion(opts: {
  packageVersion?: string;
  latestRelease?: string;
}): string {
  const { packageVersion, latestRelease } = opts;

  if (!latestRelease) {
    if (!packageVersion) {
      throw new Error(
        "Unable to resolve a base version: this repository has no published release and the " +
          "repo-root package.json has no `version`. Check the repository out in this job, or " +
          "publish a release. Only a run that has to compute a version needs one -- pass " +
          "`version` to deploy under a name you choose, or to repoint one already in S3.",
      );
    }
    return packageVersion;
  }

  // `-0` is the lowest possible prerelease of packageVersion, so this asks "is every
  // commit build of packageVersion below the latest release?". When package.json names
  // the SAME version as the release, the answer is still yes -- which is what makes the
  // patch bump happen rather than colliding with the release itself.
  const floor = packageVersion ? `${packageVersion}-0` : undefined;
  if (!floor || !semver.valid(floor) || semver.lt(floor, latestRelease)) {
    const bumped = semver.inc(latestRelease, "patch");
    if (!bumped) throw new Error(`Could not increment the latest release "${latestRelease}".`);
    return bumped;
  }

  return packageVersion as string;
}

export function computeVersion(opts: { baseVersion: string; sha: string; runId: string }): string {
  if (!opts.baseVersion) throw new Error("computeVersion: missing baseVersion");
  if (!opts.sha) throw new Error("computeVersion: missing commit sha");
  if (!RUN_ID_RE.test(String(opts.runId ?? "").trim())) {
    throw new Error(
      `"${opts.runId}" is not a GitHub run id. It must be digits: it is compared numerically ` +
        "by semver, and it is what orders two builds of the same base version.",
    );
  }
  return `${opts.baseVersion}-${String(opts.runId).trim()}.commit-${shortSha(opts.sha)}`;
}
