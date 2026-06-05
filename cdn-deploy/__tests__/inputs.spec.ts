import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isEnvironment,
  kvKeyForTarget,
  parsePercentage,
  readPackageJson,
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

describe("when resolving the deployment target", () => {
  describe("and a path is provided with a valid environment", () => {
    it("should return a path target carrying the environment", () => {
      expect(resolveTarget({ path: "auth", environment: "zone" })).toEqual({
        kind: "path",
        path: "auth",
        environment: "zone",
      });
    });
  });

  describe("and a domain is provided with a valid environment", () => {
    it("should return a domain target carrying the environment", () => {
      expect(resolveTarget({ domain: "play.decentraland.org", environment: "org" })).toEqual({
        kind: "domain",
        domain: "play.decentraland.org",
        environment: "org",
      });
    });
  });

  describe("and both path and domain are provided", () => {
    it("should throw asking for exactly one", () => {
      expect(() => resolveTarget({ path: "auth", domain: "x.org", environment: "zone" })).toThrow(
        "Provide exactly one of `deployment-path` or `domain`"
      );
    });
  });

  describe("and neither path nor domain is provided", () => {
    it("should throw asking for exactly one", () => {
      expect(() => resolveTarget({ environment: "zone" })).toThrow(
        "Provide exactly one of `deployment-path` or `domain`"
      );
    });
  });

  describe("and the environment is invalid", () => {
    it("should throw listing the valid environments", () => {
      expect(() => resolveTarget({ path: "auth", environment: "prod" })).toThrow(
        'Invalid deployment-environment "prod". Expected one of: zone, today, org'
      );
    });
  });
});

describe("when resolving the namespace id", () => {
  let map: NamespaceMap;

  beforeEach(() => {
    map = { zone: "ns-zone", today: "ns-today", org: "ns-org" };
  });

  describe("and an explicit override is provided", () => {
    it("should return the override regardless of the environment", () => {
      expect(resolveNamespace("zone", map, "ns-override")).toBe("ns-override");
    });
  });

  describe("and no override is provided", () => {
    it("should return the namespace for the environment", () => {
      expect(resolveNamespace("org", map)).toBe("ns-org");
    });
  });

  describe("and there is no namespace configured for the environment", () => {
    it("should throw naming the missing per-environment input", () => {
      expect(() => resolveNamespace("today", { zone: "ns-zone" })).toThrow(
        "cloudflare-namespace-today"
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

  describe("and the value is a valid number", () => {
    it("should return the parsed number", () => {
      expect(parsePercentage("50")).toBe(50);
    });
  });

  describe("and the value is out of range", () => {
    it("should throw for a value above 100", () => {
      expect(() => parsePercentage("150")).toThrow('Invalid percentage "150"');
    });
  });

  describe("and the value is not a number", () => {
    it("should throw a invalid percentage error", () => {
      expect(() => parsePercentage("abc")).toThrow('Invalid percentage "abc"');
    });
  });
});

describe("when deriving the KV key from a target", () => {
  describe("and the target is path-based", () => {
    let target: DeploymentTarget;

    beforeEach(() => {
      target = { kind: "path", path: "auth", environment: "zone" };
    });

    it("should use the path as the key", () => {
      expect(kvKeyForTarget(target)).toBe("auth");
    });
  });

  describe("and the target is domain-based", () => {
    let target: DeploymentTarget;

    beforeEach(() => {
      target = { kind: "domain", domain: "play.decentraland.org", environment: "org" };
    });

    it("should use the domain as the key", () => {
      expect(kvKeyForTarget(target)).toBe("play.decentraland.org");
    });
  });
});

describe("when building the rollout url for a target", () => {
  describe("and the target is path-based", () => {
    let target: DeploymentTarget;

    beforeEach(() => {
      target = { kind: "path", path: "auth", environment: "today" };
    });

    it("should build a decentraland.<env>/<path> url", () => {
      expect(rolloutUrlForTarget(target)).toBe("https://decentraland.today/auth");
    });
  });

  describe("and the target is domain-based", () => {
    let target: DeploymentTarget;

    beforeEach(() => {
      target = { kind: "domain", domain: "play.decentraland.org", environment: "org" };
    });

    it("should build an https url for the domain", () => {
      expect(rolloutUrlForTarget(target)).toBe("https://play.decentraland.org");
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
