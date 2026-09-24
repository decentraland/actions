import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as core from "@actions/core";
import {
  DEFAULT_CDN_BASE_URL,
  DEFAULT_ROLLOUT_NAME,
  folderHasIndexHtml,
  isEnvironment,
  parseBooleanInput,
  parseEnvironments,
  parsePercentage,
  readInputs,
  readPackageJson,
  validateDistPath,
  validatePackageName,
} from "../src/inputs";
import { ActionInputs, DEFAULT_BROKER_URL, DEFAULT_OIDC_AUDIENCE } from "../src/types";

/** `@actions/core` reads `INPUT_<NAME>`: uppercased, spaces to `_`, hyphens kept. */
function envNameFor(input: string): string {
  return `INPUT_${input.replace(/ /g, "_").toUpperCase()}`;
}

function setInputs(values: Record<string, string>): void {
  for (const [input, value] of Object.entries(values)) {
    process.env[envNameFor(input)] = value;
  }
}

function unsetInputs(inputs: string[]): void {
  for (const input of inputs) {
    delete process.env[envNameFor(input)];
  }
}

function clearAllInputs(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("INPUT_")) delete process.env[key];
  }
}

/** `os.tmpdir()` is a symlink on macOS; resolve it so workspace comparisons hold. */
function makeTempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe("when checking if a value is an environment", () => {
  describe("and the value is zone", () => {
    it("should return true", () => {
      expect(isEnvironment("zone")).toBe(true);
    });
  });

  describe("and the value is today", () => {
    it("should return true", () => {
      expect(isEnvironment("today")).toBe(true);
    });
  });

  describe("and the value is org", () => {
    it("should return true", () => {
      expect(isEnvironment("org")).toBe(true);
    });
  });

  describe("and the value is not a known environment", () => {
    it("should return false", () => {
      expect(isEnvironment("prod")).toBe(false);
    });
  });

  describe("and the value is an empty string", () => {
    it("should return false", () => {
      expect(isEnvironment("")).toBe(false);
    });
  });

  describe("and the value only differs in case from a known environment", () => {
    it("should return false", () => {
      expect(isEnvironment("ORG")).toBe(false);
    });
  });
});

describe("when parsing a boolean input", () => {
  describe("and the value is an empty string", () => {
    describe("and the fallback is true", () => {
      it("should return true", () => {
        expect(parseBooleanInput("", true, "require-index")).toBe(true);
      });
    });

    describe("and the fallback is false", () => {
      it("should return false", () => {
        expect(parseBooleanInput("", false, "force")).toBe(false);
      });
    });
  });

  describe("and the value is only whitespace", () => {
    it("should return the fallback", () => {
      expect(parseBooleanInput("   ", true, "require-index")).toBe(true);
    });
  });

  describe("and the value is lowercase true", () => {
    it("should return true", () => {
      expect(parseBooleanInput("true", false, "force")).toBe(true);
    });
  });

  describe("and the value is uppercase TRUE", () => {
    it("should return true rather than silently falling back to false", () => {
      expect(parseBooleanInput("TRUE", false, "force")).toBe(true);
    });
  });

  describe("and the value is capitalised True", () => {
    it("should return true", () => {
      expect(parseBooleanInput("True", false, "force")).toBe(true);
    });
  });

  describe("and the value is lowercase false", () => {
    it("should return false", () => {
      expect(parseBooleanInput("false", true, "require-index")).toBe(false);
    });
  });

  describe("and the value is uppercase FALSE", () => {
    it("should return false", () => {
      expect(parseBooleanInput("FALSE", true, "require-index")).toBe(false);
    });
  });

  describe("and the value is capitalised False", () => {
    it("should return false", () => {
      expect(parseBooleanInput("False", true, "require-index")).toBe(false);
    });
  });

  describe("and the value is padded with whitespace", () => {
    it("should tolerate the padding and return the parsed boolean", () => {
      expect(parseBooleanInput("  true \n", false, "force")).toBe(true);
    });
  });

  describe("and the value is a yes/no word", () => {
    it("should throw naming the offending input", () => {
      expect(() => parseBooleanInput("yes", false, "force")).toThrow(
        'Invalid value "yes" for `force`. Expected true or false.',
      );
    });
  });

  describe("and the value is a numeric flag", () => {
    it("should throw naming the offending input", () => {
      expect(() => parseBooleanInput("1", false, "copy-from-commit")).toThrow(
        "for `copy-from-commit`",
      );
    });
  });
});

