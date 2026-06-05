const mockCreateDeployment = jest.fn();
const mockCreateDeploymentStatus = jest.fn();
const mockCreateCommitStatus = jest.fn();
const mockGetOctokit = jest.fn(() => ({
  rest: {
    repos: {
      createDeployment: mockCreateDeployment,
      createDeploymentStatus: mockCreateDeploymentStatus,
      createCommitStatus: mockCreateCommitStatus,
    },
  },
}));
const mockContext = {
  repo: { owner: "decentraland", repo: "auth" },
  sha: "abc123def456",
  serverUrl: "https://github.com",
  runId: 99,
};

jest.mock("@actions/github", () => ({
  getOctokit: mockGetOctokit,
  get context() {
    return mockContext;
  },
}));
jest.mock("@actions/core", () => ({ warning: jest.fn(), info: jest.fn() }));

import { createObservability } from "../src/github";

describe("when creating the GitHub observability", () => {
  // clearAllMocks (not resetAllMocks): keep the module-scoped getOctokit wiring,
  // only clear call records between tests.
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("and it is disabled", () => {
    it("should not build an octokit client", () => {
      createObservability({
        enabled: false,
        token: "t",
        environment: "zone",
        packageName: "@dcl/auth-site",
        version: "1.0.0",
        cdnUrl: "https://cdn/x",
      });
      expect(mockGetOctokit).not.toHaveBeenCalled();
    });
  });

  describe("and no token is available", () => {
    let obs: ReturnType<typeof createObservability>;

    beforeEach(() => {
      obs = createObservability({
        enabled: true,
        token: undefined,
        environment: "zone",
        packageName: "@dcl/auth-site",
        version: "1.0.0",
        cdnUrl: "https://cdn/x",
      });
    });

    it("should return a no-op whose lifecycle calls resolve without an octokit", async () => {
      await obs.start();
      await obs.succeed();
      await obs.fail();
      expect(mockGetOctokit).not.toHaveBeenCalled();
    });
  });

  describe("and it is enabled with a token", () => {
    let obs: ReturnType<typeof createObservability>;

    beforeEach(() => {
      mockCreateDeployment.mockResolvedValue({ data: { id: 123 } });
      mockCreateDeploymentStatus.mockResolvedValue({});
      mockCreateCommitStatus.mockResolvedValue({});
      obs = createObservability({
        enabled: true,
        token: "t",
        environment: "org",
        packageName: "@dcl/auth-site",
        version: "1.0.0",
        cdnUrl: "https://cdn/@dcl/auth-site/1.0.0",
      });
    });

    describe("and start is called", () => {
      beforeEach(async () => {
        await obs.start();
      });

      it("should create a production deployment for the org environment", () => {
        expect(mockCreateDeployment).toHaveBeenCalledWith(
          expect.objectContaining({
            owner: "decentraland",
            repo: "auth",
            task: "cdn-deploy",
            environment: "org",
            production_environment: true,
          })
        );
      });

      it("should mark the deployment in_progress", () => {
        expect(mockCreateDeploymentStatus).toHaveBeenCalledWith(
          expect.objectContaining({ deployment_id: 123, state: "in_progress" })
        );
      });

      it("should set the cdn-rollout/upload commit status to pending", () => {
        expect(mockCreateCommitStatus).toHaveBeenCalledWith(
          expect.objectContaining({ context: "cdn-rollout/upload", state: "pending" })
        );
      });
    });

    describe("and succeed is called after start", () => {
      beforeEach(async () => {
        await obs.start();
        mockCreateDeploymentStatus.mockClear();
        mockCreateCommitStatus.mockClear();
        await obs.succeed();
      });

      it("should mark the deployment successful", () => {
        expect(mockCreateDeploymentStatus).toHaveBeenCalledWith(
          expect.objectContaining({ deployment_id: 123, state: "success" })
        );
      });

      it("should set the commit status to success", () => {
        expect(mockCreateCommitStatus).toHaveBeenCalledWith(
          expect.objectContaining({ context: "cdn-rollout/upload", state: "success" })
        );
      });
    });

    describe("and fail is called after start", () => {
      beforeEach(async () => {
        await obs.start();
        mockCreateDeploymentStatus.mockClear();
        mockCreateCommitStatus.mockClear();
        await obs.fail();
      });

      it("should mark the deployment as failure", () => {
        expect(mockCreateDeploymentStatus).toHaveBeenCalledWith(
          expect.objectContaining({ deployment_id: 123, state: "failure" })
        );
      });
    });
  });
});
