const mockSetSecret = jest.fn();

jest.mock("@actions/core", () => ({ setSecret: mockSetSecret }));

import { BrokerError, createBrokerClient } from "../src/broker";
import type { BrokerClient } from "../src/broker";

type FetchMock = jest.Mock;

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

describe("when calling the deploy broker", () => {
  let fetchMock: FetchMock;
  let client: BrokerClient;

  beforeEach(() => {
    fetchMock = jest.fn();
    client = createBrokerClient({
      baseUrl: "https://cdn-deploy.decentraland.org",
      audience: "dcl-cdn-deploy",
      fetch: fetchMock,
      getToken: async () => "a.b.c",
    });
  });

  describe("and credentials are requested", () => {
    const grant = {
      bucket: "cdn-bucket",
      region: "us-east-1",
      prefix: "@dcl/auth-site/1.0.0/",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "s", sessionToken: "t" },
      expiresInSeconds: 900,
    };

    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(response(200, grant));
    });

    it("should post to the credentials endpoint", async () => {
      await client.requestCredentials({ packageName: "@dcl/auth-site", version: "1.0.0" });

      expect(fetchMock.mock.calls[0][0]).toBe("https://cdn-deploy.decentraland.org/credentials");
    });

    it("should send the OIDC token as a bearer credential", async () => {
      await client.requestCredentials({ packageName: "@dcl/auth-site", version: "1.0.0" });

      expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer a.b.c");
    });

    it("should send the package and version", async () => {
      await client.requestCredentials({ packageName: "@dcl/auth-site", version: "1.0.0" });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        packageName: "@dcl/auth-site",
        version: "1.0.0",
      });
    });

    it("should resolve to the grant", async () => {
      await expect(
        client.requestCredentials({ packageName: "@dcl/auth-site", version: "1.0.0" }),
      ).resolves.toEqual(grant);
    });
  });

  describe("and a release copy is still running", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(
        response(202, { complete: false, copied: 640, continuation: "tok" }),
      );
    });

    // 202 is a normal, expected answer here rather than an error: the copy is resumable
    // because API Gateway caps a single call at 29 seconds.
    it("should treat a 202 as progress rather than a failure", async () => {
      await expect(
        client.release({ packageName: "@dcl/auth-site", version: "1.0.0", sourceVersion: "0.9.0" }),
      ).resolves.toEqual({ complete: false, copied: 640, continuation: "tok" });
    });
  });

  describe("and the broker refuses the request", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(
        response(403, {
          code: "repository_mismatch",
          message: "@dcl/auth-site belongs to decentraland/auth",
          details: { packageName: "@dcl/auth-site" },
        }),
      );
    });

    it("should surface the broker's code", async () => {
      await expect(
        client.rollout({
          packageName: "@dcl/auth-site",
          version: "1.0.0",
          environment: "zone",
          percentage: 100,
        }),
      ).rejects.toMatchObject({ code: "repository_mismatch" });
    });

    it("should surface the broker's message, which names what to fix", async () => {
      await expect(
        client.rollout({
          packageName: "@dcl/auth-site",
          version: "1.0.0",
          environment: "zone",
          percentage: 100,
        }),
      ).rejects.toThrow("belongs to decentraland/auth");
    });

    it("should not retry a refusal", async () => {
      await expect(
        client.rollout({
          packageName: "@dcl/auth-site",
          version: "1.0.0",
          environment: "zone",
          percentage: 100,
        }),
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("and the broker reports the source is not ready", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValueOnce(
        response(
          409,
          { code: "source_not_ready", message: "still uploading" },
          { "retry-after": "10" },
        ),
      );
    });

    // The action waits on this rather than failing: a release routinely races the commit
    // build that produced its source.
    it("should reject rather than treat a 409 as progress", async () => {
      await expect(
        client.release({ packageName: "@dcl/auth-site", version: "1.0.0", sourceVersion: "0.9.0" }),
      ).rejects.toThrow(BrokerError);
    });

    it("should carry the retry-after so the caller can wait the right amount", async () => {
      await expect(
        client.release({ packageName: "@dcl/auth-site", version: "1.0.0", sourceVersion: "0.9.0" }),
      ).rejects.toMatchObject({ code: "source_not_ready", retryAfterSeconds: 10 });
    });
  });

  describe("and the broker answers with an unparseable body", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue(response(500, "<html>gateway error</html>"));
    });

    it("should still produce a usable error", async () => {
      await expect(
        client.rollout({
          packageName: "@dcl/auth-site",
          version: "1.0.0",
          environment: "zone",
          percentage: 100,
        }),
      ).rejects.toMatchObject({ code: "broker_error", status: 500 });
    });
  });

  describe("and the broker is briefly unavailable", () => {
    beforeEach(() => {
      fetchMock
        .mockResolvedValueOnce(response(503, { code: "broker_unavailable", message: "starting" }))
        .mockResolvedValueOnce(response(200, { key: "auth", environment: "zone" }));
    });

    it("should retry and succeed", async () => {
      await expect(
        client.rollout({
          packageName: "@dcl/auth-site",
          version: "1.0.0",
          environment: "zone",
          percentage: 100,
        }),
      ).resolves.toMatchObject({ key: "auth" });
    });
  });
});

describe("when the broker url has a trailing slash", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(response(200, {}));
  });

  it("should not produce a doubled slash in the path", async () => {
    const client = createBrokerClient({
      baseUrl: "https://cdn-deploy.decentraland.org/",
      audience: "dcl-cdn-deploy",
      fetch: fetchMock,
      getToken: async () => "a.b.c",
    });

    await client.requestCredentials({ packageName: "@dcl/x", version: "1.0.0" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://cdn-deploy.decentraland.org/credentials");
  });
});

describe("when a credentials grant comes back", () => {
  let fetchMock: FetchMock;
  let client: BrokerClient;

  beforeEach(() => {
    mockSetSecret.mockClear();
    fetchMock = jest.fn();
    client = createBrokerClient({
      baseUrl: "https://cdn-deploy.decentraland.org",
      audience: "dcl-cdn-deploy",
      fetch: fetchMock,
      getToken: async () => "token",
    });
    fetchMock.mockResolvedValue(
      response(200, {
        bucket: "cdn-bucket",
        region: "us-east-1",
        prefix: "@dcl/auth-site/1.0.0/",
        expiresInSeconds: 900,
        credentials: {
          accessKeyId: "AKIA-TEST",
          secretAccessKey: "the-secret",
          sessionToken: "the-token",
        },
      }),
    );
  });

  /**
   * A grant is a live 15-minute STS session. Masking belongs at the parse site so every
   * grant is registered -- not only the ones reaching the self-refreshing credentials. The
   * first grant of an upload, and the ones minted on the copy and skip paths, never went
   * through there.
   */
  it("should mask the secret access key", async () => {
    await client.requestCredentials({ packageName: "@dcl/auth-site", version: "1.0.0" });

    expect(mockSetSecret).toHaveBeenCalledWith("the-secret");
  });

  it("should mask the session token", async () => {
    await client.requestCredentials({ packageName: "@dcl/auth-site", version: "1.0.0" });

    expect(mockSetSecret).toHaveBeenCalledWith("the-token");
  });
});