describe("when validating a package name", () => {
  describe("and the name is scoped", () => {
    it("should return the name unchanged", () => {
      expect(validatePackageName("@dcl/auth-site")).toBe("@dcl/auth-site");
    });
  });

  describe("and the name is unscoped", () => {
    it("should return the name unchanged", () => {
      expect(validatePackageName("sites")).toBe("sites");
    });
  });

  describe("and the name contains dots and hyphens", () => {
    it("should return the name unchanged", () => {
      expect(validatePackageName("@dcl/my.site-v2_1")).toBe("@dcl/my.site-v2_1");
    });
  });

  describe("and the name contains uppercase characters", () => {
    // S3 keys are case-sensitive, so an upper-case name deploys to a prefix
    // the worker never serves and prefixExists can never match.
    it("should reject it", () => {
      expect(() => validatePackageName("Explorer")).toThrow("Invalid package name");
    });
  });

  describe("and the name is longer than npm allows", () => {
    it("should reject it", () => {
      expect(() => validatePackageName("a".repeat(215))).toThrow("npm caps names at 214");
    });
  });

  describe("and the name contains a path separator", () => {
    it("should throw because the name is used as the S3 key root", () => {
      expect(() => validatePackageName("sites/auth")).toThrow('Invalid package name "sites/auth"');
    });
  });

  describe("and the name contains a windows path separator", () => {
    it("should throw", () => {
      expect(() => validatePackageName("sites\\auth")).toThrow("Invalid package name");
    });
  });

  describe("and the name is a traversal segment", () => {
    it("should throw", () => {
      expect(() => validatePackageName("..")).toThrow('Invalid package name ".."');
    });
  });

  describe("and the name contains a traversal segment", () => {
    it("should throw", () => {
      expect(() => validatePackageName("../evil")).toThrow("Invalid package name");
    });
  });

  describe("and the name starts with a dot", () => {
    it("should throw", () => {
      expect(() => validatePackageName(".hidden")).toThrow('Invalid package name ".hidden"');
    });
  });

  describe("and the name is an empty string", () => {
    it("should throw", () => {
      expect(() => validatePackageName("")).toThrow('Invalid package name ""');
    });
  });

  describe("and the name has a second slash", () => {
    it("should throw", () => {
      expect(() => validatePackageName("@dcl/auth/site")).toThrow("Invalid package name");
    });
  });

  describe("and the scoped name traverses out of its scope", () => {
    it("should throw", () => {
      expect(() => validatePackageName("@dcl/../evil")).toThrow("Invalid package name");
    });
  });
});

