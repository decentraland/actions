import { computeVersion, shortSha, snapshotize } from "../src/version";

describe("when computing the short sha", () => {
  let sha: string;

  beforeEach(() => {
    sha = "a1b2c3d4e5f6a7b8c9d0";
  });

  it("should return the first 7 characters", () => {
    expect(shortSha(sha)).toBe("a1b2c3d");
  });
});

describe("when building a snapshot version", () => {
  it("should join base, run id and commit in the oddish format", () => {
    expect(snapshotize("1.2.3", 987654321, "a1b2c3d")).toBe("1.2.3-987654321.commit-a1b2c3d");
  });
});

describe("when computing a version", () => {
  describe("and base version, run id and sha are present", () => {
    let opts: { baseVersion: string; runId: number; sha: string };

    beforeEach(() => {
      opts = { baseVersion: "1.0.0", runId: 42, sha: "deadbeefcafebabe" };
    });

    it("should produce <base>-<runId>.commit-<shortSha>", () => {
      expect(computeVersion(opts)).toBe("1.0.0-42.commit-deadbee");
    });
  });

  describe("and the base version is missing", () => {
    it("should throw a missing baseVersion error", () => {
      expect(() => computeVersion({ baseVersion: "", runId: 42, sha: "deadbeef" })).toThrow(
        "computeVersion: missing baseVersion"
      );
    });
  });

  describe("and the commit sha is missing", () => {
    it("should throw a missing commit sha error", () => {
      expect(() => computeVersion({ baseVersion: "1.0.0", runId: 42, sha: "" })).toThrow(
        "computeVersion: missing commit sha"
      );
    });
  });

  describe("and the run id is missing", () => {
    it("should throw a missing runId error", () => {
      expect(() => computeVersion({ baseVersion: "1.0.0", runId: "", sha: "deadbeef" })).toThrow(
        "computeVersion: missing runId"
      );
    });
  });
});
