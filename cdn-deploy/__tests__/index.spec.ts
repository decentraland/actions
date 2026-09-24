import * as core from "@actions/core";
import { BrokerError, createBrokerClient } from "../src/broker";
import { createBrokeredCredentials } from "../src/credentials";
import { createObservability } from "../src/github";
import { RELEASE_LIMITS, reportFailure, run } from "../src/index";
import { folderHasIndexHtml, readInputs } from "../src/inputs";
import { uploadFolderToS3, writeCompletionMarker } from "../src/s3";
import { notifyRollout } from "../src/slack";
import { ActionInputs } from "../src/types";

jest.mock("@actions/core", () => ({
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  group: jest.fn(),
  setSecret: jest.fn(),
  summary: { addHeading: jest.fn(), addTable: jest.fn(), write: jest.fn() },
}));
jest.mock("@actions/github", () => ({ context: { sha: "" } }));
jest.mock("../src/inputs", () => ({
  ...jest.requireActual("../src/inputs"),
  readInputs: jest.fn(),
  folderHasIndexHtml: jest.fn(),
}));
jest.mock("../src/s3");
jest.mock("../src/broker", () => ({
  ...jest.requireActual("../src/broker"),
  createBrokerClient: jest.fn(),
}));
jest.mock("../src/credentials");
jest.mock("../src/slack");
jest.mock("../src/github");

type SummaryMock = { addHeading: jest.Mock; addTable: jest.Mock; write: jest.Mock };
type ObservabilityMock = { start: jest.Mock; succeed: jest.Mock; fail: jest.Mock };
type BrokerMock = { requestCredentials: jest.Mock; release: jest.Mock; rollout: jest.Mock };