describe("when validating the dist path", () => {
  let workspace: string;
  let originalWorkspace: string | undefined;

  beforeEach(() => {
    originalWorkspace = process.env.GITHUB_WORKSPACE;
    delete process.env.GITHUB_WORKSPACE;
    workspace = makeTempDir("cdn-ws-");
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    if (originalWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = originalWorkspace;
  });

  describe("and the path is a real directory inside the workspace", () => {
    let distPath: string;

    beforeEach(() => {
      distPath = path.join(workspace, "dist");
      fs.mkdirSync(distPath);
      fs.writeFileSync(path.join(distPath, "index.html"), "<!doctype html>");
    });

    it("should return the path as provided", () => {
      expect(validateDistPath(distPath, workspace)).toBe(distPath);
    });
  });

  describe("and the path does not exist", () => {
    let distPath: string;

    beforeEach(() => {
      distPath = path.join(workspace, "missing");
    });

    it("should throw saying the path does not exist", () => {
      expect(() => validateDistPath(distPath, workspace)).toThrow("does not exist");
    });
  });

  describe("and the path is a file rather than a directory", () => {
    let distPath: string;

    beforeEach(() => {
      distPath = path.join(workspace, "dist.txt");
      fs.writeFileSync(distPath, "not a folder");
    });

    it("should throw saying the path is not a directory", () => {
      expect(() => validateDistPath(distPath, workspace)).toThrow("is not a directory");
    });
  });

  describe("and the path resolves outside the workspace", () => {
    let outside: string;

    beforeEach(() => {
      outside = makeTempDir("cdn-outside-");
    });

    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it("should throw saying the path resolves outside the workspace", () => {
      expect(() => validateDistPath(outside, workspace)).toThrow("outside the workspace");
    });
  });

  describe("and the path traverses out of the workspace with ..", () => {
    let distPath: string;

    beforeEach(() => {
      distPath = path.join(workspace, "..");
    });

    it("should throw saying the path resolves outside the workspace", () => {
      expect(() => validateDistPath(distPath, workspace)).toThrow("outside the workspace");
    });
  });

  describe("and the path is the workspace root itself", () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(workspace, ".git"));
      fs.writeFileSync(path.join(workspace, ".env"), "SECRET=1");
    });

    it("should throw saying the repository root would be published to a public bucket", () => {
      expect(() => validateDistPath(workspace, workspace)).toThrow(
        "dist-path is the repository root",
      );
    });
  });

  describe("and the directory contains a .git entry", () => {
    let distPath: string;

    beforeEach(() => {
      distPath = path.join(workspace, "dist");
      fs.mkdirSync(distPath);
      fs.mkdirSync(path.join(distPath, ".git"));
    });

    it("should throw saying a .git directory would be published to a public bucket", () => {
      expect(() => validateDistPath(distPath, workspace)).toThrow("contains a .git directory");
    });
  });

  describe("and a .git directory is nested inside the build", () => {
    let distPath: string;

    beforeEach(() => {
      distPath = path.join(workspace, "dist");
      fs.mkdirSync(path.join(distPath, "vendor", "sdk", ".git"), { recursive: true });
      fs.writeFileSync(
        path.join(distPath, "vendor", "sdk", ".git", "config"),
        "[http]\n  extraheader = AUTHORIZATION: basic <REDACTED>\n",
      );
    });

    /**
     * The root-only check missed this, and the uploader globs with `dot: true` and writes
     * `public-read` — so a submodule or a vendored checkout put the runner's checkout
     * token on the open internet, cached for a year.
     */
    it("should throw rather than publish it", () => {
      expect(() => validateDistPath(distPath, workspace)).toThrow("a git directory nested");
    });

    it("should name where it is, so it can be removed", () => {
      expect(() => validateDistPath(distPath, workspace)).toThrow(
        path.join("vendor", "sdk", ".git"),
      );
    });

    it("should say the config holds the checkout token", () => {
      expect(() => validateDistPath(distPath, workspace)).toThrow("checkout token");
    });
  });

  describe("and a submodule leaves a .git FILE rather than a directory", () => {
    let distPath: string;

    beforeEach(() => {
      distPath = path.join(workspace, "dist");
      fs.mkdirSync(path.join(distPath, "vendor"), { recursive: true });
      fs.writeFileSync(
        path.join(distPath, "vendor", ".git"),
        "gitdir: ../../.git/modules/vendor\n",
      );
    });

    it("should refuse that too", () => {
      expect(() => validateDistPath(distPath, workspace)).toThrow("a git directory nested");
    });
  });

  describe("and the build folder is ordinary", () => {
    let distPath: string;

    beforeEach(() => {
      distPath = path.join(workspace, "dist");
      fs.mkdirSync(path.join(distPath, "assets", "img"), { recursive: true });
      fs.writeFileSync(path.join(distPath, "index.html"), "<html></html>");
      fs.writeFileSync(path.join(distPath, "assets", "img", "logo.png"), "png");
      // Dotfiles that are not secrets are normal build output and must still deploy.
      fs.writeFileSync(path.join(distPath, ".well-known"), "{}");
    });

    it("should accept it", () => {
      expect(validateDistPath(distPath, workspace)).toBe(distPath);
    });
  });

  describe("and no workspace is configured", () => {
    let distPath: string;
    let originalCwd: string;

    beforeEach(() => {
      distPath = path.join(workspace, "dist");
      fs.mkdirSync(distPath);
      originalCwd = process.cwd();
      process.chdir(workspace);
    });

    afterEach(() => {
      process.chdir(originalCwd);
    });

    // Failing open here would drop the containment guard entirely on a runner
    // that does not set GITHUB_WORKSPACE, so it falls back to the cwd.
    it("should fall back to the working directory and accept a folder inside it", () => {
      expect(validateDistPath(distPath, undefined)).toBe(distPath);
    });

    it("should still reject a folder outside the working directory", () => {
      const outside = makeTempDir("cdn-no-ws-");
      try {
        expect(() => validateDistPath(outside, undefined)).toThrow("outside the workspace");
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

describe("when parsing the environments input", () => {
  describe("and it is a JSON array", () => {
    it("should parse the listed environments", () => {
      expect(parseEnvironments('["zone","today"]')).toEqual(["zone", "today"]);
    });
  });

  describe("and it is a JSON array padded with whitespace", () => {
    it("should parse the listed environments", () => {
      expect(parseEnvironments('  ["zone", "org"]  ')).toEqual(["zone", "org"]);
    });
  });

  describe("and it is a comma list", () => {
    it("should parse and trim the environments", () => {
      expect(parseEnvironments("zone, org")).toEqual(["zone", "org"]);
    });
  });

  describe("and it is a comma list with blank entries", () => {
    it("should drop the blanks", () => {
      expect(parseEnvironments(" zone , , today ")).toEqual(["zone", "today"]);
    });
  });

  describe("and it is an empty string", () => {
    it("should return an empty list (stage)", () => {
      expect(parseEnvironments("")).toEqual([]);
    });
  });

  describe("and it is an explicit empty array", () => {
    it("should return an empty list (stage)", () => {
      expect(parseEnvironments("[]")).toEqual([]);
    });
  });

  describe("and it contains an invalid environment", () => {
    it("should throw naming the invalid environment", () => {
      expect(() => parseEnvironments('["zone","prod"]')).toThrow('Invalid environment "prod"');
    });
  });

  describe("and it is malformed JSON", () => {
    it("should throw a message pointing at the expected shapes instead of a raw SyntaxError", () => {
      expect(() => parseEnvironments("[")).toThrow(
        "Could not parse `deployment-environments` as JSON: [",
      );
    });
  });

  describe("and it is valid JSON but not an array", () => {
    it("should throw a message naming the unusable value", () => {
      expect(() => parseEnvironments('{"a":1}')).toThrow(
        '`deployment-environments` must be a JSON array, got: {"a":1}',
      );
    });
  });

  describe("and it repeats an environment", () => {
    it("should throw naming the duplicated environment", () => {
      expect(() => parseEnvironments('["zone","zone"]')).toThrow(
        "Duplicate environment(s) in `deployment-environments`: zone",
      );
    });
  });
});

describe("when parsing the percentage", () => {
  describe("and the value is empty", () => {
    it("should default to 100", () => {
      expect(parsePercentage("")).toBe(100);
    });
  });

  describe("and the value is zero", () => {
    it("should return 0 instead of coercing it to 100", () => {
      expect(parsePercentage("0")).toBe(0);
    });
  });

  describe("and the value is 100", () => {
    it("should return 100", () => {
      expect(parsePercentage("100")).toBe(100);
    });
  });

  describe("and the value is a mid-range integer", () => {
    it("should return it", () => {
      expect(parsePercentage("25")).toBe(25);
    });
  });

  describe("and the value is negative", () => {
    it("should throw", () => {
      expect(() => parsePercentage("-1")).toThrow('Invalid percentage "-1"');
    });
  });

  describe("and the value is above 100", () => {
    it("should throw", () => {
      expect(() => parsePercentage("150")).toThrow('Invalid percentage "150"');
    });
  });

  describe("and the value is not a number", () => {
    it("should throw", () => {
      expect(() => parsePercentage("abc")).toThrow('Invalid percentage "abc"');
    });
  });

  describe("and the value is fractional", () => {
    it("should throw (percentages are integers)", () => {
      expect(() => parsePercentage("50.5")).toThrow('Invalid percentage "50.5"');
    });
  });
});

describe("when reading the package.json from a folder", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("cdn-pkg-");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("and the folder has a valid package.json", () => {
    beforeEach(() => {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "@dcl/auth-site", version: "1.2.3" }),
      );
    });

    it("should return its name and version", () => {
      expect(readPackageJson(dir)).toEqual({ name: "@dcl/auth-site", version: "1.2.3" });
    });
  });

  describe("and the folder has no package.json", () => {
    it("should return an empty object", () => {
      expect(readPackageJson(dir)).toEqual({});
    });
  });

  describe("and the package.json is not valid JSON", () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(dir, "package.json"), "{ not valid json");
    });

    it("should throw naming the unparseable file instead of returning an empty object", () => {
      expect(() => readPackageJson(dir)).toThrow(
        `Could not parse ${path.join(dir, "package.json")}`,
      );
    });
  });
});

