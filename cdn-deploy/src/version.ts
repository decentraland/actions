/**
 * Commit-deterministic version.
 *
 * Format: `<baseVersion>-commit-<shortSha>`.
 *
 * The version is derived purely from the base version + the commit, with NO run
 * id. This is deliberate: a later run (e.g. a release on the same commit) must
 * be able to *reconstruct* the version a previous run deployed, so it can locate
 * those bytes in S3 and copy them. It also makes re-runs idempotent (same commit
 * -> same S3 dir -> the state-aware check skips re-uploading). Safe because we no
 * longer publish to npm (run-id uniqueness only mattered for npm versions).
 */

/** First 7 chars of a commit sha, matching `git rev-parse --short`. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function computeVersion(opts: { baseVersion: string; sha: string }): string {
  if (!opts.baseVersion) throw new Error("computeVersion: missing baseVersion");
  if (!opts.sha) throw new Error("computeVersion: missing commit sha");
  return `${opts.baseVersion}-commit-${shortSha(opts.sha)}`;
}
