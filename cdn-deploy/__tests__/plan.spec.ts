import { resolveEnsurePlan } from "../src/plan";

type EnsurePlanOpts = Parameters<typeof resolveEnsurePlan>[0];

const COMMIT_VERSION = "1.0.0-commit-abc1234";
const RELEASE_VERSION = "1.2.3";
const NOTHING_TO_POPULATE_ERROR = "is not in S3 and there is nothing to populate it with";

/**
 * The plan covers the S3 side only; the rollout happens afterwards either way.
 *
 * It used to take `targetExists`, `force` and an explicit `sourceVersion`, and had
 * branches for all three. None of them could do anything:
 *
 * - `targetExists` was always false, because the broker refuses to mint write credentials
 *   for a published version rather than reporting that it exists — so the "already there,
 *   skip" branch and the "force set but nothing to redo" branch were both unreachable, and
 *   the tests that covered them drove a state the broker never sends.
 * - `sourceVersion` could only ever name this run's own commit build: `/release` derives
 *   the source from the token's sha and refuses anything whose `-commit-<sha7>` suffix
 *   does not match. That is exactly what `copyFromCommit` computes.
 *
 * What is left is the decision that was always actually being made.
 */
const opts = (over: Partial<EnsurePlanOpts> = {}): EnsurePlanOpts => ({
  folderPresent: false,
  targetVersion: RELEASE_VERSION,
  commitVersion: COMMIT_VERSION,
  copyFromCommit: false,
  ...over,
});

describe("when a built folder is provided", () => {
  it("should upload it", () => {
    expect(resolveEnsurePlan(opts({ folderPresent: true }))).toEqual({ s3: "upload" });
  });

  // The caller built and named those bytes, so they outrank the implicit commit source.
  it("should upload it even when the release flow is also enabled", () => {
    expect(resolveEnsurePlan(opts({ folderPresent: true, copyFromCommit: true }))).toEqual({
      s3: "upload",
    });
  });
});

describe("when the release flow fills the target", () => {
  it("should copy the commit's build into it", () => {
    expect(resolveEnsurePlan(opts({ copyFromCommit: true }))).toEqual({
      s3: "copy",
      source: COMMIT_VERSION,
    });
  });

  /**
   * Copying a version onto itself is not a copy. This is the push-build case — the target
   * IS the commit version — where there is nothing to copy from and nothing to do.
   */
  it("should refuse when the target is the commit version itself", () => {
    expect(() =>
      resolveEnsurePlan(opts({ copyFromCommit: true, targetVersion: COMMIT_VERSION })),
    ).toThrow(NOTHING_TO_POPULATE_ERROR);
  });
});

describe("when there is nothing to populate the target with", () => {
  /**
   * The reason `copy-from-commit` is opt-in. "Repoint at version X" and "release-copy into
   * version X" are the same input shape, so a target that is merely absent — a typo, an
   * expired prefix — must fail rather than be filled with whatever this commit built and
   * then served.
   */
  it("should refuse rather than guess", () => {
    expect(() => resolveEnsurePlan(opts())).toThrow(NOTHING_TO_POPULATE_ERROR);
  });

  it("should name the version it could not fill", () => {
    expect(() => resolveEnsurePlan(opts())).toThrow(RELEASE_VERSION);
  });

  it("should say what would have filled it", () => {
    expect(() => resolveEnsurePlan(opts())).toThrow(/dist-path.*copy-from-commit/s);
  });
});
