jest.mock("@actions/github", () => ({
  getOctokit: jest.fn(),
  context: {
    repo: { owner: "decentraland", repo: "auth" },
    sha: "abc123def456",
    serverUrl: "https://github.com",
    runId: 99,
    payload: {},
  },
}));
jest.mock("@actions/core", () => ({ warning: jest.fn(), info: jest.fn() }));

import * as core from "@actions/core";
import * as github from "@actions/github";
import { createObservability, latestReleaseVersion, statusSha } from "../src/github";

type RepoApi = {
  createDeployment: jest.Mock;
  createDeploymentStatus: jest.Mock;
  createCommitStatus: jest.Mock;
};

/** Build a fresh octokit stub and wire `getOctokit` to return it. */
function mockOctokit(): RepoApi {
  const repos: RepoApi = {
    createDeployment: jest.fn().mockResolvedValue({ data: { id: 1234 } }),
    createDeploymentStatus: jest.fn().mockResolvedValue({}),
    createCommitStatus: jest.fn().mockResolvedValue({}),
  };
  (github.getOctokit as jest.Mock).mockReturnValue({ rest: { repos } });
  return repos;
}

const baseOptions = {
  enabled: true,
  token: "gh-token",
  packageName: "@dcl/auth-site",
  version: "1.0.0-commit-abc1234",
  cdnUrl: "https://cdn.decentraland.org/@dcl/auth-site/1.0.0-commit-abc1234",
};

describe("when resolving the commit a status belongs on", () => {
  describe("and the event is a pull request", () => {
    let context: { sha: string; payload: { pull_request: { head: { sha: string } } } };

    beforeEach(() => {
      context = {
        sha: "merge-commit-sha",
        payload: { pull_request: { head: { sha: "head-sha" } } },
      };
    });

    // On `pull_request`, GITHUB_SHA is the ephemeral refs/pull/N/merge commit —
    // a status posted there never appears on the PR, so a required check hangs.
    it("should use the pull request head rather than the merge commit", () => {
      expect(statusSha(context as never)).toBe("head-sha");
    });
  });

  describe("and the event is not a pull request", () => {
    let context: { sha: string; payload: Record<string, never> };

    beforeEach(() => {
      context = { sha: "push-sha", payload: {} };
    });

    it("should use the workflow commit", () => {
      expect(statusSha(context as never)).toBe("push-sha");
    });
  });
});

describe("when the observability is disabled", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should not build an octokit client", () => {
    createObservability({ ...baseOptions, enabled: false, environments: ["zone"] });

    expect(github.getOctokit).not.toHaveBeenCalled();
  });

  it("should still return a usable no-op", async () => {
    const observability = createObservability({
      ...baseOptions,
      enabled: false,
      environments: ["zone"],
    });

    await expect(observability.start()).resolves.toBeUndefined();
    await expect(observability.succeed()).resolves.toBeUndefined();
    await expect(observability.fail()).resolves.toBeUndefined();
  });
});

describe("when no GitHub token is available", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should not build an octokit client", () => {
    createObservability({ ...baseOptions, token: undefined, environments: ["zone"] });

    expect(github.getOctokit).not.toHaveBeenCalled();
  });

  it("should still return a usable no-op", async () => {
    const observability = createObservability({
      ...baseOptions,
      token: undefined,
      environments: ["zone"],
    });

    await expect(observability.start()).resolves.toBeUndefined();
  });
});

describe("when creating a deployment", () => {
  let repos: RepoApi;

  beforeEach(() => {
    jest.clearAllMocks();
    repos = mockOctokit();
  });

  describe("and production is among the environments", () => {
    it("should flag the deployment as production for a single org target", async () => {
      await createObservability({ ...baseOptions, environments: ["org"] }).start();

      expect(repos.createDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ production_environment: true }),
      );
    });

    // The old code compared the JOINED string to "org", so a combined deploy
    // that really did touch production was not flagged as such.
    it("should flag the deployment as production when org is combined with another environment", async () => {
      await createObservability({ ...baseOptions, environments: ["today", "org"] }).start();

      expect(repos.createDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ production_environment: true }),
      );
    });
  });

  describe("and production is not among the environments", () => {
    it("should not flag the deployment as production", async () => {
      await createObservability({ ...baseOptions, environments: ["zone", "today"] }).start();

      expect(repos.createDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ production_environment: false }),
      );
    });
  });

  describe("and several environments are repointed", () => {
    it("should name the environment after all of them", async () => {
      await createObservability({ ...baseOptions, environments: ["zone", "today"] }).start();

      expect(repos.createDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ environment: "zone+today" }),
      );
    });
  });

  describe("and nothing is repointed", () => {
    it("should name the environment stage", async () => {
      await createObservability({ ...baseOptions, environments: [] }).start();

      expect(repos.createDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ environment: "stage" }),
      );
    });
  });

  describe("and a specific commit is being deployed", () => {
    it("should record the deployment against that commit", async () => {
      await createObservability({
        ...baseOptions,
        environments: ["org"],
        sha: "deadbeef1234567",
      }).start();

      expect(repos.createDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "deadbeef1234567" }),
      );
    });

    it("should post the commit status against that commit", async () => {
      await createObservability({
        ...baseOptions,
        environments: ["org"],
        sha: "deadbeef1234567",
      }).start();

      expect(repos.createCommitStatus).toHaveBeenCalledWith(
        expect.objectContaining({ sha: "deadbeef1234567" }),
      );
    });
  });

  describe("and pending checks exist on the commit", () => {
    // Without this, GitHub answers 409 and no deployment is created at all.
    it("should not wait on any required context", async () => {
      await createObservability({ ...baseOptions, environments: ["zone"] }).start();

      expect(repos.createDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ required_contexts: [] }),
      );
    });
  });
});

