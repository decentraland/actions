import * as core from "@actions/core";
import * as github from "@actions/github";
import { Environment } from "./types";

/**
 * Commit-status context kept identical to `static-sites-pipeline` so any repo
 * that marked `cdn-rollout/upload` as a required check keeps passing.
 */
const COMMIT_STATUS_CONTEXT = "cdn-rollout/upload";
const DEPLOYMENT_TASK = "cdn-deploy";

export type Observability = {
  start(): Promise<void>;
  succeed(): Promise<void>;
  fail(): Promise<void>;
};

const NOOP: Observability = {
  async start() {},
  async succeed() {},
  async fail() {},
};

/**
 * The commit a status belongs on.
 *
 * On a `pull_request` event `GITHUB_SHA` is the ephemeral `refs/pull/N/merge`
 * commit, and a status posted there never shows up on the PR — a repo that made
 * `cdn-rollout/upload` a required check would wait on it forever. The PR head is
 * the commit a reviewer is actually looking at.
 */
export function statusSha(context: typeof github.context = github.context): string {
  const prHead = (context.payload as { pull_request?: { head?: { sha?: string } } })?.pull_request
    ?.head?.sha;
  return prHead || context.sha;
}

/**
 * GitHub deployment + commit status for visibility. Entirely best-effort: every
 * call is wrapped so an observability failure never breaks a deploy. Returns a
 * no-op when disabled or when no token/context is available (e.g. forks).
 */
export function createObservability(opts: {
  enabled: boolean;
  token?: string;
  /** Environments being repointed; empty for a stage-only run. */
  environments: Environment[];
  packageName: string;
  version: string;
  cdnUrl: string;
  /** The commit actually being deployed — may differ from the workflow's sha. */
  sha?: string;
}): Observability {
  if (!opts.enabled || !opts.token) return NOOP;

  let octokit: ReturnType<typeof github.getOctokit>;
  try {
    octokit = github.getOctokit(opts.token);
  } catch {
    return NOOP;
  }

  const { owner, repo } = github.context.repo;
  // The deployment records the commit whose build is going live; the status has
  // to land somewhere a reviewer sees it.
  const deploySha = opts.sha || github.context.sha;
  const sha = opts.sha || statusSha();
  const environmentName = opts.environments.join("+") || "stage";
  const isProduction = opts.environments.includes("org");
  const logUrl = `${github.context.serverUrl}/${owner}/${repo}/actions/runs/${github.context.runId}`;
  let deploymentId: number | undefined;

  async function safe(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      core.warning(`observability: ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function commitStatus(state: "pending" | "success" | "failure", description: string) {
    await safe(`commit status ${state}`, () =>
      octokit.rest.repos.createCommitStatus({
        owner,
        repo,
        sha,
        context: COMMIT_STATUS_CONTEXT,
        state,
        description: description.slice(0, 140),
        target_url: logUrl,
      }),
    );
  }

  async function deploymentStatus(state: "in_progress" | "success" | "failure") {
    if (!deploymentId) return;
    await safe(`deployment status ${state}`, () =>
      octokit.rest.repos.createDeploymentStatus({
        owner,
        repo,
        deployment_id: deploymentId as number,
        state,
        log_url: logUrl,
        environment_url: opts.cdnUrl,
      }),
    );
  }

  return {
    async start() {
      await safe("create deployment", async () => {
        const created = await octokit.rest.repos.createDeployment({
          owner,
          repo,
          ref: deploySha,
          task: DEPLOYMENT_TASK,
          environment: environmentName,
          description: `Deploy ${opts.packageName}@${opts.version} to CDN`,
          auto_merge: false,
          required_contexts: [],
          transient_environment: false,
          production_environment: isProduction,
          payload: {
            packageName: opts.packageName,
            version: opts.version,
            url: opts.cdnUrl,
          } as never,
        });
        const data = created.data as { id?: number };
        if (data && typeof data.id === "number") deploymentId = data.id;
      });
      if (!deploymentId) {
        core.warning(
          "GitHub deployment could not be created — deployment status won't be recorded. The " +
            "usual cause is a job without `permissions: { deployments: write }`.",
        );
      }
      await deploymentStatus("in_progress");
      await commitStatus("pending", "Deploying to CDN");
    },
    async succeed() {
      await deploymentStatus("success");
      await commitStatus("success", `Deployed ${opts.cdnUrl}`);
    },
    async fail() {
      await deploymentStatus("failure");
      await commitStatus("failure", "Failed to deploy to CDN");
    },
  };
}
