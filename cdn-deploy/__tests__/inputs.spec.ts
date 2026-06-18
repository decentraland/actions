import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  deriveDeploymentPath,
  folderHasIndexHtml,
  isEnvironment,
  kvKeyForTarget,
  parseEnvironments,
  parsePercentage,
  readPackageJson,
  resolveKvTargets,
  resolveNamespace,
  resolveTarget,
  rolloutUrlForTarget,
} from "../src/inputs";
import { DeploymentTarget, NamespaceMap } from "../src/types";

describe("when checking if a value is an environment", () => {
  describe("and the value is a known environment", () => {
    it("should return true for zone, today and org", () => {
      expect(isEnvironment("zone") && isEnvironment("today") && isEnvironment("org")).toBe(true);
    });
  });

  describe("and the value is not a known environment", () => {
    it("should return false", () => {
      expect(isEnvironment("prod")).toBe(false);
    });
  });
});

describe("when deriving a deployment path from a package name", () => {
  describe("and the name has a scope and a -site suffix", () => {
    it("should strip both", () => {
      expect(deriveDeploymentPath("@dcl/auth-site")).toBe("auth");
    });
  });

  describe("and the name has a scope but no -site suffix", () => {
    it("should strip only the scope", () => {
      expect(deriveDeploymentPath("@dcl/sites")).toBe("sites");
    });
  });
});

describe("when resolving the deployment target", () => {
  describe("and a path is provided", () => {
    it("should return a path target", () => {
      expect(resolveTarget({ path: "auth", packageName: "@dcl/auth-site" })).toEqual({
        kind: "path",
        path: "auth",
      });
    });
  });

  describe("and a domain is provided", () => {
    it("should return a domain target", () => {
      expect(resolveTarget({ domain: "play.decentraland.org", packageName: "@dcl/explorer" })).toEqual({
        kind: "domain",
        domain: "play.decentraland.org",
      });
    });
  });

  describe("and neither path nor domain is provided", () => {
    it("should derive the path from the package name", () => {
      expect(resolveTarget({ packageName: "@dcl/account-site" })).toEqual({
        kind: "path",
        path: "account",
      });
    });
  });

  describe("and both path and domain are provided", () => {
    it("should throw", () => {
      expect(() =>
        resolveTarget({ path: "auth", domain: "x.org", packageName: "@dcl/auth-site" })
      ).toThrow("Provide either `deployment-path` or `domain`, not both");
    });
  });
});

describe("when parsing the environments input", () => {
  describe("and it is a JSON array", () => {
    it("should parse the listed environments", () => {
      expect(parseEnvironments('["zone","today"]')).toEqual(["zone", "today"]);
    });
  });

  describe("and it is a comma list", () => {
    it("should parse and trim the environments", () => {
      expect(parseEnvironments("zone, org")).toEqual(["zone", "org"]);
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
    it("should throw", () => {
      expect(() => parseEnvironments('["zone","prod"]')).toThrow('Invalid environment "prod"');
    });
  });
});

describe("when resolving the namespace id", () => {
  let map: NamespaceMap;

  beforeEach(() => {
    map = { zone: "ns-zone" };
  });

  describe("and an explicit override is provided", () => {
    it("should return the override", () => {
      expect(resolveNamespace("org", map, "ns-override")).toBe("ns-override");
    });
  });

  describe("and a per-environment value is provided", () => {
    it("should return it", () => {
      expect(resolveNamespace("zone", map)).toBe("ns-zone");
    });
  });

  describe("and nothing is provided", () => {
    it("should throw, naming the org secret to set", () => {
      expect(() => resolveNamespace("org", {})).toThrow("CF_NS_ORG");
    });
  });
});

describe("when resolving KV targets for several environments", () => {
  it("should map each environment to its namespace id", () => {
    expect(resolveKvTargets(["zone", "today"], { zone: "ns-zone", today: "ns-today" })).toEqual([
      { environment: "zone", namespaceId: "ns-zone" },
      { environment: "today", namespaceId: "ns-today" },
    ]);
  });

  describe("and the environment list is empty", () => {
    it("should return no targets (stage)", () => {
      expect(resolveKvTargets([], {})).toEqual([]);
    });
  });
});

describe("when parsing the percentage", () => {
  describe("and the value is empty", () => {
    it("should default to 100", () => {
      expect(parsePercentage("")).toBe(100);
    });
  });

  describe("and the value is out of range", () => {
    it("should throw", () => {
      expect(() => parsePercentage("150")).toThrow('Invalid percentage "150"');
    });
  });

  describe("and the value is fractional", () => {
    it("should throw (percentages are integers)", () => {
      expect(() => parsePercentage("50.5")).toThrow('Invalid percentage "50.5"');
    });
  });
});

describe("when deriving the KV key from a target", () => {
  describe("and the target is path-based", () => {
    let target: DeploymentTarget;

    beforeEach(() => {
      target = { kind: "path", path: "auth" };
    });

    it("should use the path as the key", () => {
      expect(kvKeyForTarget(target)).toBe("auth");
    });
  });

  describe("and the target is domain-based", () => {
    let target: DeploymentTarget;

    beforeEach(() => {
      target = { kind: "domain", domain: "play.decentraland.org" };
    });

    it("should use the domain as the key", () => {
      expect(kvKeyForTarget(target)).toBe("play.decentraland.org");
    });
  });
});

describe("when building the rollout url for a target and environment", () => {
  describe("and the target is path-based", () => {
    it("should build a decentraland.<env>/<path> url", () => {
      expect(rolloutUrlForTarget({ kind: "path", path: "auth" }, "today")).toBe(
        "https://decentraland.today/auth"
      );
    });
  });

  describe("and the target is domain-based", () => {
    it("should build an https url for the domain", () => {
      expect(rolloutUrlForTarget({ kind: "domain", domain: "play.decentraland.org" }, "org")).toBe(
        "https://play.decentraland.org"
      );
    });
  });
});

describe("when reading the package.json from a folder", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-pkg-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("and the folder has a valid package.json", () => {
    beforeEach(() => {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "@dcl/auth-site", version: "1.2.3" })
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

    it("should return an empty object", () => {
      expect(readPackageJson(dir)).toEqual({});
    });
  });
});

describe("when checking a folder for index.html", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-idx-"));
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
