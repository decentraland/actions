import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  folderHasIndexHtml,
  kvKeyForTarget,
  readInputs,
  readPackageJson,
  rolloutUrlForTarget,
} from "./inputs";
import { resolvePlan } from "./plan";
import { copyFolderInS3, uploadFolderToS3 } from "./s3";
import { createCloudflareKV, patchRolloutInKV, rolloutHasVersion } from "./cloudflare";
import { notifyRollout } from "./slack";
import { createObservability } from "./github";

async function run(): Promise<void> {
  const inputs = readInputs();

  // package name + base version come from the built folder's package.json,
  // matching how oddish ran with `cwd: ./dist`. The whole runtime contract
  // hinges on `prefix === packageName`.
  const pkg = inputs.folder ? readPackageJson(inputs.folder) : {};
  const plan = resolvePlan({
    folderPresent: !!inputs.folder,
    sourceVersion: inputs.sourceVersion,
    explicitVersion: inputs.version,
    packageNameInput: inputs.packageName,
    packageJson: pkg,
    runId: github.context.runId,
    sha: github.context.sha,
  });

  const { packageName, version } = plan;
  const remoteFolder = `${packageName}/${version}`;
  const cdnUrl = `${inputs.cdnBaseUrl}/${packageName}/${version}`;

  core.setOutput("version", version);
  core.setOutput("s3-path", remoteFolder);
  core.setOutput("cdn-url", cdnUrl);
  core.setOutput("mode", plan.mode);

  const key = kvKeyForTarget(inputs.target);
  core.info(`mode:         ${plan.mode}`);
  core.info(`package:      ${packageName}`);
  core.info(`version:      ${version}`);
  if (plan.sourceVersion) core.info(`source:       ${plan.sourceVersion}`);
  core.info(`environment:  ${inputs.target.environment}`);
  core.info(`kv key:       ${key} (namespace ${inputs.namespaceId})`);
  core.info(`cdn url:      ${cdnUrl}`);

  const observability = createObservability({
    enabled: inputs.createGithubDeployment,
    token: process.env.GITHUB_TOKEN,
    environment: inputs.target.environment,
    packageName,
    version,
    cdnUrl,
  });

  await observability.start();

  try {
    // 1) Put the assets in place at <packageName>/<version>/ for this mode.
    if (plan.mode === "deploy") {
      // Fail fast on an empty / misconfigured build rather than publishing a
      // broken site and pointing the CDN at it.
      if (inputs.requireIndex && !folderHasIndexHtml(inputs.folder)) {
        throw new Error(
          `No index.html found at the root of "${inputs.folder}". The build looks empty or ` +
            "misconfigured. Set `require-index: false` to deploy anyway."
        );
      }
      await core.group(`Uploading ${inputs.folder} -> s3://${inputs.s3Bucket}/${remoteFolder}`, async () => {
        const uploaded = await uploadFolderToS3({
          region: inputs.awsRegion,
          bucket: inputs.s3Bucket,
          folder: inputs.folder,
          remoteFolder,
        });
        core.info(`Uploaded ${uploaded.length} files.`);
      });
    } else if (plan.mode === "redeploy") {
      const sourceFolder = `${packageName}/${plan.sourceVersion}`;
      if (plan.sourceVersion === version) {
        core.info(`> Source and target version match (${version}); skipping S3 copy.`);
      } else {
        await core.group(`Copying s3://${inputs.s3Bucket}/${sourceFolder} -> ${remoteFolder}`, async () => {
          const copied = await copyFolderInS3({
            region: inputs.awsRegion,
            bucket: inputs.s3Bucket,
            sourceFolder,
            targetFolder: remoteFolder,
          });
          core.info(`Copied ${copied} objects.`);
        });
      }
    } else {
      core.info("> Repoint mode: no S3 operation, only moving the KV pointer.");
    }

    // 2) Patch the Cloudflare KV rollout record (read-modify-write).
    const kv = createCloudflareKV({
      accountId: inputs.cloudflareAccountId,
      apiToken: inputs.cloudflareApiToken,
      namespaceId: inputs.namespaceId,
    });

    await core.group(`Setting rollout "${inputs.deploymentName}" on KV key "${key}"`, async () => {
      await patchRolloutInKV(kv, {
        key,
        rolloutName: inputs.deploymentName,
        percentage: inputs.percentage,
        prefix: packageName,
        version,
        timestamp: Date.now(),
      });

      // Best-effort read-after-write (KV is eventually consistent — informational only).
      const visible = await rolloutHasVersion(kv, {
        key,
        rolloutName: inputs.deploymentName,
        version,
      });
      if (visible) {
        core.info(`Rollout confirmed: ${version} @ ${inputs.percentage}%`);
      } else {
        core.warning(
          "Rollout write reported success but the version is not yet visible on read-back " +
            "(Cloudflare KV is eventually consistent). This is usually transient."
        );
      }
    });

    // 3) Slack notification (non-fatal).
    if (inputs.slackWebhook) {
      try {
        await notifyRollout({
          webhookUrl: inputs.slackWebhook,
          url: rolloutUrlForTarget(inputs.target),
          rolloutName: inputs.deploymentName,
          percentage: inputs.percentage,
          prefix: packageName,
          version,
        });
      } catch (e) {
        core.warning(`Slack notification failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await observability.succeed();
    await writeSummary({
      mode: plan.mode,
      packageName,
      version,
      sourceVersion: plan.sourceVersion,
      environment: inputs.target.environment,
      percentage: inputs.percentage,
      cdnUrl,
    });
    core.info(`✅ Deployed ${packageName}@${version} to ${inputs.target.environment}`);
  } catch (e) {
    await observability.fail();
    throw e;
  }
}

/** Best-effort GitHub job summary table (no-op outside Actions / on failure). */
async function writeSummary(s: {
  mode: string;
  packageName: string;
  version: string;
  sourceVersion?: string;
  environment: string;
  percentage: number;
  cdnUrl: string;
}): Promise<void> {
  try {
    const rows: string[][] = [
      ["Mode", s.mode],
      ["Package", s.packageName],
      ["Version", s.version],
      ...(s.sourceVersion ? [["Source version", s.sourceVersion]] : []),
      ["Environment", s.environment],
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
