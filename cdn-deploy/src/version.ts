/**
 * Deterministic version computation.
 *
 * Mirrors `oddish-action`'s `snapshotize` so the version a site produced under
 * the old npm-publish flow is reproduced here without publishing: it is fully
 * derivable, before or after the build, from the base version + the workflow
 * run id + the commit. The run id guarantees uniqueness per run, so the
 * npm-registry conflict resolution oddish did is unnecessary.
 *
 * Format: `<baseVersion>-<runId>.commit-<shortSha>`
 */

/** First 7 chars of a commit sha, matching `git rev-parse --short`. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function snapshotize(baseVersion: string, runId: string | number, commit: string): string {
  return `${baseVersion}-${runId}.commit-${commit}`;
}

export function computeVersion(opts: {
  baseVersion: string;
  runId: string | number;
  sha: string;
}): string {
  if (!opts.baseVersion) throw new Error("computeVersion: missing baseVersion");
  if (!opts.sha) throw new Error("computeVersion: missing commit sha");
  if (opts.runId === undefined || opts.runId === null || `${opts.runId}`.length === 0) {
    throw new Error("computeVersion: missing runId");
  }
  return snapshotize(opts.baseVersion, opts.runId, shortSha(opts.sha));
}
