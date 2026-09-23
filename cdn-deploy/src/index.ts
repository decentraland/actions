import * as core from "@actions/core";
import * as github from "@actions/github";
import { folderHasIndexHtml, kvKeyForTarget, readInputs, rolloutUrlForTarget } from "./inputs";
import { computeVersion } from "./version";
import { resolveEnsurePlan } from "./plan";
import { copyFolderInS3, prefixExists, uploadFolderToS3 } from "./s3";
import { patchRolloutInEnvironments } from "./cloudflare";
import { notifyRollout } from "./slack";
import { createObservability } from "./github";
import { DeploymentTarget, Environment, S3Action } from "./types";

async function run(): Promise<void> {
  const inputs = readInputs();
  const { packageName } = inputs;

  // commitVersion is reproducible from the commit (no run id), so a release run
  // can locate the dev-deployed bytes. `commit` lets a manual deploy target a
  // specific commit's build; otherwise it's the workflow's commit.
  const sha = inputs.commit || github.context.sha;
  const commitVersion = computeVersion({ baseVersion: inputs.baseVersion, sha });
  const targetVersion = inputs.version || commitVersion;

  const remoteFolder = `${packageName}/${targetVersion}`;
  const cdnUrl = `${inputs.cdnBaseUrl}/${packageName}/${targetVersion}`;
  const key = kvKeyForTarget(inputs.target);
  const envs = inputs.environments;

  core.setOutput("version", targetVersion);
  core.setOutput("s3-path", remoteFolder);
  core.setOutput("cdn-url", cdnUrl);

  core.info(`package:      ${packageName}`);
  core.info(`version:      ${targetVersion}${targetVersion === commitVersion ? " (commit)" : ""}`);
  core.info(`kv key:       ${key}`);
  core.info(`environments: ${envs.length ? envs.join(", ") : "(stage only — no KV)"}`);
  core.info(`cdn url:      ${cdnUrl}`);

  const observability = createObservability({
    enabled: inputs.createGithubDeployment,
    token: process.env.GITHUB_TOKEN,
    environments: envs,
    packageName,
    version: targetVersion,
    cdnUrl,
    // Only the explicit override: passing the resolved sha unconditionally
    // would shadow the PR-head fallback, since GITHUB_SHA is always set.
    sha: inputs.commit,
  });
  await observability.start();

  // Distinct from "skip": the summary must not claim "already in S3, nothing
  // to do" for a run that failed before the S3 step ran at all.
  let s3Action: S3Action | "not-attempted" = "not-attempted";
  try {
    // 1) Ensure the target bytes are in S3 (state-aware).
    //
    // This runs on EVERY path, including a repoint that uploads nothing: the
    // point of the check is that the KV must never be pointed at a prefix that
    // isn't there. `resolveEnsurePlan` throws when the target is absent and
    // there is nothing legitimate to fill it with.
    if (inputs.distPath && inputs.requireIndex && !folderHasIndexHtml(inputs.distPath)) {
      throw new Error(
        `No index.html found at the root of "${inputs.distPath}". The build looks empty or ` +
          "misconfigured. Set `require-index: false` to deploy anyway.",
      );
    }

    const targetExists = await prefixExists({
      region: inputs.awsRegion,
      bucket: inputs.s3Bucket,
      prefix: remoteFolder,
    });
    const plan = resolveEnsurePlan({
      folderPresent: !!inputs.distPath,
      sourceVersion: inputs.sourceVersion,
      targetVersion,
      commitVersion,
      targetExists,
      force: inputs.force,
      copyFromCommit: inputs.copyFromCommit,
    });
    if (plan.s3 === "skip") {
      core.info(`> ${remoteFolder} already in S3 — skipping upload/copy.`);
      s3Action = "skip";
    } else if (plan.s3 === "copy") {
      const sourceFolder = `${packageName}/${plan.source}`;
      await core.group(
        `Copying s3://${inputs.s3Bucket}/${sourceFolder} -> ${remoteFolder}`,
        async () => {
          const copied = await copyFolderInS3({
            region: inputs.awsRegion,
            bucket: inputs.s3Bucket,
            sourceFolder,
            targetFolder: remoteFolder,
          });
          core.info(`Copied ${copied} objects.`);
        },
      );
      s3Action = "copy";
    } else {
      await core.group(
        `Uploading ${inputs.distPath} -> s3://${inputs.s3Bucket}/${remoteFolder}`,
        async () => {
          const uploaded = await uploadFolderToS3({
            region: inputs.awsRegion,
            bucket: inputs.s3Bucket,
            folder: inputs.distPath,
            remoteFolder,
          });
          // uploadDir resolves to [] for an empty folder rather than throwing;
          // repointing the KV at nothing would take the site down.
          if (uploaded.length === 0) {
            throw new Error(
              `Nothing was uploaded from "${inputs.distPath}" — the folder is empty. Check that ` +
                "the build ran and produced output.",
            );
          }
          core.info(`Uploaded ${uploaded.length} objects.`);
        },
      );
      s3Action = "upload";
    }

    // Set only now, so the value reports what the S3 step actually DID. Setting
    // it from the plan meant a failed upload still reported `mode: upload`, and
    // an `if: always()` step reading it would treat the bytes as live.
    core.setOutput("mode", s3Action);

    // 2) KV: repoint each environment, or stage (empty list -> no KV).
    if (envs.length === 0) {
      core.info("> Stage only: bytes are in S3, KV left unchanged.");
    } else {
      await core.group(
        `Setting rollout "${inputs.deploymentName}" on "${key}" for ${envs.join(", ")}`,
        async () => {
          await patchRolloutInEnvironments(
            {
              accountId: inputs.cloudflareAccountId,
              apiToken: inputs.cloudflareApiToken,
              onRetry: (message) => core.warning(message),
            },
            inputs.kvTargets,
            {
              key,
              rolloutName: inputs.deploymentName,
              percentage: inputs.percentage,
              prefix: packageName,
              version: targetVersion,
              timestamp: Date.now(),
            },
          );
          core.info(`Repointed ${envs.join(", ")} -> ${targetVersion} @ ${inputs.percentage}%`);
        },
      );

      // 3) Slack (non-fatal), one message per repointed environment.
      await notifyEnvironments(inputs, envs, targetVersion, packageName);
    }

    await observability.succeed();
    core.info(
      `✅ ${s3Action} ${packageName}@${targetVersion}` +
        (envs.length ? ` -> ${envs.join(", ")}` : " (staged, no KV)"),
    );
  } catch (e) {
    await observability.fail();
    throw e;
  } finally {
    // Written even on failure: a half-applied deploy is exactly when someone
    // needs to see what the S3 step did.
    await writeSummary({
      s3Action,
      packageName,
      version: targetVersion,
      environments: envs,
      percentage: inputs.percentage,
      cdnUrl,
    });
  }
}

