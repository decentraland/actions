import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  DEFAULT_CDN_BASE_URL,
  DEFAULT_ROLLOUT_NAME,
  folderHasIndexHtml,
  readInputs,
} from "./inputs";
import { computeVersion, resolveBaseVersion } from "./version";
import { uploadFolderToS3, writeCompletionMarker } from "./s3";
import { BrokerError, createBrokerClient, type BrokerClient, type RolloutResult } from "./broker";
import { createBrokeredCredentials } from "./credentials";
import { createObservability, latestReleaseVersion } from "./github";
import { ActionInputs, DEFAULT_OIDC_AUDIENCE, Environment, S3Action } from "./types";
import * as fs from "fs";
import { spawn } from "child_process";

/**
 * Put the resolved version where the build will look for it.
 *
 * Deliberately narrow: it rewrites `version` and nothing else, preserving the rest of the
 * file byte for byte apart from re-indentation, because this runs against a checkout the
 * later steps still use.
 */
function writePackageVersion(version: string): void {
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    pkg.version = version;
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  } catch (error) {
    core.warning(
      `Could not write the version into package.json (${error instanceof Error ? error.message : String(error)}). ` +
        "A build that reads its asset base URL from package.json will use the stale value; " +
        "read CDN_DEPLOY_VERSION instead.",
    );
  }
}

/**
 * Run the caller's build, with the settled version already in the environment.
 *
 * Spawned rather than interpolated into a `run:` block. As a composite step the command was
 * spliced into the generated script at expansion time, so a caller writing
 * `build-command: npm run build -- --tag ${{ github.event.pull_request.title }}` handed a
 * title containing shell metacharacters straight to bash. As an argv string it is data.
 *
 * `-e -o pipefail` because a build is usually a pipeline and a failure in the middle of one
 * must not be reported as success. Output is streamed rather than buffered so a long build
 * shows progress, and grouped so it stays collapsible in the log.
 */
async function runBuild(command: string): Promise<void> {
  await core.group(`Build: ${command}`, async () => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("bash", ["-e", "-o", "pipefail", "-c", command], { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) return resolve();
        reject(
          new Error(
            signal
              ? `The build was killed by ${signal}: \`${command}\`.`
              : `The build failed with exit code ${code}: \`${command}\`.`,
          ),
        );
      });
    });
  });
}

/**
 * The lowest node this action's bundle is built and tested against.
 *
 * Must match `engines.node` in package.json and `.nvmrc`; a test asserts the three agree,
 * because nothing else would notice them drifting.
 */
export const MINIMUM_NODE_MAJOR = 24;

/**
 * Refuse a runtime older than the bundle was built for.
 *
 * The action runs as `node "$GITHUB_ACTION_PATH/dist/index.js"`, and that `node` resolves
 * from PATH -- so it is whatever version the caller's `actions/setup-node` installed, not
 * anything this repository controls. `engines` is not enforced for a bare `node`
 * invocation, so a job pinning an older node runs this bundle anyway and finds out when
 * some dependency reaches for an API that is not there. That failure names a library, not
 * the cause.
 *
 * Checked first, before inputs, so the message is not buried under a validation error.
 */
export function assertSupportedNode(version: string = process.version): void {
  const major = Number.parseInt(version.replace(/^v/, ""), 10);

  if (!Number.isFinite(major) || major < MINIMUM_NODE_MAJOR) {
    throw new Error(
      `This action needs Node ${MINIMUM_NODE_MAJOR} or newer; this job is running ${version}. ` +
        "The version comes from whatever `actions/setup-node` put on PATH, so raise " +
        `\`node-version\` in the job that calls this action — for example \`node-version: ${MINIMUM_NODE_MAJOR}.x\`.`,
    );
  }
}

