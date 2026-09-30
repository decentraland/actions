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
    expect(() => assertSupportedNode("v18.20.4")).toThrow(/needs Node 24 or newer/);
  });

  it("should name the version it found, so the log says what to change", () => {
    expect(() => assertSupportedNode("v18.20.4")).toThrow(/v18\.20\.4/);
  });

  it("should say where the version comes from, since it is not set here", () => {
    expect(() => assertSupportedNode("v18.20.4")).toThrow(/setup-node/);
  });

  it("should refuse a version string it cannot read rather than assume it is fine", () => {
    expect(() => assertSupportedNode("not-a-version")).toThrow(/needs Node/);
  });
});

describe("when the job's node is new enough", () => {
  it.each([["v24.0.0"], ["v24.18.0"], ["v25.1.0"]])("should accept %s", (version) => {
    expect(() => assertSupportedNode(version as string)).not.toThrow();
  });

  it("should accept the node actually running this suite", () => {
    expect(() => assertSupportedNode()).not.toThrow();
  });
});

/**
 * Three places state the minimum and nothing else would notice them drifting: the constant
 * the check uses, the `engines` field that documents it, and the `.nvmrc` CI builds with.
 * A bundle built on 24 while the check allows 20 is the failure this guard exists to stop.
 */
describe("when the supported node version is declared", () => {
  it("should match engines.node in package.json", () => {
    const engines = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).engines;

    expect(engines.node).toBe(`>=${MINIMUM_NODE_MAJOR}`);
  });

  it("should match the .nvmrc CI builds with", () => {
    const nvmrc = fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim();

    expect(Number.parseInt(nvmrc, 10)).toBe(MINIMUM_NODE_MAJOR);
  });
});