/** Slack is observability, never a reason to fail a deploy that already landed. */
async function notifyEnvironments(
  inputs: {
    slackWebhook?: string;
    target: DeploymentTarget;
    deploymentName: string;
    percentage: number;
  },
  envs: Environment[],
  version: string,
  packageName: string,
): Promise<void> {
  if (!inputs.slackWebhook) return;
  for (const env of envs) {
    try {
      await notifyRollout({
        webhookUrl: inputs.slackWebhook,
        url: rolloutUrlForTarget(inputs.target, env),
        rolloutName: inputs.deploymentName,
        percentage: inputs.percentage,
        prefix: packageName,
        version,
        onRetry: (message) => core.warning(message),
      });
    } catch (e) {
      core.warning(`Slack notification failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Best-effort GitHub job summary table (no-op outside Actions / on failure). */
async function writeSummary(s: {
  s3Action: S3Action | "not-attempted";
  packageName: string;
  version: string;
  environments: string[];
  percentage: number;
  cdnUrl: string;
}): Promise<void> {
  try {
    const rows: string[][] = [
      ["S3", s.s3Action],
      ["Package", s.packageName],
      ["Version", s.version],
      ["Environments", s.environments.length ? s.environments.join(", ") : "(staged — no KV)"],
      ["Rollout", `${s.percentage}%`],
      ["CDN URL", s.cdnUrl],
    ];
    await core.summary
      .addHeading("CDN deploy", 3)
      .addTable([
        [
          { data: "Field", header: true },
          { data: "Value", header: true },
        ],
        ...rows,
      ])
      .write();
  } catch (e) {
    core.warning(`Could not write job summary: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Turn a thrown error into a failed job. Exported so the suite can pin it: it
 * is the only thing that makes a broken deploy show up red, and a top-level
 * `.catch` body is otherwise unreachable from a test.
 */
export function reportFailure(e: unknown): void {
  core.setFailed(e instanceof Error ? e.message : String(e));
}

run().catch(reportFailure);

export { run };
