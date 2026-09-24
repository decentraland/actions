import * as core from "@actions/core";
import * as github from "@actions/github";
import { folderHasIndexHtml, readInputs } from "./inputs";
import { computeVersion } from "./version";
import { resolveEnsurePlan } from "./plan";
import { uploadFolderToS3, writeCompletionMarker } from "./s3";
import { BrokerError, createBrokerClient, type BrokerClient, type RolloutResult } from "./broker";
import { createBrokeredCredentials } from "./credentials";
import { notifyRollout } from "./slack";
import { createObservability } from "./github";
import { ActionInputs, Environment, S3Action } from "./types";

async function run(): Promise<void> {
  const inputs = readInputs();
  const { packageName } = inputs;

  // commitVersion is reproducible from the commit (no run id), so a release run can locate
  // the dev-deployed bytes. `commit` lets a manual deploy target a specific commit's build;
  // otherwise it's the workflow's commit.
  const sha = inputs.commit || github.context.sha;
  const commitVersion = computeVersion({ baseVersion: inputs.baseVersion, sha });
  const targetVersion = inputs.version || commitVersion;

  const remoteFolder = `${packageName}/${targetVersion}`;
  const cdnUrl = `${inputs.cdnBaseUrl}/${packageName}/${targetVersion}`;
  const envs = inputs.environments;

  core.setOutput("version", targetVersion);
  core.setOutput("s3-path", remoteFolder);
  core.setOutput("cdn-url", cdnUrl);

  core.info(`package:      ${packageName}`);
  core.info(`version:      ${targetVersion}${targetVersion === commitVersion ? " (commit)" : ""}`);
  core.info(`environments: ${envs.length ? envs.join(", ") : "(stage only — no rollout)"}`);
  core.info(`cdn url:      ${cdnUrl}`);
  core.info(`broker:       ${inputs.brokerUrl}`);

  const broker = createBrokerClient({ baseUrl: inputs.brokerUrl, audience: inputs.oidcAudience });

  const observability = createObservability({
    enabled: inputs.createGithubDeployment,
    token: process.env.GITHUB_TOKEN,
    environments: envs,
    packageName,
    version: targetVersion,
    cdnUrl,
    sha: inputs.commit,
  });
  await observability.start();

  // Distinct from "skip": the summary must not claim "already in S3, nothing to do" for a
  // run that failed before the S3 step ran at all.
  let s3Action: S3Action | "not-attempted" = "not-attempted";
  try {
    if (inputs.distPath && inputs.requireIndex && !folderHasIndexHtml(inputs.distPath)) {
      throw new Error(
        `No index.html found at the root of "${inputs.distPath}". The build looks empty or ` +
          "misconfigured. Set `require-index: false` to deploy anyway.",
      );
    }

    // A pure repoint writes nothing, so it needs no credentials — and asking for them would
    // make a rollback depend on STS. Whether the bytes are really there is checked
    // authoritatively by the broker before it touches the rollout record.
    const needsWrite = !!(
      inputs.distPath ||
      inputs.sourceVersion ||
      inputs.copyFromCommit ||
      inputs.force
    );

    if (needsWrite) {
      const grant = await broker.requestCredentials({ packageName, version: targetVersion });
      const plan = resolveEnsurePlan({
        folderPresent: !!inputs.distPath,
        sourceVersion: inputs.sourceVersion,
        targetVersion,
        commitVersion,
        targetExists: grant.targetExists,
        force: inputs.force,
        copyFromCommit: inputs.copyFromCommit,
      });

      if (plan.s3 === "upload") {
        await uploadToCdn(inputs, broker, { packageName, targetVersion, remoteFolder, sha, grant });
        s3Action = "upload";
      } else if (plan.s3 === "copy") {
        await copyRelease(broker, {
          packageName,
          targetVersion,
          sourceVersion: plan.source as string,
        });
        s3Action = "copy";
      } else {
        core.info(`> ${remoteFolder} already in S3 — skipping upload/copy.`);
        s3Action = "skip";
      }
    } else {
      core.info("> Repoint only — no S3 write.");
      s3Action = "skip";
    }

    // Set only now, so the value reports what actually happened rather than what was
    // planned: an `if: always()` step reading it after a later failure learns whether the
    // bytes really landed.
    core.setOutput("mode", s3Action);

    if (envs.length === 0) {
      core.info("> Stage only: bytes are in S3, no rollout requested.");
    } else {
      const results = await rolloutEnvironments(broker, inputs, {
        packageName,
        targetVersion,
        envs,
      });
      await notifyEnvironments(inputs, results, packageName, targetVersion);
    }

    await observability.succeed();
    core.info(
      `✅ ${s3Action} ${packageName}@${targetVersion}` +
        (envs.length ? ` -> ${envs.join(", ")}` : " (staged, no rollout)"),
    );
  } catch (e) {
    await observability.fail();
    throw e;
  } finally {
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

async function uploadToCdn(
  inputs: ActionInputs,
  broker: BrokerClient,
  ctx: {
    packageName: string;
    targetVersion: string;
    remoteFolder: string;
    sha: string;
    grant: Awaited<ReturnType<BrokerClient["requestCredentials"]>>;
  },
): Promise<void> {
  const { grant, remoteFolder } = ctx;

  // Self-refreshing: the broker's session is 15 minutes, which is AssumeRole's floor, and
  // a large site can outlast it. Every part of a multipart upload is signed separately, so
  // swapping the key mid-upload is transparent.
  const credentials = createBrokeredCredentials({
    fetchGrant: async () =>
      (
        await broker.requestCredentials({
          packageName: ctx.packageName,
          version: ctx.targetVersion,
        })
      ).credentials,
    onRefresh: (expiresAt) =>
      core.debug(`deploy credentials refreshed, valid until ${expiresAt?.toISOString()}`),
  });

  await core.group(
    `Uploading ${inputs.distPath} -> s3://${grant.bucket}/${remoteFolder}`,
    async () => {
      const uploaded = await uploadFolderToS3({
        region: grant.region,
        bucket: grant.bucket,
        folder: inputs.distPath,
        remoteFolder,
        credentials,
      });

      // uploadDir resolves to [] for an empty folder rather than throwing; rolling out an
      // empty prefix would take the site down.
      if (uploaded.length === 0) {
        throw new Error(
          `Nothing was uploaded from "${inputs.distPath}" — the folder is empty. Check that the ` +
            "build ran and produced output.",
        );
      }
      core.info(`Uploaded ${uploaded.length} objects.`);

      // Written last, deliberately. Its presence is what makes the prefix eligible for a
      // rollout, so a crashed upload leaves a prefix the broker will refuse to publish.
      await writeCompletionMarker({
        region: grant.region,
        bucket: grant.bucket,
        remoteFolder,
        credentials,
        marker: {
          package: ctx.packageName,
          version: ctx.targetVersion,
          commit: ctx.sha,
          objectCount: uploaded.length,
          kind: "upload",
          completedAt: new Date().toISOString(),
          runId: process.env.GITHUB_RUN_ID,
        },
      });
      core.info("Wrote the completion marker.");
    },
  );
}

/**
 * Drives the broker's resumable copy to completion.
 *
 * No AWS credentials are involved: the copy happens inside S3, issued by the broker. The
 * loop exists because API Gateway caps a single call at 29 seconds and a site can be a few
 * thousand objects once the compressed variants are counted.
 */
async function copyRelease(
  broker: BrokerClient,
  ctx: { packageName: string; targetVersion: string; sourceVersion: string },
): Promise<void> {
  await core.group(`Releasing ${ctx.sourceVersion} -> ${ctx.targetVersion}`, async () => {
    let continuation: string | undefined;

    for (;;) {
      let progress;
      try {
        progress = await broker.release({
          packageName: ctx.packageName,
          version: ctx.targetVersion,
          sourceVersion: ctx.sourceVersion,
          continuation,
        });
      } catch (e) {
        // A release routinely races the commit build that produced its source, so this is
        // a wait rather than a failure.
        if (e instanceof BrokerError && e.code === "source_not_ready") {
          const waitSeconds = e.retryAfterSeconds ?? 10;
          core.info(`Source build not finished yet; waiting ${waitSeconds}s.`);
          await sleep(waitSeconds * 1000);
          continue;
        }
        throw e;
      }

      if (progress.complete) {
        core.info(`Copied ${progress.objectCount ?? progress.copied} objects.`);
        return;
      }
      core.info(`Copied ${progress.copied} objects so far, continuing…`);
      continuation = progress.continuation;
    }
  });
}

/**
 * One call per environment.
 *
 * Attempts every one and aggregates the failures rather than stopping at the first:
 * Cloudflare KV has no cross-namespace transaction, so a partial rollout is possible and
 * needs to be visible rather than hidden behind an abort.
 */
async function rolloutEnvironments(
  broker: BrokerClient,
  inputs: ActionInputs,
  ctx: { packageName: string; targetVersion: string; envs: Environment[] },
): Promise<RolloutResult[]> {
  const succeeded: RolloutResult[] = [];
  const failures: { environment: string; error: string }[] = [];

  await core.group(`Rolling out ${ctx.targetVersion} to ${ctx.envs.join(", ")}`, async () => {
    for (const environment of ctx.envs) {
      try {
        const result = await broker.rollout({
          packageName: ctx.packageName,
          version: ctx.targetVersion,
          environment,
          percentage: inputs.percentage,
          rolloutName: inputs.deploymentName,
        });
        succeeded.push(result);
        core.info(`${environment}: ${result.key} -> ${ctx.targetVersion} @ ${inputs.percentage}%`);
      } catch (e) {
        failures.push({ environment, error: describe(e) });
      }
    }
  });

  if (failures.length) {
    const already = succeeded.length
      ? ` Already updated: ${succeeded.map((r) => r.environment).join(", ")}.`
      : "";
    throw new Error(
      `Rollout failed for: ${failures.map((f) => f.environment).join(", ")}.${already} ` +
        `First error: ${failures[0].error}`,
    );
  }
  return succeeded;
}

/** Slack is observability, never a reason to fail a deploy that already landed. */
async function notifyEnvironments(
  inputs: ActionInputs,
  results: RolloutResult[],
  packageName: string,
  version: string,
): Promise<void> {
  if (!inputs.slackWebhook) return;
  for (const result of results) {
    try {
      await notifyRollout({
        webhookUrl: inputs.slackWebhook,
        // The broker returns the human-facing URL, since it is the thing that knows which
        // key the rollout landed on.
        url: result.url,
        rolloutName: result.rolloutName,
        percentage: result.percentage,
        prefix: packageName,
        version,
        onRetry: (message) => core.warning(message),
      });
    } catch (e) {
      core.warning(`Slack notification failed: ${describe(e)}`);
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
      ["Environments", s.environments.length ? s.environments.join(", ") : "(staged — no rollout)"],
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
    core.warning(`Could not write job summary: ${describe(e)}`);
  }
}

function describe(e: unknown): string {
  // The broker's code is its stable contract and names the thing to fix, so it leads.
  if (e instanceof BrokerError) return `[${e.code}] ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Turns a thrown error into a failed job. Exported so the suite can pin it: it is the only
 * thing that makes a broken deploy show up red, and a top-level `.catch` body is otherwise
 * unreachable from a test.
 */
export function reportFailure(e: unknown): void {
  core.setFailed(describe(e));
}

run().catch(reportFailure);

export { run };
