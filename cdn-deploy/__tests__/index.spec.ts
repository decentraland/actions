import * as core from "@actions/core";
import * as github from "@actions/github";
import { patchRolloutInEnvironments } from "../src/cloudflare";
import { createObservability } from "../src/github";
import { reportFailure, run } from "../src/index";
import { folderHasIndexHtml, readInputs } from "../src/inputs";
import { copyFolderInS3, prefixExists, uploadFolderToS3 } from "../src/s3";
import { notifyRollout } from "../src/slack";
import { ActionInputs } from "../src/types";

jest.mock("@actions/core", () => ({
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  group: jest.fn(),
  summary: { addHeading: jest.fn(), addTable: jest.fn(), write: jest.fn() },
}));
jest.mock("@actions/github", () => ({ context: { sha: "" } }));
jest.mock("../src/inputs", () => ({
  ...jest.requireActual("../src/inputs"),
  readInputs: jest.fn(),
  folderHasIndexHtml: jest.fn(),
}));
jest.mock("../src/s3");
jest.mock("../src/cloudflare");
jest.mock("../src/slack");
jest.mock("../src/github");

type SummaryMock = { addHeading: jest.Mock; addTable: jest.Mock; write: jest.Mock };
type ObservabilityMock = { start: jest.Mock; succeed: jest.Mock; fail: jest.Mock };