describe("when running the cdn-deploy action", () => {
  // `run()` is invoked at import time by src/index.ts; clearAllMocks below wipes what that
  // call touched so no test inherits it.
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
      environments: ["zone", "today"],
      deploymentName: "_site",
      percentage: 100,
      requireIndex: true,
      force: false,
      copyFromCommit: false,
      createGithubDeployment: false,
      cdnBaseUrl: "https://cdn.decentraland.org",
      brokerUrl: "https://cdn-deploy.decentraland.org",
      oidcAudience: "dcl-cdn-deploy",
      ...overrides,
    };
  }

  function grant(targetExists: boolean) {
    return {
      bucket: "cdn-test-bucket",
      region: "us-east-1",
      prefix: `${PACKAGE_NAME}/${COMMIT_VERSION}/`,
      targetExists,
      credentials: { accessKeyId: "AKIA", secretAccessKey: "s", sessionToken: "t" },
      expiresInSeconds: 900,
    };
  }

  function rolloutResult(environment: string) {
    return {
      key: "auth",
      environment,
      rolloutName: "_site",
      version: COMMIT_VERSION,
      percentage: 100,
      url: `https://decentraland.${environment}/auth`,
    };
  }

  let readInputsMock: jest.MockedFunction<typeof readInputs>;
  let folderHasIndexHtmlMock: jest.MockedFunction<typeof folderHasIndexHtml>;
  let uploadFolderToS3Mock: jest.MockedFunction<typeof uploadFolderToS3>;
  let writeCompletionMarkerMock: jest.MockedFunction<typeof writeCompletionMarker>;
  let notifyRolloutMock: jest.MockedFunction<typeof notifyRollout>;
  let createObservabilityMock: jest.MockedFunction<typeof createObservability>;
  let setOutputMock: jest.Mock;
  let groupMock: jest.Mock;
  let summaryMock: SummaryMock;
  let observability: ObservabilityMock;
  let broker: BrokerMock;
  let inputs: ActionInputs;

  beforeEach(() => {
    jest.clearAllMocks();

    setOutputMock = core.setOutput as unknown as jest.Mock;
    groupMock = core.group as unknown as jest.Mock;
    groupMock.mockImplementation((_name: string, fn: () => Promise<unknown>) => fn());

    summaryMock = core.summary as unknown as SummaryMock;
    summaryMock.addHeading.mockReturnValue(summaryMock);
    summaryMock.addTable.mockReturnValue(summaryMock);
    summaryMock.write.mockResolvedValue(summaryMock);

    observability = { start: jest.fn(), succeed: jest.fn(), fail: jest.fn() };
    createObservabilityMock = createObservability as jest.MockedFunction<
      typeof createObservability
    >;
    createObservabilityMock.mockReturnValue(observability as never);

    broker = { requestCredentials: jest.fn(), release: jest.fn(), rollout: jest.fn() };
    (createBrokerClient as jest.Mock).mockReturnValue(broker);
    (createBrokeredCredentials as jest.Mock).mockReturnValue({ accessKeyId: "AKIA" });

    readInputsMock = readInputs as jest.MockedFunction<typeof readInputs>;
    folderHasIndexHtmlMock = folderHasIndexHtml as jest.MockedFunction<typeof folderHasIndexHtml>;
    uploadFolderToS3Mock = uploadFolderToS3 as jest.MockedFunction<typeof uploadFolderToS3>;
    writeCompletionMarkerMock = writeCompletionMarker as jest.MockedFunction<
      typeof writeCompletionMarker
    >;
    notifyRolloutMock = notifyRollout as jest.MockedFunction<typeof notifyRollout>;

    broker.rollout.mockImplementation(async ({ environment }: { environment: string }) =>
      rolloutResult(environment),
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const github = require("@actions/github");
    github.context.sha = WORKFLOW_SHA;
  });

  describe("and a commit build is deployed", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockResolvedValue(grant(false));
      uploadFolderToS3Mock.mockResolvedValue(["index.html"]);
    });

    it("should upload the folder", async () => {
      await run();

      expect(uploadFolderToS3Mock).toHaveBeenCalledTimes(1);
    });

    it("should upload into the bucket and prefix the broker granted", async () => {
      await run();

      expect(uploadFolderToS3Mock).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: "cdn-test-bucket",
          remoteFolder: `${PACKAGE_NAME}/${COMMIT_VERSION}`,
        }),
      );
    });

    // The marker is what makes the prefix eligible for a rollout, so a crashed upload
    // leaves something the broker refuses to publish.
    it("should write the completion marker", async () => {
      await run();

      expect(writeCompletionMarkerMock).toHaveBeenCalledTimes(1);
    });

    /**
     * "Written last" is the whole invariant -- the marker is what makes a prefix eligible
     * for a rollout, so a marker that lands before the objects would let a crashed upload
     * read as complete. The suite asserted THAT it was written and WHAT was in it, never
     * WHEN.
     */
    it("should write the marker only after the objects are uploaded", async () => {
      await run();

      expect(uploadFolderToS3Mock.mock.invocationCallOrder[0]).toBeLessThan(
        writeCompletionMarkerMock.mock.invocationCallOrder[0],
      );
    });

    // Fire-and-forget would swallow the failure, report the run a success, and leave a
    // prefix that can never be published.
    it("should fail the run when the marker cannot be written", async () => {
      writeCompletionMarkerMock.mockRejectedValueOnce(new Error("AccessDenied"));

      await expect(run()).rejects.toThrow("AccessDenied");
    });

    it("should not roll out when the marker could not be written", async () => {
      writeCompletionMarkerMock.mockRejectedValueOnce(new Error("AccessDenied"));

      await run().catch(() => undefined);

      expect(broker.rollout).not.toHaveBeenCalled();
    });

    it("should record how many objects it wrote in the marker", async () => {
      uploadFolderToS3Mock.mockResolvedValue(["a", "b", "c"]);

      await run();

      expect(writeCompletionMarkerMock).toHaveBeenCalledWith(
        expect.objectContaining({ marker: expect.objectContaining({ objectCount: 3 }) }),
      );
    });

    it("should report the upload in the mode output", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith("mode", "upload");
    });

    it("should roll out to every requested environment", async () => {
      await run();

      expect(broker.rollout).toHaveBeenCalledTimes(2);
    });
  });

  describe("and the same commit is deployed again", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockResolvedValue(grant(true));
    });

    it("should not upload again", async () => {
      await run();

      expect(uploadFolderToS3Mock).not.toHaveBeenCalled();
    });

    it("should still roll out", async () => {
      await run();

      expect(broker.rollout).toHaveBeenCalledTimes(2);
    });

    it("should report the skip", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith("mode", "skip");
    });
  });

  describe("and a release is being staged", () => {
    beforeEach(() => {
      inputs = buildInputs({ version: RELEASE_VERSION, copyFromCommit: true, environments: [] });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant(false));
      broker.release.mockResolvedValue({ complete: true, copied: 12, objectCount: 12 });
    });

    it("should ask the broker to copy rather than upload", async () => {
      await run();

      expect(broker.release).toHaveBeenCalledWith(
        expect.objectContaining({ version: RELEASE_VERSION, sourceVersion: COMMIT_VERSION }),
      );
    });

    it("should not upload anything from the runner", async () => {
      await run();

      expect(uploadFolderToS3Mock).not.toHaveBeenCalled();
    });

    it("should not roll out, since no environment was requested", async () => {
      await run();

      expect(broker.rollout).not.toHaveBeenCalled();
    });

    it("should report the copy", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith("mode", "copy");
    });
  });

  describe("and the release copy needs more than one call", () => {
    beforeEach(() => {
      inputs = buildInputs({ version: RELEASE_VERSION, copyFromCommit: true, environments: [] });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant(false));
      broker.release
        .mockResolvedValueOnce({ complete: false, copied: 640, continuation: "tok-1" })
        .mockResolvedValueOnce({ complete: false, copied: 1280, continuation: "tok-2" })
        .mockResolvedValueOnce({ complete: true, copied: 1500, objectCount: 1500 });
    });

    it("should keep calling until the copy reports complete", async () => {
      await run();

      expect(broker.release).toHaveBeenCalledTimes(3);
    });

    it("should pass the continuation token back", async () => {
      await run();

      expect(broker.release).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ continuation: "tok-1" }),
      );
    });
  });

  describe("and the source build has not finished uploading yet", () => {
    beforeEach(() => {
      inputs = buildInputs({ version: RELEASE_VERSION, copyFromCommit: true, environments: [] });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant(false));
      // retryAfter 0 keeps the test fast; what is under test is that it waits and retries
      // rather than failing, not how long it waits.
      broker.release
        .mockRejectedValueOnce(new BrokerError("source_not_ready", 409, "still uploading", {}, 0))
        .mockRejectedValueOnce(new BrokerError("source_not_ready", 409, "still uploading", {}, 0))
        .mockResolvedValueOnce({ complete: true, copied: 5, objectCount: 5 });
    });

    // A release routinely races the commit build that produced its source, so this is a
    // wait rather than a failure.
    it("should keep waiting until the source is ready", async () => {
      await run();

      expect(broker.release).toHaveBeenCalledTimes(3);
    });

    it("should complete the release once it is", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith("mode", "copy");
    });
  });

  /**
   * The loop had no cap, no deadline and no progress check, and no pause on the progress
   * path -- so a broker answering "not done" forever burned the whole job timeout, and one
   * answering without a continuation hot-looped. These pin all three exits.
   */
  describe("and the broker never reports the copy as finished", () => {
    beforeEach(() => {
      inputs = buildInputs({ version: RELEASE_VERSION, copyFromCommit: true, environments: [] });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant(false));
      // Same token, same count: it is not getting anywhere.
      broker.release.mockResolvedValue({ complete: false, copied: 640, continuation: "stuck" });
    });

    it("should give up rather than loop forever", async () => {
      await expect(run()).rejects.toThrow(/stopped making progress/);
    });

    it("should stop after a handful of attempts", async () => {
      await run().catch(() => undefined);

      expect(broker.release.mock.calls.length).toBeLessThan(10);
    });
  });

  describe("and the broker reports the copy unfinished with nothing to resume from", () => {
    beforeEach(() => {
      inputs = buildInputs({ version: RELEASE_VERSION, copyFromCommit: true, environments: [] });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant(false));
      broker.release.mockResolvedValue({ complete: false, copied: 1 });
    });

    // Without this it re-issued immediately with an undefined continuation, restarting the
    // copy every iteration with no pause between attempts.
    it("should fail instead of restarting the copy", async () => {
      await expect(run()).rejects.toThrow(/nothing to resume from/);
    });

    it("should not call the broker again after the first answer", async () => {
      await run().catch(() => undefined);

      expect(broker.release).toHaveBeenCalledTimes(1);
    });
  });

  describe("and the source keeps saying it is not ready", () => {
    /**
     * The call cap used to count source-wait polls, so a broker sending a short
     * Retry-After burned all 300 in minutes and the run failed with "the copy did not
     * finish" — blaming the copy for a source build that had not started.
     */
    beforeEach(() => {
      inputs = buildInputs({ version: RELEASE_VERSION, copyFromCommit: true, environments: [] });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant(false));
      // One copy attempt allowed. If waits were counted against it — as they were — two
      // of them would exhaust the budget before the copy is ever tried. At the real cap of
      // 300 this distinction is invisible, which is why the cap is lowered here.
      RELEASE_LIMITS.maxCalls = 1;
      let polls = 0;
      broker.release.mockImplementation(async () => {
        // each wait sleeps at least a second (the Retry-After: 0 floor), so keep it short
        if (++polls <= 2) throw new BrokerError("source_not_ready", 409, "still uploading", {}, 0);
        return { complete: true, copied: 3, objectCount: 3 };
      });
    });

    afterEach(() => {
      RELEASE_LIMITS.maxCalls = 300;
    });

    it("should not spend the copy budget on waiting", async () => {
      await expect(run()).resolves.toBeUndefined();
    });

    it("should go on to finish the copy once the source lands", async () => {
      await run();

      expect(broker.release).toHaveBeenCalledTimes(3);
    });
  });

  describe("and the copy never reports itself complete", () => {
    beforeEach(() => {
      inputs = buildInputs({ version: RELEASE_VERSION, copyFromCommit: true, environments: [] });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant(false));
      RELEASE_LIMITS.maxCalls = 4;
      let copied = 0;
      // Always progressing, so the stall detector never fires and only the call cap can
      // stop it.
      broker.release.mockImplementation(async () => ({
        complete: false,
        copied: (copied += 10),
        continuation: `tok-${copied}`,
      }));
    });

    afterEach(() => {
      RELEASE_LIMITS.maxCalls = 300;
    });

    it("should give up rather than loop forever", async () => {
      await expect(run()).rejects.toThrow(/did not finish after 4 calls/);
    });

    /**
     * Exactly the number it reports, not one more. `>` let a 301st call through and then
     * announced 300, so the cap in the message and the cap actually applied disagreed.
     */
    it("should make exactly as many calls as the message claims", async () => {
      await run().catch(() => undefined);

      expect(broker.release).toHaveBeenCalledTimes(4);
    });
  });

  describe("and the source build never finishes", () => {
    beforeEach(() => {
      inputs = buildInputs({ version: RELEASE_VERSION, copyFromCommit: true, environments: [] });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant(false));
      broker.release.mockRejectedValue(
        new BrokerError("source_not_ready", 409, "still uploading", {}, 0),
      );
      RELEASE_LIMITS.maxSourceWaitMs = 0;
    });

    afterEach(() => {
      RELEASE_LIMITS.maxSourceWaitMs = 30 * 60_000;
    });

    // A source build that failed will never land. Waiting out the job timeout reports
    // "timed out" instead of naming the workflow that actually broke.
    it("should stop waiting rather than burn the job timeout", async () => {
      await expect(run()).rejects.toThrow(/still has not finished/);
    });

    it("should say the source most likely failed", async () => {
      await expect(run()).rejects.toThrow(/most likely failed/);
    });
  });

  describe("and the version is already published", () => {
    /**
     * The broker refuses to hand out write access to a published prefix rather than
     * trusting the caller to skip. Re-running a deploy is an ordinary operation, so that
     * refusal has to mean "already there" here, not "failed".
     */
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist", environments: ["zone"] });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockRejectedValue(
        new BrokerError("version_already_published", 409, "already published", {}),
      );
    });

    it("should not fail the run", async () => {
      await expect(run()).resolves.toBeUndefined();
    });

    it("should skip the upload", async () => {
      await run();

      expect(uploadFolderToS3Mock).not.toHaveBeenCalled();
    });

    it("should still roll out", async () => {
      await run();

      expect(broker.rollout).toHaveBeenCalledTimes(1);
    });

    it("should report the outcome as a skip", async () => {
      await run();

      expect(core.setOutput).toHaveBeenCalledWith("mode", "skip");
    });

    /**
     * `force` means "write these bytes anyway". A published version cannot be written at
     * all, so skipping would report success for a run that did the opposite of what was
     * asked — and the docs promise force re-uploads past an existing version.
     */
    it("should fail rather than silently skip when force was set", async () => {
      inputs = buildInputs({ distPath: "./dist", force: true, environments: ["zone"] });
      readInputsMock.mockReturnValue(inputs);

      await expect(run()).rejects.toThrow(/immutable/);
    });

    it("should not roll out when force could not be honoured", async () => {
      inputs = buildInputs({ distPath: "./dist", force: true, environments: ["zone"] });
      readInputsMock.mockReturnValue(inputs);

      await run().catch(() => undefined);

      expect(broker.rollout).not.toHaveBeenCalled();
    });

    // Anything else from /credentials is a real failure and must not be swallowed.
    it("should still fail on any other broker refusal", async () => {
      broker.requestCredentials.mockRejectedValue(
        new BrokerError("repository_mismatch", 403, "not your package", {}),
      );

      await expect(run()).rejects.toThrow("not your package");
    });
  });

  describe("and force is set on a run with nothing to write", () => {
    /**
     * `force` used to reach the planner, which refused -- but only after a 15-minute write
     * session had been minted for work that could never happen. It is a mistake, not a
     * modifier, when there are no bytes to redo.
     */
    beforeEach(() => {
      inputs = buildInputs({ version: "9.9.9", force: true, environments: [] });
      readInputsMock.mockReturnValue(inputs);
    });

    it("should refuse and say what to pass instead", async () => {
      await expect(run()).rejects.toThrow(/no bytes to write/);
    });

    it("should not mint credentials for work it cannot do", async () => {
      await run().catch(() => undefined);

      expect(broker.requestCredentials).not.toHaveBeenCalled();
    });
  });

  describe("and the release fails for a reason other than a missing source", () => {
    beforeEach(() => {
      inputs = buildInputs({ version: RELEASE_VERSION, copyFromCommit: true, environments: [] });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant(false));
      broker.release.mockRejectedValue(
        new BrokerError("version_tag_mismatch", 403, "not your tag", {}),
      );
    });

    it("should fail rather than retry forever", async () => {
      await expect(run()).rejects.toThrow("not your tag");
    });

    // The code travels on the error; reportFailure is what prefixes it into the message
    // the user sees, which is asserted separately below.
    it("should carry the broker's code", async () => {
      await expect(run()).rejects.toMatchObject({ code: "version_tag_mismatch" });
    });
  });

  describe("and the upload needs fresh credentials mid-flight", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockResolvedValue(grant(false));
      uploadFolderToS3Mock.mockResolvedValue(["index.html"]);
    });

    // The 15-minute session is AssumeRole's floor, so a long upload has to be able to mint
    // a new one rather than failing at the edge.
    it("should give the credentials a way to fetch a fresh grant", async () => {
      await run();

      const options = (createBrokeredCredentials as jest.Mock).mock.calls[0][0];
      await options.fetchGrant();

      expect(broker.requestCredentials).toHaveBeenCalledTimes(2);
    });

    it("should hand back the credentials from that grant", async () => {
      await run();

      const options = (createBrokeredCredentials as jest.Mock).mock.calls[0][0];

      await expect(options.fetchGrant()).resolves.toEqual(grant(false).credentials);
    });
  });

  describe("and a version is repointed without writing anything", () => {
    beforeEach(() => {
      inputs = buildInputs({ version: RELEASE_VERSION });
      readInputsMock.mockReturnValue(inputs);
    });

    // Nothing is written, so there is nothing to grant. The broker checks the bytes exist
    // before it touches the rollout record, which is the authoritative check anyway.
    it("should not ask for credentials", async () => {
      await run();

      expect(broker.requestCredentials).not.toHaveBeenCalled();
    });

    it("should still roll out", async () => {
      await run();

      expect(broker.rollout).toHaveBeenCalledTimes(2);
    });
  });

  describe("and the built folder turns out to be empty", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockResolvedValue(grant(false));
      uploadFolderToS3Mock.mockResolvedValue([]);
    });

    it("should fail rather than publish nothing", async () => {
      await expect(run()).rejects.toThrow("the folder is empty");
    });

    it("should not roll out", async () => {
      await expect(run()).rejects.toThrow();

      expect(broker.rollout).not.toHaveBeenCalled();
    });

    it("should not write a completion marker", async () => {
      await expect(run()).rejects.toThrow();

      expect(writeCompletionMarkerMock).not.toHaveBeenCalled();
    });
  });

  describe("and the build has no index.html", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(false);
    });

    it("should fail before asking for credentials", async () => {
      await expect(run()).rejects.toThrow("No index.html");

      expect(broker.requestCredentials).not.toHaveBeenCalled();
    });
  });

  describe("and the index guard is disabled for a non-HTML bundle", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist", requireIndex: false });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(false);
      broker.requestCredentials.mockResolvedValue(grant(false));
      uploadFolderToS3Mock.mockResolvedValue(["bundle.js"]);
    });

    it("should upload a folder with no index.html", async () => {
      await run();

      expect(uploadFolderToS3Mock).toHaveBeenCalledTimes(1);
    });
  });

  describe("and one environment fails to roll out", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockResolvedValue(grant(false));
      uploadFolderToS3Mock.mockResolvedValue(["index.html"]);
      broker.rollout.mockImplementation(async ({ environment }: { environment: string }) => {
        if (environment === "today") throw new Error("kv unavailable");
        return rolloutResult(environment);
      });
    });

    it("should fail the run", async () => {
      await expect(run()).rejects.toThrow("Rollout failed for: today");
    });

    // A partial rollout is possible and has to be visible rather than hidden behind an
    // abort on the first failure.
    it("should name the environment that did succeed", async () => {
      await expect(run()).rejects.toThrow("Already updated: zone");
    });

    it("should mark the deploy failed", async () => {
      await expect(run()).rejects.toThrow();

      expect(observability.fail).toHaveBeenCalledTimes(1);
    });
  });

  describe("and Slack is configured", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist", slackWebhook: "https://hooks.slack.com/x" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockResolvedValue(grant(false));
      uploadFolderToS3Mock.mockResolvedValue(["index.html"]);
      notifyRolloutMock.mockResolvedValue(undefined);
    });

    it("should notify once per environment", async () => {
      await run();

      expect(notifyRolloutMock).toHaveBeenCalledTimes(2);
    });

    // The broker returns the URL because it is the thing that knows which key the rollout
    // landed on.
    it("should link each message to the url the broker reported", async () => {
      await run();

      expect(notifyRolloutMock.mock.calls.map((call) => call[0].url)).toEqual([
        "https://decentraland.zone/auth",
        "https://decentraland.today/auth",
      ]);
    });

    describe("and the notification fails", () => {
      beforeEach(() => {
        notifyRolloutMock.mockRejectedValue(new Error("slack down"));
      });

      it("should warn rather than fail a deploy that already landed", async () => {
        await run();

        expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("Slack"));
      });

      it("should still mark the deploy successful", async () => {
        await run();

        expect(observability.succeed).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("and the run reports its results", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockResolvedValue(grant(false));
      uploadFolderToS3Mock.mockResolvedValue(["index.html"]);
    });

    it("should publish the deployed version", async () => {
      await run();

      expect(setOutputMock).toHaveBeenCalledWith("version", COMMIT_VERSION);
    });

    it("should publish the S3 prefix", async () => {
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

    it("should open the deployment before doing any work", async () => {
      await run();

      expect(observability.start).toHaveBeenCalledTimes(1);
    });

    it("should record what the S3 step did in the job summary", async () => {
      await run();

      expect(summaryMock.addTable).toHaveBeenCalledWith(expect.arrayContaining([["S3", "upload"]]));
    });

    it("should point the broker client at the configured url", async () => {
      await run();

      expect(createBrokerClient).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "https://cdn-deploy.decentraland.org",
          audience: "dcl-cdn-deploy",
        }),
      );
    });
  });

  describe("and a specific commit is being deployed", () => {
    beforeEach(() => {
      inputs = buildInputs({ commit: COMMIT_INPUT_SHA });
      readInputsMock.mockReturnValue(inputs);
    });

    it("should attribute the deployment to that commit", async () => {
      await run();

      expect(createObservabilityMock).toHaveBeenCalledWith(
        expect.objectContaining({ sha: COMMIT_INPUT_SHA, version: "1.0.0-commit-feed123" }),
      );
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

    // The broker's code names the thing to fix, so it leads the message a user reads in
    // the workflow log.
    it("should lead with the broker's code when the broker refused", () => {
      reportFailure(
        new BrokerError("repository_mismatch", 403, "belongs to decentraland/auth", {}),
      );

      expect(core.setFailed).toHaveBeenCalledWith(
        "[repository_mismatch] belongs to decentraland/auth",
      );
    });
  });
});
