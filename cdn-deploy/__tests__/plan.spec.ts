import { resolveEnsurePlan } from "../src/plan";

describe("when resolving the S3 ensure plan", () => {
  const commitVersion = "1.0.0-commit-abc1234";

  describe("and the target bytes are already present", () => {
    describe("and force is off", () => {
      it("should skip the S3 work", () => {
        expect(
          resolveEnsurePlan({
            folderPresent: true,
            targetVersion: commitVersion,
            commitVersion,
            targetExists: true,
            force: false,
          })
        ).toEqual({ s3: "skip" });
      });
    });

    describe("and force is on", () => {
      it("should re-upload when a folder is present", () => {
        expect(
          resolveEnsurePlan({
            folderPresent: true,
            targetVersion: commitVersion,
            commitVersion,
            targetExists: true,
            force: true,
          })
        ).toEqual({ s3: "upload" });
      });
    });
  });

  describe("and the target bytes are absent", () => {
    describe("and only a folder is available (normal deploy)", () => {
      it("should upload the folder", () => {
        expect(
          resolveEnsurePlan({
            folderPresent: true,
            targetVersion: commitVersion,
            commitVersion,
            targetExists: false,
            force: false,
          })
        ).toEqual({ s3: "upload" });
      });
    });

    describe("and the target is a different version than the commit (release)", () => {
      it("should copy from the commit version by default", () => {
        expect(
          resolveEnsurePlan({
            folderPresent: false,
            targetVersion: "1.2.3",
            commitVersion,
            targetExists: false,
            force: false,
          })
        ).toEqual({ s3: "copy", source: commitVersion });
      });
    });

    describe("and an explicit source version is given", () => {
      it("should copy from that source", () => {
        expect(
          resolveEnsurePlan({
            folderPresent: false,
            sourceVersion: "0.9.0-commit-old1234",
            targetVersion: "1.2.3",
            commitVersion,
            targetExists: false,
            force: false,
          })
        ).toEqual({ s3: "copy", source: "0.9.0-commit-old1234" });
      });
    });

    describe("and there is nothing to populate the target with", () => {
      it("should throw a clear error", () => {
        expect(() =>
          resolveEnsurePlan({
            folderPresent: false,
            targetVersion: commitVersion,
            commitVersion,
            targetExists: false,
            force: false,
          })
        ).toThrow('Target version "1.0.0-commit-abc1234" is not in S3');
      });
    });
  });
});
