import * as core from "@actions/core";
import { spawn } from "child_process";
import { BrokerError, createBrokerClient } from "../src/broker";
import { createBrokeredCredentials } from "../src/credentials";
import { createObservability } from "../src/github";
import { reportFailure, run } from "../src/index";
import { folderHasIndexHtml, readInputs, validateVersionShape } from "../src/inputs";
import { uploadFolderToS3, writeCompletionMarker } from "../src/s3";
import { ActionInputs } from "../src/types";

jest.mock("@actions/core", () => ({
  setOutput: jest.fn(),
  exportVariable: jest.fn(),
  setFailed: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  group: jest.fn(),
  setSecret: jest.fn(),
  summary: { addHeading: jest.fn(), addTable: jest.fn(), write: jest.fn() },
}));
jest.mock("@actions/github", () => ({ context: { sha: "", runId: 4242 } }));
jest.mock("child_process", () => ({ spawn: jest.fn() }));
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
  const COMMIT_VERSION = "1.0.0-4242.commit-abc1234";
  const RELEASE_VERSION = "1.2.3";

  function buildInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
    return {
      distPath: "",
      packageName: PACKAGE_NAME,
      packageVersion: "1.0.0",
      environments: ["zone", "today"],
      percentage: 100,
      brokerUrl: "https://cdn-deploy.decentraland.org",
      ...overrides,
    };
  }

  function grant() {
    return {
      bucket: "cdn-test-bucket",
      region: "us-east-1",
      prefix: `${PACKAGE_NAME}/${COMMIT_VERSION}/`,
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

    // A build that exits 0. Individual tests override the exit code.
    (spawn as unknown as jest.Mock).mockImplementation(() => ({
      on: (event: string, cb: (code: number) => void) => {
        if (event === "close") setImmediate(() => cb(0));
      },
    }));

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
    // Defaulted here rather than per-describe. `jest.clearAllMocks()` clears calls but NOT
    // implementations, and the config sets neither resetMocks nor restoreMocks -- so a
    // describe that set `dist-path` without stubbing this one passed only on the stub a
    // sibling describe had left behind. Six tests were in that state, `--randomize` failed
    // one seed in three, and the single test pinning the resolve->deploy version handoff
    // was one of them. A describe that wants the opposite still overrides it.
    folderHasIndexHtmlMock.mockReturnValue(true);
    uploadFolderToS3Mock = uploadFolderToS3 as jest.MockedFunction<typeof uploadFolderToS3>;
    writeCompletionMarkerMock = writeCompletionMarker as jest.MockedFunction<
      typeof writeCompletionMarker
    >;
    // Same reasoning as folderHasIndexHtml above: uploadDir resolves to the list of objects
    // it wrote, and a describe that left it undefined only worked because a sibling had
    // stubbed it.
    uploadFolderToS3Mock.mockResolvedValue(["one-object"]);

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
      broker.requestCredentials.mockResolvedValue(grant());
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

  describe("and a promotion runs with no checkout", () => {
    /**
     * The shape of the promote job: a version to put live, no dist-path, no checkout — so
     * no package.json and no base version. The commit version is never used, and demanding
     * one up front killed the job in readInputs before it ever reached the broker, taking
     * promotion to today/org and rollback with it.
     */
    beforeEach(() => {
      inputs = buildInputs({
        version: "8.36.0",
        distPath: "",
        environments: ["org"],
      });
      readInputsMock.mockReturnValue(inputs);
    });

    it("should roll out without needing a base version", async () => {
      await run();

      expect(broker.rollout).toHaveBeenCalledTimes(1);
    });

    it("should roll out the version it was given", async () => {
      await run();

      expect(broker.rollout.mock.calls[0][0]).toMatchObject({ version: "8.36.0" });
    });

    it("should write nothing to S3", async () => {
      await run();

      expect(broker.requestCredentials).not.toHaveBeenCalled();
    });
  });

  describe("and a commit version is needed but no base version resolves", () => {
    // The demand did not disappear, it moved: a run that must compute a commit version
    // still fails, and still says how to fix it.
    beforeEach(() => {
      inputs = buildInputs({
        distPath: "./dist",
        packageVersion: undefined,
        environments: ["zone"],
      });
      readInputsMock.mockReturnValue(inputs);
    });

    it("should fail naming the base version", async () => {
      await expect(run()).rejects.toThrow("Unable to resolve a base version");
    });
  });

  describe("and the same commit is deployed again", () => {
    /**
     * Driven by the broker's refusal, which is the only way this is signalled. It used to
     * be driven by a grant carrying `targetExists: true` — a value the broker never sent,
     * so the test passed against a state that cannot occur while the real redeploy path
     * went unexercised here. That field is gone from the wire entirely now.
     */
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockRejectedValue(
        new BrokerError("version_already_published", 409, "already published", {}),
      );
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

    // Anything else from /credentials is a real failure and must not be swallowed.
    it("should still fail on any other broker refusal", async () => {
      broker.requestCredentials.mockRejectedValue(
        new BrokerError("repository_mismatch", 403, "not your package", {}),
      );

      await expect(run()).rejects.toThrow("not your package");
    });
  });

  describe("and the upload needs fresh credentials mid-flight", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockResolvedValue(grant());
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

      await expect(options.fetchGrant()).resolves.toEqual(grant().credentials);
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
      broker.requestCredentials.mockResolvedValue(grant());
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

  describe("and one environment fails to roll out", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockResolvedValue(grant());
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

  describe("and the run reports its results", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist" });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockResolvedValue(grant());
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

  /**
   * The guard at src/index.ts carries the loudest comment in the file — a refusal during a
   * mid-upload credential REFRESH must not be swallowed as "already published, nothing to
   * do" — and had no test at all. Moving the upload inside the `try` above it left all 343
   * tests green, which is exactly how a half-written prefix gets rolled out and reported as
   * a success.
   */
  describe("and the version is published by another run mid-upload", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist", environments: ["zone"] });
      readInputsMock.mockReturnValue(inputs);
      folderHasIndexHtmlMock.mockReturnValue(true);
      broker.requestCredentials.mockResolvedValue({
        bucket: "cdn-test-bucket",
        region: "us-east-1",
        prefix: "@dcl/auth-site/1.0.0/",
        credentials: { accessKeyId: "AKIA", secretAccessKey: "s", sessionToken: "t" },
      });
      // The refusal arrives from the upload itself, not from the initial mint: this is the
      // credential refresh being turned down part-way through writing the prefix.
      uploadFolderToS3Mock.mockRejectedValue(
        new BrokerError("version_already_published", 409, "already published", {}),
      );
    });

    it("should fail rather than report a skip", async () => {
      await expect(run()).rejects.toThrow(/already published/);
    });

    it("should never roll out over a half-written prefix", async () => {
      await run().catch(() => undefined);

      expect(broker.rollout).not.toHaveBeenCalled();
    });

    it("should not write the completion marker", async () => {
      await run().catch(() => undefined);

      expect(writeCompletionMarker).not.toHaveBeenCalled();
    });
  });

  /**
   * A run with nothing to upload and nowhere to publish used to be reported as a success,
   * with a log line asserting "bytes are in S3" that nothing had verified. It is the shape
   * of a release job that lost its dist-path.
   */
  describe("and the run has nothing to write and nowhere to publish", () => {
    beforeEach(() => {
      inputs = buildInputs({
        version: "1.2.3",
        distPath: "",
        environments: [],
      });
      readInputsMock.mockReturnValue(inputs);
    });

    it("should refuse instead of reporting a successful no-op", async () => {
      await expect(run()).rejects.toThrow(/would do nothing/);
    });

    it("should name both of the things that could fix it", async () => {
      await expect(run()).rejects.toThrow(/dist-path[\s\S]*deployment-environments/);
    });
  });

  /**
   * The build runs inside the action, between settling the version and uploading, because
   * every site bakes its asset base URL from the version at build time. Splitting those
   * into separate composite steps meant the version had to cross a boundary, and the only
   * way across was $GITHUB_ENV -- job-wide and writable by anything the build runs.
   */
  describe("and the action owns the build", () => {
    beforeEach(() => {
      inputs = buildInputs({
        buildCommand: "npm run build",
        distPath: "./dist",
        environments: ["zone"],
      });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant());
    });

    it("should run the build the caller asked for", async () => {
      await run();

      expect(spawn).toHaveBeenCalledWith(
        "bash",
        ["-e", "-o", "pipefail", "-c", "npm run build"],
        expect.anything(),
      );
    });

    // Spliced into a `run:` block it was structure, not data: a caller interpolating an
    // untrusted string into build-command handed shell metacharacters straight to bash.
    it("should pass the command as an argument rather than as shell text", async () => {
      await run();

      const [, argv] = (spawn as unknown as jest.Mock).mock.calls[0];
      expect(argv[argv.length - 1]).toBe("npm run build");
    });

    it("should publish the version for the build to read", async () => {
      await run();

      expect(core.exportVariable).toHaveBeenCalledWith("CDN_DEPLOY_VERSION", expect.any(String));
    });

    // The ordering is the whole reason the build lives here.
    it("should build before it uploads", async () => {
      const order: string[] = [];
      (spawn as unknown as jest.Mock).mockImplementation(() => {
        order.push("build");
        return {
          on: (event: string, cb: (code: number) => void) => {
            if (event === "close") setImmediate(() => cb(0));
          },
        };
      });
      uploadFolderToS3Mock.mockImplementation(async () => {
        order.push("upload");
        return ["one"];
      });

      await run();

      expect(order).toEqual(["build", "upload"]);
    });

    it("should still upload and roll out afterwards", async () => {
      await run();

      expect(uploadFolderToS3Mock).toHaveBeenCalledTimes(1);
      expect(broker.rollout).toHaveBeenCalledTimes(1);
    });
  });

  describe("and the build fails", () => {
    beforeEach(() => {
      inputs = buildInputs({
        buildCommand: "npm run build",
        distPath: "./dist",
        environments: ["zone"],
      });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant());
      (spawn as unknown as jest.Mock).mockImplementation(() => ({
        on: (event: string, cb: (code: number) => void) => {
          if (event === "close") setImmediate(() => cb(1));
        },
      }));
    });

    it("should fail the run rather than upload whatever is on disk", async () => {
      await expect(run()).rejects.toThrow(/build failed with exit code 1/);
    });

    it("should upload nothing", async () => {
      await run().catch(() => undefined);

      expect(uploadFolderToS3Mock).not.toHaveBeenCalled();
    });

    it("should roll nothing out", async () => {
      await run().catch(() => undefined);

      expect(broker.rollout).not.toHaveBeenCalled();
    });
  });

  describe("and a version input contains a path", () => {
    it("should refuse it, since the version is half the S3 key", () => {
      expect(() =>
        validateVersionShape("../../@dcl/other-site/9.9.9", "the `version` input"),
      ).toThrow(/no path separators/);
    });
  });

  /**
   * Mutation testing found these three unguarded. Each is a value the action computes and
   * hands to something else, where "it was computed" and "it arrived" are different claims
   * and only the first was ever asserted.
   */
  describe("and the values the action hands on are checked", () => {
    beforeEach(() => {
      inputs = buildInputs({ distPath: "./dist", percentage: 25, environments: ["zone"] });
      readInputsMock.mockReturnValue(inputs);
      broker.requestCredentials.mockResolvedValue(grant());
    });

    /**
     * The self-refreshing object exists because a 15-minute session expires mid-upload on a
     * large site. Replacing it with the broker's static credentials left every test green:
     * the suite only ever checked that createBrokeredCredentials was CALLED, never that
     * what it returned was what signed the requests.
     */
    it("should sign the upload with the self-refreshing credentials, not the static grant", async () => {
      const refreshing = (createBrokeredCredentials as jest.Mock).mock.results;

      await run();

      const passed = uploadFolderToS3Mock.mock.calls[0][0].credentials;
      expect(passed).toBe(refreshing[0].value);
    });

    it("should sign the completion marker with the same object", async () => {
      await run();

      const upload = uploadFolderToS3Mock.mock.calls[0][0].credentials;
      const marker = writeCompletionMarkerMock.mock.calls[0][0].credentials;
      expect(marker).toBe(upload);
    });

    // The marker is what makes a prefix publishable, and the broker reads it back to decide
    // whether this version may be rolled out. Every field was unasserted.
    it("should describe the deployment in the completion marker", async () => {
      await run();

      expect(writeCompletionMarkerMock.mock.calls[0][0].marker).toMatchObject({
        package: PACKAGE_NAME,
        commit: expect.stringMatching(/^[0-9a-f]{7,40}$/),
        kind: "upload",
      });
    });

    it("should roll out at the percentage it was given", async () => {
      await run();

      expect(broker.rollout.mock.calls[0][0]).toMatchObject({
        percentage: 25,
        rolloutName: "_site",
      });
    });
  });

  /**
   * The guard has its own unit tests, but those pass whether or not `run()` calls it. This
   * asserts the wiring, and the ordering claim with it: checked before inputs, so the
   * message is not buried under a validation error about something the caller cannot fix
   * until node is right.
   */
  describe("and the job set up an older node than the bundle needs", () => {
    const actualVersion = process.version;

    const pretendNode = (version: string) =>
      Object.defineProperty(process, "version", { value: version, configurable: true });

    afterEach(() => pretendNode(actualVersion));

    it("should refuse the run", async () => {
      pretendNode("v18.20.4");

      await expect(run()).rejects.toThrow(/needs Node 24 or newer/);
    });

    it("should refuse before reading any input", async () => {
      pretendNode("v18.20.4");

      await run().catch(() => undefined);

      expect(readInputsMock).not.toHaveBeenCalled();
    });
  });
});
