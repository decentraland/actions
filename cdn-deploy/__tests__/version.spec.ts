import { computeVersion, shortSha } from "../src/version";

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
    let opts: { baseVersion: string; sha: string };

    beforeEach(() => {
      opts = { baseVersion: "1.0.0", sha: "deadbeefcafebabe" };
    });

    it("should produce the base version suffixed with the short sha", () => {
      expect(computeVersion(opts)).toBe("1.0.0-commit-deadbee");
    });
  });

  describe("and the sha is upper case", () => {
    let opts: { baseVersion: string; sha: string };

    beforeEach(() => {
      opts = { baseVersion: "2.5.1", sha: "ABCDEF1234567890ABCDEF1234567890ABCDEF12" };
    });

    it("should produce a version with a lower-cased short sha", () => {
      expect(computeVersion(opts)).toBe("2.5.1-commit-abcdef1");
    });
  });

  describe("and the base version is missing", () => {
    let opts: { baseVersion: string; sha: string };

    beforeEach(() => {
      opts = { baseVersion: "", sha: "deadbeefcafebabe" };
    });

    it("should throw a missing baseVersion error", () => {
      expect(() => computeVersion(opts)).toThrow("computeVersion: missing baseVersion");
    });
  });

  describe("and the commit sha is missing", () => {
    let opts: { baseVersion: string; sha: string };

    beforeEach(() => {
      opts = { baseVersion: "1.0.0", sha: "" };
    });

    it("should throw a missing commit sha error", () => {
      expect(() => computeVersion(opts)).toThrow("computeVersion: missing commit sha");
    });
  });

  describe("and the sha is a branch name", () => {
    let opts: { baseVersion: string; sha: string };

    beforeEach(() => {
      opts = { baseVersion: "1.0.0", sha: "main" };
    });

    it("should throw an error stating the value is not a commit sha", () => {
      expect(() => computeVersion(opts)).toThrow(NOT_A_SHA_ERROR);
    });
  });
});