describe("when checking a folder for index.html", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("cdn-idx-");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("and the folder has an index.html at its root", () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
    });

    it("should return true", () => {
      expect(folderHasIndexHtml(dir)).toBe(true);
    });
  });

  describe("and the folder has no index.html", () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(dir, "main.js"), "console.log(1)");
    });

    it("should return false", () => {
      expect(folderHasIndexHtml(dir)).toBe(false);
    });
  });
});

describe("when reading the action inputs", () => {
  let workspace: string;
  let originalCwd: string;
  let originalWorkspace: string | undefined;
  let setSecretMock: jest.SpyInstance;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalWorkspace = process.env.GITHUB_WORKSPACE;
    workspace = makeTempDir("cdn-inputs-");
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "@dcl/auth-site", version: "1.2.3" }),
    );
    process.chdir(workspace);
    process.env.GITHUB_WORKSPACE = workspace;
    clearAllInputs();
    setSecretMock = jest.spyOn(core, "setSecret").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(workspace, { recursive: true, force: true });
    clearAllInputs();
    if (originalWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = originalWorkspace;
    jest.restoreAllMocks();
  });

  describe("and both deployment-environments and deployment-environment are set", () => {
    beforeEach(() => {
      setInputs({ "deployment-environments": '["zone"]', "deployment-environment": "today" });
    });

    it("should refuse rather than silently pick one", () => {
      expect(() => readInputs()).toThrow("not both");
    });
  });

  describe("and both a dist-path and a source-version are given", () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(workspace, "dist"));
      setInputs({ "dist-path": "./dist", "source-version": "1.0.0" });
    });

    // Otherwise the folder the caller just built would be silently discarded in favour of
    // copying bytes already in S3.
    it("should refuse rather than discard the built folder", () => {
      expect(() => readInputs()).toThrow("not both");
    });
  });

  describe("and only the credentials are provided", () => {
    let result: ActionInputs;

    beforeEach(() => {
      result = readInputs();
    });

    it("should default the CDN base url", () => {
      expect(result.cdnBaseUrl).toBe(DEFAULT_CDN_BASE_URL);
    });

    it("should default the rollout name to _site", () => {
      expect(result.deploymentName).toBe(DEFAULT_ROLLOUT_NAME);
    });

    it("should default the percentage to 100", () => {
      expect(result.percentage).toBe(100);
    });

    it("should default requireIndex to true", () => {
      expect(result.requireIndex).toBe(true);
    });

    it("should default force to false", () => {
      expect(result.force).toBe(false);
    });

    it("should default copyFromCommit to false", () => {
      expect(result.copyFromCommit).toBe(false);
    });

    it("should default createGithubDeployment to true", () => {
      expect(result.createGithubDeployment).toBe(true);
    });

    it("should default the environments to the dev channel only", () => {
      expect(result.environments).toEqual(["zone"]);
    });

    it("should leave the dist path empty for copy and repoint flows", () => {
      expect(result.distPath).toBe("");
    });

    it("should read the package name from the repo-root package.json", () => {
      expect(result.packageName).toBe("@dcl/auth-site");
    });

    it("should read the base version from the repo-root package.json", () => {
      expect(result.baseVersion).toBe("1.2.3");
    });
  });

  describe("and create-github-deployment is an empty string", () => {
    let result: ActionInputs;

    beforeEach(() => {
      setInputs({ "create-github-deployment": "" });
      result = readInputs();
    });

    it("should default createGithubDeployment to true instead of failing the run", () => {
      expect(result.createGithubDeployment).toBe(true);
    });
  });

  describe("and create-github-deployment is explicitly false", () => {
    let result: ActionInputs;

    beforeEach(() => {
      setInputs({ "create-github-deployment": "false" });
      result = readInputs();
    });

    it("should return createGithubDeployment as false", () => {
      expect(result.createGithubDeployment).toBe(false);
    });
  });

  describe("and force is given in uppercase", () => {
    let result: ActionInputs;

    beforeEach(() => {
      setInputs({ force: "TRUE" });
      result = readInputs();
    });

    it("should return force as true", () => {
      expect(result.force).toBe(true);
    });
  });

  describe("and a boolean input has an unparseable value", () => {
    beforeEach(() => {
      setInputs({ "require-index": "maybe" });
    });

    it("should throw naming the input", () => {
      expect(() => readInputs()).toThrow('Invalid value "maybe" for `require-index`');
    });
  });

  describe("and the package-name and base-version inputs are provided", () => {
    let result: ActionInputs;

    beforeEach(() => {
      setInputs({ "package-name": "@dcl/account-site", "base-version": "9.9.9" });
      result = readInputs();
    });

    it("should override the package name read from package.json", () => {
      expect(result.packageName).toBe("@dcl/account-site");
    });

    it("should override the base version read from package.json", () => {
      expect(result.baseVersion).toBe("9.9.9");
    });
  });

  describe("and the package.json has no version", () => {
    beforeEach(() => {
      fs.writeFileSync(
        path.join(workspace, "package.json"),
        JSON.stringify({ name: "@dcl/auth-site" }),
      );
    });

    describe("and no base-version input is provided", () => {
      it("should throw instead of silently using 0.0.0", () => {
        expect(() => readInputs()).toThrow("Unable to resolve the base version");
      });
    });

    describe("and a base-version input is provided", () => {
      let result: ActionInputs;

      beforeEach(() => {
        setInputs({ "base-version": "2.0.0" });
        result = readInputs();
      });

      it("should use the provided base version", () => {
        expect(result.baseVersion).toBe("2.0.0");
      });
    });
  });

  describe("and the package.json has no name", () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ version: "1.2.3" }));
    });

    it("should throw asking for the package-name input or a checkout", () => {
      expect(() => readInputs()).toThrow("Unable to resolve package name");
    });
  });

  describe("and the package.json name is not a valid package name", () => {
    beforeEach(() => {
      fs.writeFileSync(
        path.join(workspace, "package.json"),
        JSON.stringify({ name: "../evil", version: "1.2.3" }),
      );
    });

    it("should throw rather than use it as the S3 key root", () => {
      expect(() => readInputs()).toThrow('Invalid package name "../evil"');
    });
  });

  describe("and the package.json is unparseable", () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(workspace, "package.json"), "{ not valid json");
    });

    it("should throw naming the unparseable file", () => {
      expect(() => readInputs()).toThrow("Could not parse");
    });
  });

  describe("and only the singular deployment-environment is set", () => {
    let result: ActionInputs;

    beforeEach(() => {
      setInputs({ "deployment-environment": "org" });
      result = readInputs();
    });

    it("should use that single environment", () => {
      expect(result.environments).toEqual(["org"]);
    });
  });

  describe("and the singular deployment-environment is unknown", () => {
    beforeEach(() => {
      setInputs({ "deployment-environment": "prod" });
    });

    it("should throw naming the invalid environment", () => {
      expect(() => readInputs()).toThrow('Invalid environment "prod"');
    });
  });

  describe("and version equals source-version", () => {
    beforeEach(() => {
      setInputs({ version: "1.2.3", "source-version": "1.2.3" });
    });

    it("should throw because a version cannot be copied onto itself", () => {
      expect(() => readInputs()).toThrow("a version cannot be copied");
    });
  });

  describe("and version and source-version differ", () => {
    let result: ActionInputs;

    beforeEach(() => {
      setInputs({ version: "1.2.3", "source-version": "1.0.0" });
      result = readInputs();
    });

    it("should return the requested target version", () => {
      expect(result.version).toBe("1.2.3");
    });

    it("should return the requested source version", () => {
      expect(result.sourceVersion).toBe("1.0.0");
    });
  });

  describe("and the run is stage only", () => {
    let result: ActionInputs;

    beforeEach(() => {
      setInputs({ "deployment-environments": "[]" });
      result = readInputs();
    });

    it("should resolve with no environments", () => {
      expect(result.environments).toEqual([]);
    });
  });

  describe("and a dist-path pointing at a real build folder is provided", () => {
    let distPath: string;
    let result: ActionInputs;

    beforeEach(() => {
      distPath = path.join(workspace, "dist");
      fs.mkdirSync(distPath);
      setInputs({ "dist-path": distPath });
      result = readInputs();
    });

    it("should return the dist path", () => {
      expect(result.distPath).toBe(distPath);
    });
  });

  describe("and a dist-path pointing at the repository root is provided", () => {
    beforeEach(() => {
      setInputs({ "dist-path": workspace });
    });

    it("should throw before anything is published to the public bucket", () => {
      expect(() => readInputs()).toThrow("dist-path is the repository root");
    });
  });

  describe("and a dist-path that does not exist is provided", () => {
    beforeEach(() => {
      setInputs({ "dist-path": path.join(workspace, "missing") });
    });

    it("should throw saying the path does not exist", () => {
      expect(() => readInputs()).toThrow("does not exist");
    });
  });

  describe("and the optional passthrough inputs are provided", () => {
    let result: ActionInputs;

    beforeEach(() => {
      setInputs({
        "deployment-name": "_beta",
        percentage: "0",
        commit: "abc1234",
        "aws-region": "us-west-2",
        "s3-bucket": "my-bucket",
        "cdn-base-url": "https://cdn.example.com",
        "slack-webhook": "https://hooks.example.com/services/T000/B000/xxx",
        "deployment-environments": "zone",
      });
      result = readInputs();
    });

    it("should return the rollout name", () => {
      expect(result.deploymentName).toBe("_beta");
    });

    it("should return a zero percentage rather than coercing it to 100", () => {
      expect(result.percentage).toBe(0);
    });

    it("should return the commit", () => {
      expect(result.commit).toBe("abc1234");
    });

    it("should return the CDN base url", () => {
      expect(result.cdnBaseUrl).toBe("https://cdn.example.com");
    });

    it("should mask the slack webhook", () => {
      expect(setSecretMock).toHaveBeenCalledWith(
        "https://hooks.example.com/services/T000/B000/xxx",
      );
    });
  });
});
