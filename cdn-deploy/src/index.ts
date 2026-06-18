import * as core from "@actions/core";
import * as github from "@actions/github";
import { folderHasIndexHtml, kvKeyForTarget, readInputs, rolloutUrlForTarget } from "./inputs";
import { computeVersion } from "./version";
import { resolveEnsurePlan } from "./plan";
import { copyFolderInS3, objectExists, uploadFolderToS3 } from "./s3";
import { patchRolloutInEnvironments } from "./cloudflare";
import { notifyRollout } from "./slack";
import { createObservability } from "./github";
import { S3Action } from "./types";

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
    environment: envs.join("+") || "stage",
    packageName,
    version: targetVersion,
    cdnUrl,
  });
  await observability.start();

  let s3Action: S3Action = "skip";
  try {
    // 1) Ensure the target bytes are in S3 (state-aware). Skipped entirely for a
    //    pure repoint (target named by the commit, no folder/source/force).
    const needsS3 =
      !!inputs.folder ||
      !!inputs.sourceVersion ||
      !!inputs.commit ||
      inputs.force ||
      targetVersion !== commitVersion;

    if (needsS3) {
      if (inputs.folder && inputs.requireIndex && !folderHasIndexHtml(inputs.folder)) {
        throw new Error(
          `No index.html found at the root of "${inputs.folder}". The build looks empty or ` +
            "misconfigured. Set `require-index: false` to deploy anyway."
        );
      }

      const targetExists = await objectExists({
        region: inputs.awsRegion,
        bucket: inputs.s3Bucket,
        key: `${remoteFolder}/index.html`,
      });
      const plan = resolveEnsurePlan({
        folderPresent: !!inputs.folder,
        sourceVersion: inputs.sourceVersion,
        targetVersion,
        commitVersion,
        targetExists,
        force: inputs.force,
      });
      s3Action = plan.s3;

      if (plan.s3 === "skip") {
        core.info(`> ${remoteFolder} already in S3 — skipping upload/copy.`);
      } else if (plan.s3 === "copy") {
        const sourceFolder = `${packageName}/${plan.source}`;
        await core.group(`Copying s3://${inputs.s3Bucket}/${sourceFolder} -> ${remoteFolder}`, async () => {
          const copied = await copyFolderInS3({
            region: inputs.awsRegion,
            bucket: inputs.s3Bucket,
            sourceFolder,
            targetFolder: remoteFolder,
          });
          core.info(`Copied ${copied} objects.`);
        });
      } else {
        await core.group(`Uploading ${inputs.folder} -> s3://${inputs.s3Bucket}/${remoteFolder}`, async () => {
          const uploaded = await uploadFolderToS3({
            region: inputs.awsRegion,
            bucket: inputs.s3Bucket,
            folder: inputs.folder,
            remoteFolder,
          });
          core.info(`Uploaded ${uploaded.length} files.`);
        });
      }
    } else {
      core.info("> Repoint only — no S3 operation.");
    }

    // 2) KV: repoint each environment, or stage (empty list -> no KV).
    if (envs.length === 0) {
      core.info("> Stage only: bytes are in S3, KV left unchanged.");
    } else {
      await core.group(`Setting rollout "${inputs.deploymentName}" on "${key}" for ${envs.join(", ")}`, async () => {
        await patchRolloutInEnvironments(
          { accountId: inputs.cloudflareAccountId, apiToken: inputs.cloudflareApiToken },
          inputs.kvTargets,
          {
            key,
            rolloutName: inputs.deploymentName,
            percentage: inputs.percentage,
            prefix: packageName,
            version: targetVersion,
            timestamp: Date.now(),
          }
        );
        core.info(`Repointed ${envs.join(", ")} -> ${targetVersion} @ ${inputs.percentage}%`);
      });

      // 3) Slack (non-fatal), one message per repointed environment.
      if (inputs.slackWebhook) {
        for (const env of envs) {
          try {
            await notifyRollout({
              webhookUrl: inputs.slackWebhook,
              url: rolloutUrlForTarget(inputs.target, env),
              rolloutName: inputs.deploymentName,
              percentage: inputs.percentage,
              prefix: packageName,
              version: targetVersion,
            });
          } catch (e) {
            core.warning(`Slack notification failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }

    core.setOutput("mode", s3Action);
    await observability.succeed();
    await writeSummary({
      s3Action,
      packageName,
      version: targetVersion,
      environments: envs,
      percentage: inputs.percentage,
      cdnUrl,
    });
    core.info(
      `✅ ${s3Action} ${packageName}@${targetVersion}` +
        (envs.length ? ` -> ${envs.join(", ")}` : " (staged, no KV)")
    );
  } catch (e) {
    await observability.fail();
    throw e;
  }
}

/** Best-effort GitHub job summary table (no-op outside Actions / on failure). */
async function writeSummary(s: {
  s3Action: S3Action;
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

run().catch((e) => {
  core.setFailed(e instanceof Error ? e.message : String(e));
});