describe("when the deploy succeeds", () => {
  let repos: RepoApi;

  beforeEach(async () => {
    jest.clearAllMocks();
    repos = mockOctokit();
  });

  it("should mark the commit status successful", async () => {
    const observability = createObservability({ ...baseOptions, environments: ["zone"] });
    await observability.start();
    await observability.succeed();

    expect(repos.createCommitStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "success" }),
    );
  });

  it("should mark the deployment successful", async () => {
    const observability = createObservability({ ...baseOptions, environments: ["zone"] });
    await observability.start();
    await observability.succeed();

    expect(repos.createDeploymentStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "success" }),
    );
  });
});

describe("when the deploy fails", () => {
  let repos: RepoApi;

  beforeEach(() => {
    jest.clearAllMocks();
    repos = mockOctokit();
  });

  it("should mark the commit status failed", async () => {
    const observability = createObservability({ ...baseOptions, environments: ["zone"] });
    await observability.start();
    await observability.fail();

    expect(repos.createCommitStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "failure" }),
    );
  });
});

describe("when a long description is reported", () => {
  let repos: RepoApi;

  beforeEach(() => {
    jest.clearAllMocks();
    repos = mockOctokit();
  });

  it("should truncate it to the GitHub limit", async () => {
    const observability = createObservability({
      ...baseOptions,
      environments: ["zone"],
      cdnUrl: `https://cdn.decentraland.org/${"x".repeat(300)}`,
    });
    await observability.start();
    await observability.succeed();

    const calls = repos.createCommitStatus.mock.calls;
    const { description } = calls[calls.length - 1][0];
    expect(description.length).toBeLessThanOrEqual(140);
  });
});

// Observability is decoration. Its entire contract is that it can never be the
// reason a deploy fails — which the previous suite never exercised.
describe("when the GitHub API rejects", () => {
  let repos: RepoApi;

  beforeEach(() => {
    jest.clearAllMocks();
    repos = mockOctokit();
  });

  describe("and creating the deployment fails", () => {
    beforeEach(() => {
      repos.createDeployment.mockRejectedValueOnce(new Error("403 Forbidden"));
    });

    it("should not fail the deploy", async () => {
      const observability = createObservability({ ...baseOptions, environments: ["zone"] });

      await expect(observability.start()).resolves.toBeUndefined();
    });

    it("should warn instead", async () => {
      await createObservability({ ...baseOptions, environments: ["zone"] }).start();

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("create deployment failed"),
      );
    });

    it("should point at the missing permission", async () => {
      await createObservability({ ...baseOptions, environments: ["zone"] }).start();

      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("deployments: write"));
    });

    it("should skip the deployment status it has no id for", async () => {
      await createObservability({ ...baseOptions, environments: ["zone"] }).start();

      expect(repos.createDeploymentStatus).not.toHaveBeenCalled();
    });
  });

  describe("and the commit status call fails", () => {
    beforeEach(() => {
      repos.createCommitStatus.mockRejectedValue(new Error("422 Unprocessable"));
    });

    it("should not fail the deploy", async () => {
      const observability = createObservability({ ...baseOptions, environments: ["zone"] });

      await expect(observability.start()).resolves.toBeUndefined();
    });

    it("should warn instead", async () => {
      await createObservability({ ...baseOptions, environments: ["zone"] }).start();

      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("commit status"));
    });
  });

  describe("and the deployment status call fails", () => {
    beforeEach(() => {
      repos.createDeploymentStatus.mockRejectedValue(new Error("500 Server Error"));
    });

    it("should not fail the deploy", async () => {
      const observability = createObservability({ ...baseOptions, environments: ["zone"] });

      await expect(observability.start()).resolves.toBeUndefined();
    });
  });

  describe("and building the client itself throws", () => {
    beforeEach(() => {
      (github.getOctokit as jest.Mock).mockImplementationOnce(() => {
        throw new Error("bad token");
      });
    });

    it("should fall back to a no-op", async () => {
      const observability = createObservability({ ...baseOptions, environments: ["zone"] });

      await expect(observability.start()).resolves.toBeUndefined();
    });
  });
});