describe("when running the cdn-deploy action", () => {
  // `run()` is invoked at import time by src/index.ts; the mocks it touched
  // there are cleared below so no test inherits that call.
  const WORKFLOW_SHA = "abc1234def5678901234567890abcdef12345678";
  const COMMIT_INPUT_SHA = "feed1234567890abcdef1234567890abcdef1234";
  const PACKAGE_NAME = "@dcl/auth-site";
  const COMMIT_VERSION = "1.0.0-commit-abc1234";
  const RELEASE_VERSION = "1.2.3";

  function buildInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
    return {
      distPath: "",
      packageName: PACKAGE_NAME,
      baseVersion: "1.0.0",
      target: { kind: "path", path: "auth" },
      environments: ["zone", "today"],
      kvTargets: [
        { environment: "zone", namespaceId: "kv-namespace-zone" },
        { environment: "today", namespaceId: "kv-namespace-today" },
      ],
      deploymentName: "_site",
      percentage: 100,
      requireIndex: true,
      force: false,
      copyFromCommit: false,
      awsRegion: "us-east-1",
      s3Bucket: "cdn-test-bucket",
      cloudflareAccountId: "cf-test-account",
      cloudflareApiToken: "cf-test-token",
      createGithubDeployment: false,
      cdnBaseUrl: "https://cdn.decentraland.org",
      ...overrides,
    };
  }

  let readInputsMock: jest.MockedFunction<typeof readInputs>;
  let folderHasIndexHtmlMock: jest.MockedFunction<typeof folderHasIndexHtml>;
  let prefixExistsMock: jest.MockedFunction<typeof prefixExists>;
  let uploadFolderToS3Mock: jest.MockedFunction<typeof uploadFolderToS3>;
  let copyFolderInS3Mock: jest.MockedFunction<typeof copyFolderInS3>;
  let patchRolloutInEnvironmentsMock: jest.MockedFunction<typeof patchRolloutInEnvironments>;
  let notifyRolloutMock: jest.MockedFunction<typeof notifyRollout>;
  let createObservabilityMock: jest.MockedFunction<typeof createObservability>;
  let setOutputMock: jest.Mock;
  let groupMock: jest.Mock;
  let summaryMock: SummaryMock;
  let observability: ObservabilityMock;
  let inputs: ActionInputs;

  beforeEach(() => {
    jest.clearAllMocks();

    (github.context as unknown as { sha: string }).sha = WORKFLOW_SHA;

    setOutputMock = core.setOutput as unknown as jest.Mock;
    groupMock = core.group as unknown as jest.Mock;
    groupMock.mockImplementation((_name: string, fn: () => Promise<unknown>) => fn());

    summaryMock = core.summary as unknown as SummaryMock;
    summaryMock.addHeading.mockReturnValue(summaryMock);
    summaryMock.addTable.mockReturnValue(summaryMock);
    summaryMock.write.mockResolvedValue(summaryMock);

    observability = {
      start: jest.fn().mockResolvedValue(undefined),
      succeed: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    createObservabilityMock = jest.mocked(createObservability);
    createObservabilityMock.mockReturnValue(observability);

    readInputsMock = jest.mocked(readInputs);
    folderHasIndexHtmlMock = jest.mocked(folderHasIndexHtml);
    folderHasIndexHtmlMock.mockReturnValue(true);

    prefixExistsMock = jest.mocked(prefixExists);
    prefixExistsMock.mockResolvedValue(false);
    uploadFolderToS3Mock = jest.mocked(uploadFolderToS3);
    uploadFolderToS3Mock.mockResolvedValue(["index.html", "index.html.br"]);
    copyFolderInS3Mock = jest.mocked(copyFolderInS3);
    copyFolderInS3Mock.mockResolvedValue(12);

    patchRolloutInEnvironmentsMock = jest.mocked(patchRolloutInEnvironments);
    patchRolloutInEnvironmentsMock.mockResolvedValue(["zone", "today"]);
    notifyRolloutMock = jest.mocked(notifyRollout);
    notifyRolloutMock.mockResolvedValue(undefined);

    inputs = buildInputs();
    readInputsMock.mockReturnValue(inputs);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("and a push deploys a freshly built folder that is not yet in S3", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "dist" });
      readInputsMock.mockReturnValue(inputs);
      prefixExistsMock.mockResolvedValue(false);
      uploadFolderToS3Mock.mockResolvedValue(["index.html", "index.html.br", "main.js"]);
    });

    it("should upload the built folder to the commit-version prefix of the CDN bucket", async () => {
      await run();

      expect(uploadFolderToS3Mock).toHaveBeenCalledWith({
        region: "us-east-1",
        bucket: "cdn-test-bucket",
        folder: "dist",
        remoteFolder: PACKAGE_NAME + "/" + COMMIT_VERSION,
      });
    });

    it("should repoint every configured KV namespace at the commit version", async () => {
      await run();

      expect(patchRolloutInEnvironmentsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "cf-test-account",
          apiToken: "cf-test-token",
        }),
        inputs.kvTargets,
        expect.objectContaining({
          key: "auth",
          rolloutName: "_site",
          percentage: 100,
          prefix: PACKAGE_NAME,
          version: COMMIT_VERSION,
        }),
      );
    });

    it("should publish an upload mode output", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith("mode", "upload");
    });
  });

  describe("and the same commit is deployed again with the bytes already in S3", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "dist" });
      readInputsMock.mockReturnValue(inputs);
      prefixExistsMock.mockResolvedValue(true);
    });

    it("should write nothing to S3, neither uploading nor copying", async () => {
      await run();

      expect(uploadFolderToS3Mock).not.toHaveBeenCalled();
      expect(copyFolderInS3Mock).not.toHaveBeenCalled();
    });

    it("should still repoint the KV at the commit version", async () => {
      await run();

      expect(patchRolloutInEnvironmentsMock).toHaveBeenCalledWith(
        expect.anything(),
        inputs.kvTargets,
        expect.objectContaining({ version: COMMIT_VERSION }),
      );
    });

    it("should publish a skip mode output", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith("mode", "skip");
    });
  });

  describe("and a release copies the commit build into a release version, staging only", () => {
    beforeEach(() => {
      inputs = buildInputs({
        distPath: "",
        version: RELEASE_VERSION,
        copyFromCommit: true,
        environments: [],
        kvTargets: [],
      });
      readInputsMock.mockReturnValue(inputs);
      prefixExistsMock.mockResolvedValue(false);
      copyFolderInS3Mock.mockResolvedValue(42);
    });

    it("should server-side copy from the commit-version prefix into the release prefix", async () => {
      await run();

      expect(copyFolderInS3Mock).toHaveBeenCalledWith({
        region: "us-east-1",
        bucket: "cdn-test-bucket",
        sourceFolder: PACKAGE_NAME + "/" + COMMIT_VERSION,
        targetFolder: PACKAGE_NAME + "/" + RELEASE_VERSION,
      });
    });

    it("should leave the KV untouched because no environment was requested", async () => {
      await run();

      expect(patchRolloutInEnvironmentsMock).not.toHaveBeenCalled();
    });

    it("should publish a copy mode output", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith("mode", "copy");
    });
  });

  describe("and a repoint targets a version that is already in S3", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "", version: RELEASE_VERSION });
      readInputsMock.mockReturnValue(inputs);
      prefixExistsMock.mockResolvedValue(true);
    });

    it("should write nothing to S3, neither uploading nor copying", async () => {
      await run();

      expect(uploadFolderToS3Mock).not.toHaveBeenCalled();
      expect(copyFolderInS3Mock).not.toHaveBeenCalled();
    });

    it("should repoint the KV at the requested version", async () => {
      await run();

      expect(patchRolloutInEnvironmentsMock).toHaveBeenCalledWith(
        expect.anything(),
        inputs.kvTargets,
        expect.objectContaining({ version: RELEASE_VERSION }),
      );
    });

    it("should publish a skip mode output", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith("mode", "skip");
    });
  });

  describe("and a repoint targets a version that is absent from S3 with nothing to fill it", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "", version: RELEASE_VERSION, copyFromCommit: false });
      readInputsMock.mockReturnValue(inputs);
      prefixExistsMock.mockResolvedValue(false);
    });

    it("should reject explaining the target version cannot be populated", async () => {
      await expect(run()).rejects.toThrow(/is not in S3 and there is nothing to populate it with/);
    });

    it("should never repoint the KV at a version whose bytes are not there", async () => {
      await expect(run()).rejects.toThrow();

      expect(patchRolloutInEnvironmentsMock).not.toHaveBeenCalled();
    });
  });

  describe("and the built folder produces no uploaded objects", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "dist" });
      readInputsMock.mockReturnValue(inputs);
      prefixExistsMock.mockResolvedValue(false);
      uploadFolderToS3Mock.mockResolvedValue([]);
    });

    it("should reject explaining the folder is empty", async () => {
      await expect(run()).rejects.toThrow(/the folder is empty/);
    });

    it("should never repoint the KV at an empty prefix", async () => {
      await expect(run()).rejects.toThrow();

      expect(patchRolloutInEnvironmentsMock).not.toHaveBeenCalled();
    });
  });

  describe("and the built folder has no index.html while require-index is on", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "dist", requireIndex: true });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(false);
    });

    it("should reject pointing at the missing index.html", async () => {
      await expect(run()).rejects.toThrow(/No index.html found at the root of "dist"/);
    });

    it("should reject before touching S3 at all", async () => {
      await expect(run()).rejects.toThrow();

      expect(prefixExistsMock).not.toHaveBeenCalled();
      expect(uploadFolderToS3Mock).not.toHaveBeenCalled();
    });
  });

  describe("and the Slack notification fails after the deploy landed", () => {
    beforeEach(() => {
      inputs = buildInputs({
        distPath: "dist",
        slackWebhook: "https://hooks.example.com/services/T000/B000/xxxx",
      });
      readInputsMock.mockReturnValue(inputs);
      notifyRolloutMock.mockRejectedValue(new Error("Slack notification failed (500)"));
    });

    it("should still resolve because Slack is never a reason to fail a landed deploy", async () => {
      await expect(run()).resolves.toBeUndefined();
    });

    it("should report the deploy as succeeded to observability", async () => {
      await run();

      expect(observability.succeed).toHaveBeenCalled();
    });
  });

  describe("and the KV repoint fails for one of the environments", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "dist" });
      readInputsMock.mockReturnValue(inputs);
      patchRolloutInEnvironmentsMock.mockRejectedValue(
        new Error('Rollout partially applied. Updated: zone. Failed: today ("403")'),
      );
    });

    it("should reject with the partial-write error", async () => {
      await expect(run()).rejects.toThrow(/Rollout partially applied/);
    });

    it("should report the deploy as failed to observability", async () => {
      await expect(run()).rejects.toThrow();

      expect(observability.fail).toHaveBeenCalled();
    });

    it("should have published the mode output before the KV write, so a downstream step can tell the bytes were written", async () => {
      await expect(run()).rejects.toThrow();

      expect(setOutputMock).toHaveBeenCalledWith("mode", "upload");
    });

    it("should still write the job summary so a half-applied deploy is visible", async () => {
      await expect(run()).rejects.toThrow();

      expect(summaryMock.write).toHaveBeenCalled();
    });
  });

  describe("and a commit input selects a commit other than the workflow's", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "dist", commit: COMMIT_INPUT_SHA });
      readInputsMock.mockReturnValue(inputs);
    });

    it("should thread the resolved commit sha, not the workflow sha, into observability", async () => {
      await run();

      expect(createObservabilityMock).toHaveBeenCalledWith(
        expect.objectContaining({ sha: COMMIT_INPUT_SHA, version: "1.0.0-commit-feed123" }),
      );
    });
  });
  // The mutation survey found these unasserted: every one of the behaviours
  // below could be deleted outright and the rest of the suite stayed green.
  describe("and the run reports its results", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist", slackWebhook: "https://hooks.slack.com/x" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      prefixExistsMock.mockResolvedValue(false);
      uploadFolderToS3Mock.mockResolvedValue(["index.html"]);
      patchRolloutInEnvironmentsMock.mockResolvedValue(["zone", "today"]);
      notifyRolloutMock.mockResolvedValue(undefined);
    });

    it("should publish the deployed version", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith("version", COMMIT_VERSION);
    });

    it("should publish the S3 prefix that was written", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith("s3-path", `${PACKAGE_NAME}/${COMMIT_VERSION}`);
    });

    it("should publish a cdn url containing the package and version", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith(
        "cdn-url",
        `https://cdn.decentraland.org/${PACKAGE_NAME}/${COMMIT_VERSION}`,
      );
    });

    it("should probe the target prefix in the configured region and bucket", async () => {
      await run();

      expect(prefixExistsMock).toHaveBeenCalledWith({
        region: "us-east-1",
        bucket: "cdn-test-bucket",
        prefix: `${PACKAGE_NAME}/${COMMIT_VERSION}`,
      });
    });

    it("should open the deployment before doing any work", async () => {
      await run();

      expect(observability.start).toHaveBeenCalledTimes(1);
    });

    it("should stamp the rollout with the current time", async () => {
      await run();

      const [, , params] = patchRolloutInEnvironmentsMock.mock.calls[0];
      expect(params.timestamp).toBeGreaterThan(0);
    });

    it("should surface KV retry warnings in the log", async () => {
      await run();

      const [account] = patchRolloutInEnvironmentsMock.mock.calls[0];
      expect(typeof account.onRetry).toBe("function");
    });

    it("should record what the S3 step did in the job summary", async () => {
      await run();

      expect(summaryMock.addTable).toHaveBeenCalledWith(expect.arrayContaining([["S3", "upload"]]));
    });
  });

  describe("and Slack is configured", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist", slackWebhook: "https://hooks.slack.com/x" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      prefixExistsMock.mockResolvedValue(false);
      uploadFolderToS3Mock.mockResolvedValue(["index.html"]);
      patchRolloutInEnvironmentsMock.mockResolvedValue(["zone", "today"]);
      notifyRolloutMock.mockResolvedValue(undefined);
    });

    it("should notify once per repointed environment", async () => {
      await run();

      expect(notifyRolloutMock).toHaveBeenCalledTimes(2);
    });

    it("should link each message to that environment's own url", async () => {
      await run();

      expect(notifyRolloutMock.mock.calls.map((call) => call[0].url)).toEqual([
        "https://decentraland.zone/auth",
        "https://decentraland.today/auth",
      ]);
    });

    it("should report the deployed version in the message", async () => {
      await run();

      expect(notifyRolloutMock).toHaveBeenCalledWith(
        expect.objectContaining({ version: COMMIT_VERSION, prefix: PACKAGE_NAME }),
      );
    });

    describe("and the notification fails", () => {
      beforeEach(() => {
        notifyRolloutMock.mockRejectedValue(new Error("slack down"));
      });

      it("should warn rather than stay silent", async () => {
        await run();

        expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("Slack"));
      });

      it("should still mark the deploy successful", async () => {
        await run();

        expect(observability.succeed).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("and the index guard is disabled for a non-HTML bundle", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist", requireIndex: false });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(false);
      prefixExistsMock.mockResolvedValue(false);
      uploadFolderToS3Mock.mockResolvedValue(["bundle.js"]);
      patchRolloutInEnvironmentsMock.mockResolvedValue(["zone", "today"]);
    });

    // The documented escape hatch for asset bundles — dropping requireIndex
    // from the guard would hard-fail every one of these deploys.
    it("should upload a folder with no index.html", async () => {
      await run();

      expect(uploadFolderToS3Mock).toHaveBeenCalledTimes(1);
    });
  });

  describe("and a built folder is combined with the release copy flag", () => {
    beforeEach(() => {
      inputs = buildInputs({
        distPath: "./dist",
        version: RELEASE_VERSION,
        copyFromCommit: true,
      });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      prefixExistsMock.mockResolvedValue(false);
      uploadFolderToS3Mock.mockResolvedValue(["index.html"]);
      patchRolloutInEnvironmentsMock.mockResolvedValue(["zone", "today"]);
    });

    // Guards the original production bug at the orchestration level, not just
    // in the pure planner: the folder the caller built must win.
    it("should upload the folder rather than copy the commit's build", async () => {
      await run();

      expect(uploadFolderToS3Mock).toHaveBeenCalledTimes(1);
      expect(copyFolderInS3Mock).not.toHaveBeenCalled();
    });
  });

  describe("and the run throws", () => {
    it("should fail the job rather than report success", () => {
      reportFailure(new Error("upload exploded"));

      expect(core.setFailed).toHaveBeenCalledWith("upload exploded");
    });

    it("should stringify a non-error throw", () => {
      reportFailure("plain string");

      expect(core.setFailed).toHaveBeenCalledWith("plain string");
    });
  });
});
