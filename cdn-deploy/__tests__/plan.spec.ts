import { resolveEnsurePlan } from "../src/plan";

type EnsurePlanOpts = Parameters<typeof resolveEnsurePlan>[0];

const COMMIT_VERSION = "1.0.0-commit-abc1234";
const RELEASE_VERSION = "1.2.3";
const OTHER_VERSION = "0.9.0-commit-old1234";
const SELF_COPY_ERROR = "a version cannot be copied onto itself";
const NOTHING_TO_POPULATE_ERROR = "is not in S3 and there is nothing to populate it with";

describe("when resolving the S3 ensure plan", () => {
  describe("and the target version is already present in S3", () => {
    describe("and force is off", () => {
      describe("and a dist folder was provided", () => {
        let opts: EnsurePlanOpts;

        beforeEach(() => {
          opts = {
            folderPresent: true,
            targetVersion: COMMIT_VERSION,
            commitVersion: COMMIT_VERSION,
            targetExists: true,
            force: false,
            copyFromCommit: false,
          };
        });

        it("should skip the S3 work instead of re-uploading the folder", () => {
          expect(resolveEnsurePlan(opts)).toEqual({ s3: "skip" });
        });
      });

      describe("and an explicit source version was provided", () => {
        let opts: EnsurePlanOpts;

        beforeEach(() => {
          opts = {
            folderPresent: false,
            sourceVersion: OTHER_VERSION,
            targetVersion: RELEASE_VERSION,
            commitVersion: COMMIT_VERSION,
            targetExists: true,
            force: false,
            copyFromCommit: false,
          };
        });

        it("should skip the S3 work instead of copying from the source version", () => {
          expect(resolveEnsurePlan(opts)).toEqual({ s3: "skip" });
        });
      });

      describe("and copy-from-commit is enabled for a release target", () => {
        let opts: EnsurePlanOpts;

        beforeEach(() => {
          opts = {
            folderPresent: false,
            targetVersion: RELEASE_VERSION,
            commitVersion: COMMIT_VERSION,
            targetExists: true,
            force: false,
            copyFromCommit: true,
          };
        });

        it("should skip the S3 work instead of copying the commit build", () => {
          expect(resolveEnsurePlan(opts)).toEqual({ s3: "skip" });
        });
      });

      describe("and there is nothing to populate the target with", () => {
        let opts: EnsurePlanOpts;

        beforeEach(() => {
          opts = {
            folderPresent: false,
            targetVersion: RELEASE_VERSION,
            commitVersion: COMMIT_VERSION,
            targetExists: true,
            force: false,
            copyFromCommit: false,
          };
        });

        it("should skip the S3 work without raising an error", () => {
          expect(resolveEnsurePlan(opts)).toEqual({ s3: "skip" });
        });
      });

      describe("and the source version is the same as the target version", () => {
        let opts: EnsurePlanOpts;

        beforeEach(() => {
          opts = {
            folderPresent: false,
            sourceVersion: RELEASE_VERSION,
            targetVersion: RELEASE_VERSION,
            commitVersion: COMMIT_VERSION,
            targetExists: true,
            force: false,
            copyFromCommit: false,
          };
        });

        it("should skip the S3 work without raising the self-copy error", () => {
          expect(resolveEnsurePlan(opts)).toEqual({ s3: "skip" });
        });
      });
    });

    describe("and force is on", () => {
      describe("and a dist folder was provided", () => {
        let opts: EnsurePlanOpts;

        beforeEach(() => {
          opts = {
            folderPresent: true,
            targetVersion: COMMIT_VERSION,
            commitVersion: COMMIT_VERSION,
            targetExists: true,
            force: true,
            copyFromCommit: false,
          };
        });

        it("should re-upload the folder", () => {
          expect(resolveEnsurePlan(opts)).toEqual({ s3: "upload" });
        });
      });

      describe("and an explicit source version was provided", () => {
        let opts: EnsurePlanOpts;

        beforeEach(() => {
          opts = {
            folderPresent: false,
            sourceVersion: OTHER_VERSION,
            targetVersion: RELEASE_VERSION,
            commitVersion: COMMIT_VERSION,
            targetExists: true,
            force: true,
            copyFromCommit: false,
          };
        });

        it("should copy from the explicit source version", () => {
          expect(resolveEnsurePlan(opts)).toEqual({ s3: "copy", source: OTHER_VERSION });
        });
      });

      describe("and copy-from-commit is enabled for a release target", () => {
        let opts: EnsurePlanOpts;

        beforeEach(() => {
          opts = {
            folderPresent: false,
            targetVersion: RELEASE_VERSION,
            commitVersion: COMMIT_VERSION,
            targetExists: true,
            force: true,
            copyFromCommit: true,
          };
        });

        it("should copy from the commit version", () => {
          expect(resolveEnsurePlan(opts)).toEqual({ s3: "copy", source: COMMIT_VERSION });
        });
      });

      describe("and there is nothing to populate the target with", () => {
        let opts: EnsurePlanOpts;

        beforeEach(() => {
          opts = {
            folderPresent: false,
            targetVersion: RELEASE_VERSION,
            commitVersion: COMMIT_VERSION,
            targetExists: true,
            force: true,
            copyFromCommit: false,
          };
        });

        it("should throw an error naming the target version and the ways to populate it", () => {
          expect(() => resolveEnsurePlan(opts)).toThrow(NOTHING_TO_POPULATE_ERROR);
        });
      });
    });
  });

  describe("and the target version is absent from S3", () => {
    describe("and an explicit source version was provided", () => {
      describe("and it differs from the target version", () => {
        describe("and no dist folder was provided", () => {
          let opts: EnsurePlanOpts;

          beforeEach(() => {
            opts = {
              folderPresent: false,
              sourceVersion: OTHER_VERSION,
              targetVersion: RELEASE_VERSION,
              commitVersion: COMMIT_VERSION,
              targetExists: false,
              force: false,
              copyFromCommit: false,
            };
          });

          it("should copy from the explicit source version", () => {
            expect(resolveEnsurePlan(opts)).toEqual({ s3: "copy", source: OTHER_VERSION });
          });
        });

        describe("and a dist folder was also provided", () => {
          let opts: EnsurePlanOpts;

          beforeEach(() => {
            opts = {
              folderPresent: true,
              sourceVersion: OTHER_VERSION,
              targetVersion: RELEASE_VERSION,
              commitVersion: COMMIT_VERSION,
              targetExists: false,
              force: false,
              copyFromCommit: false,
            };
          });

          it("should copy from the explicit source version instead of uploading the folder", () => {
            expect(resolveEnsurePlan(opts)).toEqual({ s3: "copy", source: OTHER_VERSION });
          });
        });

        describe("and copy-from-commit is also enabled", () => {
          let opts: EnsurePlanOpts;

          beforeEach(() => {
            opts = {
              folderPresent: false,
              sourceVersion: OTHER_VERSION,
              targetVersion: RELEASE_VERSION,
              commitVersion: COMMIT_VERSION,
              targetExists: false,
              force: false,
              copyFromCommit: true,
            };
          });

          it("should copy from the explicit source version instead of the commit version", () => {
            expect(resolveEnsurePlan(opts)).toEqual({ s3: "copy", source: OTHER_VERSION });
          });
        });
      });

      describe("and it is the same as the target version", () => {
        describe("and no dist folder was provided", () => {
          let opts: EnsurePlanOpts;

          beforeEach(() => {
            opts = {
              folderPresent: false,
              sourceVersion: RELEASE_VERSION,
              targetVersion: RELEASE_VERSION,
              commitVersion: COMMIT_VERSION,
              targetExists: false,
              force: false,
              copyFromCommit: false,
            };
          });

          it("should throw an error stating a version cannot be copied onto itself", () => {
            expect(() => resolveEnsurePlan(opts)).toThrow(SELF_COPY_ERROR);
          });
        });

        describe("and a dist folder was also provided", () => {
          let opts: EnsurePlanOpts;

          beforeEach(() => {
            opts = {
              folderPresent: true,
              sourceVersion: RELEASE_VERSION,
              targetVersion: RELEASE_VERSION,
              commitVersion: COMMIT_VERSION,
              targetExists: false,
              force: false,
              copyFromCommit: false,
            };
          });

          it("should throw the self-copy error instead of falling back to uploading the folder", () => {
            expect(() => resolveEnsurePlan(opts)).toThrow(SELF_COPY_ERROR);
          });
        });
      });
    });

    describe("and a dist folder was provided without an explicit source version", () => {
      describe("and the target version is the commit version", () => {
        let opts: EnsurePlanOpts;

        beforeEach(() => {
          opts = {
            folderPresent: true,
            targetVersion: COMMIT_VERSION,
            commitVersion: COMMIT_VERSION,
            targetExists: false,
            force: false,
            copyFromCommit: false,
          };
        });

        it("should upload the folder", () => {
          expect(resolveEnsurePlan(opts)).toEqual({ s3: "upload" });
        });
      });

      describe("and the target version differs from the commit version", () => {
        describe("and copy-from-commit is disabled", () => {
          let opts: EnsurePlanOpts;

          beforeEach(() => {
            opts = {
              folderPresent: true,
              targetVersion: RELEASE_VERSION,
              commitVersion: COMMIT_VERSION,
              targetExists: false,
              force: false,
              copyFromCommit: false,
            };
          });

          it("should upload the folder rather than discarding it", () => {
            expect(resolveEnsurePlan(opts)).toEqual({ s3: "upload" });
          });
        });

        describe("and copy-from-commit is enabled", () => {
          let opts: EnsurePlanOpts;

          beforeEach(() => {
            opts = {
              folderPresent: true,
              targetVersion: RELEASE_VERSION,
              commitVersion: COMMIT_VERSION,
              targetExists: false,
              force: false,
              copyFromCommit: true,
            };
          });

          it("should upload the folder rather than copying the commit version over it", () => {
            expect(resolveEnsurePlan(opts)).toEqual({ s3: "upload" });
          });
        });
      });
    });

    describe("and neither a dist folder nor a source version was provided", () => {
      describe("and copy-from-commit is enabled", () => {
        describe("and the target version differs from the commit version", () => {
          let opts: EnsurePlanOpts;

          beforeEach(() => {
            opts = {
              folderPresent: false,
              targetVersion: RELEASE_VERSION,
              commitVersion: COMMIT_VERSION,
              targetExists: false,
              force: false,
              copyFromCommit: true,
            };
          });

          it("should copy from the commit version", () => {
            expect(resolveEnsurePlan(opts)).toEqual({ s3: "copy", source: COMMIT_VERSION });
          });
        });

        describe("and the target version is the commit version", () => {
          let opts: EnsurePlanOpts;

          beforeEach(() => {
            opts = {
              folderPresent: false,
              targetVersion: COMMIT_VERSION,
              commitVersion: COMMIT_VERSION,
              targetExists: false,
              force: false,
              copyFromCommit: true,
            };
          });

          it("should throw instead of copying the commit version onto itself", () => {
            expect(() => resolveEnsurePlan(opts)).toThrow(NOTHING_TO_POPULATE_ERROR);
          });
        });
      });

      describe("and copy-from-commit is disabled", () => {
        describe("and the target version differs from the commit version", () => {
          let opts: EnsurePlanOpts;

          beforeEach(() => {
            opts = {
              folderPresent: false,
              targetVersion: RELEASE_VERSION,
              commitVersion: COMMIT_VERSION,
              targetExists: false,
              force: false,
              copyFromCommit: false,
            };
          });

          it("should throw instead of silently copying the current commit's build", () => {
            expect(() => resolveEnsurePlan(opts)).toThrow(NOTHING_TO_POPULATE_ERROR);
          });
        });

        describe("and the target version is the commit version", () => {
          let opts: EnsurePlanOpts;

          beforeEach(() => {
            opts = {
              folderPresent: false,
              targetVersion: COMMIT_VERSION,
              commitVersion: COMMIT_VERSION,
              targetExists: false,
              force: false,
              copyFromCommit: false,
            };
          });

          it("should throw an error naming the missing target version", () => {
            expect(() => resolveEnsurePlan(opts)).toThrow(
              'Target version "1.0.0-commit-abc1234" is not in S3',
            );
          });
        });
      });
    });
  });
});
