import * as core from "@actions/core";
import * as github from "@actions/github";
import { folderHasIndexHtml, readInputs } from "./inputs";
import { computeVersion } from "./version";
import { resolveEnsurePlan } from "./plan";
import { uploadFolderToS3, writeCompletionMarker } from "./s3";
import { BrokerError, createBrokerClient, type BrokerClient, type RolloutResult } from "./broker";
import { createBrokeredCredentials } from "./credentials";
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
    const hasBytesToWrite = !!(inputs.distPath || inputs.sourceVersion || inputs.copyFromCommit);

    // `force` means "redo the upload or copy", so on a run with nothing to redo it is a
    // mistake rather than a modifier. Caught here, before a 15-minute write session is
    // minted for work that cannot happen.
    if (inputs.force && !hasBytesToWrite) {
      throw new Error(
        "`force` was set, but this run has no bytes to write: pass `dist-path`, `source-version` " +
          "or `copy-from-commit`. To repoint an environment at a version already in S3, drop `force`.",
      );
    }

    const needsWrite = hasBytesToWrite;

    if (needsWrite) {
      // Decided BEFORE any credential is requested, so the release path never asks for
      // one. It used to: `requestCredentials` ran unconditionally here, which meant every
      // release minted a 900-second write session over the tag prefix and then handed the
      // copy to the broker without ever using it. That session sat in the job for the rest
      // of the run — through the rollout, every later step in the job and every
      // dependency loaded into the same process — holding `s3:PutObject` over the prefix
      // the broker was about to publish. Anything that got hold of it could replace what
      // production serves, in place, with no rollout call and nothing to approve, which is
      // precisely what the immutability freeze exists to stop.
      //
      // `targetExists` is false because the broker no longer reports it: it refuses to
      // mint for a published version instead, and that refusal is handled below.
      const plan = resolveEnsurePlan({
        folderPresent: !!inputs.distPath,
        sourceVersion: inputs.sourceVersion,
        targetVersion,
        commitVersion,
        targetExists: false,
        force: inputs.force,
        copyFromCommit: inputs.copyFromCommit,
      });

      // A published version is immutable, and the broker refuses to write one rather than
      // trusting the caller to skip. That refusal is the authoritative "already deployed"
      // answer on both paths, so it is a skip and not a failure -- re-running a deploy
      // stays idempotent, it just cannot overwrite what is already live.
      const isAlreadyPublished = (e: unknown) =>
        e instanceof BrokerError && e.code === "version_already_published";

      const reportAlreadyPublished = (): S3Action => {
        // `force` means "write these bytes anyway", and a published version cannot be
        // written at all — so honouring the skip here would report success for a run that
        // did the opposite of what was asked.
        if (inputs.force) {
          throw new Error(
            `\`force\` was set, but ${packageName}@${targetVersion} is already published and its ` +
              "bytes are immutable — they may be what production is serving. Deploy a new version " +
              "instead of replacing a released one.",
          );
        }
        core.info(
          `> ${remoteFolder} is already published — skipping the S3 write. What the CDN serves ` +
            "for this version is what was published before, not what this run built.",
        );
        return "skip";
      };

      if (plan.s3 === "upload") {
        let grant;
        try {
          grant = await broker.requestCredentials({ packageName, version: targetVersion });
        } catch (e) {
          if (!isAlreadyPublished(e)) throw e;
          s3Action = reportAlreadyPublished();
        }

        // Deliberately outside the catch above. A refusal during a mid-upload credential
        // REFRESH must not be swallowed as "already published, nothing to do" -- that
        // happens when another run publishes the version while this one is still writing,
        // and reporting it as a skip would call a half-written prefix a success.
        if (grant) {
          await uploadToCdn(inputs, broker, {
            packageName,
            targetVersion,
            remoteFolder,
            sha,
            grant,
          });
          s3Action = "upload";
        }
      } else if (plan.s3 === "copy") {
        // No credentials at all: the copy is server-side and the broker writes the marker.
        try {
          await copyRelease(broker, {
            packageName,
            targetVersion,
            sourceVersion: plan.source as string,
          });
          s3Action = "copy";
        } catch (e) {
          if (!isAlreadyPublished(e)) throw e;
          s3Action = reportAlreadyPublished();
        }
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
      // The broker announces each rollout to Slack itself. It is the thing that writes
      // the KV record, so it is the only one that knows a rollout happened -- this job
      // dying here used to mean a deploy went live unannounced.
      await rolloutEnvironments(broker, inputs, { packageName, targetVersion, envs });
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
 * How far the resumable copy is allowed to go before the action gives up.
 *
 * A release of the largest site is a handful of calls; hundreds means something is wrong.
 * The source wait is generous because it is legitimately waiting on another workflow, but
 * it is not unbounded -- a source build that failed will never land, and burning the job's
 * whole timeout reports "timed out" instead of naming the real cause.
 */
export const RELEASE_LIMITS = {
  maxCalls: 300,
  maxStalls: 3,
  maxSourceWaitMs: 30 * 60_000,
};

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
  limits: typeof RELEASE_LIMITS = RELEASE_LIMITS,
): Promise<void> {
  await core.group(`Releasing ${ctx.sourceVersion} -> ${ctx.targetVersion}`, async () => {
    let continuation: string | undefined;
    let calls = 0;
    let waitedMs = 0;
    let lastCopied = -1;
    let stalls = 0;

    for (;;) {
      // Bounded on three axes, because every one of them has hung a job: too many calls,
      // too long waiting for a source that will never land, and a broker that keeps
      // answering "not done" without getting further.
      // Counts copy attempts only. Source waits have their own budget below -- sharing
      // one meant a broker sending a short Retry-After burned the call cap in minutes and
      // then reported "the copy did not finish", naming the wrong thing entirely.
      // `>=`, checked before the call that would exceed it: `>` let a 301st call through
      // and then reported it as 300.
      if (calls >= limits.maxCalls) {
        throw new Error(
          `The release copy did not finish after ${limits.maxCalls} calls. Something is wrong ` +
            "with the broker or the source prefix; check the run log and retry.",
        );
      }

      let progress;
      try {
        calls++;
        progress = await broker.release({
          packageName: ctx.packageName,
          version: ctx.targetVersion,
          sourceVersion: ctx.sourceVersion,
          continuation,
        });
      } catch (e) {
        // A release routinely races the commit build that produced its source, so this is
        // a wait rather than a failure -- but only for as long as that build could
        // plausibly still be running.
        if (e instanceof BrokerError && e.code === "source_not_ready") {
          if (waitedMs >= limits.maxSourceWaitMs) {
            throw new Error(
              `The build being released (${ctx.sourceVersion}) still has not finished after ` +
                `${Math.round(limits.maxSourceWaitMs / 60_000)} minutes. It most likely failed — check that ` +
                "workflow rather than waiting on this one.",
            );
          }
          // A broker sending Retry-After: 0 would otherwise spin.
          const waitSeconds = Math.max(e.retryAfterSeconds ?? 10, 1);
          core.info(`Source build not finished yet; waiting ${waitSeconds}s.`);
          await sleep(waitSeconds * 1000);
          waitedMs += waitSeconds * 1000;
          calls--; // it never got as far as copying anything
          continue;
        }
        throw e;
      }

      if (progress.complete) {
        core.info(`Copied ${progress.objectCount ?? progress.copied} objects.`);
        return;
      }

      // "Not done" with nothing to resume from would restart the copy every iteration,
      // with no pause between attempts.
      if (!progress.continuation) {
        throw new Error(
          "The broker reported the release copy as unfinished but gave nothing to resume from. " +
            "Retry the job; if it persists the broker needs attention.",
        );
      }

      // Same token and no new objects means it is not getting anywhere.
      stalls =
        progress.copied > lastCopied || progress.continuation !== continuation ? 0 : stalls + 1;
      if (stalls >= limits.maxStalls) {
        throw new Error(
          `The release copy stopped making progress at ${progress.copied} objects. Retry the job; ` +
            "if it persists the broker needs attention.",
        );
      }

      lastCopied = progress.copied;
      continuation = progress.continuation;
      core.info(`Copied ${progress.copied} objects so far, continuing…`);
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
