import { resolvePlan } from "../src/plan";

describe("when resolving the deploy plan", () => {
  let base: {
    packageJson: { name?: string; version?: string };
    runId: number;
    sha: string;
  };

  beforeEach(() => {
    base = {
      packageJson: { name: "@dcl/auth-site", version: "1.0.0" },
      runId: 7,
      sha: "abc1234def",
    };
  });

  describe("and a folder is present without an explicit version", () => {
    it("should plan a deploy with a computed snapshot version", () => {
      expect(resolvePlan({ ...base, folderPresent: true })).toEqual({
        mode: "deploy",
        packageName: "@dcl/auth-site",
        version: "1.0.0-7.commit-abc1234",
      });
    });
  });

  describe("and a folder is present with an explicit version", () => {
    it("should plan a deploy under the explicit version", () => {
      expect(resolvePlan({ ...base, folderPresent: true, explicitVersion: "2.0.0" })).toEqual({
        mode: "deploy",
        packageName: "@dcl/auth-site",
        version: "2.0.0",
      });
    });
  });

  describe("and a source version is provided with a target version", () => {
    it("should plan a redeploy copying from source to target", () => {
      expect(
        resolvePlan({
          ...base,
          folderPresent: false,
          packageJson: {},
          packageNameInput: "@dcl/auth-site",
          sourceVersion: "1.0.0-7.commit-abc1234",
          explicitVersion: "1.2.3",
        })
      ).toEqual({
        mode: "redeploy",
        packageName: "@dcl/auth-site",
        version: "1.2.3",
        sourceVersion: "1.0.0-7.commit-abc1234",
      });
    });
  });

  describe("and a source version is provided without a target version or folder", () => {
    it("should throw asking for a target version", () => {
      expect(() =>
        resolvePlan({
          ...base,
          folderPresent: false,
          packageJson: {},
          packageNameInput: "@dcl/auth-site",
          sourceVersion: "1.0.0-7.commit-abc1234",
        })
      ).toThrow("Redeploy requires a target `version`");
    });
  });

  describe("and only a version is provided without a folder or source", () => {
    it("should plan a repoint to that version", () => {
      expect(
        resolvePlan({
          ...base,
          folderPresent: false,
          packageJson: {},
          packageNameInput: "@dcl/auth-site",
          explicitVersion: "1.2.3",
        })
      ).toEqual({
        mode: "repoint",
        packageName: "@dcl/auth-site",
        version: "1.2.3",
      });
    });
  });

  describe("and nothing actionable is provided", () => {
    it("should throw a nothing-to-do error", () => {
      expect(() =>
        resolvePlan({ ...base, folderPresent: false, packageJson: {}, packageNameInput: "@dcl/auth-site" })
      ).toThrow("Nothing to do");
    });
  });

  describe("and the package name cannot be resolved", () => {
    it("should throw an unable-to-resolve-package-name error", () => {
      expect(() => resolvePlan({ ...base, folderPresent: true, packageJson: {} })).toThrow(
        "Unable to resolve package name"
      );
    });
  });
});
