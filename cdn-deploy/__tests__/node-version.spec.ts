import * as fs from "fs";
import * as path from "path";
import { MINIMUM_NODE_MAJOR, assertSupportedNode } from "../src/index";

const root = path.join(__dirname, "..");

/**
 * The action runs as `node "$GITHUB_ACTION_PATH/dist/index.js"`, and that `node` comes from
 * whatever the caller's `actions/setup-node` put on PATH — not from anything this
 * repository controls. `engines` is advisory for a bare `node` invocation, so without this
 * the bundle runs on an older runtime and fails wherever a dependency first reaches for a
 * newer API, naming a library instead of the cause.
 */
describe("when the job's node is older than the bundle needs", () => {
  it("should refuse before doing any work", () => {
    expect(() => assertSupportedNode("v18.20.4")).toThrow(/needs Node 22 or newer/);
  });

  it("should name the version it found, so the log says what to change", () => {
    expect(() => assertSupportedNode("v18.20.4")).toThrow(/v18\.20\.4/);
  });

  it("should say where the version comes from, since it is not set here", () => {
    expect(() => assertSupportedNode("v18.20.4")).toThrow(/setup-node/);
  });

  /**
   * A job that only repoints a version runs no build, so it runs no `actions/setup-node`
   * and gets the runner's own node — 22 on ubuntu-latest. The floor has to sit below
   * whatever a caller ends up with when they never chose one.
   */
  it("should accept the runner's own node, which a build-less job does not choose", () => {
    expect(() => assertSupportedNode("v22.23.2")).not.toThrow();
  });

  it("should refuse a version string it cannot read rather than assume it is fine", () => {
    expect(() => assertSupportedNode("not-a-version")).toThrow(/needs Node/);
  });
});

describe("when the job's node is new enough", () => {
  it.each([["v22.23.2"], ["v24.18.0"], ["v25.1.0"]])("should accept %s", (version) => {
    expect(() => assertSupportedNode(version as string)).not.toThrow();
  });

  it("should accept the node actually running this suite", () => {
    expect(() => assertSupportedNode()).not.toThrow();
  });
});

/**
 * `engines`/`.nvmrc` state what you need to develop this package; `MINIMUM_NODE_MAJOR`
 * states what the emitted bundle needs to execute. They are different numbers, and the
 * only relationship that has to hold is the one asserted here.
 */
describe("when the supported node version is declared", () => {
  it("should not demand the build toolchain's version at runtime", () => {
    const engines = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).engines;
    const buildMajor = Number.parseInt(engines.node.match(/\d+/)![0], 10);

    expect(MINIMUM_NODE_MAJOR).toBeLessThanOrEqual(buildMajor);
  });

  // Anything the bundle is built with must be able to run it.
  it("should be satisfied by the version CI builds with", () => {
    const nvmrc = Number.parseInt(fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim(), 10);

    expect(nvmrc).toBeGreaterThanOrEqual(MINIMUM_NODE_MAJOR);
  });
});