describe("when the deployment response carries no id", () => {
  let repos: RepoApi;

  beforeEach(() => {
    jest.clearAllMocks();
    repos = mockOctokit();
    repos.createDeployment.mockResolvedValueOnce({ data: {} });
  });

  it("should warn that statuses will not be recorded", async () => {
    await createObservability({ ...baseOptions, environments: ["zone"] }).start();

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("deployment status won't be recorded"),
    );
  });

  it("should not attempt a deployment status", async () => {
    await createObservability({ ...baseOptions, environments: ["zone"] }).start();

    expect(repos.createDeploymentStatus).not.toHaveBeenCalled();
  });
});

/**
 * This is what anchors every commit version: base = newest release, patch-bumped. Get it
 * wrong and the build sorts below what is already live, the rollout is written, the job is
 * green and nothing changes — which is exactly the failure that cost a deploy cycle.
 *
 * Note especially the error cases. Every one of them falls back to package.json, and
 * package.json is routinely stale (`@dcl/sites` sat at 0.0.1 while serving 0.69.x), so a
 * transient 500 here is indistinguishable from "this repo has never released" and quietly
 * walks the version backwards.
 */
describe("when resolving the latest release", () => {
  function mockReleases(releases: Array<Record<string, unknown>>): jest.Mock {
    const listReleases = jest.fn().mockResolvedValue({ data: releases });
    (github.getOctokit as jest.Mock).mockReturnValue({ rest: { repos: { listReleases } } });
    return listReleases;
  }

  const release = (tag_name: string, extra: Record<string, unknown> = {}) => ({
    tag_name,
    draft: false,
    prerelease: false,
    ...extra,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("and the newest release by date is not the highest version", () => {
    // `releases/latest` would answer 1.0.1 here: a patch published for an old line after a
    // newer minor. Taking it would walk the base version backwards.
    it("should take the highest semver, not the most recent", async () => {
      mockReleases([release("1.0.1"), release("1.2.0"), release("1.1.0")]);

      await expect(latestReleaseVersion({ token: "t" })).resolves.toEqual("1.2.0");
    });
  });

  describe("and some releases are not publishable", () => {
    it("should ignore drafts", async () => {
      mockReleases([release("1.0.0"), release("9.9.9", { draft: true })]);

      await expect(latestReleaseVersion({ token: "t" })).resolves.toEqual("1.0.0");
    });

    it("should ignore prereleases, matching what `latest` meant on npm", async () => {
      mockReleases([release("1.0.0"), release("2.0.0-rc.1", { prerelease: true })]);

      await expect(latestReleaseVersion({ token: "t" })).resolves.toEqual("1.0.0");
    });
  });

  describe("and the tags are spelled differently", () => {
    it("should accept a v prefix", async () => {
      mockReleases([release("v1.4.0")]);

      await expect(latestReleaseVersion({ token: "t" })).resolves.toEqual("1.4.0");
    });

    // Repositories accumulate tags like `deploy-2019`. One of those must not stop a deploy.
    it("should skip a tag that is not semver rather than failing", async () => {
      mockReleases([release("deploy-2019"), release("1.1.0")]);

      await expect(latestReleaseVersion({ token: "t" })).resolves.toEqual("1.1.0");
    });

    it("should answer undefined when nothing is a usable version", async () => {
      mockReleases([release("deploy-2019"), release("")]);

      await expect(latestReleaseVersion({ token: "t" })).resolves.toBeUndefined();
    });
  });

  describe("and the repository has never released", () => {
    it("should answer undefined so the caller falls back to package.json", async () => {
      mockReleases([]);

      await expect(latestReleaseVersion({ token: "t" })).resolves.toBeUndefined();
    });
  });

  describe("and there is no token", () => {
    it("should not call the API at all", async () => {
      const listReleases = mockReleases([release("1.0.0")]);

      await latestReleaseVersion({});

      expect(listReleases).not.toHaveBeenCalled();
    });

    it("should say why, since the fallback silently changes the version", async () => {
      await latestReleaseVersion({});

      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("contents: read"));
    });
  });

  describe("and the API fails", () => {
    beforeEach(() => {
      (github.getOctokit as jest.Mock).mockReturnValue({
        rest: { repos: { listReleases: jest.fn().mockRejectedValue(new Error("503 upstream")) } },
      });
    });

    it("should fall back rather than fail the deploy", async () => {
      await expect(latestReleaseVersion({ token: "t" })).resolves.toBeUndefined();
    });

    it("should warn with the reason attached", async () => {
      await latestReleaseVersion({ token: "t" });

      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("503 upstream"));
    });
  });

  it("should ask for the repository it is running in", async () => {
    const listReleases = mockReleases([release("1.0.0")]);

    await latestReleaseVersion({ token: "t" });

    expect(listReleases).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "decentraland", repo: "auth" }),
    );
  });
});