async function run(): Promise<void> {
  assertSupportedNode();

  const inputs = readInputs();
  const { packageName } = inputs;

  // `commit` lets a manual deploy target a specific commit's build; otherwise it's the
  // workflow's commit.
  // The workflow's own commit. There used to be a `commit` input for "deploy this other
  // commit's build", which stopped being possible once the run id became part of the
  // version -- a past build's version cannot be reconstructed from its sha alone.
  const sha = github.context.sha;

  // Lazy, deliberately. Computing it eagerly meant every run had to resolve a base
  // version, including a promotion that supplies `version` and checks nothing out — which
  // died in readInputs before it ever reached the broker.
  // Still lazy, and now async: resolving the base means asking GitHub for the newest
  // release. A promotion supplies `version` and checks nothing out, so it must not pay for
  // that call -- eagerly resolving is what used to kill those runs inside readInputs.
  let resolved: string | undefined;
  const commitVersion = async (): Promise<string> => {
    if (resolved) return resolved;

    // The newest release anchors the base; package.json is only a floor. package.json
    // alone is not enough: it is `0.0.1` in repositories serving 0.69.x, because oddish
    // derived the version from the registry and nothing ever wrote it back.
    const baseVersion = resolveBaseVersion({
      packageVersion: inputs.packageVersion,
      latestRelease: await latestReleaseVersion({ token: process.env.GITHUB_TOKEN }),
    });

    resolved = computeVersion({ baseVersion, sha, runId: String(github.context.runId) });
    core.info(`base version:  ${baseVersion}`);
    return resolved;
  };

  // One process resolves it and one process uses it, so the version never leaves this
  // scope. It used to cross a step boundary through $GITHUB_ENV, which also meant a second
  // invocation in the same job silently inherited the first one's version.
  const targetVersion = inputs.version || (await commitVersion());

  const remoteFolder = `${packageName}/${targetVersion}`;
  const cdnUrl = `${DEFAULT_CDN_BASE_URL}/${packageName}/${targetVersion}`;
  const envs = inputs.environments;

  core.setOutput("version", targetVersion);
  core.setOutput("s3-path", remoteFolder);
  core.setOutput("cdn-url", cdnUrl);

  core.info(`package:      ${packageName}`);
  core.info(`version:      ${targetVersion}${inputs.version ? "" : " (commit)"}`);
  core.info(`environments: ${envs.length ? envs.join(", ") : "(stage only — no rollout)"}`);
  core.info(`cdn url:      ${cdnUrl}`);
  core.info(`broker:       ${inputs.brokerUrl}`);

  // The build runs here, between settling the version and uploading, because every
  // Decentraland site bakes its asset base URL from the version at build time: a build that
  // starts before the version is known emits HTML pointing at a prefix nothing was ever
  // uploaded to.
  //
  // In-process rather than as a separate composite step. The step split needed the version
  // to cross a boundary, and the only way across was $GITHUB_ENV -- which is job-wide and
  // writable by anything the build runs, so a postinstall could set the stage flag and turn
  // the deploy into a green no-op. Here the version is a local variable and there is no
  // flag to forge.
  if (inputs.buildCommand) {
    // Exported for builds that read it, and written into package.json because that is where
    // every site's prebuild reads it from today. The same value in two places the build
    // already looks, so no site has to change to be deployed correctly; those prebuilds
    // rewrite package.json themselves, so it is already scratch during CI.
    core.exportVariable("CDN_DEPLOY_VERSION", targetVersion);
    writePackageVersion(targetVersion);

    await runBuild(inputs.buildCommand);
  }

  const broker = createBrokerClient({ baseUrl: inputs.brokerUrl, audience: DEFAULT_OIDC_AUDIENCE });

  const observability = createObservability({
    enabled: true,
    token: process.env.GITHUB_TOKEN,
    environments: envs,
    packageName,
    version: targetVersion,
    cdnUrl,
    sha,
  });
  await observability.start();

  // Distinct from "skip": the summary must not claim "already in S3, nothing to do" for a
  // run that failed before the S3 step ran at all.
  let s3Action: S3Action | "not-attempted" = "not-attempted";
  try {
    if (inputs.distPath && !folderHasIndexHtml(inputs.distPath)) {
      throw new Error(
        `No index.html found at the root of "${inputs.distPath}". The build looks empty or ` +
          "misconfigured.",
      );
    }

    // A pure repoint writes nothing, so it needs no credentials — and asking for them would
    // make a rollback depend on STS. Whether the bytes are really there is checked
    // authoritatively by the broker before it touches the rollout record.
    const hasBytesToWrite = !!inputs.distPath;

    // Nothing to write and nowhere to publish is not a deploy, and both paths below would
    // call it one: "Repoint only -- no S3 write", then "Stage only: bytes are in S3, no
    // rollout requested" -- which asserts something nothing verified. The prefix may be
    // empty, and the run is green either way.
    //
    // This is the shape of a release job that lost its `dist-path`, or set `build-command`
    // without one: the build runs, its output is discarded, and the failure surfaces much
    // later when someone promotes that tag and finds nothing behind it.
    if (!hasBytesToWrite && envs.length === 0) {
      throw new Error(
        "This run would do nothing: there is no `dist-path` to upload and no environment to " +
          "roll out to. Pass `dist-path` to publish a build, or name an environment in " +
          "`deployment-environments` to repoint one at a version already in S3.",
      );
    }

    if (hasBytesToWrite) {
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
      // There is no "is it already there?" input: the broker refuses to mint for a
      // published version, and that refusal is handled below.
      // A published version is immutable, and the broker refuses to write one rather than
      // trusting the caller to skip. That refusal is the authoritative "already deployed"
      // answer on both paths, so it is a skip and not a failure -- re-running a deploy
      // stays idempotent, it just cannot overwrite what is already live.
      const isAlreadyPublished = (e: unknown) =>
        e instanceof BrokerError && e.code === "version_already_published";

      const reportAlreadyPublished = (): S3Action => {
        // A published version is immutable, so this is the idempotent re-run: the bytes
        // that are live stay live. Said plainly in the log, because "skipped" on a run the
        // caller believes rebuilt something is worth being explicit about.
        core.info(
          `> ${remoteFolder} is already published — skipping the S3 write. What the CDN serves ` +
            "for this version is what was published before, not what this run built.",
        );
        return "skip";
      };

      {
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
          rolloutName: DEFAULT_ROLLOUT_NAME,
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
