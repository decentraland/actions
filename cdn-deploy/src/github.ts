import * as core from "@actions/core";
import * as github from "@actions/github";

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
 * GitHub deployment + commit status for visibility. Entirely best-effort: every
 * call is wrapped so an observability failure never breaks a deploy. Returns a
 * no-op when disabled or when no token/context is available (e.g. forks).
 */
export function createObservability(opts: {
  enabled: boolean;
  token?: string;
  environment: string;
  packageName: string;
  version: string;
  cdnUrl: string;
}): Observability {
  if (!opts.enabled || !opts.token) return NOOP;

  let octokit: ReturnType<typeof github.getOctokit>;
  try {
    octokit = github.getOctokit(opts.token);
  } catch {
    return NOOP;
  }

  const { owner, repo } = github.context.repo;
  const sha = github.context.sha;
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
      })
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
      })
    );
  }

  return {
    async start() {
      await safe("create deployment", async () => {
        const created = await octokit.rest.repos.createDeployment({
          owner,
          repo,
          ref: sha,
          task: DEPLOYMENT_TASK,
          environment: opts.environment,
          description: `Deploy ${opts.packageName}@${opts.version} to CDN`,
          auto_merge: false,
          required_contexts: [],
          transient_environment: false,
          production_environment: opts.environment === "org",
          payload: {
            packageName: opts.packageName,
            version: opts.version,
            url: opts.cdnUrl,
          } as never,
        });
        // 201 -> deployment; 202 -> merged/pending (no id we can act on).
        const data = created.data as { id?: number };
        if (data && typeof data.id === "number") deploymentId = data.id;
      });
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
