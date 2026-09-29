import { computeVersion, resolveBaseVersion, shortSha } from "../src/version";

const NOT_A_SHA_ERROR = "is not a commit sha";

describe("when shortening a commit sha", () => {
  describe("and the sha is a full 40-character sha", () => {
    let sha: string;

    beforeEach(() => {
      sha = "9f8e7d6c5b4a39281706f5e4d3c2b1a099887766";
    });

    it("should return its first 7 characters", () => {
      expect(shortSha(sha)).toBe("9f8e7d6");
    });
  });

  describe("and the sha is already 7 characters long", () => {
    let sha: string;

    beforeEach(() => {
      sha = "a1b2c3d";
    });

    it("should return it unchanged", () => {
      expect(shortSha(sha)).toBe("a1b2c3d");
    });
  });

  describe("and the sha is upper case", () => {
    let sha: string;

    beforeEach(() => {
      sha = "ABCDEF1234567890ABCDEF1234567890ABCDEF12";
    });

    it("should return its first 7 characters in lower case", () => {
      expect(shortSha(sha)).toBe("abcdef1");
    });
  });

  describe("and the sha is surrounded by whitespace", () => {
    let sha: string;

    beforeEach(() => {
      sha = "  deadbeefcafebabe\n";
    });

    it("should trim it before shortening", () => {
      expect(shortSha(sha)).toBe("deadbee");
    });
  });

  describe("and the value is a branch name", () => {
    let sha: string;

    beforeEach(() => {
      sha = "main";
    });

    it("should throw an error stating the value is not a commit sha", () => {
      expect(() => shortSha(sha)).toThrow(NOT_A_SHA_ERROR);
    });
  });

  describe("and the value is a hex string shorter than 7 characters", () => {
    let sha: string;

    beforeEach(() => {
      sha = "abc123";
    });

    it("should throw an error asking for 7 or more hex characters", () => {
      expect(() => shortSha(sha)).toThrow(NOT_A_SHA_ERROR);
    });
  });

  describe("and the value is an empty string", () => {
    let sha: string;

    beforeEach(() => {
      sha = "";
    });

    it("should throw an error stating the value is not a commit sha", () => {
      expect(() => shortSha(sha)).toThrow(NOT_A_SHA_ERROR);
    });
  });
});

describe("when computing a version", () => {
  describe("and a base version and a valid sha are provided", () => {
    let opts: { baseVersion: string; sha: string; runId: string };

    beforeEach(() => {
      opts = { baseVersion: "1.0.0", sha: "deadbeefcafebabe", runId: "42" };
    });

    it("should produce the base version suffixed with the short sha", () => {
      expect(computeVersion(opts)).toBe("1.0.0-42.commit-deadbee");
    });
  });

  describe("and the sha is upper case", () => {
    let opts: { baseVersion: string; sha: string; runId: string };

    beforeEach(() => {
      opts = { baseVersion: "2.5.1", sha: "ABCDEF1234567890ABCDEF1234567890ABCDEF12", runId: "42" };
    });

    it("should produce a version with a lower-cased short sha", () => {
      expect(computeVersion(opts)).toBe("2.5.1-42.commit-abcdef1");
    });
  });

  describe("and the base version is missing", () => {
    let opts: { baseVersion: string; sha: string; runId: string };

    beforeEach(() => {
      opts = { baseVersion: "", sha: "deadbeefcafebabe", runId: "42" };
    });

    it("should throw a missing baseVersion error", () => {
      expect(() => computeVersion(opts)).toThrow("computeVersion: missing baseVersion");
    });
  });

  describe("and the commit sha is missing", () => {
    let opts: { baseVersion: string; sha: string; runId: string };

    beforeEach(() => {
      opts = { baseVersion: "1.0.0", sha: "", runId: "42" };
    });

    it("should throw a missing commit sha error", () => {
      expect(() => computeVersion(opts)).toThrow("computeVersion: missing commit sha");
    });
  });

  describe("and the sha is a branch name", () => {
    let opts: { baseVersion: string; sha: string; runId: string };

    beforeEach(() => {
      opts = { baseVersion: "1.0.0", sha: "main", runId: "42" };
    });

    it("should throw an error stating the value is not a commit sha", () => {
      expect(() => computeVersion(opts)).toThrow(NOT_A_SHA_ERROR);
    });
  });
});

/**
 * Ordering is the whole job. A version that sorts below what is already live produces a
 * green run that changes nothing -- the failure mode that cost us a full deploy cycle to
 * notice, because every other signal said success.
 */
describe("when ordering versions", () => {
  const semver = require("semver");

  describe("and two builds share a base version", () => {
    it("should order them by run id, not by sha", () => {
      const earlier = computeVersion({ baseVersion: "0.69.1", sha: "fa1c2d3aaa", runId: "100" });
      const later = computeVersion({ baseVersion: "0.69.1", sha: "0b3e9f1bbb", runId: "200" });

      // The later build has the alphabetically smaller sha, which is what used to invert
      // the ordering when the run id was absent.
      expect(semver.gt(later, earlier)).toBe(true);
    });
  });

  describe("and a commit build follows a release", () => {
    it("should sort above the release it is based on", () => {
      const live = "0.69.0";
      const built = computeVersion({
        baseVersion: resolveBaseVersion({ packageVersion: "0.0.1", latestRelease: live }),
        sha: "abc1234",
        runId: "100",
      });

      expect(semver.gt(built, live)).toBe(true);
    });
  });
});

describe("when resolving the base version", () => {
  describe("and package.json is behind the latest release", () => {
    it("should anchor on the release and bump the patch", () => {
      expect(resolveBaseVersion({ packageVersion: "0.0.1", latestRelease: "0.69.0" })).toBe("0.69.1");
    });
  });

  // A prerelease of the live version sorts BELOW it, so reusing the release as the base
  // would build something that can never be served.
  describe("and package.json names exactly the latest release", () => {
    it("should still bump the patch", () => {
      expect(resolveBaseVersion({ packageVersion: "0.69.0", latestRelease: "0.69.0" })).toBe("0.69.1");
    });
  });

  describe("and package.json is ahead of the latest release", () => {
    it("should keep package.json, so a planned bump wins", () => {
      expect(resolveBaseVersion({ packageVersion: "1.0.0", latestRelease: "0.69.0" })).toBe("1.0.0");
    });
  });

  describe("and the repository has never released", () => {
    it("should fall back to package.json", () => {
      expect(resolveBaseVersion({ packageVersion: "0.1.0" })).toBe("0.1.0");
    });

    it("should refuse when there is no package.json version either", () => {
      expect(() => resolveBaseVersion({})).toThrow(/no published release/);
    });
  });
});

describe("when the run id is not a number", () => {
  it("should refuse it, since semver compares it numerically", () => {
    expect(() => computeVersion({ baseVersion: "1.0.0", sha: "abc1234", runId: "abc" })).toThrow(
      /not a GitHub run id/,
    );
  });
});
