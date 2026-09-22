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

const SHA_RE = /^[0-9a-f]{7,40}$/i;

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

export function computeVersion(opts: { baseVersion: string; sha: string }): string {
  if (!opts.baseVersion) throw new Error("computeVersion: missing baseVersion");
  if (!opts.sha) throw new Error("computeVersion: missing commit sha");
  return `${opts.baseVersion}-commit-${shortSha(opts.sha)}`;
}
