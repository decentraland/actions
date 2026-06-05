import * as core from "@actions/core";
import * as github from "@actions/github";
import { kvKeyForTarget, readInputs, readPackageJson, rolloutUrlForTarget } from "./inputs";
import { computeVersion } from "./version";
import { uploadFolderToS3 } from "./s3";
import { createCloudflareKV, patchRolloutInKV, rolloutHasVersion } from "./cloudflare";
import { notifyRollout } from "./slack";
import { createObservability } from "./github";

async function run(): Promise<void> {
  const inputs = readInputs();

  // package name + base version come from the built folder's package.json,
  // matching how oddish ran with `cwd: ./dist`. The whole runtime contract
  // hinges on `prefix === packageName`.
  const pkg = readPackageJson(inputs.folder);
  const packageName = inputs.packageName || pkg.name;
  if (!packageName) {
    throw new Error(
      `Unable to resolve package name. Set the \`package-name\` input or add a "name" to ${inputs.folder}/package.json.`
    );
  }

  const isRepoint = !!inputs.version;
  const version =
    inputs.version ||
    computeVersion({
      baseVersion: pkg.version || "0.0.0",
      runId: github.context.runId,
      sha: github.context.sha,
    });

  const remoteFolder = `${packageName}/${version}`;
  const cdnUrl = `${inputs.cdnBaseUrl}/${packageName}/${version}`;

  core.setOutput("version", version);
  core.setOutput("s3-path", remoteFolder);
  core.setOutput("cdn-url", cdnUrl);

  const key = kvKeyForTarget(inputs.target);
  core.info(`package:      ${packageName}`);
  core.info(`version:      ${version}${isRepoint ? " (repoint — skipping upload)" : ""}`);
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
    // 1) Upload to S3 (skipped when re-pointing to an already-uploaded version).
    if (isRepoint) {
      core.info("> Skipping S3 upload (version input provided).");
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
    core.info(`✅ Deployed ${packageName}@${version} to ${inputs.target.environment}`);
  } catch (e) {
    await observability.fail();
    throw e;
  }
}

run().catch((e) => {
  core.setFailed(e instanceof Error ? e.message : String(e));
});
