import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

/**
 * The composite wiring is interpreted by the runner, not by jest, so what it declares is
 * asserted here as data.
 *
 * This file replaces one that guarded a three-step split: resolve, build, deploy. The
 * split needed the version to cross a step boundary, and the only way across was
 * $GITHUB_ENV — job-wide and writable by anything the build runs. It also duplicated the
 * env block verbatim, and the single deliberate difference between the two copies broke a
 * deploy. One step has neither problem, and these assertions are what stop it growing back.
 */
const action = yaml.load(fs.readFileSync(path.join(__dirname, "..", "action.yml"), "utf8")) as {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  runs: { steps: Array<{ name: string; env?: Record<string, string> }> };
};

describe("when the action declares how it runs", () => {
  it("should do all of it in a single step", () => {
    expect(action.runs.steps).toHaveLength(1);
  });

  // The flag the old split needed. Anything the build ran could set it in $GITHUB_ENV and
  // make the deploy step return early, exit 0, and report a deploy that never happened.
  it("should have no stage flag to forge", () => {
    const declared = JSON.stringify(action.runs.steps[0].env ?? {});

    expect(declared).not.toContain("CDN_DEPLOY_STAGE");
    expect(declared).not.toContain("CDN_DEPLOY_VERSION");
  });

  it("should pass the build command to the action rather than splicing it into a run block", () => {
    expect(action.runs.steps[0].env).toHaveProperty("INPUT_BUILD-COMMAND");
    expect(JSON.stringify(action.runs.steps[0])).not.toContain("run: ${{ inputs.build-command }}");
  });
});

/**
 * The surface is the part a second team copies. Every input here has to earn its place:
 * the ones removed were either inert, unused by any caller, or actively misleading —
 * `force` could not force anything, and `base-version` was a way to reintroduce by hand
 * the stale-version bug the release anchor exists to prevent.
 */
describe("when the action declares its surface", () => {
  it("should expose only the inputs a caller needs", () => {
    expect(Object.keys(action.inputs).sort()).toEqual(
      [
        "broker-url",
        "build-command",
        "deployment-environments",
        "dist-path",
        "package-name",
        "percentage",
        "version",
      ].sort(),
    );
  });

  it("should pass every declared input to the action", () => {
    const env = JSON.stringify(action.runs.steps[0].env ?? {});
    for (const input of Object.keys(action.inputs)) {
      expect(env).toContain(`inputs.${input}`);
    }
  });
});
