import * as fs from "fs";
import * as path from "path";

/**
 * The composite wiring is not reachable from the unit tests -- action.yml is interpreted by
 * the runner, not by jest -- so the one thing that broke it is asserted here as text.
 *
 * The resolve stage runs BEFORE the build. Handing it `dist-path` makes `readInputs`
 * validate a folder that cannot exist yet, which failed the whole action one step before
 * it would have resolved the version.
 */
const action = fs.readFileSync(path.join(__dirname, "..", "action.yml"), "utf8");

function envOfStep(name: string): string {
  const start = action.indexOf(`- name: ${name}`);
  expect(start).toBeGreaterThan(-1);
  const next = action.indexOf("\n    - name:", start + 1);
  return action.slice(start, next === -1 ? undefined : next);
}

describe("when the action resolves the version before building", () => {
  it("should not hand the resolve stage a dist-path that cannot exist yet", () => {
    expect(envOfStep("Resolve the deploy version")).not.toContain("INPUT_DIST-PATH:");
  });

  it("should still mark it as the resolve stage", () => {
    expect(envOfStep("Resolve the deploy version")).toContain("CDN_DEPLOY_STAGE: resolve");
  });

  it("should give the deploy stage the dist-path, since the bytes exist by then", () => {
    expect(envOfStep("Deploy to CDN and set rollout")).toContain("INPUT_DIST-PATH:");
  });

  // Both guarded steps are skipped when the caller builds for itself and passes `version`.
  it("should run the resolve and build steps only when a build-command is given", () => {
    for (const step of ["Resolve the deploy version", "Build"]) {
      expect(envOfStep(step)).toContain("inputs.build-command != ''");
    }
  });
});
