import { computeVersion, shortSha } from "../src/version";

describe("when computing the short sha", () => {
  let sha: string;

  beforeEach(() => {
    sha = "a1b2c3d4e5f6a7b8c9d0";
  });

  it("should return the first 7 characters", () => {
    expect(shortSha(sha)).toBe("a1b2c3d");
  });
});

describe("when computing a version", () => {
  describe("and base version and sha are present", () => {
    let opts: { baseVersion: string; sha: string };

    beforeEach(() => {
      opts = { baseVersion: "1.0.0", sha: "deadbeefcafebabe" };
    });

    it("should produce <base>-commit-<shortSha>", () => {
      expect(computeVersion(opts)).toBe("1.0.0-commit-deadbee");
    });

    it("should be deterministic for the same commit (no run id)", () => {
      expect(computeVersion(opts)).toBe(computeVersion({ ...opts }));
    });
  });

  describe("and the base version is missing", () => {
    it("should throw a missing baseVersion error", () => {
      expect(() => computeVersion({ baseVersion: "", sha: "deadbeef" })).toThrow(
        "computeVersion: missing baseVersion"
      );
    });
  });

  describe("and the commit sha is missing", () => {
    it("should throw a missing commit sha error", () => {
      expect(() => computeVersion({ baseVersion: "1.0.0", sha: "" })).toThrow(
        "computeVersion: missing commit sha"
      );
    });
  });
});
