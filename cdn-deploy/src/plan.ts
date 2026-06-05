import { computeVersion } from "./version";
import { DeployPlan } from "./types";

/**
 * Decide what the action does from the inputs present. Pure and testable.
 *
 * - `source-version` set        -> redeploy (copy S3 objects, no rebuild)
 * - else `folder` present       -> deploy (upload the built folder)
 * - else `version` set          -> repoint (move the KV pointer only)
 * - else                        -> error
 *
 * The target version is the explicit `version` input when given (e.g. a release
 * tag), otherwise the computed deterministic snapshot. When there is no folder
 * to derive a base version from, an explicit `version` is required.
 */
export function resolvePlan(opts: {
  folderPresent: boolean;
  sourceVersion?: string;
  explicitVersion?: string;
  packageNameInput?: string;
  packageJson: { name?: string; version?: string };
  runId: string | number;
  sha: string;
}): DeployPlan {
  const packageName = opts.packageNameInput || opts.packageJson.name;
  if (!packageName) {
    throw new Error(
      "Unable to resolve package name. Set the `package-name` input or add a " +
        '"name" to the built folder\'s package.json.'
    );
  }

  const computeTarget = () =>
    computeVersion({
      baseVersion: opts.packageJson.version || "0.0.0",
      runId: opts.runId,
      sha: opts.sha,
    });

  if (opts.sourceVersion) {
    const version = opts.explicitVersion || (opts.folderPresent ? computeTarget() : undefined);
    if (!version) {
      throw new Error(
        "Redeploy requires a target `version` (e.g. the release tag) when no `folder` is provided."
      );
    }
    return { mode: "redeploy", packageName, version, sourceVersion: opts.sourceVersion };
  }

  if (opts.folderPresent) {
    return { mode: "deploy", packageName, version: opts.explicitVersion || computeTarget() };
  }

  if (opts.explicitVersion) {
    return { mode: "repoint", packageName, version: opts.explicitVersion };
  }

  throw new Error(
    "Nothing to do: provide `folder` (deploy), `source-version` (redeploy), or `version` (repoint)."
  );
}
